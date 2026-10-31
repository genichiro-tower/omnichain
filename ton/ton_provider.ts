import { type Cell, Cell as CoreCell, type Message } from '@ton/core';

import { ChainError, ChainErrorKinds, type ChainErrorKind, type ChainErrorMeta } from '../errors.ts';
import { tonNormalizedExternalHash } from './ton_messages.ts';

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
  /** Its logical time, which orders an account's transactions. */
  lt: bigint;
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
  /**
   * The wallet's seqno, read live by running its get-method: 0 only on the
   * provider's explicit answer that the account has no code. Throws when it
   * cannot be read; never reads a failure as 0.
   */
  getSeqno(address: string): Promise<number>;
  /**
   * The `get_public_key` getter's answer. An account without the getter, or
   * whose getter fails, is a definite error; a failed read is a retryable one.
   */
  getPublicKey(address: string): Promise<bigint>;
  getJettonWalletAddress(jettonMaster: string, owner: string): Promise<string>;
  /** 0 for a jetton wallet that is not deployed. */
  getJettonBalance(jettonWallet: string): Promise<bigint>;
  /** A jetton master's TEP-64 content cell (`get_jetton_data`); `InvalidTokenIdentifier` for anything that is not a jetton master. */
  getJettonContent(jettonMaster: string): Promise<Cell>;
  /** A deployed jetton wallet's balance, owner and master (`get_wallet_data`); `null` when it has no code. */
  getJettonWalletData(jettonWallet: string): Promise<TonJettonWalletData | null>;
  sendBoc(boc: string): Promise<void>;
  /** By the normalized external-message hash (hex); `null` while the provider has not seen it. */
  getTrace(hash: string): Promise<TonTrace | null>;
  /** The whole trace holding the transaction `txHash` (hex), from its root; `null` while the provider has not seen it. */
  getTraceByTransaction(txHash: string): Promise<TonTrace | null>;
  /** The account's transactions with an lt above `afterLt`, oldest first, at most `limit` (1 to 100). */
  getAccountTransactions(account: string, opts: { afterLt: bigint; limit: number }): Promise<TonAccountTransaction[]>;
  /** The lt of the account's last transaction; 0 for an account that never had one, as the provider states it. */
  getLastTransactionLt(account: string): Promise<bigint>;
  /** Emulates the whole trace of an external message, ignoring its signature. */
  emulate(boc: string): Promise<TonTrace>;
  /** The latest masterchain block the provider has applied: its seqno and generation time (unix seconds). */
  getMasterchainHead(): Promise<TonMasterchainHead>;
}

/** One of an account's transactions, as listed after a cursor. */
export interface TonAccountTransaction {
  /** Lowercase hex. */
  hash: string;
  lt: bigint;
  /** Unix seconds. */
  utime: number;
  /** The masterchain block that finalized it; `null` while it is not final. */
  mcSeqno: number | null;
}

export interface TonJettonWalletData {
  balance: bigint;
  /** Raw. */
  owner: string;
  /** Raw. */
  jettonMaster: string;
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
    super(ChainErrorKinds.BroadcastUncertain, message, false, meta, cause);
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

  getPublicKey(address: string): Promise<bigint> {
    return this.call('getPublicKey', (p) => p.getPublicKey(address));
  }

  getJettonWalletAddress(jettonMaster: string, owner: string): Promise<string> {
    return this.call('getJettonWalletAddress', (p) => p.getJettonWalletAddress(jettonMaster, owner));
  }

  getJettonBalance(jettonWallet: string): Promise<bigint> {
    return this.call('getJettonBalance', (p) => p.getJettonBalance(jettonWallet));
  }

  getJettonContent(jettonMaster: string): Promise<Cell> {
    return this.call('getJettonContent', (p) => p.getJettonContent(jettonMaster));
  }

