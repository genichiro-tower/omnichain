import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

import { ChainErrorKinds } from '../../errors.ts';
import {
  type TonProvider,
  TonFallbackProvider,
  TonProviderError,
  type TonTraceTransaction,
  tonHttpJson,
} from '../ton_provider.ts';
import { ToncenterProvider } from '../ton_toncenter.ts';
import { TonapiProvider } from '../ton_tonapi.ts';

const ENDPOINT = { url: 'https://provider.test', apiKey: 'key' };
const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

type FetchStub = jest.Mock<(url: string, init: RequestInit) => Promise<Response>>;

function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }): FetchStub {
  const mock: FetchStub = jest.fn(async (url: string, init: RequestInit) => {
    const { status, body } = handler(url, init);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('tonHttpJson', () => {
  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [403, false],
  ])('HTTP %i is retryable=%s', async (status, retryable) => {
    stubFetch(() => ({ status, body: { error: 'nope' } }));
    const err = await tonHttpJson('P', ENDPOINT, '/x', { headers: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TonProviderError);
    expect((err as TonProviderError).retryable).toBe(retryable);
  });

  it('reads a 404 as no answer', async () => {
    stubFetch(() => ({ status: 404, body: { error: 'entity not found' } }));
    await expect(tonHttpJson('P', ENDPOINT, '/x', { headers: {} })).resolves.toBeNull();
  });

  it('treats a transport failure as retryable', async () => {
    globalThis.fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const err = await tonHttpJson('P', ENDPOINT, '/x', { headers: {} }).catch((e: unknown) => e);
    expect((err as TonProviderError).retryable).toBe(true);
  });
});

describe('TonFallbackProvider', () => {
  const answer = (name: string, getMasterchainSeqno: () => Promise<number>): TonProvider =>
    ({ name, getMasterchainSeqno }) as unknown as TonProvider;

  it('uses the fallback only after a failure with no answer', async () => {
    const onFallback = jest.fn();
    const provider = new TonFallbackProvider(
      answer('primary', async () => {
        throw new TonProviderError(ChainErrorKinds.RpcError, 'HTTP 503', true);
      }),
      answer('fallback', async () => 7),
      onFallback,
    );
    await expect(provider.getMasterchainSeqno()).resolves.toBe(7);
    expect(onFallback).toHaveBeenCalledWith('getMasterchainSeqno', expect.any(TonProviderError));
  });

  it('never second-guesses a definite answer', async () => {
    const fallback = jest.fn(async () => 7);
    const provider = new TonFallbackProvider(
      answer('primary', async () => {
        throw new TonProviderError(ChainErrorKinds.SimulationFailed, 'refused', false);
      }),
      answer('fallback', fallback),
    );
    await expect(provider.getMasterchainSeqno()).rejects.toThrow('refused');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('has no fallback without one configured', async () => {
    const provider = new TonFallbackProvider(
      answer('primary', async () => {
        throw new TonProviderError(ChainErrorKinds.RpcError, 'HTTP 503', true);
      }),
      null,
    );
    await expect(provider.getMasterchainSeqno()).rejects.toThrow('HTTP 503');
  });
});

describe('trace normalization', () => {
  const TRACE_HASH = '50379a6ae50911e7e3b658ae96044411097992b6f9ca63c82c6b6c9f2de88d66';

  async function toncenterTrace(): Promise<TonTraceTransaction[]> {
    stubFetch(() => ({ status: 200, body: fixture('toncenter_trace.json') }));
    const trace = await new ToncenterProvider(ENDPOINT).getTrace(TRACE_HASH);
    expect(trace?.complete).toBe(true);
    return trace?.transactions ?? [];
  }

  async function tonapiTrace(): Promise<TonTraceTransaction[]> {
    stubFetch((url) =>
      url.includes('/v2/blockchain/blocks/')
        ? { status: 200, body: { master_ref: '(-1,8000000000000000,100472527)' } }
        : { status: 200, body: fixture('tonapi_trace.json') },
    );
    const trace = await new TonapiProvider(ENDPOINT).getTrace(TRACE_HASH);
    expect(trace?.complete).toBe(true);
    return trace?.transactions ?? [];
  }

  it('reads a W5 transfer from TON Center', async () => {
    const [root, child] = await toncenterTrace();
    expect(root.hash).toBe(TRACE_HASH);
    expect(root.inMsg?.source).toBeNull();
    expect(root.inMsg?.opcode).toBe(0x7369676e);
    expect(root.success).toBe(true);
    expect(root.outMsgs).toHaveLength(1);
    expect(root.outMsgs[0].value).toBe(3_794_400_000n);
    expect(child.inMsg?.value).toBe(3_794_400_000n);
    expect(child.account).toBe(root.outMsgs[0].destination);
    expect(root.mcSeqno).toBe(100472531);
  });

  it('normalizes the same trace identically from TonAPI', async () => {
    const strip = (txs: TonTraceTransaction[]): unknown =>
      txs.map(({ mcSeqno: _mc, inMsg, outMsgs, ...rest }) => ({
        ...rest,
        inMsg: inMsg === null ? null : { ...inMsg, body: inMsg.body?.hash().toString('hex') ?? null },
        outMsgs: outMsgs.map((m) => ({ ...m, body: m.body?.hash().toString('hex') ?? null })),
      }));
    const fromToncenter = await toncenterTrace();
    const fromTonapi = await tonapiTrace();
    expect(strip(fromTonapi)).toEqual(strip(fromToncenter));
    expect(fromTonapi[0].mcSeqno).toBe(100472527);
  });

  it('reads an unseen message as no trace', async () => {
    stubFetch(() => ({ status: 200, body: { traces: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getTrace(TRACE_HASH)).resolves.toBeNull();
    stubFetch(() => ({ status: 404, body: { error: 'entity not found' } }));
    await expect(new TonapiProvider(ENDPOINT).getTrace(TRACE_HASH)).resolves.toBeNull();
  });
});

describe('account reads', () => {
  it('reads a never-used address as nonexist on TON Center', async () => {
    stubFetch(() => ({ status: 200, body: { accounts: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getAccountState('0:' + 'ab'.repeat(32))).resolves.toEqual({
      status: 'nonexist',
      balance: 0n,
      codeHash: null,
    });
  });

  it('reads an undeployed jetton wallet as 0 on both providers', async () => {
    stubFetch(() => ({ status: 200, body: { gas_used: 0, exit_code: -13, stack: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getJettonBalance('0:' + 'ab'.repeat(32))).resolves.toBe(0n);
    stubFetch(() => ({ status: 404, body: { error: 'entity not found' } }));
    await expect(new TonapiProvider(ENDPOINT).getJettonBalance('0:' + 'ab'.repeat(32))).resolves.toBe(0n);
  });

  it('sends the key the way each provider expects', async () => {
    const toncenter = stubFetch(() => ({ status: 200, body: { last: { seqno: 1 } } }));
    await new ToncenterProvider(ENDPOINT).getMasterchainSeqno();
    expect((toncenter.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'X-API-Key': 'key' });
    const tonapi = stubFetch(() => ({ status: 200, body: { seqno: 1 } }));
    await new TonapiProvider(ENDPOINT).getMasterchainSeqno();
    expect((tonapi.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer key' });
  });
});
