import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { type Cell, SendMode } from '@ton/core';
import { Decimal } from 'decimal.js';

import { CHAIN_ID_TON_MAINNET } from '../../../chain_ids.ts';
import { ChainErrorKinds } from '../../../errors.ts';
import { TransactionStatusTypes } from '../../../transaction_status.ts';
import { TON_CENTER_MAINNET_URL, TONAPI_MAINNET_URL, TonMainnet } from '../../ton_chains.ts';
import type { TonEmulationResult } from '../../ton_chain.ts';
import { tonInternalRequestOf, tonRelayMessage } from '../../ton_messages.ts';
import { TonSignedTransaction } from '../../ton_transactions.ts';
import { TonBroadcastUncertainError, type TonProvider, type TonTrace, type TonTraceTransaction } from '../../ton_provider.ts';
import { ToncenterProvider } from '../../ton_toncenter.ts';
import { TonapiProvider } from '../../ton_tonapi.ts';
import { type TonTransactionStatus, summarizeTonTrace } from '../../ton_transaction_status.ts';
import { TonWallet } from '../../ton_wallet.ts';
import type { TonWalletVersion } from '../../ton_messages.ts';
import {
  FetchRecorder,
  type RecordedProviderMethod,
  type RecordedScenario,
  type Recordings,
  describeResult,
  writeRecordings,
} from '../ton_recordings.ts';
import { USDT_MASTER } from '../ton_test_helpers.ts';
import { tonUserFriendlyAddress } from '../../ton_address.ts';
import { TON_USDT } from '../../ton_assets.ts';

/**
 * TON mainnet, for real: `npm run test:live:ton`. Never run by `npm test`.
 *
 * Reads keys and a dedicated test mnemonic from `.env.ton.local` (see
 * `.env.ton.example`). By default it only reads and emulates. `TON_LIVE_SEND=1`
 * broadcasts, and `TON_LIVE_RECORD=1` rewrites `fixtures/mainnet_recordings.json`.
 *
 * The fee payer relays a request to a fresh, undeployed vault index; the vault
 * returns everything it holds to the fee payer (send mode 128), so a run costs
 * only fees.
 */

// Jest gives each test file its own copy of process.env, which
// process.loadEnvFile would not reach, so the file is parsed into this copy.
const ENV_FILE = new URL('../../../.env.ton.local', import.meta.url);
if (existsSync(ENV_FILE)) {
  for (const [name, value] of Object.entries(parseEnv(readFileSync(ENV_FILE, 'utf8')))) {
    process.env[name] ??= value;
  }
}

const NANO = 1_000_000_000n;
const ATTACHED = 50_000_000n; // TON the relay carries; the vault sends all of it back
const VALID_FOR_SECONDS = 300;
const STATUS_TIMEOUT_MS = 180_000;
const STATUS_POLL_MS = 5_000;

const env = {
  mnemonic: process.env.TON_LIVE_MNEMONIC ?? '',
  feePayerAccount: Number(process.env.TON_LIVE_FEE_PAYER_ACCOUNT ?? '0'),
  maxSpend: BigInt(process.env.TON_LIVE_MAX_SPEND_NANO ?? String(NANO / 10n)),
  send: process.env.TON_LIVE_SEND === '1',
  record: process.env.TON_LIVE_RECORD === '1',
};

const missing = [
  ['TONCENTER_API_KEY', process.env.TONCENTER_API_KEY],
  ['TONAPI_API_KEY', process.env.TONAPI_API_KEY],
  ['TON_LIVE_MNEMONIC', env.mnemonic],
].flatMap(([name, value]) => (value === undefined || value === '' ? [name] : []));
if (missing.length > 0) {
  throw new Error(`Set ${missing.join(', ')} in .env.ton.local (see .env.ton.example)`);
}

const chain = TonMainnet;
// Each provider on its own, to check them against each other.
const toncenter = new ToncenterProvider({ url: TON_CENTER_MAINNET_URL, apiKey: process.env.TONCENTER_API_KEY ?? '' });
const tonapi = new TonapiProvider({ url: TONAPI_MAINNET_URL, apiKey: process.env.TONAPI_API_KEY ?? '' });
const providers: TonProvider[] = [toncenter, tonapi];
const walletAt = (account: number, version: TonWalletVersion = 'v5r1'): TonWallet =>
  TonWallet.fromMnemonic(env.mnemonic, { derivationPath: TonWallet.derivationPath({ account }), version });
