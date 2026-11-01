import { type Cell, SendMode } from '@ton/core';
import { signVerify } from '@ton/crypto';

import {
  type BroadcastOpts,
  Chain,
  type CreateTransferRequest,
  type GetTransactionStatusOpts,
  type VerifyMessageSignatureRequest,
  resolveTransferAmount,
} from '../chain.base.ts';
import { ChainType } from '../chain_type.ts';
import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType } from '../network_type.ts';
import { AssetBalanceChange, type NestedBalanceChanges } from '../transaction_status.ts';
import type { AbstractSignedMessage } from '../wallet.base.ts';
import { TonAddress, tonRawAddress } from './ton_address.ts';
import { TonAsset } from './ton_asset.ts';
import { type TonJettonMetadata, type TonMetadataFetcher, readTonJettonMetadata } from './ton_jetton_metadata.ts';
import {
  TON_JETTON_EXCESSES_OP,
  TON_JETTON_INTERNAL_TRANSFER_OP,
  TON_JETTON_TRANSFER_NOTIFICATION_OP,
  TON_JETTON_TRANSFER_OP,
  TonSignedMessage,
  tonCommentBody,
  tonJettonTransferBody,
  tonJettonTransferCommentOf,
  tonTextCommentOf,
  tonMessageHash,
  tonWalletRequestFields,
} from './ton_messages.ts';
import {
  type TonAccountState,
  TonBroadcastUncertainError,
  TonFallbackProvider,
  type TonHttpEndpoint,
  type TonJettonWalletData,
  type TonProvider,
  TonProviderError,
  type TonTrace,
  type TonTraceMessage,
  type TonTraceTransaction,
  type TonAccountTransaction,
  assertTonTxHash,
} from './ton_provider.ts';
import { type TonProofInput, type TonProofOptions, type TonProofResult, verifyTonProof } from './ton_proof.ts';
import { ToncenterProvider } from './ton_toncenter.ts';
import { TonapiProvider } from './ton_tonapi.ts';
import { type TonTraceSummary, TonTransactionStatus, summarizeTonTrace, tonJettonCreditsOf } from './ton_transaction_status.ts';
import { TonSignedTransaction, TonUnsignedTransaction, tonExternalBocHash } from './ton_transactions.ts';

/** TON a jetton transfer carries to the sender's jetton wallet; the excess returns to `responseDestination`. */
export const DEFAULT_JETTON_TRANSFER_ATTACHED_NANOTON = 50_000_000n;
/** TON forwarded to the jetton recipient with the transfer notification. */
export const DEFAULT_JETTON_FORWARD_NANOTON = 1n;
/**
 * How far past a request's `validUntil` the masterchain must be before the
 * request counts as expired; shard blocks and the provider's state can trail
 * the masterchain head by a few seconds.
 */
export const REQUEST_EXPIRY_MARGIN_SECONDS = 60;

function strictHex(value: string, bytes: number, what: string): Buffer {
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(value)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `A TON ${what} is ${bytes * 2} hex characters`);
  }
  return Buffer.from(value, 'hex');
}

/** A wallet-to-wallet jetton transfer a trace completed, its master vouching for both jetton wallets. */
export interface TonJettonTransfer {
  /** Raw. */
  jettonMaster: string;
  /** The sending owner, raw. */
  from: string;
  /** The receiving owner, raw. */
  to: string;
  /** In the jetton's smallest unit. */
  amount: bigint;
  senderJettonWallet: string;
  recipientJettonWallet: string;
  /** The receiving jetton wallet's transaction, which moved the jettons. */
  transaction: TonTraceTransaction;
  /** The text comment the transfer forwards to the recipient, if any. */
  comment: string | null;
}

/** One transfer into or out of an account, as `TonChain.getAccountTransfers` reads it from a trace. */
export interface TonAccountTransfer {
  direction: 'RECEIVE' | 'SEND';
  asset: { kind: 'native' } | { kind: 'jetton'; jettonMaster: string };
  /** The sending owner, raw. */
  from: string;
  /** The receiving owner, raw. */
  to: string;
  /** Nanotons, or the jetton's smallest unit. */
  amount: bigint;
  /** The text comment it carried, if any. */
  comment: string | null;
  /**
   * The transaction that moved it: for native TON the account's own (the one
   * that received or sent it); for jettons the receiving jetton wallet's.
   */
  transaction: TonTraceTransaction;
  /**
   * With `transaction.hash` and `direction`, names the transfer, the same on
   * every read and provider: a native SEND's position among its transaction's
   * outgoing messages ordered by creation lt; 0 for a receipt and for a jetton
   * transfer (one each per transaction).
   */
  index: number;
  /**
   * The transfer will not change: its transaction is in a finalized
   * masterchain block — and, for a native transfer whose message is shaped
   * like a jetton message, the trace is complete, since only then is it known
   * whether that message was part of a jetton transfer.
   */
  final: boolean;
  /** Native only: a bounce of a message the account had sent, coming back. */
  bounced: boolean;
}

