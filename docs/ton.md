# TON

`@getomnichain/omnichain/ton` reads TON mainnet through TON Center v3, with TonAPI as the fallback, and builds and signs requests for wallet v5r1 (W5) accounts — including requests one wallet signs and another delivers and pays for. It is built on `@ton/core`, `@ton/crypto` and `@ton/ton`.

The family is imported from `@getomnichain/omnichain/ton` only. The root entry exports `TonAddress` and loads no TON dependency.

## Chains and providers

| Export | Value |
|---|---|
| `TonMainnet` | chain id `-4000`, TON Center `https://toncenter.com`, TonAPI `https://tonapi.io`, explorer `https://tonviewer.com`, 9 decimals |

```ts
import { TonChain, TON_CENTER_MAINNET_URL, TONAPI_MAINNET_URL } from '@getomnichain/omnichain/ton';

const ton = new TonChain({
  chainId: -4000,
  name: 'TON Mainnet',
  explorerUrl: 'https://tonviewer.com',
  toncenter: { url: TON_CENTER_MAINNET_URL, apiKey: toncenterKey },
  tonapi: { url: TONAPI_MAINNET_URL, apiKey: tonapiKey },
});
```

- Every provider needs a key. A key not passed is read at first use from `TONCENTER_API_KEY` / `TONAPI_API_KEY`; without a TON Center key every call throws `RpcNotConfigured`, and without a TonAPI key there is no fallback.
- **Fallback rule:** a call is retried once on TonAPI only when TON Center failed without an answer — a transport error, a timeout, HTTP 429 or 5xx. A definite answer (not found, a refused emulation, a refused message) is final. A broadcast retried on TonAPI sends the same BOC, which the wallet's seqno keeps from landing twice.
- **An uncertain broadcast** throws `TonBroadcastUncertainError` (kind `BroadcastUncertain`, `isBroadcastUncertainError`, with `meta.txHash`): TON Center failed without an answer and there was no fallback, or TonAPI then refused the message — which it also does for a message already accepted. The message may land. Before signing a replacement, wait for `getRequestState` (below) to say `expired`; `consumed` means it landed — read `getTransactionStatus(meta.txHash)`. A new request with a new seqno can otherwise pay twice. The lite server's answers come as HTTP 500 (TonAPI also uses 406) and are read by their text, not as an outage:
  - "duplicate message" — it already has the message: sent.
  - "cannot apply external message" with W5's seqno error (exit code 133) — `NonceTooLow`, as on EVM: the wallet's seqno has moved past the request, so it, or another request with its seqno, landed. This is what resending a message that landed gets. `getRequestState` then says `consumed`; read `getTransactionStatus(meta.txHash)`, and do not sign again.
  - any other refusal (bad signature, wrong wallet id, expired — W5 checks these after the seqno, so the seqno still matched and the message has not landed) — `BroadcastRejected`, definite.
- **A trace is checked before it is used** (`assertTraceConsistent`, by both providers and again by the judgment). On TON every internal message produces a transaction where it lands, so a trace with a gap is the provider's error, never an undelivered message:
  - every transaction but the root has a parent in the trace and an incoming internal message, one its parent sent: same source, `created_lt`, destination and value;
  - every internal message sent names its source and `created_lt`;
  - in a complete trace, every internal message sent has the transaction that received it.

  A trace that breaks any of these fails retryably, so it is read from TonAPI. So does an emulation the provider cut short (TON Center's `is_incomplete`, or a TonAPI emulation missing a hop): an emulation is judged whole or not at all. A trace still running may lack transactions (TON Center keeps a missing transaction as its children's parent); it is incomplete, and the status `Pending`.
- Both providers normalize to the same types (`TonAccountState`, `TonTrace`, `TonTraceTransaction`, `TonTraceMessage`). TonAPI's trace transactions carry no `out_msgs`, so its messages are read from each transaction's BOC. An empty message body is `null` on both. TonAPI answers a trace request for a message still in flight with its own emulation (`emulated: true`); that is read as no trace, and a predicted hop under a real transaction leaves the trace incomplete.

