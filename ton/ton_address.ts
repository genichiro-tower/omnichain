import { NetworkType } from '../network_type.ts';

import { Address } from '../address.ts';

const TON_USER_FRIENDLY_REGEX = /^[A-Za-z0-9_-]{48}$/;
const TON_RAW_REGEX = /^(-?\d+):([a-fA-F0-9]{64})$/;
const USER_FRIENDLY_BYTE_LENGTH = 36;
const CRC_POLYNOMIAL = 0x1021;
const FLAG_BOUNCEABLE = 0x11;
const FLAG_NON_BOUNCEABLE = 0x51;
const FLAG_TEST_ONLY = 0x80;

export interface TonUserFriendlyOptions {
  /** `EQ…` when true (the default), `UQ…` when false. */
  bounceable?: boolean;
  /** Sets the test-only flag (`kQ…` / `0Q…`). */
  testOnly?: boolean;
}

interface ParsedTonAddress {
  workchain: number;
  hash: Buffer;
  /** `null` for the raw form, which carries no flags. */
  bounceable: boolean | null;
  testOnly: boolean;
}

/**
 * A TON address in any of its forms: raw `<workchain>:<64 hex>` or the 48-char
 * user-friendly base64url form. `canonical()` is the raw form with a lowercase
 * hash, so every form of one account compares equal.
 *
 * Self-contained (no `@ton/core`) so the root entry keeps loading no TON
 * dependency.
 */
export class TonAddress extends Address {
  readonly #parsed: ParsedTonAddress;

  constructor(raw: string) {
    super(raw);
    this.#parsed = TonAddress.parse(raw);
  }

  canonical(): string {
    return `${this.#parsed.workchain}:${this.#parsed.hash.toString('hex')}`;
  }

  get networkType(): NetworkType {
    return NetworkType.TON;
  }

  get workchain(): number {
    return this.#parsed.workchain;
  }

  /** The flag the input carried; `null` for a raw address, which has none. */
  get isBounceable(): boolean | null {
    return this.#parsed.bounceable;
  }

  get isTestOnly(): boolean {
    return this.#parsed.testOnly;
  }

  toUserFriendly(opts: TonUserFriendlyOptions = {}): string {
    const bounceable = opts.bounceable ?? true;
    let tag = bounceable ? FLAG_BOUNCEABLE : FLAG_NON_BOUNCEABLE;
    if (opts.testOnly === true) tag |= FLAG_TEST_ONLY;
    const bytes = Buffer.alloc(USER_FRIENDLY_BYTE_LENGTH);
    bytes[0] = tag;
    bytes[1] = this.#parsed.workchain & 0xff;
    this.#parsed.hash.copy(bytes, 2);
    bytes.writeUInt16BE(crc16CcittXmodem(bytes.subarray(0, 34)), 34);
    return bytes.toString('base64url');
  }

  private static parse(raw: string): ParsedTonAddress {
    if (typeof raw !== 'string') {
      throw new Error(`Invalid TON address: not a string`);
    }
    const rawMatch = TON_RAW_REGEX.exec(raw);
    if (rawMatch !== null) {
      const workchain = Number(rawMatch[1]);
      if (!Number.isSafeInteger(workchain) || workchain < -128 || workchain > 127) {
        throw new Error(`Invalid TON address workchain: "${raw}"`);
      }
      return { workchain, hash: Buffer.from(rawMatch[2], 'hex'), bounceable: null, testOnly: false };
    }
    if (TON_USER_FRIENDLY_REGEX.test(raw)) return TonAddress.parseUserFriendly(raw);
    throw new Error(`Invalid TON address: "${raw}"`);
  }

  private static parseUserFriendly(userFriendly: string): ParsedTonAddress {
    const bytes = Buffer.from(userFriendly, 'base64url');
    if (bytes.length !== USER_FRIENDLY_BYTE_LENGTH) {
      throw new Error(`Invalid TON address: "${userFriendly}"`);
    }
    const claimedCrc = bytes.readUInt16BE(34);
    if (claimedCrc !== crc16CcittXmodem(bytes.subarray(0, 34))) {
      throw new Error(`Invalid TON address checksum: "${userFriendly}"`);
    }
    const testOnly = (bytes[0] & FLAG_TEST_ONLY) !== 0;
    const tag = bytes[0] & ~FLAG_TEST_ONLY;
    if (tag !== FLAG_BOUNCEABLE && tag !== FLAG_NON_BOUNCEABLE) {
      throw new Error(`Invalid TON address flags: "${userFriendly}"`);
    }
    return {
      workchain: bytes.readInt8(1),
      hash: Buffer.from(bytes.subarray(2, 34)),
      bounceable: tag === FLAG_BOUNCEABLE,
      testOnly,
    };
  }
}

/** The canonical raw form (`0:<lowercase hex>`) of any TON address form. */
export function tonRawAddress(address: string): string {
  return new TonAddress(address).canonical();
}

/** The user-friendly form of any TON address form; bounceable unless told otherwise. */
export function tonUserFriendlyAddress(address: string, opts: TonUserFriendlyOptions = {}): string {
  return new TonAddress(address).toUserFriendly(opts);
}

function crc16CcittXmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc =
        (crc & 0x8000) !== 0 ? ((crc << 1) ^ CRC_POLYNOMIAL) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}
