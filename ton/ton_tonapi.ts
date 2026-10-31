import { Cell, type Transaction, loadTransaction } from '@ton/core';

import { ChainErrorKinds } from '../errors.ts';
import { tonRawAddress } from './ton_address.ts';
import {
  type TonAccountState,
  type TonAccountTransaction,
  type TonHttpEndpoint,
  type TonJettonWalletData,
  type TonMasterchainHead,
  type TonProvider,
  type TonTransactionPhases,
  type TonTrace,
  type TonTraceTransaction,
  TonProviderError,
  asAccountStatus,
  asBigInt,
  asRecord,
  asRequiredInteger,
  asRequiredRecord,
  asStatedAccountStatus,
  assertTonTxHash,
  assertAccountTransactionsQuery,
  assertTraceConsistent,
  assertTraceHolds,
  assertTraceOf,
  definiteError,
  errorMessageOf,
  jettonWalletDataOf,
  stackCellOf,
  tonBroadcastReply,
  tonTransactionOutcome,
  tonHttpJson,
  tonTraceMessageOf,
} from './ton_provider.ts';

const NAME = 'TonAPI';
/** The get-method exit code for an account with no code to run. */
const NO_CODE_EXIT_CODE = -13;
const BLOCK_ID_REGEX = /^\((-?\d+),([0-9a-fA-F]+),(\d+)\)$/;

interface TonapiTraceNode {
  transaction: Record<string, unknown>;
  children?: TonapiTraceNode[];
  /** TonAPI's prediction for a message still in flight, not a transaction on chain. */
  emulated?: boolean;
}

/** TonAPI (`/v2`), the fallback provider. */
export class TonapiProvider implements TonProvider {
  readonly name = NAME;

  constructor(private readonly endpoint: TonHttpEndpoint) {}