/** What an account sent and received in one trace. */
export interface TonAccountTransfers {
  trace: TonTrace;
  /** The trace is complete and every transaction in it is final: no transfer will be added or change. */
  settled: boolean;
  transfers: TonAccountTransfer[];
}

/** The messages a jetton wallet sends its owner or the response address once it took the jettons. */
const JETTON_FOLLOW_UP_OPS: ReadonlySet<number> = new Set([TON_JETTON_TRANSFER_NOTIFICATION_OP, TON_JETTON_EXCESSES_OP]);

/** Every opcode a jetton transfer's messages use: a message bearing one may turn out to be part of one. */
const JETTON_MESSAGE_OPS: ReadonlySet<number> = new Set([
  TON_JETTON_TRANSFER_OP,
  TON_JETTON_INTERNAL_TRANSFER_OP,
  TON_JETTON_TRANSFER_NOTIFICATION_OP,
  TON_JETTON_EXCESSES_OP,
]);

const isJettonShaped = (message: TonTraceMessage): boolean => message.opcode !== null && JETTON_MESSAGE_OPS.has(message.opcode);

/** Names one message: its sender and creation lt. */
const messageKey = (source: string | null, createdLt: bigint | null): string => `${source}:${createdLt}`;

/** Where a signed request stands; see `TonChain.getRequestState`. */
export type TonRequestState = 'live' | 'expired' | 'consumed';

export interface TonProviderEndpoint {
  url: string;
  /**
   * Required: the family never calls a provider without a key. When absent it
   * is read at first use from `TONCENTER_API_KEY` / `TONAPI_API_KEY`.
   */
  apiKey?: string | null;
  timeoutMs?: number;
}

export interface TonChainInit {
  chainId: number;
  name: string;
  explorerUrl: string;
  /** The main provider, TON Center v3. */
  toncenter: TonProviderEndpoint;
  /** The fallback, TonAPI; without a key there is no fallback. */
  tonapi?: TonProviderEndpoint | null;
  /** Replaces both, e.g. in tests. */
  provider?: TonProvider;
  /** Fetches a jetton's off-chain metadata JSON (https); replaceable, e.g. in tests. */
  fetchMetadata?: TonMetadataFetcher;
}

/** A transfer, with TON's own options; see `TonChain.createTransferUnsignedTransaction`. */
export interface TonTransferOptions extends CreateTransferRequest {
  /** Overrides the message's bounce flag. */
  bounce?: boolean;
  /** Overrides the send mode. */
  sendMode?: number;
  /** Jetton transfers: TON attached to the sender's jetton wallet. */
  jettonAttachedNanoton?: bigint;
  /** Jetton transfers: TON forwarded to the recipient with the transfer notification. */
  forwardTonAmountNanoton?: bigint;
}

export interface TonGetTransactionStatusOpts extends GetTransactionStatusOpts {
  /** Masterchain blocks required after the trace is final. 0 by default: TON finality needs none. */
  minMasterchainDepth?: number;
}

export interface TonEmulationResult extends TonTraceSummary {
  trace: TonTrace;
}

/**
 * A TON chain, read through TON Center v3 with TonAPI as the fallback.
 *
 * Transaction ids are normalized external-message hashes (lowercase hex), and
 * a transaction's status covers its whole trace.
 */
export class TonChain extends Chain {
  readonly #init: TonChainInit;
  readonly #jettons = new Map<string, TonAsset>();
  #provider: TonProvider | null;
  private readonly _nativeAsset: TonAsset;

  constructor(init: TonChainInit) {
    super(init.chainId, init.name, NetworkType.TON, 5, 'TON', init.explorerUrl);
    this.#init = init;
    this.#provider = init.provider ?? null;
    this._nativeAsset = new TonAsset(init.chainId, 'TON', null, TonAsset.NATIVE_DECIMALS);
  }

