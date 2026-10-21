import { createHmac } from 'node:crypto';

import { type Cell, type StateInit, beginCell, external, storeMessage } from '@ton/core';
import { keyPairFromSeed, sign, signVerify } from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';

import { mnemonicToSeedBip39 } from '../bip39.ts';
import type { Chain } from '../chain.base.ts';
import { ChainType, WalletFamily } from '../chain_type.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { AbstractTransactionPrerequisite } from '../transaction_prerequisite.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';
import { AbstractBip32StyleSingleAccountWallet, AbstractSignedMessage } from '../wallet.base.ts';
import { TonAddress, type TonUserFriendlyOptions } from './ton_address.ts';
import { TonChain } from './ton_chain.ts';
import { type TonOutMessage, tonNormalizedExternalHash, tonOutActions } from './ton_messages.ts';
import { TonSignedTransaction, TonUnsignedTransaction } from './ton_transactions.ts';

const TON_COIN_TYPE = 607;
const TON_DERIVATION_PATH_REGEX = /^m\/44'\/607'\/(\d+)'$/;
const SLIP10_ED25519_SEED_MODIFIER = 'ed25519 seed';
const FIRST_HARDENED_INDEX = 0x80000000;

/** Seconds a request stays valid unless the caller says otherwise. */
export const TON_DEFAULT_REQUEST_TTL_SECONDS = 60;

