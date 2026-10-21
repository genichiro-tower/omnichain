import { Token } from '../token.ts';
import { tonRawAddress } from './ton_address.ts';

/**
 * Native TON (`identifier` undefined, 9 decimals) or a jetton, identified by
 * its master contract in canonical raw form.
 */
export class TonAsset extends Token {
  static readonly NATIVE_DECIMALS = 9;

  constructor(chainId: number, symbol: string, jettonMaster: string | null, decimals: number) {
    super(chainId, symbol, jettonMaster === null ? undefined : tonRawAddress(jettonMaster), decimals);
  }

  /** The jetton master's raw address, or `null` for native TON. */
  get jettonMaster(): string | null {
    return this.identifier ?? null;
  }
}
