/**
 * Replace `rpcUrl` in `message` with its host-only form so API keys carried
 * in the URL path/query don't leak into error strings. Falls back to a
 * `<rpc>` placeholder if the URL is unparseable.
 */
export function sanitizeMessage(message: string, rpcUrl: string | null): string {
  let out = message;
  // Long hex runs (with or without 0x prefix) are signed-tx bytes or opaque
  // payloads. Threshold 128 hex chars = 64 bytes, above the largest transient
  // identifier (tx hash / signature = 64 hex / 88 base58) so we don't clobber
  // hashes but do catch even a minimal signed EVM tx (~110 bytes).
  out = out.replace(/(?:0x)?[0-9a-fA-F]{128,}/g, (m) => {
    const hexLen = m.startsWith('0x') || m.startsWith('0X') ? m.length - 2 : m.length;
    return `<signed-bytes:${hexLen / 2}B>`;
  });
  // Long base64 runs (Solana / Jito payloads). base64 signed-tx is ~200 chars.
  out = out.replace(/[A-Za-z0-9+/]{160,}={0,2}/g, (m) => `<signed-bytes-b64:${m.length}c>`);
  out = out.replace(/([?&])([a-zA-Z_-]*(?:api[-_]?key|key|token|access[-_]?token|secret|auth))=[^\s"&]+/gi, '$1$2=<redacted>');
  out = out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer <redacted>');
  out = out.replace(/Authorization:\s*[A-Za-z0-9._~+/=-]+/gi, 'Authorization: <redacted>');
  out = out.replace(/((?:x-)?api[-_]?key)\s*:\s*[A-Za-z0-9._~+/=-]+/gi, '$1: <redacted>');
  out = out.replace(/(\/v\d+|\/api|\/rpc)\/[A-Za-z0-9_-]{16,}(?=[\s/,)\];.'"]|$)/gi, '$1/<redacted>');
  out = out.replace(/https?:\/\/[^\s"'`]*\.(?:alchemy\.com|infura\.io|quiknode\.pro|helius-rpc\.com|ankr\.com|blastapi\.io|drpc\.org)\/[A-Za-z0-9_./=-]{8,}/gi, (m) => {
    try {
      const u = new URL(m);
      return `${u.protocol}//${u.host}/<redacted>`;
    } catch {
      return '<rpc>';
    }
  });
  if (!rpcUrl) return out;
  try {
    const u = new URL(rpcUrl);
    const host = `${u.protocol}//${u.host}`;
    return out.replaceAll(rpcUrl, host);
  } catch {
    return out.replaceAll(rpcUrl, '<rpc>');
  }
}

/**
 * Build a fresh `Error` from `cause` with a sanitized message and stack,
 * dropping every other property (axios errors carry `.config.headers`
 * `Authorization` and `.config.url`/`baseURL` with API keys). Consumers'
 * structured loggers (pino `err` serializer, `util.inspect({showHidden})`)
 * walk `error.cause`; this ensures the API key never lands in logs.
 * Returns `undefined` for non-Error causes so the ChainError constructor
 * leaves cause unset.
 */
export function sanitizeCause(cause: unknown, rpcUrl: string | null): Error | undefined {
  if (!(cause instanceof Error)) return undefined;
  const short = (cause as Error & { shortMessage?: string }).shortMessage;
  const source = typeof short === 'string' && short.length > 0 ? short : cause.message;
  const safe = new Error(sanitizeMessage(source, rpcUrl));
  safe.name = cause.name;
  if (cause.stack) safe.stack = sanitizeMessage(cause.stack, rpcUrl);
  return safe;
}

export const ChainErrorKinds = {
  ChainNotSupported: 'chain_not_supported',
  DuplicateToken: 'duplicate_token',
  RpcNotConfigured: 'rpc_not_configured',
  RpcError: 'rpc_error',
  TransactionDecodeFailed: 'transaction_decode_failed',
  InvalidAddress: 'invalid_address',
  InvalidTokenIdentifier: 'invalid_token_identifier',
  InvalidArgument: 'invalid_argument',
  BroadcastRejected: 'broadcast_rejected',
  /** The broadcast failed in a way that does not tell whether the transaction reached the network; read its status before signing again. */
  BroadcastUncertain: 'broadcast_uncertain',
  NonceTooLow: 'nonce_too_low',
  InsufficientFunds: 'insufficient_funds',
  BlockhashExpired: 'blockhash_expired',
  SimulationFailed: 'simulation_failed',
  TransactionTooLarge: 'transaction_too_large',
  FeatureNotSupported: 'feature_not_supported',
} as const;

export type ChainErrorKind = (typeof ChainErrorKinds)[keyof typeof ChainErrorKinds];

export interface ChainErrorMeta {
  chainId?: number;
  txHash?: string;
  address?: string;
  identifier?: string;
  rpcHost?: string;
  envCandidates?: string[];
  /** ABI-encoded revert data from an EVM eth_call that reverted. */
  revertData?: string;
}

export class ChainError extends Error {
  readonly kind: ChainErrorKind;
  readonly meta: ChainErrorMeta;

  constructor(kind: ChainErrorKind, message: string, meta: ChainErrorMeta = {}, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ChainError';
    this.kind = kind;
    this.meta = meta;
  }
}

export function isChainError(err: unknown, kind?: ChainErrorKind): err is ChainError {
  if (!(err instanceof ChainError)) return false;
  return kind === undefined || err.kind === kind;
}

export function isBlockhashExpiredError(err: unknown): err is ChainError {
  return isChainError(err, ChainErrorKinds.BlockhashExpired);
}

export function isSimulationError(err: unknown): err is ChainError {
  return isChainError(err, ChainErrorKinds.SimulationFailed);
}

export function isBroadcastUncertainError(err: unknown): err is ChainError {
  return isChainError(err, ChainErrorKinds.BroadcastUncertain);
}

export function isNonceError(err: unknown): err is ChainError {
  return isChainError(err, ChainErrorKinds.NonceTooLow);
}

export function isTransactionTooLargeError(err: unknown): err is ChainError {
  return isChainError(err, ChainErrorKinds.TransactionTooLarge);
}
