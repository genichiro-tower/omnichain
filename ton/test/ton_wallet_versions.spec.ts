import { Cell, SendMode, internal, loadMessage } from '@ton/core';
import { keyPairFromSeed } from '@ton/crypto';
import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';

import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { ChainErrorKinds } from '../../errors.ts';
import { TonChain } from '../ton_chain.ts';
import { tonRelayMessage, tonWalletRequestFields } from '../ton_messages.ts';
import { type TonAccountState, TonBroadcastUncertainError, type TonProvider, tonBroadcastReply, TonProviderError } from '../ton_provider.ts';
import { TonSignedTransaction, TonUnsignedTransaction } from '../ton_transactions.ts';
import { TON_LEGACY_MAX_MESSAGES, TonWallet, deriveTonNativeSeed } from '../ton_wallet.ts';
import { TON_LEGACY_DEFAULT_WALLET_ID } from '../ton_wallet_contracts.ts';
import { MNEMONIC, OTHER, usdtJettonContent } from './ton_test_helpers.ts';

const keyPair = keyPairFromSeed(deriveTonNativeSeed(MNEMONIC));

describe('TON wallet versions (v3r2, v4r2, v5r1)', () => {
  it("gives the Python SDK's v4r2 address for the test phrase, and the library's for each version", () => {
    const v4 = TonWallet.fromMnemonic(MNEMONIC, { version: 'v4r2' });
    // Computed by the Python SDK: TonWallet.from_mnemonic(phrase) — v4r2 is its default.
    expect(v4.address).toBe('0:6e55f7885c3f91f1a62c9bc3fd3d3e6cf8211d3bcdcecbdd0fa5c730de694943');
    expect(TonWallet.fromMnemonic(MNEMONIC, { version: 'v3r2' }).address).toBe(
      WalletContractV3R2.create({ workchain: 0, publicKey: keyPair.publicKey }).address.toRawString(),
    );
    expect(TonWallet.fromMnemonic(MNEMONIC).address).toBe(WalletContractV5R1.create({ workchain: 0, publicKey: keyPair.publicKey }).address.toRawString());
    expect(TonWallet.fromMnemonic(MNEMONIC).version).toBe('v5r1');
    // One key, three wallets.
    const addresses = (['v3r2', 'v4r2', 'v5r1'] as const).map((version) => TonWallet.fromMnemonic(MNEMONIC, { version }).address);
    expect(new Set(addresses).size).toBe(3);
    expect(() => TonWallet.fromMnemonic(MNEMONIC, { version: 'v2r2' as never })).toThrow(/version must be one of/);
  });

  describe('workchain -1 (the masterchain), as the Python SDK builds it', () => {
    it("gives the Python SDK's W5 address on -1", () => {
      // Computed by the Python SDK: TonWallet.from_mnemonic(phrase, version='v5r1', workchain=-1).
      const w5 = TonWallet.fromMnemonic(MNEMONIC, { workchain: -1 });
      expect(w5.address).toBe('-1:7b018a245a15b9a3002d4f23a24dae92c220fcb221de347a35a0b50b2960aa7d');
      expect(w5.workchain).toBe(-1);
    });

    it.each(['v4r2', 'v3r2'] as const)(
      "gives %s on -1 the Python SDK's wallet id, 698983191, not @ton/ton's 698983191 + workchain",
      (version) => {
        // ton_core's DEFAULT_SUBWALLET_ID is a constant, so the contract — and the address hash — is the workchain-0 one.
        const basechain = TonWallet.fromMnemonic(MNEMONIC, { version });
        const masterchain = TonWallet.fromMnemonic(MNEMONIC, { version, workchain: -1 });
        expect(masterchain.address).toBe(`-1:${basechain.address.slice(2)}`);
        expect((masterchain.contract as WalletContractV4).walletId).toBe(TON_LEGACY_DEFAULT_WALLET_ID);
        const atonDefault = (version === 'v4r2' ? WalletContractV4 : WalletContractV3R2).create({ workchain: -1, publicKey: keyPair.publicKey });
        expect(atonDefault.walletId).toBe(TON_LEGACY_DEFAULT_WALLET_ID - 1);
        expect(atonDefault.address.toRawString()).not.toBe(masterchain.address);
        // Its requests carry that wallet id, so the contract accepts them.
        const body = loadMessage(Cell.fromBase64(masterchain.createExternalRequest({ seqno: 0, messages: [{ to: OTHER, value: 1n }] }).boc).beginParse()).body;
        expect(tonWalletRequestFields(body).walletId).toBe(TON_LEGACY_DEFAULT_WALLET_ID);
      },
    );

    it('takes a path and a workchain together, and refuses any other workchain', () => {
      const atPath = TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath({ account: 2 }), workchain: -1 });
      expect(atPath.address.startsWith('-1:')).toBe(true);
      expect(atPath.publicKey.equals(TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath({ account: 2 }) }).publicKey)).toBe(true);
      expect(() => TonWallet.fromMnemonic(MNEMONIC, { workchain: 1 as never })).toThrow(/workchain 0 or -1/);
    });
  });

  it.each([
    ['v4r2', WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey })],
    ['v3r2', WalletContractV3R2.create({ workchain: 0, publicKey: keyPair.publicKey })],
  ] as const)('signs a %s request exactly as @ton/ton does, with "ignore errors" on every message', (version, contract) => {
    const wallet = TonWallet.fromMnemonic(MNEMONIC, { version });
    const messages = [
      { to: OTHER, value: 1_000n, bounce: false },
      { to: OTHER, value: 2_000n, bounce: false },
    ];
    const request = wallet.createExternalRequest({ seqno: 7, validUntil: 2_000_000_000, messages });
    const ours = loadMessage(Cell.fromBase64(request.boc).beginParse()).body;
    const theirs = contract.createTransfer({
      seqno: 7,
      timeout: 2_000_000_000,
      secretKey: keyPair.secretKey,
      sendMode: SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      messages: messages.map((m) => internal({ to: m.to, value: m.value, bounce: m.bounce })),
    });
    expect(ours.hash().equals(theirs.hash())).toBe(true);
    expect(tonWalletRequestFields(ours)).toEqual({ layout: 'legacy', walletId: contract.walletId, validUntil: 2_000_000_000, seqno: 7 });
    expect(new TonSignedTransaction({ chainId: CHAIN_ID_TON_MAINNET, boc: request.boc })).toMatchObject({
      walletAddress: wallet.address,
      seqno: 7,
      validUntil: 2_000_000_000,
      txHash: request.hash,
    });
  });

  it('keeps each message its own send mode on v3r2 / v4r2', () => {
    const wallet = TonWallet.fromMnemonic(MNEMONIC, { version: 'v4r2' });
    const request = wallet.createExternalRequest({
      seqno: 1,
      messages: [
        { to: OTHER, value: 1n, mode: SendMode.PAY_GAS_SEPARATELY },
        { to: OTHER, value: 0n, mode: SendMode.CARRY_ALL_REMAINING_BALANCE },
      ],
    });
    const slice = loadMessage(Cell.fromBase64(request.boc).beginParse()).body.beginParse();
    slice.skip(512 + 96 + 8);
    expect([slice.loadUint(8), slice.loadUint(8)]).toEqual([
      SendMode.PAY_GAS_SEPARATELY | SendMode.IGNORE_ERRORS,
      SendMode.CARRY_ALL_REMAINING_BALANCE | SendMode.IGNORE_ERRORS,
    ]);
  });

  it(`refuses more than ${TON_LEGACY_MAX_MESSAGES} messages on v3r2 / v4r2`, () => {
    const messages = Array.from({ length: TON_LEGACY_MAX_MESSAGES + 1 }, () => ({ to: OTHER, value: 1n }));
    expect(() => TonWallet.fromMnemonic(MNEMONIC, { version: 'v4r2' }).createExternalRequest({ seqno: 0, messages })).toThrow(/at most 4/);
    expect(() => TonWallet.fromMnemonic(MNEMONIC, { version: 'v3r2' }).createExternalRequest({ seqno: 0, messages })).toThrow(/at most 4/);
  });

  it('tells a W5 body from a v3r2 / v4r2 one', () => {
    const w5 = TonWallet.fromMnemonic(MNEMONIC);
    const body = loadMessage(Cell.fromBase64(w5.createExternalRequest({ seqno: 3, validUntil: 2_000_000_001, messages: [{ to: OTHER, value: 1n }] }).boc).beginParse()).body;
    expect(body.bits.length % 8).not.toBe(0);
    expect(tonWalletRequestFields(body)).toMatchObject({ layout: 'w5', seqno: 3, validUntil: 2_000_000_001 });
  });

  describe('gasless (relayed) requests are W5 only', () => {
    it.each(['v3r2', 'v4r2'] as const)('refuses to sign one on %s', (version) => {
      const wallet = TonWallet.fromMnemonic(MNEMONIC, { version });
      expect(() => wallet.createInternalRequest({ seqno: 0, messages: [{ to: OTHER, value: 1n }] })).toThrow(
        expect.objectContaining({ kind: ChainErrorKinds.FeatureNotSupported }),
      );
    });

    it('refuses to relay to a v3r2 / v4r2 wallet', () => {
      const request = TonWallet.fromMnemonic(MNEMONIC).createInternalRequest({ seqno: 0, messages: [{ to: OTHER, value: 1n }] });
      const v4 = TonWallet.fromMnemonic(MNEMONIC, { version: 'v4r2' });
      expect(() => tonRelayMessage({ wallet: v4, request, value: 1n, deploy: false })).toThrow(/Only W5/);
      expect(tonRelayMessage({ wallet: TonWallet.fromMnemonic(MNEMONIC), request, value: 1n, deploy: false }).to).toBe(TonWallet.fromMnemonic(MNEMONIC).address);
    });
  });

  it('signs a v4r2 transfer through the chain, deploying at seqno 0', async () => {
    const wallet = TonWallet.fromMnemonic(MNEMONIC, { version: 'v4r2' });
    const provider = {
      name: 'fake',
      getSeqno: async () => 0,
      getAccountState: async (): Promise<TonAccountState> => ({ status: 'nonexist', balance: 0n, codeHash: null }),
      getJettonContent: async () => usdtJettonContent(),
    } as unknown as TonProvider;
    const chain = new TonChain({ chainId: CHAIN_ID_TON_MAINNET, name: 'TON', explorerUrl: 'https://tonviewer.com', toncenter: { url: 'https://x' }, provider });
    const transaction = new TonUnsignedTransaction({ chainId: CHAIN_ID_TON_MAINNET, walletAddress: wallet.address, messages: [{ to: OTHER, value: 5n }] });
    const signed = await wallet.signTransaction(transaction, chain);
    const message = loadMessage(Cell.fromBase64(signed.boc).beginParse());
    expect(message.init?.code?.hash().equals(wallet.stateInit.code?.hash() as Buffer)).toBe(true);
    expect(signed).toMatchObject({ walletAddress: wallet.address, seqno: 0 });
  });

  describe("reads v3r2 / v4r2 refusals of a broadcast by their check order", () => {
    const refused = (exitCode: number) =>
      tonBroadcastReply(
        'P',
        Promise.reject(new TonProviderError(ChainErrorKinds.RpcError, `cannot apply external message to current state : exitcode=${exitCode}, steps=1`, true)),
      );
    it('seqno moved (33): NonceTooLow', async () => {
      await expect(refused(33)).rejects.toMatchObject({ kind: ChainErrorKinds.NonceTooLow });
    });
    it.each([35, 36])('expired, checked first (%i): it may have landed, so uncertain', async (code) => {
      await expect(refused(code)).rejects.toBeInstanceOf(TonBroadcastUncertainError);
    });
    it('refused before running (an account that cannot pay): it may have landed, so uncertain', async () => {
      // TON Center's reply, as observed on mainnet for a resend to an emptied v4r2 wallet.
      const reply =
        'TON Center /api/v3/message answered HTTP 500: {"error":"LITE_SERVER_UNKNOWN: cannot apply external message to current state : inbound external message rejected by account 1719D87EF8DB748709D11CF9D26C4B7774400B268903C01CBA098964AB57ED80 before smart-contract execution"}';
      await expect(tonBroadcastReply('P', Promise.reject(new TonProviderError(ChainErrorKinds.RpcError, reply, true)))).rejects.toBeInstanceOf(
        TonBroadcastUncertainError,
      );
    });

    it('wallet id (34), after the seqno matched: definitely refused', async () => {
      await expect(refused(34)).rejects.toMatchObject({ kind: ChainErrorKinds.BroadcastRejected });
    });
  });
});
