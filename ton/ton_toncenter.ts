import { Cell, beginCell } from '@ton/core';

import { ChainErrorKinds } from '../errors.ts';
import { tonRawAddress } from './ton_address.ts';
import { parseTonAddress } from './ton_messages.ts';
import {
  type TonAccountState,
  type TonHttpEndpoint,
  type TonProvider,
  type TonTrace,
  type TonTraceMessage,
  type TonTraceTransaction,
  asAccountStatus,
  asBigInt,
  asRecord,
  definiteError,
  errorMessageOf,
  tonHttpJson,
} from './ton_provider.ts';

const NAME = 'TON Center';

interface ToncenterStackItem {
  type: string;
  value: string;
}

/** TON Center's indexer API (`/api/v3`) and its emulator (`/api/emulate/v1`). */
export class ToncenterProvider implements TonProvider {
  readonly name = NAME;

  constructor(private readonly endpoint: TonHttpEndpoint) {}

  async getAccountState(address: string): Promise<TonAccountState> {
    const reply = asRecord(
      await this.get(`/api/v3/accountStates?address=${encodeURIComponent(tonRawAddress(address))}&include_boc=false`),
      'accountStates',
    );
    const accounts = Array.isArray(reply.accounts) ? reply.accounts : [];
    if (accounts.length === 0) return { status: 'nonexist', balance: 0n, codeHash: null };
    const account = asRecord(accounts[0], 'account');
    const balance = asBigInt(account.balance, 'balance');
    let status = asAccountStatus(account.status);
    // TON Center reports a never-touched address as `uninit`; it has no history.
    if (status === 'uninit' && balance === 0n && (account.last_transaction_lt ?? '0') === '0') status = 'nonexist';
    return { status, balance, codeHash: typeof account.code_hash === 'string' ? account.code_hash : null };
  }

  async getSeqno(address: string): Promise<number> {
    const result = await this.runGetMethod(address, 'seqno', []);
    if (result === null) return 0;
    return Number(numAt(result, 0, 'seqno'));
  }

  async getJettonWalletAddress(jettonMaster: string, owner: string): Promise<string> {
    const ownerSlice = beginCell().storeAddress(parseTonAddress(owner)).endCell().toBoc().toString('base64');
    const result = await this.runGetMethod(jettonMaster, 'get_wallet_address', [{ type: 'slice', value: ownerSlice }]);
    if (result === null) throw definiteError(ChainErrorKinds.InvalidTokenIdentifier, `${jettonMaster} is not a jetton master`);
    const item = result[0];
    if (item === undefined || (item.type !== 'cell' && item.type !== 'slice')) {
      throw definiteError(ChainErrorKinds.RpcError, `${NAME} get_wallet_address returned no address`);
    }
    return Cell.fromBase64(item.value).beginParse().loadAddress().toRawString();
  }

  async getJettonBalance(jettonWallet: string): Promise<bigint> {
    const result = await this.runGetMethod(jettonWallet, 'get_wallet_data', []);
    return result === null ? 0n : numAt(result, 0, 'jetton balance');
  }

  async sendBoc(boc: string): Promise<void> {
    const reply = await tonHttpJson(NAME, this.endpoint, '/api/v3/message', { method: 'POST', body: { boc }, headers: this.headers() });
    const error = errorMessageOf(reply);
    if (error !== null) throw definiteError(ChainErrorKinds.BroadcastRejected, `${NAME} refused the message: ${error}`);
  }

  async getTrace(hash: string): Promise<TonTrace | null> {
    const reply = asRecord(await this.get(`/api/v3/traces?msg_hash=${encodeURIComponent(hexToBase64(hash))}`), 'traces');
    const traces = Array.isArray(reply.traces) ? reply.traces : [];
    if (traces.length === 0) return null;
    const trace = asRecord(traces[0], 'trace');
    const info = asRecord(trace.trace_info ?? {}, 'trace_info');
    const complete = trace.is_incomplete !== true && info.trace_state === 'complete' && Number(info.pending_messages ?? 0) === 0;
    return { complete, transactions: orderedTransactions(trace.trace, asRecord(trace.transactions, 'transactions')) };
  }

  async emulate(boc: string): Promise<TonTrace> {
    const reply = await tonHttpJson(NAME, this.endpoint, '/api/emulate/v1/emulateTrace', {
      method: 'POST',
      body: { boc, ignore_chksig: true },
      headers: this.headers(),
    });
    const error = errorMessageOf(reply);
    if (error !== null) throw definiteError(ChainErrorKinds.SimulationFailed, `${NAME} emulation failed: ${error}`);
    const result = asRecord(reply, 'emulation');
    return { complete: true, transactions: orderedTransactions(result.trace, asRecord(result.transactions, 'transactions')) };
  }

