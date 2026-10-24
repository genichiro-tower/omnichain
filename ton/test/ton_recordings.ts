import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/**
 * Real mainnet replies, recorded by the live suite (`npm run test:live:ton`
 * with `TON_LIVE_RECORD=1`) and replayed by `ton_recorded.spec.ts`.
 *
 * A call stores the method, the full URL, the body and the reply — never the
 * headers, which is where the API keys travel.
 */
export const RECORDINGS_PATH = new URL('./fixtures/mainnet_recordings.json', import.meta.url);

export interface RecordedCall {
  method: string;
  url: string;
  body: string | null;
  status: number;
  response: string;
}

/** A provider method the live suite called directly, replayed through that provider alone. */
export type RecordedProviderMethod = 'getTrace' | 'emulate' | 'getSeqno' | 'getAccountState' | 'getJettonBalance' | 'getJettonWalletAddress' | 'sendBoc';

export interface RecordedScenario {
  description: string;
  /**
   * What the call was given: through `TonChain`, an external message BOC to
   * emulate or a hash to read; through one provider (`provider`), a method
   * and its arguments.
   */
  input: { boc?: string; hash?: string; provider?: 'TON Center' | 'TonAPI'; method?: RecordedProviderMethod; args?: string[] };
  calls: RecordedCall[];
  /** What the live run observed, asserted again on replay. */
  expect: {
    success?: boolean;
    status?: string;
    errorCode?: string | null;
    deliveryOutcomes?: string[];
    /** A provider method's result, as {@link describeResult} gives it. */
    result?: string;
    /** A provider method's error kind, when it threw. */
    errorKind?: string;
  };
}

/** A provider result as stable text: bigints and cells (by hash) spelled out. */
export function describeResult(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, v: unknown) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v !== null && typeof v === 'object' && typeof (v as { hash?: unknown }).hash === 'function' && 'bits' in (v as object)) {
      return `cell:${(v as { hash(): Buffer }).hash().toString('hex')}`;
    }
    return v;
  });
}

export interface Recordings {
  recordedAt: string;
  feePayer: string;
  scenarios: Record<string, RecordedScenario>;
}

export function readRecordings(): Recordings | null {
  return existsSync(RECORDINGS_PATH) ? (JSON.parse(readFileSync(RECORDINGS_PATH, 'utf8')) as Recordings) : null;
}

/** Writes `recordings`, keeping earlier scenarios this run did not record again (some, like a trace in flight, show up only sometimes). */
export function writeRecordings(recordings: Recordings): void {
  const earlier = readRecordings()?.scenarios ?? {};
  const merged = { ...recordings, scenarios: { ...earlier, ...recordings.scenarios } };
  writeFileSync(RECORDINGS_PATH, `${JSON.stringify(merged, null, 2)}\n`);
}

/** Wraps `fetch` to keep every call made until `take()`; the real request goes through unchanged. */
export class FetchRecorder {
  #calls: RecordedCall[] = [];
  readonly #realFetch = globalThis.fetch;

  install(): void {
    const real = this.#realFetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const response = await real(input, init);
      const text = await response.clone().text();
      this.#calls.push({
        method: init?.method ?? 'GET',
        url: String(input),
        body: typeof init?.body === 'string' ? init.body : null,
        status: response.status,
        response: text,
      });
      return response;
    }) as typeof fetch;
  }

  uninstall(): void {
    globalThis.fetch = this.#realFetch;
  }

  /** The calls since the last `take()`, then starts over. */
  take(): RecordedCall[] {
    const calls = this.#calls;
    this.#calls = [];
    return calls;
  }
}

/** A `fetch` that answers only from `calls`, matched on method, URL and body. */
export function replayFetch(calls: readonly RecordedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? init.body : null;
    const call = calls.find((c) => c.method === method && c.url === String(input) && c.body === body);
    if (call === undefined) throw new Error(`no recorded reply for ${method} ${String(input)}`);
    return new Response(call.response, { status: call.status });
  }) as typeof fetch;
}
