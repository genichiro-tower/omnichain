---
id: RIN-XXX
title: TON in omnichain — TonChain, BIP-39 W5R1 wallets, relayed (signed-internal) requests, trace emulation and transaction status
status: draft
repos: [omnichain]
---

<!-- ======================= PART A - REQUEST ======================= -->

# Summary

The omnichain `./ton` subpath exports only `TonAddress`, an address validator
(`ton/index.ts:1`).
- `chain_ids.ts:118-133` defines `CHAIN_ID_TON_MAINNET = -4000` and notes
  "TonChain deferred".
- There is no chain class, wallet, signing, message building, balance or
  transaction status, and no `@ton/*` dependency.
- The Python omnichain has a TON chain (`omnichain/impl/ton/base.py`), with
  three gaps:
  - its wallets use TON's own mnemonic;
  - its transaction status is unfinished;
  - it has neither emulation nor relayed requests.

Depositron's TON card (`../depositron/0-ton-depositron.md`) needs these from
the SDK:
- **Wallets:** a W5R1 deposit wallet per vault, derived from a BIP-39
  mnemonic.
- **Relaying:** one fee-payer wallet that delivers each deposit wallet's
  signed request and pays for it, deploying the wallet on its first use.
- **Emulation:** a whole-trace emulation, to size what the fee payer attaches.
- **Status:** a transaction status that judges each message's delivery.

This card adds them. It builds on `@ton/core` and `@ton/ton` for cells,
StateInit and W5R1 rather than reimplementing them.

---

# Objective

Any service built on omnichain can derive TON wallets from the seed it already
holds, have a central wallet pay for and deliver their operations, know in
advance what an operation will cost and whether it will work, and tell
afterwards whether it did.

---

# Scope

## Out of scope / non-goals

- **No testnet preset.** TON ships mainnet only (`-4000`).
- **No wallet versions other than W5R1.** No v3/v4, no TON-native 24-word
  mnemonic, and no W5 extensions.
- **No deposit watching.** That is Clydner's job, not the SDK's.
- **No jetton-specific transfer building beyond a body helper.** Callers
  encode their own messages.
- **No changes to other families.**

---

# Requirements

- **R1. Dependencies.** `@ton/core`, `@ton/crypto` and `@ton/ton` (W5R1,
  including `authType: 'internal'` requests), pinned. Built for ESM and CJS
  like the other subpaths.
- **R2. `TonChain` and preset.**
  - `TonChain({ chainId, name, toncenter: { url, apiKey }, tonapi?: { url,
    apiKey }, explorerUrl })`, extending
    `Chain`.
  - `TonMainnet`: `-4000`, native TON with 9 decimals, `tvm:-239`, tonviewer
    explorer.
  - **Providers:** TON Center v3 is the main provider; TonAPI is the
    fallback (Q1). Both sit behind one internal interface with the same
    result types, and each is keyed. There is no keyless use.
  - **Fallback rule:**
    - a read or an emulation that fails on TON Center (transport error,
      timeout, 429, 5xx) is retried once on TonAPI;
    - a broadcast that fails on TON Center is sent to TonAPI with the same
      BOC. That is safe: the seqno makes a second landing impossible, and
      the id is the same normalized hash on both. If TonAPI then refuses
      it, or there is no fallback, the broadcast is **uncertain**
      (`TonBroadcastUncertainError`, with the hash): the message may land,
      so the caller waits for `getRequestState` to say `expired` before
      signing a replacement (`consumed`: it landed);
    - a broadcast reply is read by the lite server's text, not its HTTP
      status (TON Center sends both as 500): "cannot apply external
      message" on W5's seqno check (exit code 133, the first check after the
      signature) is `NonceTooLow` — it or another request with its seqno
      landed, which is what a resend of a landed message gets; any other
      refusal is a definite `BroadcastRejected`; "duplicate message" means
      the network has it, and counts as sent. The uncertain broadcast has
      its own kind, `BroadcastUncertain`;
    - a definite answer from TON Center, such as "not found" or a failed
      emulation, is never second-guessed by TonAPI;
    - without a TonAPI config, there is no fallback.
  - Results from either provider are normalized to the same types, so a
    caller cannot tell which one answered, except from a log line (an empty
    message body is `null` on both). A TonAPI trace that is its emulation of
    a message still in flight (`emulated`) is read as no trace; an emulated
    hop leaves the trace incomplete.
