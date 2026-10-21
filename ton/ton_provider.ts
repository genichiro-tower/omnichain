import type { Cell, Message } from '@ton/core';

import { ChainError, ChainErrorKinds, type ChainErrorKind, type ChainErrorMeta } from '../errors.ts';

export type TonAccountStatus = 'nonexist' | 'uninit' | 'active' | 'frozen';

export interface TonAccountState {
  status: TonAccountStatus;
  /** Nanotons. */
  balance: bigint;
  /** Base64 code hash; `null` until deployed. */
  codeHash: string | null;
}

export interface TonTraceMessage {
  /** Raw address; `null` for an external message's missing side. */
  source: string | null;
  destination: string | null;
  value: bigint;
  /** The forward fee the message still carries (paid by its sender on top of `value`). */
  fwdFee: bigint;
  bounce: boolean;
  bounced: boolean;
  /** The body's first 32 bits, when it has them. */
  opcode: number | null;
  /**
   * The sender's logical time when it created the message; `null` for an
   * external-in message. Unique per sender, so (source, createdLt) names one
   * message across the trace.
   */
  createdLt: bigint | null;
  body: Cell | null;
}

export interface TonTraceTransaction {
  /** Lowercase hex. */
  hash: string;
  /** The transaction whose outgoing message this one received; `null` for the root. */
  parent: string | null;
  /** Canonical raw address. */
  account: string;
  /**
   * Compute and action phases succeeded and no action was skipped. A compute
   * phase skipped because the account has no code yet (a plain transfer to an
   * undeployed address) counts as success. A W5 external request sends every
   * message with "ignore errors", so a message it could not send is skipped
   * with the action phase still reporting success — `skippedActions` is the
   * only sign, and it fails the transaction.
   */
  success: boolean;
  /** Actions the action phase skipped (messages not sent). */
  skippedActions: number;
  aborted: boolean;
  computeExitCode: number | null;
  actionResultCode: number | null;
  /** Nanotons. */
  totalFees: bigint;
  origStatus: TonAccountStatus;
  endStatus: TonAccountStatus;
  inMsg: TonTraceMessage | null;
  outMsgs: TonTraceMessage[];
  /** The masterchain block that references this transaction's block; `null` until it is final (or emulated). */
  mcSeqno: number | null;
  /** Unix seconds. */
  utime: number;
}

export interface TonTrace {
  /** No message of the trace is still in flight. */
  complete: boolean;
  /** Root (the external message's transaction) first, then breadth-first. */
  transactions: TonTraceTransaction[];
}

/**
 * The reads and writes TonChain needs, implemented by TON Center v3 and TonAPI.
 * Each normalizes its replies to these types, so a caller cannot tell which
 * provider answered.
 */
export interface TonProvider {
  readonly name: string;
  getAccountState(address: string): Promise<TonAccountState>;
  /** 0 for a wallet that is not deployed. */
  getSeqno(address: string): Promise<number>;
  getJettonWalletAddress(jettonMaster: string, owner: string): Promise<string>;
  /** 0 for a jetton wallet that is not deployed. */
  getJettonBalance(jettonWallet: string): Promise<bigint>;
  sendBoc(boc: string): Promise<void>;
  /** By the normalized external-message hash (hex); `null` while the provider has not seen it. */
  getTrace(hash: string): Promise<TonTrace | null>;
  /** Emulates the whole trace of an external message, ignoring its signature. */
  emulate(boc: string): Promise<TonTrace>;
  /** The latest masterchain block the provider has applied: its seqno and generation time (unix seconds). */
  getMasterchainHead(): Promise<TonMasterchainHead>;
}

export interface TonMasterchainHead {
  seqno: number;
  utime: number;
}

/**
 * A provider failure. `retryable` is true only for failures that say nothing
 * about the answer (transport, timeout, 429, 5xx); the fallback retries those
 * and nothing else.
 */
export class TonProviderError extends ChainError {
  readonly retryable: boolean;

  constructor(kind: ChainErrorKind, message: string, retryable: boolean, meta?: ChainErrorMeta, cause?: Error) {
    super(kind, message, meta, cause);
    this.name = 'TonProviderError';
    this.retryable = retryable;
  }
}

