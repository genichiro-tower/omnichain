/**
 * Chain ID constants — mirrors omnichain-py/src/omnichain/chain_ids.py.
 * Source of truth: https://github.com/getomnichain/omnichain-py
 *
 * EVM chain IDs are the canonical EIP-155 numbers.
 * Non-EVM chains use synthetic negative IDs (Python convention) so a single
 * `number` fits every chain and the sign disambiguates families.
 */

// -----------------------------------------------------------------------------
// UTXO family (mirrors chain_ids.py:17-25)
// -----------------------------------------------------------------------------

export const CHAIN_ID_BITCOIN_MAINNET = -1;
export const CHAIN_ID_BITCOIN_TESTNET = -2;
export const CHAIN_ID_BITCOIN_SIGNET = -3;

export const CHAIN_ID_LITECOIN_MAINNET = -10;
export const CHAIN_ID_DOGECOIN_MAINNET = -12;
export const CHAIN_ID_DASH_MAINNET = -14;
export const CHAIN_ID_ZCASH_MAINNET = -16;
export const CHAIN_ID_BITCOIN_CASH_MAINNET = -18;

export const CHAIN_FAMILY_UTXO: ReadonlySet<number> = new Set([
  CHAIN_ID_BITCOIN_MAINNET,
  CHAIN_ID_BITCOIN_TESTNET,
  CHAIN_ID_BITCOIN_SIGNET,
  CHAIN_ID_LITECOIN_MAINNET,
  CHAIN_ID_DOGECOIN_MAINNET,
  CHAIN_ID_DASH_MAINNET,
  CHAIN_ID_ZCASH_MAINNET,
  CHAIN_ID_BITCOIN_CASH_MAINNET,
]);

/**
 * True for any chainId in the static UTXO family set (Python parity).
 *
 * **Divergence warning**: `networkTypeOf` currently routes only `-1/-2/-3`
 * (BTC) statically. `LTC (-10)`, `DOGE (-12)`, `DASH (-14)`, `ZCASH (-16)`,
 * `BCH (-18)` return `true` here for family membership, but v0 has no
 * `addressFor` path for them — construct the chain instance and call
 * `chain.validateAddress(raw)` directly. Do not use `isUtxo` as a routing
 * precondition; use `tryNetworkTypeOf` or per-chain registration checks.
 */
export function isUtxo(chainId: number): boolean {
  return CHAIN_FAMILY_UTXO.has(chainId);
}

// -----------------------------------------------------------------------------
// Solana family (mirrors chain_ids.py:43-55)
// -----------------------------------------------------------------------------

export const CHAIN_ID_SOLANA_MAINNET = -2000;
export const CHAIN_ID_SOLANA_TESTNET = -2001;
export const CHAIN_ID_SOLANA_DEVNET = -2002;

export const CHAIN_FAMILY_SOLANA: ReadonlySet<number> = new Set([
  CHAIN_ID_SOLANA_MAINNET,
  CHAIN_ID_SOLANA_TESTNET,
  CHAIN_ID_SOLANA_DEVNET,
]);

export function isSolana(chainId: number): boolean {
  return CHAIN_FAMILY_SOLANA.has(chainId);
}

// -----------------------------------------------------------------------------
// Sui family (mirrors chain_ids.py:57-67) — not implemented on TS v0.
// -----------------------------------------------------------------------------

export const CHAIN_ID_SUI_MAINNET = -2500;
export const CHAIN_ID_SUI_TESTNET = -2501;
export const CHAIN_ID_SUI_DEVNET = -2502;

export const CHAIN_FAMILY_SUI: ReadonlySet<number> = new Set([
  CHAIN_ID_SUI_MAINNET,
  CHAIN_ID_SUI_TESTNET,
  CHAIN_ID_SUI_DEVNET,
]);

export function isSui(chainId: number): boolean {
  return CHAIN_FAMILY_SUI.has(chainId);
}

// -----------------------------------------------------------------------------
// XRPL family (mirrors chain_ids.py:69-78) — not implemented on TS v0.
// -----------------------------------------------------------------------------

export const CHAIN_ID_XRPL_MAINNET = -3000;
export const CHAIN_ID_XRPL_TESTNET = -3001;

export const CHAIN_FAMILY_XRPL: ReadonlySet<number> = new Set([
  CHAIN_ID_XRPL_MAINNET,
  CHAIN_ID_XRPL_TESTNET,
]);

export function isXrpl(chainId: number): boolean {
  return CHAIN_FAMILY_XRPL.has(chainId);
}

// -----------------------------------------------------------------------------
// Stellar family (mirrors chain_ids.py:80-89) — not implemented on TS v0.
// -----------------------------------------------------------------------------

export const CHAIN_ID_STELLAR_MAINNET = -3500;
export const CHAIN_ID_STELLAR_TESTNET = -3501;

export const CHAIN_FAMILY_STELLAR: ReadonlySet<number> = new Set([
  CHAIN_ID_STELLAR_MAINNET,
  CHAIN_ID_STELLAR_TESTNET,
]);

export function isStellar(chainId: number): boolean {
  return CHAIN_FAMILY_STELLAR.has(chainId);
}

// -----------------------------------------------------------------------------
// TON family (mirrors chain_ids.py:92-100). TonChain serves mainnet only
// (`@getomnichain/omnichain/ton`).
// -----------------------------------------------------------------------------