- **R3. Addresses.** `TonAddress` gains:
  - one canonical form, raw `0:<hex>` lowercase, so `canonical()` makes two
    forms of one address compare equal;
  - `toUserFriendly({ bounceable, testOnly })`;
  - parsing of raw and both user-friendly forms;
  - `isBounceable`.

  The validator's existing behaviour is kept for valid inputs.
- **R4. Wallets.**
  - `TonWallet.fromMnemonic(mnemonic, { derivationPath })` derives an
    ed25519 key with SLIP-0010 at a hardened path from a **BIP-39** seed.
    `TonWallet.derivationPath({ account })` gives `m/44'/607'/{account}'`
    (the default is account 0), the same shape as Tron's and Stellar's
    `fromMnemonic` / `derivationPath`.
  - It exposes `publicKey` and the W5R1 `address` (workchain 0, the mainnet
    client wallet id).
  - It exposes `stateInit()`.
  - It exposes `signMessage(message)` and `verify`, over SHA-256 of
    `"TON Signed Message:\n"` and the message (SEP-53's shape), never the
    message's own bytes: the key also signs W5 requests over a 32-byte cell
    hash, and a crafted message must not stand in for one.
  - Its address equals `@ton/ton`'s `WalletContractV5R1` address for the same
    key and wallet id.
- **R5. Requests.** For a W5R1 wallet and `messages[1..255]` (`to`, `value`,
  `body?`, `bounce?`, `stateInit?`, `mode`):
  - `createExternalRequest({ seqno, validUntil })`: the wallet's own signed
    external message, used by the fee payer;
  - `createInternalRequest({ seqno, validUntil })`: the signed internal
    request (op `0x73696e74`), for a relayer to deliver;
  - `relayMessage({ to: wallet, request, value, deploy })`: the internal
    message a relayer sends. It carries the target's StateInit when `deploy`
    is true.
  - Helpers: a text-comment body, and a jetton `transfer` body (op
    `0x0f8a7ea5`, with `response_destination` and `forward_ton_amount`).
- **R6. Reads.**
  - `getAccountState(address)`: `nonexist | uninit | active | frozen`, with
    balance and code hash.
  - `getSeqno(address)`: 0 when the wallet is not deployed.
  - `getBalance(owner, token?)`:
    - native TON;
    - a jetton through the master's `get_wallet_address` and the wallet's
      `get_wallet_data`. An undeployed jetton wallet reads as 0.
  - `getJettonWalletAddress(master, owner)`, which rango-intents will need.
- **R7. Emulation.** `emulate(externalBoc, { ignoreSignature })` emulates the
  whole trace of an external message. It returns:
  - per transaction: account, compute success and exit code, and fees;
  - per outgoing message: delivered or bounced;
  - the total fees the external message's sender pays;
  - balance changes for TON and jettons.

  It works for a relay whose target is not deployed: deploy, request,
  outgoing messages and their downstream hops.
- **R8. Broadcast and status.**
  - `broadcast(externalBoc)` returns the **normalized external-message hash**,
    which is the transaction id.
  - `getTransactionStatus(hash)` reads the trace and returns the transaction
    status types the SDK already has (`Pending` / `Success` / `Failed`),
    with:
    - each transaction's result, and each outgoing message's delivery or
      bounce;
    - fees and balance changes;
    - completeness: no message still in flight;
    - finality (Q2): `Success` or `Failed` only once every transaction in the
      trace is in a block that a masterchain block references (TON Center's
      `mc_block_seqno` is set) and the trace is complete. A transaction that
      is only seen (a pending trace, or a shard block not yet referenced) is
      `Pending`;
    - the number of masterchain blocks since then, so a caller may require
      extra depth. The default is 0.
  - An external message that never landed stays `Pending`, and is
    distinguishable as expired once its `validUntil` has passed and the
    sender's seqno has not moved.
- **R9. Docs and exports.** `ton/index.ts` exports the above. The README's
  family table says TON is implemented, and `chain_ids.ts` drops its
  "deferred" note. CHANGELOG entry and a version bump.

---

# Acceptance Criteria

- **AC1 (R3)** The raw, `EQ…` and `UQ…` forms of one address give the same
  `canonical()`. `toUserFriendly({ bounceable: false })` gives the `UQ…`
  form.
- **AC2 (R4)** For a fixed BIP-39 mnemonic, `TonWallet.fromMnemonic(m,
  { derivationPath: TonWallet.derivationPath({ account: i }) })` gives fixed
  addresses (test vectors). Each equals
  `WalletContractV5R1.create({ publicKey, workchain: 0 })`. Accounts 0 and 1
  differ.
- **AC3 (R5, R7) Mainnet, emulation only.** A relay from a funded fee payer
  to an undeployed deposit wallet, with `deploy: true` and one TON transfer
  out, emulates as:
  - deploy succeeded;
  - request accepted;
  - the transfer delivered;
  - fees reported.

  The same relay without `deploy` emulates as failed.
- **AC4 (R5, R8) Mainnet, real value.** The same relay sent for real:
  - `broadcast` returns a hash;
  - `getTransactionStatus` is `Pending`, then `Success`;
  - the deposit wallet is `active` with seqno 1;
  - the fees match the emulation within its margin.
- **AC5 (R6)** `getJettonWalletAddress(USDT master, owner)` equals the
  address the master's get-method returns. `getBalance` of an undeployed
  jetton wallet is 0.
- **AC6 (R8)** A jetton transfer to a malformed jetton wallet reads as
  `Failed`, with that message bounced.

---

# Constraints & Context

## Starting points

- **TS today:** `ton/ton_address.ts`, `chain_ids.ts:118-133`,
  `network_type.ts`, `address.factory.ts`.
- **Precedents:** the Tron family (`tron/`), the latest port.
  - `TronChain`, presets, `TronWallet`.
  - Status with `signers`, `blockNumber` and `memo`.
  - Solana's ed25519 SLIP-0010 derivation.
  - `estimateAndApplyCu`, the closest emulation precedent.
- **Python reference:** `omnichain/impl/ton/base.py`. Use it for:
  - presets and decimals;
  - jetton reads that try the standard, stablecoin and stablecoinV2
    classes;
  - toncenter v3 and TonAPI trace parsing.

  Its status is unfinished, and its wallets differ.

## Compatibility constraints

- Additive. `TonAddress` keeps accepting what it accepts today.

## Dependencies / blockers

- None. This card blocks `../depositron/0-ton-depositron.md`.

---

# Open Questions

- **Q1 (resolved).** TON Center v3 is the main provider and TonAPI the
  fallback (decided 2026-10-21).
  - TON Center: `/api/v3/traces`, and emulation via
    `/api/emulate/v1/emulateTrace`.
  - TonAPI: `/v2/traces/{id}`, and emulation via `/v2/traces/emulate`.
- **Q2 (resolved).** Finality has no confirmation count (decided 2026-10-21).
  - TON's BFT consensus makes a masterchain block final once signed by
    validators holding more than 2/3 of the stake, and a shard block final
    once a masterchain block references it. There is no reorg that more
    depth would protect against.
  - So a transaction is final when it is in a masterchain-referenced block and
    its trace is complete.
  - The extra masterchain depth stays a parameter, defaulting to 0.

<!-- ========================= PART B - PLAN ========================= -->

---

# Implementation Plan

1. `TonAddress` forms and the `@ton/*` dependencies (R1, R3).
2. Messages, relay messages and the normalized external hash (R5).
3. TON Center v3 and TonAPI providers with the fallback (R2, R6–R8).
4. `TonChain`, `TonWallet`, emulation and transaction status (R2, R4, R6–R8).
5. Docs, CHANGELOG and version 0.7.0 (R9).

---

# Verification

- Typecheck and the ESM and CJS builds are clean.
- Real replies from both providers in the unit fixtures; one test checks
  they normalize the same trace identically. The replayed mainnet recordings
  (`mainnet_recordings.json`) hold TON Center replies only; TonAPI is checked
  against TON Center live.
- The SLIP-0010 derivation matches the spec vectors; the normalized external
  hash matches TON Center's `hash_norm` on a real message.
- `code-review/code_reviewer.py`: 5 rounds, round 5 has no Critical; rounds
  6–8 and 10–11 had no Critical; round 9's (a message signature usable as
  a W5 request signature) is fixed. The double-spend and fail-open Mediums
  of rounds 7–11 are fixed: resend after landing, fail-open reads (seqno,
  account state, phases, jetton balance), mixed providers in expiry, replay
  of a failed relayed request, provider gaps, request state, lost
  seqno/validUntil, unchecked hashes, bounce by address form, lenient
  signature parsing.
