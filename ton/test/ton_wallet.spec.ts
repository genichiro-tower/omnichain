import { createHash } from 'node:crypto';

import { Cell, loadMessage } from '@ton/core';
import { WalletContractV5R1 } from '@ton/ton';

import { signVerify } from '@ton/crypto';

import { TonWallet, deriveSlip10Ed25519Seed, tonMessageHash } from '../ton_wallet.ts';
import { tonExternalBocHash } from '../ton_transactions.ts';

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
  const wallet = TonWallet.fromMnemonic(MNEMONIC);

  it("derives the W5R1 wallet of m/44'/607'/<account>'", () => {
    expect(WalletContractV5R1.create({ workchain: 0, publicKey: wallet.publicKey }).address.toRawString()).toBe(
      wallet.address,
    );
    expect(TonWallet.derivationPath({ account: 3 })).toBe("m/44'/607'/3'");
    const second = TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath({ account: 1 }) });
    expect(second.address).not.toBe(wallet.address);
    expect(TonWallet.fromMnemonic(MNEMONIC).address).toBe(wallet.address);
  });

  it('gives the non-bounceable form for deposits', () => {
    expect(wallet.addressUserFriendly({ bounceable: false }).startsWith('UQ')).toBe(true);
  });

  it('refuses a non-hardened or foreign derivation path', () => {
    expect(() => TonWallet.fromMnemonic(MNEMONIC, { derivationPath: "m/44'/607'/0'/0/0" })).toThrow(/derivation path/);
    expect(() => TonWallet.fromMnemonic(MNEMONIC, { derivationPath: "m/44'/195'/0'" })).toThrow(/derivation path/);
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
    expect(request.beginParse().loadUint(32)).toBe(W5_SIGNED_INTERNAL_OP);
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
