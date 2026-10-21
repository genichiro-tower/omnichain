import { Cell, loadMessage } from '@ton/core';

import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType } from '../network_type.ts';
import { AbstractSignedTransaction } from '../signed_transaction.ts';
import type { JsonDict } from '../transaction_json.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';
import { tonRawAddress } from './ton_address.ts';
import { type TonOutMessage, tonNormalizedExternalHash, tonOutActions } from './ton_messages.ts';

/**
 * A request a wallet will send itself: its messages, and optionally how long
 * the signed request stays valid. The seqno and whether to deploy are read at
 * signing time (`TonWallet.signTransaction`).
 */
export class TonUnsignedTransaction extends UnsignedTransaction {
  readonly walletAddress: string;
  readonly messages: readonly TonOutMessage[];
  readonly validUntil: number | undefined;

  constructor(init: { chainId: number; walletAddress: string; messages: readonly TonOutMessage[]; validUntil?: number }) {
    super(init.chainId, NetworkType.TON);
    tonOutActions(init.messages);
    this.walletAddress = tonRawAddress(init.walletAddress);
    this.messages = init.messages;
    this.validUntil = init.validUntil;
  }
}

/** A signed external message: its BOC and its normalized hash, the transaction id. */
export class TonSignedTransaction extends AbstractSignedTransaction {
  static readonly JSON_TYPE = 'TonSignedTransaction';

  readonly #chainId: number;
  readonly boc: string;
  readonly #hash: string;

  constructor(init: { chainId: number; boc: string; hash?: string }) {
    super();
    this.#chainId = init.chainId;
    this.boc = init.boc;
    this.#hash = init.hash ?? tonExternalBocHash(init.boc);
  }

  get chainId(): number {
    return this.#chainId;
  }

  /** Normalized external-message hash, lowercase hex. */
  get txHash(): string {
    return this.#hash;
  }

  toJson(): JsonDict {
    return { type: TonSignedTransaction.JSON_TYPE, chainId: this.#chainId, boc: this.boc };
  }
}

/** The normalized hash of an external message given as a base64 BOC; refuses anything else. */
export function tonExternalBocHash(boc: string): string {
  let message;
  try {
    message = loadMessage(Cell.fromBase64(boc).beginParse());
  } catch (err) {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, 'Not a TON message BOC', undefined, err as Error);
  }
  if (message.info.type !== 'external-in') {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Expected an external-in message, got ${message.info.type}`);
  }
  return tonNormalizedExternalHash(message.info.dest.toRawString(), message.body);
}