  async getAccountState(address: string): Promise<TonAccountState> {
    // TonAPI states `nonexist` for a never-used address; no reply says nothing.
    const reply = await this.get(`/v2/accounts/${encodeURIComponent(tonRawAddress(address))}`);
    if (reply === null) throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} returned no account for ${address}`, true);
    const account = asRecord(reply, 'account');
    return {
      status: asStatedAccountStatus(account.status),
      balance: asBigInt(account.balance, 'balance'),
      codeHash: typeof account.code_hash === 'string' ? account.code_hash : null,
    };
  }

  async getSeqno(address: string): Promise<number> {
    const reply = await this.get(`/v2/wallet/${encodeURIComponent(tonRawAddress(address))}/seqno`);
    if (reply === null) throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} has no seqno for ${address}`, true);
    return asRequiredInteger(asRecord(reply, 'seqno').seqno, 'seqno');
  }

  async getPublicKey(address: string): Promise<bigint> {
    // TonAPI answers a getter an account lacks with 404 or a failed result.
    const reply = await this.get(this.getMethodPath(address, 'get_public_key', []));
    const result = reply === null ? null : asRecord(reply, 'get_public_key');
    if (result === null || result.success !== true || Number(result.exit_code ?? 0) !== 0) {
      throw definiteError(ChainErrorKinds.RpcError, `${address} answers no get_public_key`);
    }
    const stack = Array.isArray(result.stack) ? result.stack : [];
    const first = stack[0] === undefined ? null : asRecord(stack[0], 'stack item');
    if (first === null || first.type !== 'num') throw definiteError(ChainErrorKinds.RpcError, `${NAME} returned no public key`);
    return asBigInt(first.num, 'public key');
  }

  async getJettonWalletAddress(jettonMaster: string, owner: string): Promise<string> {
    const result = await this.runGetMethod(jettonMaster, 'get_wallet_address', [tonRawAddress(owner)]);
    const decoded = result === null ? null : result.decoded;
    if (decoded === null || typeof decoded !== 'object' || typeof (decoded as Record<string, unknown>).jetton_wallet_address !== 'string') {
      throw definiteError(ChainErrorKinds.InvalidTokenIdentifier, `${jettonMaster} is not a jetton master`);
    }
    return tonRawAddress(String((decoded as Record<string, unknown>).jetton_wallet_address));
  }

  /**
   * 0 only for a jetton wallet with no code: TonAPI answers a get-method on
   * one with 404 (or exit code -13), which other failures can also produce, so
   * the account state confirms it. Any other failure throws.
   */
  async getJettonBalance(jettonWallet: string): Promise<bigint> {
    const reply = await this.get(this.getMethodPath(jettonWallet, 'get_wallet_data', []));
    const result = reply === null ? null : asRecord(reply, 'get_wallet_data');
    if (result === null || (result.success !== true && Number(result.exit_code) === NO_CODE_EXIT_CODE)) {
      const state = await this.getAccountState(jettonWallet);
      if (state.status === 'nonexist' || state.status === 'uninit') return 0n;
      throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} could not run get_wallet_data on ${jettonWallet}, which is ${state.status}`, true);
    }
    if (result.success !== true || Number(result.exit_code ?? 0) !== 0) {
      throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} could not run get_wallet_data on ${jettonWallet}`, true);
    }
    const stack = Array.isArray(result.stack) ? result.stack : [];
    const first = stack[0] === undefined ? null : asRecord(stack[0], 'stack item');
    if (first === null || first.type !== 'num') throw definiteError(ChainErrorKinds.RpcError, `${NAME} returned no jetton balance`);
    return asBigInt(first.num, 'jetton balance');
  }

  async getJettonContent(jettonMaster: string): Promise<Cell> {
    const reply = await this.get(this.getMethodPath(jettonMaster, 'get_jetton_data', []));
    const result = reply === null ? null : asRecord(reply, 'get_jetton_data');
    if (result === null || result.success !== true || Number(result.exit_code ?? 0) !== 0) {
      throw definiteError(ChainErrorKinds.InvalidTokenIdentifier, `${jettonMaster} is not a jetton master`);
    }
    return stackCellOf((Array.isArray(result.stack) ? result.stack : [])[3], 'jetton content');
  }

  /** `null` only for a jetton wallet with no code, confirmed by the account state as for the balance. */
  async getJettonWalletData(jettonWallet: string): Promise<TonJettonWalletData | null> {
    const reply = await this.get(this.getMethodPath(jettonWallet, 'get_wallet_data', []));
    const result = reply === null ? null : asRecord(reply, 'get_wallet_data');
    if (result === null || (result.success !== true && Number(result.exit_code) === NO_CODE_EXIT_CODE)) {
      const state = await this.getAccountState(jettonWallet);
      if (state.status === 'nonexist' || state.status === 'uninit') return null;
      throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} could not run get_wallet_data on ${jettonWallet}, which is ${state.status}`, true);
    }
    if (result.success !== true || Number(result.exit_code ?? 0) !== 0) {
      throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} could not run get_wallet_data on ${jettonWallet}`, true);
    }
    return jettonWalletDataOf(result.stack);
  }

  async sendBoc(boc: string): Promise<void> {
    const reply = await tonBroadcastReply(
      NAME,
      tonHttpJson(NAME, this.endpoint, '/v2/blockchain/message', { method: 'POST', body: { boc }, headers: this.headers() }),
    );
    const error = errorMessageOf(reply);
    if (error !== null) throw definiteError(ChainErrorKinds.BroadcastRejected, `${NAME} refused the message: ${error}`);
  }

  async getTrace(hash: string): Promise<TonTrace | null> {
    const trace = await this.traceAt(hash);
    return trace === null ? null : assertTraceOf(NAME, hash, trace);
  }

  // `/v2/traces/{id}` takes a transaction hash as well as a message hash.
  async getTraceByTransaction(txHash: string): Promise<TonTrace | null> {
    const trace = await this.traceAt(txHash);
    return trace === null ? null : assertTraceHolds(NAME, txHash, trace);
  }

  async getAccountTransactions(account: string, opts: { afterLt: bigint; limit: number }): Promise<TonAccountTransaction[]> {
    assertAccountTransactionsQuery(opts);
    const query = new URLSearchParams({ after_lt: String(opts.afterLt), limit: String(opts.limit), sort_order: 'asc' });
    const reply = await this.get(`/v2/blockchain/accounts/${encodeURIComponent(tonRawAddress(account))}/transactions?${query.toString()}`);
    if (reply === null) {
      // A never-used account has no transactions; anything else answering 404 says nothing.
      if ((await this.getAccountState(account)).status === 'nonexist') return [];
      throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} returned no transaction list for ${account}`, true);
    }
    const list = asRecord(reply, 'transactions').transactions;
    if (!Array.isArray(list)) throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} returned no transaction list for ${account}`, true);
    // TonAPI serves committed blocks only; the masterchain block is read as for a trace.
    const raw = list.map((item) => asRequiredRecord(item, 'transaction'));
    const parsed = await this.withMasterchainSeqnos(raw.map((tx) => ({ tx, parent: null })));
    return parsed.map((tx, index) => ({ hash: tx.hash, lt: asBigInt(raw[index].lt, 'lt'), utime: tx.utime, mcSeqno: tx.mcSeqno }));
  }

  /**
   * The newest transaction's lt. TonAPI's raw account is no source for it: for
   * an account that does not exist but had transactions (one that bounced a
   * message), it states `last_transaction_lt: 0` (seen on mainnet) while its
   * transaction list holds them. 0 needs an empty list and the account stated
   * `nonexist`.
   */
  async getLastTransactionLt(account: string): Promise<bigint> {
    const raw = encodeURIComponent(tonRawAddress(account));
    const newest = await this.get(`/v2/blockchain/accounts/${raw}/transactions?limit=1&sort_order=desc`);
    const list = newest === null ? [] : asRecord(newest, 'transactions').transactions;
    if (!Array.isArray(list)) throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} returned no transaction list for ${account}`, true);
    if (list.length > 0) return asBigInt(asRequiredRecord(list[0], 'transaction').lt, 'lt');
    if ((await this.getAccountState(account)).status === 'nonexist') return 0n;
    throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} returned no account for ${account}`, true);
  }

  /** The trace at a hash, checked; `null` on 404 and for TonAPI's emulation of a message in flight. */
  private async traceAt(hash: string): Promise<TonTrace | null> {
    // TonAPI answers a hash it has no trace for with 404.
    const reply = await this.get(`/v2/traces/${encodeURIComponent(assertTonTxHash(hash))}`);
    if (reply === null) return null;
    // TonAPI answers a message still in flight with its emulation; only what
    // is on chain counts, and a predicted hop leaves the trace incomplete.
    if ((reply as TonapiTraceNode).emulated === true) return null;
    const root = withoutEmulated(reply as TonapiTraceNode);
    const transactions = await this.withMasterchainSeqnos(flatten(root));
    return assertTraceConsistent(NAME, { complete: isComplete(root), transactions });
  }

  async emulate(boc: string): Promise<TonTrace> {
    const reply = await tonHttpJson(NAME, this.endpoint, '/v2/traces/emulate?ignore_signature_check=true', {
      method: 'POST',
      body: { boc },
      headers: this.headers(),
    });
    const error = errorMessageOf(reply);
    if (error !== null) throw definiteError(ChainErrorKinds.SimulationFailed, `${NAME} emulation failed: ${error}`);
    const root = reply as TonapiTraceNode;
    // An emulation is judged whole or not at all.
    if (!isComplete(root)) throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} returned an emulation cut short`, true);
    return assertTraceConsistent(NAME, { complete: true, transactions: flatten(root).map(({ tx, parent }) => toTransaction(tx, parent, null)) });
  }

  async getMasterchainHead(): Promise<TonMasterchainHead> {
    const reply = asRecord(await this.get('/v2/blockchain/masterchain-head'), 'masterchain-head');
    return { seqno: asRequiredInteger(reply.seqno, 'masterchain seqno'), utime: asRequiredInteger(reply.gen_utime, 'masterchain gen_utime') };
  }

  /**
   * Resolves each transaction's masterchain block: its own block on the
   * masterchain, the shard block's `master_ref` otherwise. TonAPI serves only
   * committed blocks, so a transaction it returns is final; `master_ref` is the
   * masterchain block the shard block points back to, which can be a few
   * blocks before the one TON Center reports as committing it.
   */
  private async withMasterchainSeqnos(transactions: FlatTransaction[]): Promise<TonTraceTransaction[]> {
    const masterRefs = new Map<string, number | null>();
    for (const { tx } of transactions) {
      const block = String(tx.block ?? '');
      if (!masterRefs.has(block)) masterRefs.set(block, await this.masterchainSeqnoOf(block));
    }
    return transactions.map(({ tx, parent }) => toTransaction(tx, parent, masterRefs.get(String(tx.block ?? '')) ?? null));
  }

  private async masterchainSeqnoOf(block: string): Promise<number | null> {
    const match = BLOCK_ID_REGEX.exec(block);
    if (match === null) return null;
    if (Number(match[1]) === -1) return Number(match[3]);
    const reply = await this.get(`/v2/blockchain/blocks/${encodeURIComponent(block)}`);
    const masterRef = reply === null ? null : BLOCK_ID_REGEX.exec(String(asRecord(reply, 'block').master_ref ?? ''));
    return masterRef === null ? null : Number(masterRef[3]);
  }

  /** The reply of a get-method that ran, or `null` when the account has no code to run it. */
  private async runGetMethod(address: string, method: string, args: string[]): Promise<Record<string, unknown> | null> {
    const reply = await this.get(this.getMethodPath(address, method, args));
    if (reply === null) return null;
    const result = asRecord(reply, method);
    return result.success === true && Number(result.exit_code ?? 0) === 0 ? result : null;
  }

  private getMethodPath(address: string, method: string, args: string[]): string {
    const query = args.map((arg) => `args=${encodeURIComponent(arg)}`).join('&');
    return `/v2/blockchain/accounts/${encodeURIComponent(tonRawAddress(address))}/methods/${method}${query.length > 0 ? `?${query}` : ''}`;
  }

  private get(path: string): Promise<unknown | null> {
    return tonHttpJson(NAME, this.endpoint, path, { headers: this.headers() });
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.endpoint.apiKey}` };
  }
}

