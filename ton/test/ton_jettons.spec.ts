import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';
import { Decimal } from 'decimal.js';
import { Address, Cell, Dictionary, SendMode, beginCell } from '@ton/core';
import { createHash } from 'node:crypto';

import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { assetHashOf } from '../../transaction_status.ts';
import { tonUserFriendlyAddress } from '../ton_address.ts';
import { TON_USDT } from '../ton_assets.ts';
import { TonChain } from '../ton_chain.ts';
import { type TonMetadataFetcher, parseTonJettonContent, readTonJettonMetadata } from '../ton_jetton_metadata.ts';
import { TON_JETTON_INTERNAL_TRANSFER_OP, tonJettonTransferBody } from '../ton_messages.ts';
import type { TonAccountState, TonProvider, TonTrace, TonTraceMessage, TonTraceTransaction } from '../ton_provider.ts';
import { ToncenterProvider } from '../ton_toncenter.ts';
import { TonapiProvider } from '../ton_tonapi.ts';
import { TonWallet } from '../ton_wallet.ts';
import { JETTON_WALLET, MNEMONIC, OTHER, USDT_MASTER, realTrace, settled, usdtJettonContent, usdtOffchainMetadata } from './ton_test_helpers.ts';

const ENDPOINT = { url: 'https://provider.test', apiKey: 'key' };
const fixture = (name: string): unknown => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string) => { status: number; body: unknown }): void {
  globalThis.fetch = (async (url: string) => {
    const { status, body } = handler(url);
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

/** On-chain TEP-64 content with the given snake fields. */
function onchainContent(fields: Record<string, string>): Cell {
  const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
  for (const [key, value] of Object.entries(fields)) {
    dict.set(createHash('sha256').update(key).digest(), beginCell().storeUint(0, 8).storeStringTail(value).endCell());
  }
  return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

const failingFetch: TonMetadataFetcher = async () => {
  throw new Error('down');
};

describe('jetton metadata (TEP-64)', () => {
  it("reads USDT's real content: decimals on chain, the symbol from its off-chain JSON", async () => {
    const parsed = parseTonJettonContent(usdtJettonContent());
    expect(parsed).toEqual({ fields: { uri: 'https://tether.to/usdt-ton.json', decimals: '6' }, uri: 'https://tether.to/usdt-ton.json' });
    const fetchJson = jest.fn(async () => usdtOffchainMetadata());
    await expect(readTonJettonMetadata(usdtJettonContent(), fetchJson)).resolves.toMatchObject({
      symbol: 'USD₮',
      name: 'Tether USD',
      decimals: 6,
      uri: 'https://tether.to/usdt-ton.json',
    });
    expect(fetchJson).toHaveBeenCalledWith('https://tether.to/usdt-ton.json');
  });

  it('keeps the on-chain decimals when the off-chain JSON does not load, without a symbol', async () => {
    await expect(readTonJettonMetadata(usdtJettonContent(), failingFetch)).resolves.toMatchObject({ symbol: null, decimals: 6 });
  });

  it('never guesses decimals: none on chain and the JSON did not load is an error', async () => {
    const content = onchainContent({ uri: 'https://example.test/m.json', symbol: 'X' });
    await expect(readTonJettonMetadata(content, failingFetch)).rejects.toMatchObject({ retryable: true, message: expect.stringContaining('decimals') });
  });

  it("uses TEP-64's default of 9 when the metadata, fully read, names no decimals", async () => {
    await expect(readTonJettonMetadata(onchainContent({ symbol: 'ABC' }), failingFetch)).resolves.toMatchObject({ symbol: 'ABC', decimals: 9 });
    const content = onchainContent({ uri: 'https://example.test/m.json' });
    await expect(readTonJettonMetadata(content, async () => ({ symbol: 'DEF' }))).resolves.toMatchObject({ symbol: 'DEF', decimals: 9 });
  });

  it('reads off-chain content (a URI after the prefix) and chunked on-chain values', async () => {
    const offchain = beginCell().storeUint(1, 8).storeStringTail('https://example.test/j.json').endCell();
    await expect(readTonJettonMetadata(offchain, async () => ({ symbol: 'J', decimals: '3' }))).resolves.toMatchObject({ symbol: 'J', decimals: 3 });

    const chunks = Dictionary.empty(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
    chunks.set(0, beginCell().storeStringTail('US').endCell());
    chunks.set(1, beginCell().storeStringTail('DX').endCell());
    const dict = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    dict.set(createHash('sha256').update('symbol').digest(), beginCell().storeUint(1, 8).storeDict(chunks).endCell());
    dict.set(createHash('sha256').update('decimals').digest(), beginCell().storeUint(0, 8).storeStringTail('2').endCell());
    const chunked = beginCell().storeUint(0, 8).storeDict(dict).endCell();
    await expect(readTonJettonMetadata(chunked, failingFetch)).resolves.toMatchObject({ symbol: 'USDX', decimals: 2 });
  });

  it('refuses decimals out of range', async () => {
    await expect(readTonJettonMetadata(onchainContent({ decimals: '256' }), failingFetch)).rejects.toMatchObject({
      kind: ChainErrorKinds.InvalidTokenIdentifier,
    });
  });
});

describe('jetton get-methods on both providers', () => {
  it("reads USDT's content cell alike from TON Center and TonAPI", async () => {
    stubFetch(() => ({ status: 200, body: fixture('toncenter_usdt_jetton_data.json') }));
    const fromToncenter = await new ToncenterProvider(ENDPOINT).getJettonContent(USDT_MASTER);
    stubFetch(() => ({ status: 200, body: fixture('tonapi_usdt_jetton_data.json') }));
    const fromTonapi = await new TonapiProvider(ENDPOINT).getJettonContent(USDT_MASTER);
    expect(fromTonapi.hash().equals(fromToncenter.hash())).toBe(true);
    expect(fromToncenter.hash().equals(usdtJettonContent().hash())).toBe(true);
  });

  it("reads a USDT jetton wallet's owner and master alike from both", async () => {
    stubFetch(() => ({ status: 200, body: fixture('toncenter_usdt_wallet_data.json') }));
    const fromToncenter = await new ToncenterProvider(ENDPOINT).getJettonWalletData('0:' + '26'.repeat(32));
    stubFetch(() => ({ status: 200, body: fixture('tonapi_usdt_wallet_data.json') }));
    const fromTonapi = await new TonapiProvider(ENDPOINT).getJettonWalletData('0:' + '26'.repeat(32));
    expect(fromTonapi).toEqual(fromToncenter);
    expect(fromToncenter).toMatchObject({
      jettonMaster: USDT_MASTER,
      owner: '0:23fa979918f1fe702db9100bf843e87c7015eccd39a4721e9b6bac170bc04ce3',
      balance: 939188090649145n,
    });
  });

  it('calls a contract without the get-method no jetton master, and a provider error retryable', async () => {
    stubFetch(() => ({ status: 200, body: { gas_used: 0, exit_code: 11, stack: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getJettonContent(OTHER)).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidTokenIdentifier });
    stubFetch(() => ({ status: 200, body: { error: 'liteserver timeout', exit_code: 0 } }));
    await expect(new ToncenterProvider(ENDPOINT).getJettonContent(OTHER)).rejects.toMatchObject({ retryable: true });
  });

  it('reads a jetton wallet with no code as none, and a failure on a deployed one as an error', async () => {
    stubFetch(() => ({ status: 200, body: { gas_used: 0, exit_code: -13, stack: [] } }));
    await expect(new ToncenterProvider(ENDPOINT).getJettonWalletData(OTHER)).resolves.toBeNull();
    stubFetch((url) => (url.includes('/methods/') ? { status: 404, body: { error: 'entity not found' } } : { status: 200, body: { balance: 1, status: 'active' } }));
    await expect(new TonapiProvider(ENDPOINT).getJettonWalletData(OTHER)).rejects.toMatchObject({ retryable: true });
  });
});

function fakeProvider(overrides: Partial<TonProvider> = {}): TonProvider {
  return {
    name: 'fake',
    getAccountState: async (): Promise<TonAccountState> => ({ status: 'active', balance: 5n, codeHash: 'h' }),
    getSeqno: async () => 3,
    getPublicKey: async () => 0n,
    getJettonWalletAddress: async () => JETTON_WALLET,
    getJettonBalance: async () => 42n,
    sendBoc: async () => {},
    getTrace: async () => null,
    emulate: async () => ({ complete: true, transactions: [] }),
    getMasterchainHead: async () => ({ seqno: 100472540, utime: 1_700_000_000 }),
    getJettonContent: async () => usdtJettonContent(),
    getJettonWalletData: async () => null,
    getTraceByTransaction: async () => null,
    getAccountTransactions: async () => [],
    getLastTransactionLt: async () => 0n,
    ...overrides,
  };
}

function chainWith(provider: TonProvider, fetchMetadata: TonMetadataFetcher = async () => usdtOffchainMetadata()): TonChain {
  return new TonChain({ chainId: CHAIN_ID_TON_MAINNET, name: 'TON', explorerUrl: 'https://tonviewer.com', toncenter: { url: 'https://x' }, provider, fetchMetadata });
}

describe('TonChain jettons', () => {
  const from = TonWallet.fromMnemonic(MNEMONIC).address;

  it('resolves a jetton from its metadata once, and native TON without a call', async () => {
    const getJettonContent = jest.fn(async () => usdtJettonContent());
    const chain = chainWith(fakeProvider({ getJettonContent }));
    const usdt = await chain.resolveAsset(tonUserFriendlyAddress(USDT_MASTER, { bounceable: true }));
    expect(usdt).toMatchObject({ symbol: 'USD₮', decimals: 6, jettonMaster: USDT_MASTER });
    expect(assetHashOf(usdt)).toBe(assetHashOf(TON_USDT));
    await chain.resolveAsset(USDT_MASTER);
    expect(getJettonContent).toHaveBeenCalledTimes(1);
    await expect(chain.resolveAsset(undefined)).resolves.toBe(chain.nativeAsset);
  });

  it('takes a human-readable jetton amount in the jetton decimals', async () => {
    const chain = chainWith(fakeProvider());
    const transfer = await chain.createTransferUnsignedTransaction({ from, to: OTHER, tokenIdentifier: USDT_MASTER, amountHr: new Decimal('1.5') });
    const body = (transfer.messages[0].body as Cell).beginParse();
    body.skip(32 + 64);
    expect(body.loadCoins()).toBe(1_500_000n);
  });

  it("sends a jetton wallet's whole balance, and refuses an empty one", async () => {
    const chain = chainWith(fakeProvider({ getJettonBalance: async () => 42n }));
    const transfer = await chain.createTransferUnsignedTransaction({ from, to: OTHER, tokenIdentifier: USDT_MASTER, isFullBalance: true });
    const body = (transfer.messages[0].body as Cell).beginParse();
    body.skip(32 + 64);
    expect(body.loadCoins()).toBe(42n);
    const empty = chainWith(fakeProvider({ getJettonBalance: async () => 0n }));
    await expect(empty.createTransferUnsignedTransaction({ from, to: OTHER, tokenIdentifier: USDT_MASTER, isFullBalance: true })).rejects.toMatchObject({
      kind: ChainErrorKinds.InsufficientFunds,
    });
  });

  it('sends all native TON with send mode 128 + 2 and no value', async () => {
    const transfer = await chainWith(fakeProvider()).createTransferUnsignedTransaction({ from, to: OTHER, isFullBalance: true });
    expect(transfer.messages[0]).toMatchObject({ value: 0n, mode: SendMode.CARRY_ALL_REMAINING_BALANCE | SendMode.IGNORE_ERRORS });
    expect(transfer.messages[0].mode).toBe(130);
  });

  it.each([
    ['EQ… to a deployed contract', true, 'active', true],
    ['EQ… to an address with no wallet yet', true, 'nonexist', false],
    ['UQ…', false, 'active', false],
    ['raw', null, 'active', false],
  ] as const)('bounces native TON sent %s: %s', async (_case, bounceable, status, bounce) => {
    const chain = chainWith(fakeProvider({ getAccountState: async () => ({ status, balance: 0n, codeHash: null }) }));
    const to = bounceable === null ? OTHER : tonUserFriendlyAddress(OTHER, { bounceable });
    const transfer = await chain.createTransferUnsignedTransaction({ from, to, amount: 1n });
    expect(transfer.messages[0].bounce).toBe(bounce);
  });

  it('takes overrides for bounce, send mode, attached TON and forwarded TON', async () => {
    const chain = chainWith(fakeProvider());
    const native = await chain.createTransferUnsignedTransaction({ from, to: OTHER, amount: 1n, bounce: true, sendMode: SendMode.PAY_GAS_SEPARATELY });
    expect(native.messages[0]).toMatchObject({ bounce: true, mode: SendMode.PAY_GAS_SEPARATELY });
    const jetton = await chain.createTransferUnsignedTransaction({
      from,
      to: OTHER,
      tokenIdentifier: USDT_MASTER,
      amount: 7n,
      bounce: false,
      sendMode: 3,
      jettonAttachedNanoton: 90_000_000n,
      forwardTonAmountNanoton: 5n,
    });
    expect(jetton.messages[0]).toMatchObject({ bounce: false, mode: 3, value: 90_000_000n });
    expect((jetton.messages[0].body as Cell).hash().equals(
      tonJettonTransferBody({ amount: 7n, destination: OTHER, responseDestination: from, forwardTonAmount: 5n }).hash(),
    )).toBe(true);
  });

  it("links a jetton by its master's bounceable (EQ…) form", async () => {
    const chain = chainWith(fakeProvider());
    const eq = tonUserFriendlyAddress(USDT_MASTER, { bounceable: true });
    expect(eq.startsWith('EQ')).toBe(true);
    expect(chain.getTokenExplorerUrl(USDT_MASTER)).toBe(`https://tonviewer.com/${eq}`);
    expect(chain.getAssetExplorerUrl(TON_USDT)).toBe(`https://tonviewer.com/${eq}`);
    expect(chain.getAssetExplorerUrl(chain.nativeAsset)).toBeNull();
  });
});

describe('jetton balance changes', () => {
  const SENDER_JW = '0:' + '1a'.repeat(32);
  const RECIPIENT_JW = '0:' + '2b'.repeat(32);
  const RECIPIENT = OTHER;

  /** The sender's wallet sends a USDT transfer; its jetton wallet passes the jettons on; the recipient's jetton wallet takes them. */
  async function jettonTrace(amount: bigint, receiverAborted = false): Promise<TonTrace> {
    const [root] = (await realTrace()).transactions;
    const sender = root.account;
    const transfer: TonTraceMessage = {
      ...root.outMsgs[0],
      destination: SENDER_JW,
      value: 50_000_000n,
      bounce: true,
      opcode: 0x0f8a7ea5,
      body: tonJettonTransferBody({ amount, destination: RECIPIENT, responseDestination: sender, forwardTonAmount: 1n }),
    };
    const internalTransfer: TonTraceMessage = {
      ...transfer,
      source: SENDER_JW,
      destination: RECIPIENT_JW,
      value: 40_000_000n,
      opcode: TON_JETTON_INTERNAL_TRANSFER_OP,
      createdLt: (transfer.createdLt as bigint) + 2n,
      body: beginCell()
        .storeUint(TON_JETTON_INTERNAL_TRANSFER_OP, 32)
        .storeUint(0, 64)
        .storeCoins(amount)
        .storeAddress(Address.parse(sender))
        .storeAddress(Address.parse(sender))
        .storeCoins(1n)
        .storeBit(false)
        .endCell(),
    };
    const tx = (hash: string, parent: string, account: string, inMsg: TonTraceMessage, outMsgs: TonTraceMessage[] = []): TonTraceTransaction => ({
      ...root,
      hash: hash.repeat(32),
      parent,
      account,
      inMsg,
      outMsgs,
      success: true,
      aborted: false,
    });
    const senderJettonWallet = tx('c1', root.hash, SENDER_JW, transfer, [internalTransfer]);
    const recipientJettonWallet = { ...tx('c2', senderJettonWallet.hash, RECIPIENT_JW, internalTransfer), aborted: receiverAborted, success: !receiverAborted };
    return { complete: true, transactions: settled([{ ...root, outMsgs: [transfer] }, senderJettonWallet, recipientJettonWallet]) };
  }

  const genuine = (sender: string): Partial<TonProvider> => ({
    getJettonWalletData: async (wallet: string) => (wallet === SENDER_JW ? { balance: 0n, owner: sender, jettonMaster: USDT_MASTER } : null),
    getJettonWalletAddress: async (_master: string, owner: string) => (owner === sender ? SENDER_JW : owner === RECIPIENT ? RECIPIENT_JW : JETTON_WALLET),
  });

  it('moves the jettons from the sending owner to the recipient, in the jetton asset, on status and emulation', async () => {
    const trace = await jettonTrace(2_500_000n);
    const sender = trace.transactions[0].account;
    const chain = chainWith(fakeProvider({ ...genuine(sender), getTrace: async () => trace, emulate: async () => trace }));
    for (const balanceChanges of [(await chain.getTransactionStatus('ab'.repeat(32))).balanceChanges, (await chain.emulate('boc')).balanceChanges]) {
      const usdt = assetHashOf(TON_USDT);
      expect(balanceChanges?.get(sender)?.get(usdt)?.change.balanceChangeMr).toBe(-2_500_000n);
      expect(balanceChanges?.get(RECIPIENT)?.get(usdt)?.change.balanceChangeMr).toBe(2_500_000n);
      expect(balanceChanges?.get(RECIPIENT)?.get(usdt)?.token).toMatchObject({ symbol: 'USD₮', decimals: 6 });
    }
  });

  it('moves nothing when the master does not vouch for a jetton wallet', async () => {
    const trace = await jettonTrace(2_500_000n);
    const sender = trace.transactions[0].account;
    const impostor = { ...genuine(sender), getJettonWalletAddress: async () => JETTON_WALLET };
    const status = await chainWith(fakeProvider({ ...impostor, getTrace: async () => trace })).getTransactionStatus('ab'.repeat(32));
    const usdt = assetHashOf(TON_USDT);
    expect(status.balanceChanges?.get(RECIPIENT)?.get(usdt)).toBeUndefined();
    expect(status.balanceChanges?.get(sender)?.get(usdt)).toBeUndefined();
  });

  it('moves nothing when the receiving jetton wallet aborted', async () => {
    const trace = await jettonTrace(2_500_000n, true);
    const sender = trace.transactions[0].account;
    const result = await chainWith(fakeProvider({ ...genuine(sender), emulate: async () => trace })).emulate('boc');
    expect(result.jettonCredits).toEqual([]);
    expect(result.balanceChanges.get(RECIPIENT)?.get(assetHashOf(TON_USDT))).toBeUndefined();
  });

  it("credits jettons a jetton wallet accepted though it then skipped a message", async () => {
    const trace = await jettonTrace(1n);
    const receiving = trace.transactions[2];
    const skipped: TonTrace = {
      ...trace,
      transactions: trace.transactions.map((tx) => (tx === receiving ? { ...tx, success: false, skippedActions: 1 } : tx)),
    };
    const result = await chainWith(fakeProvider({ ...genuine(trace.transactions[0].account), emulate: async () => skipped })).emulate('boc');
    expect(result.jettonCredits).toHaveLength(1);
  });
});
