import { readFileSync } from 'node:fs';

import { jest } from '@jest/globals';

import { Cell, beginCell, contractAddress, storeStateInit, type StateInit } from '@ton/core';
import { keyPairFromSeed, sign } from '@ton/crypto';

import { ChainErrorKinds } from '../../errors.ts';
import { TonAddress } from '../ton_address.ts';
import { TonChain } from '../ton_chain.ts';
import {
  TON_WALLET_TG_TRAMPOLINE_CODE_HASH,
  type TonProofInput,
  type TonProofOptions,
  tonProofDigest,
  verifyTonProof,
} from '../ton_proof.ts';
import { type TonAccountState, type TonProvider, TonProviderError } from '../ton_provider.ts';
import { TON_WALLET_VERSIONS, tonWalletContract } from '../ton_wallet_contracts.ts';

type Recorded = TonProofInput & { publicKey: string };
const recorded = JSON.parse(readFileSync(new URL('./fixtures/ton_proofs.json', import.meta.url), 'utf8')) as Record<
  'v4r2_mainnet' | 'v3r1_mainnet' | 'w5beta_testnet',
  Recorded
>;

const optsFor = (input: TonProofInput, overrides: Partial<TonProofOptions> = {}): TonProofOptions => ({
  expectedDomain: input.proof.domain.value,
  expectedPayload: input.proof.payload,
  now: new Date((Number(input.proof.timestamp) + 30) * 1000),
  ...overrides,
});

const noProvider = (): TonProvider => {
  throw new Error('a fixed-key wallet reads nothing from the chain');
};

const verify = (input: TonProofInput, overrides: Partial<TonProofOptions> = {}, provider = noProvider) =>
  verifyTonProof(input, optsFor(input, overrides), provider);

const bocOf = (init: StateInit): string => beginCell().store(storeStateInit(init)).endCell().toBoc().toString('base64');

/** A proof signed by `secretKey` for the account `init` deploys. */
function signedProof(init: StateInit, secretKey: Buffer, at = 1_800_000_000): TonProofInput {
  const address = new TonAddress(contractAddress(0, init).toRawString());
  const domain = 'dashboard.example';
  const payload = 'nonce-0123456789abcdef';
  return {
    address: address.canonical(),
    network: '-239',
    proof: {
      timestamp: at,
      domain: { lengthBytes: Buffer.byteLength(domain), value: domain },
      payload,
      signature: sign(tonProofDigest(address, domain, at, payload), secretKey).toString('base64'),
      stateInit: bocOf(init),
    },
  };
}

describe('ton_proof recorded from real wallets', () => {
  it('verifies a mainnet v4r2 proof and returns its key', async () => {
    const input = recorded.v4r2_mainnet;
    await expect(verify(input)).resolves.toEqual({ ok: true, publicKey: input.publicKey, version: 'v4r2' });
  });

  it.each([
    ['v3r1', recorded.v3r1_mainnet],
    // A testnet proof from W5 beta, its network set aside: the pre-release W5, not v5r1.
    ['W5 beta', { ...recorded.w5beta_testnet, network: '-239' }],
  ])('refuses a wallet version it does not build (%s)', async (_label, input) => {
    await expect(verify(input)).resolves.toEqual({ ok: false, reason: 'unsupported_wallet' });
  });

  it("verifies through a TonChain that has no provider key, reading nothing from the chain", async () => {
    const input = recorded.v4r2_mainnet;
    const chain = new TonChain({ chainId: -4000, name: 'TON', explorerUrl: 'https://tonviewer.com', toncenter: { url: 'https://toncenter.com', apiKey: '' } });
    await expect(chain.verifyTonProof(input, optsFor(input))).resolves.toMatchObject({ ok: true, version: 'v4r2' });
  });

  it('refuses a testnet proof', async () => {
    await expect(verify(recorded.w5beta_testnet)).resolves.toEqual({ ok: false, reason: 'network' });
  });
});

describe('ton_proof refusals, each with its reason and none thrown', () => {
  const input = recorded.v4r2_mainnet;
  const ts = input.proof.timestamp as number;
  const withProof = (proof: Partial<TonProofInput['proof']>): TonProofInput => ({ ...input, proof: { ...input.proof, ...proof } });
  const flipped = Buffer.from(input.proof.signature, 'base64');
  flipped[10] ^= 1;

  it.each<[string, TonProofInput, Partial<TonProofOptions>, string]>([
    ['another domain', input, { expectedDomain: 'evil.example' }, 'domain'],
    ['a domain length that is not its UTF-8 length', withProof({ domain: { lengthBytes: 19, value: input.proof.domain.value } }), {}, 'domain'],
    ['another payload', input, { expectedPayload: 'another-nonce' }, 'payload'],
    ['a proof older than the window', input, { now: new Date((ts + 601) * 1000) }, 'expired'],
    ['a proof from too far in the future', input, { now: new Date((ts - 61) * 1000) }, 'expired'],
    ['a timestamp that is not a number', withProof({ timestamp: '17e8' }), {}, 'expired'],
    ['another account’s StateInit', withProof({ stateInit: recorded.v3r1_mainnet.proof.stateInit }), {}, 'address'],
    ['a StateInit that is no BOC', withProof({ stateInit: 'not-a-boc' }), {}, 'address'],
    ['a flipped signature byte', withProof({ signature: flipped.toString('base64') }), {}, 'signature'],
    ['a signature that is not 64 bytes', withProof({ signature: Buffer.alloc(63).toString('base64') }), {}, 'signature'],
    ['another reported key', { ...input, publicKey: 'ab'.repeat(32) }, {}, 'public_key'],
  ])('refuses %s', async (_label, proofInput, overrides, reason) => {
    await expect(verify(proofInput, overrides)).resolves.toEqual({ ok: false, reason });
  });

  it.each<[string, Partial<TonProofOptions>]>([
    ['an invalid now', { now: new Date('garbage') }],
    ['a NaN maxAgeSeconds', { maxAgeSeconds: Number.NaN }],
    ['an infinite maxAgeSeconds', { maxAgeSeconds: Number.POSITIVE_INFINITY }],
    ['a zero maxAgeSeconds', { maxAgeSeconds: 0 }],
  ])('throws for %s rather than leave the age unchecked', async (_label, overrides) => {
    await expect(verify(input, overrides)).rejects.toMatchObject({ kind: ChainErrorKinds.InvalidArgument });
  });

  it('accepts a decimal-string timestamp and a few seconds of wallet clock ahead', async () => {
    await expect(verify(withProof({ timestamp: String(ts) }), { now: new Date((ts - 30) * 1000) })).resolves.toMatchObject({ ok: true });
  });

  it('accepts a payload longer than a dapp may request, as a real wallet signed it', async () => {
    expect(Buffer.byteLength(input.proof.payload)).toBeGreaterThan(128);
    await expect(verify(input)).resolves.toMatchObject({ ok: true });
  });
});