interface FlatTransaction {
  tx: Record<string, unknown>;
  parent: string | null;
}

function flatten(root: TonapiTraceNode): FlatTransaction[] {
  const ordered: FlatTransaction[] = [];
  const queue: Array<{ node: TonapiTraceNode; parent: string | null }> = [{ node: root, parent: null }];
  while (queue.length > 0) {
    const { node, parent } = queue.shift() as { node: TonapiTraceNode; parent: string | null };
    const tx = asRecord(node.transaction, 'transaction');
    ordered.push({ tx, parent });
    const hash = rawTransactionOf(tx).hash().toString('hex');
    queue.push(...(node.children ?? []).map((child) => ({ node: child, parent: hash })));
  }
  return ordered;
}

function withoutEmulated(node: TonapiTraceNode): TonapiTraceNode {
  return { ...node, children: (node.children ?? []).filter((child) => child.emulated !== true).map(withoutEmulated) };
}

/** Every internal message a transaction sent has reached its destination's transaction. */
function isComplete(node: TonapiTraceNode): boolean {
  const children = node.children ?? [];
  const sent = rawTransactionOf(asRecord(node.transaction, 'transaction'))
    .outMessages.values()
    .filter((message) => message.info.type === 'internal').length;
  return sent <= children.length && children.every(isComplete);
}

