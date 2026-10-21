# omnichain

A service-agnostic abstraction layer for talking to blockchain networks. One
shape (`Chain`, `Token`, `Address`, `UnsignedTransaction`) covers EVM
(Ethereum / Arbitrum / Base / BNB / …), UTXO (Bitcoin / Litecoin /
Dogecoin), Solana, Stellar, Tron, and TON, with the same call surface
regardless of underlying network.

This repository is the canonical source for the SDK. It is consumed by
sister services (depositron, pluton-back-end, gasless) as a git submodule
mounted at each service's own `chain` directory.

## What's in here

| Concept | File | Purpose |
|---|---|---|
| `Chain` | [chain.base.ts](../chain.base.ts) | Abstract base for any chain — exposes `getBalance`, `createTransferUnsignedTransaction`, `getTransactionStatus`, address/token validation, explorer URLs |
| `Token` | [token.ts](../token.ts) | Abstract base for an on-chain asset — `chainId`, `symbol`, `identifier` (or `NATIVE_TOKEN_IDENTIFIER`), `decimals` |
| `Address` | [address.ts](../address.ts) | Abstract address with `canonical()` + `networkType` |
| `UnsignedTransaction` | [unsigned_transaction.ts](../unsigned_transaction.ts) | Abstract base for an unsigned tx; per-chain subclasses add the bytes |
| `NetworkType` | [network_type.ts](../network_type.ts) | Enum (`EVM`, `COSMOS`, `TON`, `SOLANA`, `BTC`, `TRON`, `STELLAR`) + `registerNonEvmChain(chainId, type)` registry |
| Python base types | [chain_type.ts](../chain_type.ts), [transaction_prerequisite.ts](../transaction_prerequisite.ts), [signed_transaction.ts](../signed_transaction.ts), [transaction_simulation.ts](../transaction_simulation.ts), [wallet.base.ts](../wallet.base.ts), [asset_balance.ts](../asset_balance.ts), [transaction_json.ts](../transaction_json.ts) | Ports of omnichain-py `base/base.py`: `ChainType`, `WalletFamily`, `FiatCurrency`, prerequisites + `UnsignedTransactionWithPrerequisites`, signed transaction + broadcast response, simulation result, signed message + wallet bases, asset balance, and the `{type, chain_id, …}` JSON envelope (`UnsignedTransaction.fromJson` / `AbstractSignedTransaction.fromJson` dispatch on `type`). Used by Stellar and Tron |
| `TransactionStatus` | [transaction_status.ts](../transaction_status.ts) | Abstract base — chainId, status, inclusionAt, error, balanceChanges. Per-network subclasses: `EvmTransactionStatus` (+logs, +fees), `SolanaTransactionStatus` (+fees), `UtxoTransactionStatus` (+outputs, +vsize, +confirmations, +fees) |
| `AssetBalanceChange` | [transaction_status.ts](../transaction_status.ts) | Per-(wallet, asset) balance delta. `.balanceChangeMr: bigint` is the source of truth; `.balanceChangeHr: Decimal` is a lazy accessor derived via exact string-shift (never loses wei). `.fromHr(hr, decimals)` factory for Python-parity construction. `NestedBalanceChanges = Map<wallet, Map<assetHash, {token, change}>>` |
| `AbstractGasPricing` + subclasses | [abstract_gas_pricing.ts](../abstract_gas_pricing.ts), [evm/evm_gas_pricing.ts](../evm/evm_gas_pricing.ts), [solana/solana_gas_pricing.ts](../solana/solana_gas_pricing.ts), [utxo/utxo_gas_pricing.ts](../utxo/utxo_gas_pricing.ts) | Python-parity explicit-fee override types. `GasPricingType = FeePriority \| AbstractGasPricing`. Type surface only in Wave 2B — per-chain builders don't consume `CreateTransferRequest.gasPricing` yet |
| `Priority` | [priority.ts](../priority.ts) | Shared `Priority` enum (`SLOW`/`NORMAL`/`FAST`) used by per-chain `suggestGas` / `suggestFeeRate` / `suggestPriorityFeeMicroLamports` |
| `ChainError` | [errors.ts](../errors.ts) | Module-internal error with a `kind` discriminator |
| `CHAIN_ID_TO_RANGO_NAME` + accessors | [rango_chain_names.ts](../rango_chain_names.ts) | Bidirectional map between omnichain chain ids and Rango's canonical uppercase `blockchains[].name`. Downstream consumers that talk to Rango import from here instead of maintaining local copies. `NOT_ON_RANGO` set records explicit "not on Rango" decisions; the coverage test forces a decision on every new chain id |
| `addressFor(chainId, raw)` | [address.factory.ts](../address.factory.ts) | Network-aware address constructor |

