# Changelog

All notable changes to `@getomnichain/omnichain` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [0.7.2] — 2026-10-31

TON: a key's wallet address, TonConnect `ton_proof` sign-in and `signData` text signatures. Additive.

### Added

- **`tonWalletAddress(publicKey, version, { workchain })`** and **`tonWalletAddresses(publicKey)`**: the raw address of a public key's wallet, built as `TonWallet` builds its contract (`TonWallet` now uses the same `tonWalletContract`). For callers that hold a key but no seed, such as a fill proof's signer.
- **`TonChain.verifyTonProof(input, opts)`** (and `verifyTonProof`, `tonProofDigest`): verifies a TonConnect `ton_proof` by TonConnect's rules — network, domain, age, payload, the StateInit's address, the key from a fixed-key wallet's StateInit (`v3r2`, `v4r2`, `v5r1`) or Telegram Wallet's live key, and the signature. Returns `{ ok: true, publicKey, version }` or `{ ok: false, reason }`; never throws on what the wallet sent; reads the chain only for Telegram Wallet.
- **`verifyTonSignData(result, opts)`** (and `tonSignDataTextDigest`): verifies a TonConnect `signData` of a text payload against the signer's key, with the expected address, domain, text and age. Returns `{ ok: true }` or `{ ok: false, reason }`; never throws on what the wallet sent.
- **`TonWallet.signTonProof({ domain, payload })`** and **`TonWallet.signTextData({ text, domain })`**: the `ton_proof` and `signData` results a wallet app would give, for signing in and signing text from a script.
- **`getPublicKey(address)`** on `TonProvider` (TON Center `runGetMethod`, TonAPI's get-method, with fallback): an account's `get_public_key`; a missing getter is a definite answer, a failed read a retryable one.

### Changed

- `TON_WALLET_VERSIONS`, `TON_LEGACY_DEFAULT_WALLET_ID` and `TonWorkchain` move to `ton_wallet_contracts.ts`; they are exported from `@getomnichain/omnichain/ton` as before.

## [0.7.1] — 2026-10-25

TON: an account's transfers from a transaction hash, with finality — what a deposit watcher (clydner, via TonAPI webhooks) needs. Additive.

### Added

- **`TonChain.getAccountTransfers({ account, txHash })`** (and `accountTransfersOf(account, trace)`): the native TON and jetton transfers into and out of an account in the trace holding a transaction. Each has its direction, asset, owners, amount, text comment, the transaction that moved it, an `index` (with the transaction and direction it names the transfer, the same on every read and provider), and `final` (that transaction is finalized — and, for a native transfer shaped like a jetton message, the trace is complete — so it never changes later); `settled` once the trace is complete and all of it final. A received message counts unless the account sent it back as a bounce; a bounce of its own message coming back is marked `bounced`; the TON riding along a jetton transfer is part of it. Jettons count only when their master vouches for both jetton wallets.
- **`TonChain.getJettonTransfers(trace)`**: the verified wallet-to-wallet jetton transfers of a trace (the jetton balance changes now build on it).
- **`getTraceByTransaction(txHash)`** (providers and `TonChain`): the whole trace holding an account transaction, from its root; refused unless it holds it.
- **`getAccountTransactions(account, { afterLt, limit })`**: transactions after a cursor, oldest first, alike on both providers (TON Center's inclusive `start_lt`, TonAPI's exclusive `after_lt`).
- **`getLastTransactionLt(account)`**: 0 only for an account that never had a transaction — one that does not exist but bounced a message still has its lt. On TonAPI it is read from the transaction list: its raw account states 0 for such an account.
- `TonTraceTransaction.lt`; `tonJettonCreditsOf`, `tonTextCommentOf`, `tonJettonTransferCommentOf`; the jetton notification and excesses ops.

## [0.7.0] — 2026-10-21

TON: a chain, W5 wallets, and requests one wallet signs and another delivers and pays for. Mainnet only. See `docs/ton.md`.

### Added

- **`TonChain` and `TonMainnet`** (`@getomnichain/omnichain/ton`), read through TON Center v3 with TonAPI as the fallback. A call goes to TonAPI only when TON Center failed without an answer (transport, timeout, 429, 5xx). Every provider needs a key; a missing one is read from `TONCENTER_API_KEY` / `TONAPI_API_KEY`. A trace whose receivers disagree with their senders, or with a transaction left out, is refused as a provider failure and read from TonAPI instead.
- **`ChainErrorKinds.BroadcastUncertain`** and `isBroadcastUncertainError`: a broadcast that may have reached the network.
- **`TonBroadcastUncertainError`** (kind `BroadcastUncertain`): a broadcast that may have reached the network although it failed — a provider failed without an answer, with no fallback or with the fallback then refusing it. It carries `meta.txHash`; before signing again, wait for `getRequestState` to say `expired` (`consumed`: it landed). The lite server refusing a message on W5's seqno check is `NonceTooLow` (it, or another request with its seqno, landed — what a resend of a landed message gets); any other refusal is `BroadcastRejected`; "duplicate message" counts as sent. All come as HTTP 500 and are read by their text. A TON Center trace that is finished but leaves a transaction out is read from TonAPI. The masterchain head and a deployed wallet's seqno are never read as 0 or `NaN` on a failed or malformed reply, and an account is `nonexist` only when the provider says so. `getSeqno` reads the wallet's get-method live rather than gating on the indexed state, which can trail a deploy.
- **`TonChain.getRequestState({ wallet, seqno, validUntil, hash? })`** → `live | expired | consumed`, the check before signing a replacement. `consumed`: the wallet's seqno moved past the request, or it has a trace — never re-sign. `expired`: chain time (the masterchain head's) a minute past `validUntil`, the seqno not past it and no trace — safe to replace. `live`: it can still execute — a relayed (internal) request that failed included, since W5 keeps its seqno only when the transaction succeeds and anyone can deliver it again until `validUntil`. All reads come from one provider; a failed read throws.
- **Signed requests keep what they commit to**: `createInternalRequest` returns `{ body, seqno, validUntil }` (`tonRelayMessage` takes it); `TonSignedTransaction` reads `walletAddress`, `seqno` and `validUntil` from its signed body, and round-trips through `toJson` / `fromJson` (registered). `tonW5RequestFields` / `tonInternalRequestOf` read them from any signed W5 body.
- **`assertTraceConsistent`** runs in both providers and in the judgment: a trace with a gap — a transaction without an incoming message or a parent, or in a complete trace a sent message no transaction received — is a retryable provider error read from TonAPI, never an undelivered message. An emulation cut short is refused the same way. Transaction ids are refused unless 64 lowercase hex, everywhere; "no trace" is read only from the providers' explicit answers. A TonAPI trace that is its prediction for a message in flight (`emulated`) is never read as on chain.
- **Jetton assets and metadata**: `TonChain.resolveAsset` reads a jetton's symbol and decimals from its TEP-64 metadata (`get_jetton_data`, on-chain and off-chain over https), as Python and the Tron and Stellar ports do; `getJettonMetadata`, `createAsset`, `getJettonAsset`, `getAssetExplorerUrl`; `ton_assets.ts` with `TON_TON`, `TON_USDT`, `TON_MAINNET_STABLECOINS_PEG`. Providers gain `getJettonContent` and `getJettonWalletData`.
- **Transfers** (`TonTransferOptions`): `amountHr` for jettons; `isFullBalance` (native: send mode 130, value 0; jettons: the whole jetton balance); overrides for `bounce`, `sendMode`, `jettonAttachedNanoton`, `forwardTonAmountNanoton`. Native bounce defaults to bounceable only for an `EQ…` address that is deployed.
- **Jetton balance changes** in the status and `emulate`, per owner in the jetton asset, each transfer checked against its master. `jettonCredits` counts a credit unless the jetton wallet aborted.
- **`TonChain.verifySignature(publicKey, message, signature)`**: a TON message signature checked with the public key only, as on Tron and Stellar; strict 128-hex signatures.
- **Reads never fail open**: missing phase data (TON Center's `description`, TonAPI judged from the transaction BOC) is a retryable malformed reply, never a successful transaction; a jetton wallet reads 0 only when it has no code; a trace must be the requested message's.
- **The jetton explorer link** uses the master's bounceable (`EQ…`) form.
- **`TonWallet.signMessage` / `verifySignature`** sign `tonMessageHash(message)`, SHA-256 of `"TON Signed Message:\n"` and the message (as SEP-53 does for Stellar), so a signed message can never pass for a W5 request signature.
- **Workchain -1** (`TonWallet` / `fromMnemonic` `workchain`), with the Python SDK's wallet ids on both workchains (W5's context names workchain 0; v3r2 / v4r2 use 698983191), so -1 wallets match the Python SDK's addresses.
- **Wallet versions v4r2 and v3r2** (`TonWallet` / `fromMnemonic` `version`), as the Python SDK has them: external requests (up to 4 messages, "ignore errors" on each); relayed (gasless) requests stay W5-only and are refused for them. Their broadcast refusals are read by their check order (seqno 33 → `NonceTooLow`; expiry 35 / 36 → `BroadcastUncertain`), and a refusal "before smart-contract execution" (an account that cannot pay) is `BroadcastUncertain` on every version. `tonWalletRequestFields` reads any of the three bodies.
- **`TonWallet.fromMnemonic` without a path** uses TON's own mnemonic scheme — the key and W5 address the Python SDK and TON wallets give for the same words (`deriveTonNativeSeed`); Python's marker path `m/44'/607'/0'/0/0` means the same, and a passphrase is refused there. With a path it derives BIP-39 / SLIP-0010 as before.
- **`TonWallet`**: W5R1 on workchain 0, its key derived from a BIP-39 mnemonic with SLIP-0010 ed25519 at `m/44'/607'/<account>'`. `createExternalRequest` (sent and paid by the wallet itself) and `createInternalRequest` (signed for a relayer, op `0x73696e74`).
- **Relaying:** `tonRelayMessage({ wallet, request, value, deploy })` delivers a wallet's signed request and, with `deploy`, its StateInit, so the relayer deploys it on first use and pays every fee.
- **Messages:** `TonOutMessage`, `tonCommentBody`, `tonJettonTransferBody` (TEP-74), `tonNormalizedExternalHash` (TEP-467, the transaction id).
- **Reads:** account state, seqno, TON and jetton balances, `getJettonWalletAddress`.
- **`TonChain.emulate`**: the whole trace of an external message, signature ignored — fees, success, failed transactions, bounced messages, TON balance changes and jetton credits.
- **`TonTransactionStatus`**: final once the trace is complete and every transaction is in a masterchain-referenced block, with no confirmation count. `Failed` when the request did not do what it was signed for — the sending (or relayed) wallet failed, skipped a message or did not execute the request, or a message it sent bounced, or (a jetton transfer) was not sent on, or reached a receiver that failed without sending it back (`failed`, code `receiver_failed`: nothing returned); `bounced` only when the trace has the bounce. `summary.deliveries` gives each message's outcome. Failures further down the trace do not fail it.

