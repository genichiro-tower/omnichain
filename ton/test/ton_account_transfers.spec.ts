import { readFileSync } from 'node:fs';

import { Address, beginCell } from '@ton/core';

import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { tonUserFriendlyAddress } from '../ton_address.ts';
import { type TonAccountTransfers, TonChain } from '../ton_chain.ts';
import {
  TON_JETTON_EXCESSES_OP,
  TON_JETTON_INTERNAL_TRANSFER_OP,
  TON_JETTON_TRANSFER_NOTIFICATION_OP,
  tonCommentBody,
  tonJettonTransferBody,
} from '../ton_messages.ts';
import type { TonAccountState, TonProvider, TonTrace, TonTraceMessage, TonTraceTransaction } from '../ton_provider.ts';
import { ToncenterProvider } from '../ton_toncenter.ts';
import { TonapiProvider } from '../ton_tonapi.ts';
import { JETTON_WALLET, OTHER, USDT_MASTER, bouncing, realTrace, settled, usdtJettonContent } from './ton_test_helpers.ts';

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
    stubFetch((url) => (url.includes('/transactions') ? { status: 200, body: { transactions: [{ lt: 111648649000011 }] } } : { status: 200, body: { status: 'active', balance: 1 } }));
    await expect(new TonapiProvider(ENDPOINT).getLastTransactionLt(FEE_PAYER)).resolves.toBe(111648649000011n);
    stubFetch((url) => {
      if (url.includes('/transactions')) return { status: 200, body: { transactions: [] } };
      if (url.includes('/v2/blockchain/accounts/')) return { status: 404, body: { error: 'entity not found' } };
      return { status: 200, body: { balance: 0, status: 'nonexist' } };
    });
    await expect(new TonapiProvider(ENDPOINT).getLastTransactionLt(NEVER_USED)).resolves.toBe(0n);
    // An account that does not exist but bounced a message: TonAPI's raw account states lt 0 (as on mainnet), its list has the transaction.
    stubFetch((url) => {
      if (url.includes('/transactions')) return { status: 200, body: { transactions: [{ lt: 112322303000014 }] } };
      if (url.includes('/v2/blockchain/accounts/')) return { status: 200, body: { balance: 0, last_transaction_lt: 0, status: 'nonexist' } };
      return { status: 200, body: { balance: 0, status: 'nonexist' } };
    });
    await expect(new TonapiProvider(ENDPOINT).getLastTransactionLt(NEVER_USED)).resolves.toBe(112322303000014n);
    stubFetch(() => ({ status: 200, body: { address_book: {} } }));
    await expect(new ToncenterProvider(ENDPOINT).getLastTransactionLt(FEE_PAYER)).rejects.toMatchObject({ retryable: true });
  });
});

function fakeProvider(overrides: Partial<TonProvider> = {}): TonProvider {
  return {
    name: 'fake',
    getAccountState: async (): Promise<TonAccountState> => ({ status: 'active', balance: 5n, codeHash: 'h' }),
    getSeqno: async () => 3,
    getPublicKey: async () => 0n,
    getJettonWalletAddress: async () => JETTON_WALLET,
    getJettonBalance: async () => 0n,
    sendBoc: async () => {},
    getTrace: async () => null,
    emulate: async () => ({ complete: true, transactions: [] }),
    getMasterchainHead: async () => ({ seqno: 100520170, utime: 1_700_000_000 }),
    getJettonContent: async () => usdtJettonContent(),
    getJettonWalletData: async () => null,
    getTraceByTransaction: async () => null,
    getAccountTransactions: async () => [],
    getLastTransactionLt: async () => 0n,
    ...overrides,
  };
}

const chainWith = (provider: TonProvider): TonChain =>
  new TonChain({ chainId: CHAIN_ID_TON_MAINNET, name: 'TON', explorerUrl: 'https://tonviewer.com', toncenter: { url: 'https://x' }, provider });

