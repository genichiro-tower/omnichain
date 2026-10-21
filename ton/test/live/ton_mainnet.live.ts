import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { SendMode } from '@ton/core';

import { TransactionStatusTypes } from '../../../transaction_status.ts';
import { TonMainnet } from '../../ton_chains.ts';
import type { TonEmulationResult } from '../../ton_chain.ts';
import { tonRelayMessage } from '../../ton_messages.ts';
import type { TonTransactionStatus } from '../../ton_transaction_status.ts';
import { TonWallet } from '../../ton_wallet.ts';
import { FetchRecorder, type RecordedScenario, type Recordings, writeRecordings } from '../ton_recordings.ts';

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
  ['TON_LIVE_MNEMONIC', env.mnemonic],
].flatMap(([name, value]) => (value === undefined || value === '' ? [name] : []));
if (missing.length > 0) {
  throw new Error(`Set ${missing.join(', ')} in .env.ton.local (see .env.ton.example)`);
}

const chain = TonMainnet;
const walletAt = (account: number): TonWallet =>
  TonWallet.fromMnemonic(env.mnemonic, { derivationPath: TonWallet.derivationPath({ account }) });
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

/** The fee payer's external request relaying `vault`'s request to send everything it holds back. */
async function relayBoc(vault: TonWallet, deploy: boolean): Promise<{ boc: string; hash: string }> {
  const validUntil = Math.floor(Date.now() / 1000) + VALID_FOR_SECONDS;
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
    const { boc } = await relayBoc(vault, true);
    const emulated = await chain.emulate(boc);
    expect(emulated.success).toBe(true);
    expect(emulated.fees).toBeLessThan(env.maxSpend);
    const hash = await chain.broadcast(boc);
    console.log(`sent ${hash}`);
    const status = await finalStatusRecorded('relay_deploy_sent', 'the deploy relay, sent and final', hash);
    expect(status.status).toBe(TransactionStatusTypes.Success);
    expect((await chain.getAccountState(vault.address)).status).toBe('active');
    expect(await chain.getSeqno(vault.address)).toBe(1);
    expect(status.fees).toBeLessThan(env.maxSpend);
  });

  (env.send ? it : it.skip)('sends a relay without deploy and reads it Failed', async () => {
    const { wallet: vault } = await freshVault(env.feePayerAccount);
    const { boc } = await relayBoc(vault, false);
    const hash = await chain.broadcast(boc);
    console.log(`sent ${hash}`);
    const status = await finalStatusRecorded('relay_without_deploy_sent', 'a relay without deploy, sent; bounced back to the fee payer', hash);
    expect(status.status).toBe(TransactionStatusTypes.Failed);
  });

  (env.send ? it : it.skip)('spent no more than the cap', async () => {
    const spent = startBalance - (await chain.getAccountState(feePayer.address)).balance;
    console.log(`spent ${Number(spent) / 1e9} TON`);
    expect(spent).toBeLessThan(env.maxSpend);
  });
});