/**
 * TonAPI's trace transactions carry no `out_msgs`; the messages are read from
 * the transaction's own BOC (`raw`), which also gives the exact values and
 * forward fees.
 */
function rawTransactionOf(tx: Record<string, unknown>): Transaction {
  if (typeof tx.raw !== 'string') throw definiteError(ChainErrorKinds.RpcError, `${NAME} trace transaction has no raw BOC`);
  return loadTransaction(Cell.fromBoc(Buffer.from(tx.raw, 'hex'))[0].beginParse());
}

/**
 * The phases from the transaction's own BOC, the chain's record — not
 * TonAPI's JSON phase fields, which are optional.
 */
function phasesOf(raw: Transaction): TonTransactionPhases {
  const description = raw.description;
  if (description.type !== 'generic' && description.type !== 'tick-tock') {
    throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} trace holds a ${description.type} transaction`, true);
  }
  const compute = description.computePhase;
  const action = description.actionPhase ?? null;
  return {
    computeSkipped: compute.type === 'skipped' ? compute.reason.replace('-', '_') : null,
    computeSuccess: compute.type === 'vm' && compute.success,
    computeExitCode: compute.type === 'vm' ? compute.exitCode : null,
    action: action === null ? null : { success: action.success, resultCode: action.resultCode, skippedActions: action.skippedActions },
    aborted: description.aborted,
  };
}

function toTransaction(tx: Record<string, unknown>, parent: string | null, mcSeqno: number | null): TonTraceTransaction {
  const raw = rawTransactionOf(tx);
  return {
    hash: raw.hash().toString('hex'),
    lt: raw.lt,
    parent,
    account: tonRawAddress(String(asRecord(tx.account, 'account').address)),
    ...tonTransactionOutcome(phasesOf(raw)),
    totalFees: raw.totalFees.coins,
    origStatus: asAccountStatus(tx.orig_status),
    endStatus: asAccountStatus(tx.end_status),
    inMsg: raw.inMessage === undefined || raw.inMessage === null ? null : tonTraceMessageOf(raw.inMessage),
    outMsgs: raw.outMessages.values().map(tonTraceMessageOf),
    mcSeqno,
    utime: raw.now,
  };
}
