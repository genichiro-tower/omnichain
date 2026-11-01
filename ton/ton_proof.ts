import { createHash } from 'node:crypto';

import { Cell, type StateInit, contractAddress, loadStateInit } from '@ton/core';
import { signVerify } from '@ton/crypto';

import { TonAddress } from './ton_address.ts';
import { tonConnectBase64, tonConnectTimestamp, tonConnectWindow } from './ton_connect_time.ts';
import type { TonWalletVersion } from './ton_messages.ts';
import { type TonProvider, TonProviderError } from './ton_provider.ts';
import { TON_WALLET_VERSIONS, tonWalletContract } from './ton_wallet_contracts.ts';

/** TonConnect's id for TON mainnet; a proof names the network it was made on. */
export const TON_CONNECT_MAINNET = '-239';

/** Telegram Wallet's in-app wallet: a trampoline contract whose key can rotate. */
export const TON_WALLET_TG_TRAMPOLINE_CODE_HASH = '9149ae51c1e4689710cebf7830297b16acfbadb363a920a537893e7ffeeca768';

const MAX_PUBLIC_KEY = (1n << 256n) - 1n;

/** A TonConnect `ton_proof` sign-in, as the dashboard receives it from the wallet. */
export interface TonProofInput {
  /** The connected account, in any form. */
  address: string;
  /** TonConnect's network id (`account.chain`): `-239` for mainnet. */
  network: string;
  proof: {
    /** Unix seconds, as a number or a decimal string. */
    timestamp: number | string;
    domain: { lengthBytes: number; value: string };
    /** ed25519, base64. */
    signature: string;
    payload: string;
    /** The account's StateInit (`walletStateInit`), a base64 BOC. */
    stateInit: string;
  };
  /** The key the wallet reported, if any: it must be the proof's. */
  publicKey?: string;
}

export interface TonProofOptions {
  /** The host the sign-in page is served from. */
  expectedDomain: string;
  /** The challenge the backend issued for this sign-in. */
  expectedPayload: string;
  /** Default 600. */
  maxAgeSeconds?: number;
  now?: Date;
}

/** A fixed-key wallet version, or Telegram Wallet's trampoline. */
export type TonProofWallet = TonWalletVersion | 'wallet_tg';

export type TonProofFailure =
  | 'network'
  | 'domain'
  | 'expired'
  | 'payload'
  | 'address'
  | 'unsupported_wallet'
  | 'public_key'
  | 'signature'
  /** The chain could not be read; the same proof may verify on a retry. */
  | 'provider';

export type TonProofResult =
  | { ok: true; publicKey: string; version: TonProofWallet }
  | { ok: false; reason: TonProofFailure };

/**
 * Verifies a TonConnect `ton_proof` by TonConnect's rules: the network, the
 * domain, the age and the payload; the StateInit is the account's; the key is
 * read from a known wallet's StateInit, or for Telegram Wallet from its live
 * account; and the signature is that key's. Never throws on what the wallet
 * sent; throws `InvalidArgument` for options that would leave the age unchecked.
 *
 * `provider` is only called for Telegram Wallet.
 */
export async function verifyTonProof(
  input: TonProofInput,
  opts: TonProofOptions,
  provider: () => TonProvider,
): Promise<TonProofResult> {
  const window = tonConnectWindow(opts.now, opts.maxAgeSeconds, 'verifyTonProof');

  const { proof } = input;
  if (String(input.network) !== TON_CONNECT_MAINNET) return fail('network');

  if (proof.domain?.value !== opts.expectedDomain || proof.domain.lengthBytes !== Buffer.byteLength(proof.domain.value, 'utf8')) {
    return fail('domain');
  }

  const timestamp = tonConnectTimestamp(proof.timestamp, window);
  if (timestamp === null) return fail('expired');

  // TonConnect caps what a dapp may request; what was signed is bound by being the issued payload.
  if (proof.payload !== opts.expectedPayload) return fail('payload');

  const account = accountOf(input.address, proof.stateInit);
  if (account === null) return fail('address');

  const key = await keyOf(account, provider);
  if (!key.ok) return key;
  if (input.publicKey !== undefined && input.publicKey.toLowerCase() !== key.publicKey.toString('hex')) return fail('public_key');

  const signature = tonConnectBase64(proof.signature);
  if (signature === null || signature.length !== 64) return fail('signature');
  const digest = tonProofDigest(account.address, proof.domain.value, timestamp, proof.payload);
  if (!signVerify(digest, signature, key.publicKey)) return fail('signature');
  return { ok: true, publicKey: key.publicKey.toString('hex'), version: key.version };
}