/**
 * A broadcast whose outcome is unknown: a provider failed without an answer,
 * so the message may have reached the network even if another provider then
 * refused it (a refusal can mean it was already accepted). Read the status of
 * `meta.txHash`, or wait until the request is expired, before signing again.
 */
export class TonBroadcastUncertainError extends TonProviderError {
  constructor(message: string, meta?: ChainErrorMeta, cause?: Error) {
    super(ChainErrorKinds.RpcError, message, false, meta, cause);
    this.name = 'TonBroadcastUncertainError';
  }
}

/**
 * TON Center v3 first; TonAPI only when TON Center fails without an answer.
 *
 * A definite answer from the primary (not found, a refused emulation, a
 * refused broadcast) is final. A broadcast retried on the fallback sends the
 * same BOC: the wallet's seqno makes a second landing impossible.
 */
export class TonFallbackProvider implements TonProvider {
  readonly name: string;

  constructor(
    private readonly primary: TonProvider,
    private readonly fallback: TonProvider | null,
    private readonly onFallback: (method: string, err: TonProviderError) => void = () => {},
  ) {
    this.name = fallback === null ? primary.name : `${primary.name}+${fallback.name}`;
  }

  getAccountState(address: string): Promise<TonAccountState> {
    return this.call('getAccountState', (p) => p.getAccountState(address));
  }

  getSeqno(address: string): Promise<number> {
    return this.call('getSeqno', (p) => p.getSeqno(address));
  }

  getJettonWalletAddress(jettonMaster: string, owner: string): Promise<string> {
    return this.call('getJettonWalletAddress', (p) => p.getJettonWalletAddress(jettonMaster, owner));
  }

  getJettonBalance(jettonWallet: string): Promise<bigint> {
    return this.call('getJettonBalance', (p) => p.getJettonBalance(jettonWallet));
  }

  /**
   * A refusal is definite only when no provider failed before it: once one
   * failed without an answer, the message may already be in flight, and a
   * later refusal may be the network rejecting a duplicate.
   */
  async sendBoc(boc: string): Promise<void> {
    try {
      await this.primary.sendBoc(boc);
      return;
    } catch (err) {
      if (!(err instanceof TonProviderError) || !err.retryable) throw err;
      if (this.fallback === null) throw new TonBroadcastUncertainError(`broadcast outcome unknown: ${err.message}`, undefined, err);
      this.onFallback('sendBoc', err);
      try {
        await this.fallback.sendBoc(boc);
      } catch (fallbackErr) {
        throw new TonBroadcastUncertainError(
          `broadcast outcome unknown: ${err.message}; then ${(fallbackErr as Error).message}`,
          undefined,
          fallbackErr as Error,
        );
      }
    }
  }

  getTrace(hash: string): Promise<TonTrace | null> {
    return this.call('getTrace', (p) => p.getTrace(hash));
  }

  emulate(boc: string): Promise<TonTrace> {
    return this.call('emulate', (p) => p.emulate(boc));
  }

  getMasterchainHead(): Promise<TonMasterchainHead> {
    return this.call('getMasterchainHead', (p) => p.getMasterchainHead());
  }

  private async call<T>(method: string, run: (provider: TonProvider) => Promise<T>): Promise<T> {
    try {
      return await run(this.primary);
    } catch (err) {
      if (this.fallback === null || !(err instanceof TonProviderError) || !err.retryable) throw err;
      this.onFallback(method, err);
      return run(this.fallback);
    }
  }
}

