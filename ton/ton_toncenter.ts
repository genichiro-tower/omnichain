import { Cell, beginCell } from '@ton/core';

import { ChainErrorKinds } from '../errors.ts';
import { tonRawAddress } from './ton_address.ts';
import { parseTonAddress } from './ton_messages.ts';
import {
  type TonAccountState,
  type TonHttpEndpoint,
  type TonMasterchainHead,
  type TonProvider,
  type TonTrace,
  type TonTraceMessage,
  type TonTraceTransaction,
  TonProviderError,
  asAccountStatus,
  asBigInt,
  asRequiredInteger,
  asStatedAccountStatus,
  assertTraceConsistent,
  asRecord,
  definiteError,
  errorMessageOf,
  tonBroadcastReply,
  tonHttpJson,
} from './ton_provider.ts';

const NAME = 'TON Center';
/** TON Center's get-method exit code for an account with no code to run. */
const NO_CODE_EXIT_CODE = -13;

interface ToncenterStackItem {
  type: string;
  value: string;
}

/** TON Center's indexer API (`/api/v3`) and its emulator (`/api/emulate/v1`). */
export class ToncenterProvider implements TonProvider {
  readonly name = NAME;

  constructor(private readonly endpoint: TonHttpEndpoint) {}

  async getAccountState(address: string): Promise<TonAccountState> {
    const path = `/api/v3/accountStates?address=${encodeURIComponent(tonRawAddress(address))}&include_boc=false`;
    const reply = await tonHttpJson(NAME, this.endpoint, path, { headers: this.headers() });
    // Only an explicit empty list means a never-used address.
    if (reply === null || !Array.isArray((reply as Record<string, unknown>).accounts)) {
      throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} returned no account list for ${address}`, true);
    }
    const accounts = (reply as Record<string, unknown[]>).accounts;
    if (accounts.length === 0) return { status: 'nonexist', balance: 0n, codeHash: null };
    const account = asRecord(accounts[0], 'account');
    const balance = asBigInt(account.balance, 'balance');
    let status = asStatedAccountStatus(account.status);
    // TON Center reports a never-touched address as `uninit`; it has no history.
    if (status === 'uninit' && balance === 0n && (account.last_transaction_lt ?? '0') === '0') status = 'nonexist';
    return { status, balance, codeHash: typeof account.code_hash === 'string' ? account.code_hash : null };
  }

  async getSeqno(address: string): Promise<number> {
    const reply = await this.runGetMethodReply(address, 'seqno', []);
    const exitCode = Number(reply.exit_code);
    if (errorMessageOf(reply) === null && exitCode === NO_CODE_EXIT_CODE) return 0;
    if (errorMessageOf(reply) !== null || exitCode !== 0 || !Array.isArray(reply.stack)) {
      throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} could not run seqno on ${address}`, true);
    }
    return asRequiredInteger(String(numAt(reply.stack as ToncenterStackItem[], 0, 'seqno')), 'seqno');
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
    const reply = await tonBroadcastReply(
      NAME,
      tonHttpJson(NAME, this.endpoint, '/api/v3/message', { method: 'POST', body: { boc }, headers: this.headers() }),
    );
    const error = errorMessageOf(reply);
    if (error !== null) throw definiteError(ChainErrorKinds.BroadcastRejected, `${NAME} refused the message: ${error}`);
  }

  async getTrace(hash: string): Promise<TonTrace | null> {
    const reply = asRecord(await this.get(`/api/v3/traces?msg_hash=${encodeURIComponent(hexToBase64(hash))}`), 'traces');
    const traces = Array.isArray(reply.traces) ? reply.traces : [];
    if (traces.length === 0) return null;
    const trace = asRecord(traces[0], 'trace');
    const info = asRecord(trace.trace_info ?? {}, 'trace_info');
    const { transactions, missing } = orderedTransactions(trace.trace, asRecord(trace.transactions, 'transactions'));
    const finished = trace.is_incomplete !== true && info.trace_state === 'complete' && Number(info.pending_messages ?? 0) === 0;
    // A trace still running may not have every transaction yet; a finished one
    // without them never will, so TonAPI is asked instead.
    if (finished && missing) {
      throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} returned a finished trace with transactions left out`, true);
    }
    return assertTraceConsistent(NAME, { complete: finished && !missing, transactions });
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
    const { transactions, missing } = orderedTransactions(result.trace, asRecord(result.transactions, 'transactions'));
    if (missing) throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} emulation returned a trace with missing transactions`, true);
    return assertTraceConsistent(NAME, { complete: true, transactions });
  }

  async getMasterchainHead(): Promise<TonMasterchainHead> {
    const reply = asRecord(await this.get('/api/v3/masterchainInfo'), 'masterchainInfo');
    const last = asRecord(reply.last, 'last');
    return { seqno: asRequiredInteger(last.seqno, 'masterchain seqno'), utime: asRequiredInteger(last.gen_utime, 'masterchain gen_utime') };
  }

  /** The stack of a get-method that ran, or `null` when the account has no code to run it. */
  private async runGetMethod(address: string, method: string, stack: ToncenterStackItem[]): Promise<ToncenterStackItem[] | null> {
    const reply = await this.runGetMethodReply(address, method, stack);
    if (errorMessageOf(reply) !== null || Number(reply.exit_code ?? 0) !== 0) return null;
    return Array.isArray(reply.stack) ? (reply.stack as ToncenterStackItem[]) : [];
  }

  private async runGetMethodReply(address: string, method: string, stack: ToncenterStackItem[]): Promise<Record<string, unknown>> {
    const reply = await tonHttpJson(NAME, this.endpoint, '/api/v3/runGetMethod', {
      method: 'POST',
      body: { address: tonRawAddress(address), method, stack },
      headers: this.headers(),
    });
    if (reply === null) throw new TonProviderError(ChainErrorKinds.RpcError, `${NAME} runGetMethod returned nothing`, true);
    return asRecord(reply, 'runGetMethod');
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

/**
 * The trace's transactions, root first then breadth-first along the trace
 * tree. A node whose transaction the reply left out stays the parent of its
 * children, and makes the trace `missing` a part.
 */
function orderedTransactions(tree: unknown, byHash: Record<string, unknown>): { transactions: TonTraceTransaction[]; missing: boolean } {
  const ordered: TonTraceTransaction[] = [];
  let missing = false;
  const queue: Array<{ node: unknown; parent: string | null }> =
    tree === undefined || tree === null ? [] : [{ node: tree, parent: null }];
  while (queue.length > 0) {
    const { node: raw, parent } = queue.shift() as { node: unknown; parent: string | null };
    const node = asRecord(raw, 'trace node');
    const tx = byHash[String(node.tx_hash)];
    if (tx === undefined) missing = true;
    else ordered.push(toTransaction(asRecord(tx, 'transaction'), parent));
    const children = Array.isArray(node.children) ? node.children : [];
    queue.push(...children.map((child) => ({ node: child, parent: base64ToHex(String(node.tx_hash)) })));
  }
  return { transactions: ordered, missing };
}

function toTransaction(tx: Record<string, unknown>, parent: string | null): TonTraceTransaction {
  const description = asRecord(tx.description ?? {}, 'description');
  const compute = description.compute_ph === undefined ? null : asRecord(description.compute_ph, 'compute_ph');
  const action = description.action === undefined || description.action === null ? null : asRecord(description.action, 'action');
  const computeOk = compute === null || (compute.skipped === true ? compute.reason === 'no_state' : compute.success === true);
  const skippedActions = action === null ? 0 : Number(action.skipped_actions ?? 0);
  const actionOk = action === null || (action.success === true && skippedActions === 0);
  const finalized = tx.finality === undefined || tx.finality === 'finalized';
  return {
    hash: base64ToHex(String(tx.hash)),
    parent,
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
  const cell = content !== null && typeof content.body === 'string' ? Cell.fromBase64(content.body) : null;
  // An empty body is no body, as TonAPI's decoded messages read it.
  const body = cell === null || (cell.bits.length === 0 && cell.refs.length === 0) ? null : cell;
  return {
    source: typeof msg.source === 'string' ? tonRawAddress(msg.source) : null,
    destination: typeof msg.destination === 'string' ? tonRawAddress(msg.destination) : null,
    value: asBigInt(msg.value, 'value'),
    fwdFee: asBigInt(msg.fwd_fee, 'fwd_fee'),
    bounce: msg.bounce === true,
    bounced: msg.bounced === true,
    opcode: typeof msg.opcode === 'string' ? Number(BigInt(msg.opcode)) >>> 0 : null,
    createdLt: msg.created_lt === null || msg.created_lt === undefined ? null : asBigInt(msg.created_lt, 'created_lt'),
    body,
  };
}

function hexToBase64(hex: string): string {
  return Buffer.from(hex, 'hex').toString('base64');
}

function base64ToHex(base64: string): string {
  return Buffer.from(base64, 'base64').toString('hex');
}
