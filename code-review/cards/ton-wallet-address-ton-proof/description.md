---
id: RIN-XXX
title: TON in omnichain — a wallet address from a public key, TonConnect ton_proof (fixed-key wallets and Telegram Wallet) and signData text verification
status: draft
repos: [omnichain]
---

<!-- ======================= PART A - REQUEST ======================= -->

# Summary

A TON address does not reveal its key. Two rango-intents TON cards need to
tie a key to an address, and omnichain 0.7.1 cannot:
- **Fill proofs** (`../intents/intents7.ton-destination-fill-proof.md`): the
  solver sends its public key, and rango-intents must check that the key's
  wallet is the fill's sender. 0.7.1 builds a wallet address only from a seed
  (`TonWallet`, `ton_wallet.ts:140-150`).
- **Affiliate claims** (`../intents/intents9…`): each claim is signed, and
  wallet apps sign arbitrary text only through TonConnect `signData`, a format
  of its own.
- **Affiliate sign-in** (`../intents/intents9.ton-wallet-signin-and-affiliates.md`):
  affiliates sign in with TonConnect's `ton_proof` (decided 2026-10-27).
  Verifying it means checking the proof's `walletStateInit` against the
  address, reading the key from it, and checking an ed25519 signature over
  TonConnect's own message layout. `TonChain.verifySignature`
  (`ton_chain.ts:580-594`) verifies omnichain's `TON Signed Message` scheme
  only, and `verifyMessageSignature` throws for TON (`:600-606`).

Wallet derivation and signature schemes belong in omnichain, as for every
other family.

---

# Objective

Callers can ask omnichain two questions: is this the wallet of this public
key, and is this `ton_proof` a valid sign-in by this address for this
nonce?

---

# Scope

## Out of scope / non-goals

- TonConnect `signData`.
- The sign-in flow itself (nonces, sessions): rango-intents `intents9`.
- Testnet proofs: `ton_proof` from network `-3` is refused, as omnichain
  serves TON mainnet only.

---

# Requirements

- **R1. `tonWalletAddress(publicKey, version, opts?)`** (`ton_wallet.ts`):
  - takes a 32-byte key (bytes or 64 hex), a version in `TON_WALLET_VERSIONS`
    (`v3r2`, `v4r2`, `v5r1`), and `workchain` (default 0);
  - returns the canonical raw address, built exactly as `TonWallet` builds its
    contract (W5's default wallet id, `TON_LEGACY_DEFAULT_WALLET_ID` for
    v3r2/v4r2);
  - `TonWallet`'s constructor uses it, so the two cannot drift;
  - also `tonWalletAddresses(publicKey)`: one address per version.
- **R2. `TonChain.verifyTonProof(input, opts)`**, following TonConnect's
  verification rules:
  - **Input:** `address`, `network`, and `proof { timestamp, domain {
    lengthBytes, value }, signature (base64), payload, stateInit (base64
    BOC) }`, plus an optional `publicKey`.
  - **Options:** `expectedDomain`, `expectedPayload`, `maxAgeSeconds`
    (default 600), `now`.
  - **Checks, in order:**
    1. `network` is `-239`.
    2. `domain.value === expectedDomain` and `lengthBytes` is its UTF-8
       length.
    3. `timestamp` is within `maxAgeSeconds` of `now` and not in the future.
    4. `payload === expectedPayload`.
    5. The `stateInit`'s address on the address's workchain equals `address`.
    6. The key:
       - the `stateInit`'s code hash is a known fixed-key wallet (`v3r2`,
         `v4r2`, `v5r1`), and the key is read from its data with that
         version's layout; or
       - it is Telegram Wallet's trampoline (R3), and the key is the live
         one.

       The key must equal `publicKey` if given.
    7. ed25519 over `sha256(0xffff ‖ "ton-connect" ‖ sha256(message))`
       verifies, where `message` = `"ton-proof-item-v2/"` ‖ workchain
       (int32 BE) ‖ hash (32 bytes) ‖ `lengthBytes` (uint32 LE) ‖ domain ‖
       timestamp (uint64 LE) ‖ payload.
  - **Result:** `{ ok: true, publicKey, version }` or `{ ok: false, reason }`
    (`network`, `domain`, `expired`, `payload`, `address`,
    `unsupported_wallet`, `public_key`, `signature`, `provider`). It never
    throws on bad input from the wallet.
  - Also from TonConnect's rules: `timestamp` may be a number or a decimal
    string; domain and payload are at most 128 UTF-8 bytes each and 222
    together.
- **R3. Telegram Wallet.** Its in-app wallet is a trampoline contract that
  can rotate its key, so the key in its `stateInit` may be stale. As
  TonConnect's verification rules say:
  - the `stateInit` code hash is the trampoline,
    `9149ae51c1e4689710cebf7830297b16acfbadb363a920a537893e7ffeeca768`;
  - the live account (`getAccountState`) is `active` and its `codeHash` is
    the same trampoline;
  - only then is `get_public_key` called on the account, and its result (at
    most 256 bits) is the key. It is never cached between proofs.

  An inactive account, a code mismatch or a failed getter gives `ok: false`,
  reason `unsupported_wallet`. A failed read that may be transient gives
  reason `provider` (the caller may retry), not a throw.
  - `TonProvider` gains `getPublicKey(address): Promise<bigint>`: TON
    Center's `runGetMethod` (as `getSeqno`, `ton_toncenter.ts:72`), and
    TonAPI's `/v2/blockchain/accounts/{id}/methods/get_public_key`, with the
    usual fallback (`ton_provider.ts:184-260`).
  - `verifyTonProof` is therefore `async`.