export const CHAIN_ID_TON_MAINNET = -4000;
export const CHAIN_ID_TON_TESTNET = -4001;

export const CHAIN_FAMILY_TON: ReadonlySet<number> = new Set([
  CHAIN_ID_TON_MAINNET,
  CHAIN_ID_TON_TESTNET,
]);

export function isTon(chainId: number): boolean {
  return CHAIN_FAMILY_TON.has(chainId);
}

// -----------------------------------------------------------------------------
// Tron family (mirrors chain_ids.py:103-111) — not implemented on TS v0.
// Note: Tron uses positive numeric IDs (not synthetic negatives).
// -----------------------------------------------------------------------------

export const CHAIN_ID_TRON_MAINNET = 728126428;
export const CHAIN_ID_TRON_SHASTA = 2494104990;

export const CHAIN_FAMILY_TRON: ReadonlySet<number> = new Set([
  CHAIN_ID_TRON_MAINNET,
  CHAIN_ID_TRON_SHASTA,
]);

export function isTron(chainId: number): boolean {
  return CHAIN_FAMILY_TRON.has(chainId);
}

// -----------------------------------------------------------------------------
// EVM chain IDs (mirrors chain_ids.py:114-167).
// -----------------------------------------------------------------------------

export const CHAIN_ID_ETHEREUM = 1;
export const CHAIN_ID_GOERLI = 5;
export const CHAIN_ID_OPTIMISM = 10;
export const CHAIN_ID_CRONOS = 25;
export const CHAIN_ID_BNB_CHAIN = 56;
export const CHAIN_ID_OKX_CHAIN = 66;
export const CHAIN_ID_GNOSIS = 100;
export const CHAIN_ID_UNICHAIN = 130;
export const CHAIN_ID_POLYGON = 137;
export const CHAIN_ID_MONAD = 143;
export const CHAIN_ID_SONIC = 146;
export const CHAIN_ID_SHIMMER = 148;
export const CHAIN_ID_XLAYER = 196;
export const CHAIN_ID_OPBNB = 204;
export const CHAIN_ID_FANTOM = 250;
export const CHAIN_ID_BOBA = 288;
export const CHAIN_ID_ZKSYNC = 324;
export const CHAIN_ID_WORLD_CHAIN = 480;
export const CHAIN_ID_WANCHAIN = 888;
export const CHAIN_ID_STABLE = 988;
export const CHAIN_ID_HYPER_EVM = 999;
export const CHAIN_ID_METIS = 1088;
export const CHAIN_ID_POLYGON_ZKEVM = 1101;
export const CHAIN_ID_MOONBEAM = 1284;
export const CHAIN_ID_MOONRIVER = 1285;
export const CHAIN_ID_SEI_EVM = 1329;
export const CHAIN_ID_SONEIUM = 1868;
export const CHAIN_ID_ABSTRACT = 2741;
export const CHAIN_ID_CITREA = 4114;
export const CHAIN_ID_TEMPO = 4217;
export const CHAIN_ID_MEGA_ETH = 4326;
export const CHAIN_ID_MANTLE = 5000;
export const CHAIN_ID_ZETACHAIN = 7000;
export const CHAIN_ID_BASE = 8453;
export const CHAIN_ID_IOTA_EVM = 8822;
export const CHAIN_ID_PLASMA = 9745;
export const CHAIN_ID_MODE = 34443;
export const CHAIN_ID_ARBITRUM = 42161;
export const CHAIN_ID_CELO = 42220;
export const CHAIN_ID_AVALANCHE_C_CHAIN = 43114;
export const CHAIN_ID_INK = 57073;
export const CHAIN_ID_LINEA = 59144;
export const CHAIN_ID_BOB = 60808;
export const CHAIN_ID_BERA_CHAIN = 80094;
export const CHAIN_ID_BLAST = 81457;
export const CHAIN_ID_TAIKO = 167000;
export const CHAIN_ID_SCROLL = 534352;
export const CHAIN_ID_KATANA = 747474;
export const CHAIN_ID_ZKLINK_NOVA = 810180;
export const CHAIN_ID_ZORA = 7777777;
export const CHAIN_ID_SEPOLIA = 11155111;
export const CHAIN_ID_CELO_SEPOLIA = 11142220;
export const CHAIN_ID_AURORA = 1313161554;

/**
 * Sign/family test — returns `true` for any positive integer chainId that
 * isn't a Tron chain. Does NOT assert that the chainId corresponds to a
 * pre-baked `EvmChain`. Consumers wanting a support check should look up the
 * chain in `ALL_DECLARED_EVM_CHAINS` (48 pre-baked chains); the smaller
 * `ALL_EVM_CHAINS` is the pre-v0 "wired" set of 4 kept for backward compat.
 *
 * **Caveat on all `is*` predicates**: they operate on the immutable Python-
 * parity family sets in this file. `networkTypeOf()` (in `network_type.ts`)
 * reads the runtime registry that also includes consumer-registered chains,
 * and is the authoritative routing check. The two can disagree for any
 * chainId a consumer registered.
 */
export function isEvm(chainId: number): boolean {
  return Number.isInteger(chainId) && chainId > 0 && !CHAIN_FAMILY_TRON.has(chainId);
}
