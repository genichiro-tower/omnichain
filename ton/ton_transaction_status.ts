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
import { TON_JETTON_INTERNAL_TRANSFER_OP, TON_JETTON_TRANSFER_OP, TON_W5_SIGNED_INTERNAL_OP } from './ton_messages.ts';
import { type TonTrace, type TonTraceMessage, type TonTraceTransaction, assertTraceConsistent } from './ton_provider.ts';

/** Jettons a jetton wallet received in a trace (a TEP-74 `internal_transfer` it accepted). */
/** Jettons a jetton wallet accepted (`internal_transfer`), read from the trace alone — not yet checked against any master. */
export interface TonJettonCredit {
  /** The receiving jetton wallet, raw. */
  jettonWallet: string;
  amount: bigint;
  /** The previous owner the transfer names, raw. */
  from: string | null;
  /** The jetton wallet that sent them, raw. */
  senderJettonWallet: string | null;
  /** The receiving transaction. */
  transaction: string;
}

/** What happened to one message a wallet sent. */
export type TonDeliveryOutcome =
  /**
   * Its destination kept it (a non-bounceable message is delivered even if the
   * receiver then failed). For a jetton transfer, the receiver's jetton wallet
   * accepted the jettons.
   */
  | 'delivered'
  /** Its destination failed or had no code, and the value (or the jettons) came back. */
  | 'bounced'
  /**
   * A bounceable message whose destination failed without sending it back —
   * an action phase that failed without send mode +16, or too little value
   * left to pay for the bounce. The value stayed there or went on fees.
   */
  | 'failed'
  /**
   * A jetton transfer whose sender's jetton wallet took it without error but
   * sent the jettons nowhere. Never a message missing from a complete trace:
   * that is the provider's gap, refused as an inconsistent trace.
   */
  | 'undelivered'
  /** The trace is still running. */
  | 'pending';

export interface TonMessageDelivery {
  /** The sending wallet, raw. */
  from: string;
  /** Raw. */
  to: string;
  value: bigint;
  outcome: TonDeliveryOutcome;
  /** The receiving transaction's hash, when there is one. */
  transaction: string | null;
}

/** Why the request did not do what it was signed for. */
export interface TonRequestProblem {
  code: string;
  reason: string;
}

/** What a trace did, from either a real trace or an emulation. */
export interface TonTraceSummary {
  /**
   * The request did what it was signed for: the sending wallet's transaction
   * (and, for a relayed request, the target wallet's) succeeded with nothing
   * skipped, and every message those wallets sent was delivered. Failures
   * further down — a recipient contract that throws on a notification, an
   * excess refund that was skipped — do not undo those deliveries and are
   * reported in `failedTransactions` / `bouncedMessages` only.
   */
  success: boolean;
  problem: TonRequestProblem | null;
  /** Every message the sending wallets sent, and what became of it. */
  deliveries: TonMessageDelivery[];
  /** Nanotons the network took: every transaction's fees plus the forward fees its messages carried. */
  fees: bigint;
  failedTransactions: TonTraceTransaction[];
  bouncedMessages: TonTraceMessage[];
  /** Native TON per account. */
  balanceChanges: NestedBalanceChanges;
  jettonCredits: TonJettonCredit[];
}

export function summarizeTonTrace(chainId: number, trace: TonTrace): TonTraceSummary {
  assertTraceConsistent('the trace given', trace);
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
    // Accepted unless the jetton wallet's transaction aborted; a refund it then skipped does not undo the credit.
    const credit = !tx.aborted && tx.inMsg !== null ? jettonCreditOf(tx, tx.inMsg) : null;
    if (credit !== null) jettonCredits.push(credit);
  }

  const balanceChanges: NestedBalanceChanges = new Map();
  for (const [account, delta] of deltas) {
    balanceChanges.set(
      account,
      new Map([[assetHashOf(native), { token: native, change: AssetBalanceChange.fromMr(delta, TonAsset.NATIVE_DECIMALS) }]]),
    );
  }
  const { problem, deliveries } = judgeRequest(trace);
  return {
    success: problem === null,
    problem,
    deliveries,
    fees,
    failedTransactions: trace.transactions.filter((tx) => !tx.success),
    bouncedMessages: trace.transactions.flatMap((tx) => (tx.inMsg !== null && tx.inMsg.bounced ? [tx.inMsg] : [])),
    balanceChanges,
    jettonCredits,
  };
}

/**
 * Judges the wallets that sent the request — the root, and any wallet it
 * delivered a signed internal request to — on their own transactions and on
 * the first hop of every message they sent.
 */