## Per-chain implementations

| Network | Where | What it is |
|---|---|---|
| **EVM** (Ethereum, Arbitrum, Base, BNB, …) | [evm/](../evm) | `EvmChain` over `ethers.js` v6 + ERC-20 support — see [evm.md](./evm.md) |
| **UTXO** (Bitcoin, Litecoin, Dogecoin + testnets) | [utxo/](../utxo) | `UtxoChain` + `BtcChain` over `bitcoinjs-lib` v7 + `coininfo` — see [utxo.md](./utxo.md) |
| **Solana** (mainnet, devnet, testnet) | [solana/](../solana) | `SolanaChain` over `@solana/web3.js` v1 + SPL Token / Token-2022 — see [solana.md](./solana.md) |
| **Stellar** (mainnet, testnet) | [stellar/](../stellar) | `StellarChain` over `@stellar/stellar-sdk` (Horizon + Soroban RPC); import from `@getomnichain/omnichain/stellar` — see [stellar.md](./stellar.md) |
| **Tron** (mainnet, Shasta) | [tron/](../tron) | `TronChain` over the TronGrid HTTP API (tronpy port); import from `@getomnichain/omnichain/tron` — see [tron.md](./tron.md) |
| **TON** (mainnet) | [ton/](../ton) | `TonChain` over TON Center v3 with TonAPI as fallback, W5R1 wallets and relayed requests; import from `@getomnichain/omnichain/ton` — see [ton.md](./ton.md) |

## Quickstart

### Construct a chain instance

```ts
import { arbitrumChain } from '@getomnichain/omnichain';

const arb = arbitrumChain('https://arb1.arbitrum.io/rpc');
await arb.getBalance('0xabc…', /* tokenIdentifier */ 'NATIVE');
```

For BTC:

```ts
import {
  bitcoinMainnetChain,
  BitcoinCoreTool,
  BITCOIN_MAINNET_PARAMS,
} from '@getomnichain/omnichain';

const core = new BitcoinCoreTool({
  baseUrl: 'http://localhost:8332',
  user: 'user',
  password: 'pass',
  params: BITCOIN_MAINNET_PARAMS,
  wallet: 'pluton-hot-wallet',
});

const btc = bitcoinMainnetChain({
  chainId: -1,
  utxoProvider: core,
  rawTxProvider: core,
  feeEstimator: core,
  broadcaster: core,
  chainTipProvider: core,
});
```

For Solana:

```ts
import { SolanaMainnet, Priority } from '@getomnichain/omnichain';

const cuMicroLamports = await SolanaMainnet.suggestPriorityFeeMicroLamports(Priority.NORMAL);
const balance = await SolanaMainnet.getBalance('5gUu…');
```

### Network-aware fee suggestion (Priority)

Each chain owns its own fee-suggestion math; the consumer just passes a
`Priority` and signs whatever envelope is returned.

| Chain | Method | Result | RPC call under the hood |
|---|---|---|---|
| EVM (`supportsEip1559`) | `chain.suggestGas(priority)` | `EvmGasEstimate { maxFeePerGas, maxPriorityFeePerGas }` | Single `eth_feeHistory` call at percentile `{SLOW:25, NORMAL:50, FAST:75}` over 10 blocks; sort tips + pick p90; 2 gwei fallback if reward rows empty; `MIN_GAS_PRICE_FLOOR` (0.05 gwei) clamp on the returned tip; RPC failure bubbles as `ChainError(RpcError)` (no defensive fallback) |
| EVM (legacy — `!supportsEip1559`) | `chain.suggestGas(priority)` | `EvmGasEstimate { gasPrice }` only — `maxFee*` fields **undefined** (Python parity) | `eth_gasPrice` × `{SLOW:1.0, NORMAL:1.2, FAST:1.5}`; clamped up to `MIN_GAS_PRICE_FLOOR`. Consumers that always sign EIP-1559 must dispatch on `supportsEip1559` or use `isLegacyGasEstimate` and fall back to a type-0 transaction on these chains. |
| BTC / UTXO | `chain.suggestFeeRate(priority)` | `number` (sats/vByte) | `feeEstimator.getFeeEstimate(targetBlocks)` with `FAST:1, NORMAL:3, SLOW:6` |
| Solana | `chain.suggestPriorityFeeMicroLamports(priority)` | `number` (microlamports/CU) | `getRecentPrioritizationFees({ lockedWritableAccounts: [] })` percentiles `{SLOW:p25, NORMAL:p50, FAST:p90}`; `0` on a quiet cluster |

### Build a transfer

The unified entry point is `Chain.createTransferUnsignedTransaction(req)`,
where `req` is the same shape for every chain:

