import { createHash } from 'node:crypto';

import { Cell, beginCell, loadMessage } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';

import { mnemonicNew, mnemonicToPrivateKey, signVerify } from '@ton/crypto';

import { TON_PYTHON_MARKER_PATH, TonWallet, deriveSlip10Ed25519Seed } from '../ton_wallet.ts';
import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { TonSignedMessage, tonInternalRequestOf, tonMessageHash, tonW5RequestFields } from '../ton_messages.ts';
import { TonChain } from '../ton_chain.ts';
import { TronSignedMessage } from '../../tron/tron_chain.ts';
import { TonSignedTransaction, tonExternalBocHash } from '../ton_transactions.ts';

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const W5_SIGNED_EXTERNAL_OP = 0x7369676e;
const W5_SIGNED_INTERNAL_OP = 0x73696e74;

describe('SLIP-0010 ed25519', () => {
  // SLIP-0010 test vector 1 for ed25519.
  const seed = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');

  it('matches the specification vectors', () => {
    expect(deriveSlip10Ed25519Seed(seed, []).toString('hex')).toBe(
      '2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7',
    );
    expect(deriveSlip10Ed25519Seed(seed, [0]).toString('hex')).toBe(
      '68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3',
    );
    expect(deriveSlip10Ed25519Seed(seed, [0, 1]).toString('hex')).toBe(
      'b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2',
    );
  });
});