function judgeRequest(trace: TonTrace): { problem: TonRequestProblem | null; deliveries: TonMessageDelivery[] } {
  const root = trace.transactions[0];
  if (root === undefined) return { problem: { code: 'no_transaction', reason: 'the trace has no transaction' }, deliveries: [] };
  const children = childrenByParent(trace.transactions);
  const relayTargets = (children.get(root.hash) ?? []).filter((tx) => tx.inMsg?.opcode === TON_W5_SIGNED_INTERNAL_OP);

  const deliveries: TonMessageDelivery[] = [];
  let problem: TonRequestProblem | null = null;
  const note = (found: TonRequestProblem): void => {
    problem ??= found;
  };
  for (const wallet of [root, ...relayTargets]) {
    if (!wallet.success) {
      note(
        wallet.skippedActions > 0
          ? { code: 'skipped_actions', reason: `${wallet.account} skipped ${wallet.skippedActions} message(s) it could not send` }
          : { code: String(wallet.computeExitCode ?? wallet.actionResultCode ?? 'failed'), reason: `${wallet.account} failed in ${wallet.hash}` },
      );
    }
    // A bounce the wallet sends back is not a message it was asked to send.
    // Sorted by creation, the order the request listed them.
    const sent = wallet.outMsgs
      .filter((m) => m.destination !== null && !m.bounced)
      .sort((a, b) => (a.createdLt === b.createdLt ? 0 : (a.createdLt ?? 0n) < (b.createdLt ?? 0n) ? -1 : 1));
    if (wallet !== root && wallet.success && sent.length === 0) {
      note({ code: 'request_not_executed', reason: `${wallet.account} did not execute the relayed request (bad signature or seqno)` });
    }
    const received = children.get(wallet.hash) ?? [];
    for (const message of sent) {
      const { receiver, outcome: firstHop } = deliveryOf(message, received, trace.complete);
      // A jetton transfer moves the jettons one hop later, in the receiver's jetton wallet.
      const jettonHop =
        firstHop === 'delivered' && message.opcode === TON_JETTON_TRANSFER_OP && receiver !== null
          ? jettonDeliveryOf(receiver, children.get(receiver.hash) ?? [], trace.complete)
          : null;
      const outcome = jettonHop?.outcome ?? firstHop;
      deliveries.push({
        from: wallet.account,
        to: message.destination as string,
        value: message.value,
        outcome,
        transaction: jettonHop?.receiver?.hash ?? receiver?.hash ?? null,
      });
      if (outcome === 'bounced' || outcome === 'undelivered' || outcome === 'failed') {
        const code = outcome === 'failed' ? 'receiver_failed' : outcome;
        note({
          code: jettonHop === null ? code : `jetton_${code}`,
          reason: `a ${jettonHop === null ? 'message' : 'jetton transfer'} from ${wallet.account} to ${message.destination} was ${outcome}`,
        });
      }
    }
  }
  return { problem, deliveries };
}

/**
 * Which received transaction took `message`, and whether it kept the value.
 *
 * Matched on (source, createdLt), which names one message. The providers
 * refuse a trace whose receivers disagree with their senders, so a match is
 * the message itself.
 */
function deliveryOf(
  message: TonTraceMessage,
  received: readonly TonTraceTransaction[],
  complete: boolean,
): { receiver: TonTraceTransaction | null; outcome: TonDeliveryOutcome } {
  const receiver =
    received.find((tx) => tx.inMsg !== null && tx.inMsg.source === message.source && tx.inMsg.createdLt === message.createdLt) ??
    null;
  if (receiver === null) return { receiver, outcome: complete ? 'undelivered' : 'pending' };
  // A receiver that did not abort kept the value, even if it skipped one of its
  // own sends (e.g. an excess refund under "ignore errors"); so did one a
  // non-bounceable message reached. An aborted receiver of a bounceable message
  // sends it back only on a failed compute phase (no code yet included), a
  // failed action with send mode +16, and when the value covers the bounce;
  // the bounce is in the receiver's own transaction.
  if (!message.bounce || !receiver.aborted) return { receiver, outcome: 'delivered' };
  const bouncedBack = receiver.outMsgs.some((m) => m.bounced && m.destination === message.source);
  return { receiver, outcome: bouncedBack ? 'bounced' : 'failed' };
}

/** The `internal_transfer` the sender's jetton wallet sent on, judged where the jettons land. */
function jettonDeliveryOf(
  senderJettonWallet: TonTraceTransaction,
  received: readonly TonTraceTransaction[],
  complete: boolean,
): { receiver: TonTraceTransaction | null; outcome: TonDeliveryOutcome } {
  const transfer = senderJettonWallet.outMsgs.find((m) => m.opcode === TON_JETTON_INTERNAL_TRANSFER_OP && !m.bounced);
  if (transfer === undefined) return { receiver: null, outcome: complete ? 'undelivered' : 'pending' };
  return deliveryOf(transfer, received, complete);
}

function childrenByParent(transactions: readonly TonTraceTransaction[]): Map<string, TonTraceTransaction[]> {
  const byParent = new Map<string, TonTraceTransaction[]>();
  for (const tx of transactions) {
    if (tx.parent === null) continue;
    byParent.set(tx.parent, [...(byParent.get(tx.parent) ?? []), tx]);
  }
  return byParent;
}

function jettonCreditOf(tx: TonTraceTransaction, inMsg: TonTraceMessage): TonJettonCredit | null {
  if (inMsg.opcode !== TON_JETTON_INTERNAL_TRANSFER_OP || inMsg.bounced || inMsg.body === null) return null;
  try {
    const slice = (inMsg.body as Cell).beginParse();
    slice.skip(32 + 64);
    const amount = slice.loadCoins();
    const from = slice.loadMaybeAddress();
    return {
      jettonWallet: tx.account,
      amount,
      from: from === null ? null : from.toRawString(),
      senderJettonWallet: inMsg.source,
      transaction: tx.hash,
    };
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
 * more anyway. `Failed` when the request did not do what it was signed for
 * (see {@link TonTraceSummary.success}); a failed status still carries the
 * summary, whose `deliveries` say which messages did arrive.
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
    const error: TransactionErrorInfo = { ...(summary.problem as TonRequestProblem) };
    return new TonTransactionStatus({ ...common, status: TransactionStatusTypes.Failed, error });
  }
}
