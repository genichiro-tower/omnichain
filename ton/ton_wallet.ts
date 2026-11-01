import { createHmac, pbkdf2Sync } from 'node:crypto';

import { type Cell, SendMode, type StateInit, beginCell, external, storeMessage, storeMessageRelaxed, storeStateInit } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';
import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';

import { mnemonicToSeedBip39 } from '../bip39.ts';
import type { Chain } from '../chain.base.ts';
import { ChainType, WalletFamily } from '../chain_type.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { AbstractTransactionPrerequisite } from '../transaction_prerequisite.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';
import { AbstractBip32StyleSingleAccountWallet, AbstractSignedMessage } from '../wallet.base.ts';
import { TonAddress, type TonUserFriendlyOptions } from './ton_address.ts';
import { TonChain } from './ton_chain.ts';
import {
  type TonInternalRequest,
  type TonOutMessage,
  type TonWalletVersion,
  TonSignedMessage,
  tonMessageHash,
  tonNormalizedExternalHash,
  tonOutActions,
} from './ton_messages.ts';
import { type TonProofInput, tonProofDigest } from './ton_proof.ts';
import { type TonSignDataTextResult, tonSignDataTextDigest } from './ton_sign_data.ts';
import { TonSignedTransaction, TonUnsignedTransaction } from './ton_transactions.ts';
import { type TonWalletContract, type TonWorkchain, tonWalletContract } from './ton_wallet_contracts.ts';

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

/** v3r2 / v4r2 send at most four messages per request. */
export const TON_LEGACY_MAX_MESSAGES = 4;

/** The path the Python SDK accepts as a marker for TON's own scheme; it derives nothing. */
export const TON_PYTHON_MARKER_PATH = "m/44'/607'/0'/0/0";

const TON_NATIVE_SEED_SALT = 'TON default seed';
const TON_NATIVE_PBKDF2_ITERATIONS = 100_000;

/**
 * The ed25519 seed TON's own mnemonic scheme gives (what TON wallets,
 * `@ton/crypto`'s `mnemonicToPrivateKey` and the Python SDK compute):
 * HMAC-SHA512 of the words keyed by the phrase, then PBKDF2-SHA512 with
 * "TON default seed", 100,000 rounds; the first 32 bytes. The words are
 * trimmed and lowercased, as the Python SDK does; they are not validated.
 */