  getJettonWalletData(jettonWallet: string): Promise<TonJettonWalletData | null> {
    return this.call('getJettonWalletData', (p) => p.getJettonWalletData(jettonWallet));
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

  getTraceByTransaction(txHash: string): Promise<TonTrace | null> {
    return this.call('getTraceByTransaction', (p) => p.getTraceByTransaction(txHash));
  }

  getAccountTransactions(account: string, opts: { afterLt: bigint; limit: number }): Promise<TonAccountTransaction[]> {
    return this.call('getAccountTransactions', (p) => p.getAccountTransactions(account, opts));
  }

  getLastTransactionLt(account: string): Promise<bigint> {
    return this.call('getLastTransactionLt', (p) => p.getLastTransactionLt(account));
  }

  emulate(boc: string): Promise<TonTrace> {
    return this.call('emulate', (p) => p.emulate(boc));
  }

  getMasterchainHead(): Promise<TonMasterchainHead> {
    return this.call('getMasterchainHead', (p) => p.getMasterchainHead());
  }

  /**
   * Runs several reads on one provider throughout: the primary, or — when any
   * of them fails without an answer — all of them again on the fallback. Reads
   * that must see the chain at one point never mix providers that lag
   * differently.
   */
  onOneProvider<T>(method: string, run: (provider: TonProvider) => Promise<T>): Promise<T> {
    return this.call(method, run);
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
/** Enough of an error reply to keep the lite server's exit code, which follows a long preamble. */
const ERROR_TEXT_LIMIT = 1_000;

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
    throw new TonProviderError(ChainErrorKinds.RpcError, `${provider} ${path} answered HTTP ${response.status}: ${text.slice(0, ERROR_TEXT_LIMIT)}`, true);
  }
  let payload: unknown;
  try {
    payload = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new TonProviderError(ChainErrorKinds.RpcError, `${provider} ${path} answered non-JSON (HTTP ${response.status})`, true);
  }
  if (response.status >= 400) {
    const message = errorMessageOf(payload) ?? text.slice(0, ERROR_TEXT_LIMIT);
    throw new TonProviderError(ChainErrorKinds.RpcError, `${provider} ${path} refused (HTTP ${response.status}): ${message}`, false);
  }
  return payload;
}

const EXTERNAL_MESSAGE_REFUSED = /cannot apply external message/i;
const EXTERNAL_MESSAGE_DUPLICATE = /duplicate message/i;
const REFUSAL_EXIT_CODE = /exit\s*code\s*[=:]?\s*(-?\d+)/i;
/**
 * The wallets' refusals of an external request, by exit code.
 *
 * W5R1 checks the signature, then the seqno (133), the wallet id, then
 * `valid_until`: a message that already landed fails on the seqno, and only
 * there — every later refusal means the seqno still matched.
 *
 * v3r2 and v4r2 check `valid_until` first (v3r2: 35, which is also its bad
 * signature; v4r2: 36), then the seqno (33), the wallet id (34), the
 * signature (35). An expiry refusal therefore says nothing about whether the
 * message landed earlier.
 */
const SEQNO_MOVED_EXIT_CODES = new Set([133, 33]);
/**
 * The account refused to run the request at all — typically it holds nothing
 * to pay for it, as a wallet that sent everything away does. No check ran, so
 * this says nothing about whether the same request landed earlier.
 */
const REFUSED_BEFORE_EXECUTION = /before smart-contract execution/i;
const MAYBE_LANDED_EXIT_CODES = new Set([35, 36]);

/**
 * The reply to a broadcast, read for what the lite server said rather than
 * the HTTP status (both answers come as HTTP 500 from TON Center, and from
 * TonAPI as 500 or 406):
 * - "duplicate message": the network already has this exact message, so the
 *   broadcast succeeded;
 * - "cannot apply external message": the wallet does not accept it now. On a
 *   seqno check (W5 133, v3r2 / v4r2 33) this is `NonceTooLow` — this
 *   message or another with its seqno already landed, so read the status
 *   before signing again; on a v3r2 / v4r2 expiry (35, 36), or a refusal "before
 *   smart-contract execution" (an account that cannot pay to run it), it may
 *   have landed earlier, so it is `BroadcastUncertain`; any other refusal is
 *   a definite `BroadcastRejected`.
 */
export async function tonBroadcastReply(provider: string, reply: Promise<unknown>): Promise<unknown> {
  try {
    return await reply;
  } catch (err) {
    if (!(err instanceof TonProviderError)) throw err;
    if (EXTERNAL_MESSAGE_DUPLICATE.test(err.message)) return {};
    if (EXTERNAL_MESSAGE_REFUSED.test(err.message)) {
      if (REFUSED_BEFORE_EXECUTION.test(err.message)) {
        throw new TonBroadcastUncertainError(
          `${provider} refused the message before running it (the account cannot pay for it); it may be a request that landed earlier: ${err.message}`,
          undefined,
          err,
        );
      }
      const exitCode = Number(REFUSAL_EXIT_CODE.exec(err.message)?.[1]);
      if (MAYBE_LANDED_EXIT_CODES.has(exitCode)) {
        throw new TonBroadcastUncertainError(
          `${provider} refused the message as expired (v3r2 / v4r2 check that first, so it may have landed earlier) or for its signature: ${err.message}`,
          undefined,
          err,
        );
      }
      if (SEQNO_MOVED_EXIT_CODES.has(exitCode)) {
        throw new TonProviderError(
          ChainErrorKinds.NonceTooLow,
          `${provider} refused the message: the wallet's seqno has moved past it, so it or another request with its seqno landed: ${err.message}`,
          false,
          undefined,
          err,
        );
      }
      throw new TonProviderError(ChainErrorKinds.BroadcastRejected, `${provider} refused the message: ${err.message}`, false, undefined, err);
    }
    throw err;
  }
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

/** A required integer field; a reply without one says nothing definite, so the fallback is asked. */
export function asRequiredInteger(value: unknown, what: string): number {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new TonProviderError(ChainErrorKinds.RpcError, `Malformed TON provider reply: ${what} is missing or not an integer`, true);
  }
  return parsed;
}

function malformed(what: string): TonProviderError {
  return new TonProviderError(ChainErrorKinds.RpcError, `Malformed TON provider reply: ${what}`, true);
}

/** A required object field; a reply without one says nothing definite, so the fallback is asked. */
export function asRequiredRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw malformed(`${what} is missing or not an object`);
  return value as Record<string, unknown>;
}

