import { readFileSync } from 'node:fs';

import { ChainErrorKinds } from '../../errors.ts';
import type { TonTrace } from '../ton_provider.ts';
import { ToncenterProvider } from '../ton_toncenter.ts';
import { TonapiProvider } from '../ton_tonapi.ts';

const ENDPOINT = { url: 'https://provider.test', apiKey: 'key' };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => { status: number; body: unknown }): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(url);
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return urls;
}

const MASTER_REF = { status: 200, body: { master_ref: '(-1,8000000000000000,100520160)' } };
const tonapiWith = (body: unknown) => (url: string) => (url.includes('/v2/blockchain/blocks/') ? MASTER_REF : { status: 200, body });

// A relay of ours on mainnet: the fee payer's transaction (root), the vault's (its child) and the vault's payout back.
const ROOT_TX = 'a4c3cf2b78df72d981d1cda4eeaea0b3782fb660eedd1528506963ff3382d46f';
const CHILD_TX = '6d77e813c7d6a847185f1c5c3f4d37171c90780ec9448f1aa45b7db45bcdb533';
const FEE_PAYER = '0:420b9825072820d744b071765d6384ac77a36008d726d2a64bad0695c38b0fb1';
const NEVER_USED = '0:' + 'ab'.repeat(32);

/** A trace without what legitimately differs between providers: the masterchain block and body cell identity. */
function comparable(trace: TonTrace | null): unknown {
  return trace?.transactions.map(({ mcSeqno: _mc, inMsg, outMsgs, ...rest }) => ({
    ...rest,
    inMsg: inMsg === null ? null : { ...inMsg, body: inMsg.body?.hash().toString('hex') ?? null },
    outMsgs: outMsgs.map((m) => ({ ...m, body: m.body?.hash().toString('hex') ?? null })),
  }));
}

