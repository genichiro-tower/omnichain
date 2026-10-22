import {
  Address,
  Cell,
  type OutActionSendMsg,
  SendMode,
  type StateInit,
  beginCell,
  internal,
  storeMessage,
} from '@ton/core';

import { createHash } from 'node:crypto';

import { ChainError, ChainErrorKinds } from '../errors.ts';
import { AbstractSignedMessage } from '../wallet.base.ts';

const TON_MESSAGE_PREFIX = 'TON Signed Message:\n';

/**
 * What `signMessage` signs: SHA-256 of a fixed prefix and the message's UTF-8
 * bytes, as Stellar's SEP-53 does. The same key authorizes W5 requests by
 * signing a 32-byte cell hash, so signing a message's bytes directly would let
 * a crafted 32-byte message stand in for a request; a prefixed digest cannot
 * equal a cell hash without a SHA-256 preimage.
 */
export function tonMessageHash(message: string): Buffer {
  return createHash('sha256').update(TON_MESSAGE_PREFIX, 'utf8').update(message, 'utf8').digest();
}

export class TonSignedMessage extends AbstractSignedMessage {
  constructor(signature: string) {
    super(signature);
  }
}

/** W5's limit on outgoing messages per request. */
export const TON_MAX_MESSAGES_PER_REQUEST = 255;

/** The send mode a message gets unless it names one: the wallet pays forward fees on top of `value`. */
export const TON_DEFAULT_SEND_MODE = SendMode.PAY_GAS_SEPARATELY;

export const TON_COMMENT_OP = 0;
export const TON_JETTON_TRANSFER_OP = 0x0f8a7ea5;
export const TON_JETTON_INTERNAL_TRANSFER_OP = 0x178d4519;

/** One outgoing internal message of a wallet request. */
export interface TonOutMessage {
  /** Any address form. */
  to: string;
  /** Nanotons attached. */
  value: bigint;
  body?: Cell;
  /** Defaults to `true` when there is a body and `false` otherwise. */
  bounce?: boolean;
  stateInit?: StateInit;
  /** Defaults to {@link TON_DEFAULT_SEND_MODE}. */
  mode?: number;
}

export function tonOutAction(message: TonOutMessage): OutActionSendMsg {
  if (message.value < 0n) {
    throw new ChainError(ChainErrorKinds.InvalidArgument, `TON message value must be >= 0, got ${message.value}`);
  }
  return {
    type: 'sendMsg',
    mode: message.mode ?? TON_DEFAULT_SEND_MODE,
    outMsg: internal({
      to: parseTonAddress(message.to),
      value: message.value,
      bounce: message.bounce ?? message.body !== undefined,
      body: message.body,
      init: message.stateInit,
    }),
  };
}

export function tonOutActions(messages: readonly TonOutMessage[]): OutActionSendMsg[] {
  if (messages.length === 0 || messages.length > TON_MAX_MESSAGES_PER_REQUEST) {
    throw new ChainError(
      ChainErrorKinds.InvalidArgument,
      `A TON request carries 1 to ${TON_MAX_MESSAGES_PER_REQUEST} messages, got ${messages.length}`,
    );
  }
  return messages.map(tonOutAction);
}

/** A text comment body (op 0), the form wallets show as a memo. */
export function tonCommentBody(text: string): Cell {
  return beginCell().storeUint(TON_COMMENT_OP, 32).storeStringTail(text).endCell();
}

export interface TonJettonTransferBodyArgs {
  /** Jetton units, in the jetton's smallest unit. */
  amount: bigint;
  /** The new owner (not their jetton wallet). */
  destination: string;
  /** Who receives the excess TON once the transfer settles. */
  responseDestination: string;
  /** TON forwarded to `destination` with the transfer notification; 0 sends none. */
  forwardTonAmount?: bigint;
  forwardPayload?: Cell;
  queryId?: bigint;
}

/** The TEP-74 `transfer` body, sent to the sender's own jetton wallet. */
export function tonJettonTransferBody(args: TonJettonTransferBodyArgs): Cell {
  const builder = beginCell()
    .storeUint(TON_JETTON_TRANSFER_OP, 32)
    .storeUint(args.queryId ?? 0n, 64)
    .storeCoins(args.amount)
    .storeAddress(parseTonAddress(args.destination))
    .storeAddress(parseTonAddress(args.responseDestination))
    .storeBit(false)
    .storeCoins(args.forwardTonAmount ?? 0n);
  return args.forwardPayload === undefined
    ? builder.storeBit(false).endCell()
    : builder.storeBit(true).storeRef(args.forwardPayload).endCell();
}