/** A get-method stack entry that is a cell or slice: TON Center gives base64 (`value`), TonAPI hex (`cell`). */
export function stackCellOf(item: unknown, what: string): Cell {
  const entry = asRequiredRecord(item, what);
  if (entry.type !== 'cell' && entry.type !== 'slice') throw malformed(`${what} is not a cell`);
  try {
    if (typeof entry.value === 'string') return CoreCell.fromBase64(entry.value);
    if (typeof entry.cell === 'string') return CoreCell.fromBoc(Buffer.from(entry.cell, 'hex'))[0];
  } catch {
    throw malformed(`${what} is not a valid cell`);
  }
  throw malformed(`${what} carries no cell`);
}

/** `get_wallet_data`'s stack — balance, owner, master, code — as both providers give it. */
export function jettonWalletDataOf(stack: unknown): TonJettonWalletData {
  if (!Array.isArray(stack) || stack.length < 3) throw malformed('get_wallet_data returned a short stack');
  const balanceEntry = asRequiredRecord(stack[0], 'jetton balance');
  const balance = asBigInt(balanceEntry.value ?? balanceEntry.num, 'jetton balance');
  try {
    return {
      balance,
      owner: stackCellOf(stack[1], 'jetton wallet owner').beginParse().loadAddress().toRawString(),
      jettonMaster: stackCellOf(stack[2], 'jetton master').beginParse().loadAddress().toRawString(),
    };
  } catch (err) {
    if (err instanceof TonProviderError) throw err;
    throw malformed('get_wallet_data returned no addresses');
  }
}