export interface TonHttpEndpoint {
  url: string;
  apiKey: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** One JSON request; maps every failure to a {@link TonProviderError}. Returns `null` on a 404. */
export async function tonHttpJson(
  provider: string,
  endpoint: TonHttpEndpoint,
  path: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; headers: Record<string, string> },
): Promise<unknown | null> {
  const url = `${endpoint.url.replace(/\/$/, '')}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method ?? 'GET',
      headers: { accept: 'application/json', ...(init.body === undefined ? {} : { 'content-type': 'application/json' }), ...init.headers },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: AbortSignal.timeout(endpoint.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      redirect: 'error',
    });
  } catch (err) {
    throw new TonProviderError(ChainErrorKinds.RpcError, `${provider} ${path} request failed: ${(err as Error).message}`, true, undefined, err as Error);
  }
  const text = await response.text();
  if (response.status === 404) return null;
  if (response.status === 429 || response.status >= 500) {
    throw new TonProviderError(ChainErrorKinds.RpcError, `${provider} ${path} answered HTTP ${response.status}: ${text.slice(0, 200)}`, true);
  }
  let payload: unknown;
  try {
    payload = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new TonProviderError(ChainErrorKinds.RpcError, `${provider} ${path} answered non-JSON (HTTP ${response.status})`, true);
  }
  if (response.status >= 400) {
    const message = errorMessageOf(payload) ?? text.slice(0, 200);
    throw new TonProviderError(ChainErrorKinds.RpcError, `${provider} ${path} refused (HTTP ${response.status}): ${message}`, false);
  }
  return payload;
}

/** The `error` field some replies carry with a 2xx status. */
export function errorMessageOf(payload: unknown): string | null {
  if (payload === null || typeof payload !== 'object') return null;
  const error = (payload as { error?: unknown }).error;
  return typeof error === 'string' && error.length > 0 ? error : null;
}

export function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TonProviderError(ChainErrorKinds.RpcError, `Malformed TON provider reply: ${what} is not an object`, false);
  }
  return value as Record<string, unknown>;
}

export function asBigInt(value: unknown, what: string): bigint {
  if (typeof value === 'bigint') return value;
  if ((typeof value === 'number' && Number.isInteger(value)) || (typeof value === 'string' && /^-?(\d+|0x[0-9a-fA-F]+)$/.test(value))) {
    return BigInt(value);
  }
  if (value === undefined || value === null) return 0n;
  throw new TonProviderError(ChainErrorKinds.RpcError, `Malformed TON provider reply: ${what} is not an integer`, false);
}

export function asAccountStatus(value: unknown): TonAccountStatus {
  return value === 'active' || value === 'frozen' || value === 'uninit' || value === 'nonexist' ? value : 'nonexist';
}

/** A decoded message in the trace form (raw addresses, opcode from the body). */
export function tonTraceMessageOf(message: Message): TonTraceMessage {
  const info = message.info;
  const body = message.body.bits.length === 0 && message.body.refs.length === 0 ? null : message.body;
  return {
    source: info.type === 'external-in' || info.src === null ? null : info.src.toRawString(),
    destination: info.type === 'external-out' ? null : info.dest.toRawString(),
    value: info.type === 'internal' ? info.value.coins : 0n,
    fwdFee: info.type === 'internal' ? info.forwardFee : 0n,
    bounce: info.type === 'internal' && info.bounce,
    bounced: info.type === 'internal' && info.bounced,
    opcode: body !== null && body.bits.length >= 32 ? body.beginParse().loadUint(32) : null,
    createdLt: info.type === 'external-in' ? null : info.createdLt,
    body,
  };
}

/**
 * Every internal message sent must carry its source and `created_lt`, and every
 * transaction that received a message must have received one its parent sent:
 * same source, `created_lt`, destination and value. A provider whose
 * trace breaks that is wrong, not the chain, so the error is retryable and
 * the fallback provider is asked instead.
 */
export function assertTraceConsistent(provider: string, trace: TonTrace): TonTrace {
  const byHash = new Map(trace.transactions.map((tx) => [tx.hash, tx]));
  const inconsistent = (detail: string): TonProviderError =>
    new TonProviderError(ChainErrorKinds.RpcError, `${provider} returned an inconsistent trace: ${detail}`, true);
  for (const tx of trace.transactions) {
    const unnamed = tx.outMsgs.find((m) => m.destination !== null && (m.source === null || m.createdLt === null));
    if (unnamed !== undefined) throw inconsistent(`transaction ${tx.hash} sent a message to ${unnamed.destination} with no source or created_lt`);
    if (tx.parent === null) continue;
    const parent = byHash.get(tx.parent);
    if (parent === undefined || tx.inMsg === null) continue;
    const sent = parent.outMsgs.find((m) => m.source === tx.inMsg?.source && m.createdLt === tx.inMsg?.createdLt);
    if (sent === undefined || tx.inMsg.createdLt === null || sent.destination !== tx.account || sent.value !== tx.inMsg.value) {
      throw inconsistent(`transaction ${tx.hash} received no message its parent ${parent.hash} sent`);
    }
  }
  return trace;
}

export function definiteError(kind: ChainErrorKind, message: string): TonProviderError {
  return new TonProviderError(kind, message, false);
}
