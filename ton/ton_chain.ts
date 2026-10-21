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
import { TonAddress, tonRawAddress } from './ton_address.ts';
import { TonAsset } from './ton_asset.ts';
import { tonCommentBody, tonJettonTransferBody } from './ton_messages.ts';
import {
  type TonAccountState,
  TonFallbackProvider,
  type TonHttpEndpoint,
  type TonProvider,
  TonProviderError,
  type TonTrace,
} from './ton_provider.ts';
import { ToncenterProvider } from './ton_toncenter.ts';
import { TonapiProvider } from './ton_tonapi.ts';
import { type TonTraceSummary, TonTransactionStatus, summarizeTonTrace } from './ton_transaction_status.ts';
import { TonSignedTransaction, TonUnsignedTransaction, tonExternalBocHash } from './ton_transactions.ts';

/** TON a jetton transfer carries to the sender's jetton wallet; the excess returns to `responseDestination`. */
export const DEFAULT_JETTON_TRANSFER_ATTACHED_NANOTON = 50_000_000n;
/** TON forwarded to the jetton recipient with the transfer notification. */
export const DEFAULT_JETTON_FORWARD_NANOTON = 1n;

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

  /** 0 while the wallet is not deployed. */
  async getSeqno(address: string): Promise<number> {
    const state = await this.getAccountState(address);
    return state.status === 'active' ? this.provider.getSeqno(tonRawAddress(address)) : 0;
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
        messages: [{ to: req.to, value: resolved.amountMr, body: comment, bounce: false }],
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

  /** Sends an external message (base64 BOC or bytes) and returns its normalized hash. */
  async broadcast(signed: string | Uint8Array, opts?: BroadcastOpts): Promise<string> {
    if (opts?.signal !== undefined) {
      throw new ChainError(ChainErrorKinds.FeatureNotSupported, 'TON broadcast does not take a signal', { chainId: this.chainId });
    }
    const boc = typeof signed === 'string' ? signed : Buffer.from(signed).toString('base64');
    const hash = tonExternalBocHash(boc);
    try {
      await this.provider.sendBoc(boc);
    } catch (err) {
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
  getChainTipHeight(): Promise<number> {
    return this.provider.getMasterchainSeqno();
  }

  /**
   * Whether a request signed with `seqno` and `validUntil` can no longer land:
   * its validity has passed and the wallet's seqno never moved past it.
   */
  async isRequestExpired(args: { wallet: string; seqno: number; validUntil: number; now?: number }): Promise<boolean> {
    const now = args.now ?? Math.floor(Date.now() / 1000);
    if (now <= args.validUntil) return false;
    return (await this.getSeqno(args.wallet)) <= args.seqno;
  }

  /** TON addresses do not reveal their key, so a signature cannot be checked against one. */
  async verifyMessageSignature(_req: VerifyMessageSignatureRequest): Promise<boolean> {
    throw new ChainError(
      ChainErrorKinds.FeatureNotSupported,
      'TON message signatures need the signer public key; use TonWallet.verifySignature',
      { chainId: this.chainId },
    );
  }

  private async statusOf(hash: string, opts: TonGetTransactionStatusOpts): Promise<TonTransactionStatus> {
    if (!/^[0-9a-f]{64}$/.test(hash)) {
      throw new ChainError(ChainErrorKinds.InvalidArgument, `A TON transaction id is 64 lowercase hex characters, got ${hash}`, {
        chainId: this.chainId,
      });
    }
    const trace = await this.provider.getTrace(hash);
    const masterchainTip = trace === null ? 0 : await this.provider.getMasterchainSeqno();
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
