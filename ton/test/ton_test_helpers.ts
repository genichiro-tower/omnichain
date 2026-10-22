import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { TonTrace, TonTraceMessage, TonTraceTransaction } from '../ton_provider.ts';
import { ToncenterProvider } from '../ton_toncenter.ts';

export const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const USDT_MASTER = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';
export const OTHER = '0:9d1e1843624c4d175a695a8c2de8a5a61f03b93336e8caa4e164bf6cbbab205e';
export const JETTON_WALLET = '0:e655d099d9200bbf27c20d594f2ebd21a0f854c608cd16d4c0c5e9b3f55fc2e7';

/** The normalized hash of the external message the recorded trace starts with: its id. */
export const REAL_TRACE_MESSAGE_HASH = '0b64b29895862dae3dd18964c9c6b7562e35b9a81ade0d002f3c9a4823ee859e';

/** The recorded W5 transfer trace (a wallet paying 3.7944 TON to another), read through TON Center's parser. */
export async function realTrace(): Promise<TonTrace> {
  const body = JSON.parse(readFileSync(new URL('./fixtures/toncenter_trace.json', import.meta.url), 'utf8'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  try {
    return (await new ToncenterProvider({ url: 'https://x', apiKey: 'k' }).getTrace(REAL_TRACE_MESSAGE_HASH)) as TonTrace;
  } finally {
    globalThis.fetch = realFetch;
  }
}

/** `receiver` aborted and sent its incoming message back, as TON's bounce phase does. */
export function bouncing(receiver: TonTraceTransaction): TonTraceTransaction {
  const inMsg = receiver.inMsg as TonTraceMessage;
  const bounce: TonTraceMessage = {
    ...inMsg,
    source: receiver.account,
    destination: inMsg.source,
    bounce: false,
    bounced: true,
    createdLt: (inMsg.createdLt ?? 0n) + 1n,
  };
  return { ...receiver, success: false, aborted: true, outMsgs: [...receiver.outMsgs, bounce] };
}

/**
 * A hand-built trace made whole the way the chain would have it: each
 * transaction's incoming message is one its parent sent (added to the
 * parent's messages if the test left it out), and every message sent has the
 * transaction that received it (a plain, successful one if the test left it
 * out). Providers refuse a trace with gaps, and so does the judgment.
 */
export function settled(transactions: readonly TonTraceTransaction[]): TonTraceTransaction[] {
  const txs = transactions.map((tx) => ({ ...tx, outMsgs: [...tx.outMsgs] }));
  const byHash = new Map(txs.map((tx) => [tx.hash, tx]));
  let lt = 900_000_000_000n;
  for (const tx of txs.slice(1)) {
    const parent = tx.parent === null ? undefined : byHash.get(tx.parent);
    const inMsg = tx.inMsg;
    if (parent === undefined || inMsg === null) continue;
    const sent = parent.outMsgs.find(
      (m) => m.source === inMsg.source && m.createdLt === inMsg.createdLt && m.destination === tx.account && m.value === inMsg.value,
    );
    if (sent !== undefined) continue;
    const message: TonTraceMessage = { ...inMsg, source: parent.account, destination: tx.account, createdLt: lt++ };
    tx.inMsg = message;
    parent.outMsgs.push(message);
  }
  const received = new Set(txs.flatMap((tx) => (tx.parent !== null && tx.inMsg !== null ? [`${tx.parent}:${tx.inMsg.createdLt}`] : [])));
  const receivers = txs.flatMap((tx) =>
    tx.outMsgs
      .filter((m) => m.destination !== null && !received.has(`${tx.hash}:${m.createdLt}`))
      .map(
        (m): TonTraceTransaction => ({
          ...tx,
          hash: createHash('sha256').update(`${tx.hash}:${m.createdLt}`).digest('hex'),
          parent: tx.hash,
          account: m.destination as string,
          success: true,
          skippedActions: 0,
          aborted: false,
          computeExitCode: 0,
          actionResultCode: 0,
          inMsg: m,
          outMsgs: [],
        }),
      ),
  );
  return [...txs, ...receivers];
}