### Changed

- **`TonAddress.canonical()`** is the raw form with a lowercase hash, so every form of one account compares equal (it returned the input before). It also converts to either user-friendly form and reports the input's flags.
- **The root entry exports only `TonAddress`** from the TON family, so it loads no `@ton/*` dependency.

### Dependencies

- `@ton/core` ^0.63, `@ton/crypto` ^3.3, `@ton/ton` ^16.3.

## [0.6.3] — 2026-10-05

Tron: a transaction status rango-intents can trust, and local signing for depositron (RIN-317). No new node calls; building a transaction makes one fewer.

### Added

- **`TronTransactionStatus.blockNumber`, `.signers`, `.memo`, `.memoHex`**, filled on successful and failed statuses from the two replies the status already reads:
  - `blockNumber` is the including block;
  - `signers` is the contract's owner account as a `T…` address (`[]` without the raw transaction);
  - `memoHex` is `raw_data.data` in lowercase, and `memo` is its strict-UTF-8 decoding.
  Pending and not-found statuses carry `null`, `[]`, `null`, `null`. All four are optional in the init, so existing constructors compile unchanged.
- **`decodeTronMemo(memoHex)`**: the memo decoder, identical to Clydner's `memoOf` (strict UTF-8, a leading byte-order mark dropped, `null` for empty, odd-length, non-hex or invalid UTF-8 input).
- **`TronTransaction.rawDataHex`**: the locally serialized `raw_data`.

### Changed

- **Balance changes count only real money moves.**
  - Internal transactions count as TRX only when not `rejected`, with a `call` or `suicide` note, summing every `callValueInfo` entry without a `tokenId`.
  - `TriggerSmartContract` `call_value` is debited from the owner and credited to the contract.
  - A `Transfer` log counts as TRC-20 only with exactly three topics and one 32-byte data word.
  Before, rejected entries, staking and delegation entries, and TRC-10 amounts were counted as TRX.
- **The txID is computed locally.**
  - `build()` hashes the protobuf-encoded `raw_data` (`TransferContract`, `TriggerSmartContract`, `FreezeBalanceV2Contract`, `DelegateResourceContract`) instead of asking `wallet/getsignweight`, which is now called only when a permission id is set, and must agree.
  - `sign()` / `TronWallet.signTransaction()` recompute the txID and refuse a carried `txID` or `raw_data_hex` that does not match, or an unsupported contract type, before the key is used.
  - `broadcast()` / `broadcastSignedTransaction()` re-check the txID before sending (so an altered stored transaction never reaches the node, and is reported as `InvalidArgument`) and require the node's reply to name the same txID (`RpcError` otherwise).

### Note

- TypeScript-only. omnichain-py's side of both fixes is on RIN-328; `docs/tron.md` lists them under "Differences from omnichain-py".

## [0.6.2] — 2026-10-04

Adds multi-signer UTXO transactions (RIN-267). A consumer that spends pre-selected inputs owned by several keys can now assemble, sign per key, finalize and broadcast without importing `bitcoinjs-lib`. Keys stay with the consumer; the SDK receives signer objects.

### Added

- **`UtxoChain.assembleTransaction({ inputs, outputs, rbfEnabled? }): UnsignedUtxoTransaction`**: builds from explicit inputs (`{ utxo, parentTxHex }`) and outputs (`{ kind: 'address', address, valueSats }` or `{ kind: 'opReturn', data }`), in the given order, with no coin selection and no automatic change.
  - Inputs are added the way `createTransferUnsignedTransaction` adds them (`nonWitnessUtxo` always, `witnessUtxo` on segwit and P2SH, RBF or final sequence).
  - `feeSats` is inputs minus outputs, `feeRateSatsPerVByte` is `feeSats / estimatedVBytes`, `changeAddress` is `null`, and `inputsToSign` groups input indices by `ownerAddress`.
  - Every input is checked against its parent transaction (txid, output value, output script) and against its `ownerAddress`, so the reported fee is what the chain will charge.
  - Address outputs must be at or above the chain's dust value; at most one OP_RETURN output of up to 80 bytes; outputs may not exceed inputs.
- **`UnsignedUtxoTransaction.signWith(signer): UnsignedUtxoTransaction`**: signs the P2WPKH and P2PKH inputs whose script belongs to `signer.publicKey` and returns a new transaction, so calls chain. Repeating a key is a no-op; a key that owns no input throws. Taproot, P2WSH and P2SH inputs are never signed. Works on transactions from `createTransferUnsignedTransaction` too.
- **Parent checks before signing and finalizing**: `signWith` and `finalize` require every input's parent transaction, refuse a declared amount or script that differs from the parent output, and refuse a transaction whose real fee differs from `feeSats`. The signer is never called for such a transaction, so a provider that misreports an amount cannot lead to a signed, fee-burning transaction.
- **`UnsignedUtxoTransaction.finalize(): { hex, txid, vsize }`**: requires a signature on every input (naming the first unsigned index), verifies every signature in strict low-S mode, refuses a fee rate of 5000 sat/vB or more, and returns broadcast-ready hex with its txid and real vsize.
- **`UtxoChain.addressForPublicKey(publicKey, scriptType = 'p2wpkh')`**: P2WPKH or P2PKH address of a 33-byte compressed public key on the chain's network. P2WPKH on a network without segwit (Dogecoin) throws `FeatureNotSupported`.
- **`utxoFromRawTransaction(rawTxHex, vout, ownerAddress)`**: reads one output of a raw transaction into an `UnspentTransactionOutput`, without a network call; the txid is computed from the hex.
- **Types**: `UtxoPsbtInput`, `UtxoPsbtOutput`, `AssembleUtxoTransactionRequest`, `UtxoSigner`, `FinalizedUtxoTransaction`, `UtxoSingleKeyScriptType`, and `UtxoNetworkInfo`, which is now the declared type of `UtxoNetworkParams.networkInfo` (same structure as before).

### Note

