import { AssetMap } from '../asset_map.ts';
import { FiatCurrency } from '../chain_type.ts';
import type { TonAsset } from './ton_asset.ts';
import { TonMainnet } from './ton_chains.ts';

export const TON_TON = TonMainnet.nativeAsset;

export const TON_USDT = TonMainnet.getJettonAsset('USD₮', 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs', 6);

export const TON_MAINNET_STABLECOINS_PEG: ReadonlyMap<TonAsset, FiatCurrency> = new AssetMap<TonAsset, FiatCurrency>([[TON_USDT, FiatCurrency.USD]]);