- **R4. `verifyTonSignData(result, opts)`** (`ton_sign_data.ts`): a TonConnect
  `signData` of a **text** payload, as the wallet returns it (`signature`
  base64, `address` raw, `timestamp`, `domain`, `payload { type: 'text',
  text }`), checked against `publicKey` (the caller's: rango-intents saves the
  key its `ton_proof` sign-in gave), `expectedAddress`, `expectedDomain`,
  `expectedText`, `maxAgeSeconds` (600) and `now`.
  - The signed digest is `sha256(0xffff ‖ "ton-connect/sign-data/" ‖ workchain
    (int32 BE) ‖ account hash ‖ domain length (uint32 BE) ‖ domain ‖
    timestamp (uint64 BE) ‖ "txt" ‖ text length (uint32 BE) ‖ text)`
    (TonConnect `spec/rpc.md`; big-endian throughout, unlike `ton_proof`).
  - Result `{ ok: true }` or `{ ok: false, reason }` (`payload`, `address`,
    `domain`, `expired`, `signature`); never throws on what the wallet sent;
    an unusable key, `now` or `maxAgeSeconds` throws `InvalidArgument`.
  - `TonWallet.signTonProof({ domain, payload })` and
    `TonWallet.signTextData({ text, domain })` give what a wallet app would,
    for scripts that sign in and claim without one.
- **R5. Exports** from `@getomnichain/omnichain/ton`; `docs/ton.md` documents
  both; a patch release (0.7.2).

---

# Acceptance Criteria

- **AC1 (R1)** For a key derived by `TonWallet` in each version,
  `tonWalletAddress` equals `TonWallet.address`; known mainnet wallets' keys
  give their addresses.
- **AC2 (R2)** A `ton_proof` produced by Tonkeeper on mainnet (recorded, for
  our domain and payload) verifies and returns its key.
- **AC3 (R2)** Each of these returns `ok: false` with its reason and does
  not throw:
  - another domain, another payload, an old timestamp, network `-3`;
  - a `stateInit` of another address;
  - an unknown wallet code;
  - a flipped signature byte;
  - a mismatching `publicKey`;
  - a Telegram Wallet proof whose live account is not active, or runs other
    code.
- **AC4 (R3)** A recorded Telegram Wallet proof verifies with the getter's
  key (provider stubbed), even when its `stateInit` holds another key; a
  getter failure gives `provider`.
- **AC5 (R4)** `signData` text results signed by the reference
  implementation (`mois-ilya/ton-sign-data-reference`, MIT) verify. Another
  text, address, domain or key, an old timestamp and a flipped signature byte
  each give their reason. `TonWallet.signTonProof` / `signTextData` results
  verify for every wallet version.
- **AC6** Every existing TON spec passes; `npm run build` emits both entry
  points.

---

# Constraints & Context

## Starting points

- `ton/ton_wallet.ts:58-62,111-160`, `ton/ton_chain.ts:282,575-606`,
  `ton/ton_provider.ts:8-14,85-111,184-260`, `ton/ton_toncenter.ts:55-120`,
  `ton/ton_tonapi.ts:57-70`, `ton/index.ts`, `docs/ton.md`.
- TonConnect: "Verifying signed-in users" (docs.ton.org; the WalletTg
  section and the trampoline hash), the reference `ton-proof-service.ts` in
  `ton-connect/sdk`, the `ton_proof` item (`timestamp`, `domain`,
  `signature`, `payload`, `state_init`).
- `@ton/ton` `WalletContractV3R2` / `V4` / `V5R1` (the code cells to hash).

## Dependencies / blockers

- None. rango-intents `intents7` and `intents9` bump to this release (0.7.2).

---

# Open Questions

- **Q1 (resolved).** Telegram Wallet is supported (R3), decided 2026-10-27.

<!-- ========================= PART B - PLAN ========================= -->

---

# Implementation Plan

1. `tonWalletAddress`, `tonWalletAddresses`; `TonWallet` on top of them.
2. `verifyTonProof` and its message/digest helpers.
3. `getPublicKey` on both providers; the Telegram Wallet branch.
4. Recorded proofs (Tonkeeper, Telegram Wallet) and specs; docs; release.

---

# Verification

- `npm test -- ton`; `npm run build`.

<!-- ====================== PART C - DEVIATIONS ====================== -->

---

# Deviations from the plan

- **A proof may be up to 60 s ahead of `now`** (R2 step 3 said "not in the
  future"). Wallet clocks run slightly ahead; TonConnect's own verifier checks
  only the age.
- **No byte caps on the domain and payload** (R2's 128/128/222). They bound
  what a dapp may request, and a real Tonkeeper proof (TonProof.NET's recorded
  v4r2) carries a 291-byte payload. Equality with the issued payload binds it.
- **`version` is `TonWalletVersion | 'wallet_tg'`**, naming Telegram Wallet's
  trampoline.
- **AC2's recorded proof is TonProof.NET's** (MIT): a mainnet v4r2 Tonkeeper
  proof, with its v3r1 and testnet W5 beta samples as refusals. W5 beta is not
  v5r1 and is refused as `unsupported_wallet`; v5r1 is exercised with proofs
  signed in the spec.

---

# Follow-ups raised
