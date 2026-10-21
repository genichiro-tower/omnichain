import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

import { ChainErrorKinds } from '../../errors.ts';
import {
  TonBroadcastUncertainError,
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
  const answer = (name: string, getMasterchainHead: () => Promise<unknown>): TonProvider =>
    ({ name, getMasterchainHead }) as unknown as TonProvider;

  it('uses the fallback only after a failure with no answer', async () => {
    const onFallback = jest.fn();
    const provider = new TonFallbackProvider(
      answer('primary', async () => {
        throw new TonProviderError(ChainErrorKinds.RpcError, 'HTTP 503', true);
      }),
      answer('fallback', async () => 7),
      onFallback,
    );
    await expect(provider.getMasterchainHead()).resolves.toBe(7);
    expect(onFallback).toHaveBeenCalledWith('getMasterchainHead', expect.any(TonProviderError));
  });

  it('never second-guesses a definite answer', async () => {
    const fallback = jest.fn(async () => 7);
    const provider = new TonFallbackProvider(
      answer('primary', async () => {
        throw new TonProviderError(ChainErrorKinds.SimulationFailed, 'refused', false);
      }),
      answer('fallback', fallback),
    );
    await expect(provider.getMasterchainHead()).rejects.toThrow('refused');
    expect(fallback).not.toHaveBeenCalled();
  });

  it('has no fallback without one configured', async () => {
    const provider = new TonFallbackProvider(
      answer('primary', async () => {
        throw new TonProviderError(ChainErrorKinds.RpcError, 'HTTP 503', true);
      }),
      null,
    );
    await expect(provider.getMasterchainHead()).rejects.toThrow('HTTP 503');
  });

  describe('sendBoc', () => {
    const unavailable = (): TonProviderError => new TonProviderError(ChainErrorKinds.RpcError, 'HTTP 503', true);
    const refused = (): TonProviderError => new TonProviderError(ChainErrorKinds.BroadcastRejected, 'refused', false);
    const sender = (name: string, sendBoc: () => Promise<void>): TonProvider => ({ name, sendBoc }) as unknown as TonProvider;

    it('keeps a refusal with no failure before it definite', async () => {
      const fallback = jest.fn(async () => {});
      const provider = new TonFallbackProvider(sender('primary', async () => { throw refused(); }), sender('fallback', fallback));
      const err = await provider.sendBoc('boc').catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(TonBroadcastUncertainError);
      expect((err as TonProviderError).kind).toBe(ChainErrorKinds.BroadcastRejected);
      expect(fallback).not.toHaveBeenCalled();
    });

    it('sends through the fallback when the primary failed without an answer', async () => {
      const fallback = jest.fn(async () => {});
      const provider = new TonFallbackProvider(sender('primary', async () => { throw unavailable(); }), sender('fallback', fallback));
      await expect(provider.sendBoc('boc')).resolves.toBeUndefined();
      expect(fallback).toHaveBeenCalledWith('boc');
    });

    it('reads a refusal after a failure without an answer as uncertain', async () => {
      const provider = new TonFallbackProvider(
        sender('primary', async () => { throw unavailable(); }),
        sender('fallback', async () => { throw refused(); }),
      );
      const err = await provider.sendBoc('boc').catch((e: unknown) => e);
      expect(err).toBeInstanceOf(TonBroadcastUncertainError);
      expect(err).toMatchObject({ kind: ChainErrorKinds.BroadcastUncertain, retryable: false });
    });

    it('reads a failure without an answer and no fallback as uncertain', async () => {
      const provider = new TonFallbackProvider(sender('primary', async () => { throw unavailable(); }), null);
      await expect(provider.sendBoc('boc')).rejects.toBeInstanceOf(TonBroadcastUncertainError);
    });
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

  it('fails a transaction whose action phase skipped a message, on both providers', async () => {
    const toncenter = fixture('toncenter_trace.json') as { traces: Array<{ trace: { tx_hash: string }; transactions: Record<string, { description: { action: Record<string, unknown> } }> }> };
    const root = toncenter.traces[0].transactions[toncenter.traces[0].trace.tx_hash];
    root.description.action = { ...root.description.action, success: true, skipped_actions: 1, msgs_created: 0 };
    stubFetch(() => ({ status: 200, body: toncenter }));
    const fromToncenter = await new ToncenterProvider(ENDPOINT).getTrace(TRACE_HASH);
    expect(fromToncenter?.transactions[0]).toMatchObject({ success: false, skippedActions: 1 });

    const tonapi = fixture('tonapi_trace.json') as { transaction: { action_phase: Record<string, unknown> } };
    tonapi.transaction.action_phase = { ...tonapi.transaction.action_phase, success: true, skipped_actions: 1 };
    stubFetch((url) =>
      url.includes('/v2/blockchain/blocks/')
        ? { status: 200, body: { master_ref: '(-1,8000000000000000,100472527)' } }
        : { status: 200, body: tonapi },
    );
    const fromTonapi = await new TonapiProvider(ENDPOINT).getTrace(TRACE_HASH);
    expect(fromTonapi?.transactions[0]).toMatchObject({ success: false, skippedActions: 1 });
  });

  type ToncenterTraceFixture = {
    traces: Array<{ trace: { tx_hash: string; children: Array<{ tx_hash: string }> }; transactions: Record<string, { in_msg: Record<string, unknown> }> }>;
  };

  it('refuses a trace whose receiver disagrees with its sender, and the fallback answers', async () => {
    const toncenter = fixture('toncenter_trace.json') as ToncenterTraceFixture;
    const childHash = toncenter.traces[0].trace.children[0].tx_hash;
    const child = toncenter.traces[0].transactions[childHash];
    child.in_msg = { ...child.in_msg, value: '1' };
    stubFetch(() => ({ status: 200, body: toncenter }));
    const err = await new ToncenterProvider(ENDPOINT).getTrace(TRACE_HASH).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TonProviderError);
    expect((err as TonProviderError).retryable).toBe(true);
    expect((err as Error).message).toContain('inconsistent trace');

    stubFetch((url) => {
      if (url.startsWith('https://toncenter.test')) return { status: 200, body: toncenter };
      if (url.includes('/v2/blockchain/blocks/')) return { status: 200, body: { master_ref: '(-1,8000000000000000,100472527)' } };
      return { status: 200, body: fixture('tonapi_trace.json') };
    });
    const onFallback = jest.fn();
    const provider = new TonFallbackProvider(
      new ToncenterProvider({ url: 'https://toncenter.test', apiKey: 'key' }),
      new TonapiProvider(ENDPOINT),
      onFallback,
    );
    const trace = await provider.getTrace(TRACE_HASH);
    expect(trace?.transactions).toHaveLength(2);
    expect(onFallback).toHaveBeenCalledWith('getTrace', expect.any(TonProviderError));
  });

  it('reads a running TON Center trace with a transaction not yet in it as incomplete, keeping its children under it', async () => {
    const toncenter = fixture('toncenter_trace.json') as ToncenterTraceFixture & { traces: Array<{ trace_info: Record<string, unknown> }> };
    delete toncenter.traces[0].transactions[toncenter.traces[0].trace.tx_hash];
    toncenter.traces[0].trace_info = { ...toncenter.traces[0].trace_info, trace_state: 'pending' };
    stubFetch(() => ({ status: 200, body: toncenter }));
    const trace = await new ToncenterProvider(ENDPOINT).getTrace(TRACE_HASH);
    expect(trace?.complete).toBe(false);
    expect(trace?.transactions).toHaveLength(1);
    expect(trace?.transactions[0].parent).toBe(TRACE_HASH);
  });

  it('asks TonAPI when a finished TON Center trace left a transaction out', async () => {
    const toncenter = fixture('toncenter_trace.json') as ToncenterTraceFixture;
    delete toncenter.traces[0].transactions[toncenter.traces[0].trace.tx_hash];
    stubFetch(() => ({ status: 200, body: toncenter }));
    await expect(new ToncenterProvider(ENDPOINT).getTrace(TRACE_HASH)).rejects.toMatchObject({ retryable: true });

    stubFetch((url) => {
      if (url.startsWith('https://toncenter.test')) return { status: 200, body: toncenter };
      if (url.includes('/v2/blockchain/blocks/')) return { status: 200, body: { master_ref: '(-1,8000000000000000,100472527)' } };
      return { status: 200, body: fixture('tonapi_trace.json') };
    });
    const provider = new TonFallbackProvider(new ToncenterProvider({ url: 'https://toncenter.test', apiKey: 'key' }), new TonapiProvider(ENDPOINT));
    const trace = await provider.getTrace(TRACE_HASH);
    expect(trace).toMatchObject({ complete: true });
    expect(trace?.transactions).toHaveLength(2);
  });

  it("reads TonAPI's prediction for a message in flight as no trace, and a predicted hop as incomplete", async () => {
    const masterRef = { status: 200, body: { master_ref: '(-1,8000000000000000,100472527)' } };
    const predicted = { ...(fixture('tonapi_trace.json') as Record<string, unknown>), emulated: true };
    stubFetch((url) => (url.includes('/v2/blockchain/blocks/') ? masterRef : { status: 200, body: predicted }));
    await expect(new TonapiProvider(ENDPOINT).getTrace(TRACE_HASH)).resolves.toBeNull();

    const partly = fixture('tonapi_trace.json') as { children: Array<Record<string, unknown>> };
    partly.children[0].emulated = true;
    stubFetch((url) => (url.includes('/v2/blockchain/blocks/') ? masterRef : { status: 200, body: partly }));
    const trace = await new TonapiProvider(ENDPOINT).getTrace(TRACE_HASH);
    expect(trace?.complete).toBe(false);
    expect(trace?.transactions.map((tx) => tx.hash)).toEqual([TRACE_HASH]);
  });

  it('reads an unseen message as no trace', async () => {
    stubFetch(() => ({ status: 200, body: { traces: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getTrace(TRACE_HASH)).resolves.toBeNull();
    stubFetch(() => ({ status: 404, body: { error: 'entity not found' } }));
    await expect(new TonapiProvider(ENDPOINT).getTrace(TRACE_HASH)).resolves.toBeNull();
  });
});

describe('broadcast', () => {
  const REFUSAL = 'cannot apply external message to current state : inbound external message rejected by transaction 420B98...: exitcode=33';

  it('reads the lite server refusing a message as definite on both providers', async () => {
    stubFetch(() => ({ status: 500, body: { error: `LITE_SERVER_UNKNOWN: ${REFUSAL}`, code: 500 } }));
    const fromToncenter = await new ToncenterProvider(ENDPOINT).sendBoc('boc').catch((e: unknown) => e);
    expect(fromToncenter).toMatchObject({ kind: ChainErrorKinds.BroadcastRejected, retryable: false });
    stubFetch(() => ({ status: 406, body: { error: `lite server error, code -701: ${REFUSAL}` } }));
    const fromTonapi = await new TonapiProvider(ENDPOINT).sendBoc('boc').catch((e: unknown) => e);
    expect(fromTonapi).toMatchObject({ kind: ChainErrorKinds.BroadcastRejected, retryable: false });
  });

  it("reads W5's seqno refusal as NonceTooLow: the message, or another with its seqno, landed", async () => {
    const refusal = (exitCode: number): string =>
      `LITE_SERVER_UNKNOWN: cannot apply external message to current state : External message was not accepted\nCannot run message on account: inbound external message rejected by transaction 420B98...:\nexitcode=${exitCode}, steps=49, gas_used=0`;
    stubFetch(() => ({ status: 500, body: { error: refusal(133), code: 500 } }));
    await expect(new ToncenterProvider(ENDPOINT).sendBoc('boc')).rejects.toMatchObject({ kind: ChainErrorKinds.NonceTooLow, retryable: false });
    stubFetch(() => ({ status: 406, body: { error: `lite server error, code -701: ${refusal(133)}` } }));
    await expect(new TonapiProvider(ENDPOINT).sendBoc('boc')).rejects.toMatchObject({ kind: ChainErrorKinds.NonceTooLow, retryable: false });
    // Expiry is checked after the seqno: the seqno still matched, so the message never landed.
    stubFetch(() => ({ status: 500, body: { error: refusal(136), code: 500 } }));
    await expect(new ToncenterProvider(ENDPOINT).sendBoc('boc')).rejects.toMatchObject({ kind: ChainErrorKinds.BroadcastRejected });
  });

  it('reads the lite server already having the message as sent', async () => {
    stubFetch(() => ({ status: 500, body: { error: 'lite server error, code 0: cannot send external message : duplicate message' } }));
    await expect(new TonapiProvider(ENDPOINT).sendBoc('boc')).resolves.toBeUndefined();
  });

  it('keeps any other 5xx retryable', async () => {
    stubFetch(() => ({ status: 503, body: { error: 'overloaded' } }));
    await expect(new ToncenterProvider(ENDPOINT).sendBoc('boc')).rejects.toMatchObject({ kind: ChainErrorKinds.RpcError, retryable: true });
  });
});

describe('reads a failure as a failure, never as 0', () => {
  it('refuses a masterchain head without its time', async () => {
    stubFetch(() => ({ status: 200, body: { last: { seqno: 1 } } }));
    await expect(new ToncenterProvider(ENDPOINT).getMasterchainHead()).rejects.toMatchObject({ retryable: true });
    stubFetch(() => ({ status: 200, body: { seqno: 1 } }));
    await expect(new TonapiProvider(ENDPOINT).getMasterchainHead()).rejects.toMatchObject({ retryable: true });
  });

  it("refuses a deployed wallet's seqno it could not read", async () => {
    stubFetch(() => ({ status: 200, body: { gas_used: 0, exit_code: -13, stack: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getSeqno('0:' + 'ab'.repeat(32))).rejects.toMatchObject({ retryable: true });
    stubFetch(() => ({ status: 404, body: { error: 'entity not found' } }));
    await expect(new TonapiProvider(ENDPOINT).getSeqno('0:' + 'ab'.repeat(32))).rejects.toMatchObject({ retryable: true });
    stubFetch(() => ({ status: 200, body: {} }));
    await expect(new TonapiProvider(ENDPOINT).getSeqno('0:' + 'ab'.repeat(32))).rejects.toMatchObject({ retryable: true });
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
    const toncenter = stubFetch(() => ({ status: 200, body: { last: { seqno: 1, gen_utime: 1700000000 } } }));
    await new ToncenterProvider(ENDPOINT).getMasterchainHead();
    expect((toncenter.mock.calls[0][1] as RequestInit).headers).toMatchObject({ 'X-API-Key': 'key' });
    const tonapi = stubFetch(() => ({ status: 200, body: { seqno: 1, gen_utime: 1700000000 } }));
    await new TonapiProvider(ENDPOINT).getMasterchainHead();
    expect((tonapi.mock.calls[0][1] as RequestInit).headers).toMatchObject({ authorization: 'Bearer key' });
  });
});
