import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from '@ton/ton';

import { ChainError, ChainErrorKinds } from '../errors.ts';
import type { TonWalletVersion } from './ton_messages.ts';

/** The wallet contracts this SDK builds and signs for, oldest first. */
export const TON_WALLET_VERSIONS: readonly TonWalletVersion[] = ['v3r2', 'v4r2', 'v5r1'];

/** 0 (the basechain) or -1 (the masterchain). */
export type TonWorkchain = 0 | -1;

/** The v3r2 / v4r2 wallet id the Python SDK uses, whatever the wallet's workchain. */
export const TON_LEGACY_DEFAULT_WALLET_ID = 698983191;

export type TonWalletContract = WalletContractV5R1 | WalletContractV4 | WalletContractV3R2;

/**
 * The wallet contract `publicKey` has in `version`, as the Python SDK
 * (ton_core) builds it: W5's context names workchain 0 (as @ton/ton's default
 * does), and v3r2 / v4r2's wallet id is 698983191 whatever the workchain —
 * where @ton/ton would add the workchain, giving another address on -1.
 */
export function tonWalletContract(
  publicKey: Uint8Array | string,
  version: TonWalletVersion,
  workchain: TonWorkchain = 0,
): TonWalletContract {
  const key = tonPublicKeyOf(publicKey);
  if (!TON_WALLET_VERSIONS.includes(version)) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `TON wallet version must be one of ${TON_WALLET_VERSIONS.join(', ')}, got ${String(version)}`);
  }
  if (workchain !== 0 && workchain !== -1) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `A TON wallet lives on workchain 0 or -1, got ${String(workchain)}`);
  }
  return version === 'v5r1'
    ? WalletContractV5R1.create({ workchain, publicKey: key })
    : version === 'v4r2'
      ? WalletContractV4.create({ workchain, publicKey: key, walletId: TON_LEGACY_DEFAULT_WALLET_ID })
      : WalletContractV3R2.create({ workchain, publicKey: key, walletId: TON_LEGACY_DEFAULT_WALLET_ID });
}

/** The canonical raw address of `publicKey`'s wallet in `version`. */
export function tonWalletAddress(publicKey: Uint8Array | string, version: TonWalletVersion, opts: { workchain?: TonWorkchain } = {}): string {
  return tonWalletContract(publicKey, version, opts.workchain).address.toRawString();
}

/** `publicKey`'s wallet address in every version, raw. */
export function tonWalletAddresses(publicKey: Uint8Array | string, opts: { workchain?: TonWorkchain } = {}): Record<TonWalletVersion, string> {
  return Object.fromEntries(TON_WALLET_VERSIONS.map((version) => [version, tonWalletAddress(publicKey, version, opts)])) as Record<TonWalletVersion, string>;
}

/** An ed25519 public key given as 32 bytes or 64 hex characters. */
export function tonPublicKeyOf(publicKey: Uint8Array | string): Buffer {
  if (typeof publicKey === 'string') {
    if (!/^[0-9a-fA-F]{64}$/.test(publicKey)) throw new ChainError(ChainErrorKinds.InvalidArgument, 'A TON public key is 64 hex characters');
    return Buffer.from(publicKey, 'hex');
  }
  if (publicKey.length !== 32) throw new ChainError(ChainErrorKinds.InvalidArgument, `A TON public key is 32 bytes, got ${publicKey.length}`);
  return Buffer.from(publicKey);
}
