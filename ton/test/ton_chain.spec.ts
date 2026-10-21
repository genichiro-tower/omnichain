import { jest } from '@jest/globals';

import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { TonChain } from '../ton_chain.ts';
import { TON_JETTON_TRANSFER_OP } from '../ton_messages.ts';
import type { TonAccountState, TonProvider } from '../ton_provider.ts';
import { TonUnsignedTransaction } from '../ton_transactions.ts';
import { TonWallet } from '../ton_wallet.ts';
import { JETTON_WALLET, MNEMONIC, OTHER, USDT_MASTER } from './ton_test_helpers.ts';

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
