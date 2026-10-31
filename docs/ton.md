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
  - "cannot apply external message" with a seqno error (W5 133, v3r2 / v4r2 33) — `NonceTooLow`, as on EVM: the wallet's seqno has moved past the request, so it, or another request with its seqno, landed. This is what resending a message that landed gets. `getRequestState` then says `consumed`; read `getTransactionStatus(meta.txHash)`, and do not sign again.
  - a refusal that does not rule out an earlier landing — `BroadcastUncertain`: a v3r2 / v4r2 expiry (35, 36: they check the expiry before the seqno), or "rejected … before smart-contract execution" (an account that cannot pay to run it, such as a wallet that sent everything away; no check ran).
  - any other refusal (W5's bad signature, wrong wallet id or expiry, which it checks after the seqno; a v3r2 / v4r2 wrong wallet id) — the seqno still matched, so the message has not landed — `BroadcastRejected`, definite.
- **A trace is checked before it is used** (`assertTraceConsistent`, by both providers and again by the judgment). On TON every internal message produces a transaction where it lands, so a trace with a gap is the provider's error, never an undelivered message:
  - every transaction but the root has a parent in the trace and an incoming internal message, one its parent sent: same source, `created_lt`, destination and value;
  - every internal message sent names its source and `created_lt`;
  - in a complete trace, every internal message sent has the transaction that received it.

  A trace that breaks any of these fails retryably, so it is read from TonAPI. So does an emulation the provider cut short (TON Center's `is_incomplete`, or a TonAPI emulation missing a hop): an emulation is judged whole or not at all. A trace still running may lack transactions (TON Center keeps a missing transaction as its children's parent); it is incomplete, and the status `Pending`.
- **A trace is the message's**: a trace whose root did not receive the requested message (by its normalized hash) is refused retryably.
- Both providers normalize to the same types (`TonAccountState`, `TonTrace`, `TonTraceTransaction`, `TonTraceMessage`). TonAPI's trace transactions carry no `out_msgs`, so its messages are read from each transaction's BOC. An empty message body is `null` on both. TonAPI answers a trace request for a message still in flight with its own emulation (`emulated: true`); that is read as no trace, and a predicted hop under a real transaction leaves the trace incomplete.

## Addresses

`TonAddress` accepts the raw form (`0:<hex>`) and both user-friendly forms (`EQ…` bounceable, `UQ…` non-bounceable, and their test-only variants). `canonical()` is the raw form with a lowercase hash, so every form of one account compares equal. `toUserFriendly({ bounceable, testOnly })` converts back; `tonRawAddress` / `tonUserFriendlyAddress` are the function forms.

A TON transfer to an address whose wallet is not deployed must use the **non-bounceable** form, or it bounces back.

## Assets and transfers

- `resolveAsset(identifier?)` — native TON, or the jetton whose master `identifier` names (any address form), its symbol and decimals read from TEP-64 metadata: the master's `get_jetton_data` content (on-chain fields, snake or chunked) and, for what it lacks, the off-chain JSON its URI names (https only; `fetchMetadata` in `TonChainInit` replaces the fetch). The decimals decide every amount, so they are never guessed: TEP-64's default of 9 applies only when the metadata, fully read, names none, and a URI that did not load with no decimals on chain throws. A symbol that cannot be read falls back to the address's first characters, as in Python. Resolved jettons are kept for the chain's lifetime. `getJettonMetadata(master)` returns the metadata itself; `createAsset` / `getJettonAsset` build one without reading. `TON_TON`, `TON_USDT` (`USD₮`, 6) and `TON_MAINNET_STABLECOINS_PEG` are in `ton_assets.ts`.
- `createTransferUnsignedTransaction(req: TonTransferOptions)` — native TON or a jetton; exactly one of `amount` (smallest unit), `amountHr` (a jetton's decimals come from `resolveAsset`) or `isFullBalance`:
  - native `isFullBalance` sends everything the wallet holds (send mode 128 + 2 = 130, value 0), as Python does; a jetton's sends the jetton wallet's whole balance (`InsufficientFunds` when it is empty) — Python ignores it for jettons;
  - native bounce, unless `bounce` is given: only to a bounceable (`EQ…`) address that is deployed. A contract that fails then returns the TON, and a wallet not deployed yet still receives it — what TON wallets do. Python defaults to `false`, which loses TON sent to a failing contract; for wallets the two agree;
  - jetton transfers are bounceable, carry `DEFAULT_JETTON_TRANSFER_ATTACHED_NANOTON` (0.05 TON) and forward `DEFAULT_JETTON_FORWARD_NANOTON` (1 nanoton);
  - `bounce`, `sendMode`, `jettonAttachedNanoton` and `forwardTonAmountNanoton` override.
- `getTokenExplorerUrl(master)` / `getAssetExplorerUrl(asset)` link a jetton by its master's bounceable (`EQ…`) form — a contract; `getWalletExplorerUrl` uses the non-bounceable form.

## Wallets

```ts
import { TonWallet } from '@getomnichain/omnichain/ton';

const own = TonWallet.fromMnemonic(tonWalletWords);  // TON's own scheme: the wallet's account, as the Python SDK gives it
const vault = TonWallet.fromMnemonic(mnemonic, { derivationPath: TonWallet.derivationPath({ account: 7 }) }); // indexed
vault.address;                                   // 0:…
vault.addressUserFriendly({ bounceable: false }); // UQ…
```

Two derivations, chosen by whether a path is given:

| | No `derivationPath` (or Python's marker `m/44'/607'/0'/0/0`) | A `derivationPath` (`m/44'/607'/<account>'`) |
|---|---|---|
| Scheme | TON's own mnemonic scheme (HMAC-SHA512, then PBKDF2-SHA512 "TON default seed", 100,000 rounds) — what TON wallets, `@ton/crypto` and the Python SDK use | BIP-39 seed, then SLIP-0010 ed25519 at the hardened path |
| Accounts | One per mnemonic: a wallet's own words give its W5 account, the same key and address as the Python SDK (`version='v5r1'`) | Many: one per account index, for vaults derived from one mnemonic |
| Passphrase | Refused (the Python SDK ignores it) | BIP-39 passphrase |

- `m/44'/607'/0'` is account 0 of the path scheme, **not** the Python SDK's key, although the Python SDK accepts that string as a marker. Without a path the words are trimmed and lowercased, as in Python, and not validated.
- **Wallet versions** (`version`, as in the Python SDK): `v5r1` (W5, the default), `v4r2` (the Python SDK's default) and `v3r2`. One key gives a different address per version; with no path each matches the Python SDK's account of that version. `stateInit` deploys the wallet.
- **Workchain** (`workchain`, as in the Python SDK): 0, the basechain (the default), or -1, the masterchain. The wallet ids are the Python SDK's on both: W5's context names workchain 0 and v3r2 / v4r2's is 698983191, whatever the wallet's workchain, so a -1 wallet has its workchain-0 twin's contract and hash (`-1:<same hash>`). `@ton/ton`'s v3r2 / v4r2 default (698983191 + workchain) would give another address on -1. The masterchain prices gas, messages and cells about 150 times higher: funding a wallet there costs about 0.01 TON in fees, and a W5 request several hundredths.

| | v5r1 (W5) | v4r2, v3r2 |
|---|---|---|
| External requests (`createExternalRequest`, `signTransaction`) — the wallet pays | yes, up to 255 messages | yes, up to 4 messages |
| Relayed, gasless requests (`createInternalRequest`, `tonRelayMessage`) — another account pays | yes | **no** — refused (`FeatureNotSupported`); `tonRelayMessage` refuses a non-W5 target |

- Every external request carries "ignore errors" (+2) on each message — W5 forces it, and v3r2 / v4r2 get it here, since a v3r2 request whose action phase failed would keep its seqno and could land again. Each message keeps its own send mode; v3r2 / v4r2 bodies are what `@ton/ton` builds.
- `createExternalRequest({ seqno, messages, validUntil, deploy })` is a request the wallet sends itself (and pays for). W5 sends external requests with "ignore errors" (+2) on every message.
- `createInternalRequest({ seqno, messages, validUntil })` is a request for a relayer (op `0x73696e74`). Send modes are kept as given, so without +2 its messages leave together or not at all.
- `signTransaction(transaction, chain)` reads the seqno and whether the wallet is deployed, and signs a `TonUnsignedTransaction` as an external request.
- `signMessage` / `verifySignature` sign `tonMessageHash(message)` = SHA-256(`"TON Signed Message:\n"` + the message's UTF-8 bytes) with ed25519, the shape of Stellar's SEP-53. Never the message's own bytes: the same key signs W5 requests over a 32-byte cell hash, so a crafted 32-byte message would otherwise yield a signature that authorizes a transfer. Standard TON wallets (TonConnect `signData`) do not produce this format.
- `TonChain.verifySignature(publicKey, message, signature)` checks one with the public key only (32 bytes, or 64 hex characters), as `TronChain` / `StellarChain` do; `TonWallet.verifySignature` uses it. The signature must be exactly 128 hex characters (anything else, trailing characters included, is `false`) and a `TonSignedMessage`. `TonChain.verifyMessageSignature` throws: a TON address does not reveal its key — the key's wallet address is `tonWalletAddress(publicKey, version)`.
- `tonWalletAddress(publicKey, version, { workchain })` is the raw address of a key's wallet, built as `TonWallet` builds its contract (`TonWallet` uses it); `tonWalletAddresses(publicKey)` gives one per version. The key is 32 bytes or 64 hex characters.

## Sign-in: TonConnect `ton_proof`

```ts
const result = await TonMainnet.verifyTonProof(
  { address, network, proof, publicKey }, // as TonConnect returns them: account.address, account.chain, the ton_proof item, account.publicKey
  { expectedDomain: 'dashboard.example', expectedPayload: nonce }, // maxAgeSeconds (600), now
);
// { ok: true, publicKey, version } | { ok: false, reason }
```

`verifyTonProof` checks, in order, by TonConnect's rules:

1. the network is mainnet (`-239`) — the signature does not cover it;
2. the domain is `expectedDomain`, and `lengthBytes` its UTF-8 length;
3. the timestamp (a number or a decimal string) is at most `maxAgeSeconds` old, and at most 60 s ahead (a wallet's clock may run ahead);
4. the payload is `expectedPayload`;
5. the StateInit is the account's: its address on the account's workchain is the account;
6. the key: a fixed-key wallet (`v3r2`, `v4r2`, `v5r1`, by code hash) gives it from its StateInit data. Telegram Wallet's in-app wallet (its trampoline, `TON_WALLET_TG_TRAMPOLINE_CODE_HASH`) can rotate its key, so the live account must be `active` and run the trampoline, and its `get_public_key` names the key, read afresh for every proof. A reported `publicKey` must be that key;
7. ed25519 over `sha256(0xffff ‖ "ton-connect" ‖ sha256(message))` (`tonProofDigest`), `message` being `"ton-proof-item-v2/"` ‖ workchain (int32 BE) ‖ account hash ‖ domain length (uint32 LE) ‖ domain ‖ timestamp (uint64 LE) ‖ payload.

Reasons: `network`, `domain`, `expired`, `payload`, `address`, `unsupported_wallet` (another contract, W5 beta and v3r1 among them, or a Telegram Wallet account that is not running the trampoline), `public_key`, `signature`, and `provider` — the chain could not be read, so the same proof may verify on a retry. It never throws on what the wallet sent; an invalid `now` or a `maxAgeSeconds` that is not a positive finite number throws `InvalidArgument`, as it would leave the age unchecked. Only Telegram Wallet reads the chain (`getAccountState`, `getPublicKey`), so a chain without provider keys verifies every other wallet. TonConnect's 128-byte caps on the domain and payload bound what a dapp may request, not what was signed: the payload is bound by being the issued one.

## Signing text: TonConnect `signData`

```ts
const result = verifyTonSignData(signDataResult, { // the signData result as the wallet returns it
  publicKey,                  // the signer's key: e.g. from its ton_proof sign-in
  expectedAddress, expectedDomain, expectedText, // maxAgeSeconds (600), now
});
// { ok: true } | { ok: false, reason: 'payload' | 'address' | 'domain' | 'expired' | 'signature' }
```

Text payloads only. The wallet signs ed25519 over `sha256(0xffff ‖ "ton-connect/sign-data/" ‖ workchain (int32 BE) ‖ account hash ‖ domain length (uint32 BE) ‖ domain ‖ timestamp (uint64 BE) ‖ "txt" ‖ text length (uint32 BE) ‖ text)` (`tonSignDataTextDigest`) — big-endian throughout, unlike `ton_proof`. A TON address does not reveal its key, so the caller supplies it. Never throws on what the wallet sent; an unusable key, `now` or `maxAgeSeconds` throws `InvalidArgument`. Not every wallet app offers `signData`.

Without a wallet app, a `TonWallet` gives both results a wallet app would: `signTonProof({ domain, payload })` for sign-in, `signTextData({ text, domain })` for text — each with an optional `timestamp`.

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

Every read comes from one provider (if one fails on TON Center, all are repeated on TonAPI), and a read that fails throws rather than answering: no provider reads a failure as a 0 seqno, a `NaN` time, `nonexist` or "no trace". `hash` must be 64 lowercase hex characters, as everywhere a transaction id is taken, and its request must be `wallet`'s at `seqno` (read from the signed request in the trace), or the call is refused.

## Reading state

- `getAccountState(address)` — `nonexist | uninit | active | frozen`, balance and code hash, from the providers' indexers. TON Center reports a never-used address as `uninit`; it is read as `nonexist`. `nonexist` only when the provider says so (TON Center's empty account list, TonAPI's `status: "nonexist"`); a missing reply or an unknown status throws.
- `getSeqno(address)` — read live from the wallet's get-method, not from the indexed account state, which can trail a deploy by seconds; 0 only on the provider's explicit answer that the account has no code. `signTransaction` deploys at seqno 0 (a StateInit sent to a deployed wallet is ignored).
- `getBalance(owner, jettonMaster?)` and `getJettonWalletAddress(jettonMaster, owner)` — through the master's `get_wallet_address` and the wallet's `get_wallet_data`. A jetton wallet reads 0 only when it has no code — TON Center's exit code -13, or TonAPI's 404 confirmed by a `nonexist` / `uninit` account state; a get-method that fails on a deployed jetton wallet throws (retryably) rather than reading 0.
- `getChainTipHeight()` — the masterchain's latest block (`provider.getMasterchainHead()` also gives its time).

## An account's transfers (deposit watching)

A watcher told about an account transaction — a TonAPI webhook names `account_id`, `lt`, `tx_hash` — reads what moved with:

```ts
const result = await ton.getAccountTransfers({ account, txHash }); // null while the providers have no trace yet
for (const t of result?.transfers ?? []) {
  if (!t.final) continue;            // emit only final transfers; read again later for the rest
  t.direction;                       // 'RECEIVE' | 'SEND'
  t.asset;                           // { kind: 'native' } | { kind: 'jetton', jettonMaster }
  t.from; t.to; t.amount; t.comment; // owners (raw), smallest unit, text comment
  t.transaction.hash; t.index;       // with t.direction, names the transfer on every read: a dedup key
}
result?.settled;                     // the trace is complete and all final: nothing will change
```

- **Native TON:** an incoming internal message the account kept (not one its transaction sent back as a bounce), or an outgoing one. A bounce of the account's own message coming back is a receipt marked `bounced`; the bounce it sends back is no transfer. The TON riding along a jetton transfer (`transfer`, `internal_transfer`, `transfer_notification`, `excesses`) is part of the jetton transfer, not a payment.
- **Jettons:** the account as owner. A transfer counts only when its master vouches for both jetton wallets (`getJettonTransfers`); its transaction is the receiving jetton wallet's, so a jetton receipt is final when the jettons have landed. A jetton transfer with no forward TON amount produces no transaction on the recipient's own account, only on its jetton wallet — a watcher that must see every jetton receipt watches the owner's jetton wallets too.
- **Final** means the moving transaction is in a finalized masterchain block (TON needs no confirmation count) — and, for a native transfer whose message is shaped like a jetton message, that the trace is complete, since until then it may yet turn out to be part of a jetton transfer. A final transfer never changes or disappears on a later read.
- **Naming a transfer:** `(transaction.hash, direction, index)` is the same on every read and provider. `index` is a native SEND's position among its transaction's outgoing messages ordered by creation lt, and 0 for a receipt or a jetton transfer.
- **Catching up** after missed notifications: `getLastTransactionLt(account)` when watching starts, then `getAccountTransactions(account, { afterLt, limit })` and `getAccountTransfers` for each. `getTraceByTransaction(txHash)` returns the whole trace holding any transaction.
- TonAPI's free tier (1 RPS) is tight for reading traces: each shard block's masterchain block is one more request. Read through TON Center first, as `TonMainnet` does.

## Emulation, broadcast and status

- `emulate(boc)` emulates the external message's whole trace with the signature ignored, deploys and downstream hops included. It returns `success` and `problem` (judged as for the status below), `deliveries`, `fees` (every transaction's fees plus the forward fees its messages carried), the failed transactions and bounced messages, native TON balance changes and `jettonCredits`. A message the target would refuse outright throws `SimulationFailed`.
- `broadcast(boc)` returns the **normalized external-message hash** (TEP-467, lowercase hex), the transaction id on both providers.
- `getTransactionStatus(hash, { minMasterchainDepth })` reads the whole trace:
  - `Pending` until the trace is complete and every transaction is in a block a masterchain block references; there is no confirmation count, because TON's consensus is final at that point (`minMasterchainDepth`, 0 by default, asks for more);
  - `Failed` when the request did not do what it was signed for: the sending wallet's transaction (or, for a relayed request, the target wallet's) failed or skipped a message (`skipped_actions`), the target did not execute the request (`request_not_executed`), or a message those wallets sent `bounced` or reached a receiver that failed without sending it back (`receiver_failed`), or a jetton transfer's jettons were not sent on (`jetton_undelivered`);
  - `Success` otherwise, with the balance changes (TON, and jettons — below), `fees`, `jettonCredits`, the trace, `masterchainSeqno` and `masterchainDepth`.
- **Jetton balance changes** (status and `emulate`): each wallet-to-wallet jetton transfer the trace completed (TEP-74 `transfer` → `internal_transfer` accepted) moves its amount from the sending owner to the recipient, per owner, in the jetton's asset (`resolveAsset`), as Python reports them. A transfer counts only once its master vouches for both jetton wallets — the sender's is the master's wallet for its owner, the receiving one the master's wallet for the recipient the transfer named — so a contract posing as a jetton wallet moves nothing. Mints and burns are not counted. `jettonCredits` lists every accepted `internal_transfer` as the trace shows it, unchecked; a jetton wallet that accepted jettons but skipped a message after (an excess refund) still credits them.
- A bounceable message is `bounced` only when its receiver's transaction sent it back — a failed compute phase, including an address with no code yet, or a failed action with send mode +16. A receiver that aborted without sending it back (an action that failed without +16, or too little value left to pay for the bounce) makes it `failed`: the value stayed there or went on fees, and nothing returned. A jetton transfer is judged where the jettons land, in the receiver's jetton wallet (`jetton_bounced` / `jetton_receiver_failed` / `jetton_undelivered` when they do not).
- `summary.deliveries` lists every message the sending wallets sent, in the order each wallet sent them (the request's order), with its outcome (`delivered`, `bounced`, `failed`, `undelivered` — a jetton transfer only, never a gap in a complete trace — or `pending`). A message is matched to the transaction that received it by (source, `created_lt`), which names one message (the providers refuse a trace where the receiver's account or value disagrees); a failed status carries the deliveries too, so a caller can tell which messages arrived. A non-bounceable message is `delivered` even when its receiver then fails — the value stays there. Failures further down the trace (a recipient that throws on a jetton notification, a skipped excess refund) do not undo deliveries; they are in `failedTransactions` / `bouncedMessages` and do not fail the status.
- A transaction succeeds when its compute phase succeeded — or was skipped only because the account has no code yet, a plain transfer to an undeployed address — and its action phase, if any, succeeded without skipping a message. The phases are required: TON Center's `description` (`compute_ph`, its `success` / `exit_code`, `action`, `aborted`) is read strictly, and TonAPI's transactions are judged from their own BOC (`raw`), not its optional JSON phase fields. Missing phase data, or a compute phase that succeeded without an action phase, is a malformed reply — retryable, read from the other provider — never a success.
- `getTrace` and `getTransactionStatus` take the transaction id as 64 lowercase hex characters and refuse anything else (`InvalidArgument`). "No trace" is read only from the providers' explicit answers (TON Center's empty `traces` list, TonAPI's 404); any other reply throws.

### Provider differences

| | TON Center v3 | TonAPI |
|---|---|---|
| Finality | per transaction `mc_block_seqno` (+ `finality: finalized`) | serves committed blocks only |
| `masterchainSeqno` | the masterchain block that committed the shard block | the shard block's `master_ref`, which can be a few blocks earlier |

## Testing

- `npm test` runs the unit specs (`ton/test/*.spec.ts`, no network) and `ton_recorded.spec.ts`, which replays real mainnet replies from `ton/test/fixtures/mainnet_recordings.json` and checks the SDK reaches what it reached live: through `TonChain` (emulations, statuses — the relays, the failed and replayed relayed request, a bounced jetton transfer) and through each provider alone (TonAPI's emulation, its complete trace and its emulation of a message in flight, its replies for a never-used address, both providers' answers to a resent message and their USDT jetton wallet). Re-recording keeps scenarios a run did not record again.
- `npm run test:live:ton` runs `ton/test/live/ton_mainnet.live.ts` against mainnet. It reads `.env.ton.local` (git-ignored; template `.env.ton.example`): the provider keys, a **dedicated** test mnemonic, the fee payer's account index and a spend cap. It reads and emulates by default — the masterchain head on each provider, a relay emulated on both providers alike, a relay that deploys a fresh vault and the same relay without deploy, and `getRequestState` on a request never sent (`expired` past its time, `live` before it), whose seqno and `validUntil` a `TonSignedTransaction` reads back, TonAPI's replies for a never-used address, the fee payer's USDT jetton wallet alike on both providers and empty (AC5), and USDT resolved from its TEP-64 metadata (`USD₮`, 6 decimals, the content alike on both providers) with a transfer priced in its decimals. With `TON_LIVE_SEND=1` it broadcasts both relays, reads the sent trace alike from both providers, checks a landed request is `consumed`, resends a landed message to both providers (`NonceTooLow`, no second landing), and delivers a relayed request the vault cannot pay yet, then delivers the same request again (failed with the seqno unchanged and still `live`, then executed and `consumed`, its seqno and `validUntil` read back from the trace), checks the paid fees are within a fifth of the emulated ones, sends a USDT transfer to the fee payer's own jetton wallet, which has no code (`Failed`, `bounced`: AC6, no jettons needed), and runs every kind of wallet on its own requests — a fresh W5, v4r2 and v3r2 wallet at a path, and the no-path wallet (TON's own scheme, the Python SDK's account): funded by the fee payer, each deploys itself with its first request (when new) and sends part back, sends a USDT transfer to its own jetton wallet (bounced, AC6), refuses a resend of the landed request while it can pay (`NonceTooLow`), sends everything back, and refuses a resend once emptied (`BroadcastUncertain`). Masterchain (-1) wallets of each version are only emulated (funding one), for cost. It rewrites the recordings only with `TON_LIVE_RECORD=1`. The vault returns everything to the fee payer, so a run costs only fees. Recordings keep URLs, bodies and replies, never headers, so no key is written.

## Not covered

Testnet, wallet versions other than v3r2 / v4r2 / v5r1 (and Telegram Wallet's trampoline for `ton_proof`), W5 extensions, jetton mints and burns in balance changes, and off-chain metadata outside https.