export function deriveTonNativeSeed(mnemonicStr: string): Buffer {
  const words = mnemonicStr.trim().toLowerCase().split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) throw new ChainError(ChainErrorKinds.InvalidArgument, 'The mnemonic is empty');
  const entropy = createHmac('sha512', words.join(' ')).update('').digest();
  return pbkdf2Sync(entropy, TON_NATIVE_SEED_SALT, TON_NATIVE_PBKDF2_ITERATIONS, 64, 'sha512').subarray(0, 32);
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
  /** The wallet contract: W5 (v5r1, the default), or v4r2 / v3r2 as the Python SDK builds them. */
  readonly version: TonWalletVersion;
  /** 0 (the basechain, the default) or -1 (the masterchain, where gas and storage cost far more). */
  readonly workchain: TonWorkchain;
  readonly contract: TonWalletContract;
  readonly #secretKey: Buffer;
  private readonly _address: string;

  constructor(ed25519Seed: Uint8Array, opts: { version?: TonWalletVersion; workchain?: TonWorkchain } = {}) {
    super();
    if (ed25519Seed.length !== 32) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `A TON ed25519 seed is 32 bytes, got ${ed25519Seed.length}`);
    }
    const version = opts.version ?? 'v5r1';
    const workchain = opts.workchain ?? 0;
    const keyPair = keyPairFromSeed(Buffer.from(ed25519Seed));
    this.contract = tonWalletContract(keyPair.publicKey, version, workchain);
    this.publicKey = keyPair.publicKey;
    this.#secretKey = keyPair.secretKey;
    this.version = version;
    this.workchain = workchain;
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

  /**
   * - **No `derivationPath`** (or Python's marker `m/44'/607'/0'/0/0`): TON's
   *   own mnemonic scheme, as TON wallets and the Python SDK derive it — one
   *   key per mnemonic, so a wallet's own words give its W5 account. A
   *   passphrase is refused: Python ignores it, so honouring it would give a
   *   key Python does not.
   * - **A `derivationPath`** (`derivationPath({ account })`): BIP-39 and
   *   SLIP-0010 at that path — many accounts from one mnemonic. Note that
   *   `m/44'/607'/0'` is account 0 of this scheme, not Python's key.
   */
  static fromMnemonic(
    mnemonicStr: string,
    opts: { derivationPath?: string; passphrase?: string; version?: TonWalletVersion; workchain?: TonWorkchain } = {},
  ): TonWallet {
    if (opts.derivationPath === undefined || opts.derivationPath === TON_PYTHON_MARKER_PATH) {
      if (opts.passphrase !== undefined && opts.passphrase !== '') {
        throw new ChainError(
          ChainErrorKinds.InvalidArgument,
          "TON's own mnemonic scheme takes no passphrase here (the Python SDK ignores it); pass a derivationPath to use one",
        );
      }
      return new TonWallet(deriveTonNativeSeed(mnemonicStr), { version: opts.version, workchain: opts.workchain });
    }
    const index = TonWallet.indexFromDerivationPath(opts.derivationPath);
    return new TonWallet(deriveTonEd25519Seed(mnemonicToSeedBip39(mnemonicStr, opts.passphrase ?? ''), index), { version: opts.version, workchain: opts.workchain });
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
   * Every version sends external requests with "ignore errors" (+2) on every
   * message (W5 forces it; v3r2 / v4r2 get it here), so a message that cannot
   * be sent is skipped rather than failing the others — a v3r2 / v4r2
   * request whose action phase failed would keep its seqno and could land
   * again. v3r2 / v4r2 carry at most 4 messages.
   */
  createExternalRequest(args: TonRequestArgs & { deploy?: boolean }): TonExternalRequest {
    const validUntil = args.validUntil ?? defaultValidUntil();
    const body =
      this.contract instanceof WalletContractV5R1
        ? this.contract.createRequest({
            seqno: args.seqno,
            timeout: validUntil,
            secretKey: this.#secretKey,
            authType: 'external',
            actions: tonOutActions(args.messages),
          })
        : this.legacyExternalBody(args.seqno, validUntil, args.messages);
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
   * `tonRelayMessage` — the gasless path, where another account pays. W5
   * (v5r1) only: v3r2 / v4r2 wallets accept requests only as external
   * messages they pay for themselves. Send modes are kept as given, so
   * without "ignore errors" the request's messages leave all together or not
   * at all.
   */
  createInternalRequest(args: TonRequestArgs): TonInternalRequest {
    if (!(this.contract instanceof WalletContractV5R1)) {
      throw new ChainError(
        ChainErrorKinds.FeatureNotSupported,
        `Relayed (gasless) requests need a W5 (v5r1) wallet; this one is ${this.version}`,
      );
    }
    const validUntil = args.validUntil ?? defaultValidUntil();
    const body = this.contract.createRequest({
      seqno: args.seqno,
      timeout: validUntil,
      secretKey: this.#secretKey,
      authType: 'internal',
      actions: tonOutActions(args.messages),
    });
    return { body, seqno: args.seqno, validUntil };
  }

  /**
   * A v3r2 / v4r2 signed body: the signature, then wallet id, valid_until,
   * seqno, (v4r2: op 0, "send messages"), and each message with its own send
   * mode (+2) — what `@ton/ton`'s transfers build, with per-message modes.
   */
  private legacyExternalBody(seqno: number, validUntil: number, messages: readonly TonOutMessage[]): Cell {
    if (messages.length > TON_LEGACY_MAX_MESSAGES) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `A ${this.version} request carries at most ${TON_LEGACY_MAX_MESSAGES} messages, got ${messages.length}`);
    }
    const signing = beginCell()
      .storeUint((this.contract as WalletContractV4 | WalletContractV3R2).walletId, 32)
      .storeUint(validUntil, 32)
      .storeUint(seqno, 32);
    if (this.version === 'v4r2') signing.storeUint(0, 8);
    for (const action of tonOutActions(messages)) {
      signing.storeUint(action.mode | SendMode.IGNORE_ERRORS, 8).storeRef(beginCell().store(storeMessageRelaxed(action.outMsg)).endCell());
    }
    const signature = sign(signing.endCell().hash(), this.#secretKey);
    return beginCell().storeBuffer(signature).storeBuilder(signing).endCell();
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
    const seqno = await tonChain.getSeqno(this._address);
    // At seqno 0 the wallet may have no code yet; a StateInit sent to a
    // deployed wallet is ignored.
    const request = this.createExternalRequest({ seqno, messages: transaction.messages, validUntil: transaction.validUntil, deploy: seqno === 0 });
    return new TonSignedTransaction({ chainId: transaction.chainId, boc: request.boc });
  }

  /** An ed25519 signature over {@link tonMessageHash}, hex; never over the message's bytes, which could pass for a request hash. */
  signMessage(message: string): TonSignedMessage {
    return new TonSignedMessage(sign(tonMessageHash(message), this.#secretKey).toString('hex'));
  }

  /**
   * A TonConnect `ton_proof` of this wallet, as a wallet app would give it:
   * for signing in where a wallet app is not at hand (`TonChain.verifyTonProof`).
   */
  signTonProof(args: { domain: string; payload: string; timestamp?: number }): TonProofInput {
    const timestamp = args.timestamp ?? Math.floor(Date.now() / 1000);
    const address = new TonAddress(this._address);
    return {
      address: this._address,
      network: '-239',
      publicKey: this.publicKey.toString('hex'),
      proof: {
        timestamp,
        domain: { lengthBytes: Buffer.byteLength(args.domain, 'utf8'), value: args.domain },
        payload: args.payload,
        signature: sign(tonProofDigest(address, args.domain, timestamp, args.payload), this.#secretKey).toString('base64'),
        stateInit: beginCell().store(storeStateInit(this.stateInit)).endCell().toBoc().toString('base64'),
      },
    };
  }

  /** A TonConnect `signData` of `text`, as a wallet app would give it (`verifyTonSignData`). */
  signTextData(args: { text: string; domain: string; timestamp?: number }): TonSignDataTextResult {
    const timestamp = args.timestamp ?? Math.floor(Date.now() / 1000);
    const digest = tonSignDataTextDigest(new TonAddress(this._address), args.domain, timestamp, args.text);
    return {
      signature: sign(digest, this.#secretKey).toString('base64'),
      address: this._address,
      timestamp,
      domain: args.domain,
      payload: { type: 'text', text: args.text },
    };
  }

  verifySignature(message: string, signedMessage: AbstractSignedMessage): boolean {
    return TonChain.verifySignature(this.publicKey, message, signedMessage);
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
