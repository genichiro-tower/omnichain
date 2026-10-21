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
- **An uncertain broadcast** throws `TonBroadcastUncertainError` (`RpcError`, with `meta.txHash`): TON Center failed without an answer and there was no fallback, or TonAPI then refused the message — which it also does for a message already accepted. The message may land. Read `getTransactionStatus(meta.txHash)`, or wait until `isRequestExpired` is true, before signing a replacement; a new request with a new seqno can pay twice. A refusal with no failure before it is `BroadcastRejected` and definite: the lite server will not apply the message. A lite server that already has the message ("duplicate message") counts as sent, so broadcasting the same BOC twice is safe. Both answers come as HTTP 500 (TonAPI also uses 406) and are read by their text, not as an outage. A refusal does not prove an earlier send of the same BOC did not land.
- **A trace is checked before it is used**: every internal message must name its source and `created_lt`, and every transaction must have received a message its parent sent, to that account, with that value. A provider whose trace breaks this — or, on TON Center, leaves a transaction out of an emulation — fails retryably, so the trace is read from TonAPI. A TON Center trace that leaves a transaction out is incomplete (`Pending`), and that transaction's children keep it as their parent.
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
- `signMessage` / `verifySignature` sign the message's UTF-8 bytes with ed25519. `TonChain.verifyMessageSignature` throws: a TON address does not reveal its key.

## Messages and relaying

`TonOutMessage` is `{ to, value, body?, bounce?, stateInit?, mode? }`; at most 255 per request. `bounce` defaults to whether there is a body; `mode` to `PAY_GAS_SEPARATELY`.

Helpers: `tonCommentBody(text)`, `tonJettonTransferBody({ amount, destination, responseDestination, forwardTonAmount, forwardPayload })` (TEP-74, sent to the sender's own jetton wallet), and `tonRelayMessage({ wallet, request, value, deploy })`.

A relayer delivers another wallet's request and pays for it:

```ts
const request = vault.createInternalRequest({ seqno: vaultSeqno, messages });
const relay = tonRelayMessage({ wallet: vault, request, value: attachedNanotons, deploy: !vaultDeployed });
const signed = feePayer.createExternalRequest({ seqno: feePayerSeqno, messages: [relay], deploy: !feePayerDeployed });
const emulation = await ton.emulate(signed.boc); // fees and outcome before sending
const hash = await ton.broadcast(signed.boc);
```

The relay message is bounceable: a request that fails in the target returns the value to the relayer. A request the target does not accept (a bad signature, a stale seqno) is dropped without a bounce — the target keeps the value — and the status reports it as `request_not_executed`.

## Reading state

- `getAccountState(address)` — `nonexist | uninit | active | frozen`, balance and code hash. TON Center reports a never-used address as `uninit`; it is read as `nonexist`.
- `getSeqno(address)` — 0 while the wallet is not deployed.
- `getBalance(owner, jettonMaster?)` and `getJettonWalletAddress(jettonMaster, owner)` — through the master's `get_wallet_address` and the wallet's `get_wallet_data`; an undeployed jetton wallet reads 0.
- `getChainTipHeight()` — the masterchain's latest block (`provider.getMasterchainHead()` also gives its time).

## Emulation, broadcast and status

- `emulate(boc)` emulates the external message's whole trace with the signature ignored, deploys and downstream hops included. It returns `success` and `problem` (judged as for the status below), `deliveries`, `fees` (every transaction's fees plus the forward fees its messages carried), the failed transactions and bounced messages, native TON balance changes and `jettonCredits`. A message the target would refuse outright throws `SimulationFailed`.
- `broadcast(boc)` returns the **normalized external-message hash** (TEP-467, lowercase hex), the transaction id on both providers.
- `getTransactionStatus(hash, { minMasterchainDepth })` reads the whole trace:
  - `Pending` until the trace is complete and every transaction is in a block a masterchain block references; there is no confirmation count, because TON's consensus is final at that point (`minMasterchainDepth`, 0 by default, asks for more);
  - `Failed` when the request did not do what it was signed for: the sending wallet's transaction (or, for a relayed request, the target wallet's) failed or skipped a message (`skipped_actions`), the target did not execute the request (`request_not_executed`), or a message those wallets sent `bounced`, was `undelivered`, or reached a receiver that failed without sending it back (`receiver_failed`);
  - `Success` otherwise, with the TON balance changes, `fees`, `jettonCredits`, the trace, `masterchainSeqno` and `masterchainDepth`.