  /** The configured provider, built on first use so a chain without keys can still be constructed. */
  get provider(): TonProvider {
    if (this.#provider === null) {
      const toncenter = endpointOf('TON Center', this.#init.toncenter, 'TONCENTER_API_KEY');
      if (toncenter === null) {
        throw new ChainError(ChainErrorKinds.RpcNotConfigured, `${this.name}: a TON Center API key is required`, {
          chainId: this.chainId,
        });
      }
      const tonapi =
        this.#init.tonapi === undefined || this.#init.tonapi === null
          ? null
          : endpointOf('TonAPI', this.#init.tonapi, 'TONAPI_API_KEY');
      this.#provider = new TonFallbackProvider(
        new ToncenterProvider(toncenter),
        tonapi === null ? null : new TonapiProvider(tonapi),
      );
    }
    return this.#provider;
  }

  get chainType(): ChainType {
    return ChainType.TON;
  }

  get nativeToken(): TonAsset {
    return this._nativeAsset;
  }

  get nativeAsset(): TonAsset {
    return this._nativeAsset;
  }

  getWalletExplorerUrl(address: string): string {
    return `${this.explorerBaseUrl}/${new TonAddress(address).toUserFriendly({ bounceable: false })}`;
  }

  /** A jetton master is a contract, so its link uses the bounceable (`EQ…`) form. */
  getTokenExplorerUrl(tokenIdentifier?: string): string {
    if (tokenIdentifier === undefined) return this.explorerBaseUrl;
    return `${this.explorerBaseUrl}/${new TonAddress(tokenIdentifier).toUserFriendly({ bounceable: true })}`;
  }

  /** `null` for native TON. */
  getAssetExplorerUrl(asset: TonAsset): string | null {
    if (!(asset instanceof TonAsset)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Invalid asset ${String(asset)}, expected TonAsset`, { chainId: this.chainId });
    }
    return asset.jettonMaster === null ? null : this.getTokenExplorerUrl(asset.jettonMaster);
  }

  getTransactionExplorerUrl(txHash: string): string {
    return `${this.explorerBaseUrl}/transaction/${txHash}`;
  }

  validateAddress(raw: string): boolean {
    try {
      const { workchain } = new TonAddress(raw);
      return workchain === 0 || workchain === -1;
    } catch {
      return false;
    }
  }

  validateTokenIdentifier(raw: string | undefined): boolean {
    return raw === undefined || this.validateAddress(raw);
  }

  getAccountState(address: string): Promise<TonAccountState> {
    return this.provider.getAccountState(tonRawAddress(address));
  }

  /**
   * The wallet's seqno, read live from its get-method rather than from the
   * indexed account state, which can trail a deploy; 0 while it has no code.
   */
  getSeqno(address: string): Promise<number> {
    return this.provider.getSeqno(tonRawAddress(address));
  }

  /**
   * Native TON for no identifier; otherwise the jetton whose master
   * `identifier` names, its symbol and decimals read from its TEP-64
   * metadata ({@link getJettonMetadata}). Resolved jettons are kept for the
   * chain's lifetime.
   */
  async resolveAsset(identifier: string | null | undefined): Promise<TonAsset> {
    if (identifier === null || identifier === undefined) return this._nativeAsset;
    const master = tonRawAddress(identifier);
    const known = this.#jettons.get(master);
    if (known !== undefined) return known;
    const metadata = await this.getJettonMetadata(master);
    // As Python does: a jetton whose metadata names no symbol is called by its address's first characters.
    const symbol = metadata.symbol ?? new TonAddress(master).toUserFriendly({ bounceable: true }).slice(0, 4);
    const asset = new TonAsset(this.chainId, symbol, master, metadata.decimals);
    this.#jettons.set(master, asset);
    return asset;
  }

  /**
   * A jetton's TEP-64 metadata: the master's `get_jetton_data` content, and the
   * off-chain JSON its URI names (https) for what the content lacks. Throws
   * `InvalidTokenIdentifier` for anything that is not a jetton master, and
   * (retryably) when the decimals cannot be read.
   */
  async getJettonMetadata(jettonMaster: string): Promise<TonJettonMetadata> {
    return readTonJettonMetadata(await this.provider.getJettonContent(tonRawAddress(jettonMaster)), this.#init.fetchMetadata);
  }

  createAsset(symbol: string, identifier: string | null | undefined, decimals: number): TonAsset {
    if (identifier === null || identifier === undefined) {
      if (symbol !== 'TON' || decimals !== TonAsset.NATIVE_DECIMALS) {
        throw new ChainError(ChainErrorKinds.InvalidArgument, `Native TON is TON with ${TonAsset.NATIVE_DECIMALS} decimals`, { chainId: this.chainId });
      }
      return this._nativeAsset;
    }
    return this.getJettonAsset(symbol, identifier, decimals);
  }

  getJettonAsset(symbol: string, jettonMaster: string, decimals: number): TonAsset {
    return new TonAsset(this.chainId, symbol, jettonMaster, decimals);
  }

  /** The jetton wallet `owner` has (or will have) for `jettonMaster`, raw. */
  getJettonWalletAddress(jettonMaster: string, owner: string): Promise<string> {
    return this.provider.getJettonWalletAddress(tonRawAddress(jettonMaster), tonRawAddress(owner));
  }

  /** Nanotons, or the jetton's smallest unit when `tokenIdentifier` is a jetton master. */
  async getBalance(owner: string, tokenIdentifier?: string): Promise<bigint> {
    if (tokenIdentifier === undefined) return (await this.getAccountState(owner)).balance;
    return this.provider.getJettonBalance(await this.getJettonWalletAddress(tokenIdentifier, owner));
  }

  /**
   * A transfer from `from`: native TON (with `memo` as a text comment), or a
   * jetton through the sender's jetton wallet, the excess returned to the
   * sender. `amountHr` takes the jetton's decimals from its metadata.
   *
   * - `isFullBalance`: native TON sends everything the wallet holds (send mode
   *   128 + 2, value 0); a jetton sends the jetton wallet's whole balance.
   * - Native `bounce`, unless given: only to a bounceable (`EQ…`) address
   *   that is deployed — a contract that fails then returns the TON, and a
   *   wallet not deployed yet still receives it, as TON wallets send.
   * - Jetton transfers are always bounceable unless `bounce` says otherwise,
   *   carry {@link DEFAULT_JETTON_TRANSFER_ATTACHED_NANOTON} and forward
   *   {@link DEFAULT_JETTON_FORWARD_NANOTON}; `jettonAttachedNanoton`,
   *   `forwardTonAmountNanoton` and `sendMode` override.
   */
  async createTransferUnsignedTransaction(req: TonTransferOptions): Promise<TonUnsignedTransaction> {
    if (req.from === undefined) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'TON transfers need `from`', { chainId: this.chainId });
    }
    if (req.gasPricing !== undefined) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'TON transfers take no gasPricing', { chainId: this.chainId });
    }
    const from = req.from;
    const comment = req.memo === undefined ? undefined : tonCommentBody(req.memo);
    const jettonMaster = req.tokenIdentifier;
    if (jettonMaster === undefined) {
      const resolved = resolveTransferAmount(req, TonAsset.NATIVE_DECIMALS);
      const full = resolved.kind === 'full';
      return new TonUnsignedTransaction({
        chainId: this.chainId,
        walletAddress: from,
        messages: [
          {
            to: req.to,
            value: full ? 0n : resolved.amountMr,
            body: comment,
            bounce: req.bounce ?? (await this.bouncesByDefault(req.to)),
            mode: req.sendMode ?? (full ? SendMode.CARRY_ALL_REMAINING_BALANCE | SendMode.IGNORE_ERRORS : undefined),
          },
        ],
      });
    }
    // Only a human-readable amount needs the jetton's decimals, and so its metadata.
    const decimals = req.amountHr === undefined ? 0 : (await this.resolveAsset(jettonMaster)).decimals;
    const resolved = resolveTransferAmount(req, decimals);
    const amount = resolved.kind === 'full' ? await this.getBalance(from, jettonMaster) : resolved.amountMr;
    if (amount === 0n) {
      throw new ChainError(ChainErrorKinds.InsufficientFunds, `${from} holds none of ${jettonMaster}`, { chainId: this.chainId });
    }
    return new TonUnsignedTransaction({
      chainId: this.chainId,
      walletAddress: from,
      messages: [
        {
          to: await this.getJettonWalletAddress(jettonMaster, from),
          value: req.jettonAttachedNanoton ?? DEFAULT_JETTON_TRANSFER_ATTACHED_NANOTON,
          bounce: req.bounce ?? true,
          mode: req.sendMode,
          body: tonJettonTransferBody({
            amount,
            destination: req.to,
            responseDestination: from,
            forwardTonAmount: req.forwardTonAmountNanoton ?? DEFAULT_JETTON_FORWARD_NANOTON,
            forwardPayload: comment,
          }),
        },
      ],
    });
  }

  /**
   * Emulates the whole trace of an external message (signature ignored): what
   * it would cost, and whether every transaction would succeed with nothing
   * bounced. Throws `SimulationFailed` when the message would be refused
   * outright.
   */
  async emulate(boc: string): Promise<TonEmulationResult> {
    const trace = await this.provider.emulate(boc);
    const summary = summarizeTonTrace(this.chainId, trace);
    await this.addJettonBalanceChanges(trace, summary.balanceChanges);
    return { trace, ...summary };
  }

  /**
   * Sends an external message (base64 BOC or bytes) and returns its normalized
   * hash. Throws `TonBroadcastUncertainError` when the message may have reached
   * the network anyway; re-signing then can pay twice.
   */
  async broadcast(signed: string | Uint8Array, opts?: BroadcastOpts): Promise<string> {
    if (opts?.signal !== undefined) {
      throw new ChainError(ChainErrorKinds.FeatureNotSupported, 'TON broadcast does not take a signal', { chainId: this.chainId });
    }
    const boc = typeof signed === 'string' ? signed : Buffer.from(signed).toString('base64');
    const hash = tonExternalBocHash(boc);
    try {
      await this.provider.sendBoc(boc);
    } catch (err) {
      if (err instanceof TonBroadcastUncertainError) {
        throw new TonBroadcastUncertainError(err.message, { chainId: this.chainId, txHash: hash }, err);
      }
      if (err instanceof TonProviderError) {
        throw new ChainError(err.kind, err.message, { chainId: this.chainId, txHash: hash }, err);
      }
      throw err;
    }
    return hash;
  }

  broadcastSignedTransaction(signed: TonSignedTransaction): Promise<string> {
    if (signed.chainId !== this.chainId) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `Signed for chain ${signed.chainId}, not ${this.chainId}`);
    }
    return this.broadcast(signed.boc);
  }

  getTransactionStatus(txHash: string, opts?: TonGetTransactionStatusOpts): Promise<TonTransactionStatus>;
  getTransactionStatus(txHashes: string[], opts?: TonGetTransactionStatusOpts): Promise<TonTransactionStatus[]>;
  async getTransactionStatus(
    hashOrHashes: string | string[],
    opts: TonGetTransactionStatusOpts = {},
  ): Promise<TonTransactionStatus | TonTransactionStatus[]> {
    if (Array.isArray(hashOrHashes)) {
      const statuses: TonTransactionStatus[] = [];
      for (const hash of hashOrHashes) statuses.push(await this.statusOf(hash, opts));
      return statuses;
    }
    return this.statusOf(hashOrHashes, opts);
  }

  /** The masterchain's latest block. */
  /** The whole trace holding the account transaction `txHash`, from its root; `null` while the providers have not seen it. */
  getTraceByTransaction(txHash: string): Promise<TonTrace | null> {
    this.assertTxHash(txHash);
    return this.provider.getTraceByTransaction(txHash);
  }

  /** The account's transactions with an lt above `afterLt` (0 for all), oldest first, at most `limit` (1 to 100, default 100). */
  getAccountTransactions(account: string, opts: { afterLt?: bigint; limit?: number } = {}): Promise<TonAccountTransaction[]> {
    return this.provider.getAccountTransactions(tonRawAddress(account), { afterLt: opts.afterLt ?? 0n, limit: opts.limit ?? 100 });
  }

  /** The lt of the account's last transaction; 0 for an account that never had one. */
  getLastTransactionLt(account: string): Promise<bigint> {
    return this.provider.getLastTransactionLt(tonRawAddress(account));
  }

  async getChainTipHeight(): Promise<number> {
    return (await this.provider.getMasterchainHead()).seqno;
  }

  /**
   * Where a signed request stands, so it is never replaced while it can still
   * execute — the one check to make before signing a replacement, after a
   * `Failed` relayed request or an uncertain broadcast:
   * - `consumed`: the wallet's seqno has moved past the request's, or (given
   *   `hash`, for an external request) the request has a trace. It executed —
   *   or another request signed with the same seqno did. Do not re-sign it;
   *   read its status (`getTransactionStatus(hash)`, or the relay's).
   * - `expired`: the chain's own time (not this machine's) is past
   *   `validUntil` by {@link REQUEST_EXPIRY_MARGIN_SECONDS}, with the seqno
   *   not moved past it and no trace. It can never execute; replacing it is
   *   safe.
   * - `live`: neither yet. It can still execute — a relayed request that
   *   failed included: W5 keeps an internal request's seqno only when the
   *   transaction succeeds, so anyone can deliver it again from the trace
   *   until `validUntil`.
   *
   * `wallet` is the wallet that signed it: the sender of an external request,
   * the target of a relayed one (pass no `hash` for a relayed request; a
   * relay's own hash is the relayer's request). All reads come from one
   * provider.
   */
  async getRequestState(args: { wallet: string; seqno: number; validUntil: number; hash?: string }): Promise<TonRequestState> {
    if (args.hash !== undefined) this.assertTxHash(args.hash);
    const wallet = tonRawAddress(args.wallet);
    return this.onOneProvider('getRequestState', async (provider) => {
      if ((await provider.getSeqno(wallet)) > args.seqno) return 'consumed';
      const trace = args.hash === undefined ? null : await provider.getTrace(args.hash);
      if (trace !== null) {
        // A relay's hash names the relayer's request, not the relayed one: its
        // trace says nothing about whether the target's request executed.
        const root = trace.transactions[0];
        if (root !== undefined && root.parent === null) {
          if (root.account !== wallet) {
            throw new ChainError(
              ChainErrorKinds.InvalidArgument,
              `${args.hash} is a request of ${root.account}, not of ${wallet}; for a relayed request pass no hash`,
              { chainId: this.chainId, txHash: args.hash },
            );
          }
          // The provider bound the trace to `hash`, so its root carries the signed request.
          const signedSeqno = tonWalletRequestFields(root.inMsg?.body as Cell).seqno;
          if (signedSeqno !== args.seqno) {
            throw new ChainError(
              ChainErrorKinds.InvalidArgument,
              `${args.hash} was signed at seqno ${signedSeqno}, not ${args.seqno}`,
              { chainId: this.chainId, txHash: args.hash },
            );
          }
        }
        return 'consumed';
      }
      const head = await provider.getMasterchainHead();
      return head.utime > args.validUntil + REQUEST_EXPIRY_MARGIN_SECONDS ? 'expired' : 'live';
    });
  }

  /** Native TON bounces only to a bounceable (`EQ…`) address that is deployed. */
  private async bouncesByDefault(to: string): Promise<boolean> {
    if (new TonAddress(to).isBounceable !== true) return false;
    return (await this.getAccountState(to)).status === 'active';
  }

  private assertTxHash(hash: string): void {
    try {
      assertTonTxHash(hash);
    } catch (err) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, (err as Error).message, { chainId: this.chainId });
    }
  }

  private onOneProvider<T>(method: string, run: (provider: TonProvider) => Promise<T>): Promise<T> {
    const provider = this.provider;
    return provider instanceof TonFallbackProvider ? provider.onOneProvider(method, run) : run(provider);
  }

  /**
   * Whether `signedMessage` is `publicKey`'s signature of `message`
   * (`TonWallet.signMessage`: ed25519 over {@link tonMessageHash}). Needs only
   * the public key — 32 bytes, or 64 hex characters — as Tron's and
   * Stellar's do. A signature must be exactly 128 hex characters.
   */
  static verifySignature(publicKey: Uint8Array | string, message: string, signedMessage: AbstractSignedMessage): boolean {
    if (!(signedMessage instanceof TonSignedMessage)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `TonChain expected a TonSignedMessage, got ${signedMessage?.constructor?.name ?? typeof signedMessage}`);
    }
    const key = typeof publicKey === 'string' ? strictHex(publicKey, 32, 'public key') : Buffer.from(publicKey);
    if (key.length !== 32) throw new ChainError(ChainErrorKinds.InvalidArgument, `A TON public key is 32 bytes, got ${key.length}`);
    if (!/^[0-9a-fA-F]{128}$/.test(signedMessage.signature)) return false;
    try {
      return signVerify(tonMessageHash(message), Buffer.from(signedMessage.signature, 'hex'), key);
    } catch {
      return false;
    }
  }

  /**
   * TON addresses do not reveal their key, so a signature cannot be checked
   * against an address alone: use `TonChain.verifySignature` with the
   * signer's public key (its W5 address is `WalletContractV5R1.create({
   * publicKey, workchain: 0 }).address`).
   */
  async verifyMessageSignature(_req: VerifyMessageSignatureRequest): Promise<boolean> {
    throw new ChainError(
      ChainErrorKinds.FeatureNotSupported,
      'TON message signatures need the signer public key; use TonChain.verifySignature(publicKey, message, signature)',
      { chainId: this.chainId },
    );
  }
  /**
   * Verifies a TonConnect `ton_proof` sign-in ({@link verifyTonProof}). The
   * chain is read only for Telegram Wallet, whose key is the live one.
   */
  verifyTonProof(input: TonProofInput, opts: TonProofOptions): Promise<TonProofResult> {
    return verifyTonProof(input, opts, () => this.provider);
  }


  private async statusOf(hash: string, opts: TonGetTransactionStatusOpts): Promise<TonTransactionStatus> {
    this.assertTxHash(hash);
    const trace = await this.provider.getTrace(hash);
    const masterchainTip = trace === null ? 0 : (await this.provider.getMasterchainHead()).seqno;
    const status = TonTransactionStatus.fromTrace({
      chainId: this.chainId,
      trace,
      masterchainTip,
      minMasterchainDepth: opts.minMasterchainDepth,
    });
    if (trace !== null && status.balanceChanges !== null) await this.addJettonBalanceChanges(trace, status.balanceChanges);
    return status;
  }

  /**
   * The transfers into and out of `account` in the trace holding the
   * transaction `txHash` — e.g. one a webhook named — or `null` while the
   * providers have no trace of it. Emit only `final` transfers; once
   * `settled`, the result will not change.
   */
  async getAccountTransfers(args: { account: string; txHash: string }): Promise<TonAccountTransfers | null> {
    const trace = await this.getTraceByTransaction(args.txHash);
    return trace === null ? null : this.accountTransfersOf(args.account, trace);
  }

  /**
   * The transfers into and out of `account` in `trace`:
   * - native TON it received — an incoming internal message whose value it
   *   kept, not one its transaction sent back as a bounce — or sent, an
   *   outgoing internal message; a bounce of its own message coming back is
   *   a receipt marked `bounced`, and the bounce it sends back is no
   *   transfer;
   * - jettons it sent or received as owner ({@link getJettonTransfers});
   * - the TON riding along a jetton transfer (`transfer`, `internal_transfer`,
   *   `transfer_notification`, `excesses`) is part of it, not a native transfer.
   */
  async accountTransfersOf(account: string, trace: TonTrace): Promise<TonAccountTransfers> {
    const owner = tonRawAddress(account);
    const found: Array<Omit<TonAccountTransfer, 'final'> & { jettonShaped: boolean }> = [];
    const jettons = await this.getJettonTransfers(trace);
    // The TON riding along a verified jetton transfer is part of it: the owner's
    // `transfer`, the `internal_transfer`, and the notification and excesses the
    // receiving jetton wallet sent. Any other message carrying value is a native
    // payment, whatever its opcode — a body that merely looks like a jetton
    // message moves real TON.
    const byHash = new Map(trace.transactions.map((tx) => [tx.hash, tx]));
    const partOfJetton = new Set<string>();
    for (const jetton of jettons) {
      const received = jetton.transaction;
      const sender = received.parent === null ? undefined : byHash.get(received.parent);
      for (const message of [sender?.inMsg ?? null, received.inMsg]) {
        if (message !== null) partOfJetton.add(messageKey(message.source, message.createdLt));
      }
      for (const message of received.outMsgs) {
        if (message.opcode !== null && JETTON_FOLLOW_UP_OPS.has(message.opcode)) partOfJetton.add(messageKey(message.source, message.createdLt));
      }
    }
    const isNativePayment = (message: TonTraceMessage): boolean =>
      message.value > 0n && !partOfJetton.has(messageKey(message.source, message.createdLt));
    for (const tx of trace.transactions) {
      if (tx.account !== owner) continue;
      const inMsg = tx.inMsg;
      if (inMsg !== null && inMsg.source !== null && isNativePayment(inMsg)) {
        const sentBack = tx.aborted && tx.outMsgs.some((m) => m.bounced && m.destination === inMsg.source);
        if (!sentBack) {
          found.push({
            direction: 'RECEIVE',
            asset: { kind: 'native' },
            from: inMsg.source,
            to: owner,
            amount: inMsg.value,
            comment: tonTextCommentOf(inMsg.body),
            transaction: tx,
            index: 0,
            bounced: inMsg.bounced,
            jettonShaped: isJettonShaped(inMsg),
          });
        }
      }
      // Ordered by creation, so a message's position does not depend on the provider's order.
      const outgoing = [...tx.outMsgs].sort((a, b) => ((a.createdLt ?? 0n) < (b.createdLt ?? 0n) ? -1 : (a.createdLt ?? 0n) > (b.createdLt ?? 0n) ? 1 : 0));
      outgoing.forEach((message, position) => {
        if (message.destination === null || message.bounced || !isNativePayment(message)) return;
        found.push({
          direction: 'SEND',
          asset: { kind: 'native' },
          from: owner,
          to: message.destination,
          amount: message.value,
          comment: tonTextCommentOf(message.body),
          transaction: tx,
          index: position,
          bounced: false,
          jettonShaped: isJettonShaped(message),
        });
      });
    }
    for (const jetton of jettons) {
      const common = {
        asset: { kind: 'jetton' as const, jettonMaster: jetton.jettonMaster },
        from: jetton.from,
        to: jetton.to,
        amount: jetton.amount,
        comment: jetton.comment,
        transaction: jetton.transaction,
        index: 0,
        bounced: false,
        jettonShaped: false,
      };
      if (jetton.from === owner) found.push({ ...common, direction: 'SEND' });
      if (jetton.to === owner) found.push({ ...common, direction: 'RECEIVE' });
    }
    const transfers = found.map(({ jettonShaped, ...transfer }) => ({
      ...transfer,
      final: transfer.transaction.mcSeqno !== null && (!jettonShaped || trace.complete),
    }));
    return { trace, settled: trace.complete && trace.transactions.every((tx) => tx.mcSeqno !== null), transfers };
  }

  /**
   * The wallet-to-wallet jetton transfers (TEP-74 `transfer` →
   * `internal_transfer`) the trace completed: a jetton wallet accepted the
   * jettons. Each counts only once its master vouches for both jetton wallets:
   * the sender's must be the master's wallet for the owner it reports, and
   * the receiving one the master's wallet for the recipient the transfer
   * named. Anything else — a contract posing as a jetton wallet, a mint or a
   * burn — is not a transfer here.
   */
  async getJettonTransfers(trace: TonTrace): Promise<TonJettonTransfer[]> {
    const byHash = new Map(trace.transactions.map((tx) => [tx.hash, tx]));
    const walletData = new Map<string, Promise<TonJettonWalletData | null>>();
    const walletOf = new Map<string, Promise<string>>();
    const dataOf = (wallet: string): Promise<TonJettonWalletData | null> => {
      if (!walletData.has(wallet)) walletData.set(wallet, this.provider.getJettonWalletData(wallet));
      return walletData.get(wallet) as Promise<TonJettonWalletData | null>;
    };
    const walletAddressOf = (master: string, owner: string): Promise<string> => {
      const key = `${master}|${owner}`;
      if (!walletOf.has(key)) walletOf.set(key, this.provider.getJettonWalletAddress(master, owner));
      return walletOf.get(key) as Promise<string>;
    };
    const transfers: TonJettonTransfer[] = [];
    for (const credit of tonJettonCreditsOf(trace)) {
      const received = byHash.get(credit.transaction);
      const sender = received?.parent === null || received?.parent === undefined ? undefined : byHash.get(received.parent);
      const recipient = sender?.inMsg === null || sender?.inMsg === undefined ? null : jettonTransferDestinationOf(sender.inMsg);
      if (credit.senderJettonWallet === null || sender === undefined || recipient === null || received === undefined) continue;
      const data = await dataOf(credit.senderJettonWallet);
      if (data === null) continue;
      const [senderWallet, recipientWallet] = await Promise.all([
        walletAddressOf(data.jettonMaster, data.owner),
        walletAddressOf(data.jettonMaster, recipient),
      ]);
      if (senderWallet !== credit.senderJettonWallet || recipientWallet !== credit.jettonWallet) continue;
      transfers.push({
        jettonMaster: data.jettonMaster,
        from: data.owner,
        to: recipient,
        amount: credit.amount,
        senderJettonWallet: credit.senderJettonWallet,
        recipientJettonWallet: credit.jettonWallet,
        transaction: received,
        comment: tonJettonTransferCommentOf(sender.inMsg?.body ?? null),
      });
    }
    return transfers;
  }

  /** Adds the verified jetton transfers' balance changes: the sending owner loses the amount, the recipient gains it. */
  private async addJettonBalanceChanges(trace: TonTrace, balanceChanges: NestedBalanceChanges): Promise<void> {
    for (const transfer of await this.getJettonTransfers(trace)) {
      const asset = await this.resolveAsset(transfer.jettonMaster);
      AssetBalanceChange.upsert(balanceChanges, transfer.from, asset, AssetBalanceChange.fromMr(-transfer.amount, asset.decimals));
      AssetBalanceChange.upsert(balanceChanges, transfer.to, asset, AssetBalanceChange.fromMr(transfer.amount, asset.decimals));
    }
  }
}

/** The recipient owner a jetton `transfer` names, raw; `null` for any other message. */
function jettonTransferDestinationOf(message: TonTraceMessage): string | null {
  if (message.opcode !== TON_JETTON_TRANSFER_OP || message.body === null) return null;
  try {
    const slice = message.body.beginParse();
    slice.skip(32 + 64);
    slice.loadCoins();
    return slice.loadAddress().toRawString();
  } catch {
    return null;
  }
}

function endpointOf(name: string, endpoint: TonProviderEndpoint, apiKeyEnv: string): TonHttpEndpoint | null {
  const apiKey = (endpoint.apiKey ?? readEnv()?.[apiKeyEnv] ?? '').trim();
  if (apiKey.length === 0) return null;
  if (!/^https:\/\//.test(endpoint.url)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `${name} URL must be https, got ${endpoint.url}`);
  }
  return { url: endpoint.url, apiKey, timeoutMs: endpoint.timeoutMs };
}

function readEnv(): Record<string, string | undefined> | undefined {
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
}
