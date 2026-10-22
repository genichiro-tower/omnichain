import { beginCell } from '@ton/core';

import { CHAIN_ID_TON_MAINNET } from '../../chain_ids.ts';
import { TransactionStatusTypes } from '../../transaction_status.ts';
import { TON_JETTON_INTERNAL_TRANSFER_OP, TON_JETTON_TRANSFER_OP, TON_W5_SIGNED_INTERNAL_OP } from '../ton_messages.ts';
import { type TonTrace, type TonTraceMessage, type TonTraceTransaction, assertTraceConsistent } from '../ton_provider.ts';
import { TonTransactionStatus, summarizeTonTrace } from '../ton_transaction_status.ts';
import { TonWallet } from '../ton_wallet.ts';
import { JETTON_WALLET, MNEMONIC, OTHER, bouncing, realTrace, settled } from './ton_test_helpers.ts';

describe('TonTransactionStatus', () => {
  it('is Success once the trace is complete and every transaction is in a referenced block', async () => {
    const trace = await realTrace();
    const status = TonTransactionStatus.fromTrace({ chainId: CHAIN_ID_TON_MAINNET, trace, masterchainTip: 100472540 });
    expect(status.status).toBe(TransactionStatusTypes.Success);
    expect(status.masterchainSeqno).toBe(100472531);
    expect(status.masterchainDepth).toBe(9);

    const [root, child] = trace.transactions;
    const deltaOf = (account: string): bigint =>
      [...(status.balanceChanges?.get(account)?.values() ?? [])][0].change.balanceChangeMr;
    expect(deltaOf(root.account)).toBe(-(3_794_400_000n + 58_135n + root.totalFees));
    expect(deltaOf(child.account)).toBe(3_794_400_000n - child.totalFees);
    expect(status.fees).toBe(root.totalFees + child.totalFees + 58_135n);
  });

  it('stays Pending while not final, incomplete or shallower than asked', async () => {
    const trace = await realTrace();
    const notFinal = { ...trace, transactions: trace.transactions.map((tx, i) => (i === 1 ? { ...tx, mcSeqno: null } : tx)) };
    const at = (t: TonTrace | null, minMasterchainDepth = 0): string =>
      TonTransactionStatus.fromTrace({ chainId: CHAIN_ID_TON_MAINNET, trace: t, masterchainTip: 100472540, minMasterchainDepth }).status;
    expect(at(null)).toBe(TransactionStatusTypes.Pending);
    expect(at(notFinal)).toBe(TransactionStatusTypes.Pending);
    expect(at({ ...trace, complete: false })).toBe(TransactionStatusTypes.Pending);
    expect(at(trace, 10)).toBe(TransactionStatusTypes.Pending);
    expect(at(trace, 9)).toBe(TransactionStatusTypes.Success);
  });

  it('is Failed when a message the wallet sent bounced', async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      trace: {
        complete: true,
        transactions: settled([{ ...root, outMsgs: [{ ...root.outMsgs[0], bounce: true }] }, bouncing({ ...child, inMsg: { ...(child.inMsg as TonTraceMessage), bounce: true } })]),
      },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.error?.code).toBe('bounced');
    expect(status.summary?.deliveries).toEqual([
      expect.objectContaining({ from: root.account, to: child.account, outcome: 'bounced', transaction: child.hash }),
    ]);
  });

  it('is Failed, not bounced, when the receiver aborted without sending the value back', async () => {
    // An action phase that failed without send mode +16, or too little value to pay for the bounce.
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      trace: {
        complete: true,
        transactions: [{ ...root, outMsgs: [{ ...root.outMsgs[0], bounce: true }] }, { ...child, success: false, aborted: true, outMsgs: [] }],
      },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.error?.code).toBe('receiver_failed');
    expect(status.summary?.deliveries).toEqual([expect.objectContaining({ outcome: 'failed', transaction: child.hash })]);
  });

  it('stays Success when a recipient fails on a non-bounceable message or further down', async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const downstream: TonTraceTransaction = { ...child, hash: 'dd'.repeat(32), parent: child.hash, success: false };
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      trace: { complete: true, transactions: settled([root, { ...child, success: false }, downstream]) },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Success);
    expect(status.summary?.deliveries[0].outcome).toBe('delivered');
    expect(status.summary?.failedTransactions).toHaveLength(2);
  });

  it('is Failed when a relayed request was not executed', async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const target: TonTraceTransaction = {
      ...child,
      inMsg: { ...(child.inMsg as NonNullable<TonTraceTransaction['inMsg']>), opcode: TON_W5_SIGNED_INTERNAL_OP, bounce: true },
      outMsgs: [],
    };
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      trace: { complete: true, transactions: [root, target] },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.error?.code).toBe('request_not_executed');
  });

  it("judges a relayed request's own messages", async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const payout = { ...root.outMsgs[0], source: child.account, destination: OTHER, value: 7n, bounce: true };
    const target: TonTraceTransaction = {
      ...child,
      inMsg: { ...(child.inMsg as NonNullable<TonTraceTransaction['inMsg']>), opcode: TON_W5_SIGNED_INTERNAL_OP },
      outMsgs: [payout],
    };
    const received: TonTraceTransaction = {
      ...child,
      hash: 'ee'.repeat(32),
      parent: child.hash,
      account: OTHER,
      inMsg: { ...payout },
      outMsgs: [],
    };
    const judge = (receiver: TonTraceTransaction | null, complete = true): TonTransactionStatus =>
      TonTransactionStatus.fromTrace({
        chainId: CHAIN_ID_TON_MAINNET,
        trace: { complete, transactions: receiver === null ? [root, target] : settled([root, target, receiver]) },
        masterchainTip: 100472540,
      });
    expect(judge(received).status).toBe(TransactionStatusTypes.Success);
    expect(judge(received).summary?.deliveries.map((d) => d.outcome)).toEqual(['delivered', 'delivered']);
    expect(judge(bouncing(received)).error?.code).toBe('bounced');
    expect(judge({ ...received, success: false, aborted: true }).error?.code).toBe('receiver_failed');
    // A complete trace without the payout's receiver is the provider's gap, not an undelivered payout.
    expect(() => judge(null)).toThrow(expect.objectContaining({ retryable: true, message: expect.stringContaining('reached no transaction') }));
    expect(judge(null, false).status).toBe(TransactionStatusTypes.Pending);
  });

  it('is Failed when a bounceable message reaches an address with no code', async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      trace: {
        complete: true,
        transactions: settled([
          { ...root, outMsgs: [{ ...root.outMsgs[0], bounce: true }] },
          { ...bouncing({ ...child, inMsg: { ...(child.inMsg as TonTraceMessage), bounce: true } }), success: true, origStatus: 'nonexist' as const },
        ]),
      },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.error?.code).toBe('bounced');
  });

  it('is Failed when a relay without deploy reaches an undeployed wallet', async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const relay = { ...root.outMsgs[0], bounce: true, opcode: TON_W5_SIGNED_INTERNAL_OP };
    const bounceBack = { ...relay, source: child.account, destination: root.account, bounce: false, bounced: true };
    const target: TonTraceTransaction = {
      ...child,
      aborted: true,
      success: true,
      inMsg: { ...relay },
      outMsgs: [bounceBack],
    };
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      trace: { complete: true, transactions: settled([{ ...root, outMsgs: [relay] }, target]) },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(['bounced', 'request_not_executed']).toContain(status.error?.code);
    expect(status.summary?.deliveries).toEqual([expect.objectContaining({ to: child.account, outcome: 'bounced' })]);
  });

  it("judges a jetton transfer where the jettons land, in the receiver's jetton wallet", async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const transfer = { ...root.outMsgs[0], bounce: true, opcode: TON_JETTON_TRANSFER_OP };
    const internalTransfer = { ...transfer, source: child.account, destination: OTHER, value: 40_000_000n, opcode: TON_JETTON_INTERNAL_TRANSFER_OP };
    const senderJettonWallet: TonTraceTransaction = { ...child, inMsg: { ...transfer }, outMsgs: [internalTransfer] };
    const receiverJettonWallet: TonTraceTransaction = {
      ...child,
      hash: 'ff'.repeat(32),
      parent: child.hash,
      account: OTHER,
      inMsg: { ...internalTransfer },
      outMsgs: [],
    };
    const judge = (receiver: TonTraceTransaction): TonTransactionStatus =>
      TonTransactionStatus.fromTrace({
        chainId: CHAIN_ID_TON_MAINNET,
        trace: { complete: true, transactions: settled([{ ...root, outMsgs: [transfer] }, senderJettonWallet, receiver]) },
        masterchainTip: 100472540,
      });
    const landed = judge(receiverJettonWallet);
    expect(landed.status).toBe(TransactionStatusTypes.Success);
    expect(landed.summary?.deliveries[0]).toMatchObject({ outcome: 'delivered', transaction: receiverJettonWallet.hash });
    const refunded = judge(bouncing(receiverJettonWallet));
    expect(refunded.status).toBe(TransactionStatusTypes.Failed);
    expect(refunded.error?.code).toBe('jetton_bounced');
    const kept = judge({ ...receiverJettonWallet, success: false, aborted: true });
    expect(kept.error?.code).toBe('jetton_receiver_failed');
    expect(kept.summary?.deliveries[0].outcome).toBe('failed');
    // Its excess refund skipped under "ignore errors": the jettons still landed.
    const excessSkipped = judge({ ...receiverJettonWallet, success: false, aborted: false, skippedActions: 1 });
    expect(excessSkipped.status).toBe(TransactionStatusTypes.Success);
    expect(excessSkipped.summary?.failedTransactions).toHaveLength(1);
  });

  it('tells two identical jetton transfers apart by created_lt', async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    const vault = root.account;
    const vaultJettonWallet = child.account;
    // Two transfers from the vault to its own jetton wallet with the same attached TON.
    const transfer = (lt: bigint): TonTraceMessage => ({
      ...root.outMsgs[0],
      source: vault,
      destination: vaultJettonWallet,
      value: 50_000_000n,
      bounce: true,
      opcode: TON_JETTON_TRANSFER_OP,
      createdLt: lt,
    });
    const internalTransfer = (lt: bigint, to: string): TonTraceMessage => ({
      ...transfer(lt),
      source: vaultJettonWallet,
      destination: to,
      value: 40_000_000n,
      opcode: TON_JETTON_INTERNAL_TRANSFER_OP,
    });
    const tx = (hash: string, parent: string, account: string, inMsg: TonTraceMessage, outMsgs: TonTraceMessage[] = []): TonTraceTransaction => ({
      ...child,
      hash: hash.repeat(32),
      parent,
      account,
      inMsg,
      outMsgs,
      success: true,
      aborted: false,
    });
    const first = tx('a1', root.hash, vaultJettonWallet, transfer(10n), [internalTransfer(11n, OTHER)]);
    const second = tx('a2', root.hash, vaultJettonWallet, transfer(20n), [internalTransfer(21n, JETTON_WALLET)]);
    const firstLanded = tx('b1', first.hash, OTHER, internalTransfer(11n, OTHER));
    const secondRefunded = bouncing(tx('b2', second.hash, JETTON_WALLET, internalTransfer(21n, JETTON_WALLET)));
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      // The receivers are listed in the opposite order to the messages, as a provider may return them.
      trace: {
        complete: true,
        transactions: settled([{ ...root, outMsgs: [transfer(20n), transfer(10n)] }, second, first, secondRefunded, firstLanded]),
      },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.error?.code).toBe('jetton_bounced');
    expect(status.summary?.deliveries).toEqual([
      expect.objectContaining({ outcome: 'delivered', transaction: firstLanded.hash }),
      expect.objectContaining({ outcome: 'bounced', transaction: secondRefunded.hash }),
    ]);
  });

  it('refuses, retryably, a trace whose receiver disagrees with its sender', async () => {
    const trace = await realTrace();
    const [root, child] = trace.transactions;
    expect(assertTraceConsistent('P', trace)).toBe(trace);
    const refused = (transactions: TonTraceTransaction[]): unknown => {
      try {
        assertTraceConsistent('P', { complete: true, transactions });
      } catch (err) {
        return err;
      }
      return null;
    };
    const tampered = [
      [root, { ...child, inMsg: { ...(child.inMsg as TonTraceMessage), value: 1n } }],
      [root, { ...child, account: OTHER }],
      [root, { ...child, inMsg: { ...(child.inMsg as TonTraceMessage), createdLt: 1n } }],
      [{ ...root, outMsgs: [{ ...root.outMsgs[0], createdLt: null }] }, child],
    ];
    for (const transactions of tampered) {
      expect(refused(transactions)).toMatchObject({ retryable: true, message: expect.stringMatching(/inconsistent trace/i) });
    }
  });

  it('is Failed when a wallet skipped a message it could not send', async () => {
    const trace = await realTrace();
    const [root] = trace.transactions;
    const status = TonTransactionStatus.fromTrace({
      chainId: CHAIN_ID_TON_MAINNET,
      trace: { complete: true, transactions: [{ ...root, success: false, skippedActions: 1, outMsgs: [] }] },
      masterchainTip: 100472540,
    });
    expect(status.status).toBe(TransactionStatusTypes.Failed);
    expect(status.error?.code).toBe('skipped_actions');
  });

  it('reads the jettons a jetton wallet accepted', async () => {
    const trace = await realTrace();
    const [, child] = trace.transactions;
    const body = beginCell()
      .storeUint(TON_JETTON_INTERNAL_TRANSFER_OP, 32)
      .storeUint(0, 64)
      .storeCoins(9_000n)
      .storeAddress(TonWallet.fromMnemonic(MNEMONIC).contract.address)
      .endCell();
    const credit: TonTraceTransaction = {
      ...child,
      inMsg: { ...(child.inMsg as NonNullable<TonTraceTransaction['inMsg']>), opcode: TON_JETTON_INTERNAL_TRANSFER_OP, body },
    };
    expect(summarizeTonTrace(CHAIN_ID_TON_MAINNET, { complete: true, transactions: [{ ...credit, parent: null }] }).jettonCredits).toEqual([
      {
        jettonWallet: child.account,
        amount: 9_000n,
        from: TonWallet.fromMnemonic(MNEMONIC).address,
        senderJettonWallet: (child.inMsg as TonTraceMessage).source,
        transaction: child.hash,
      },
    ]);
  });
});
