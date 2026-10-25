import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { type Cell, SendMode } from '@ton/core';
import { Decimal } from 'decimal.js';

import { CHAIN_ID_TON_MAINNET } from '../../../chain_ids.ts';
import { ChainErrorKinds } from '../../../errors.ts';
import { TransactionStatusTypes } from '../../../transaction_status.ts';
import { TON_CENTER_MAINNET_URL, TONAPI_MAINNET_URL, TonMainnet } from '../../ton_chains.ts';
import { TonChain, type TonEmulationResult } from '../../ton_chain.ts';
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

/** Retries a call that failed without an answer (a rate limit, an outage) — the free tiers are tight for a long run. */
async function retryingOutages<T>(call: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call();
    } catch (err) {
      if (attempt >= 4 || (err as { retryable?: boolean }).retryable !== true) throw err;
      await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt));
    }
  }
}

/** The provider's trace holding `txHash` once it is complete. */
async function completeTraceBy(provider: TonProvider, txHash: string): Promise<TonTrace> {
  const deadline = Date.now() + STATUS_TIMEOUT_MS;
  for (;;) {
    const trace = await provider.getTraceByTransaction(txHash);
    if (trace?.complete === true) return trace;
    if (Date.now() > deadline) throw new Error(`${provider.name}: no complete trace holding ${txHash} after ${STATUS_TIMEOUT_MS / 1000}s`);
    await new Promise((resolve) => setTimeout(resolve, STATUS_POLL_MS));
  }
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
    // Only a run that sends needs the fee payer funded.
    if (env.send && state.balance < ATTACHED * 2n + env.maxSpend) {
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
    // Read back as clydner will, from the vault's transaction: the fee payer sent ATTACHED and got the rest back.
    const vaultTx = status.trace?.transactions.find((tx) => tx.account === vault.address);
    const vaultSide = await chain.getAccountTransfers({ account: vault.address, txHash: vaultTx?.hash as string });
    expect(vaultSide?.settled).toBe(true);
    expect(vaultSide?.transfers.map(({ direction, amount, final }) => ({ direction, amount, final }))[0]).toEqual({ direction: 'RECEIVE', amount: ATTACHED, final: true });
    const feePayerSide = await chain.getAccountTransfers({ account: feePayer.address, txHash: vaultTx?.hash as string });
    expect(feePayerSide?.transfers.map(({ direction }) => direction)).toEqual(['SEND', 'RECEIVE']);
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
    // The vault does not exist, yet had a transaction (the bounce): both providers give its lt, not 0.
    const bouncedVault = status.trace?.transactions.find((tx) => tx.parent !== null && tx.account !== feePayer.address);
    const lts = await Promise.all(providers.map((p) => p.getLastTransactionLt(bouncedVault?.account as string)));
    expect(lts[0]).toBeGreaterThan(0n);
    expect(lts[1]).toBe(lts[0]);
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

  // Reading an account's transfers from a transaction, as clydner does from a TonAPI webhook.
  it('finds a trace from a transaction in its middle, alike on both providers, and lists transactions after a cursor', async () => {
    const lastLt = await chain.getLastTransactionLt(feePayer.address);
    expect(lastLt).toBeGreaterThan(0n);
    const [fromToncenter, fromTonapi] = await Promise.all(
      providers.map((p) => p.getAccountTransactions(feePayer.address, { afterLt: lastLt - 1_000_000_000n, limit: 5 })),
    );
    expect(fromToncenter.length).toBeGreaterThan(0);
    expect(fromTonapi.map(({ hash, lt }) => ({ hash, lt }))).toEqual(fromToncenter.map(({ hash, lt }) => ({ hash, lt })));
    expect([...fromToncenter.map((tx) => tx.lt)].sort((a, b) => (a < b ? -1 : 1))).toEqual(fromToncenter.map((tx) => tx.lt));
    // A never-used address, on both providers.
    const unused = `0:${randomBytes(32).toString('hex')}`;
    for (const provider of providers) await expect(provider.getLastTransactionLt(unused)).resolves.toBe(0n);

    // A transaction in the middle of a trace gives the whole trace, from its root, on both providers.
    const middle = fromToncenter[fromToncenter.length - 1].hash;
    const traces = await Promise.all(providers.map((p) => retryingOutages(() => completeTraceBy(p, middle))));
    expect(traces[0].transactions.map((tx) => tx.hash)).toContain(middle);
    expect(comparable(traces[1])).toEqual(comparable(traces[0]));
  });

  it("reads a recent USDT transfer's sides as a verified jetton SEND and RECEIVE, alike on both providers", async () => {
    const reply = (await (
      await fetch(`${TON_CENTER_MAINNET_URL}/api/v3/jetton/transfers?jetton_master=${USDT_MASTER}&limit=20&sort=desc`, {
        headers: { 'X-API-Key': process.env.TONCENTER_API_KEY ?? '' },
      })
    ).json()) as { jetton_transfers: Array<{ transaction_hash: string; transaction_aborted: boolean; amount: string }> };
    const recent = reply.jetton_transfers.find((t) => !t.transaction_aborted);
    if (recent === undefined) throw new Error('no recent USDT transfer');
    const txHash = Buffer.from(recent.transaction_hash, 'base64').toString('hex');
    const trace = await completeTraceBy(toncenter, txHash);
    const [jetton] = (await chain.getJettonTransfers(trace)).filter((t) => t.amount === BigInt(recent.amount));
    expect(jetton).toMatchObject({ jettonMaster: USDT_MASTER });
    const sent = await chain.accountTransfersOf(jetton.from, trace);
    const received = await chain.accountTransfersOf(jetton.to, trace);
    const usdt = (t: { asset: { kind: string } }) => t.asset.kind === 'jetton';
    expect(sent.transfers.filter(usdt).some((t) => t.direction === 'SEND' && t.amount === jetton.amount && t.to === jetton.to && t.final)).toBe(true);
    expect(received.transfers.filter(usdt).some((t) => t.direction === 'RECEIVE' && t.amount === jetton.amount && t.from === jetton.from && t.final)).toBe(true);
    console.log(`USDT transfer ${txHash}: ${Number(jetton.amount) / 1e6} USDT from ${jetton.from} to ${jetton.to}`);
    // The same through TonAPI alone.
    const onTonapi = new TonChain({ chainId: CHAIN_ID_TON_MAINNET, name: 'TON', explorerUrl: 'https://tonviewer.com', toncenter: { url: TON_CENTER_MAINNET_URL }, provider: tonapi });
    const fromTonapi = await retryingOutages(async () => onTonapi.accountTransfersOf(jetton.to, await completeTraceBy(tonapi, txHash)));
    expect(fromTonapi.transfers.filter(usdt).map(({ direction, amount, from }) => ({ direction, amount, from }))).toEqual(
      received.transfers.filter(usdt).map(({ direction, amount, from }) => ({ direction, amount, from })),
    );
  });

  // The masterchain prices gas, messages and cells about 150 times higher, so it is emulated only.
  it.each(['v5r1', 'v4r2', 'v3r2'] as const)("emulates funding a %s wallet on workchain -1", async (version) => {
    const wallet = TonWallet.fromMnemonic(env.mnemonic, { derivationPath: TonWallet.derivationPath({ account: env.feePayerAccount + 1 }), version, workchain: -1 });
    expect(wallet.address.startsWith('-1:')).toBe(true);
    const funding = await feePayer.signTransaction(
      await chain.createTransferUnsignedTransaction({ from: feePayer.address, to: wallet.addressUserFriendly({ bounceable: false }), amount: ATTACHED }),
      chain,
    );
    const emulated = await retryingOutages(() => chain.emulate(funding.boc));
    expect(emulated.success).toBe(true);
    expect(emulated.deliveries).toEqual([expect.objectContaining({ to: wallet.address, outcome: 'delivered' })]);
    console.log(`funding a ${version} masterchain wallet: fees ${Number(emulated.fees) / 1e9} TON`);
  });

  /** A fresh wallet of `version` at the first unused account index above the fee payer. */
  async function freshWallet(version: TonWalletVersion): Promise<TonWallet> {
    for (let account = env.feePayerAccount + 1; account < env.feePayerAccount + 50; account++) {
      const candidate = walletAt(account, version);
      if ((await chain.getAccountState(candidate.address)).status === 'nonexist') return candidate;
    }
    throw new Error(`no unused ${version} wallet within 50 accounts`);
  }

  const lifecycles: Array<[string, () => Promise<TonWallet>]> = [
    ['W5, fresh at a path', () => freshWallet('v5r1')],
    ['v4r2, fresh at a path', () => freshWallet('v4r2')],
    ['v3r2, fresh at a path', () => freshWallet('v3r2')],
    // TON's own scheme, the Python SDK's account: one per mnemonic, so it is fresh only on the first run.
    ['W5 with no path (the Python SDK scheme)', async () => TonWallet.fromMnemonic(env.mnemonic)],
  ];

  /*
   * Every kind of wallet, on mainnet, paying its own way: funded by the fee
   * payer, it deploys itself with its first request (when new) and sends part
   * back, sends a USDT transfer to its own jetton wallet (no code: bounced,
   * AC6), refuses a resend of the landed request while it can pay to run it
   * (seqno: NonceTooLow), sends everything back, and refuses a resend once
   * emptied (before execution: uncertain). Costs fees only.
   */
  (env.send ? it.each(lifecycles) : it.skip.each(lifecycles))('runs a %s wallet on its own requests', async (label, walletOf) => {
    const wallet = await walletOf();
    const name = `${wallet.version}_${label.includes('no path') ? 'native' : 'path'}`;
    const startSeqno = await chain.getSeqno(wallet.address);
    console.log(`${label}: ${wallet.addressUserFriendly({ bounceable: false })}, seqno ${startSeqno}`);
    const pay = (to: TonWallet): string => to.addressUserFriendly({ bounceable: false });

    // Funded to the non-bounceable form: the wallet may not be deployed yet.
    const funding = await feePayer.signTransaction(await chain.createTransferUnsignedTransaction({ from: feePayer.address, to: pay(wallet), amount: ATTACHED }), chain);
    await chain.broadcast(funding.boc);
    expect((await finalStatusRecorded(`${name}_funded`, `the fee payer funding a ${label} wallet`, funding.txHash)).status).toBe(TransactionStatusTypes.Success);

    // Its own request: deploys it when new, and sends part back.
    const partial = await wallet.signTransaction(
      await chain.createTransferUnsignedTransaction({ from: wallet.address, to: pay(feePayer), amount: ATTACHED / 5n }),
      chain,
    );
    expect(partial.seqno).toBe(startSeqno);
    expect((await chain.emulate(partial.boc)).success).toBe(true);
    await chain.broadcast(partial.boc);
    console.log(`sent ${partial.txHash} (${label}: ${startSeqno === 0 ? 'deploys and sends' : 'sends'} part back)`);
    expect((await finalStatusRecorded(`${name}_send`, `a ${label} wallet's own request`, partial.txHash)).status).toBe(TransactionStatusTypes.Success);
    expect((await chain.getAccountState(wallet.address)).status).toBe('active');
    expect(await chain.getSeqno(wallet.address)).toBe(startSeqno + 1);
    await expect(chain.getRequestState({ wallet: wallet.address, seqno: partial.seqno, validUntil: partial.validUntil, hash: partial.txHash })).resolves.toBe(
      'consumed',
    );

    // A USDT transfer to its own jetton wallet, which has no code: bounced (AC6).
    const jetton = await wallet.signTransaction(
      await chain.createTransferUnsignedTransaction({
        from: wallet.address,
        to: wallet.address,
        tokenIdentifier: USDT_MASTER,
        amount: 1n,
        jettonAttachedNanoton: ATTACHED / 5n,
      }),
      chain,
    );
    await chain.broadcast(jetton.boc);
    const bounced = await finalStatusRecorded(`${name}_jetton_bounced`, `a ${label} wallet's USDT transfer to a jetton wallet with no code`, jetton.txHash);
    expect(bounced.status).toBe(TransactionStatusTypes.Failed);
    expect(bounced.error?.code).toBe('bounced');

    // Resent while it can pay to run it: the seqno check refuses it.
    const resent = await toncenter.sendBoc(partial.boc).then(() => null, (e: unknown) => e);
    console.log(`${label} resend: ${(resent as Error | null)?.message.slice(0, 120) ?? 'accepted'}`);
    if (resent !== null) expect(resent).toMatchObject({ kind: ChainErrorKinds.NonceTooLow });

    // Everything back (send mode 128 + 2), leaving it empty.
    const sweep = await wallet.signTransaction(
      await chain.createTransferUnsignedTransaction({ from: wallet.address, to: pay(feePayer), isFullBalance: true }),
      chain,
    );
    expect(sweep.seqno).toBe(startSeqno + 2);
    await chain.broadcast(sweep.boc);
    expect((await finalStatusRecorded(`${name}_sweep`, `a ${label} wallet sending everything back`, sweep.txHash)).status).toBe(TransactionStatusTypes.Success);

    // An emptied wallet refuses even to run a resend: possibly landed, never definite.
    const toEmpty = await toncenter.sendBoc(sweep.boc).then(() => null, (e: unknown) => e);
    console.log(`${label} resend to the emptied wallet: ${(toEmpty as Error | null)?.message.slice(0, 120) ?? 'accepted'}`);
    if (toEmpty !== null) expect(toEmpty).toBeInstanceOf(TonBroadcastUncertainError);
    expect(await chain.getSeqno(wallet.address)).toBe(startSeqno + 3);
  });

  (env.send ? it : it.skip)('spent no more than the cap', async () => {
    const spent = startBalance - (await chain.getAccountState(feePayer.address)).balance;
    console.log(`spent ${Number(spent) / 1e9} TON`);
    expect(spent).toBeLessThan(env.maxSpend);
  });
});
