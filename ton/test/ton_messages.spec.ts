import { readFileSync } from 'node:fs';

import { Cell } from '@ton/core';

import {
  TON_JETTON_TRANSFER_OP,
  tonCommentBody,
  tonJettonTransferBody,
  tonNormalizedExternalHash,
  tonOutAction,
  tonRelayMessage,
} from '../ton_messages.ts';

const OWNER = '0:9d1e1843624c4d175a695a8c2de8a5a61f03b93336e8caa4e164bf6cbbab205e';
const OTHER = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe';

describe('TON messages', () => {
  it('computes the normalized external hash TON Center indexes', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/external_message.json', import.meta.url), 'utf8'));
    const hash = tonNormalizedExternalHash(fixture.destination, Cell.fromBase64(fixture.body));
    expect(hash).toBe(Buffer.from(fixture.hash_norm, 'base64').toString('hex'));
    expect(hash).not.toBe(Buffer.from(fixture.hash, 'base64').toString('hex'));
  });

  it('builds a text comment', () => {
    const slice = tonCommentBody('42').beginParse();
    expect(slice.loadUint(32)).toBe(0);
    expect(slice.loadStringTail()).toBe('42');
  });

  it('builds a TEP-74 jetton transfer', () => {
    const slice = tonJettonTransferBody({
      amount: 10_000n,
      destination: OTHER,
      responseDestination: OWNER,
      forwardTonAmount: 1n,
      forwardPayload: tonCommentBody('memo'),
    }).beginParse();
    expect(slice.loadUint(32)).toBe(TON_JETTON_TRANSFER_OP);
    expect(slice.loadUintBig(64)).toBe(0n);
    expect(slice.loadCoins()).toBe(10_000n);
    expect(slice.loadAddress().toRawString()).toBe(OTHER);
    expect(slice.loadAddress().toRawString()).toBe(OWNER);
    expect(slice.loadBit()).toBe(false);
    expect(slice.loadCoins()).toBe(1n);
    expect(slice.loadBit()).toBe(true);
    expect(slice.loadRef().beginParse().skip(32).loadStringTail()).toBe('memo');
  });

  it('defaults bounce to whether a message has a body', () => {
    const plain = tonOutAction({ to: OTHER, value: 1n });
    const call = tonOutAction({ to: OTHER, value: 1n, body: tonCommentBody('x') });
    expect(plain.outMsg.info.type === 'internal' && plain.outMsg.info.bounce).toBe(false);
    expect(call.outMsg.info.type === 'internal' && call.outMsg.info.bounce).toBe(true);
  });

  it("makes a bounceable relay message that deploys its target only when asked", () => {
    const request = tonCommentBody('request');
    const wallet = { address: OWNER, stateInit: { code: tonCommentBody('code'), data: tonCommentBody('data') } };
    expect(tonRelayMessage({ wallet, request, value: 50_000_000n, deploy: true })).toEqual({
      to: OWNER,
      value: 50_000_000n,
      body: request,
      bounce: true,
      stateInit: wallet.stateInit,
    });
    expect(tonRelayMessage({ wallet, request, value: 1n, deploy: false }).stateInit).toBeUndefined();
  });

  it('refuses a negative value', () => {
    expect(() => tonOutAction({ to: OTHER, value: -1n })).toThrow(/>= 0/);
  });
});