export const TON_W5_SIGNED_INTERNAL_OP = 0x73696e74;
export const TON_W5_SIGNED_EXTERNAL_OP = 0x7369676e;

/** What a signed W5 request commits to, read back from its body. */
export interface TonW5RequestFields {
  /** `external`: the wallet sends it itself; `internal`: a relayer delivers it. */
  authType: 'external' | 'internal';
  walletId: number;
  /** Unix seconds; the wallet refuses it from then on. */
  validUntil: number;
  /** The wallet seqno it executes at. */
  seqno: number;
}

/**
 * The fields of a signed W5R1 request body: op, wallet id, `valid_until` and
 * seqno lead the body, the signature trails it. Throws `TransactionDecodeFailed`
 * for anything that is not one.
 */
export function tonW5RequestFields(body: Cell): TonW5RequestFields {
  try {
    const slice = body.beginParse();
    const op = slice.loadUint(32);
    if (op !== TON_W5_SIGNED_EXTERNAL_OP && op !== TON_W5_SIGNED_INTERNAL_OP) throw new Error(`op 0x${op.toString(16)}`);
    return {
      authType: op === TON_W5_SIGNED_EXTERNAL_OP ? 'external' : 'internal',
      walletId: slice.loadInt(32),
      validUntil: slice.loadUint(32),
      seqno: slice.loadUint(32),
    };
  } catch (err) {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, `Not a signed W5 request: ${(err as Error).message}`, undefined, err as Error);
  }
}

/**
 * A request a wallet signed for a relayer (`TonWallet.createInternalRequest`),
 * with the seqno and `validUntil` it commits to — what
 * `TonChain.getRequestState` needs once it has been sent.
 */
export interface TonInternalRequest {
  /** The signed request, the relay message's body. */
  body: Cell;
  seqno: number;
  validUntil: number;
}

/** A signed internal request read back from its body, e.g. one found in a trace. */
export function tonInternalRequestOf(body: Cell): TonInternalRequest {
  const fields = tonW5RequestFields(body);
  if (fields.authType !== 'internal') {
    throw new ChainError(ChainErrorKinds.TransactionDecodeFailed, 'Not a signed W5 internal request: it is an external one');
  }
  return { body, seqno: fields.seqno, validUntil: fields.validUntil };
}

/** The wallet a relay delivers to: its address and the StateInit that deploys it (a `TonWallet` fits). */
export interface TonRelayTarget {
  address: string;
  stateInit: StateInit;
}

export interface TonRelayMessageArgs {
  wallet: TonRelayTarget;
  /** The wallet's own signed internal request (`TonWallet.createInternalRequest`). */
  request: TonInternalRequest;
  /** Nanotons the relayer attaches: the trace's fees plus whatever the request's messages need. */
  value: bigint;
  /** Attach the wallet's StateInit, deploying it; set while it is not deployed. */
  deploy: boolean;
}

/**
 * The message a relayer sends to deliver a wallet's signed internal request.
 *
 * Bounceable, so a request that fails in the wallet returns the value. A
 * request the wallet does not accept (a bad signature, a stale seqno) is
 * dropped without a bounce and the wallet keeps the value; the transaction
 * status reports that as `request_not_executed`.
 */
export function tonRelayMessage(args: TonRelayMessageArgs): TonOutMessage {
  return {
    to: args.wallet.address,
    value: args.value,
    body: args.request.body,
    bounce: true,
    stateInit: args.deploy ? args.wallet.stateInit : undefined,
  };
}

/**
 * The normalized hash of an external message (TEP-467): source, import fee and
 * StateInit dropped, body stored as a reference. It is what both TON Center and
 * TonAPI index the external message under, and is used as the transaction id.
 */
export function tonNormalizedExternalHash(destination: string, body: Cell): string {
  const normalized = beginCell()
    .store(
      storeMessage(
        { info: { type: 'external-in', src: null, dest: parseTonAddress(destination), importFee: 0n }, body },
        { forceRef: true },
      ),
    )
    .endCell();
  return normalized.hash().toString('hex');
}

export function parseTonAddress(address: string): Address {
  try {
    return Address.parse(address);
  } catch (err) {
    throw new ChainError(ChainErrorKinds.InvalidAddress, `Invalid TON address: ${address}`, { address }, err as Error);
  }
}