/** A required boolean field; see {@link asRequiredRecord}. */
export function asRequiredBoolean(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw malformed(`${what} is missing or not a boolean`);
  return value;
}

/** A transaction's phases as the chain recorded them, the part of it the judgment reads. */
export interface TonTransactionPhases {
  /** Why the compute phase was skipped (`no_state`: the account has no code yet), or `null` when it ran. */
  computeSkipped: string | null;
  /** Whether a compute phase that ran succeeded. */
  computeSuccess: boolean;
  computeExitCode: number | null;
  /** The action phase; it runs exactly when the compute phase ran and succeeded. */
  action: { success: boolean; resultCode: number; skippedActions: number } | null;
  aborted: boolean;
}

/**
 * A transaction succeeds when its compute phase succeeded — or was skipped
 * only because the account has no code yet — and its action phase, if any,
 * succeeded without skipping a message. Phases that cannot be what the chain
 * recorded (a successful compute phase without an action phase) are a
 * malformed reply, never a success.
 */
export function tonTransactionOutcome(phases: TonTransactionPhases): Pick<
  TonTraceTransaction,
  'success' | 'skippedActions' | 'aborted' | 'computeExitCode' | 'actionResultCode'
> {
  const ran = phases.computeSkipped === null;
  if (ran && phases.computeSuccess && phases.action === null) throw malformed('a compute phase that succeeded has no action phase');
  if ((!ran || !phases.computeSuccess) && phases.action !== null) throw malformed('an action phase follows a compute phase that did not succeed');
  const computeOk = ran ? phases.computeSuccess : phases.computeSkipped === 'no_state';
  const skippedActions = phases.action?.skippedActions ?? 0;
  return {
    success: computeOk && (phases.action === null || (phases.action.success && skippedActions === 0)),
    skippedActions,
    aborted: phases.aborted,
    computeExitCode: ran ? phases.computeExitCode : null,
    actionResultCode: phases.action?.resultCode ?? null,
  };
}