- Additive only; no existing method changes behaviour. All errors are `ChainError` (`InvalidArgument`, `InvalidAddress`, or `FeatureNotSupported`).
- TypeScript-only; omnichain-py has no counterpart.

## [0.6.1] — 2026-10-04

Adds a raw storage-slot read to `EvmChain` (RIN-320). Consumers can read contract state, including an EIP-7702 delegate's state in the EOA's own storage, without reaching through `getProvider()`.

### Added

- **`EvmChain.getStorageAt(address, slot): Promise<string>`**: one `eth_getStorageAt` call. Returns the 32-byte word as a `0x`-prefixed lowercase hex string (66 characters); an unset slot returns 32 zero bytes. Works on every `EvmChain`; `supports7702` is not required.
  - Invalid address → `ChainError(InvalidAddress)`. A slot that is not a `bigint` in `0 … 2^256 − 1` → `ChainError(InvalidArgument)`. Both are raised before any RPC call.
  - RPC failure, or a reply that is not a hex word of at most 32 bytes → `ChainError(RpcError)`, with `address` in `meta` and the RPC URL sanitized.

### Note

- Additive only. TypeScript-only for now; omnichain-py parity is tracked in RIN-322.

## [0.6.0] — 2026-10-04

Adds the Stellar and Tron chain families at parity with omnichain-py (RIN-315). Both are ports of `impl/stellar` and `impl/tron`: same methods (camelCased), same arguments and defaults, same RPC calls, same balance-change rules, same wallets and the same JSON wire format. They were verified against Python on mainnet and testnet:
- Every mainnet case from Python's integration tests produces identical output.
- Every key and signature vector from Python's unit tests is byte-identical.
- A transaction built by TS, signed by Python's `StellarWallet` and broadcast by TS lands on testnet.

### Added

- Stellar and Tron are imported from their subpaths only. Like Python's `import omnichain`, the root entry does not load the families' chain modules, so at runtime `@stellar/stellar-sdk` is loaded only by consumers that use Stellar. Consumers that compile omnichain's source need it at compile time; see Migration.
- **`@getomnichain/omnichain/stellar`**:
  - Chains: `StellarMainnet` / `StellarTestnet`.
  - Assets: `StellarAsset` (native, SAC, non-SAC Soroban), `STELLAR_XLM` / `STELLAR_USDC` / `STELLAR_EURC` / `STELLAR_BNUSD` plus testnet assets, `STELLAR_MAINNET_STABLECOINS_PEG`.
  - `StellarChain` methods:
    - transfers: `createTransferTransaction` (classic `Payment` or Soroban `transfer`, with trustline prerequisites), `createExactInSwapTransaction`;
    - status: `getTransactionStatus` (Horizon effects, Soroban diagnostic events, Stellar Expert fallback, memo, fees);
    - simulation and broadcast: `simulateTransaction`, `broadcastSignedTransaction`;
    - reads: `getAssetBalance` (reserve-aware), `getWalletBalance`, `getTrustLineLimit`, `resolveAsset`, `createSacToken`, `createNonSacToken`;
    - utilities: `verifySignature` (SEP-53), `getAccountNextSequence`.
  - Models: `StellarUnsignedTransaction` (intent → envelope at sign time), `StellarSignedTransaction`, `StellarWallet` (SEP-5 mnemonic, SEP-53 messages, trustline handling, Friendbot), `StellarAddress`, `StellarGasPricing`.
- **`@getomnichain/omnichain/tron`**:
  - Chains: `TronMainnet` / `TronShastaTestnet`.
  - Assets: `TronAsset` (TRX + TRC-20), `TRON_TRX` / `TRON_USDT` / `TRON_USDC` plus Shasta assets, `TRON_ASSETS_REQUIRING_ZERO_RESET_APPROVAL`, `TRON_MAINNET_STABLECOINS_PEG`.
  - `TronChain` methods:
    - transfers: `createTransferTransaction` (TransferContract / TRC-20 `TriggerSmartContract`, memo, fee limit);
    - status: `getTransactionStatus` (TransferContract + internal transactions + TRC-20 logs + fee);
    - simulation and broadcast: `simulateTransaction` (`wallet/triggerconstantcontract`, energy), `broadcastSignedTransaction` (duplicate-tolerant);
    - reads: `getAssetBalance`, `resolveAsset`, `getChainParameters`;
    - utilities: `verifySignature`.
  - Models: `TronTransactionFees` (with Python's cross-field validator), `TronWallet` (BIP-44 secp256k1, tronpy-compatible message signatures, USDT zero-reset approve flow), `TronAddress`, `TronGasPricing`, `parseTronCanonicalTransaction` (the 12-contract schema from `helpers/transaction.py`).
  - Ports of the tronpy pieces Python relies on: `TronClient`, `TronTransaction` / `TronTransactionBuilder`, `TronContract`, and the keys module (`TronPrivateKey` / `TronPublicKey` / `TronSignature`, base58check helpers).
- **Python base types** used by both families:
  - enums `ChainType`, `WalletFamily`, `FiatCurrency`;
  - `AbstractTransactionPrerequisite`, `AbstractHandledPrerequisiteResponse`, `UnsignedTransactionWithPrerequisites`;
  - `AbstractSignedTransaction`, `AbstractBroadcastTransactionResponse`;
  - `AbstractTransactionSimulationResult` with `TransactionSimulationStatusTypes`;
  - `AbstractSignedMessage`, `AbstractWallet`, `AbstractBip32StyleSingleAccountWallet`, `AbstractAssetBalance`;
  - the BIP-39 helpers `mnemonicToSeedSep5` / `mnemonicToSeedBip39`.
- **JSON wire format shared with Python** — `toJson()` / `toJsonStr()` / `fromJson()` on the Stellar and Tron unsigned/signed transactions, using Python's `{type, chain_id, …}` envelope. `UnsignedTransaction.fromJson` and `AbstractSignedTransaction.fromJson` dispatch on `type`, so payloads move between Python and TS processes unchanged. A family's types are registered when its subpath is imported: import `@getomnichain/omnichain/stellar` or `/tron` before decoding its payloads through the root `fromJson`.
- **`NetworkType.STELLAR`**, with the Stellar chain ids seeded in the registry. `addressFor` now parses addresses instead of throwing `ChainNotSupported`:
  - Tron (`TronAddress`): what Python's `validate_wallet_address` + `format_wallet_address` accept, a `T…` base58check address of 21 bytes; `validateAddress` uses the same check.
  - Stellar (`StellarAddress`): `G…` / `M…`, checked without loading `@stellar/stellar-sdk`.
- **Python-semantics helpers** the ports rely on:
  - `AssetMap`, a `Map` keyed by asset value like a Python `dict`, and the shared asset registry (`searchRegisteredAsset` / `getRegisteredAsset`);
  - `bytesFromHex`, equivalent to `bytes.fromhex`;
  - `pyRepr` / `pyStr` / `pyTypeRepr` / `pyFloatRepr`, so error and `toString` texts match Python's;
  - `pyJsonDumps`: `toJsonStr` output is byte-identical to omnichain-py's `to_json_str` and accepts its `json.dumps` options;
  - `tronAbiEncodeSingle` / `tronAbiDecodeSingle`, a port of tronpy's `trx_abi` (strict eth_abi decoding with Tron addresses).
- **Tests** — 988 new tests:
  - Python's wallet vectors;
  - mainnet status cases replayed offline from recorded RPC responses;
  - Python JSON payload fixtures;
  - fixtures generated by CPython / pydantic / tronpy / eth_abi for hex parsing, UTF-8, `int`, `repr`, `json.dumps`, ABI coding, signing and node error texts;
  - Horizon and TronGrid exercised over real local HTTP;
  - builders, simulation, broadcast, prerequisites, canonical transactions.

### Changed

- `UnsignedTransaction` gains `toJson()` / `toJsonStr()` (throwing `FeatureNotSupported` for models without a JSON form, as in Python) and a static `fromJson`.
- New runtime dependency `@stellar/stellar-sdk` `^15.1.0`, the newest line that still supports Node 20 (v17 requires Node ≥ 22.12). Tron adds no dependency.

### Migration

- **Consumers that compile omnichain's source** (a submodule whose `.ts` files are in the consumer's `tsconfig` `include`) must add `@stellar/stellar-sdk` `^15.1.0` and `decimal.js` to their own dependencies, or exclude `stellar/**` from compilation if they do not use Stellar. npm consumers of the built package get both as dependencies.
- **`NetworkType.STELLAR` is a new enum member.** Exhaustive `switch`es over `NetworkType` and local mirrors of the enum need a `STELLAR` case.
- **Registry and address behaviour on Tron and Stellar chain ids:**
  - `networkTypeOf(-3500)` / `networkTypeOf(-3501)` threw before and now return `STELLAR`.
  - `registerNonEvmChain(-3500 | -3501, <another type>)` now throws, because the ids are seeded as Stellar. Call `unregisterChain` first to reclassify one.
  - `addressFor`, `canonicalizeAddressStrict` and `@IsAddress` on Tron and Stellar chain ids validate the address instead of throwing `ChainNotSupported`.