## Addresses

`TonAddress` accepts the raw form (`0:<hex>`) and both user-friendly forms (`EQ…` bounceable, `UQ…` non-bounceable, and their test-only variants). `canonical()` is the raw form with a lowercase hash, so every form of one account compares equal. `toUserFriendly({ bounceable, testOnly })` converts back; `tonRawAddress` / `tonUserFriendlyAddress` are the function forms.

A TON transfer to an address whose wallet is not deployed must use the **non-bounceable** form, or it bounces back.

## Wallets

```ts
import { TonWallet } from '@getomnichain/omnichain/ton';

const wallet = TonWallet.fromMnemonic(mnemonic, { derivationPath: TonWallet.derivationPath({ account: 7 }) });
wallet.address;                                   // 0:…
wallet.addressUserFriendly({ bounceable: false }); // UQ…
```

- The key is derived from a **BIP-39** mnemonic with SLIP-0010 ed25519 at the hardened path `m/44'/607'/<account>'` — not TON's own 24-word scheme, which cannot derive indexed keys.
- The account is a W5R1 wallet on workchain 0 with the mainnet client wallet id. `stateInit` deploys it.
- `createExternalRequest({ seqno, messages, validUntil, deploy })` is a request the wallet sends itself (and pays for). W5 sends external requests with "ignore errors" (+2) on every message.
- `createInternalRequest({ seqno, messages, validUntil })` is a request for a relayer (op `0x73696e74`). Send modes are kept as given, so without +2 its messages leave together or not at all.
- `signTransaction(transaction, chain)` reads the seqno and whether the wallet is deployed, and signs a `TonUnsignedTransaction` as an external request.
- `signMessage` / `verifySignature` sign `tonMessageHash(message)` = SHA-256(`"TON Signed Message:\n"` + the message's UTF-8 bytes) with ed25519, the shape of Stellar's SEP-53. Never the message's own bytes: the same key signs W5 requests over a 32-byte cell hash, so a crafted 32-byte message would otherwise yield a signature that authorizes a transfer. `TonChain.verifyMessageSignature` throws: a TON address does not reveal its key.

## Messages and relaying

`TonOutMessage` is `{ to, value, body?, bounce?, stateInit?, mode? }`; at most 255 per request. `bounce` defaults to whether there is a body; `mode` to `PAY_GAS_SEPARATELY`.

Helpers: `tonCommentBody(text)`, `tonJettonTransferBody({ amount, destination, responseDestination, forwardTonAmount, forwardPayload })` (TEP-74, sent to the sender's own jetton wallet), and `tonRelayMessage({ wallet, request, value, deploy })`.

A relayer delivers another wallet's request and pays for it:

```ts
const validUntil = Math.floor(Date.now() / 1000) + 300;
// Keep both requests (they carry their seqno and validUntil): getRequestState needs them later.
const request = vault.createInternalRequest({ seqno: await ton.getSeqno(vault.address), validUntil, messages });
const relay = tonRelayMessage({ wallet: vault, request, value: attachedNanotons, deploy: request.seqno === 0 });
const feePayerSeqno = await ton.getSeqno(feePayer.address);
const signed = feePayer.createExternalRequest({ seqno: feePayerSeqno, validUntil, messages: [relay], deploy: feePayerSeqno === 0 });
const emulation = await ton.emulate(signed.boc); // fees and outcome before sending
const hash = await ton.broadcast(signed.boc);
```

`createInternalRequest` returns `{ body, seqno, validUntil }`; `createExternalRequest` returns `{ boc, hash, seqno, validUntil }`; a `TonSignedTransaction` (from `signTransaction`, or `fromJson`) reads `walletAddress`, `seqno` and `validUntil` from its signed body. `tonW5RequestFields(body)` and `tonInternalRequestOf(body)` read them back from any signed W5 body, such as a relay message found in a trace.

The relay message is bounceable: a request that fails in the target's compute phase (a stale seqno, a wrong wallet id, expired) returns the value to the relayer. One that fails sending its messages (more than the target holds) aborts without a bounce — the target keeps the value (`receiver_failed`). A request with a bad signature is dropped silently, the target keeping the value (`request_not_executed`).

**A relayed request that failed is not dead.** W5 keeps an internal request's seqno only when the transaction succeeds, so after a failure the request is still valid, and anyone can deliver it again from the public trace until its `validUntil` — observed on mainnet: a request that failed for lack of funds executed when delivered a second time. Before signing a replacement, wait for `getRequestState({ wallet: vault.address, seqno: request.seqno, validUntil: request.validUntil })` to say `expired`.

### Before signing a replacement: `getRequestState`

`getRequestState({ wallet, seqno, validUntil, hash? })` says where a signed request stands. `wallet` is the wallet that signed it — the sender of an external request (pass its `hash`), the target of a relayed one (no `hash`: a relay's hash is the relayer's request, and a `hash` whose trace starts at another wallet is refused with `InvalidArgument`).

| State | Means | Do |
|---|---|---|
| `consumed` | The wallet's seqno moved past the request's, or the request (by `hash`) has a trace. It executed — or another request signed with the same seqno did. | Never re-sign it. Read the status: `getTransactionStatus(hash)`, or the relay's. |
| `expired` | The chain's time — the masterchain head's, not this machine's — is more than `REQUEST_EXPIRY_MARGIN_SECONDS` (60) past `validUntil`, the seqno has not moved past it, and it has no trace. It can never execute. | Replacing it is safe. |
| `live` | Neither yet. It can still execute — a failed relayed request included. | Wait. |

Every read comes from one provider (if one fails on TON Center, all are repeated on TonAPI), and a read that fails throws rather than answering: no provider reads a failure as a 0 seqno, a `NaN` time, `nonexist` or "no trace". `hash` must be 64 lowercase hex characters, as everywhere a transaction id is taken.

## Reading state

- `getAccountState(address)` — `nonexist | uninit | active | frozen`, balance and code hash, from the providers' indexers. TON Center reports a never-used address as `uninit`; it is read as `nonexist`. `nonexist` only when the provider says so (TON Center's empty account list, TonAPI's `status: "nonexist"`); a missing reply or an unknown status throws.
- `getSeqno(address)` — read live from the wallet's get-method, not from the indexed account state, which can trail a deploy by seconds; 0 only on the provider's explicit answer that the account has no code. `signTransaction` deploys at seqno 0 (a StateInit sent to a deployed wallet is ignored).
- `getBalance(owner, jettonMaster?)` and `getJettonWalletAddress(jettonMaster, owner)` — through the master's `get_wallet_address` and the wallet's `get_wallet_data`; an undeployed jetton wallet reads 0.
- `getChainTipHeight()` — the masterchain's latest block (`provider.getMasterchainHead()` also gives its time).

## Emulation, broadcast and status

- `emulate(boc)` emulates the external message's whole trace with the signature ignored, deploys and downstream hops included. It returns `success` and `problem` (judged as for the status below), `deliveries`, `fees` (every transaction's fees plus the forward fees its messages carried), the failed transactions and bounced messages, native TON balance changes and `jettonCredits`. A message the target would refuse outright throws `SimulationFailed`.
- `broadcast(boc)` returns the **normalized external-message hash** (TEP-467, lowercase hex), the transaction id on both providers.
- `getTransactionStatus(hash, { minMasterchainDepth })` reads the whole trace:
  - `Pending` until the trace is complete and every transaction is in a block a masterchain block references; there is no confirmation count, because TON's consensus is final at that point (`minMasterchainDepth`, 0 by default, asks for more);
  - `Failed` when the request did not do what it was signed for: the sending wallet's transaction (or, for a relayed request, the target wallet's) failed or skipped a message (`skipped_actions`), the target did not execute the request (`request_not_executed`), or a message those wallets sent `bounced` or reached a receiver that failed without sending it back (`receiver_failed`), or a jetton transfer's jettons were not sent on (`jetton_undelivered`);
  - `Success` otherwise, with the TON balance changes, `fees`, `jettonCredits`, the trace, `masterchainSeqno` and `masterchainDepth`.
