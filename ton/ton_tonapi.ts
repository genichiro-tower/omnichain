import { Cell, type Transaction, loadTransaction } from '@ton/core';

import { ChainErrorKinds } from '../errors.ts';
import { tonRawAddress } from './ton_address.ts';
import {
  type TonAccountState,
  type TonHttpEndpoint,
  type TonProvider,
  type TonTrace,
  type TonTraceTransaction,
  asAccountStatus,
  asBigInt,
  asRecord,
  definiteError,
  errorMessageOf,
  tonHttpJson,
  tonTraceMessageOf,
} from './ton_provider.ts';

const NAME = 'TonAPI';
const BLOCK_ID_REGEX = /^\((-?\d+),([0-9a-fA-F]+),(\d+)\)$/;

interface TonapiTraceNode {
  transaction: Record<string, unknown>;
  children?: TonapiTraceNode[];
}

/** TonAPI (`/v2`), the fallback provider. */
export class TonapiProvider implements TonProvider {
  readonly name = NAME;

  constructor(private readonly endpoint: TonHttpEndpoint) {}

  async getAccountState(address: string): Promise<TonAccountState> {
    const reply = await this.get(`/v2/accounts/${encodeURIComponent(tonRawAddress(address))}`);
    if (reply === null) return { status: 'nonexist', balance: 0n, codeHash: null };
    const account = asRecord(reply, 'account');
    return {
      status: asAccountStatus(account.status),
      balance: asBigInt(account.balance, 'balance'),
      codeHash: typeof account.code_hash === 'string' ? account.code_hash : null,
    };
  }

  async getSeqno(address: string): Promise<number> {
    const reply = await this.get(`/v2/wallet/${encodeURIComponent(tonRawAddress(address))}/seqno`);
    return reply === null ? 0 : Number(asRecord(reply, 'seqno').seqno ?? 0);
  }

  async getJettonWalletAddress(jettonMaster: string, owner: string): Promise<string> {
    const result = await this.runGetMethod(jettonMaster, 'get_wallet_address', [tonRawAddress(owner)]);
    const decoded = result === null ? null : result.decoded;
    if (decoded === null || typeof decoded !== 'object' || typeof (decoded as Record<string, unknown>).jetton_wallet_address !== 'string') {
      throw definiteError(ChainErrorKinds.InvalidTokenIdentifier, `${jettonMaster} is not a jetton master`);
    }
    return tonRawAddress(String((decoded as Record<string, unknown>).jetton_wallet_address));
  }

  async getJettonBalance(jettonWallet: string): Promise<bigint> {
    const result = await this.runGetMethod(jettonWallet, 'get_wallet_data', []);
    if (result === null) return 0n;
    const stack = Array.isArray(result.stack) ? result.stack : [];
    const first = stack[0] === undefined ? null : asRecord(stack[0], 'stack item');
    if (first === null || first.type !== 'num') throw definiteError(ChainErrorKinds.RpcError, `${NAME} returned no jetton balance`);
    return asBigInt(first.num, 'jetton balance');
  }

  async sendBoc(boc: string): Promise<void> {
    const reply = await tonHttpJson(NAME, this.endpoint, '/v2/blockchain/message', { method: 'POST', body: { boc }, headers: this.headers() });
    const error = errorMessageOf(reply);
    if (error !== null) throw definiteError(ChainErrorKinds.BroadcastRejected, `${NAME} refused the message: ${error}`);
  }

  async getTrace(hash: string): Promise<TonTrace | null> {
    const reply = await this.get(`/v2/traces/${hash}`);
    if (reply === null) return null;
    const root = reply as TonapiTraceNode;
    const transactions = await this.withMasterchainSeqnos(flatten(root));
    return { complete: isComplete(root), transactions };
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
    return { complete: true, transactions: flatten(root).map((tx) => toTransaction(tx, null)) };
  }

  async getMasterchainSeqno(): Promise<number> {
    const reply = asRecord(await this.get('/v2/blockchain/masterchain-head'), 'masterchain-head');
    return Number(reply.seqno);
  }

  /**
   * Resolves each transaction's masterchain block: its own block on the
   * masterchain, the shard block's `master_ref` otherwise. TonAPI serves only
   * committed blocks, so a transaction it returns is final; `master_ref` is the
   * masterchain block the shard block points back to, which can be a few
   * blocks before the one TON Center reports as committing it.
   */
  private async withMasterchainSeqnos(transactions: Record<string, unknown>[]): Promise<TonTraceTransaction[]> {
    const masterRefs = new Map<string, number | null>();
    for (const tx of transactions) {
      const block = String(tx.block ?? '');
      if (!masterRefs.has(block)) masterRefs.set(block, await this.masterchainSeqnoOf(block));
    }
    return transactions.map((tx) => toTransaction(tx, masterRefs.get(String(tx.block ?? '')) ?? null));
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
    const query = args.map((arg) => `args=${encodeURIComponent(arg)}`).join('&');
    const reply = await this.get(
      `/v2/blockchain/accounts/${encodeURIComponent(tonRawAddress(address))}/methods/${method}${query.length > 0 ? `?${query}` : ''}`,
    );
    if (reply === null) return null;
    const result = asRecord(reply, method);
    return result.success === true && Number(result.exit_code ?? 0) === 0 ? result : null;
  }

  private get(path: string): Promise<unknown | null> {
    return tonHttpJson(NAME, this.endpoint, path, { headers: this.headers() });
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.endpoint.apiKey}` };
  }
}

function flatten(root: TonapiTraceNode): Record<string, unknown>[] {
  const ordered: Record<string, unknown>[] = [];
  const queue: TonapiTraceNode[] = [root];
  while (queue.length > 0) {
    const node = queue.shift() as TonapiTraceNode;
    ordered.push(asRecord(node.transaction, 'transaction'));
    queue.push(...(node.children ?? []));
  }
  return ordered;
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

function toTransaction(tx: Record<string, unknown>, mcSeqno: number | null): TonTraceTransaction {
  const raw = rawTransactionOf(tx);
  const compute = tx.compute_phase === undefined ? null : asRecord(tx.compute_phase, 'compute_phase');
  const action = tx.action_phase === undefined || tx.action_phase === null ? null : asRecord(tx.action_phase, 'action_phase');
  const computeOk = compute === null || (compute.skipped === true ? compute.skip_reason === 'cskip_no_state' : compute.success === true);
  const actionOk = action === null || action.success === true;
  return {
    hash: raw.hash().toString('hex'),
    account: tonRawAddress(String(asRecord(tx.account, 'account').address)),
    success: computeOk && actionOk,
    aborted: tx.aborted === true,
    computeExitCode: compute === null || compute.skipped === true ? null : Number(compute.exit_code),
    actionResultCode: action === null ? null : Number(action.result_code),
    totalFees: raw.totalFees.coins,
    origStatus: asAccountStatus(tx.orig_status),
    endStatus: asAccountStatus(tx.end_status),
    inMsg: raw.inMessage === undefined || raw.inMessage === null ? null : tonTraceMessageOf(raw.inMessage),
    outMsgs: raw.outMessages.values().map(tonTraceMessageOf),
    mcSeqno,
    utime: raw.now,
  };
}
