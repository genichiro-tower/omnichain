import { NetworkType } from '../../network_type.ts';

import { EvmAddress } from '../../evm/evm_address.ts';
import { TonAddress } from '../ton_address.ts';

const VALID_TON_RAW =
  '-1:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
const VALID_TON_USER_FRIENDLY = 'EQDrjaLahLkMB-hMCmkzOyBuHJ139ZUYmPHu6RRBKnbdLIYI';

describe('TonAddress', () => {
  it('accepts raw workchain:hex form and preserves it', () => {
    const address = new TonAddress(VALID_TON_RAW);
    expect(address.canonical()).toBe(VALID_TON_RAW);
  });

  it('accepts user-friendly base64url form', () => {
    expect(() => new TonAddress(VALID_TON_USER_FRIENDLY)).not.toThrow();
  });

  it('reports TON network type', () => {
    expect(new TonAddress(VALID_TON_RAW).networkType).toBe(NetworkType.TON);
  });

  it('rejects short strings', () => {
    expect(() => new TonAddress('EQabc')).toThrow();
  });

  it('rejects a user-friendly address with a broken CRC checksum', () => {
    const broken = `${VALID_TON_USER_FRIENDLY.slice(0, 46)}AA`;
    expect(() => new TonAddress(broken)).toThrow(/checksum/i);
  });

  it('does not consider an EVM and a TON value equal even when strings match', () => {
    const evm = new EvmAddress('0xabcdef0123456789abcdef0123456789abcdef01');
    const ton = new TonAddress(VALID_TON_RAW);
    expect(evm.equals(ton)).toBe(false);
  });
});

describe('TonAddress forms', () => {
  // One W5R1 account in its three forms (checked against @ton/core's Address).
  const RAW = '0:9d1e1843624c4d175a695a8c2de8a5a61f03b93336e8caa4e164bf6cbbab205e';
  const BOUNCEABLE = 'EQCdHhhDYkxNF1ppWowt6KWmHwO5MzboyqThZL9su6sgXsq8';
  const NON_BOUNCEABLE = 'UQCdHhhDYkxNF1ppWowt6KWmHwO5MzboyqThZL9su6sgXpd5';

  it('gives one canonical raw form for every form of one account', () => {
    for (const form of [RAW, RAW.toUpperCase(), BOUNCEABLE, NON_BOUNCEABLE]) {
      expect(new TonAddress(form).canonical()).toBe(RAW);
    }
    expect(new TonAddress(BOUNCEABLE).equals(new TonAddress(NON_BOUNCEABLE))).toBe(true);
  });

  it('converts to either user-friendly form', () => {
    const address = new TonAddress(RAW);
    expect(address.toUserFriendly()).toBe(BOUNCEABLE);
    expect(address.toUserFriendly({ bounceable: false })).toBe(NON_BOUNCEABLE);
  });

  it('reports the bounceable flag the input carried', () => {
    expect(new TonAddress(BOUNCEABLE).isBounceable).toBe(true);
    expect(new TonAddress(NON_BOUNCEABLE).isBounceable).toBe(false);
    expect(new TonAddress(RAW).isBounceable).toBeNull();
  });

  it('keeps the masterchain workchain through a round trip', () => {
    const masterchain = new TonAddress(VALID_TON_RAW);
    expect(new TonAddress(masterchain.toUserFriendly()).canonical()).toBe(VALID_TON_RAW);
  });

  it('round-trips the test-only flag', () => {
    const testOnly = new TonAddress(RAW).toUserFriendly({ bounceable: false, testOnly: true });
    expect(new TonAddress(testOnly).isTestOnly).toBe(true);
    expect(new TonAddress(testOnly).canonical()).toBe(RAW);
  });
});
