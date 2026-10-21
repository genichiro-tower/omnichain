import { readFileSync } from 'node:fs';

import type { TonTrace } from '../ton_provider.ts';
import { ToncenterProvider } from '../ton_toncenter.ts';

export const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
export const USDT_MASTER = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';
export const OTHER = '0:9d1e1843624c4d175a695a8c2de8a5a61f03b93336e8caa4e164bf6cbbab205e';
export const JETTON_WALLET = '0:e655d099d9200bbf27c20d594f2ebd21a0f854c608cd16d4c0c5e9b3f55fc2e7';

/** The recorded W5 transfer trace (a wallet paying 3.7944 TON to another), read through TON Center's parser. */
export async function realTrace(): Promise<TonTrace> {
  const body = JSON.parse(readFileSync(new URL('./fixtures/toncenter_trace.json', import.meta.url), 'utf8'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  try {
    return (await new ToncenterProvider({ url: 'https://x', apiKey: 'k' }).getTrace('00')) as TonTrace;
  } finally {
    globalThis.fetch = realFetch;
  }
}