/** An account's status as the provider stated it; anything else says nothing definite. */
export function asStatedAccountStatus(value: unknown): TonAccountStatus {
  if (value === 'active' || value === 'frozen' || value === 'uninit' || value === 'nonexist') return value;
  throw new TonProviderError(ChainErrorKinds.RpcError, `Malformed TON provider reply: unknown account status ${String(value)}`, true);
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
 * Checks a trace before anything is judged from it. On TON every internal
 * message produces a transaction where it lands, so a provider's trace must
 * hold together:
 * - one root (the first transaction); every other transaction has a parent in
 *   the trace and an incoming message. A trace still running may lack a
 *   parent, the root included;
 * - every internal message sent names its source and `created_lt`;
 * - every incoming message is one its parent sent: same source, `created_lt`,
 *   destination and value;
 * - in a complete trace, every internal message sent has the transaction
 *   that received it.
 * A trace that breaks any of these is the provider's error, not the chain's:
 * the error is retryable, so the fallback provider is asked instead, and no
 * gap is ever read as an undelivered message.
 */
export function assertTraceConsistent(source: string, trace: TonTrace): TonTrace {
  const inconsistent = (detail: string): TonProviderError =>
    new TonProviderError(ChainErrorKinds.RpcError, `Inconsistent trace from ${source}: ${detail}`, true);
  const byHash = new Map(trace.transactions.map((tx) => [tx.hash, tx]));
  const received = new Set<string>();
  trace.transactions.forEach((tx, index) => {
    const unnamed = tx.outMsgs.find((m) => m.destination !== null && (m.source === null || m.createdLt === null));
    if (unnamed !== undefined) throw inconsistent(`transaction ${tx.hash} sent a message to ${unnamed.destination} with no source or created_lt`);
    if (index === 0 && tx.parent === null) return;
    if (tx.parent === null) throw inconsistent(`transaction ${tx.hash} has no parent but is not the root`);
    if (tx.inMsg === null || tx.inMsg.source === null || tx.inMsg.createdLt === null) {
      throw inconsistent(`transaction ${tx.hash} has no incoming internal message`);
    }
    const parent = byHash.get(tx.parent);
    if (parent === undefined) {
      if (trace.complete) throw inconsistent(`transaction ${tx.hash} names a parent ${tx.parent} the trace does not hold`);
      return;
    }
    const inMsg = tx.inMsg;
    const sent = parent.outMsgs.find((m) => m.source === inMsg.source && m.createdLt === inMsg.createdLt);
    if (sent === undefined || sent.destination !== tx.account || sent.value !== inMsg.value) {
      throw inconsistent(`transaction ${tx.hash} received no message its parent ${parent.hash} sent`);
    }
    received.add(`${parent.hash}:${inMsg.createdLt}`);
  });
  if (trace.complete) {
    for (const tx of trace.transactions) {
      const lost = tx.outMsgs.find((m) => m.destination !== null && !received.has(`${tx.hash}:${m.createdLt}`));
      if (lost !== undefined) {
        throw inconsistent(`the trace is complete, but the message ${tx.hash} sent to ${lost.destination} reached no transaction`);
      }
    }
  }
  return trace;
}

/**
 * The trace a provider returned for `hash` must be that message's: its root
 * received an external message whose normalized hash is `hash`. A trace still
 * running may not hold its root yet.
 */
export function assertTraceOf(source: string, hash: string, trace: TonTrace): TonTrace {
  const root = trace.transactions[0];
  if (root === undefined || root.parent !== null) return trace;
  const inMsg = root.inMsg;
  if (inMsg === null || inMsg.source !== null || inMsg.body === null || tonNormalizedExternalHash(root.account, inMsg.body) !== hash) {
    throw new TonProviderError(ChainErrorKinds.RpcError, `${source} returned the trace of another message than ${hash}`, true);
  }
  return trace;
}

/** The trace a provider returned for the transaction `txHash` must hold it. */
export function assertTraceHolds(source: string, txHash: string, trace: TonTrace): TonTrace {
  if (!trace.transactions.some((tx) => tx.hash === txHash)) {
    throw new TonProviderError(ChainErrorKinds.RpcError, `${source} returned a trace that does not hold transaction ${txHash}`, true);
  }
  return trace;
}

/** The most account transactions one call returns. */
export const TON_MAX_ACCOUNT_TRANSACTIONS = 100;

/** Refuses a page size outside 1 to {@link TON_MAX_ACCOUNT_TRANSACTIONS} and a negative cursor. */
export function assertAccountTransactionsQuery(opts: { afterLt: bigint; limit: number }): void {
  if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > TON_MAX_ACCOUNT_TRANSACTIONS) {
    throw new TonProviderError(ChainErrorKinds.InvalidArgument, `limit must be 1 to ${TON_MAX_ACCOUNT_TRANSACTIONS}, got ${opts.limit}`, false);
  }
  if (typeof opts.afterLt !== 'bigint' || opts.afterLt < 0n) {
    throw new TonProviderError(ChainErrorKinds.InvalidArgument, `afterLt must be a non-negative bigint, got ${String(opts.afterLt)}`, false);
  }
}

const TX_HASH_REGEX = /^[0-9a-f]{64}$/;

/**
 * Refuses anything but a transaction id as the SDK gives it — the normalized
 * external-message hash, 64 lowercase hex characters. A base64 hash or a typo
 * would otherwise find no trace, and "no trace" counts as "never landed".
 */
export function assertTonTxHash(hash: string): string {
  if (typeof hash !== 'string' || !TX_HASH_REGEX.test(hash)) {
    throw new TonProviderError(
      ChainErrorKinds.InvalidArgument,
      `A TON transaction id is 64 lowercase hex characters, got ${JSON.stringify(hash)}`,
      false,
    );
  }
  return hash;
}

export function definiteError(kind: ChainErrorKind, message: string): TonProviderError {
  return new TonProviderError(kind, message, false);
}