- A bounceable message is `bounced` only when its receiver's transaction sent it back — a failed compute phase, including an address with no code yet, or a failed action with send mode +16. A receiver that aborted without sending it back (an action that failed without +16, or too little value left to pay for the bounce) makes it `failed`: the value stayed there or went on fees, and nothing returned. A jetton transfer is judged where the jettons land, in the receiver's jetton wallet (`jetton_bounced` / `jetton_receiver_failed` / `jetton_undelivered` when they do not).
- `summary.deliveries` lists every message the sending wallets sent, in the order each wallet sent them (the request's order), with its outcome (`delivered`, `bounced`, `failed`, `undelivered` — a jetton transfer only, never a gap in a complete trace — or `pending`). A message is matched to the transaction that received it by (source, `created_lt`), which names one message (the providers refuse a trace where the receiver's account or value disagrees); a failed status carries the deliveries too, so a caller can tell which messages arrived. A non-bounceable message is `delivered` even when its receiver then fails — the value stays there. Failures further down the trace (a recipient that throws on a jetton notification, a skipped excess refund) do not undo deliveries; they are in `failedTransactions` / `bouncedMessages` and do not fail the status.
- A transaction succeeds when its compute phase succeeded — or was skipped only because the account has no code yet, a plain transfer to an undeployed address — and its action phase, if any, succeeded.
- `getTrace` and `getTransactionStatus` take the transaction id as 64 lowercase hex characters and refuse anything else (`InvalidArgument`). "No trace" is read only from the providers' explicit answers (TON Center's empty `traces` list, TonAPI's 404); any other reply throws.

