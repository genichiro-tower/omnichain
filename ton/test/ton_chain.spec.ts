import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';
import { beginCell } from '@ton/core';

import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { TransactionStatusTypes } from '../../transaction_status.ts';
import { TonChain } from '../ton_chain.ts';
import { TON_JETTON_INTERNAL_TRANSFER_OP, TON_JETTON_TRANSFER_OP } from '../ton_messages.ts';
import type { TonAccountState, TonProvider, TonTrace, TonTraceTransaction } from '../ton_provider.ts';
import { ToncenterProvider } from '../ton_toncenter.ts';
import { TonTransactionStatus, summarizeTonTrace } from '../ton_transaction_status.ts';
import { TonUnsignedTransaction } from '../ton_transactions.ts';
import { TonWallet } from '../ton_wallet.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const USDT_MASTER = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';
const OTHER = '0:9d1e1843624c4d175a695a8c2de8a5a61f03b93336e8caa4e164bf6cbbab205e';
const JETTON_WALLET = '0:e655d099d9200bbf27c20d594f2ebd21a0f854c608cd16d4c0c5e9b3f55fc2e7';

function fakeProvider(overrides: Partial<TonProvider> = {}): TonProvider {
  return {
    name: 'fake',
    getAccountState: async (): Promise<TonAccountState> => ({ status: 'active', balance: 5n, codeHash: 'h' }),
    getSeqno: async () => 3,
    getJettonWalletAddress: async () => JETTON_WALLET,
    getJettonBalance: async () => 42n,
    sendBoc: async () => {},
    getTrace: async () => null,
    emulate: async () => ({ complete: true, transactions: [] }),
    getMasterchainSeqno: async () => 100,
    ...overrides,
  };
}

function chainWith(provider: TonProvider): TonChain {
  return new TonChain({ chainId: CHAIN_ID_TON_MAINNET, name: 'TON Mainnet', explorerUrl: 'https://tonviewer.com', toncenter: { url: 'https://x' }, provider });
}

async function realTrace(): Promise<TonTrace> {
  const body = JSON.parse(readFileSync(new URL('./fixtures/toncenter_trace.json', import.meta.url), 'utf8'));
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
  try {
    return (await new ToncenterProvider({ url: 'https://x', apiKey: 'k' }).getTrace('00')) as TonTrace;
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('TonTransactionStatus', () => {
  it('is Success once the trace is complete and every transaction is in a referenced block', async () => {
    const trace = await realTrace();
    const status = TonTransactionStatus.fromTrace({ chainId: CHAIN_ID_TON_MAINNET, trace, masterchainTip: 100472540 });
    expect(status.status).toBe(TransactionStatusTypes.Success);
    expect(status.masterchainSeqno).toBe(100472531);
    expect(status.masterchainDepth).toBe(9);

    const [root, child] = trace.transactions;
    const deltaOf = (account: string): bigint =>
      [...(status.balanceChanges?.get(account)?.values() ?? [])][0].change.balanceChangeMr;
    expect(deltaOf(root.account)).toBe(-(3_794_400_000n + 58_135n + root.totalFees));
    expect(deltaOf(child.account)).toBe(3_794_400_000n - child.totalFees);
    expect(status.fees).toBe(root.totalFees + child.totalFees + 58_135n);
  });

  it('stays Pending while not final, incomplete or shallower than asked', async () => {
    const trace = await realTrace();
    const notFinal = { ...trace, transactions: trace.transactions.map((tx, i) => (i === 1 ? { ...tx, mcSeqno: null } : tx)) };
    const at = (t: TonTrace | null, minMasterchainDepth = 0): string =>
      TonTransactionStatus.fromTrace({ chainId: CHAIN_ID_TON_MAINNET, trace: t, masterchainTip: 100472540, minMasterchainDepth }).status;
    expect(at(null)).toBe(TransactionStatusTypes.Pending);
    expect(at(notFinal)).toBe(TransactionStatusTypes.Pending);
    expect(at({ ...trace, complete: false })).toBe(TransactionStatusTypes.Pending);
    expect(at(trace, 10)).toBe(TransactionStatusTypes.Pending);
    expect(at(trace, 9)).toBe(TransactionStatusTypes.Success);
  });

  it('is Failed when a message bounced', async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const bounce: TonTraceTransaction = {
      ...root,
      hash: 'cc'.repeat(32),
      inMsg: { ...(child.inMsg as NonNullable<TonTraceTransaction['inMsg']>), source: child.account, destination: root.account, bounced: true },
      outMsgs: [],
    };
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      trace: { complete: true, transactions: [root, child, bounce] },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.error?.code).toBe('bounced');
    expect(status.summary?.bouncedMessages).toHaveLength(1);
  });

  it('is Failed when a wallet skipped a message it could not send', async () => {
    const trace = await realTrace();
    const [root] = trace.transactions;
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      trace: { complete: true, transactions: [{ ...root, success: false, skippedActions: 1, outMsgs: [] }] },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.error?.code).toBe('skipped_actions');
  });

  it('reads the jettons a jetton wallet accepted', async () => {
    const trace = await realTrace();
    const [, child] = trace.transactions;
    const body = beginCell()
      .storeUint(TON_JETTON_INTERNAL_TRANSFER_OP, 32)
      .storeUint(0, 64)
      .storeCoins(9_000n)
      .storeAddress(TonWallet.fromMnemonic(MNEMONIC).contract.address)
      .endCell();
    const credit: TonTraceTransaction = {
      ...child,
      inMsg: { ...(child.inMsg as NonNullable<TonTraceTransaction['inMsg']>), opcode: TON_JETTON_INTERNAL_TRANSFER_OP, body },
    };
    expect(summarizeTonTrace(CHAIN_ID_TON_MAINNET, { complete: true, transactions: [credit] }).jettonCredits).toEqual([
      { jettonWallet: child.account, amount: 9_000n, from: TonWallet.fromMnemonic(MNEMONIC).address },
    ]);
  });
});