- A bounceable message is `bounced` only when its receiver's transaction sent it back — a failed compute phase, including an address with no code yet, or a failed action with send mode +16. A receiver that aborted without sending it back (an action that failed without +16, or too little value left to pay for the bounce) makes it `failed`: the value stayed there or went on fees, and nothing returned. A jetton transfer is judged where the jettons land, in the receiver's jetton wallet (`jetton_bounced` / `jetton_receiver_failed` / `jetton_undelivered` when they do not).
- `summary.deliveries` lists every message the sending wallets sent, in the order each wallet sent them (the request's order), with its outcome (`delivered`, `bounced`, `failed`, `undelivered`, `pending`). A message is matched to the transaction that received it by (source, `created_lt`), which names one message (the providers refuse a trace where the receiver's account or value disagrees); a failed status carries the deliveries too, so a caller can tell which messages arrived. A non-bounceable message is `delivered` even when its receiver then fails — the value stays there. Failures further down the trace (a recipient that throws on a jetton notification, a skipped excess refund) do not undo deliveries; they are in `failedTransactions` / `bouncedMessages` and do not fail the status.
- A transaction succeeds when its compute phase succeeded — or was skipped only because the account has no code yet, a plain transfer to an undeployed address — and its action phase, if any, succeeded.
- `isRequestExpired({ wallet, seqno, validUntil, hash })` — true when the request can no longer land, so a replacement cannot pay twice: the masterchain's latest block is more than `REQUEST_EXPIRY_MARGIN_SECONDS` (60) past `validUntil` — the chain's clock, not this machine's — the wallet's seqno never moved past the request's, and there is no trace of `hash`.

### Provider differences

| | TON Center v3 | TonAPI |
|---|---|---|
| Finality | per transaction `mc_block_seqno` (+ `finality: finalized`) | serves committed blocks only |
| `masterchainSeqno` | the masterchain block that committed the shard block | the shard block's `master_ref`, which can be a few blocks earlier |

## Testing

- `npm test` runs the unit specs (`ton/test/*.spec.ts`, no network) and `ton_recorded.spec.ts`, which replays real mainnet replies from `ton/test/fixtures/mainnet_recordings.json` through the providers' parsing and checks the SDK reaches the verdicts it reached live.
- `npm run test:live:ton` runs `ton/test/live/ton_mainnet.live.ts` against mainnet. It reads `.env.ton.local` (git-ignored; template `.env.ton.example`): the provider keys, a **dedicated** test mnemonic, the fee payer's account index and a spend cap. It reads and emulates by default — the masterchain head on each provider, a relay emulated on both providers alike, a relay that deploys a fresh vault and the same relay without deploy, and `isRequestExpired` on a request never sent. With `TON_LIVE_SEND=1` it broadcasts both relays, reads the sent trace alike from both providers, checks a landed request is never expired, and resends a landed message to both providers (a definite answer, no second landing). It rewrites the recordings only with `TON_LIVE_RECORD=1`. The vault returns everything to the fee payer, so a run costs only fees. Recordings keep URLs, bodies and replies, never headers, so no key is written.

## Not covered

Testnet, wallet versions other than W5R1, W5 extensions, TON-native mnemonics, jetton metadata (jetton transfers take `amount` in the smallest unit), and jetton balance changes beyond `jettonCredits`.