describe('account transfers', () => {
  it('reads both sides of a real relay: the fee payer sends and gets the rest back, the vault receives and sends it', async () => {
    stubFetch(() => ({ status: 200, body: fixture('toncenter_trace_by_tx.json') }));
    const trace = (await new ToncenterProvider(ENDPOINT).getTraceByTransaction(CHILD_TX)) as TonTrace;
    const chain = chainWith(fakeProvider({ getTraceByTransaction: async () => trace }));
    const [root, vaultTx, payback] = trace.transactions;
    const relay = root.outMsgs[0];
    const back = vaultTx.outMsgs[0];

    const feePayer = (await chain.getAccountTransfers({ account: FEE_PAYER, txHash: CHILD_TX })) as TonAccountTransfers;
    expect(feePayer.settled).toBe(true);
    expect(feePayer.transfers.map(({ direction, asset, from, to, amount, transaction, final, bounced }) => ({ direction, asset, from, to, amount, tx: transaction.hash, final, bounced }))).toEqual([
      { direction: 'SEND', asset: { kind: 'native' }, from: FEE_PAYER, to: vaultTx.account, amount: relay.value, tx: root.hash, final: true, bounced: false },
      { direction: 'RECEIVE', asset: { kind: 'native' }, from: vaultTx.account, to: FEE_PAYER, amount: back.value, tx: payback.hash, final: true, bounced: false },
    ]);

    const vault = (await chain.getAccountTransfers({ account: tonUserFriendlyAddress(vaultTx.account, { bounceable: false }), txHash: CHILD_TX })) as TonAccountTransfers;
    expect(vault.transfers.map(({ direction, amount }) => ({ direction, amount }))).toEqual([
      { direction: 'RECEIVE', amount: relay.value },
      { direction: 'SEND', amount: back.value },
    ]);
    await expect(chainWith(fakeProvider()).getAccountTransfers({ account: FEE_PAYER, txHash: CHILD_TX })).resolves.toBeNull();
  });

  it('reads a verified jetton transfer, with its comment, and not the TON riding along it', async () => {
    const [root] = (await realTrace()).transactions;
    const sender = root.account;
    const RECIPIENT = OTHER;
    const SENDER_JW = '0:' + '1a'.repeat(32);
    const RECIPIENT_JW = '0:' + '2b'.repeat(32);
    const transfer: TonTraceMessage = {
      ...root.outMsgs[0],
      destination: SENDER_JW,
      value: 50_000_000n,
      bounce: true,
      opcode: 0x0f8a7ea5,
      body: tonJettonTransferBody({ amount: 7_000_000n, destination: RECIPIENT, responseDestination: sender, forwardTonAmount: 1n, forwardPayload: tonCommentBody('order 42') }),
    };
    const internalTransfer: TonTraceMessage = {
      ...transfer,
      source: SENDER_JW,
      destination: RECIPIENT_JW,
      value: 40_000_000n,
      opcode: TON_JETTON_INTERNAL_TRANSFER_OP,
      createdLt: (transfer.createdLt as bigint) + 2n,
      body: beginCell().storeUint(TON_JETTON_INTERNAL_TRANSFER_OP, 32).storeUint(0, 64).storeCoins(7_000_000n).storeAddress(Address.parse(sender)).storeAddress(Address.parse(sender)).storeCoins(1n).storeBit(false).endCell(),
    };
    const notification: TonTraceMessage = { ...internalTransfer, source: RECIPIENT_JW, destination: RECIPIENT, value: 1n, bounce: false, opcode: TON_JETTON_TRANSFER_NOTIFICATION_OP, createdLt: (transfer.createdLt as bigint) + 4n, body: beginCell().storeUint(TON_JETTON_TRANSFER_NOTIFICATION_OP, 32).endCell() };
    const excesses: TonTraceMessage = { ...notification, destination: sender, value: 30_000_000n, opcode: TON_JETTON_EXCESSES_OP, createdLt: (transfer.createdLt as bigint) + 5n, body: beginCell().storeUint(TON_JETTON_EXCESSES_OP, 32).endCell() };
    const tx = (hash: string, parent: string, account: string, inMsg: TonTraceMessage, outMsgs: TonTraceMessage[] = []): TonTraceTransaction => ({ ...root, hash: hash.repeat(32), parent, account, inMsg, outMsgs, success: true, aborted: false });
    const senderJettonWallet = tx('c1', root.hash, SENDER_JW, transfer, [internalTransfer]);
    const recipientJettonWallet = tx('c2', senderJettonWallet.hash, RECIPIENT_JW, internalTransfer, [notification, excesses]);
    const trace: TonTrace = { complete: true, transactions: settled([{ ...root, outMsgs: [transfer] }, senderJettonWallet, recipientJettonWallet]) };
    const chain = chainWith(
      fakeProvider({
        getTraceByTransaction: async () => trace,
        getJettonWalletData: async (wallet: string) => (wallet === SENDER_JW ? { balance: 0n, owner: sender, jettonMaster: USDT_MASTER } : null),
        getJettonWalletAddress: async (_master: string, owner: string) => (owner === sender ? SENDER_JW : owner === RECIPIENT ? RECIPIENT_JW : JETTON_WALLET),
      }),
    );
    const jettonOf = (t: TonAccountTransfers) =>
      t.transfers.map(({ direction, asset, from, to, amount, comment, transaction }) => ({ direction, asset, from, to, amount, comment, tx: transaction.hash }));
    const expected = { asset: { kind: 'jetton', jettonMaster: USDT_MASTER }, from: sender, to: RECIPIENT, amount: 7_000_000n, comment: 'order 42', tx: recipientJettonWallet.hash };
    expect(jettonOf((await chain.getAccountTransfers({ account: RECIPIENT, txHash: 'ab'.repeat(32) })) as TonAccountTransfers)).toEqual([{ direction: 'RECEIVE', ...expected }]);
    // The sender's `transfer` message and the excesses coming back are part of the jetton transfer.
    expect(jettonOf((await chain.getAccountTransfers({ account: sender, txHash: 'ab'.repeat(32) })) as TonAccountTransfers)).toEqual([{ direction: 'SEND', ...expected }]);

    // A jetton wallet the master does not vouch for moves no jettons; the TON its messages carry is plain TON.
    const impostor = chainWith(fakeProvider({ getTraceByTransaction: async () => trace, getJettonWalletData: async () => ({ balance: 0n, owner: sender, jettonMaster: USDT_MASTER }) }));
    const native = (t: TonAccountTransfers | null) => t?.transfers.map(({ direction, asset, from, amount }) => ({ direction, kind: asset.kind, from, amount }));
    expect(native(await impostor.getAccountTransfers({ account: RECIPIENT, txHash: 'ab'.repeat(32) }))).toEqual([
      { direction: 'RECEIVE', kind: 'native', from: RECIPIENT_JW, amount: 1n },
    ]);
    expect(native(await impostor.getAccountTransfers({ account: sender, txHash: 'ab'.repeat(32) }))).toEqual([
      { direction: 'SEND', kind: 'native', from: sender, amount: 50_000_000n },
      { direction: 'RECEIVE', kind: 'native', from: RECIPIENT_JW, amount: 30_000_000n },
    ]);
  });

  it('reports TON sent with a jetton opcode to a contract that is no jetton wallet, as TON', async () => {
    const [root, child] = (await realTrace()).transactions;
    // 500 TON with a body that only looks like a jetton `transfer`: no jetton wallet takes it.
    const lookalike: TonTraceMessage = {
      ...root.outMsgs[0],
      value: 500_000_000_000n,
      opcode: 0x0f8a7ea5,
      body: tonJettonTransferBody({ amount: 1n, destination: OTHER, responseDestination: root.account }),
    };
    const trace: TonTrace = { complete: true, transactions: settled([{ ...root, outMsgs: [lookalike] }, { ...child, inMsg: lookalike }]) };
    const result = (await chainWith(fakeProvider({ getTraceByTransaction: async () => trace })).getAccountTransfers({ account: root.account, txHash: 'ab'.repeat(32) })) as TonAccountTransfers;
    expect(result.transfers.map(({ direction, asset, to, amount }) => ({ direction, asset, to, amount }))).toEqual([
      { direction: 'SEND', asset: { kind: 'native' }, to: child.account, amount: 500_000_000_000n },
    ]);
  });

  it('does not count a message its receiver sent back, and marks the bounce coming back', async () => {
    const [root, child] = (await realTrace()).transactions;
    const sent: TonTraceMessage = { ...root.outMsgs[0], bounce: true };
    const trace: TonTrace = { complete: true, transactions: settled([{ ...root, outMsgs: [sent] }, bouncing({ ...child, inMsg: sent })]) };
    const chain = chainWith(fakeProvider({ getTraceByTransaction: async () => trace }));
    const receiver = (await chain.getAccountTransfers({ account: child.account, txHash: 'ab'.repeat(32) })) as TonAccountTransfers;
    expect(receiver.transfers).toEqual([]);
    const sender = (await chain.getAccountTransfers({ account: root.account, txHash: 'ab'.repeat(32) })) as TonAccountTransfers;
    expect(sender.transfers.map(({ direction, bounced }) => ({ direction, bounced }))).toEqual([
      { direction: 'SEND', bounced: false },
      { direction: 'RECEIVE', bounced: true },
    ]);
  });

  it('marks a transfer final only once its transaction is, and the trace settled only when all are', async () => {
    const [root, child] = (await realTrace()).transactions;
    const second: TonTraceMessage = { ...root.outMsgs[0], createdLt: (root.outMsgs[0].createdLt as bigint) + 1n, value: 7n, body: tonCommentBody('hi') };
    const trace: TonTrace = { complete: true, transactions: settled([{ ...root, outMsgs: [root.outMsgs[0], second] }, { ...child, mcSeqno: null }]) };
    const result = (await chainWith(fakeProvider({ getTraceByTransaction: async () => trace })).getAccountTransfers({ account: root.account, txHash: 'ab'.repeat(32) })) as TonAccountTransfers;
    expect(result.settled).toBe(false);
    expect(result.transfers.map(({ index, final, comment }) => ({ index, final, comment }))).toEqual([
      // The recorded transfer's own comment, read from mainnet data.
      { index: 0, final: true, comment: '6fwZ2jecQsdpThG6HaDD7Q' },
      { index: 1, final: true, comment: 'hi' },
    ]);
    const receiver = (await chainWith(fakeProvider({ getTraceByTransaction: async () => trace })).getAccountTransfers({ account: child.account, txHash: 'ab'.repeat(32) })) as TonAccountTransfers;
    // Both messages reach the same account: the receipt in the transaction not yet final is not final; the other is.
    expect(receiver.transfers.map(({ amount, final }) => ({ amount, final }))).toEqual([
      { amount: root.outMsgs[0].value, final: false },
      { amount: 7n, final: true },
    ]);
  });
});