/** SLIP-0010 ed25519 derivation along hardened `path` segments (e.g. `[44, 607, 0]`) from a BIP-39 seed. */
export function deriveSlip10Ed25519Seed(bip39Seed: Uint8Array, path: readonly number[]): Buffer {
  let digest = createHmac('sha512', SLIP10_ED25519_SEED_MODIFIER).update(bip39Seed).digest();
  let il = digest.subarray(0, 32);
  let ir = digest.subarray(32);
  for (const segment of path) {
    if (!Number.isInteger(segment) || segment < 0 || segment >= FIRST_HARDENED_INDEX) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid SLIP-0010 path segment ${segment}`);
    }
    const indexBytes = Buffer.alloc(4);
    indexBytes.writeUInt32BE(FIRST_HARDENED_INDEX + segment);
    digest = createHmac('sha512', ir).update(Buffer.concat([Buffer.alloc(1), il, indexBytes])).digest();
    il = digest.subarray(0, 32);
    ir = digest.subarray(32);
  }
  return Buffer.from(il);
}

/** The ed25519 seed of `m/44'/607'/{index}'`. */
export function deriveTonEd25519Seed(bip39Seed: Uint8Array, index: number): Buffer {
  return deriveSlip10Ed25519Seed(bip39Seed, [44, TON_COIN_TYPE, index]);
}

export class TonSignedMessage extends AbstractSignedMessage {
  constructor(signature: string) {
    super(signature);
  }
}

export interface TonRequestArgs {
  seqno: number;
  messages: readonly TonOutMessage[];
  /** Unix seconds; defaults to now + {@link TON_DEFAULT_REQUEST_TTL_SECONDS}. */
  validUntil?: number;
}

export interface TonExternalRequest {
  /** The external message, base64 BOC, ready to broadcast. */
  boc: string;
  /** Its normalized hash, lowercase hex — the transaction id. */
  hash: string;
  seqno: number;
  validUntil: number;
}

/**
 * A wallet v5r1 (W5) account, its key derived from a BIP-39 mnemonic with
 * SLIP-0010 ed25519 at the hardened path `m/44'/607'/{index}'`, on workchain 0
 * with the mainnet client wallet id.
 *
 * It signs two kinds of request: an external one it sends itself (paying its
 * own fees), and an internal one a relayer delivers and pays for
 * (`tonRelayMessage`).
 */
export class TonWallet extends AbstractBip32StyleSingleAccountWallet {
  readonly publicKey: Buffer;
  readonly contract: WalletContractV5R1;
  readonly #secretKey: Buffer;
  private readonly _address: string;

  constructor(ed25519Seed: Uint8Array) {
    super();
    if (ed25519Seed.length !== 32) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `A TON ed25519 seed is 32 bytes, got ${ed25519Seed.length}`);
    }
    const keyPair = keyPairFromSeed(Buffer.from(ed25519Seed));
    this.publicKey = keyPair.publicKey;
    this.#secretKey = keyPair.secretKey;
    this.contract = WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey });
    this._address = this.contract.address.toRawString();
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `TonWallet { address: '${this._address}' }`;
  }

  static chainType(): ChainType {
    return ChainType.TON;
  }

  static walletFamily(): WalletFamily {
    return WalletFamily.TON;
  }

  chainType(): ChainType {
    return TonWallet.chainType();
  }

  walletFamily(): WalletFamily {
    return TonWallet.walletFamily();
  }

  static fromMnemonic(mnemonicStr: string, opts: { derivationPath?: string; passphrase?: string } = {}): TonWallet {
    const index = TonWallet.indexFromDerivationPath(opts.derivationPath ?? TonWallet.derivationPath());
    return new TonWallet(deriveTonEd25519Seed(mnemonicToSeedBip39(mnemonicStr, opts.passphrase ?? ''), index));
  }

  static derivationPath(args: { account?: number } = {}): string {
    return `m/44'/${TON_COIN_TYPE}'/${args.account ?? 0}'`;
  }

  /** Canonical raw address, `0:<hex>`. */
  get address(): string {
    return this._address;
  }

  addressUserFriendly(opts: TonUserFriendlyOptions = {}): string {
    return new TonAddress(this._address).toUserFriendly(opts);
  }

  /** The code and data that deploy this wallet; attach while it is not deployed. */
  get stateInit(): StateInit {
    return { code: this.contract.init.code, data: this.contract.init.data };
  }

  /**
   * A request this wallet sends itself, as an external message. Pass `deploy`
   * while the wallet is not deployed, so the message carries its StateInit.
   *
   * W5 sends external requests with "ignore errors" (+2) on every message, so
   * a message that cannot be sent is skipped rather than failing the others.
   */
  createExternalRequest(args: TonRequestArgs & { deploy?: boolean }): TonExternalRequest {
    const validUntil = args.validUntil ?? defaultValidUntil();
    const body = this.contract.createRequest({
      seqno: args.seqno,
      timeout: validUntil,
      secretKey: this.#secretKey,
      authType: 'external',
      actions: tonOutActions(args.messages),
    });
    const message = external({ to: this.contract.address, init: args.deploy === true ? this.stateInit : undefined, body });
    return {
      boc: beginCell().store(storeMessage(message)).endCell().toBoc().toString('base64'),
      hash: tonNormalizedExternalHash(this._address, body),
      seqno: args.seqno,
      validUntil,
    };
  }

  /**
   * A signed internal request (op `0x73696e74`) for a relayer to deliver with
   * `tonRelayMessage`. Send modes are kept as given, so without "ignore errors"
   * the request's messages leave all together or not at all.
   */
  createInternalRequest(args: TonRequestArgs): Cell {
    return this.contract.createRequest({
      seqno: args.seqno,
      timeout: args.validUntil ?? defaultValidUntil(),
      secretKey: this.#secretKey,
      authType: 'internal',
      actions: tonOutActions(args.messages),
    });
  }

  /** Signs `transaction` as an external request, reading the seqno and deployment from `chain`. */
  async signTransaction(transaction: UnsignedTransaction, chain: Chain): Promise<TonSignedTransaction> {
    if (!(transaction instanceof TonUnsignedTransaction)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Expected a TonUnsignedTransaction, got ${transaction.constructor.name}`);
    }
    if (new TonAddress(transaction.walletAddress).canonical() !== this._address) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Transaction is for ${transaction.walletAddress}, not this wallet ${this._address}`,
      );
    }
    const tonChain = assertTonChain(chain);
    if (tonChain.chainId !== transaction.chainId) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Transaction for chain ${transaction.chainId} cannot be signed on ${tonChain.chainId}`,
      );
    }
    const state = await tonChain.getAccountState(this._address);
    const seqno = state.status === 'active' ? await tonChain.getSeqno(this._address) : 0;
    const request = this.createExternalRequest({
      seqno,
      messages: transaction.messages,
      validUntil: transaction.validUntil,
      deploy: state.status !== 'active',
    });
    return new TonSignedTransaction({ chainId: transaction.chainId, boc: request.boc, hash: request.hash });
  }

  /** An ed25519 signature over the message's UTF-8 bytes, hex. */
  signMessage(message: string): TonSignedMessage {
    return new TonSignedMessage(sign(Buffer.from(message, 'utf8'), this.#secretKey).toString('hex'));
  }

  verifySignature(message: string, signedMessage: AbstractSignedMessage): boolean {
    try {
      return signVerify(Buffer.from(message, 'utf8'), Buffer.from(signedMessage.signature, 'hex'), this.publicKey);
    } catch {
      return false;
    }
  }

  async handleTransactionPrerequisite(prerequisite: AbstractTransactionPrerequisite): Promise<never> {
    throw new ChainError(
      ChainErrorKinds.FeatureNotSupported,
      `TonWallet has no transaction prerequisites (got ${prerequisite?.constructor?.name ?? typeof prerequisite})`,
    );
  }

  private static indexFromDerivationPath(derivationPath: string): number {
    const match = TON_DERIVATION_PATH_REGEX.exec(derivationPath);
    if (match === null) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        `Invalid TON derivation path ${derivationPath}; expected m/44'/607'/<account>' (hardened, SLIP-0010)`,
      );
    }
    return Number(match[1]);
  }
}

function assertTonChain(chain: Chain): TonChain {
  if (!(chain instanceof TonChain)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Expected a TonChain, got ${chain.constructor.name}`);
  }
  return chain;
}

function defaultValidUntil(): number {
  return Math.floor(Date.now() / 1000) + TON_DEFAULT_REQUEST_TTL_SECONDS;
}
