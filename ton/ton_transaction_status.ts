import type { Cell } from '@ton/core';

import {
  AssetBalanceChange,
  type NestedBalanceChanges,
  TransactionStatus,
  type TransactionErrorInfo,
  type TransactionStatusType,
  TransactionStatusTypes,
  assetHashOf,
} from '../transaction_status.ts';
import { TonAsset } from './ton_asset.ts';
import { TON_JETTON_INTERNAL_TRANSFER_OP } from './ton_messages.ts';
import type { TonTrace, TonTraceMessage, TonTraceTransaction } from './ton_provider.ts';

/** Jettons a jetton wallet received in a trace (a TEP-74 `internal_transfer` it accepted). */
export interface TonJettonCredit {
  /** The receiving jetton wallet, raw. */
  jettonWallet: string;
  amount: bigint;
  /** The previous owner the transfer names, raw. */
  from: string | null;
}

/** What a trace did, from either a real trace or an emulation. */
export interface TonTraceSummary {
  /** Every transaction succeeded and no message bounced. */
  success: boolean;
  /** Nanotons the network took: every transaction's fees plus the forward fees its messages carried. */
  fees: bigint;
  failedTransactions: TonTraceTransaction[];
  bouncedMessages: TonTraceMessage[];
  /** Native TON per account. */
  balanceChanges: NestedBalanceChanges;
  jettonCredits: TonJettonCredit[];
}

export function summarizeTonTrace(chainId: number, trace: TonTrace): TonTraceSummary {
  const native = new TonAsset(chainId, 'TON', null, TonAsset.NATIVE_DECIMALS);
  const deltas = new Map<string, bigint>();
  const add = (account: string, delta: bigint): void => {
    deltas.set(account, (deltas.get(account) ?? 0n) + delta);
  };
  let fees = 0n;
  const jettonCredits: TonJettonCredit[] = [];
  for (const tx of trace.transactions) {
    fees += tx.totalFees;
    let debit = tx.totalFees;
    if (tx.inMsg !== null && tx.inMsg.source !== null) add(tx.account, tx.inMsg.value);
    for (const out of tx.outMsgs) {
      if (out.destination === null) continue;
      fees += out.fwdFee;
      debit += out.value + out.fwdFee;
    }
    add(tx.account, -debit);
    const credit = tx.success && tx.inMsg !== null ? jettonCreditOf(tx.account, tx.inMsg) : null;
    if (credit !== null) jettonCredits.push(credit);
  }

  const balanceChanges: NestedBalanceChanges = new Map();
  for (const [account, delta] of deltas) {
    balanceChanges.set(
      account,
      new Map([[assetHashOf(native), { token: native, change: AssetBalanceChange.fromMr(delta, TonAsset.NATIVE_DECIMALS) }]]),
    );
  }
  const failedTransactions = trace.transactions.filter((tx) => !tx.success);
  const bouncedMessages = trace.transactions.flatMap((tx) => (tx.inMsg !== null && tx.inMsg.bounced ? [tx.inMsg] : []));
  return {
    success: failedTransactions.length === 0 && bouncedMessages.length === 0,
    fees,
    failedTransactions,
    bouncedMessages,
    balanceChanges,
    jettonCredits,
  };
}

function jettonCreditOf(account: string, inMsg: TonTraceMessage): TonJettonCredit | null {
  if (inMsg.opcode !== TON_JETTON_INTERNAL_TRANSFER_OP || inMsg.bounced || inMsg.body === null) return null;
  try {
    const slice = (inMsg.body as Cell).beginParse();
    slice.skip(32 + 64);
    const amount = slice.loadCoins();
    const from = slice.loadMaybeAddress();
    return { jettonWallet: account, amount, from: from === null ? null : from.toRawString() };
  } catch {
    return null;
  }
}

export interface TonTransactionStatusInit {
  chainId: number;
  status: TransactionStatusType;
  inclusionAt?: Date | null;
  error?: TransactionErrorInfo | null;
  balanceChanges?: NestedBalanceChanges | null;
  trace?: TonTrace | null;
  summary?: TonTraceSummary | null;
  masterchainSeqno?: number | null;
  masterchainDepth?: number | null;
}

/**
 * The status of an external message's whole trace.
 *
 * Final — `Success` or `Failed` — only once the trace is complete and every
 * transaction in it is in a block a masterchain block references. TON's
 * consensus is final at that point; `masterchainDepth` lets a caller ask for
 * more anyway. `Failed` when any transaction failed or any message bounced.
 */
export class TonTransactionStatus extends TransactionStatus {
  readonly trace: TonTrace | null;
  readonly summary: TonTraceSummary | null;
  /** The highest masterchain block referencing the trace's transactions. */
  readonly masterchainSeqno: number | null;
  /** Masterchain blocks since then. */
  readonly masterchainDepth: number | null;

  constructor(init: TonTransactionStatusInit) {
    super({
      chainId: init.chainId,
      status: init.status,
      inclusionAt: init.inclusionAt,
      error: init.error,
      balanceChanges: init.balanceChanges,
    });
    this.trace = init.trace ?? null;
    this.summary = init.summary ?? null;
    this.masterchainSeqno = init.masterchainSeqno ?? null;
    this.masterchainDepth = init.masterchainDepth ?? null;
  }

  get fees(): bigint | null {
    return this.summary?.fees ?? null;
  }

  get jettonCredits(): TonJettonCredit[] {
    return this.summary?.jettonCredits ?? [];
  }

  static fromTrace(args: {
    chainId: number;
    trace: TonTrace | null;
    masterchainTip: number;
    minMasterchainDepth?: number;
  }): TonTransactionStatus {
    const { chainId, trace } = args;
    const pending = (): TonTransactionStatus =>
      new TonTransactionStatus({ chainId, status: TransactionStatusTypes.Pending, trace });
    if (trace === null || !trace.complete || trace.transactions.length === 0) return pending();
    const seqnos = trace.transactions.map((tx) => tx.mcSeqno);
    if (seqnos.some((seqno) => seqno === null)) return pending();
    const masterchainSeqno = Math.max(...(seqnos as number[]));
    const masterchainDepth = Math.max(args.masterchainTip - masterchainSeqno, 0);
    if (masterchainDepth < (args.minMasterchainDepth ?? 0)) return pending();

    const summary = summarizeTonTrace(chainId, trace);
    const common = {
      chainId,
      inclusionAt: new Date(trace.transactions[0].utime * 1000),
      trace,
      summary,
      masterchainSeqno,
      masterchainDepth,
    };
    if (summary.success) {
      return new TonTransactionStatus({ ...common, status: TransactionStatusTypes.Success, balanceChanges: summary.balanceChanges });
    }
    const failed = summary.failedTransactions[0];
    const error: TransactionErrorInfo =
      failed === undefined
        ? { code: 'bounced', reason: `${summary.bouncedMessages.length} message(s) bounced` }
        : {
            code: String(failed.computeExitCode ?? failed.actionResultCode ?? 'failed'),
            reason: `transaction ${failed.hash} on ${failed.account} failed`,
          };
    return new TonTransactionStatus({ ...common, status: TransactionStatusTypes.Failed, error });
  }
}
