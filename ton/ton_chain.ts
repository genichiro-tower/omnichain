import type { Cell } from '@ton/core';
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
import type { AbstractSignedMessage } from '../wallet.base.ts';
import { TonAddress, tonRawAddress } from './ton_address.ts';
import { TonAsset } from './ton_asset.ts';
import { TonSignedMessage, tonCommentBody, tonJettonTransferBody, tonMessageHash, tonW5RequestFields } from './ton_messages.ts';
import {
  type TonAccountState,
  TonBroadcastUncertainError,
  TonFallbackProvider,
  type TonHttpEndpoint,
  type TonProvider,
  TonProviderError,
  type TonTrace,
  assertTonTxHash,
} from './ton_provider.ts';
import { ToncenterProvider } from './ton_toncenter.ts';
import { TonapiProvider } from './ton_tonapi.ts';
import { type TonTraceSummary, TonTransactionStatus, summarizeTonTrace } from './ton_transaction_status.ts';
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

  getWalletExplorerUrl(address: string): string {
    return `${this.explorerBaseUrl}/${new TonAddress(address).toUserFriendly({ bounceable: false })}`;
  }

  getTokenExplorerUrl(tokenIdentifier?: string): string {
    return tokenIdentifier === undefined ? this.explorerBaseUrl : this.getWalletExplorerUrl(tokenIdentifier);
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
   * jetton through the sender's jetton wallet with
   * {@link DEFAULT_JETTON_TRANSFER_ATTACHED_NANOTON} attached and the excess
   * returned to the sender.
   */
  async createTransferUnsignedTransaction(req: CreateTransferRequest): Promise<TonUnsignedTransaction> {
    if (req.from === undefined) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'TON transfers need `from`', { chainId: this.chainId });
    }
    if (req.gasPricing !== undefined) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'TON transfers take no gasPricing', { chainId: this.chainId });
    }
    const jettonMaster = req.tokenIdentifier;
    if (jettonMaster !== undefined && req.amount === undefined) {
      throw new ChainError(
        ChainErrorKinds.InvalidArgument,
        'Jetton transfers take `amount` in the jetton smallest unit; the SDK does not read jetton metadata',
        { chainId: this.chainId },
      );
    }
    // A jetton's decimals only matter for `amountHr`, which was just refused.
    const resolved = resolveTransferAmount(req, jettonMaster === undefined ? TonAsset.NATIVE_DECIMALS : 0);
    if (resolved.kind === 'full') {
      throw new ChainError(ChainErrorKinds.FeatureNotSupported, 'TON transfers take an exact amount', { chainId: this.chainId });
    }
    const comment = req.memo === undefined ? undefined : tonCommentBody(req.memo);
    if (jettonMaster === undefined) {
      return new TonUnsignedTransaction({
        chainId: this.chainId,
        walletAddress: req.from,
        // The destination's own form says whether it may bounce: `EQ…` asks for
        // a refund if it fails, `UQ…` (and the flagless raw form) does not —
        // the form for an address with no wallet deployed yet.
        messages: [{ to: req.to, value: resolved.amountMr, body: comment, bounce: new TonAddress(req.to).isBounceable ?? false }],
      });
    }
    return new TonUnsignedTransaction({
      chainId: this.chainId,
      walletAddress: req.from,
      messages: [
        {
          to: await this.getJettonWalletAddress(jettonMaster, req.from),
          value: DEFAULT_JETTON_TRANSFER_ATTACHED_NANOTON,
          bounce: true,
          body: tonJettonTransferBody({
            amount: resolved.amountMr,
            destination: req.to,
            responseDestination: req.from,
            forwardTonAmount: DEFAULT_JETTON_FORWARD_NANOTON,
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
    return { trace, ...summarizeTonTrace(this.chainId, trace) };
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
          const signedSeqno = tonW5RequestFields(root.inMsg?.body as Cell).seqno;
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

  private async statusOf(hash: string, opts: TonGetTransactionStatusOpts): Promise<TonTransactionStatus> {
    this.assertTxHash(hash);
    const trace = await this.provider.getTrace(hash);
    const masterchainTip = trace === null ? 0 : (await this.provider.getMasterchainHead()).seqno;
    return TonTransactionStatus.fromTrace({
      chainId: this.chainId,
      trace,
      masterchainTip,
      minMasterchainDepth: opts.minMasterchainDepth,
    });
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
