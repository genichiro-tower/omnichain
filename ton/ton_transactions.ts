import { Cell, type CommonMessageInfoExternalIn, type Message, loadMessage } from '@ton/core';

import { ChainError, ChainErrorKinds } from '../errors.ts';
import { NetworkType } from '../network_type.ts';
import { AbstractSignedTransaction } from '../signed_transaction.ts';
import {
  JSON_TRANSACTION_CHAIN_ID_KEY,
  type JsonDict,
  type JsonTransactionInput,
  jsonPayloadItem,
  jsonTransactionEnvelope,
  parseJsonTransactionEnvelope,
  registerJsonTransactionType,
} from '../transaction_json.ts';
import { UnsignedTransaction } from '../unsigned_transaction.ts';
import { tonRawAddress } from './ton_address.ts';
import { type TonOutMessage, tonNormalizedExternalHash, tonOutActions, tonW5RequestFields } from './ton_messages.ts';

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

/**
 * A signed W5 external request: its BOC, its normalized hash (the
 * transaction id), and — read from the signed body itself, so they survive a
 * JSON round trip — the wallet, seqno and `validUntil` it commits to, which
 * `TonChain.getRequestState` takes.
 */
export class TonSignedTransaction extends AbstractSignedTransaction {
  static readonly JSON_TYPE = 'TonSignedTransaction';

  readonly #chainId: number;
  readonly boc: string;
  readonly #hash: string;
  /** Raw. */
  readonly walletAddress: string;
  readonly seqno: number;
  readonly validUntil: number;

  constructor(init: { chainId: number; boc: string }) {
    super();
    const request = tonExternalRequestOf(init.boc);
    this.#chainId = init.chainId;
    this.boc = init.boc;
    this.#hash = request.hash;
    this.walletAddress = request.walletAddress;
    this.seqno = request.seqno;
    this.validUntil = request.validUntil;
  }

  get chainId(): number {
    return this.#chainId;
  }

  /** Normalized external-message hash, lowercase hex. */
  get txHash(): string {
    return this.#hash;
  }

  toJson(): JsonDict {
    return jsonTransactionEnvelope(TonSignedTransaction.JSON_TYPE, this.#chainId, { boc: this.boc });
  }

  static fromJson(data: JsonTransactionInput): TonSignedTransaction {
    const payload = parseJsonTransactionEnvelope(data, TonSignedTransaction.JSON_TYPE);
    const chainId = jsonPayloadItem(payload, JSON_TRANSACTION_CHAIN_ID_KEY);
    const boc = jsonPayloadItem(payload, 'boc');
    if (!Number.isSafeInteger(chainId) || typeof boc !== 'string') {
      throw new ChainError(ChainErrorKinds.InvalidArgument, 'A TonSignedTransaction payload needs an integer chain_id and a boc string');
    }
    return new TonSignedTransaction({ chainId: chainId as number, boc });
  }
}

registerJsonTransactionType(TonSignedTransaction);

/** A signed W5 external request read back from its base64 BOC. */
export function tonExternalRequestOf(boc: string): { walletAddress: string; hash: string; seqno: number; validUntil: number } {
  const message = externalMessageOf(boc);
  const fields = tonW5RequestFields(message.body);
  if (fields.authType !== 'external') {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, 'Not a signed W5 external request: it is an internal one');
  }
  const walletAddress = message.info.dest.toRawString();
  return { walletAddress, hash: tonNormalizedExternalHash(walletAddress, message.body), seqno: fields.seqno, validUntil: fields.validUntil };
}

/** The normalized hash of an external message given as a base64 BOC; refuses anything else. */
export function tonExternalBocHash(boc: string): string {
  const message = externalMessageOf(boc);
  return tonNormalizedExternalHash(message.info.dest.toRawString(), message.body);
}

function externalMessageOf(boc: string): Message & { info: CommonMessageInfoExternalIn } {
  let message: Message;
  try {
    message = loadMessage(Cell.fromBase64(boc).beginParse());
  } catch (err) {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, 'Not a TON message BOC', undefined, err as Error);
  }
  if (message.info.type !== 'external-in') {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `Expected an external-in message, got ${message.info.type}`);
  }
  return message as Message & { info: CommonMessageInfoExternalIn };
}

