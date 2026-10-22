import { createHash } from 'node:crypto';

import { type Cell, Dictionary, type Slice } from '@ton/core';

import { ChainErrorKinds } from '../errors.ts';
import { TonProviderError } from './ton_provider.ts';

/** A jetton's TEP-64 metadata, as far as it could be read. */
export interface TonJettonMetadata {
  symbol: string | null;
  name: string | null;
  /** Always set: the content's, the off-chain JSON's, or TEP-64's default of 9 when neither names one. */
  decimals: number;
  description: string | null;
  image: string | null;
  /** The off-chain metadata URI, when the content names one. */
  uri: string | null;
}

/** Fetches a metadata URI's JSON; injectable for tests. */
export type TonMetadataFetcher = (uri: string) => Promise<unknown>;

const TEP64_KEYS = ['uri', 'name', 'description', 'image', 'symbol', 'decimals'] as const;
const OFFCHAIN_FETCH_TIMEOUT_MS = 10_000;
const OFFCHAIN_MAX_BYTES = 64 * 1024;
const TEP64_DEFAULT_DECIMALS = 9;

/**
 * The fields of a jetton master's content cell (`get_jetton_data`, TEP-64):
 * on-chain (prefix 0x00, a dictionary keyed by the SHA-256 of each field
 * name, values snake or chunked), or off-chain (any other prefix, a snake
 * URI — TEP-64's 0x01 and the older variants some jettons use).
 */
export function parseTonJettonContent(content: Cell): { fields: Partial<Record<(typeof TEP64_KEYS)[number], string>>; uri: string | null } {
  const slice = content.beginParse();
  const prefix = slice.loadUint(8);
  if (prefix !== 0x00) return { fields: {}, uri: slice.loadStringTail() };
  const dict = slice.loadDict(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
  const fields: Partial<Record<(typeof TEP64_KEYS)[number], string>> = {};
  for (const key of TEP64_KEYS) {
    const value = dict.get(createHash('sha256').update(key).digest());
    if (value !== undefined) fields[key] = contentDataOf(value.beginParse());
  }
  return { fields, uri: fields.uri ?? null };
}

/**
 * A jetton's metadata from its content cell, filling what the content lacks
 * from the off-chain JSON its URI names (https only).
 *
 * The decimals decide every amount, so they are never guessed: when the
 * content names none and the off-chain JSON could not be read, this throws
 * (retryably). A symbol that cannot be read is `null`.
 */
export async function readTonJettonMetadata(content: Cell, fetchJson: TonMetadataFetcher = fetchOffchainJson): Promise<TonJettonMetadata> {
  const { fields, uri } = parseTonJettonContent(content);
  const merged: Record<string, string> = { ...fields };
  let offchainRead = uri === null;
  if (uri !== null && (merged.symbol === undefined || merged.decimals === undefined)) {
    try {
      const json = await fetchJson(uri);
      if (json !== null && typeof json === 'object' && !Array.isArray(json)) {
        for (const key of TEP64_KEYS) {
          const value = (json as Record<string, unknown>)[key];
          if (merged[key] === undefined && (typeof value === 'string' || typeof value === 'number')) merged[key] = String(value);
        }
        offchainRead = true;
      }
    } catch {
      offchainRead = false;
    }
  } else {
    offchainRead = true;
  }
  if (merged.decimals === undefined && !offchainRead) {
    throw new TonProviderError(ChainErrorKinds.RpcError, `Could not read the jetton's decimals: its metadata at ${uri} did not load`, true);
  }
  return {
    symbol: merged.symbol ?? null,
    name: merged.name ?? null,
    decimals: merged.decimals === undefined ? TEP64_DEFAULT_DECIMALS : decimalsOf(merged.decimals),
    description: merged.description ?? null,
    image: merged.image ?? null,
    uri,
  };
}

function decimalsOf(value: string): number {
  if (!/^\d{1,3}$/.test(value.trim()) || Number(value) > 255) {
    throw new TonProviderError(ChainErrorKinds.InvalidTokenIdentifier, `A jetton's decimals must be 0 to 255, got ${JSON.stringify(value)}`, false);
  }
  return Number(value);
}

/** A TEP-64 content value: snake (0x00) or chunked (0x01, a dictionary of snake chunks). */
function contentDataOf(slice: Slice): string {
  const prefix = slice.loadUint(8);
  if (prefix === 0x00) return slice.loadStringTail();
  if (prefix === 0x01) {
    const chunks = slice.loadDict(Dictionary.Keys.Uint(32), Dictionary.Values.Cell());
    return [...chunks.keys()]
      .sort((a, b) => a - b)
      .map((index) => (chunks.get(index) as Cell).beginParse().loadStringTail())
      .join('');
  }
  throw new TonProviderError(ChainErrorKinds.InvalidTokenIdentifier, `Unknown TEP-64 content data prefix 0x${prefix.toString(16)}`, false);
}

async function fetchOffchainJson(uri: string): Promise<unknown> {
  if (!uri.startsWith('https://')) throw new Error(`only https metadata is fetched, not ${uri}`);
  const response = await fetch(uri, { signal: AbortSignal.timeout(OFFCHAIN_FETCH_TIMEOUT_MS), redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > OFFCHAIN_MAX_BYTES) throw new Error('metadata too large');
  return JSON.parse(text);
}
