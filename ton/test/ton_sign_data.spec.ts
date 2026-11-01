import { readFileSync } from 'node:fs';

import { ChainErrorKinds } from '../../errors.ts';
import { TonAddress } from '../ton_address.ts';
import { verifyTonProof } from '../ton_proof.ts';
import { type TonSignDataOptions, type TonSignDataTextResult, verifyTonSignData } from '../ton_sign_data.ts';
import { TON_WALLET_VERSIONS } from '../ton_wallet_contracts.ts';
import { TonWallet } from '../ton_wallet.ts';
import { MNEMONIC } from './ton_test_helpers.ts';

const reference = JSON.parse(readFileSync(new URL('./fixtures/ton_sign_data.json', import.meta.url), 'utf8')) as {
  publicKey: string;
  vectors: TonSignDataTextResult[];
};

const optsFor = (result: TonSignDataTextResult, overrides: Partial<TonSignDataOptions> = {}): TonSignDataOptions => ({
  publicKey: reference.publicKey,
  expectedAddress: result.address,
  expectedDomain: result.domain,
  expectedText: result.payload.text,
  now: new Date((Number(result.timestamp) + 30) * 1000),
  ...overrides,
});

describe('signData text, signed by the reference implementation', () => {
  it.each(reference.vectors.map((v) => [v.payload.text, v] as const))('verifies %j', (_text, result) => {
    expect(verifyTonSignData(result, optsFor(result))).toEqual({ ok: true });
  });

  it('takes the expected address in any form', () => {
    const result = reference.vectors[0];
    const friendly = new TonAddress(result.address).toUserFriendly({ bounceable: false });
    expect(verifyTonSignData(result, optsFor(result, { expectedAddress: friendly }))).toEqual({ ok: true });
  });
});

describe('signData refusals, each with its reason and none thrown', () => {
  const result = reference.vectors[1];
  const flipped = Buffer.from(result.signature, 'base64');
  flipped[5] ^= 1;
  const other = TonWallet.fromMnemonic(MNEMONIC);

  it.each<[string, TonSignDataTextResult, Partial<TonSignDataOptions>, string]>([
    ['another text', result, { expectedText: 'Claim 900000' }, 'payload'],
    ['a binary payload', { ...result, payload: { type: 'binary', text: result.payload.text } as never }, {}, 'payload'],
    ['another account', result, { expectedAddress: other.address }, 'address'],
    ['an address that is not one', { ...result, address: 'nope' }, {}, 'address'],
    ['another domain', result, { expectedDomain: 'evil.example' }, 'domain'],
    ['a signature older than the window', result, { now: new Date((Number(result.timestamp) + 601) * 1000) }, 'expired'],
    ['a flipped signature byte', { ...result, signature: flipped.toString('base64') }, {}, 'signature'],
    ['another key', result, { publicKey: other.publicKey }, 'signature'],
  ])('refuses %s', (_label, signed, overrides, reason) => {
    expect(verifyTonSignData(signed, optsFor(result, overrides))).toEqual({ ok: false, reason });
  });

  it('refuses something that is not a result at all', () => {
    expect(verifyTonSignData(null as never, optsFor(result))).toEqual({ ok: false, reason: 'payload' });
  });

  it.each<[string, Partial<TonSignDataOptions>]>([
    ['a 31-byte key', { publicKey: Buffer.alloc(31) }],
    ['an invalid now', { now: new Date('garbage') }],
    ['a NaN maxAgeSeconds', { maxAgeSeconds: Number.NaN }],
  ])('throws for %s, a caller fault', (_label, overrides) => {
    expect(() => verifyTonSignData(result, optsFor(result, overrides))).toThrow(expect.objectContaining({ kind: ChainErrorKinds.InvalidArgument }));
  });
});

describe('signing without a wallet app', () => {
  it.each(TON_WALLET_VERSIONS)('a %s TonWallet signs text that verifies with its key', (version) => {
    const wallet = TonWallet.fromMnemonic(MNEMONIC, { version });
    const signed = wallet.signTextData({ text: 'Claim 500000', domain: 'dashboard.example', timestamp: 1_800_000_000 });
    const opts = { publicKey: wallet.publicKey, expectedAddress: wallet.address, expectedDomain: 'dashboard.example', expectedText: 'Claim 500000', now: new Date(1_800_000_010_000) };
    expect(verifyTonSignData(signed, opts)).toEqual({ ok: true });
  });

  it.each(TON_WALLET_VERSIONS)('a %s TonWallet signs in with a ton_proof that verifies', async (version) => {
    const wallet = TonWallet.fromMnemonic(MNEMONIC, { version });
    const input = wallet.signTonProof({ domain: 'dashboard.example', payload: 'nonce-1', timestamp: 1_800_000_000 });
    const opts = { expectedDomain: 'dashboard.example', expectedPayload: 'nonce-1', now: new Date(1_800_000_010_000) };
    await expect(verifyTonProof(input, opts, () => { throw new Error('no chain read'); })).resolves.toEqual({
      ok: true,
      publicKey: wallet.publicKey.toString('hex'),
      version,
    });
  });
});