- AC3 and AC4 on mainnet (`npm run test:live:ton`, 2026-10-21, fee payer
  `UQBCC5glBygg10SwcXZdY4Ssd6NgCNcm0qZLrQaVw4sPsQfx`):
  - a relay deploying a fresh vault emulated and sent (`f090af72…`): Success,
    vault active at seqno 1; fees 0.0021 TON;
  - the same relay without deploy emulated and sent (`43311663…`): Failed,
    `bounced`, value back to the fee payer;
  - the run spent 0.0029 TON; the replies are recorded and replayed under
    `npm test`.
- The live suite (17 tests) also checks both providers against each other:
  the masterchain head, emulation and the sent trace alike (both passing the
  trace check), `getRequestState` on a request never sent (`expired` /
  `live`) and on one that landed (`consumed`), a resend of a landed message
  (`NonceTooLow` from both, never landing twice), and a relayed request that
  failed (`live`, seqno unchanged) then executed when delivered again
  (`consumed`, its seqno and `validUntil` read back from the trace), AC5,
  AC6 (a jetton transfer bounced by a jetton wallet with no code), and the
  paid fees within a fifth of the emulated ones (equal on the last run).
  Last run 2026-10-22: 17 passed, 0.0062 TON; 17 recorded scenarios.
- 1899 tests pass (141 for TON, the 17 recorded scenarios included).