- **Advisories inherited from `@stellar/stellar-sdk` 15.1.** It pins `axios` 1.15.0 and depends on `toml` 3.0.0, both with high-severity advisories. The stellar-sdk line that fixes them (17.x) needs Node ≥ 22. Consumers can lift both with npm `overrides`; with this recipe `npm audit` reports no vulnerabilities for stellar-sdk, and the Stellar test suite passes on axios 1.20:

  ```json
  "overrides": { "@stellar/stellar-sdk": { "axios": "^1.20.0", "toml": "^4.2.0" } }
  ```

### Note — differences from omnichain-py

- Transport and API failures of the transaction lookup during `getTransactionStatus` (Horizon 429/5xx, TronGrid rate limits) throw `ChainError(RpcError)`; Python reports them as `NotFound`. Real "not found" answers still return `NotFound`.
- Non-SAC Soroban balances are converted exactly; Python divides with a float.
- Tron debug `print()` calls and Python's log lines are not ported. tronpy's bundled shared TronGrid keys are not shipped.
- `StellarWallet` errors never include the secret seed.
- `AbstractWallet.signAndBroadcastTransaction` is Python's `sign_and_broad_cast_transaction` without the spelling slip.
- The TS `Chain` adapters wrap the Python-parity methods: `getBalance`, `createTransferUnsignedTransaction`, `broadcast`, `verifyMessageSignature`, `getChainTipHeight`, and batch `getTransactionStatus`.
  - Stellar's adapter rejects `isFullBalance`, because Python ignores it and the TS request then has no amount;
  - Stellar's adapter refuses a transfer whose trustline prerequisite is still pending (same check as Python's `ensure_minimum_trust_line`), because it can only return the transaction;
  - Tron's `broadcast` adapter throws `BroadcastRejected` only for codes java-tron returns before accepting the transaction (`SIGERROR`, `CONTRACT_VALIDATE_ERROR`, `CONTRACT_EXE_ERROR`, `BANDWITH_ERROR`). Everything else that Python returns as `broadcast_error`, `DUP_TRANSACTION_ERROR` and a reply without `txid` included, is `RpcError`: check the transaction's status before re-signing. `TRANSACTION_EXPIRATION_ERROR` and `TAPOS_ERROR` are `RpcError` too, because java-tron checks expiry before its duplicate check, so re-broadcasting a transaction that already landed returns them after the 60 s expiry;
  - Stellar's `broadcast` adapter throws `RpcError` for a Horizon `200` without `hash` (Python's `KeyError('hash')`);
  - `wait` / `confirmations` options are rejected, as on UTXO.
- Soroban `prepare` assembles the transaction like stellar-sdk Python's `_assemble_transaction`: the signed fee is the classic fee plus the simulation's `minResourceFee`.
- Horizon submit reads `hash` without decoding `result_xdr`, as Python does, so a landed transaction is never reported as failed because of an unknown result type.

### Known issues shared with omnichain-py

These are bugs in omnichain-py itself. They are kept for parity and tracked to be fixed in both SDKs. Consumers that credit deposits from transaction status should account for them:

- RIN-316 (Stellar) — any contract can emit a `transfer` event carrying a SAC topic and pose as USDC / XLM in status, and `resolveAsset` returns XLM for any contract whose `name()` is `"native"`.
- RIN-317 (Tron) — status counts rejected internal transactions and TRC-10 `callValue` as TRX, and does not debit TRX sent as `call_value`.
- RIN-318 (Tron) — the wallet signs the txID returned by the node (or found in a JSON payload) without recomputing it from `raw_data`.
- RIN-319 (Stellar) — a decimals fallback of 7 is cached after an RPC error, and Horizon effects are read from the first page (200) only.
- Stellar — the ID of a muxed `M…` receiver is stripped to its `G…` account when a transfer is built.

### Note — upstream behaviour mirrored as-is

- Today's Soroban RPC returns diagnostic events at the top level, not under `events` where Python reads them. Historical Soroban statuses therefore resolve through the Stellar Expert API in both SDKs.
- `TronTransactionFees` validates against the *current* energy price. Transactions executed under an older price fail that check in both SDKs, which affects some historical Shasta transactions.

---

## [0.5.1] — 2026-09-22

