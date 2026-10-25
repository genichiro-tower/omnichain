---
title: omnichain — TON account transfers from a transaction hash (for clydner)
status: in progress
repos: [omnichain]
---

<!-- ======================= PART A - REQUEST ======================= -->

# Summary

Clydner will watch TON addresses through TonAPI webhooks. A webhook names an
**account transaction** (`account_id`, `lt`, `tx_hash`), but omnichain 0.7.0
reads a trace only by its **external message** hash, and has no way to say
which transfers a transaction moved into or out of an account, or whether they
are final. This adds that, so clydner (and depositron) do not re-implement TON
trace logic.

# Objective

From a transaction hash, omnichain returns the native-TON and jetton transfers
into and out of a given account in that transaction's trace, each with whether
it is final, plus what is needed to catch up on an account after missed
notifications.

# Scope

## Out of scope / non-goals

- Clydner itself (its own card).
- Jetton mints and burns, NFTs, and anything that is not a TON or jetton transfer.
- Testnet.

# Requirements

- **R1. Trace by transaction.** `getTraceByTransaction(txHash)` on both
  providers and `TonChain`: the whole trace containing that transaction (from its
  root), checked as every trace is (`assertTraceConsistent`), and refused unless
  it holds the transaction. TON Center `/api/v3/traces?tx_hash=`, TonAPI
  `/v2/traces/{tx_hash}`; `null` while the providers have no trace; TonAPI's
  emulation of a message in flight is no trace.
- **R2. Account transactions after a cursor.** `getAccountTransactions(account,
  { afterLt, limit })`: the account's transactions with an lt above `afterLt`,
  oldest first (hash, lt, time, masterchain block when final). TON Center
  `start_lt` is inclusive and TonAPI `after_lt` exclusive; both read as "after".
- **R3. Last transaction lt.** `getLastTransactionLt(account)`: 0 for an account
  that never transacted, as the provider states it.
- **R4. Account transfers.** `TonChain.getAccountTransfers({ account, txHash })`
  → `null` while there is no trace, else `{ trace, settled, transfers }`:
  - native TON received by the account (an incoming internal message whose
    value it kept — not one its transaction sent back as a bounce), or sent by
    it (an outgoing internal message), with the text comment when there is one;
    a received bounce of the account's own message is marked `bounced`;
  - jettons sent or received by the account as owner: each wallet-to-wallet
    TEP-74 transfer whose master vouches for both jetton wallets, as for the
    jetton balance changes; mints, burns and impostor jetton wallets move
    nothing;
  - the TON that rides along a jetton transfer (`transfer`, `internal_transfer`,
    `transfer_notification`, `excesses`) is part of it, not a native transfer;
  - each transfer: direction, asset (native or the jetton master), owner from
    and to, amount, comment, the transaction that moved it (native: the
    account's; jettons: the receiving jetton wallet's) with its lt, time and
    masterchain block, `final` (that transaction is in a finalized masterchain
    block), and an index telling apart transfers of one transaction;
  - `settled`: the trace is complete and every transaction in it is final — no
    transfer will be added or change.

# Acceptance Criteria

- **AC1 (R1)** A transaction hash in the middle of a trace returns the whole
  trace from its root on both providers, alike.
- **AC2 (R2, R3)** Both providers list the same transactions after a given lt;
  a never-used address has last lt 0.
- **AC3 (R4)** For a real USDT transfer, the sender's and the recipient's
  transfers are a verified jetton SEND and RECEIVE of the same amount, final once
  the receiving jetton wallet's transaction is.
- **AC4 (R4)** For a relay of ours, the fee payer's native SEND and the vault's
  RECEIVE match the messages; a bounced message is not a RECEIVE of the
  receiver.

# Constraints & Context

- Version 0.7.1; additive only.
- Reads go through the existing providers and fallback, strict as the rest
  (failed reads throw, never read as empty).

<!-- ======================= PART B - IMPLEMENTATION ======================= -->

# Implementation Plan

1. Providers: `getTraceByTransaction`, `getAccountTransactions`,
   `getLastTransactionLt`; the fallback; `assertTraceHolds`.
2. `TonChain`: the three reads, and the verified jetton transfers factored out
   of the jetton balance changes.
3. `getAccountTransfers`.
4. Tests (unit with recorded replies; live on mainnet), docs, CHANGELOG, 0.7.1.

# Verification

- Unit: provider reads against replies recorded from both providers on
  mainnet (a trace found from its middle transaction, account transactions
  after a cursor, last lt); `getAccountTransfers` on a real relay trace (both
  accounts, the real transfer's comment read) and on built jetton, impostor,
  bounce and finality cases. 1984 tests pass; build clean.
- Live (read-only, 2026-10-25): AC1 and AC2 alike on both providers; AC3 on
  recent real USDT transfers, verified the same through TonAPI alone.

<!-- ======================= PART C - DEVIATIONS ======================= -->

# Deviations

- `getLastTransactionLt` on TonAPI: its raw account states
  `last_transaction_lt: 0` for an account that does not exist but had
  transactions (a vault that bounced a relay — seen on mainnet, while TON
  Center gave the lt), so the newest transaction in its list decides; 0 needs
  an empty list and `nonexist` stated.
- Live, with sends (2026-10-25): 28 of 29, then the remaining emulation test
  passed on its own (it had raced the previous run's last transaction). The
  relay read back with `getAccountTransfers`, and the bounced vault's last lt
  alike on both providers. The live suite asks for funds only when it sends
  (`TON_LIVE_SKIP_BALANCE_CHECK=1` bypasses that), and retries provider
  outages in its TonAPI cross-checks.
- TonAPI's free tier (1 RPS) rate-limits trace reads (one masterchain-block
  lookup per shard block); reads should go through TON Center first.

# Follow-ups raised

- Pace or batch TonAPI's masterchain-block lookups so its free tier can serve
  trace reads as a fallback.
