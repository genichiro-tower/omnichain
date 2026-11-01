import { keyPairFromSeed } from '@ton/crypto';

import { ChainErrorKinds } from '../../errors.ts';
import { TonWallet, deriveTonNativeSeed } from '../ton_wallet.ts';
import { TON_WALLET_VERSIONS, tonWalletAddress, tonWalletAddresses } from '../ton_wallet_contracts.ts';
import { MNEMONIC } from './ton_test_helpers.ts';

describe('a wallet address from a public key', () => {
  it('gives the fixed addresses of the test phrase: the Python v4r2 one and the BIP-39 W5 one', () => {
    const pythonKey = keyPairFromSeed(deriveTonNativeSeed(MNEMONIC)).publicKey;
    expect(tonWalletAddress(pythonKey, 'v4r2')).toBe('0:6e55f7885c3f91f1a62c9bc3fd3d3e6cf8211d3bcdcecbdd0fa5c730de694943');
    const w5 = TonWallet.fromMnemonic(MNEMONIC, { derivationPath: TonWallet.derivationPath() });
    expect(tonWalletAddress(w5.publicKey, 'v5r1')).toBe('0:47caefa86550c7458435fab2a51aaa47cb9c80a9a9cf062ac440d30d3a67c72e');
  });

  it.each([0, -1] as const)('is the address TonWallet builds, in every version, on workchain %i', (workchain) => {
    for (const version of TON_WALLET_VERSIONS) {
      const wallet = TonWallet.fromMnemonic(MNEMONIC, { version, workchain });
      expect(tonWalletAddress(wallet.publicKey, version, { workchain })).toBe(wallet.address);
      expect(tonWalletAddress(wallet.publicKey.toString('hex'), version, { workchain })).toBe(wallet.address);
    }
  });

  it('gives one address per version', () => {
    const key = TonWallet.fromMnemonic(MNEMONIC).publicKey;
    const addresses = tonWalletAddresses(key);
    expect(Object.keys(addresses)).toEqual(['v3r2', 'v4r2', 'v5r1']);
    for (const version of TON_WALLET_VERSIONS) {
      expect(addresses[version]).toBe(TonWallet.fromMnemonic(MNEMONIC, { version }).address);
    }
  });

  it.each([
    ['a 31-byte key', Buffer.alloc(31)],
    ['63 hex characters', 'a'.repeat(63)],
    ['a non-hex string', 'z'.repeat(64)],
  ])('refuses %s', (_label, key) => {
    expect(() => tonWalletAddress(key, 'v5r1')).toThrow(expect.objectContaining({ kind: ChainErrorKinds.InvalidArgument }));
  });

  it('refuses an unknown version and workchain', () => {
    const key = Buffer.alloc(32, 1);
    expect(() => tonWalletAddress(key, 'v2r2' as never)).toThrow(/version must be one of/);
    expect(() => tonWalletAddress(key, 'v5r1', { workchain: 1 as never })).toThrow(/workchain 0 or -1/);
  });
});