### Provider differences

| | TON Center v3 | TonAPI |
|---|---|---|
| Finality | per transaction `mc_block_seqno` (+ `finality: finalized`) | serves committed blocks only |
| `masterchainSeqno` | the masterchain block that committed the shard block | the shard block's `master_ref`, which can be a few blocks earlier |

## Testing

- `npm test` runs the unit specs (`ton/test/*.spec.ts`, no network) and `ton_recorded.spec.ts`, which replays real mainnet replies from `ton/test/fixtures/mainnet_recordings.json` through the providers' parsing and checks the SDK reaches the verdicts it reached live.
- `npm run test:live:ton` runs `ton/test/live/ton_mainnet.live.ts` against mainnet. It reads `.env.ton.local` (git-ignored; template `.env.ton.example`): the provider keys, a **dedicated** test mnemonic, the fee payer's account index and a spend cap. It reads and emulates by default — the masterchain head on each provider, a relay emulated on both providers alike, a relay that deploys a fresh vault and the same relay without deploy, and `getRequestState` on a request never sent (`expired` past its time, `live` before it), whose seqno and `validUntil` a `TonSignedTransaction` reads back. With `TON_LIVE_SEND=1` it broadcasts both relays, reads the sent trace alike from both providers, checks a landed request is `consumed`, resends a landed message to both providers (`NonceTooLow`, no second landing), and delivers a relayed request the vault cannot pay yet, then delivers the same request again (failed with the seqno unchanged and still `live`, then executed and `consumed`, its seqno and `validUntil` read back from the trace). It rewrites the recordings only with `TON_LIVE_RECORD=1`. The vault returns everything to the fee payer, so a run costs only fees. Recordings keep URLs, bodies and replies, never headers, so no key is written.

## Not covered

Testnet, wallet versions other than W5R1, W5 extensions, TON-native mnemonics, jetton metadata (jetton transfers take `amount` in the smallest unit), and jetton balance changes beyond `jettonCredits`.