describe('ton_proof from every fixed-key wallet version', () => {
  const keys = keyPairFromSeed(Buffer.alloc(32, 7));

  it.each(TON_WALLET_VERSIONS)('verifies a %s wallet’s proof', async (version) => {
    const input = signedProof(tonWalletContract(keys.publicKey, version).init, keys.secretKey);
    await expect(verify(input)).resolves.toEqual({ ok: true, publicKey: keys.publicKey.toString('hex'), version });
  });
});

describe('ton_proof from Telegram Wallet', () => {
  const TRAMPOLINE = Cell.fromBoc(Buffer.from('b5ee9c7241010101001a000030ff00209821d7498308b9f240df8085f833d0ed1e20ed53d969427e39', 'hex'))[0];
  const anchor = keyPairFromSeed(Buffer.alloc(32, 1));
  const live = keyPairFromSeed(Buffer.alloc(32, 2));
  // Storage revision, a zero word, the Telegram Money subwallet id, the anchor key.
  const init: StateInit = {
    code: TRAMPOLINE,
    data: beginCell().storeUint(0, 8).storeUint(0, 32).storeUint(0x7fff7f11, 32).storeBuffer(anchor.publicKey).endCell(),
  };
  const ACTIVE: TonAccountState = { status: 'active', balance: 1n, codeHash: TRAMPOLINE.hash().toString('base64') };

  function provider(state: TonAccountState | Error, key: bigint | Error = BigInt(`0x${live.publicKey.toString('hex')}`)) {
    const getAccountState = jest.fn(async () => {
      if (state instanceof Error) throw state;
      return state;
    });
    const getPublicKey = jest.fn(async () => {
      if (key instanceof Error) throw key;
      return key;
    });
    return { provider: () => ({ getAccountState, getPublicKey }) as unknown as TonProvider, getAccountState, getPublicKey };
  }

  it('is the code TonConnect names', () => {
    expect(TRAMPOLINE.hash().toString('hex')).toBe(TON_WALLET_TG_TRAMPOLINE_CODE_HASH);
  });

  it('verifies with the live key, though the StateInit holds another, reading it afresh', async () => {
    const input = signedProof(init, live.secretKey);
    const p = provider(ACTIVE);
    await expect(verify(input, {}, p.provider)).resolves.toEqual({ ok: true, publicKey: live.publicKey.toString('hex'), version: 'wallet_tg' });
    await verify(input, {}, p.provider);
    expect(p.getPublicKey).toHaveBeenCalledTimes(2);
  });

  it('refuses a proof signed by the stale anchor key', async () => {
    await expect(verify(signedProof(init, anchor.secretKey), {}, provider(ACTIVE).provider)).resolves.toEqual({ ok: false, reason: 'signature' });
  });

  it.each<[string, TonAccountState]>([
    ['an account that is not active', { ...ACTIVE, status: 'uninit' }],
    ['an account running other code', { ...ACTIVE, codeHash: Buffer.alloc(32).toString('base64') }],
  ])('refuses %s, without reading its key', async (_label, state) => {
    const p = provider(state);
    await expect(verify(signedProof(init, live.secretKey), {}, p.provider)).resolves.toEqual({ ok: false, reason: 'unsupported_wallet' });
    expect(p.getPublicKey).not.toHaveBeenCalled();
  });

  it('answers provider for a read that may succeed on a retry, and unsupported_wallet for a definite one', async () => {
    const input = signedProof(init, live.secretKey);
    const retryable = new TonProviderError(ChainErrorKinds.RpcError, 'down', true);
    const definite = new TonProviderError(ChainErrorKinds.RpcError, 'no getter', false);
    await expect(verify(input, {}, provider(retryable).provider)).resolves.toEqual({ ok: false, reason: 'provider' });
    await expect(verify(input, {}, provider(ACTIVE, retryable).provider)).resolves.toEqual({ ok: false, reason: 'provider' });
    await expect(verify(input, {}, provider(ACTIVE, definite).provider)).resolves.toEqual({ ok: false, reason: 'unsupported_wallet' });
    await expect(verify(input, {}, provider(ACTIVE, 1n << 256n).provider)).resolves.toEqual({ ok: false, reason: 'unsupported_wallet' });
  });

  it('answers provider when the chain has no provider configured', async () => {
    const unconfigured = () => {
      throw new Error('a TON Center API key is required');
    };
    await expect(verify(signedProof(init, live.secretKey), {}, unconfigured)).resolves.toEqual({ ok: false, reason: 'provider' });
  });
});