describe('TonWallet', () => {
  // SLIP-0010 account 0: the derivation a path selects.
  const wallet = TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath() });

  it("derives the W5R1 wallet of m/44'/607'/<account>'", () => {
    expect(WalletContractV5R1.create({ workchain: 0, publicKey: wallet.publicKey }).address.toRawString()).toBe(
      wallet.address,
    );
    expect(TonWallet.derivationPath({ account: 3 })).toBe("m/44'/607'/3'");
    const second = TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath({ account: 1 }) });
    expect(second.address).not.toBe(wallet.address);
    expect(TonWallet.fromMnemonic(MNEMONIC, { derivationPath: "m/44'/607'/0'" }).address).toBe(wallet.address);
  });

  it('gives fixed addresses for the BIP-39 test vector (AC2)', () => {
    // Computed independently of this code; a change in the passphrase, coin type or W5R1 code cell moves them.
    expect(wallet.address).toBe('0:47caefa86550c7458435fab2a51aaa47cb9c80a9a9cf062ac440d30d3a67c72e');
    expect(TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath({ account: 1 }) }).address).toBe(
      '0:287246fae4df4daab7991eb61f862a46f7843f8196130645749af6a8a4b104cc',
    );
  });

  it('gives the non-bounceable form for deposits', () => {
    expect(wallet.addressUserFriendly({ bounceable: false }).startsWith('UQ')).toBe(true);
  });

  it('refuses a non-hardened or foreign derivation path', () => {
    expect(() => TonWallet.fromMnemonic(MNEMONIC, { derivationPath: "m/44'/607'/1'/0/0" })).toThrow(/derivation path/);
    expect(() => TonWallet.fromMnemonic(MNEMONIC, { derivationPath: "m/44'/195'/0'" })).toThrow(/derivation path/);
  });

  describe("without a path: TON's own scheme, the Python SDK's account", () => {
    // Computed by the Python SDK (omnichain 0.0.3, TonWallet.from_mnemonic(phrase, version='v5r1')).
    // The 24-word phrase was generated for this test and has never held funds.
    const PYTHON_VECTORS = [
      {
        phrase: MNEMONIC,
        publicKey: 'af19469000fc85b42ef8800249debdaf430dc91da21f45a7da137f51062cdc91',
        address: '0:7b018a245a15b9a3002d4f23a24dae92c220fcb221de347a35a0b50b2960aa7d',
      },
      {
        phrase: 'gospel cheap myth general inmate reduce board mango syrup lizard check sunset produce uniform crucial month theory spy occur crystal infant riot peace engine',
        publicKey: '50d86d7bdb559ee34d3ed8360f38bef92684a82fed621e272909d4bb0bb14292',
        address: '0:e05ecac2bdf64a8f3feaa541248a368a66d0febd74c65ad23f4ec004292e7c80',
      },
    ];

    it.each(PYTHON_VECTORS)('gives the Python SDK key and W5 address for $address', ({ phrase, publicKey, address }) => {
      const native = TonWallet.fromMnemonic(phrase);
      expect(native.publicKey.toString('hex')).toBe(publicKey);
      expect(native.address).toBe(address);
      // Python's marker path is the same account, and so is the phrase with other spacing and case.
      expect(TonWallet.fromMnemonic(phrase, { derivationPath: TON_PYTHON_MARKER_PATH }).address).toBe(address);
      expect(TonWallet.fromMnemonic(`  ${phrase.toUpperCase().split(' ').join('   ')}\n`).address).toBe(address);
    });

    it("matches @ton/crypto's mnemonicToPrivateKey on a fresh TON mnemonic", async () => {
      const words = await mnemonicNew(24);
      const expected = await mnemonicToPrivateKey(words);
      expect(TonWallet.fromMnemonic(words.join(' ')).publicKey.equals(expected.publicKey)).toBe(true);
    });

    it("is not a path's account: m/44'/607'/0' keeps the BIP-39 / SLIP-0010 derivation", () => {
      expect(TonWallet.fromMnemonic(MNEMONIC).address).not.toBe(wallet.address);
      expect(wallet.address).toBe('0:47caefa86550c7458435fab2a51aaa47cb9c80a9a9cf062ac440d30d3a67c72e');
    });

    it('refuses a passphrase, which the Python SDK ignores, and takes one with a path', () => {
      expect(() => TonWallet.fromMnemonic(MNEMONIC, { passphrase: 'x' })).toThrow(/passphrase/);
      expect(() => TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TON_PYTHON_MARKER_PATH, passphrase: 'x' })).toThrow(/passphrase/);
      expect(TonWallet.fromMnemonic(MNEMONIC, { passphrase: '' }).address).toBe(PYTHON_VECTORS[0].address);
      expect(TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath(), passphrase: 'x' }).address).not.toBe(wallet.address);
    });

    it('refuses an empty mnemonic', () => {
      expect(() => TonWallet.fromMnemonic('   ')).toThrow(/empty/);
    });
  });

  it('builds an external request, with its StateInit while undeployed', () => {
    const request = wallet.createExternalRequest({
      seqno: 0,
      validUntil: 2_000_000_000,
      deploy: true,
      messages: [{ to: wallet.address, value: 1n }],
    });
    const message = loadMessage(Cell.fromBase64(request.boc).beginParse());
    expect(message.info.type).toBe('external-in');
    expect(message.init?.code?.equals(wallet.stateInit.code as Cell)).toBe(true);
    expect(message.body.beginParse().loadUint(32)).toBe(W5_SIGNED_EXTERNAL_OP);
    expect(request.hash).toBe(tonExternalBocHash(request.boc));
    expect(request.validUntil).toBe(2_000_000_000);

    const deployed = wallet.createExternalRequest({ seqno: 4, validUntil: 2_000_000_000, messages: [{ to: wallet.address, value: 1n }] });
    expect(loadMessage(Cell.fromBase64(deployed.boc).beginParse()).init).toBeNull();
  });

  it('builds a signed internal request for a relayer', () => {
    const request = wallet.createInternalRequest({ seqno: 2, validUntil: 2_000_000_000, messages: [{ to: wallet.address, value: 5n }] });
    expect(request.body.beginParse().loadUint(32)).toBe(W5_SIGNED_INTERNAL_OP);
    expect(request).toMatchObject({ seqno: 2, validUntil: 2_000_000_000 });
    // What it commits to can be read back from the signed body alone, e.g. one found in a trace.
    expect(tonInternalRequestOf(request.body)).toEqual(request);
    expect(tonW5RequestFields(request.body)).toMatchObject({ authType: 'internal', seqno: 2, validUntil: 2_000_000_000 });
  });

  it('keeps what a signed external request commits to, through JSON too', () => {
    const request = wallet.createExternalRequest({ seqno: 7, validUntil: 2_000_000_123, messages: [{ to: wallet.address, value: 1n }] });
    const signed = new TonSignedTransaction({ chainId: CHAIN_ID_TON_MAINNET, boc: request.boc });
    expect(signed).toMatchObject({ walletAddress: wallet.address, seqno: 7, validUntil: 2_000_000_123, txHash: request.hash });
    const restored = TonSignedTransaction.fromJson(JSON.stringify(signed.toJson()));
    expect(restored).toMatchObject({ chainId: CHAIN_ID_TON_MAINNET, walletAddress: wallet.address, seqno: 7, validUntil: 2_000_000_123, txHash: request.hash });
    expect(signed.toJson()).toEqual({ type: 'TonSignedTransaction', chain_id: CHAIN_ID_TON_MAINNET, boc: request.boc });
  });

  it('refuses to read an external request as an internal one, and anything that is not a W5 request', () => {
    const external = wallet.createExternalRequest({ seqno: 1, messages: [{ to: wallet.address, value: 1n }] });
    const externalBody = loadMessage(Cell.fromBase64(external.boc).beginParse()).body;
    expect(() => tonInternalRequestOf(externalBody)).toThrow(/it is an external one/);
    expect(() => tonW5RequestFields(beginCell().storeUint(0, 32).endCell())).toThrow(/Not a signed W5 request/);
  });

  it('refuses an empty request and one over 255 messages', () => {
    expect(() => wallet.createInternalRequest({ seqno: 0, messages: [] })).toThrow(/1 to 255/);
    const tooMany = Array.from({ length: 256 }, () => ({ to: wallet.address, value: 1n }));
    expect(() => wallet.createInternalRequest({ seqno: 0, messages: tooMany })).toThrow(/1 to 255/);
  });

  it('signs and verifies messages', () => {
    const signed = wallet.signMessage('hello');
    expect(wallet.verifySignature('hello', signed)).toBe(true);
    expect(wallet.verifySignature('hellO', signed)).toBe(false);
    const empty = wallet.signMessage('');
    expect(wallet.verifySignature('', empty)).toBe(true);
    expect(wallet.verifySignature(' ', empty)).toBe(false);
  });

  describe('TonChain.verifySignature, with the public key only', () => {
    const signed = wallet.signMessage('hi');
    const publicKeyHex = wallet.publicKey.toString('hex');

    it('verifies against the public key as bytes or hex', () => {
      expect(TonChain.verifySignature(wallet.publicKey, 'hi', signed)).toBe(true);
      expect(TonChain.verifySignature(publicKeyHex, 'hi', signed)).toBe(true);
      expect(TonChain.verifySignature(publicKeyHex.toUpperCase(), 'hi', signed)).toBe(true);
    });

    it.each([
      ['trailing junk', `${signed.signature}zz-garbage`],
      ['a trailing hex byte (65 bytes)', `${signed.signature}00`],
      ['a missing byte (63 bytes)', signed.signature.slice(0, 126)],
      ['an odd length', signed.signature.slice(0, 127)],
      ['a 0x prefix', `0x${signed.signature}`],
      ['empty', ''],
    ])('refuses a signature with %s', (_case, signature) => {
      expect(TonChain.verifySignature(wallet.publicKey, 'hi', new TonSignedMessage(signature))).toBe(false);
    });

    it("refuses another wallet's signature", () => {
      const other = TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath({ account: 1 }) });
      expect(TonChain.verifySignature(wallet.publicKey, 'hi', other.signMessage('hi'))).toBe(false);
      expect(TonChain.verifySignature(other.publicKey, 'hi', other.signMessage('hi'))).toBe(true);
    });

    it('refuses a malformed public key and a signature of another family', () => {
      expect(() => TonChain.verifySignature(publicKeyHex.slice(2), 'hi', signed)).toThrow(/64 hex characters/);
      expect(() => TonChain.verifySignature(new Uint8Array(31), 'hi', signed)).toThrow(/32 bytes/);
      expect(() => TonChain.verifySignature(wallet.publicKey, 'hi', new TronSignedMessage(signed.signature))).toThrow(/TonSignedMessage/);
    });
  });

  it('never signs a message\'s own bytes, which could pass for a W5 request hash', () => {
    // W5 accepts a signature over a 32-byte cell hash; a 32-byte message must not yield one.
    const message = 'a'.repeat(32);
    const signed = wallet.signMessage(message);
    const signature = Buffer.from(signed.signature, 'hex');
    expect(signVerify(Buffer.from(message, 'utf8'), signature, wallet.publicKey)).toBe(false);
    expect(signVerify(tonMessageHash(message), signature, wallet.publicKey)).toBe(true);
    expect(tonMessageHash('hello').toString('hex')).toBe(
      createHash('sha256').update('TON Signed Message:\nhello').digest('hex'),
    );
  });
});