describe('account transfers read before and after a jetton transfer completes', () => {
  it('keeps every final transfer and its index; a jetton-shaped message is final only on a complete trace', async () => {
    const [root] = (await realTrace()).transactions;
    const sender = root.account;
    const SENDER_JW = '0:' + '1a'.repeat(32);
    const RECIPIENT_JW = '0:' + '2b'.repeat(32);
    const lt = root.outMsgs[0].createdLt as bigint;
    const transfer: TonTraceMessage = {
      ...root.outMsgs[0],
      destination: SENDER_JW,
      value: 50_000_000n,
      bounce: true,
      opcode: 0x0f8a7ea5,
      createdLt: lt,
      body: tonJettonTransferBody({ amount: 5n, destination: OTHER, responseDestination: sender, forwardTonAmount: 0n }),
    };
    const payment: TonTraceMessage = { ...root.outMsgs[0], value: 1_000_000_000n, createdLt: lt + 1n, body: tonCommentBody('rent') };
    const internalTransfer: TonTraceMessage = {
      ...transfer,
      source: SENDER_JW,
      destination: RECIPIENT_JW,
      value: 40_000_000n,
      opcode: TON_JETTON_INTERNAL_TRANSFER_OP,
      createdLt: lt + 3n,
      body: beginCell().storeUint(TON_JETTON_INTERNAL_TRANSFER_OP, 32).storeUint(0, 64).storeCoins(5n).storeAddress(Address.parse(sender)).storeAddress(Address.parse(sender)).storeCoins(0n).storeBit(false).endCell(),
    };
    const tx = (hash: string, parent: string, account: string, inMsg: TonTraceMessage, outMsgs: TonTraceMessage[] = []): TonTraceTransaction => ({ ...root, hash: hash.repeat(32), parent, account, inMsg, outMsgs, success: true, aborted: false });
    // Listed in the reverse of creation order, as a provider may.
    const owner = { ...root, outMsgs: [payment, transfer] };
    const senderJettonWallet = tx('c1', root.hash, SENDER_JW, transfer, [internalTransfer]);
    const paid = tx('c3', root.hash, root.outMsgs[0].destination as string, payment);
    const recipientJettonWallet = tx('c2', senderJettonWallet.hash, RECIPIENT_JW, internalTransfer);
    const provider = (trace: TonTrace) =>
      fakeProvider({
        getTraceByTransaction: async () => trace,
        getJettonWalletData: async (wallet: string) => (wallet === SENDER_JW ? { balance: 0n, owner: sender, jettonMaster: USDT_MASTER } : null),
        getJettonWalletAddress: async (_master: string, who: string) => (who === sender ? SENDER_JW : who === OTHER ? RECIPIENT_JW : JETTON_WALLET),
      });
    const view = (t: TonAccountTransfers) =>
      t.transfers.map(({ direction, asset, amount, index, final, transaction }) => ({ direction, kind: asset.kind, amount, index, final, tx: transaction.hash }));

    // Before: the receiving jetton wallet has not run yet.
    const before = (await chainWith(provider({ complete: false, transactions: [owner, senderJettonWallet, paid] })).getAccountTransfers({ account: sender, txHash: 'ab'.repeat(32) })) as TonAccountTransfers;
    expect(view(before)).toEqual([
      { direction: 'SEND', kind: 'native', amount: 50_000_000n, index: 0, final: false, tx: root.hash },
      { direction: 'SEND', kind: 'native', amount: 1_000_000_000n, index: 1, final: true, tx: root.hash },
    ]);
    // After: the jettons landed; the transfer message is the jetton transfer's, and the payment keeps its index.
    const after = (await chainWith(provider({ complete: true, transactions: [owner, senderJettonWallet, paid, recipientJettonWallet] })).getAccountTransfers({ account: sender, txHash: 'ab'.repeat(32) })) as TonAccountTransfers;
    expect(view(after)).toEqual([
      { direction: 'SEND', kind: 'native', amount: 1_000_000_000n, index: 1, final: true, tx: root.hash },
      { direction: 'SEND', kind: 'jetton', amount: 5n, index: 0, final: true, tx: recipientJettonWallet.hash },
    ]);
    // Every transfer final before is unchanged after.
    const finalBefore = view(before).filter((t) => t.final);
    expect(view(after)).toEqual(expect.arrayContaining(finalBefore));
  });
});