const feePayer = walletAt(env.feePayerAccount);
const recorder = new FetchRecorder();
const scenarios: Record<string, RecordedScenario> = {};

/** The first account index above the fee payer that has never been used on chain. */
async function freshVault(after: number): Promise<{ wallet: TonWallet; account: number }> {
  for (let account = after + 1; account < after + 50; account++) {
    const wallet = walletAt(account);
    if ((await chain.getAccountState(wallet.address)).status === 'nonexist') return { wallet, account };
  }
  throw new Error(`no unused vault index within 50 of ${after}`);
}

interface SentRequest {
  boc: string;
  hash: string;
  seqno: number;
  validUntil: number;
}

/** The fee payer's external request relaying `vault`'s request to send everything it holds back. */
async function relayBoc(vault: TonWallet, deploy: boolean, validUntil = Math.floor(Date.now() / 1000) + VALID_FOR_SECONDS): Promise<SentRequest> {
  const request = vault.createInternalRequest({
    seqno: 0,
    validUntil,
    messages: [{ to: feePayer.address, value: 0n, bounce: false, mode: SendMode.CARRY_ALL_REMAINING_BALANCE }],
  });
  const state = await chain.getAccountState(feePayer.address);
  const seqno = await chain.getSeqno(feePayer.address);
  return feePayer.createExternalRequest({
    seqno,
    validUntil,
    deploy: state.status !== 'active',
    messages: [tonRelayMessage({ wallet: vault, request, value: ATTACHED, deploy })],
  });
}

/** A trace without what legitimately differs between providers: the masterchain block and body cell identity. */
function comparable(trace: TonTrace): unknown {
  return trace.transactions.map(({ mcSeqno: _mc, inMsg, outMsgs, ...rest }: TonTraceTransaction) => ({
    ...rest,
    inMsg: inMsg === null ? null : { ...inMsg, body: inMsg.body?.hash().toString('hex') ?? null },
    outMsgs: outMsgs.map((m) => ({ ...m, body: m.body?.hash().toString('hex') ?? null })),
  }));
}

