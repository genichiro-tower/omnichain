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

export interface RecordedScenario {
  description: string;
  /** What the SDK call was given: an external message BOC to emulate, or a hash to read. */
  input: { boc?: string; hash?: string };
  calls: RecordedCall[];
  /** What the live run observed, asserted again on replay. */
  expect: {
    success?: boolean;
    status?: string;
    errorCode?: string | null;
    deliveryOutcomes?: string[];
  };
}

export interface Recordings {
  recordedAt: string;
  feePayer: string;
  scenarios: Record<string, RecordedScenario>;
}

export function readRecordings(): Recordings | null {
  return existsSync(RECORDINGS_PATH) ? (JSON.parse(readFileSync(RECORDINGS_PATH, 'utf8')) as Recordings) : null;
}

export function writeRecordings(recordings: Recordings): void {
  writeFileSync(RECORDINGS_PATH, `${JSON.stringify(recordings, null, 2)}\n`);
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
