import { CHAIN_ID_TON_MAINNET } from '../chain_ids.ts';
import { TonChain } from './ton_chain.ts';

export const TON_CENTER_MAINNET_URL = 'https://toncenter.com';
export const TONAPI_MAINNET_URL = 'https://tonapi.io';

/**
 * TON mainnet. Its keys are read at first use from `TONCENTER_API_KEY` and
 * `TONAPI_API_KEY`; a service that holds them elsewhere builds its own
 * `TonChain` with the same URLs.
 */
export const TonMainnet = new TonChain({
  chainId: CHAIN_ID_TON_MAINNET,
  name: 'TON Mainnet',
  explorerUrl: 'https://tonviewer.com',
  toncenter: { url: TON_CENTER_MAINNET_URL },
  tonapi: { url: TONAPI_MAINNET_URL },
});

export const ALL_TON_CHAINS: ReadonlyArray<TonChain> = [TonMainnet];
