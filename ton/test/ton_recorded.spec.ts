import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { TonChain } from '../ton_chain.ts';
import { TON_CENTER_MAINNET_URL, TONAPI_MAINNET_URL } from '../ton_chains.ts';
import type { TonProvider } from '../ton_provider.ts';
import { ToncenterProvider } from '../ton_toncenter.ts';
import { TonapiProvider } from '../ton_tonapi.ts';
import { type RecordedProviderMethod, type RecordedScenario, describeResult, readRecordings, replayFetch } from './ton_recordings.ts';

/**
 * Replays the mainnet recordings the live suite wrote, through the real
 * providers' parsing: the SDK must reach the same verdicts it reached live.
 */
const recordings = readRecordings();

const chain = new TonChain({
  chainId: CHAIN_ID_TON_MAINNET,
  name: 'TON Mainnet',
  explorerUrl: 'https://tonviewer.com',
  toncenter: { url: TON_CENTER_MAINNET_URL, apiKey: 'replay' },
  tonapi: { url: TONAPI_MAINNET_URL, apiKey: 'replay' },
});

const providers: Record<string, TonProvider> = {
  'TON Center': new ToncenterProvider({ url: TON_CENTER_MAINNET_URL, apiKey: 'replay' }),
  TonAPI: new TonapiProvider({ url: TONAPI_MAINNET_URL, apiKey: 'replay' }),
};

async function replay(scenario: RecordedScenario): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = replayFetch(scenario.calls);
  try {
    if (scenario.input.provider !== undefined) {
      const provider = providers[scenario.input.provider];
      const call = provider[scenario.input.method as RecordedProviderMethod] as (...args: string[]) => Promise<unknown>;
      const outcome = await call.apply(provider, scenario.input.args ?? []).then(
        (result) => ({ result: describeResult(result) }),
        (err: unknown) => ({ errorKind: (err as { kind?: string }).kind ?? String(err) }),
      );
      expect(outcome).toEqual(
        scenario.expect.errorKind === undefined ? { result: scenario.expect.result } : { errorKind: scenario.expect.errorKind },
      );
    } else if (scenario.input.boc !== undefined) {
      const result = await chain.emulate(scenario.input.boc);
      expect(result.success).toBe(scenario.expect.success);
      expect(result.problem?.code ?? null).toBe(scenario.expect.errorCode ?? null);
      expect(result.deliveries.map((d) => d.outcome)).toEqual(scenario.expect.deliveryOutcomes);
    } else {
      const status = await chain.getTransactionStatus(scenario.input.hash as string);
      expect(status.status).toBe(scenario.expect.status);
      expect(status.error?.code ?? null).toBe(scenario.expect.errorCode ?? null);
      expect(status.summary?.deliveries.map((d) => d.outcome) ?? []).toEqual(scenario.expect.deliveryOutcomes);
    }
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe('TON mainnet recordings', () => {
  if (recordings === null) {
    it.todo('record them with TON_LIVE_RECORD=1 npm run test:live:ton');
    return;
  }
  for (const [name, scenario] of Object.entries(recordings.scenarios)) {
    it(`${name}: ${scenario.description}`, () => replay(scenario));
  }
});
