import { createHash } from 'node:crypto';

import { signVerify } from '@ton/crypto';

import { TonAddress } from './ton_address.ts';
import { tonConnectBase64, tonConnectTimestamp, tonConnectWindow } from './ton_connect_time.ts';
import { tonPublicKeyOf } from './ton_wallet_contracts.ts';

/** A TonConnect `signData` result for a text payload, as the wallet returns it. */
export interface TonSignDataTextResult {
  /** ed25519, base64. */
  signature: string;
  /** The signing account, raw. */
  address: string;
  /** Unix seconds, as a number or a decimal string. */
  timestamp: number | string;
  /** The dApp's domain, as the wallet saw it. */
  domain: string;
  payload: { type: 'text'; text: string };
}

export interface TonSignDataOptions {
  /** The signer's key, 32 bytes or 64 hex characters: e.g. the one its `ton_proof` sign-in gave. */
  publicKey: Uint8Array | string;
  expectedAddress: string;
  expectedDomain: string;
  /** The text the dApp asked the wallet to sign. */
  expectedText: string;
  /** Default 600. */
  maxAgeSeconds?: number;
  now?: Date;
}

export type TonSignDataFailure = 'payload' | 'address' | 'domain' | 'expired' | 'signature';

export type TonSignDataResult = { ok: true } | { ok: false; reason: TonSignDataFailure };

/**
 * Verifies a TonConnect `signData` of a text payload against the key it should
 * be from. A TON address does not reveal its key, so the caller supplies it.
 * Never throws on what the wallet sent; throws `InvalidArgument` for a key or
 * options that are not usable.
 */
export function verifyTonSignData(result: TonSignDataTextResult, opts: TonSignDataOptions): TonSignDataResult {
  const publicKey = tonPublicKeyOf(opts.publicKey);
  const window = tonConnectWindow(opts.now, opts.maxAgeSeconds, 'verifyTonSignData');
  const expected = new TonAddress(opts.expectedAddress);

  if (result?.payload?.type !== 'text' || result.payload.text !== opts.expectedText) return { ok: false, reason: 'payload' };
  let address: TonAddress;
  try {
    address = new TonAddress(result.address);
  } catch {
    return { ok: false, reason: 'address' };
  }
  if (address.canonical() !== expected.canonical()) return { ok: false, reason: 'address' };
  if (result.domain !== opts.expectedDomain) return { ok: false, reason: 'domain' };
  const timestamp = tonConnectTimestamp(result.timestamp, window);
  if (timestamp === null) return { ok: false, reason: 'expired' };

  const signature = tonConnectBase64(result.signature);
  if (signature === null || signature.length !== 64) return { ok: false, reason: 'signature' };
  const digest = tonSignDataTextDigest(address, result.domain, timestamp, result.payload.text);
  return signVerify(digest, signature, publicKey) ? { ok: true } : { ok: false, reason: 'signature' };
}

/**
 * What a wallet signs for a `signData` text payload:
 * `sha256(0xffff ‖ "ton-connect/sign-data/" ‖ workchain (int32 BE) ‖ account
 * hash ‖ domain length (uint32 BE) ‖ domain ‖ timestamp (uint64 BE) ‖ "txt" ‖
 * text length (uint32 BE) ‖ text)`. A script without a wallet app signs this
 * with ed25519 to produce the same result.
 */
export function tonSignDataTextDigest(address: TonAddress, domain: string, timestamp: number, text: string): Buffer {
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(address.workchain);
  const domainBytes = Buffer.from(domain, 'utf8');
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32BE(domainBytes.length);
  const time = Buffer.alloc(8);
  time.writeBigUInt64BE(BigInt(timestamp));
  const textBytes = Buffer.from(text, 'utf8');
  const textLength = Buffer.alloc(4);
  textLength.writeUInt32BE(textBytes.length);
  const message = Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from('ton-connect/sign-data/', 'utf8'),
    workchain,
    Buffer.from(address.canonical().split(':')[1], 'hex'),
    domainLength,
    domainBytes,
    time,
    Buffer.from('txt', 'utf8'),
    textLength,
    textBytes,
  ]);
  return createHash('sha256').update(message).digest();
}