Surfaces Solana finality on `SolanaTransactionStatus` (RIN-296, SDK half of RIN-285). Non-blocking pollers can now read one status snapshot and see how close to finality a tx is, matching the pattern EVM (`blockNumber` + tip derivation) and UTXO (RIN-195's carried `confirmations`) already use.

### Added

- **`SolanaTransactionStatus.slot: number | null`** — from `getTransaction`'s `slot` on the success path; from `getSignatureStatus`'s `slot` on the ledger-pruned fallback.
- **`SolanaTransactionStatus.confirmations: number | null`** — the raw RPC count for non-final states, normalised to the exported `SOLANA_FINALIZED_CONFIRMATIONS = 32` when the RPC returns `null` (rooted, per the Solana RPC contract). `null` when the sig-status read was unavailable.
- **`SolanaTransactionStatus.confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null`** — the raw RPC string.
- **`SolanaTransactionStatus.signers: readonly string[]`** — base58 signer keys in message order (the first `header.numRequiredSignatures` `staticAccountKeys`). Mirrors omnichain-py `signer_keys = account_keys[: header.num_required_signatures]` at `impl/solana/base.py:1175`. Empty on the ledger-pruned fallback and on `notFound`.
- **`SOLANA_FINALIZED_CONFIRMATIONS = 32`** — exported constant.
- **`SolanaConfirmationStatus`** — union of the three RPC states.

### Changed

- **`SolanaChain.getTransactionStatus`** fires `getTransaction` and `getSignatureStatus` in parallel via `Promise.allSettled` (RIN-296 D1) — the common Success case pays one round-trip of latency instead of two. Sig-status failure on the Success path degrades the four new fields to `null`/`[]` rather than failing the whole read (D2). The ledger-pruned Pending branch carries whatever finality it has (D3).

### Note

- No `blockNumber` field. Solana slots are not block heights (skipped slots exist) and `getChainTipHeight` returns a block height (0.3.3 fix); consumers deriving finality from `blockNumber` on other families must gate Solana on `confirmations`.
- **Additive only.** All new fields optional in the init with safe defaults (`null` / `[]`); every pre-0.5.1 `SolanaTransactionStatus.successful/failed/pending/notFound` call site compiles unchanged.
- **Note on version bump.** RIN-285 R4 specifies a **minor** bump. This release ships as a **patch** (0.5.0 → 0.5.1) per requester decision. Under SemVer this is a documented divergence — the change is additive to the public surface (new optional fields, new exported constant/type) and a minor bump would be more strictly correct.

---

## [0.5.0] — 2026-09-21

Adds a single canonical bidirectional map between omnichain chain ids and Rango's uppercase `blockchains[].name` identifiers. Removes the need for downstream consumers that talk to Rango to maintain their own partial copies of the mapping.

### Added

- **`CHAIN_ID_TO_RANGO_NAME: ReadonlyMap<number, string>`** on `rango_chain_names.ts` — primary map for every omnichain chain that appears in Rango's `/meta`. Sourced from `GET https://public-api.rango.exchange/basic/meta`, snapshot dated 2026-09-21.
- **`RANGO_NAME_TO_CHAIN_ID: ReadonlyMap<string, number>`** — the inverse map, keyed by uppercase name.
- **`NOT_ON_RANGO: ReadonlySet<number>`** — explicit "not on Rango" decisions for testnets + mainnet chains omnichain declares but Rango's `/meta` does not carry (e.g. `MANTLE`, `OPBNB`, `SEI_EVM`, `WORLD_CHAIN`, `WANCHAIN`, `ABSTRACT`, `INK`, `BOB`, `ZKLINK_NOVA`, `TEMPO`). Each id must appear in the map or here; the coverage test fails otherwise, and `prepublishOnly` now runs the suite so an undecided chain id cannot ship.
- **`rangoNameForChainId(chainId)`** and **`chainIdForRangoName(name)`** — accessors. The name-side normalises `trim() + toUpperCase()` and returns `undefined` for any non-string input, so callers looping over untrusted Rango feed rows can skip bad entries instead of aborting.
- **Fixture** `test/fixtures/rango_meta_blockchains.json` — compact wrapper `{fetchedAt, source, blockchains: [{name, chainId, type}, …]}` of Rango's `/meta`, ~8 KB. The map's substance is verified against it: every mapped name exists, every positive-id row's parsed `chainId` (hex `0x…` or decimal) equals the omnichain id, every non-positive mapped id lives on the family predicate the fixture type implies (`SOLANA→isSolana`, `SUI→isSui`, `XRPL→isXrpl`, `STELLAR→isStellar`, `TON→isTon`, `TRANSFER→isUtxo`; TRON is positive and covered by the hex check), and no `NOT_ON_RANGO` id is actually present in the fixture. Refreshing the map becomes "replace fixture, rerun tests."
- **Tests** in `test/rango_chain_names.spec.ts`: bijection, no-duplicate names, name-format invariant (`/^[A-Z0-9_]+$/`), critical anchors (BTC=-1, SOLANA=-2000, ETH, BSC, ARBITRUM, BASE, LINEA, AVAX_CCHAIN, LTC, DOGE, BCH, TRON), case/whitespace normalisation, unknown-and-non-string handling, disjoint map/`NOT_ON_RANGO`, exhaustive `chain_ids.ts` coverage, and the three fixture-backed feed checks.

### Note

- Aliases (alternate Rango spellings for the same chain) are out of scope. If a consumer hits one in the wild, opening a follow-up to add it is a separate decision.

---

## [0.4.0] — 2026-09-16

Brings TS `UtxoTransactionStatus` in line with the Python SDK's already-shipped UTXO shape: per-input `{address, value}` surfaced, and `balanceChanges` becomes net per-address (matching EVM/Solana). Every hydration detail lives in the per-tool provider, mirroring Python's `AbstractUtxoTool.get_tx`.

### Added

- **`UtxoTransaction` interface** on `utxo/utxo.ts` — the intermediate type returned by the tool layer, mirroring Python's `class UtxoTransaction`: `{ inputs, outputs, netChangesHr: Record<string, Decimal>, size, vsize, confirmations, confirmationDatetime }`.
- **`UtxoTransactionInput` type** — `{ txid, vout, scriptPubkeyHex, address, valueSats, valueBtcHr, coinbase? }`. Both `valueSats` (bigint, `@deprecated`) and `valueBtcHr` (Decimal) are populated this release; the deprecated `valueSats` is scheduled for removal in a future major, with `valueBtcHr` renamed → `value` at that point to align with Python. Mirrors the `AssetBalanceChange.balanceChangeMr`/`Hr` idiom.
- **`UtxoRawTransactionProvider.getTransactionWithInputs(txid)`** — new provider method returning a fully-hydrated `UtxoTransaction`. Every adapter is responsible for hydration per its API, matching Python's per-tool approach.
- **`EsploraTool.getTransactionWithInputs`** — parses inline `vin[*].prevout` from Esplora's `/tx/{txid}` response; zero extra RPCs.
- **`BitcoinCoreTool.getTransactionWithInputs`** — hydrates via a hybrid path that works on every Core version: whichever verbosity the caller requests (`bitcoinCoreVerbose?: 1 | 2`, default `1`), the adapter uses any `vin[*].prevout` the response inlines and runs a batched `getrawtransaction verbose=1` walk for the vins that do not carry a prevout (older Core, mempool txs, pruned-block txs, Core < 25). Zero extra RPCs when block undo data is available; N extra otherwise. Matches Python's `impl/utxo/tools/bitcoin_core.py:453` cost profile on the fallback path. Setting `bitcoinCoreVerbose: 2` on Core ≥ 25 is the recommended production configuration for confirmed-heavy status polling.
- **`UtxoTransactionStatus.inputs`** — `readonly UtxoTransactionInput[] | null`. Populated when the provider tool hydrated every non-coinbase input; `null` (with `inputsUnresolvedReason: 'pending'`) on `Pending` statuses whose provider skips hydration.
- **`UtxoTransactionStatus.inputsUnresolvedReason`** — `'provider_error' | 'parent_missing' | 'pending' | null`.
- **`UtxoInputsUnresolvedReason`** type on `utxo/utxo.ts`.
- **8 new RIN-226 unit tests** covering: inputs order + dual units, net semantics on a mixed-owner tx, self-send fee-only debit, no legacy accessor, hydration failure → thrown `RpcError`, coinbase input shape, `Pending` + hydration unavailable, `valueSats`/`valueBtcHr` agreement.

### Changed (breaking on the UTXO surface)

- **`UtxoTransactionStatus.balanceChanges`** is now **net per-address** (from `UtxoTransaction.netChangesHr`) on `Success` statuses — inputs debited, outputs credited. Previously gross output credits per receiving address. Matches `EvmTransactionStatus`, `SolanaTransactionStatus`, Python's UTXO status, and Clydner's BlockCypher parser.
- On confirmed + hydration failure, `UtxoChain.getTransactionStatus` **throws `ChainError(RpcError)`** rather than returning a `Success` with `null` balance changes (preserves the base `TransactionStatus(Success)` invariant that requires `balanceChanges` present).
- Rewrote the `UtxoTransactionStatus` class docstring — the "gross output credits" caveat and the "`inputs` … comes back in the 2C UTXO port" TODO are removed.
- No `outputCreditsByAddress()` accessor and no `grossOutputCreditsLegacy` field: deposit detectors that only need who-got-credited iterate `status.outputs[]` directly (Python has neither).

### Note

- Migration: consumers that summed positive UTXO credits from `balanceChanges` need to switch to iterating `status.outputs[]` per address. A hot-wallet withdrawal that previously read as a large positive credit (from the change output) now reads as a net debit for the fee — the correct sign.
- Companion cards to file: rango-intents BTC-8 workaround deletion (drop `enrichInputTxFromChain` and the parent-tx resolver; consume `status.inputs` + iterate `status.outputs[]` for deposit detection) and Clydner BlockCypher-parser netting (drop the parser's own netting or document why it stays because it ingests BlockCypher payloads directly, not SDK statuses).

---

## [0.3.6] — 2026-08-03

Adds per-transaction visibility into internal ETH movements. The receipt-only `decodeBalanceChanges` cannot see router-mediated ETH (e.g. `WETH9.withdraw` + a router forwarding via `msg.sender.call{value: wad}`); this release exposes the underlying trace primitive and adds an opt-in flag on `decodeBalanceChanges` that folds it in.

### Added

- **`EvmChain.getInternalTransfers(txHash): Promise<InternalEthTransfer[]>`** — wraps `debug_traceTransaction` with `{tracer: 'callTracer'}` and walks the returned call tree, emitting one `{ from, to, value }` per non-zero `CALL` / `CALLCODE`. `DELEGATECALL` and `STATICCALL` (which cannot move ETH) are excluded. Reverted subtrees (nodes with `error` set) are skipped. Addresses lowercased.
- **`InternalEthTransfer`** type re-exported from `evm/evm_chain.ts`: `{ from: string; to: string; value: bigint }`.
- **`decodeBalanceChanges({ …, includeInternalTransfers: true })`** — new optional flag. When set, folds internal ETH movements into the returned native credits/debits by calling `getInternalTransfers` internally. Costs one extra RPC call (the trace); throws `FeatureNotSupported` on providers without trace support. Off by default — receipt-only behavior is unchanged (matches the Python reference).
- **`GetTransactionStatusOpts.includeInternalTransfers?: boolean`** — plumbs the same flag through the top-level `chain.getTransactionStatus(hash, opts)` and its array/batch overload, so consumers using the high-level status API get the fold path without dropping to `decodeBalanceChanges` directly. EVM-only; ignored on other families.
- New failure modes on `getInternalTransfers`: malformed `txHash` → `InvalidArgument`; provider doesn't expose `debug_traceTransaction` (public RPCs, Alchemy free tier) → `FeatureNotSupported` with a provider-tier note; other transport failures → `RpcError` with URL-redacted message + cause.

### Notes

- **No double-counting on direct-value txs.** When `includeInternalTransfers: true`, the sender's native debit is `-gasCost` (not `-(value + gasCost)`) and the top-level `to`'s `+value` credit is omitted — the trace walker emits both legs of the top-level CALL, so folding in `value` a second time would inflate the sender's outgoing.
- **Two RPCs are the minimum** when `includeInternalTransfers: true`: the caller still needs `eth_getTransactionReceipt` for `gasUsed` / `status` / `blockNumber` and ERC-20 `Transfer` logs; `debug_traceTransaction` supplies internal ETH. Neither call on its own carries the union of what's needed.
- Alternative single-tx approaches (`eth_getBalance` at `blockNumber - 1` vs `blockNumber`) miscount when the block contains multiple transactions touching the same address; the tracer is the only accurate per-tx path.
- Receipt-only `decodeBalanceChanges` (default) still matches the Python reference. The trace-fold path is a TS-side extension pending upstream Python parity.

---

## [0.3.5] — 2026-08-03

Restore functionality that was incorrectly removed pre-0.2.0.

### Added

- **`Chain.verifyMessageSignature(req: VerifyMessageSignatureRequest)`** restored on the base class (abstract) with per-family implementations:
  - **EVM**: `ethers.verifyMessage(message, signature) === getAddress(signer)` (EIP-191 `personal_sign` envelope). Accepts checksummed, lowercase, or unprefixed-40-hex signer forms.
  - **Solana**: ed25519 verify of raw message bytes against the signer pubkey. Signature accepted as base58 (native) or hex (128 chars). Signer must be a 32-byte base58 pubkey.
  - **UTXO**: `bitcoinjs-message.verify` with the family's `messagePrefix` and segwit-tolerant checking (`checkSegwitAlways = true`).
  - Never throws for "signature doesn't match" — returns `false`. Malformed inputs also return `false` (not thrown).
- **`VerifyMessageSignatureRequest { message, signer, signature }`** type re-exported from `chain.base.ts`.
- New direct dependencies: **`bs58@^6`** (Solana signature/signer decode) and **`bitcoinjs-message@^2`** (UTXO verify). Both were transitive before; making them explicit fixes hoisting fragility.

### Note

- This capability was originally added at `3ad092c` and removed at `327598c` (before the 0.2.0 npm release) on a "Python parity" argument. The removal was wrong — the method has active consumer usage (wallet-connect login, off-chain attestations, wallet-ownership proofs) that has no non-family-coupled substitute. Restoring it here matches the 0.2.x-era API shape exactly so consumers can consume it without changes to call sites written against the older abstract.

---

## [0.3.4] — 2026-08-03

Bugfix.

### Fixed

- **Jito bundle auth header** — `SolanaChain.submitJitoBundle` and `SolanaChain.getBundleStatus` were sending the UUID under `Authorization: Bearer <uuid>`; the block engine's authenticated tier expects **`x-jito-auth: <uuid>`** (confirmed against Jito's own `jito-labs/jito-py-rpc` SDK). With the wrong header the block engine accepted the submit (returned a bundle id) but treated the request as unauthenticated — bundles never landed and every bundled tx timed out at the ~70s blockhash window. Regression noted in 0.3.0 Known Limitations as "verify against endpoint"; verified against production by the gasless team on 0.3.3. Now sends `x-jito-auth` at both call sites; unauthenticated (no `jito.auth` configured) still sends no auth header at all.

---

## [0.3.3] — 2026-08-02

Bugfix.

### Fixed

- **`SolanaChain.getChainTipHeight()`** returned the **slot** (`getSlot('confirmed')`) instead of the **block height** (`getBlockHeight('confirmed')`). The method's cross-family contract is a block-height accessor comparable with `getLatestBlockhash().lastValidBlockHeight`, which is a block height. On Solana `slot > blockHeight` always (currently by ~25M — slots include skipped/empty ones), so any consumer doing the standard blockhash-expiry check `getChainTipHeight() > lastValidBlockHeight` saw `true` immediately and marked every freshly-built Solana tx as expired within ~1s. Now returns `getBlockHeight('confirmed')`; the value is the same units as `lastValidBlockHeight` and the expiry math works correctly. `EvmChain.getChainTipHeight()` was already correct (returns block number).

---

## [0.3.2] — 2026-08-02

Additive minor. Closes the final gasless "only-omnichain" gap: `simulateTransaction` now exposes web3.js's `accounts` passthrough so consumers can read post-simulation account state (the primitive `measureUserPrefundViaSimulation` needs).

### Added

- **`SolanaChain.simulateTransaction(signed, opts)` — `opts.accounts?: { addresses: string[] }`**. When supplied, the return object gains an `accounts?: ({ lamports: number; data: Uint8Array } | null)[]` field in the same order as `opts.accounts.addresses`. Missing addresses in the post-sim state map to `null`. Base64 is used on the wire and decoded to `Uint8Array` for the consumer.
- Validation: empty `addresses[]` throws `InvalidArgument`; a malformed pubkey throws `InvalidAddress`.
- Back-compat: when `opts.accounts` is omitted, the return shape is unchanged from 0.3.1 (`accounts` field absent).

---

## [0.3.1] — 2026-08-02

Additive minor. Two new `SolanaChain` read primitives to unblock the gasless `RIN-153` migration finish — consumers assembling `MessageV0` locally (custom fee ix + Jito tip + ALTs merged with aggregator swap bytes) can now route every chain **read** through the SDK without being pushed into the opinionated full-builder. Local computation (compile + sign) stays consumer-side by design.

### Added

- **`SolanaChain.getLatestBlockhash(commitment?)`** — thin passthrough to `Connection.getLatestBlockhash`. Returns `{ blockhash, lastValidBlockHeight }`. Defaults to `'confirmed'`; accepts `'processed' | 'confirmed' | 'finalized'` (consumers with Jito flows should pass `'processed'` — RPC lag vs Jito's leader tip can otherwise reject a submitted bundle as `Invalid`). Transport failures wrap as `ChainError(RpcError)` with URL-redacted messages.
- **`SolanaChain.simulateTransaction(signed, opts?)`** — passthrough to `Connection.simulateTransaction`. Accepts a signed `VersionedTransaction` as `Uint8Array` or `0x`-prefixed hex; deserializes internally. Returns `{ unitsConsumed, err, logs }`. Opts: `{ sigVerify?, replaceRecentBlockhash?, commitment? }`. Input validation matches `broadcast` (rejects empty / <65 bytes / malformed hex as `InvalidArgument`). Companion to `estimateAndApplyCu`, which only sizes SDK-built transactions — this is the raw primitive for consumers that build the tx themselves.

Both methods reuse the internal `rpcWrap` sanitizer path so no keyed URL can leak through their error messages.

### Notes

- `SolanaChain.estimateAndApplyCu` and `SolanaChain.createUnsignedTransaction` continue to be the preferred paths when the SDK owns the tx build; these primitives are for the consumer-owned-build case.

---

## [0.3.0] — 2026-08-02

Complete chain-connection surface. Consumers can now build any protocol flow — including EIP-7702 relayers, Solana Jito bundles, arbitrary contract calls — without importing `ethers`, `@solana/web3.js`, `@solana/spl-token`, or `bitcoinjs-lib` directly.

Design principle: minimum new API surface. 10 new methods total; optional-field extensions where existing shapes already covered the use case. Policy, orchestration, state, jobs, retries, tip sizing, endpoint-list content, wallet custody stay in the consumer.

### Added

#### New base method (all 3 families)

- `Chain.broadcast(signed: string | Uint8Array, opts?: BroadcastOpts): Promise<string>` — universal broadcast entry point. Returns deterministic tx hash (EVM/UTXO) or base58 signature (Solana, both `direct` and `via: 'jito'`). Handles "already-known" retries as success (safe against load-balanced provider propagation lag).

#### `EvmChain`

- `getPendingNonce(address): Promise<bigint>`
- `getDelegation(address): Promise<string | null>` — parses EIP-7702 delegation designator (`0xef0100 || <20-byte>`). Requires `supports7702: true`.
- `call({ to, data, from?, value?, blockTag?, estimateGas? }): Promise<EvmCallResult>` — read path + optional gas estimate. Revert data on `ChainError.meta.revertData`.
- `buildAuthorizationDigest({ chainId, delegate, nonce }): Uint8Array` — EIP-7702 auth digest for external signer.
- `createUnsignedTransaction({ from, to, data?, value?, authorizationList?, gasLimit?, nonce?, maxFeePerGas?, maxPriorityFeePerGas? }): Promise<UnsignedEvmTransaction>` — general-purpose builder; emits `type = 4` when `authorizationList` present, else `2` (or `0` on legacy chains).

#### `SolanaChain`

- `getAccountInfo(pubkey | pubkey[])` — single or batch.
- `getTokenAccount(owner, mint, opts?)` — returns ATA + exists/owner-safety flags; distinguishes "not found" from "hostile squat" (`InvalidArgument` on the latter).
- `fetchAddressLookupTable(address)` — for message compilation.
- `submitJitoBundle(signedTxs: Uint8Array[], opts?): Promise<string>` — returns bundle id.
- `getBundleStatus(bundleId | bundleId[])` — polls Jito for landed/failed.
- `createUnsignedTransaction({ payer, instructions, addressLookupTables? }): Promise<UnsignedSolanaTransaction>` — general-purpose builder; rejects >1232-byte txs at build time.

#### Unsigned-tx helpers

- `UnsignedSolanaTransaction.digestForSigning(): Uint8Array` — message bytes for external ed25519 signer.
- `UnsignedSolanaTransaction.finalizeAndSerialize(signatures: Uint8Array[]): Uint8Array` — attach externally-computed signatures, return wire bytes.

#### New types / interfaces

- `Eip7702Authorization { chainId, address, nonce, signature: { r, s, yParity } }`
- `CreateEvmUnsignedTransactionRequest`, `CreateSolanaUnsignedTransactionRequest`
- `EvmCallRequest`, `EvmCallResult`
- `JitoBundleStatus { bundleId, state: 'Pending' | 'Landed' | 'Failed', slot?, err? }`
- `SolanaJitoConfig { url, auth? }`
- `BroadcastOpts`, `GetTransactionStatusOpts`, `CreateUnsignedTransactionRequest`

#### New optional fields on existing shapes

- `EvmChainInit.rpcUrls?: string[]` (multi-endpoint failover deferred to 0.3.1; >1 throws at construction — fail-closed)
- `EvmChainInit.supports7702?: boolean` (default `false`)
- `EvmChainInit.nativeTransferGasLimit?`, `nativeTransferGasMultiplier?` (declarative)
- `SolanaChainInit.rpcUrls?: string[]` (same failover throw)
- `SolanaChainInit.jito?: SolanaJitoConfig`
- `SolanaChainInit.legacyRpcEnvNames?: string[]` (env-var rename compat)
- `CreateTransferRequest.addressLookupTables?: unknown[]` (Solana honors; EVM/UTXO ignore)
- `UnsignedEvmTransaction`: `type?`, `authorizationList?`, `gasLimit?`, `nonce?`, `maxFeePerGas?`, `maxPriorityFeePerGas?`
- `UnsignedSolanaTransaction.addressLookupTables?`
- `EvmTransactionStatus.blockNumber?: number`

#### `ChainErrorKinds` — 7 new kinds

- `BroadcastRejected` — chain says no; do not retry, do not re-sign
- `NonceTooLow`
- `InsufficientFunds`
- `BlockhashExpired` — safe to re-broadcast SAME signed bytes on Solana
- `SimulationFailed` — preflight rejected; revert data on `meta.revertData` (EVM)
- `TransactionTooLarge`
- `FeatureNotSupported`

#### New helpers (from `errors.ts`)

- `isBlockhashExpiredError`, `isSimulationError`, `isNonceError`, `isTransactionTooLargeError`
- `sanitizeUtxoErrMessage` (was internal; now exported)

#### `getTransactionStatus` — batch overload + wait/poll semantics

Signature now overloaded:
```ts
getTransactionStatus(hash: string, opts?: GetTransactionStatusOpts): Promise<TransactionStatus>
getTransactionStatus(hashes: string[], opts?: GetTransactionStatusOpts): Promise<TransactionStatus[]>
```

`GetTransactionStatusOpts`:
- `wait?: boolean` — poll until terminal
- `timeoutMs?: number` — **required** when `wait: true`
- `confirmations?: number` — EVM: any N ≥1; Solana: 1 or ≥32; UTXO: not supported
- `signal?: AbortSignal` — honored in poll loop

Batch: 8-way worker pool. On any per-item error, all workers abort and the promise rejects with the underlying error.

### Changed

#### Behavior changes on existing methods (subtle — audit consumer code)

- **`SolanaChain.estimateAndApplyCu`** — throws `ChainErrorKinds.SimulationFailed` (was `InvalidArgument`). Consumers switching on `.kind === InvalidArgument` around this method silently fall through. `SolanaChain.isSimulationError(err)` remains compatible.
- **`sanitizeCause`** — prefers `err.shortMessage` (ethers v6 one-liner) over `err.message` (multi-line JSON). Reduces leak surface; changes what shows up in `err.cause.message`.
- **`sanitizeMessage(msg, null)`** — no longer identity; new redactor rules run regardless of `rpcUrl`.

#### API surface additions to base class (source-breaking for external subclasses only)

- `Chain.broadcast` and the two-signature `Chain.getTransactionStatus` are `abstract`. Only breaks consumers who subclass `Chain` directly (none known today). All internal chain implementations satisfy them.

#### Build-time validation (previously deferred to broadcast/sign time)

- **`createTransferUnsignedTransaction` on Solana** — throws `TransactionTooLarge` at build time if the serialized tx > 1232 bytes (previously failed later at broadcast).
- **`createTransferUnsignedTransaction` on Solana** — wraps `MessageV0.compile` failures in `ChainError(InvalidArgument)` (previously escaped as raw `@solana/web3.js` error).
- **`createTransferUnsignedTransaction` on Solana** — routes returned bytes through `sanitizeMessage` on transport failures (was unwrapped `FetchError` — leaked keyed URLs into logs).

#### Fail-closed on unsupported options (deliberate)

Where prior code silently accepted-and-ignored, these now throw:

- **`broadcast(bytes, { signal })`** — `BroadcastOpts.signal?: never`. Compile-fails on TS; runtime throws `FeatureNotSupported` for JS. Silently ignoring signal would let a caller conclude "not sent" while the tx still lands → double-send hazard.
- **`createUnsignedTransaction({ signal })`** — same treatment.
- **`getTransactionStatus(hash, { wait: true })` without `timeoutMs`** — throws `InvalidArgument`. Unbounded polling would pin an RPC worker + connection forever.
- **`getTransactionStatus(hash, { wait: true, confirmations: N })` on Solana** where `N` is not 1 or ≥32 — throws `InvalidArgument`.
- **`getTransactionStatus(hash, { wait }|{ confirmations })` on UTXO** — throws `FeatureNotSupported`. Poll block-tip provider consumer-side.
- **`EvmChain.call({ estimateGas: true, blockTag })`** — throws `InvalidArgument`. ethers v6's `estimateGas` has no block-tag plumbing.
- **`broadcast(new Uint8Array(0))`** — throws `InvalidArgument` (all families).
- **`broadcast(bytes)` on Solana** with `< 65` or `> 1232` bytes — throws `InvalidArgument` / `TransactionTooLarge` on both `direct` and `via: 'jito'` paths.
- **`SolanaChainInit` without `chainAgnosticGenesisHash`** — TS compile error (new required field).
- **`EvmChain` constructed over a chainId already registered as non-EVM** — throws `InvalidArgument`.

#### Batch `getTransactionStatus` — no longer masks failures

Previously per-item errors were converted to `NotFound` synthesized statuses. Now: any per-item failure re-throws with an internal `AbortController` stopping the other workers. This closes a double-send hazard where a transport error on one hash caused a relayer to re-sign a mined tx.

#### `broadcast` — safer "already-known" handling

- **EVM matcher widened** for Nethermind (`AlreadyKnown`), Besu (`TRANSACTION_ALREADY_KNOWN`), Erigon/reth (`txpool: already known`, `already present`), plus generic mempool phrases.
- **No confirmation gate** — returns `keccak256(hex)` unconditionally on match. Confirmation reads on load-balanced providers (Alchemy/Infura/QuickNode round-robin) routinely hit a different backend and return null; falling into terminal `BroadcastRejected` on that path would trigger re-signs while the original tx is live.

#### UTXO `computeUtxoTxidLE` — safe bitcoinjs parse failures

Wraps `bitcoinjs-lib` parse errors on the "already-known" path in `ChainError(BroadcastRejected)` with explicit "do NOT re-sign" guidance in the message. Prior code let raw parse errors escape as non-`ChainError`.

#### EVM address normalization

`createUnsignedTransaction`, `call`, `getPendingNonce` now normalize `to`/`from`/`address` to `0x`-prefixed EIP-55 checksum form via ethers `getAddress` before storing/sending. Accepts unprefixed 40-hex bodies AND `0X`-prefixed input; wraps malformed as `ChainError(InvalidAddress)`.

#### URL redactor coverage

`sanitizeMessage` now redacts:
- Signed-bytes hex runs (128+ chars, with/without `0x` prefix)
- Base64 signed-bytes (160+ chars, e.g. Solana wire format)
- Query params: `?apiKey=`, `?api-key=`, `?api_key=`, `?token=`, `?auth=`, `?secret=`, `?access-token=`
- `Bearer <token>` (case-insensitive)
- Bare `Authorization: <val>`
- `x-api-key:` / `X-Api-Key:` / `Api-Key:` / `api_key:` headers
- Path-embedded keys under `/vN/`, `/api/`, or `/rpc/` (terminator broadened for comma, paren, semicolon, dot, quote, whitespace, end-of-string)
- Full URLs of known providers (Alchemy, Infura, QuickNode, Helius, Ankr, Blast, dRPC) with the path stripped
- Basic-auth credentials in URLs (`user:pass@host`)
- Provider key markers (`pk_`, `sk_`, `ghp_`, `gho_` prefixes)

### Fixed

- **Solana `getBundleStatus`** — robust parsing of Jito's `err` shape variants (`null` / `{ Ok: null }` / `{ Err: … }` / `'string'` / omitted / missing row). Prior code could report a failed bundle as landed on some shapes.
- **Solana Jito auth flow** — request path now honors `AbortSignal` with a bounded 15s timeout; sanitized `RpcError` on transport failure; robust HTTP-shape handling for the block-engine response.
- **`SolanaChain.rpcUrls.length > 1`** — throws at construction (fail-closed) instead of silently discarding entries.
- **`EvmChain` `already-known` detection** — deterministic hash returned even when the provider's confirmation read is served by a lagging backend (load-balanced propagation).
- **UTXO `sanitizeUtxoErrMessage`** — retains legacy hex-path key rule (`/[hex]{32,}` in URL segments), basic-auth scrubbing, and `pk_/sk_/ghp_/gho_` markers; also inherits shared sanitizer rules.
- **EVM broadcast classifier** — default terminal branch is `BroadcastRejected` (matches Solana/UTXO). Transport signals (`ECONNRESET`, `ETIMEDOUT`, rate-limit codes `-32005/-32007/-32016/-32029/429`, HTTP 5xx) branch to `RpcError`.
- **`Chain.getTransactionStatus(hash, { wait: true, timeoutMs })`** — on timeout from non-terminal state, throws `ChainError(RpcError)` with explicit "must NOT credit / must NOT re-sign" wording. Previously returned bare `NotFound`, indistinguishable from a definitive read — created a double-send hazard.

### Security

- New redactor rules close 4 key-leak paths flagged during review:
  - Query-string keys where the param name isn't literally `key` (e.g. `?auth=`)
  - `x-api-key:` header form (Helius / Alchemy / QuickNode)
  - Path-embedded keys wrapped by `(`, `)`, `,`, `;`, `.`, `"`, `'`
  - `/rpc/<key>` path segments (self-hosted providers)
- EIP-7702 `buildAuthorizationDigest` — wraps `getAddress` failures in `ChainError(InvalidAddress)` (was raw ethers `TypeError`).
- EIP-2 low-s canonical form check on EIP-7702 authorization signatures — silently-skipped non-canonical authorizations rejected at build time (prevents "tx lands, gas spent, no delegation installed" hazard).
- `sanitizeCause` prefers `err.shortMessage` — prevents ethers v6 multi-line JSON dumps from leaking signed bytes into `err.cause.message`.

### Deferred (recorded, not shipping in 0.3.0)

Ships in 0.3.1:
- Multi-endpoint RPC failover (`evm_rpc_client.ts` / `solana_rpc_client.ts` seam). `rpcUrls` field exists but `length > 1` throws.
- `AbortSignal` end-to-end. Honored in `getTransactionStatus` poll loops today; NOT in `broadcast` / `createUnsignedTransaction` / `getAccountInfo` / `getTokenAccount` / `fetchAddressLookupTable` / `getPendingNonce` / `getDelegation` (these fail-closed on `{ signal }`).

Follow-up cards:
- `SolanaChain.getBundleStatus` — dropped bundles indistinguishable from in-flight; consumer must impose polling timeout policy. Adding a fourth `'Unknown'` state (or querying `getInflightBundleStatuses` for missing rows) is a follow-up.
- Jito auth header shape — currently `Authorization: Bearer`; the block engine documents `x-jito-auth` on authenticated tiers. Verify against endpoint before wiring `jito.auth`.
- `withFeatures({ supports7702?, jito?, rpcUrl?, rpcUrls? })` clone method on registered chain factories — currently consumers must hand-rebuild frozen chain singletons to opt in to 7702 or Jito.
- Blockhash-expiry internal re-broadcast — consumer implements retry loop per safe-broadcast rule (re-broadcast SAME signed bytes, never re-prepare).

---

## [0.2.1] — 2026-08-01

Hotfix release. Zero API changes; hygiene only. Native-token sentinel handling deferred to the paired gasless card (out of SDK scope — `Token.isNative()` already covers the SDK-side native check; the `0xeeee…` string convention is a consumer-side external-interop concern).

### Added

- Dual CJS+ESM build pipeline: emits `dist/esm/` (ESM) + `dist/cjs/` (CJS) via two `tsc` configs, with per-directory `package.json` `type` overrides so Node picks the correct loader per subpath. Fixes `ERR_REQUIRE_ESM` for CJS consumers (NestJS builds target CJS by default).

### Changed

- `class-validator` and `class-transformer` moved from `dependencies` to `peerDependencies` with generous ranges (`class-validator: ^0.14 || ^0.15 || ^0.16`). Prevents duplicate copies when both gasless (0.14) and depositron (0.15) install this package — two copies silently break decorator-metadata dedupe.
- `decimal.js` stays a regular dependency (already cross-copy-safe via structural probe + toString round-trip in `chain.base.ts`).

### Security

- `.env` and `.npmrc.publish` added to `.gitignore` so npm tokens can never be committed.

## [0.2.0] — 2026-07-27

Initial npm release of `@getomnichain/omnichain`. Replaces prior vendored-submodule consumption of the SDK.

### Added

- Package published to npm registry under `@getomnichain` scope with public access.
- CJS build (single-target) suitable for NestJS consumers.
- Root barrel + `/evm`, `/utxo`, `/solana` subpath exports.
- Full API surface at parity with the vendored submodule at commit `65c515002a08eceae29b5089c2ca6de83395a1fe`.

### Migration from vendored submodule

- Consumers that previously imported from `../../chain/*` (relative to `src/modules/`) now import from `@getomnichain/omnichain` (root barrel) or `@getomnichain/omnichain/evm` / `/utxo` / `/solana` for subpath-scoped imports.
- Solana chainId numbering renumbered (breaking; per-consumer SQL data migration required for any persisted Solana chainId).
- Prior vendored git submodule deprecated — do not consume.

---

[0.6.3]: https://github.com/getomnichain/omnichain/releases/tag/v0.6.3
[0.6.2]: https://github.com/getomnichain/omnichain/releases/tag/v0.6.2
[0.6.1]: https://github.com/getomnichain/omnichain/releases/tag/v0.6.1
[0.5.1]: https://github.com/getomnichain/omnichain/releases/tag/v0.5.1
[0.5.0]: https://github.com/getomnichain/omnichain/releases/tag/v0.5.0
[0.4.0]: https://github.com/getomnichain/omnichain/releases/tag/v0.4.0
[0.3.6]: https://github.com/getomnichain/omnichain/releases/tag/v0.3.6
[0.3.5]: https://github.com/getomnichain/omnichain/releases/tag/v0.3.5
[0.3.4]: https://github.com/getomnichain/omnichain/releases/tag/v0.3.4
[0.3.3]: https://github.com/getomnichain/omnichain/releases/tag/v0.3.3
[0.3.2]: https://github.com/getomnichain/omnichain/releases/tag/v0.3.2
[0.3.1]: https://github.com/getomnichain/omnichain/releases/tag/v0.3.1
[0.3.0]: https://github.com/getomnichain/omnichain/releases/tag/v0.3.0
[0.2.1]: https://github.com/getomnichain/omnichain/releases/tag/v0.2.1
[0.2.0]: https://github.com/getomnichain/omnichain/releases/tag/v0.2.0