  async getMasterchainSeqno(): Promise<number> {
    const reply = asRecord(await this.get('/api/v3/masterchainInfo'), 'masterchainInfo');
    return Number(asRecord(reply.last, 'last').seqno);
  }

  /** The stack of a get-method that ran, or `null` when the account has no code to run it. */
  private async runGetMethod(address: string, method: string, stack: ToncenterStackItem[]): Promise<ToncenterStackItem[] | null> {
    const reply = asRecord(
      await tonHttpJson(NAME, this.endpoint, '/api/v3/runGetMethod', {
        method: 'POST',
        body: { address: tonRawAddress(address), method, stack },
        headers: this.headers(),
      }),
      'runGetMethod',
    );
    if (errorMessageOf(reply) !== null || Number(reply.exit_code ?? 0) !== 0) return null;
    return Array.isArray(reply.stack) ? (reply.stack as ToncenterStackItem[]) : [];
  }

  private async get(path: string): Promise<unknown> {
    return (await tonHttpJson(NAME, this.endpoint, path, { headers: this.headers() })) ?? {};
  }

  private headers(): Record<string, string> {
    return { 'X-API-Key': this.endpoint.apiKey };
  }
}

function numAt(stack: ToncenterStackItem[], index: number, what: string): bigint {
  const item = stack[index];
  if (item === undefined || item.type !== 'num') throw definiteError(ChainErrorKinds.RpcError, `${NAME} returned no ${what}`);
  return asBigInt(item.value, what);
}

/** The trace's transactions, root first then breadth-first along the trace tree. */
function orderedTransactions(tree: unknown, byHash: Record<string, unknown>): TonTraceTransaction[] {
  const ordered: TonTraceTransaction[] = [];
  const queue: unknown[] = tree === undefined || tree === null ? [] : [tree];
  while (queue.length > 0) {
    const node = asRecord(queue.shift(), 'trace node');
    const tx = byHash[String(node.tx_hash)];
    if (tx !== undefined) ordered.push(toTransaction(asRecord(tx, 'transaction')));
    if (Array.isArray(node.children)) queue.push(...node.children);
  }
  return ordered;
}

function toTransaction(tx: Record<string, unknown>): TonTraceTransaction {
  const description = asRecord(tx.description ?? {}, 'description');
  const compute = description.compute_ph === undefined ? null : asRecord(description.compute_ph, 'compute_ph');
  const action = description.action === undefined || description.action === null ? null : asRecord(description.action, 'action');
  const computeOk = compute === null || (compute.skipped === true ? compute.reason === 'no_state' : compute.success === true);
  const skippedActions = action === null ? 0 : Number(action.skipped_actions ?? 0);
  const actionOk = action === null || (action.success === true && skippedActions === 0);
  const finalized = tx.finality === undefined || tx.finality === 'finalized';
  return {
    hash: base64ToHex(String(tx.hash)),
    account: tonRawAddress(String(tx.account)),
    success: computeOk && actionOk,
    skippedActions,
    aborted: description.aborted === true,
    computeExitCode: compute === null || compute.skipped === true ? null : Number(compute.exit_code),
    actionResultCode: action === null ? null : Number(action.result_code),
    totalFees: asBigInt(tx.total_fees, 'total_fees'),
    origStatus: asAccountStatus(tx.orig_status),
    endStatus: asAccountStatus(tx.end_status),
    inMsg: tx.in_msg === null || tx.in_msg === undefined ? null : toMessage(asRecord(tx.in_msg, 'in_msg')),
    outMsgs: (Array.isArray(tx.out_msgs) ? tx.out_msgs : []).map((m) => toMessage(asRecord(m, 'out_msg'))),
    mcSeqno: finalized && typeof tx.mc_block_seqno === 'number' ? tx.mc_block_seqno : null,
    utime: Number(tx.now ?? 0),
  };
}

function toMessage(msg: Record<string, unknown>): TonTraceMessage {
  const content = msg.message_content === null || msg.message_content === undefined ? null : asRecord(msg.message_content, 'message_content');
  const body = content !== null && typeof content.body === 'string' ? Cell.fromBase64(content.body) : null;
  return {
    source: typeof msg.source === 'string' ? tonRawAddress(msg.source) : null,
    destination: typeof msg.destination === 'string' ? tonRawAddress(msg.destination) : null,
    value: asBigInt(msg.value, 'value'),
    fwdFee: asBigInt(msg.fwd_fee, 'fwd_fee'),
    bounce: msg.bounce === true,
    bounced: msg.bounced === true,
    opcode: typeof msg.opcode === 'string' ? Number(BigInt(msg.opcode)) >>> 0 : null,
    body,
  };
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

function base64ToHex(base64: string): string {
  return Buffer.from(base64, 'base64').toString('hex');
}