```ts
const unsigned = await chain.createTransferUnsignedTransaction({
  from: senderAddress,
  to: recipientAddress,
  tokenIdentifier: 'NATIVE',            // or an ERC-20 / SPL / etc. identifier
  amount: 1_000_000n,                   // smallest unit (wei / sats / lamports)
  memo: 'optional UTF-8 memo',          // BTC: emits OP_RETURN; EVM: ignored
});
```

The returned object is a chain-specific subclass of `UnsignedTransaction`:

- EVM → `UnsignedEvmTransaction` (`{ to, value, data, chainId }`)
- UTXO → `UnsignedUtxoTransaction` (`{ psbtBase64, selectedInputs, feeSats, inputsToSign, … }`)
- Solana → `UnsignedSolanaTransaction` (`{ transaction: VersionedTransaction, … }`)

Signers (wallets, hardware devices, the protocol itself) take this and
sign it externally; the chain module **does not hold keys** and **does not
read environment variables** for credentials.

### Check transaction status

```ts
import { isSuccess } from '@getomnichain/omnichain';

const status = await chain.getTransactionStatus(txHash);
// EvmTransactionStatus | SolanaTransactionStatus | UtxoTransactionStatus
// Base fields: { chainId, status, inclusionAt, error, balanceChanges }
// Subclass extras vary per chain (see the type table above).

if (isSuccess(status)) {
  // balanceChanges is now Map<wallet, Map<assetHash, {token, change}>>
  for (const [wallet, perAsset] of status.balanceChanges) {
    for (const { token, change } of perAsset.values()) {
      // balanceChangeMr is the exact source of truth (bigint minor units);
      // balanceChangeHr is a lazy Decimal accessor for display (Wave 2B).
      console.log(wallet, token.symbol, change.balanceChangeMr, change.balanceChangeHr.toFixed());
    }
  }
}
```

