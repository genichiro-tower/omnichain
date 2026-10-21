import { jest } from '@jest/globals';

import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { REQUEST_EXPIRY_MARGIN_SECONDS, TonChain } from '../ton_chain.ts';
import { TON_JETTON_TRANSFER_OP } from '../ton_messages.ts';
import { type TonAccountState, TonBroadcastUncertainError, TonFallbackProvider, type TonProvider, TonProviderError } from '../ton_provider.ts';
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
    getMasterchainHead: async () => ({ seqno: 100, utime: 1_700_000_000 }),
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

  it('reads the seqno live, even while the indexed state still says undeployed', async () => {
    // A wallet deployed seconds ago: the indexer trails, the get-method does not.
    const getAccountState = jest.fn(async (): Promise<TonAccountState> => ({ status: 'uninit', balance: 1n, codeHash: null }));
    const chain = chainWith(fakeProvider({ getAccountState, getSeqno: async () => 1 }));
    await expect(chain.getSeqno(OTHER)).resolves.toBe(1);
    expect(getAccountState).not.toHaveBeenCalled();
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
    const fresh = await wallet.signTransaction(transaction, chainWith(fakeProvider({ getSeqno: async () => 0 })));
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

  it('keeps an uncertain broadcast uncertain, with the hash to read', async () => {
    const chain = chainWith(
      fakeProvider({
        sendBoc: async () => {
          throw new TonBroadcastUncertainError('broadcast outcome unknown');
        },
      }),
    );
    const request = TonWallet.fromMnemonic(MNEMONIC).createExternalRequest({ seqno: 0, messages: [{ to: OTHER, value: 1n }] });
    const err = await chain.broadcast(request.boc).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TonBroadcastUncertainError);
    expect((err as TonBroadcastUncertainError).meta).toMatchObject({ txHash: request.hash });
  });

  it('refuses a malformed transaction id', async () => {
    await expect(chainWith(fakeProvider()).getTransactionStatus('ABC')).rejects.toThrow(/64 lowercase hex/);
  });

  it('calls a request expired only on chain time past validUntil, the seqno unmoved and no trace', async () => {
    const hash = 'ab'.repeat(32);
    const validUntil = 1_000;
    const at = (utime: number, overrides: Partial<TonProvider> = {}): TonChain =>
      chainWith(fakeProvider({ getSeqno: async () => 3, getMasterchainHead: async () => ({ seqno: 100, utime }), ...overrides }));
    const past = validUntil + REQUEST_EXPIRY_MARGIN_SECONDS + 1;
    await expect(at(past).isRequestExpired({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe(true);
    // This machine's clock is far ahead; the chain's is not.
    await expect(at(validUntil + 1).isRequestExpired({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe(false);
    await expect(at(past).isRequestExpired({ wallet: OTHER, seqno: 2, validUntil, hash })).resolves.toBe(false);
    const landed = at(past, { getTrace: async () => ({ complete: false, transactions: [] }) });
    await expect(landed.isRequestExpired({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe(false);
    // A seqno that could not be read is an error, not an unmoved seqno.
    const unreadable = at(past, {
      getSeqno: async () => {
        throw new TonProviderError(ChainErrorKinds.RpcError, 'could not run seqno', true);
      },
    });
    await expect(unreadable.isRequestExpired({ wallet: OTHER, seqno: 3, validUntil, hash })).rejects.toThrow('could not run seqno');
  });

  it('reads all of an expiry check from one provider', async () => {
    const validUntil = 1_000;
    const past = validUntil + REQUEST_EXPIRY_MARGIN_SECONDS + 1;
    const unavailable = (): never => {
      throw new TonProviderError(ChainErrorKinds.RpcError, 'HTTP 503', true);
    };
    // The primary answers the head, then fails the seqno: everything is asked again of the fallback.
    const primaryHead = jest.fn(async () => ({ seqno: 100, utime: past }));
    const primary = fakeProvider({ getMasterchainHead: primaryHead, getSeqno: async () => unavailable() });
    const fallbackHead = jest.fn(async () => ({ seqno: 90, utime: validUntil }));
    const fallback = fakeProvider({ getMasterchainHead: fallbackHead, getSeqno: async () => 3 });
    const chain = chainWith(new TonFallbackProvider(primary, fallback));
    // The fallback's own clock is not past validUntil yet, so it is not expired.
    await expect(chain.isRequestExpired({ wallet: OTHER, seqno: 3, validUntil, hash: 'ab'.repeat(32) })).resolves.toBe(false);
    expect(fallbackHead).toHaveBeenCalled();
  });

  it('keeps a relayed request alive until chain time passes it with the seqno unmoved, whatever its status', async () => {
    const validUntil = 1_000;
    const at = (utime: number, seqno: number): TonChain =>
      chainWith(fakeProvider({ getSeqno: async () => seqno, getMasterchainHead: async () => ({ seqno: 100, utime }) }));
    const past = validUntil + REQUEST_EXPIRY_MARGIN_SECONDS + 1;
    // A failed relayed request leaves the seqno where it was: still valid before validUntil.
    await expect(at(validUntil - 10, 5).isRelayedRequestExpired({ wallet: OTHER, seqno: 5, validUntil })).resolves.toBe(false);
    await expect(at(past, 5).isRelayedRequestExpired({ wallet: OTHER, seqno: 5, validUntil })).resolves.toBe(true);
    // The seqno moved past it: it, or another request with its seqno, executed.
    await expect(at(past, 6).isRelayedRequestExpired({ wallet: OTHER, seqno: 5, validUntil })).resolves.toBe(false);
  });

  it('reads TON and jetton balances', async () => {
    const chain = chainWith(fakeProvider());
    await expect(chain.getBalance(OTHER)).resolves.toBe(5n);
    await expect(chain.getBalance(OTHER, USDT_MASTER)).resolves.toBe(42n);
  });
});
