import { ChainError, ChainErrorKinds } from '../errors.ts';

const DEFAULT_MAX_AGE_SECONDS = 600;
/** How far ahead of `now` a wallet's clock may run. */
const CLOCK_SKEW_SECONDS = 60;

/** `now` and the age limit, in seconds; throws for values that would leave a signature's age unchecked. */
export function tonConnectWindow(now: Date | undefined, maxAgeSeconds: number | undefined, what: string): { now: number; maxAge: number } {
  const at = now ?? new Date();
  const seconds = at instanceof Date ? Math.floor(at.getTime() / 1000) : Number.NaN;
  const maxAge = maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (!Number.isFinite(seconds) || !Number.isFinite(maxAge) || maxAge <= 0) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `${what} needs a valid \`now\` and a positive \`maxAgeSeconds\``);
  }
  return { now: seconds, maxAge };
}

/**
 * A wallet's signing time, as a number or a decimal string, when it is within
 * the window: at most `maxAge` old and at most a minute ahead. `null` otherwise.
 */
export function tonConnectTimestamp(value: unknown, window: { now: number; maxAge: number }): number | null {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !/^\d{1,15}$/.test(text)) return null;
  const timestamp = Number(text);
  // Written to pass only when both bounds hold, so nothing unusable can slip through.
  return window.now - timestamp <= window.maxAge && timestamp <= window.now + CLOCK_SKEW_SECONDS ? timestamp : null;
}

/** Base64 or base64url bytes, `null` for anything else. */
export function tonConnectBase64(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(value)) return null;
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