/** The provider's trace of `hash` once it is complete; TonAPI can trail TON Center. */
async function completeTrace(provider: TonProvider, hash: string): Promise<TonTrace> {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  for (;;) {
    const trace = await provider.getTrace(hash);
    if (trace?.complete === true) return trace;
    if (Date.now() > deadline) throw new Error(`${provider.name}: no complete trace of ${hash} after ${STATUS_TIMEOUT_MS / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
}

/**
 * Calls one provider directly and records the replies, so `npm test` replays
 * them through that provider's parsing (TonAPI's included, which the chain
 * reaches only on a fallback).
 */
async function providerRecorded(
  name: string,
  description: string,
  provider: ToncenterProvider | TonapiProvider,
  method: RecordedProviderMethod,
  ...args: string[]
): Promise<unknown> {
  recorder.take();
  const call = provider[method] as (...a: string[]) => Promise<unknown>;
  const outcome = await call.apply(provider, args).then(
    (result) => ({ result }),
    (err: unknown) => ({ err }),
  );
  scenarios[name] = {
    description,
    input: { provider: provider.name as 'TON Center' | 'TonAPI', method, args },
    calls: recorder.take(),
    expect: 'err' in outcome ? { errorKind: (outcome.err as { kind?: string }).kind ?? String(outcome.err) } : { result: describeResult(outcome.result) },
  };
  if ('err' in outcome) throw outcome.err;
  return outcome.result;
}

async function emulateRecorded(name: string, description: string, boc: string): Promise<TonEmulationResult> {
  recorder.take();
  const result = await chain.emulate(boc);
  scenarios[name] = {
    description,
    input: { boc },
    calls: recorder.take(),
    expect: {
      success: result.success,
      errorCode: result.problem?.code ?? null,
      deliveryOutcomes: result.deliveries.map((d) => d.outcome),
    },
  };
  return result;
}

async function finalStatusRecorded(name: string, description: string, hash: string): Promise<TonTransactionStatus> {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  for (;;) {
    recorder.take();
    const status = await chain.getTransactionStatus(hash);
    if (status.status !== TransactionStatusTypes.Pending) {
      scenarios[name] = {
        description,
        input: { hash },
        calls: recorder.take(),
        expect: {
          status: status.status,
          errorCode: status.error?.code ?? null,
          deliveryOutcomes: status.summary?.deliveries.map((d) => d.outcome) ?? [],
        },
      };
      return status;
    }
    if (Date.now() > deadline) throw new Error(`${hash} still pending after ${STATUS_TIMEOUT_MS / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
}

describe('TON mainnet (live)', () => {
  let startBalance: bigint;
  let sent: SentRequest | null = null;
  let deployedVault: TonWallet | null = null;

  beforeAll(async () => {
    recorder.install();
    const state = await chain.getAccountState(feePayer.address);
    startBalance = state.balance;
    console.log(
      `fee payer ${feePayer.addressUserFriendly({ bounceable: false })} (m/44'/607'/${env.feePayerAccount}'): ` +
        `${state.status}, ${Number(state.balance) / 1e9} TON`,
    );
    if (state.balance < ATTACHED * 2n + env.maxSpend) {
      throw new Error(`Fund the fee payer ${feePayer.addressUserFriendly({ bounceable: false })} with at least 0.5 TON`);
    }
  });

  afterAll(() => {
    recorder.uninstall();
    if (env.record && Object.keys(scenarios).length > 0) {
      const recordings: Recordings = { recordedAt: new Date().toISOString(), feePayer: feePayer.address, scenarios };
      writeRecordings(recordings);
      console.log(`wrote ${Object.keys(scenarios).length} scenarios to fixtures/mainnet_recordings.json`);
    }
  });

  it('reads the chain through the providers', async () => {
    expect(await chain.getChainTipHeight()).toBeGreaterThan(0);
    expect(await chain.getSeqno(feePayer.address)).toBeGreaterThanOrEqual(0);
  });

  it.each(providers.map((p) => [p.name, p] as const))("reads the masterchain head's seqno and time from %s", async (_name, provider) => {
    const head = await provider.getMasterchainHead();
    expect(head.seqno).toBeGreaterThan(0);
    expect(Math.abs(head.utime - Date.now() / 1000)).toBeLessThan(120);
  });

  it('emulates a relay the same on both providers', async () => {
    const { wallet: vault } = await freshVault(env.feePayerAccount);
    const { boc } = await relayBoc(vault, true);
    const fromToncenter = await toncenter.emulate(boc);
    const fromTonapi = (await providerRecorded('tonapi_emulate_relay', 'TonAPI emulating a relay that deploys a fresh vault', tonapi, 'emulate', boc)) as TonTrace;
    const judged = (trace: TonTrace): unknown => {
      const summary = summarizeTonTrace(CHAIN_ID_TON_MAINNET, trace);
      return { success: summary.success, deliveries: summary.deliveries.map((d) => d.outcome) };
    };
    expect(judged(fromTonapi)).toEqual(judged(fromToncenter));
    expect(fromTonapi.transactions.map((tx) => tx.account)).toEqual(fromToncenter.transactions.map((tx) => tx.account));
  });

  it('calls a request that was never sent expired once the chain is past its validUntil, and live before', async () => {
    const head = await toncenter.getMasterchainHead();
    const { wallet: vault } = await freshVault(env.feePayerAccount);
    const stale = await relayBoc(vault, true, head.utime - 120);
    await expect(chain.getRequestState({ wallet: feePayer.address, ...stale })).resolves.toBe('expired');
    const fresh = await relayBoc(vault, true);
    await expect(chain.getRequestState({ wallet: feePayer.address, ...fresh })).resolves.toBe('live');
    // A signed transaction carries what the check needs, read from the signed body.
    const signed = new TonSignedTransaction({ chainId: chain.chainId, boc: fresh.boc });
    expect(signed).toMatchObject({ walletAddress: feePayer.address, seqno: fresh.seqno, validUntil: fresh.validUntil, txHash: fresh.hash });
  });

  it('reads a never-used address on TonAPI: nonexist, seqno 0, no jettons', async () => {
    const { wallet: vault } = await freshVault(env.feePayerAccount);
    await expect(providerRecorded('tonapi_account_nonexist', 'TonAPI account state of a never-used address', tonapi, 'getAccountState', vault.address)).resolves.toMatchObject({
      status: 'nonexist',
      balance: 0n,
    });
    await expect(providerRecorded('tonapi_seqno_undeployed', 'TonAPI seqno of a never-used address', tonapi, 'getSeqno', vault.address)).resolves.toBe(0);
    await expect(
      providerRecorded('tonapi_jetton_balance_undeployed', 'TonAPI jetton balance of a never-used address (404, confirmed by the account state)', tonapi, 'getJettonBalance', vault.address),
    ).resolves.toBe(0n);
  });

  it("finds the fee payer's USDT jetton wallet alike on both providers, empty while undeployed (AC5)", async () => {
    const fromToncenter = await providerRecorded('toncenter_usdt_jetton_wallet', "TON Center: the fee payer's USDT jetton wallet from the master's get-method", toncenter, 'getJettonWalletAddress', USDT_MASTER, feePayer.address);
    const fromTonapi = await providerRecorded('tonapi_usdt_jetton_wallet', "TonAPI: the fee payer's USDT jetton wallet from the master's get-method", tonapi, 'getJettonWalletAddress', USDT_MASTER, feePayer.address);
    expect(fromTonapi).toBe(fromToncenter);
    expect(await chain.getJettonWalletAddress(USDT_MASTER, feePayer.address)).toBe(fromToncenter);
    expect((await chain.getAccountState(fromToncenter as string)).status).toBe('nonexist');
    expect(await chain.getBalance(feePayer.address, USDT_MASTER)).toBe(0n);
  });

  it("resolves USDT from its TEP-64 metadata, alike on both providers, and prices a transfer in its decimals", async () => {
    const usdt = await chain.resolveAsset(tonUserFriendlyAddress(USDT_MASTER, { bounceable: true }));
    expect(usdt).toMatchObject({ symbol: TON_USDT.symbol, decimals: TON_USDT.decimals, jettonMaster: USDT_MASTER });
    const [fromToncenter, fromTonapi] = await Promise.all(providers.map((p) => p.getJettonContent(USDT_MASTER)));
    expect(fromTonapi.hash().equals(fromToncenter.hash())).toBe(true);
    const transfer = await chain.createTransferUnsignedTransaction({ from: feePayer.address, to: feePayer.address, tokenIdentifier: USDT_MASTER, amountHr: new Decimal('0.25') });
    const body = (transfer.messages[0].body as Cell).beginParse();
    body.skip(32 + 64);
    expect(body.loadCoins()).toBe(250_000n);
    expect(chain.getAssetExplorerUrl(usdt)).toBe(`${chain.explorerBaseUrl}/${tonUserFriendlyAddress(USDT_MASTER, { bounceable: true })}`);
  });

  it('emulates a relay that deploys a fresh vault (AC3)', async () => {
    const { wallet: vault } = await freshVault(env.feePayerAccount);
    const { boc } = await relayBoc(vault, true);
    const result = await emulateRecorded('relay_deploy_emulation', 'fee payer relays to an undeployed vault with deploy; the vault returns all to the fee payer', boc);
    expect(result.success).toBe(true);
    expect(result.deliveries.map((d) => d.outcome)).toEqual(['delivered', 'delivered']);
    expect(result.fees).toBeLessThan(env.maxSpend);
    console.log(`emulated fees ${Number(result.fees) / 1e9} TON`);
  });

  it('emulates the same relay without deploy as failed (AC3)', async () => {
    const { wallet: vault } = await freshVault(env.feePayerAccount);
    const { boc } = await relayBoc(vault, false);
    const result = await emulateRecorded('relay_without_deploy_emulation', 'the same relay without deploy, to an undeployed vault', boc);
    expect(result.success).toBe(false);
  });

  (env.send ? it : it.skip)('sends the deploy relay and reads it final (AC4)', async () => {
    const { wallet: vault } = await freshVault(env.feePayerAccount);
    const request = await relayBoc(vault, true);
    const { boc } = request;
    const emulated = await chain.emulate(boc);
    expect(emulated.success).toBe(true);
    expect(emulated.fees).toBeLessThan(env.maxSpend);
    const hash = await chain.broadcast(boc);
    expect(hash).toBe(request.hash);
    sent = request;
    deployedVault = vault;
    console.log(`sent ${hash}`);
    // Just sent, TonAPI may answer with its emulation of the message in flight: never a trace.
    recorder.take();
    const inFlight = await tonapi.getTrace(hash);
    const calls = recorder.take();
    if (calls.some((call) => call.response.includes('"emulated":true'))) {
      expect(inFlight).toBeNull();
      scenarios.tonapi_trace_in_flight = {
        description: 'TonAPI answering a trace request for a message in flight with its emulation',
        input: { provider: 'TonAPI', method: 'getTrace', args: [hash] },
        calls,
        expect: { result: describeResult(null) },
      };
      console.log('TonAPI answered with an emulation of the message in flight');
    }
    const status = await finalStatusRecorded('relay_deploy_sent', 'the deploy relay, sent and final', hash);
    expect(status.status).toBe(TransactionStatusTypes.Success);
    expect((await chain.getAccountState(vault.address)).status).toBe('active');
    expect(await chain.getSeqno(vault.address)).toBe(1);
    expect(status.fees).toBeLessThan(env.maxSpend);
    // The emulation priced it: within a fifth of what it cost.
    const paid = status.fees as bigint;
    const gap = paid > emulated.fees ? paid - emulated.fees : emulated.fees - paid;
    console.log(`fees: emulated ${Number(emulated.fees) / 1e9} TON, paid ${Number(paid) / 1e9} TON`);
    expect(gap * 5n).toBeLessThanOrEqual(emulated.fees);
  });

  (env.send ? it : it.skip)('reads the sent trace the same from both providers', async () => {
    if (sent === null) throw new Error('the deploy relay was not sent');
    const hash = sent.hash;
    const [fromToncenter] = await Promise.all([completeTrace(toncenter, hash), completeTrace(tonapi, hash)]);
    const fromTonapi = (await providerRecorded('tonapi_trace_sent', 'TonAPI trace of the sent deploy relay, complete', tonapi, 'getTrace', hash)) as TonTrace;
    expect(comparable(fromTonapi)).toEqual(comparable(fromToncenter));
  });

  (env.send ? it : it.skip)('calls a request that landed consumed', async () => {
    if (sent === null) throw new Error('the deploy relay was not sent');
    await expect(chain.getRequestState({ wallet: feePayer.address, ...sent })).resolves.toBe('consumed');
  });

  // A provider answers a resend of a landed message with W5's seqno refusal
  // (NonceTooLow: check the status, never a plain rejection), or accepts it
  // (a duplicate, or a lite server behind the message); either way the
  // wallet's seqno keeps it from landing again.
  (env.send ? it : it.skip)('answers a resent message as possibly landed on both providers, and does not land it twice', async () => {
    if (sent === null) throw new Error('the deploy relay was not sent');
    const seqno = await chain.getSeqno(feePayer.address);
    expect(seqno).toBe(sent.seqno + 1);
    const resend = sent.boc;
    for (const provider of providers) {
      // A retryable reply is an outage, not an answer; ask again.
      let err: unknown = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        err = await providerRecorded(
          `${provider === tonapi ? 'tonapi' : 'toncenter'}_resend_landed`,
          `${provider.name} answering a resend of a message that landed`,
          provider as ToncenterProvider | TonapiProvider,
          'sendBoc',
          resend,
        ).then(() => null, (e: unknown) => e);
        console.log(`${provider.name} on a resend: ${(err as Error | null)?.message ?? 'accepted'}`);
        if (!(err as { retryable?: boolean } | null)?.retryable) break;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      if (err !== null) expect(err).toMatchObject({ kind: ChainErrorKinds.NonceTooLow, retryable: false });
    }
    await new Promise((resolve) => setTimeout(resolve, 15_000));
    expect(await chain.getSeqno(feePayer.address)).toBe(seqno);
  });

  // W5 keeps an internal request's seqno only when the transaction succeeds:
  // a relayed request that failed stays valid, and executes when delivered
  // again. Only chain time past validUntil, or a moved seqno, ends it.
  (env.send ? it : it.skip)('keeps a failed relayed request valid, and it executes when delivered again', async () => {
    if (deployedVault === null) throw new Error('the deploy relay was not sent');
    const vault = deployedVault;
    const seqno = await chain.getSeqno(vault.address);
    const validUntil = Math.floor(Date.now() / 1000) + VALID_FOR_SECONDS;
    // More than one relay carries, so the first delivery cannot pay it; everything left returns after.
    const request = vault.createInternalRequest({
      seqno,
      validUntil,
      messages: [
        { to: feePayer.address, value: ATTACHED + ATTACHED / 2n, bounce: false, mode: SendMode.PAY_GAS_SEPARATELY },
        { to: feePayer.address, value: 0n, bounce: false, mode: SendMode.CARRY_ALL_REMAINING_BALANCE },
      ],
    });
    const deliver = async (name: string, description: string): Promise<TonTransactionStatus> => {
      const relay = feePayer.createExternalRequest({
        seqno: await chain.getSeqno(feePayer.address),
        validUntil,
        messages: [tonRelayMessage({ wallet: vault, request, value: ATTACHED, deploy: false })],
      });
      await chain.broadcast(relay.boc);
      console.log(`sent ${relay.hash} (${name})`);
      return finalStatusRecorded(name, description, relay.hash);
    };

    const failed = await deliver('relayed_request_failed', 'a relayed request the vault cannot pay yet; aborted without a bounce');
    expect(failed.status).toBe(TransactionStatusTypes.Failed);
    // The relay is bounceable, but an action-phase failure without +16 sends nothing back.
    expect(failed.summary?.deliveries[0].outcome).toBe('failed');
    expect(await chain.getSeqno(vault.address)).toBe(seqno);
    // Failed, yet still live: anyone can deliver it again.
    await expect(chain.getRequestState({ wallet: vault.address, seqno, validUntil })).resolves.toBe('live');

    const replayed = await deliver('relayed_request_replayed', 'the same signed request delivered again, now payable');
    expect(replayed.status).toBe(TransactionStatusTypes.Success);
    expect(await chain.getSeqno(vault.address)).toBe(seqno + 1);
    await expect(chain.getRequestState({ wallet: vault.address, seqno, validUntil })).resolves.toBe('consumed');
    // What the relayed request committed to can be read back from the trace's relay message.
    const relayed = replayed.trace?.transactions.find((tx) => tx.account === vault.address)?.inMsg?.body;
    expect(relayed === undefined || relayed === null ? null : tonInternalRequestOf(relayed)).toMatchObject({ seqno, validUntil });
  });

  (env.send ? it : it.skip)('sends a relay without deploy and reads it Failed', async () => {
    const { wallet: vault } = await freshVault(env.feePayerAccount);
    const { boc } = await relayBoc(vault, false);
    const hash = await chain.broadcast(boc);
    console.log(`sent ${hash}`);
    const status = await finalStatusRecorded('relay_without_deploy_sent', 'a relay without deploy, sent; bounced back to the fee payer', hash);
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    // The undeployed vault's compute phase was skipped, so TON sent the value back.
    expect(status.summary?.deliveries.map((d) => d.outcome)).toEqual(['bounced']);
  });

  (env.send ? it : it.skip)('reads a jetton transfer to a jetton wallet with no code as Failed, bounced (AC6)', async () => {
    // The fee payer's own USDT jetton wallet is not deployed: the transfer bounces, no jettons needed.
    const transfer = await chain.createTransferUnsignedTransaction({ from: feePayer.address, to: feePayer.address, tokenIdentifier: USDT_MASTER, amount: 1n });
    const signed = await feePayer.signTransaction(transfer, chain);
    const emulated = await chain.emulate(signed.boc);
    expect(emulated.problem?.code).toBe('bounced');
    const hash = await chain.broadcast(signed.boc);
    console.log(`sent ${hash} (jetton transfer to a jetton wallet with no code)`);
    const status = await finalStatusRecorded('jetton_transfer_bounced', 'a USDT transfer from a wallet whose jetton wallet has no code; bounced', hash);
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.error?.code).toBe('bounced');
    expect(status.summary?.deliveries.map((d) => d.outcome)).toEqual(['bounced']);
  });

  // v4r2 and v3r2 pay for their own requests; only W5 takes relayed ones.
  it.each(['v4r2', 'v3r2'] as const)('refuses to sign a relayed request on %s', (version) => {
    expect(() => walletAt(env.feePayerAccount + 1, version).createInternalRequest({ seqno: 0, messages: [{ to: feePayer.address, value: 1n }] })).toThrow(/W5/);
  });

  (env.send ? it.each(['v4r2', 'v3r2'] as const) : it.skip.each(['v4r2', 'v3r2'] as const))(
    'deploys a %s wallet that sends everything back, and refuses a resend',
    async (version) => {
      let wallet: TonWallet | null = null;
      for (let account = env.feePayerAccount + 1; account < env.feePayerAccount + 50 && wallet === null; account++) {
        const candidate = walletAt(account, version);
        if ((await chain.getAccountState(candidate.address)).status === 'nonexist') wallet = candidate;
      }
      if (wallet === null) throw new Error(`no unused ${version} wallet within 50 accounts`);
      // Funded from the fee payer, to the non-bounceable form: the wallet is not deployed yet.
      const fund = await chain.createTransferUnsignedTransaction({ from: feePayer.address, to: wallet.addressUserFriendly({ bounceable: false }), amount: ATTACHED });
      const funding = await feePayer.signTransaction(fund, chain);
      await chain.broadcast(funding.boc);
      expect((await finalStatusRecorded(`${version}_funded`, `the fee payer funding a fresh ${version} wallet`, funding.txHash)).status).toBe(
        TransactionStatusTypes.Success,
      );
      // The wallet deploys itself and sends part back, keeping enough to run a resend.
      const partial = await chain.createTransferUnsignedTransaction({ from: wallet.address, to: feePayer.addressUserFriendly({ bounceable: false }), amount: ATTACHED / 2n });
      const signed = await wallet.signTransaction(partial, chain);
      expect(signed.seqno).toBe(0);
      expect((await chain.emulate(signed.boc)).success).toBe(true);
      await chain.broadcast(signed.boc);
      console.log(`sent ${signed.txHash} (${version} deploys and sends half back)`);
      const status = await finalStatusRecorded(`${version}_deploy_send`, `a fresh ${version} wallet deploying itself and sending half back`, signed.txHash);
      expect(status.status).toBe(TransactionStatusTypes.Success);
      expect((await chain.getAccountState(wallet.address)).status).toBe('active');
      expect(await chain.getSeqno(wallet.address)).toBe(1);
      await expect(chain.getRequestState({ wallet: wallet.address, seqno: signed.seqno, validUntil: signed.validUntil, hash: signed.txHash })).resolves.toBe(
        'consumed',
      );
      // Resent while the wallet can pay to run it: the v3r2 / v4r2 seqno check (33) refuses it.
      const resent = await toncenter.sendBoc(signed.boc).then(() => null, (e: unknown) => e);
      console.log(`${version} resend: ${(resent as Error | null)?.message.slice(0, 200) ?? 'accepted'}`);
      if (resent !== null) expect(resent).toMatchObject({ kind: ChainErrorKinds.NonceTooLow });
      expect(await chain.getSeqno(wallet.address)).toBe(1);

      // Then everything back (send mode 128 + 2), leaving the wallet empty.
      const sweep = await wallet.signTransaction(
        await chain.createTransferUnsignedTransaction({ from: wallet.address, to: feePayer.addressUserFriendly({ bounceable: false }), isFullBalance: true }),
        chain,
      );
      expect(sweep.seqno).toBe(1);
      await chain.broadcast(sweep.boc);
      expect((await finalStatusRecorded(`${version}_sweep`, `the ${version} wallet sending everything back`, sweep.txHash)).status).toBe(
        TransactionStatusTypes.Success,
      );
      // An emptied wallet refuses to even run a resend: possibly landed, never definite.
      const toEmpty = await toncenter.sendBoc(sweep.boc).then(() => null, (e: unknown) => e);
      console.log(`${version} resend to the emptied wallet: ${(toEmpty as Error | null)?.message.slice(0, 200) ?? 'accepted'}`);
      if (toEmpty !== null) expect(toEmpty).toBeInstanceOf(TonBroadcastUncertainError);
      expect(await chain.getSeqno(wallet.address)).toBe(2);
    },
  );

  (env.send ? it : it.skip)('spent no more than the cap', async () => {
    const spent = startBalance - (await chain.getAccountState(feePayer.address)).balance;
    console.log(`spent ${Number(spent) / 1e9} TON`);
    expect(spent).toBeLessThan(env.maxSpend);
  });
});