**Wallet-key case normalization** — the wallet key used in
`NestedBalanceChanges` is chain-specific: EVM addresses are lowercased,
Solana keys are the raw base58 (case-sensitive), UTXO keys are the raw
provider-returned address (bech32 lower-case in practice; providers
don't uppercase). If you do `status.balanceChanges.get(userAddress)`
directly, normalise `userAddress` to the same form (`toLowerCase()` for
EVM).

## Error model

All errors thrown by this module are `ChainError` with a typed
`kind` field — see [errors.ts](../errors.ts):

- `NotSupported`, `RpcError`, `RpcChainIdMismatch`, `TransactionDecodeFailed`,
  `InvalidAddress`, `InvalidTokenIdentifier`, `RpcNotConfigured`

Use `isChainError(err, ChainErrorKinds.InvalidAddress)` to narrow.

## NetworkType registry

Some addresses look identical across networks (e.g. all `0x…` 20-byte hex
addresses are valid EVM-shaped, but a real EVM-vs-non-EVM dispatch needs
context). The module maintains a small registry mapping `chainId →
NetworkType` (`network_type.ts`).

Behavior in v0:

- **Static seeds at module load** (from `chain_ids.ts`): BTC family
  (`-1/-2/-3`), Solana family (`-2000/-2001/-2002`), Stellar family
  (`-3500/-3501`), TON family (`-4000/-4001`), Tron family
  (`728126428/2494104990`).
- **`networkTypeOf(chainId)`**: returns the registered NetworkType if
  present. For unregistered positive ids returns `EVM`. For unregistered
  negative ids throws `ChainError(ChainNotSupported)` — fail-closed so a
  stale `-100` doesn't silently misroute.
- **`tryNetworkTypeOf(chainId)`**: non-throwing sibling; returns
  `undefined` on unregistered negatives.
- **`registerNonEvmChain(id, type)`**: idempotent for same type; throws
  `ChainError(InvalidArgument)` on conflict. Since positive ids
  synthesize EVM by default, claiming a positive id for a non-EVM
  family requires `unregisterChain(id)` first.
- **`unregisterChain(id)`** + **`networkTypeRegistrations()`**: escape
  hatch and diagnostics.
- Chain constructors (`SolanaChain`, `UtxoChain`) self-register in
  their constructors. `EvmChain` does NOT self-register (its 48
  pre-baked entries at module load would otherwise turn a consumer's
  earlier `registerNonEvmChain(sameId, OTHER)` into an unrecoverable
  import-time crash).

`addressFor(chainId, raw)` reads from this registry via `networkTypeOf`
and dispatches to the appropriate `Address` subclass — currently EVM,
Solana, BTC, TON, Tron (`TronAddress`, canonical base58check `T…`) and
Stellar (`StellarAddress`, `G…`/`M…`). The COSMOS family throws
`ChainNotSupported` (no Address parser yet).

## Chain IDs

- **EVM chains** use real EVM `chainId` values (1, 42161, 8453, 56, …).
- **Non-EVM chains** — the SDK now owns a reserved negative-ID range,
  matching `omnichain-py/chain_ids.py`:
  - BTC family: `-1` mainnet, `-2` testnet, `-3` signet
  - LTC `-10`, DOGE `-12`, DASH `-14`, ZEC `-16`, BCH `-18` (mainnets only — testnets for these families are not defined in v0)
  - Solana `-2000` mainnet, `-2001` testnet, `-2002` devnet
  - Stellar `-3500` mainnet, `-3501` testnet
  - TON `-4000` mainnet, `-4001` testnet
  - Tron keeps its real positive ids (`728126428` mainnet, `2494104990` Shasta)
  Consumers **should not** invent overlapping negative IDs for their own
  chains. `registerNonEvmChain` throws `ChainError(InvalidArgument)` on
  family conflict. Notable overlap: TON's native `global_id = -3` collides
  with BTC signet in this SDK — use `CHAIN_ID_TON_TESTNET` (`-4001`) for
  TON.

## Boundary: this module reads env only for RPC URL resolution

Constructors take plain config objects (`baseUrl`, `user`, `password`,
`rpcUrl`, …). The **one** exception is RPC URL fallback resolution:
`EvmChain.readRpcUrl` and `SolanaChain.readRpcUrl` will read
`<NAME>_RPC_URL` / `EVM_<chainId>_RPC_URL` / `SOLANA_<chainId>_RPC_URL`
env vars if no `rpcUrl` was passed at construction. Adding a
`process.env` read anywhere else in this SDK is a review-blocker.

## Adding a new chain

### New EVM chain
Add a factory function to [evm/evm_chains.ts](../evm/evm_chains.ts):

```ts
export const POLYGON_CHAIN_ID = 137;
export const Polygon = new EvmChain({
  chainId: POLYGON_CHAIN_ID,
  name: 'Polygon',
  blockTimeSeconds: 2,
  explorerBaseUrl: 'https://polygonscan.com',
  nativeSymbol: 'MATIC',
  // rpcUrl is optional. When omitted, the SDK resolves via env-var fallback:
  //   POLYGON_RPC_URL, then EVM_137_RPC_URL, then throws RpcNotConfigured.
});
```

The RPC URL precedence for every `EvmChain` is:

1. `rpcUrl` passed at construction (wins).
2. `<NAME_UPPERCASE_UNDERSCORED>_RPC_URL` env var (e.g. `POLYGON_RPC_URL`).
3. `EVM_<chainId>_RPC_URL` env var.
4. Throws `ChainError(RpcNotConfigured)` on first RPC call.

Solana is similar but has a required `defaultRpcUrl` that acts as the final
fallback instead of throwing — see [solana.md](./solana.md).

### New UTXO chain
See [utxo.md](./utxo.md) — define `UtxoNetworkParams` (use `coininfo` for
network bytes), write a factory under the appropriate subdirectory.

### New chain family entirely (Cosmos, Aptos, etc.)
Add `Foo` enum value to [network_type.ts](../network_type.ts), create
`foo/` with `FooChain extends Chain`, `FooAddress extends Address`,
`UnsignedFooTransaction extends UnsignedTransaction`. Wire into
[address.factory.ts](../address.factory.ts).

## Testing layout

| Spec | What it verifies |
|---|---|
| [test/](../test) | Address factory + registry + cross-chain glue |
| [evm/test/](../evm/test) | EVM address parsing + EVM chain RPC mocks + `suggestGas` percentile / fallback / legacy paths |
| [solana/test/](../solana/test) | Solana address validators + `suggestPriorityFeeMicroLamports` percentile / empty-cluster |
| [utxo/btc/test/](../utxo/btc/test) | BTC parsing, fee math, coin selection, chain transfer round-trip with mocked providers + `suggestFeeRate` targetBlocks mapping |
| `<consumer>/test/integration/` | Live-network smoke checks belong in the consuming service, not this SDK |

## See also

- [evm.md](./evm.md) — EVM chains and ERC-20
- [utxo.md](./utxo.md) — Bitcoin / Litecoin / Dogecoin, fee estimation, asset filtering
- [solana.md](./solana.md) — Solana, SPL Token, Token-2022, priority-fee model
- [stellar.md](./stellar.md) — Stellar classic + Soroban, trustlines, SEP-5/SEP-53 wallet
- [tron.md](./tron.md) — Tron TRX + TRC-20, energy fees, approvals, canonical transactions
- [ton.md](./ton.md) — TON and jettons, W5R1 wallets, relayed requests, trace emulation and status
