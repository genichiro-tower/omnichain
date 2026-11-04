---
id: RIN-XXX
title: TON account transfers — a native receipt is what the account kept, net of what its transaction sent out
status: draft
repos: [omnichain]
---

<!-- ======================= PART A - REQUEST ======================= -->

# Summary

`TonChain.accountTransfersOf` (and `getAccountTransfers`, built on it) reports
a native `RECEIVE` with `amount = inMsg.value`: the full value of the message
that arrived, whatever the account's transaction did with it. Clydner reports
deposits from it, and rango-intents verifies deposits with it.

A Depositron vault acts only when the fee payer's relay message reaches it, and
that message carries the TON the vault needs (fees, contract-call value, and a
margin). The vault sends its payouts in the same transaction. Today that
transaction is reported as a native `RECEIVE` of the full relay value, so a
refund request reads as a new deposit.

Seen on staging (2026-11-04, intent `f1eb2bfe-5ef6-4f25-8d95-ca519c0501f8`,
vault `UQBOTa-T1GYFNFwRHMAWGleS61ewuPE6dG10312hpJp47SEB`): a short 0.009 TON
deposit was refunded by a request that brought 0.012098212 TON in and sent
0.009 TON out (tx `05035eb1…`). The receipt was reported at 0.012098212 TON,
accepted as a valid deposit, auctioned, and refunded to the user. The fee payer
paid the user 0.0121 TON it never owed.

This card makes a native receipt's amount the value the account kept, measured
in message values: the incoming value minus the values of every message the
same transaction sent out. A receipt that kept nothing is not a receipt.

---

# Objective

A TON account's reported receipts are what other parties paid into it. TON that
only passes through the account, in the transaction that brought it, is not
reported as received.

---

# Scope

## Out of scope / non-goals

- Do not change jetton transfers (`asset.kind === 'jetton'`): their amount is the
  jetton amount, and the TON riding along is already excluded.
- Do not change `SEND` transfers: every outgoing native payment stays reported,
  with its own value.
- Do not use balance changes or fees: the net is computed from message values
  only, so a plain deposit keeps its exact amount.
- No opcode-based classification.

---

# Requirements

- **R1.** A native `RECEIVE` reports `amount = inMsg.value − Σ value of the
  outgoing messages of the same transaction`. Every outgoing internal message
  counts, including those that are part of a jetton transfer (their attached
  TON).
- **R2.** When that net is zero or negative, no native `RECEIVE` is reported for
  that transaction.
- **R3.** A transaction with no outgoing messages reports its receipt exactly as
  today (`amount = inMsg.value`).
- **R4.** Bounce handling is unchanged: an incoming message the transaction sent
  back as a bounce is no receipt, and a bounce of the account's own message is a
  receipt marked `bounced`.
- **R5.** The `amount` doc comment on `TonAccountTransfer` states the new meaning
  for native receipts.
- **R6.** Released as a patch version, with a CHANGELOG entry that names the
  behaviour change for callers.
- **R7.** A caller can ask for receipts as delivered instead
  (`receipts: 'gross'` on `accountTransfersOf` and `getAccountTransfers`): the
  incoming value whatever the transaction sent out, as before this change. Net is
  the default.

---

# Acceptance Criteria

- **AC1 (R1)** The staging refund trace above (`05035eb1…`: in 12 098 212,
  out 9 000 000) recorded as a fixture: the vault's native `RECEIVE` is
  3 098 212 — the margin and fees Depositron leaves behind today — and its `SEND`
  of 9 000 000 to the user is still reported. With Depositron's margin return in
  the same transaction it has none (AC6).
- **AC2 (R1)** A transaction that received 50 000 000 and sent 10 000 000 reports
  one native `RECEIVE` of 40 000 000.
- **AC3 (R3)** A plain wallet deposit fixture (no outgoing messages) reports the
  same `RECEIVE` amount as before this change, to the nanoton.
- **AC4 (R1, R2)** A vault transaction that runs a jetton payout (relay value in,
  the jetton `transfer` message with its attached TON out) reports a native
  `RECEIVE` of only the difference, or none when it is ≤ 0; the jetton `SEND` is
  unchanged.
- **AC5 (R4)** The existing bounce fixtures pass unchanged.
- **AC6 (R2)** A relay that brought 12 098 212 in and sent 9 000 000 to the user
  plus 10 000 000 back to the fee payer reports no native `RECEIVE`.
- **AC7 (R7)** A destination that forwards 0.999 of a 1 TON receipt in the same
  transaction: `gross` reports 1 TON, `net` (and the default) 0.001 TON. The
  refund trace read `gross` reports the vault's 12 098 212.

---

# Constraints & Context

## Starting points

- `ton/ton_chain.ts` — `accountTransfersOf`: the native `RECEIVE` branch
  (`found.push({ direction: 'RECEIVE', asset: { kind: 'native' }, amount:
  inMsg.value, … })`). `tx.outMsgs` is already at hand.
- `ton/test/fixtures/` — recorded traces; add the staging refund trace.

## Compatibility constraints

- `TonAccountTransfer`'s shape does not change; only the value of `amount` for
  native receipts, and whether one is reported.
- Callers: Clydner (`tonapi-watcher.service.ts` → `accountTransfersOf`) and
  rango-intents (`getAccountTransfers` in deposit enrichment and
  `POST /transaction`) want net, the default, and pick it up with a version bump.
- rango-intents' fill proof (`proof/services/ton_fill_status.ts`) proves that a
  solver's TON reached the destination. A destination that forwards it in the
  same transaction keeps little or nothing, so net would reject a real fill: it
  must pass `receipts: 'gross'` when it bumps to this version.

## Dependencies / blockers

None to build. Depositron's margin return (`../depositron/1-ton-return-relay-margin.md`)
is what makes a refund's net negative. On its own this card only shrinks the
phantom receipt to the leftover (AC1), so it does not fix the incident alone:
omnichain, Clydner, rango-intents and Depositron's margin return reach
production together, with no window between them where only some are live.

---

# Open Questions

<!-- none -->