<!-- ====================== PART C - DEVIATIONS ====================== -->

---

# Deviations from the plan

PR: `getomnichain/omnichain#17` (`genichiro-tower:feature/ton-chain` →
`main`), opened from a fork: `genichiro-tower` has read access only.

- **R4:** `stateInit` is a getter and verification is `verifySignature`.
- **R5:** the relay is `tonRelayMessage({ wallet, request, value, deploy })`.
- **R8:** the status judges the request on the wallets that sent it and the
  first hop of each message they sent (a jetton transfer at the receiver's
  jetton wallet), with `summary.deliveries` per message; failures further
  down do not fail it. Codes: `skipped_actions`, `request_not_executed`,
  `bounced`, `receiver_failed`, `jetton_bounced`, `jetton_receiver_failed`,
  `jetton_undelivered` (a jetton wallet that sent the jettons nowhere). A
  message missing from a complete trace is never `undelivered`: it is the
  provider's gap (see matching). A message is `bounced`
  only when the receiver's transaction sent it back (a failed compute phase,
  or a failed action with send mode +16, with value left for the bounce); a
  receiver that aborted without sending it back makes it `failed` — the value
  did not return.
- **R8, matching:** each message a sending wallet sent is matched to the
  transaction that received it by (source, `created_lt`), which names one
  message. `assertTraceConsistent` checks every trace, in both providers and
  again in the judgment: every transaction but the root has a parent in the
  trace and an incoming internal message its parent sent (same source,
  `created_lt`, destination, value); every internal message names its source
  and `created_lt`; in a complete trace every message sent has its receiving
  transaction. A trace that breaks this fails retryably and is read from
  TonAPI; so does an emulation cut short. A running trace may lack
  transactions (TON Center keeps a missing one as its children's parent) and
  is incomplete. Transaction ids are refused unless 64 lowercase hex, and
  "no trace" is read only from the providers' explicit answers. Matching by destination and value paired
  identical messages arbitrarily (a vault's jetton transfers all go to its
  own jetton wallet with the same attached TON). `summary.deliveries` is
  ordered as each wallet sent its messages, the request's order.
- **R6/R8:** TonAPI's `master_ref` can be a few masterchain blocks before
  TON Center's committing block; finality is the same.
- **Testing (not in Part A):** three tiers.
  - Unit specs (`ton/test/*.spec.ts`), no network. The delivery judgment is
    in `ton_status.spec.ts`.
  - `ton_recorded.spec.ts` replays real mainnet replies
    (`fixtures/mainnet_recordings.json`) through the providers' parsing under
    `npm test`.
  - `npm run test:live:ton` (`ton/test/live/ton_mainnet.live.ts`,
    `jest.live.config.mjs`, never part of `npm test`) runs AC3 and AC4 on
    mainnet, plus the provider behaviour the SDK relies on: the masterchain
    head's time, emulation and sent traces alike on both providers,
    `getRequestState`, a failed relayed request delivered again, and a
    resend of a landed message (refused, accepted
    or "duplicate", never landing twice; TonAPI serves its emulation of a
    message in flight as its trace, which is read as no trace). It reads,
    and emulates by default; `TON_LIVE_SEND=1` broadcasts
    and `TON_LIVE_RECORD=1` rewrites the recordings. The vault returns
    everything to the fee payer, so a run costs only fees, under
    `TON_LIVE_MAX_SPEND_NANO`.
  - Secrets: the provider keys and a **dedicated** test mnemonic live in the
    git-ignored `.env.ton.local` (template `.env.ton.example`), parsed into
    Jest's own `process.env`. Recordings keep URLs, bodies and replies, never
    headers.
  - AC6 is recorded on mainnet without jettons: a USDT transfer to the fee
    payer's own jetton wallet, which has no code, bounces (`Failed`,
    `bounced`). AC5 too: the USDT jetton wallet alike on both providers and
    empty. TonAPI's replies (emulation, a complete trace, its emulation of a
    message in flight, a never-used address, a resend) are recorded and
    replayed through `TonapiProvider` under `npm test`.