describe('TonChain', () => {
  it('needs a TON Center key before any call', () => {
    const previous = process.env.TONCENTER_API_KEY;
    delete process.env.TONCENTER_API_KEY;
    try {
      const chain = new TonChain({ chainId: CHAIN_ID_TON_MAINNET, name: 'TON', explorerUrl: 'https://tonviewer.com', toncenter: { url: 'https://toncenter.com' } });
      expect(() => chain.provider).toThrow(expect.objectContaining({ kind: ChainErrorKinds.RpcNotConfigured }));
    } finally {
      if (previous !== undefined) process.env.TONCENTER_API_KEY = previous;
    }
  });

  it('reads seqno 0 for an undeployed wallet without asking the provider', async () => {
    const getSeqno = jest.fn(async () => 9);
    const chain = chainWith(fakeProvider({ getAccountState: async () => ({ status: 'uninit', balance: 1n, codeHash: null }), getSeqno }));
    await expect(chain.getSeqno(OTHER)).resolves.toBe(0);
    expect(getSeqno).not.toHaveBeenCalled();
  });

  it('builds a native transfer and a jetton transfer', async () => {
    const chain = chainWith(fakeProvider());
    const from = TonWallet.fromMnemonic(MNEMONIC).address;
    const native = await chain.createTransferUnsignedTransaction({ from, to: OTHER, amount: 1_000n, memo: '42' });
    expect(native.messages).toEqual([expect.objectContaining({ to: OTHER, value: 1_000n, bounce: false })]);

    const jetton = await chain.createTransferUnsignedTransaction({ from, to: OTHER, tokenIdentifier: USDT_MASTER, amount: 10_000n });
    expect(jetton.messages[0].to).toBe(JETTON_WALLET);
    expect(jetton.messages[0].body?.beginParse().loadUint(32)).toBe(TON_JETTON_TRANSFER_OP);
    await expect(
      chain.createTransferUnsignedTransaction({ from, to: OTHER, tokenIdentifier: USDT_MASTER, isFullBalance: true }),
    ).rejects.toThrow(/amount/);
  });

  it('signs with the live seqno, and deploys an undeployed wallet', async () => {
    const wallet = TonWallet.fromMnemonic(MNEMONIC);
    const transaction = new TonUnsignedTransaction({ chainId: CHAIN_ID_TON_MAINNET, walletAddress: wallet.address, messages: [{ to: OTHER, value: 1n }] });
    const deployed = await wallet.signTransaction(transaction, chainWith(fakeProvider()));
    const fresh = await wallet.signTransaction(
      transaction,
      chainWith(fakeProvider({ getAccountState: async () => ({ status: 'nonexist', balance: 0n, codeHash: null }) })),
    );
    expect(deployed.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fresh.boc.length).toBeGreaterThan(deployed.boc.length);
  });

  it('broadcasts and returns the normalized hash', async () => {
    const sendBoc = jest.fn(async () => {});
    const chain = chainWith(fakeProvider({ sendBoc }));
    const request = TonWallet.fromMnemonic(MNEMONIC).createExternalRequest({ seqno: 0, messages: [{ to: OTHER, value: 1n }] });
    await expect(chain.broadcast(request.boc)).resolves.toBe(request.hash);
    expect(sendBoc).toHaveBeenCalledWith(request.boc);
  });

  it('refuses a malformed transaction id', async () => {
    await expect(chainWith(fakeProvider()).getTransactionStatus('ABC')).rejects.toThrow(/64 lowercase hex/);
  });

  it('calls a request expired only past validUntil with the seqno unmoved', async () => {
    const chain = chainWith(fakeProvider({ getSeqno: async () => 3 }));
    await expect(chain.isRequestExpired({ wallet: OTHER, seqno: 3, validUntil: 100, now: 99 })).resolves.toBe(false);
    await expect(chain.isRequestExpired({ wallet: OTHER, seqno: 3, validUntil: 100, now: 101 })).resolves.toBe(true);
    await expect(chain.isRequestExpired({ wallet: OTHER, seqno: 2, validUntil: 100, now: 101 })).resolves.toBe(false);
  });

  it('reads TON and jetton balances', async () => {
    const chain = chainWith(fakeProvider());
    await expect(chain.getBalance(OTHER)).resolves.toBe(5n);
    await expect(chain.getBalance(OTHER, USDT_MASTER)).resolves.toBe(42n);
  });
});