describe('trace by transaction', () => {
  it('finds the whole trace from a transaction in its middle, alike on both providers', async () => {
    const urls = stubFetch(() => ({ status: 200, body: fixture('toncenter_trace_by_tx.json') }));
    const fromToncenter = await new ToncenterProvider(ENDPOINT).getTraceByTransaction(CHILD_TX);
    expect(urls[0]).toContain('/api/v3/traces?tx_hash=');
    stubFetch(tonapiWith(fixture('tonapi_trace_by_tx.json')));
    const fromTonapi = await new TonapiProvider(ENDPOINT).getTraceByTransaction(CHILD_TX);
    expect(fromToncenter?.transactions[0].hash).toBe(ROOT_TX);
    expect(fromToncenter?.transactions.map((tx) => tx.hash)).toContain(CHILD_TX);
    expect(fromToncenter?.complete).toBe(true);
    expect(comparable(fromTonapi)).toEqual(comparable(fromToncenter));
  });

  it('refuses, retryably, a trace that does not hold the transaction', async () => {
    const other = 'cd'.repeat(32);
    stubFetch(() => ({ status: 200, body: fixture('toncenter_trace_by_tx.json') }));
    await expect(new ToncenterProvider(ENDPOINT).getTraceByTransaction(other)).rejects.toMatchObject({
      retryable: true,
      message: expect.stringContaining('does not hold transaction'),
    });
    stubFetch(tonapiWith(fixture('tonapi_trace_by_tx.json')));
    await expect(new TonapiProvider(ENDPOINT).getTraceByTransaction(other)).rejects.toMatchObject({ retryable: true });
  });

  it('reads no trace only from the explicit answers, and refuses a malformed hash', async () => {
    stubFetch(() => ({ status: 200, body: { traces: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getTraceByTransaction(CHILD_TX)).resolves.toBeNull();
    stubFetch(() => ({ status: 404, body: { error: 'entity not found' } }));
    await expect(new TonapiProvider(ENDPOINT).getTraceByTransaction(CHILD_TX)).resolves.toBeNull();
    stubFetch(() => ({ status: 404, body: { error: 'not found' } }));
    await expect(new ToncenterProvider(ENDPOINT).getTraceByTransaction(CHILD_TX)).rejects.toMatchObject({ retryable: true });
    await expect(new ToncenterProvider(ENDPOINT).getTraceByTransaction(CHILD_TX.toUpperCase())).rejects.toMatchObject({
      kind: ChainErrorKinds.InvalidArgument,
    });
  });

  it("reads TonAPI's emulation of a message in flight as no trace", async () => {
    stubFetch(tonapiWith({ ...(fixture('tonapi_trace_by_tx.json') as Record<string, unknown>), emulated: true }));
    await expect(new TonapiProvider(ENDPOINT).getTraceByTransaction(CHILD_TX)).resolves.toBeNull();
  });
});

describe('account transactions after a cursor', () => {
  it('lists the same transactions after an lt on both providers, oldest first', async () => {
    const afterLt = 111500696000001n;
    const tcUrls = stubFetch(() => ({ status: 200, body: fixture('toncenter_account_transactions.json') }));
    const fromToncenter = await new ToncenterProvider(ENDPOINT).getAccountTransactions(FEE_PAYER, { afterLt, limit: 3 });
    // TON Center's start_lt is inclusive: one above the cursor.
    expect(tcUrls[0]).toContain('start_lt=111500696000002');
    const taUrls = stubFetch(tonapiWith(fixture('tonapi_account_transactions.json')));
    const fromTonapi = await new TonapiProvider(ENDPOINT).getAccountTransactions(FEE_PAYER, { afterLt, limit: 3 });
    expect(taUrls[0]).toContain('after_lt=111500696000001');
    const strip = (txs: Array<{ hash: string; lt: bigint; utime: number }>) => txs.map(({ hash, lt, utime }) => ({ hash, lt, utime }));
    expect(strip(fromTonapi)).toEqual(strip(fromToncenter));
    expect(fromToncenter.map((tx) => tx.lt)).toEqual([111500696000005n, 111500782000001n, 111500782000005n]);
    expect(fromToncenter.every((tx) => tx.mcSeqno !== null && /^[0-9a-f]{64}$/.test(tx.hash))).toBe(true);
  });

  it('lists nothing for a never-used account only when the provider says it never existed', async () => {
    stubFetch(() => ({ status: 200, body: { transactions: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getAccountTransactions(NEVER_USED, { afterLt: 0n, limit: 10 })).resolves.toEqual([]);
    stubFetch((url) => (url.includes('/transactions') ? { status: 404, body: { error: 'entity not found' } } : { status: 200, body: { balance: 0, status: 'nonexist' } }));
    await expect(new TonapiProvider(ENDPOINT).getAccountTransactions(NEVER_USED, { afterLt: 0n, limit: 10 })).resolves.toEqual([]);
    stubFetch((url) => (url.includes('/transactions') ? { status: 404, body: { error: 'entity not found' } } : { status: 200, body: { balance: 5, status: 'active' } }));
    await expect(new TonapiProvider(ENDPOINT).getAccountTransactions(FEE_PAYER, { afterLt: 0n, limit: 10 })).rejects.toMatchObject({ retryable: true });
  });

  it('refuses a page size outside 1 to 100 and a negative cursor', async () => {
    const provider = new ToncenterProvider(ENDPOINT);
    await expect(provider.getAccountTransactions(FEE_PAYER, { afterLt: 0n, limit: 0 })).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidArgument });
    await expect(provider.getAccountTransactions(FEE_PAYER, { afterLt: 0n, limit: 101 })).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidArgument });
    await expect(provider.getAccountTransactions(FEE_PAYER, { afterLt: -1n, limit: 1 })).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidArgument });
  });
});

describe('last transaction lt', () => {
  it('reads it on both providers, and 0 for a never-used account as the provider states it', async () => {
    stubFetch(() => ({ status: 200, body: { accounts: [{ last_transaction_lt: '111648649000011', balance: '1', status: 'active' }] } }));
    await expect(new ToncenterProvider(ENDPOINT).getLastTransactionLt(FEE_PAYER)).resolves.toBe(111648649000011n);
    stubFetch(() => ({ status: 200, body: { accounts: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getLastTransactionLt(NEVER_USED)).resolves.toBe(0n);
    stubFetch(() => ({ status: 200, body: { last_transaction_lt: '111648649000011', status: 'active', balance: '1' } }));
    await expect(new TonapiProvider(ENDPOINT).getLastTransactionLt(FEE_PAYER)).resolves.toBe(111648649000011n);
    stubFetch((url) => (url.includes('/v2/blockchain/accounts/') ? { status: 404, body: { error: 'entity not found' } } : { status: 200, body: { balance: 0, status: 'nonexist' } }));
    await expect(new TonapiProvider(ENDPOINT).getLastTransactionLt(NEVER_USED)).resolves.toBe(0n);
    stubFetch(() => ({ status: 200, body: { address_book: {} } }));
    await expect(new ToncenterProvider(ENDPOINT).getLastTransactionLt(FEE_PAYER)).rejects.toMatchObject({ retryable: true });
  });
});