/**
 * What a wallet signs for a `ton_proof`:
 * `sha256(0xffff ‖ "ton-connect" ‖ sha256(message))`, where `message` is
 * `"ton-proof-item-v2/"` ‖ workchain (int32 BE) ‖ account hash ‖ domain length
 * (uint32 LE) ‖ domain ‖ timestamp (uint64 LE) ‖ payload.
 */
export function tonProofDigest(address: TonAddress, domain: string, timestamp: number, payload: string): Buffer {
  const workchain = Buffer.alloc(4);
  workchain.writeInt32BE(address.workchain);
  const domainBytes = Buffer.from(domain, 'utf8');
  const domainLength = Buffer.alloc(4);
  domainLength.writeUInt32LE(domainBytes.length);
  const time = Buffer.alloc(8);
  time.writeBigUInt64LE(BigInt(timestamp));
  const message = Buffer.concat([
    Buffer.from('ton-proof-item-v2/', 'utf8'),
    workchain,
    Buffer.from(address.canonical().split(':')[1], 'hex'),
    domainLength,
    domainBytes,
    time,
    Buffer.from(payload, 'utf8'),
  ]);
  const inner = createHash('sha256').update(message).digest();
  return createHash('sha256').update(Buffer.from([0xff, 0xff])).update('ton-connect', 'utf8').update(inner).digest();
}

interface ProofAccount {
  address: TonAddress;
  stateInit: StateInit;
}

/** The account, when `stateInit` is the one its address is derived from. */
function accountOf(rawAddress: string, stateInitBoc: string): ProofAccount | null {
  try {
    const address = new TonAddress(rawAddress);
    const stateInit = loadStateInit(Cell.fromBase64(stateInitBoc).beginParse());
    if (stateInit.code == null || stateInit.data == null) return null;
    const derived = contractAddress(address.workchain, stateInit).toRawString();
    return derived === address.canonical() ? { address, stateInit } : null;
  } catch {
    return null;
  }
}

type KeyResult = { ok: true; publicKey: Buffer; version: TonProofWallet } | { ok: false; reason: TonProofFailure };

async function keyOf(account: ProofAccount, provider: () => TonProvider): Promise<KeyResult> {
  const codeHash = account.stateInit.code!.hash().toString('hex');
  const version = fixedKeyVersions().get(codeHash);
  if (version !== undefined) {
    try {
      // v3r2 / v4r2 data: seqno, wallet id, key; W5 data starts with its signature-allowed bit.
      const data = account.stateInit.data!.beginParse();
      data.skip(version === 'v5r1' ? 65 : 64);
      return { ok: true, publicKey: data.loadBuffer(32), version };
    } catch {
      return fail('unsupported_wallet');
    }
  }
  if (codeHash === TON_WALLET_TG_TRAMPOLINE_CODE_HASH) return trampolineKeyOf(account.address, provider);
  return fail('unsupported_wallet');
}

/**
 * Telegram Wallet's key can rotate, so the one in its StateInit may be stale:
 * the live account must run the trampoline, and its getter names the key.
 * Read afresh for every proof.
 */
async function trampolineKeyOf(address: TonAddress, provider: () => TonProvider): Promise<KeyResult> {
  const raw = address.canonical();
  try {
    const live = provider();
    const state = await live.getAccountState(raw);
    const codeHash = state.codeHash === null ? null : Buffer.from(state.codeHash, 'base64').toString('hex');
    if (state.status !== 'active' || codeHash !== TON_WALLET_TG_TRAMPOLINE_CODE_HASH) return fail('unsupported_wallet');
    const key = await live.getPublicKey(raw);
    if (key < 0n || key > MAX_PUBLIC_KEY) return fail('unsupported_wallet');
    return { ok: true, publicKey: Buffer.from(key.toString(16).padStart(64, '0'), 'hex'), version: 'wallet_tg' };
  } catch (err) {
    return fail(err instanceof TonProviderError && !err.retryable ? 'unsupported_wallet' : 'provider');
  }
}

let codeHashes: Map<string, TonWalletVersion> | null = null;

/** The code hash of every fixed-key wallet version this SDK builds. */
function fixedKeyVersions(): Map<string, TonWalletVersion> {
  codeHashes ??= new Map(TON_WALLET_VERSIONS.map((version) => [tonWalletContract(Buffer.alloc(32), version).init.code.hash().toString('hex'), version]));
  return codeHashes;
}

function fail(reason: TonProofFailure): { ok: false; reason: TonProofFailure } {
  return { ok: false, reason };
}
