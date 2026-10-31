import { jest } from '@jest/globals';

import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { tonUserFriendlyAddress } from '../ton_address.ts';
import { REQUEST_EXPIRY_MARGIN_SECONDS, TonChain } from '../ton_chain.ts';
import { TON_JETTON_TRANSFER_OP } from '../ton_messages.ts';
import { type TonAccountState, TonBroadcastUncertainError, TonFallbackProvider, type TonProvider, TonProviderError } from '../ton_provider.ts';
import { TonUnsignedTransaction } from '../ton_transactions.ts';
import { TonWallet } from '../ton_wallet.ts';
import type { TonMetadataFetcher } from '../ton_jetton_metadata.ts';
import { JETTON_WALLET, MNEMONIC, OTHER, USDT_MASTER, realTrace, usdtJettonContent, usdtOffchainMetadata } from './ton_test_helpers.ts';

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
    getMasterchainHead: async () => ({ seqno: 100, utime: 1_700_000_000 }),
    getJettonContent: async () => usdtJettonContent(),
    getJettonWalletData: async () => null,
    getTraceByTransaction: async () => null,
    getAccountTransactions: async () => [],
    getLastTransactionLt: async () => 0n,
    ...overrides,
  };
}

function chainWith(provider: TonProvider, fetchMetadata: TonMetadataFetcher = async () => usdtOffchainMetadata()): TonChain {
  return new TonChain({
    chainId: CHAIN_ID_TON_MAINNET,
    name: 'TON Mainnet',
    explorerUrl: 'https://tonviewer.com',
    toncenter: { url: 'https://x' },
    provider,
    fetchMetadata,
  });
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
  });

  it.each([
    ['EQ… (bounceable)', true, true],
    ['UQ… (non-bounceable)', false, false],
    ['raw', null, false],
  ] as const)('makes a native transfer to a %s address bounce=%s', async (_form, bounceable, bounce) => {
    const chain = chainWith(fakeProvider());
    const to = bounceable === null ? OTHER : tonUserFriendlyAddress(OTHER, { bounceable });
    const transfer = await chain.createTransferUnsignedTransaction({ from: TonWallet.fromMnemonic(MNEMONIC).address, to, amount: 1n });
    expect(transfer.messages[0].bounce).toBe(bounce);
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

  describe('getRequestState', () => {
    const hash = 'ab'.repeat(32);
    const validUntil = 1_000;
    const past = validUntil + REQUEST_EXPIRY_MARGIN_SECONDS + 1;
    const at = (utime: number, seqno: number, overrides: Partial<TonProvider> = {}): TonChain =>
      chainWith(fakeProvider({ getSeqno: async () => seqno, getMasterchainHead: async () => ({ seqno: 100, utime }), ...overrides }));

    it('is expired only on chain time past validUntil, the seqno not past the request and no trace', async () => {
      await expect(at(past, 3).getRequestState({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe('expired');
      // Requests before it never executed either: still expired.
      await expect(at(past, 1).getRequestState({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe('expired');
      // This machine's clock is far ahead; the chain's is not.
      await expect(at(validUntil + 1, 3).getRequestState({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe('live');
    });

    it('is consumed once the seqno moved past it or the request has a trace, however late it is', async () => {
      await expect(at(past, 4).getRequestState({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe('consumed');
      await expect(at(validUntil, 4).getRequestState({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe('consumed');
      const traced = at(past, 3, { getTrace: async () => ({ complete: false, transactions: [] }) });
      await expect(traced.getRequestState({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe('consumed');
    });

    it('keeps a relayed request that failed live until chain time passes it, and calls it consumed once it executed', async () => {
      // A failed relayed request leaves the wallet's seqno where it was.
      await expect(at(validUntil - 10, 5).getRequestState({ wallet: OTHER, seqno: 5, validUntil })).resolves.toBe('live');
      await expect(at(past, 5).getRequestState({ wallet: OTHER, seqno: 5, validUntil })).resolves.toBe('expired');
      // Delivered again and executed: the seqno moved.
      await expect(at(past, 6).getRequestState({ wallet: OTHER, seqno: 5, validUntil })).resolves.toBe('consumed');
    });

    it("refuses a relay's hash given for the relayed wallet, whose request may still be live", async () => {
      const trace = await realTrace();
      const relayer = trace.transactions[0].account;
      const chain = at(validUntil, 5, { getTrace: async () => trace });
      // seqno 5 is the wallet's current seqno here, below the request's 508: not consumed by seqno.
      await expect(chain.getRequestState({ wallet: OTHER, seqno: 5, validUntil, hash })).rejects.toMatchObject({
        kind: ChainErrorKinds.InvalidArgument,
        message: expect.stringContaining('for a relayed request pass no hash'),
      });
      // The recorded request was signed at seqno 508; another seqno names another request.
      await expect(chain.getRequestState({ wallet: relayer, seqno: 508, validUntil, hash })).resolves.toBe('consumed');
      await expect(chain.getRequestState({ wallet: relayer, seqno: 5, validUntil, hash })).rejects.toMatchObject({
        kind: ChainErrorKinds.InvalidArgument,
        message: expect.stringContaining('signed at seqno 508'),
      });
    });

    it('throws on a read that failed rather than answering', async () => {
      const unreadable = at(past, 3, {
        getSeqno: async () => {
          throw new TonProviderError(ChainErrorKinds.RpcError, 'could not run seqno', true);
        },
      });
      await expect(unreadable.getRequestState({ wallet: OTHER, seqno: 3, validUntil, hash })).rejects.toThrow('could not run seqno');
    });

    it.each(['AB'.repeat(32), 'ab'.repeat(31), Buffer.from('ab'.repeat(32), 'hex').toString('base64'), `${'ab'.repeat(32)}x`])(
      'refuses the malformed hash %s instead of finding no trace',
      async (malformed) => {
        const getTrace = jest.fn(async () => null);
        const chain = at(past, 3, { getTrace });
        await expect(chain.getRequestState({ wallet: OTHER, seqno: 3, validUntil, hash: malformed })).rejects.toMatchObject({
          kind: ChainErrorKinds.InvalidArgument,
        });
        expect(getTrace).not.toHaveBeenCalled();
      },
    );

    it('reads everything from one provider', async () => {
      const unavailable = (): never => {
        throw new TonProviderError(ChainErrorKinds.RpcError, 'HTTP 503', true);
      };
      // The primary answers the seqno, then fails the trace: everything is asked again of the fallback.
      const primary = fakeProvider({ getSeqno: async () => 3, getTrace: async () => unavailable(), getMasterchainHead: async () => ({ seqno: 100, utime: past }) });
      const fallbackHead = jest.fn(async () => ({ seqno: 90, utime: validUntil }));
      const fallback = fakeProvider({ getSeqno: async () => 3, getMasterchainHead: fallbackHead });
      const chain = chainWith(new TonFallbackProvider(primary, fallback));
      // The fallback's own clock is not past validUntil yet.
      await expect(chain.getRequestState({ wallet: OTHER, seqno: 3, validUntil, hash })).resolves.toBe('live');
      expect(fallbackHead).toHaveBeenCalled();
    });
  });

  it('reads TON and jetton balances', async () => {
    const chain = chainWith(fakeProvider());
    await expect(chain.getBalance(OTHER)).resolves.toBe(5n);
    await expect(chain.getBalance(OTHER, USDT_MASTER)).resolves.toBe(42n);
  });
});