- **R8, replacing a request:** one check,
  `getRequestState({ wallet, seqno, validUntil, hash? })` →
  `live | expired | consumed`, for external and relayed requests alike.
  `consumed`: the wallet's seqno moved past it or it has a trace — never
  re-sign, read the status. `expired`: the chain's clock (masterchain head
  time, 60 s margin) is past `validUntil`, the seqno not past it, no trace —
  safe to replace. `live`: it can still execute. W5 keeps an internal
  request's seqno only when the transaction succeeds, so a relayed request
  that failed stays `live` and anyone can deliver it again until
  `validUntil` (seen on mainnet); a `Failed` status does not end it. A
  `hash` whose trace starts at another wallet (a relay's hash given for the
  relayed wallet) is refused. All
  reads come from one provider; a failed or malformed read throws (no 0
  seqno, `NaN` time, `nonexist` or "no trace" from a failure). The seqno is
  read live from the wallet's get-method, not gated on the indexed account
  state, which trails a deploy.
- **R4/R5, what a request commits to:** `createInternalRequest` returns
  `{ body, seqno, validUntil }`, and `tonRelayMessage` takes that;
  `TonSignedTransaction` reads `walletAddress`, `seqno` and `validUntil` from
  its signed body and round-trips through JSON (registered type).
  `tonW5RequestFields` / `tonInternalRequestOf` read them from any signed W5
  body, so `getRequestState` can always be called after the fact.
- **Reads never fail open:** TON Center's phase data is required (missing
  `description` / `compute_ph` / `aborted`, or a successful compute phase
  without an action phase, is a retryable malformed reply); TonAPI's
  transactions are judged from their BOC, not its optional JSON phases. A
  jetton wallet reads 0 only with no code (TON Center -13; TonAPI 404
  confirmed by the account state). A trace must be the requested message's.
- **R5, native transfers:** bounceable to `EQ…`, not to `UQ…` or raw.
- **R4, signatures:** `TonChain.verifySignature(publicKey, message, sig)`
  verifies with the public key only; signatures must be exactly 128 hex.
- The root entry exports only `TonAddress`; the family is `./ton`.

---

# Follow-ups raised

The review's remaining Medium items (PR #17, "Known open items"): 404 / failed get-method read as 0, `jettonCredits` /
`failedTransactions` predicates, emulation `ignoreSignature` and sender fees,
native bounce flag, pinned `@ton/*`, the fallback log line.
