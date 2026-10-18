/**
 * Agent-facing behavior: human-unit transfers, prepare → execute, retry
 * safety, structured errors, guardrails, and secret isolation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AbiCoder, Interface, Transaction, MaxUint256 } from 'ethers';
import { WalletVault, encodeErc20Read, policyPreset } from 'dsh-web3-core';
import { WalletService } from '../src/service.js';
import { buildTools, type WalletTool } from '../src/tools.js';
import { WALLET_PASSPHRASE_REF } from '../src/passphrase.js';
import { MockChainProvider, ApprovalStub } from '../src/testing.js';

const HARDHAT_MNEMONIC = 'test test test test test test test test test test test junk';
const ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ALICE = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BOB = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const PRIVATE_KEY_0 = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const abi = AbiCoder.defaultAbiCoder();
const erc20 = new Interface(['function transfer(address,uint256)', 'function approve(address,uint256)']);

let dir: string;
let provider: MockChainProvider;
let service: WalletService;
let approval: ApprovalStub;
let tools: WalletTool[];
let accountId: string;

function tool(name: string): WalletTool {
  const found = tools.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`no tool ${name}`);
  return found;
}

async function run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  return (await tool(name).execute(args, {})) as Record<string, unknown>;
}

/** Make USDC on Base look deployed with 6 decimals and a balance for account 0. */
function mockUsdc(balance: bigint): void {
  const key = (data: string) => `${USDC_BASE.toLowerCase()}:${data}`;
  provider.codes.set(USDC_BASE.toLowerCase(), '0x6080');
  provider.calls.set(key(encodeErc20Read('decimals')), abi.encode(['uint8'], [6]));
  provider.calls.set(key(encodeErc20Read('balanceOf', [ACCOUNT_0])), abi.encode(['uint256'], [balance]));
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-web3-agent-'));
  // A known baseline (strict policy, nothing capped) rather than the
  // small-amount defaults, so each test states the gates it exercises.
  await writeFile(join(dir, 'policy.json'), JSON.stringify(policyPreset('strict')), { mode: 0o600 });
  await writeFile(
    join(dir, 'limits.json'),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), whitelistOnly: false, usd: {}, native: {} }),
    { mode: 0o600 },
  );
  const vault = await WalletVault.open({ directory: dir, kdf: { N: 1024, r: 8, p: 1 } });
  provider = new MockChainProvider(8453);
  approval = new ApprovalStub();
  service = new WalletService(vault, {
    vaultPath: dir,
    passphraseMode: 'manual',
    env: { [WALLET_PASSPHRASE_REF]: 'pw' },
    rpcOverrides: {},
    tokens: {},
    createProvider: () => provider,
  });
  tools = buildTools({ service, approval });
  const secretFile = join(dir, 'secret.txt');
  await writeFile(secretFile, HARDHAT_MNEMONIC, { mode: 0o600 });
  accountId = (await service.importAccount({ source: 'mnemonic', secretFile, label: 'main' })).meta.id;
});

afterEach(async () => {
  // vault.lock() is synchronous; service.lock() also persists PIN state
  // asynchronously, which would race with the directory removal.
  service.vault.lock();
  await rm(dir, { recursive: true, force: true });
});

describe('wallet_transfer: human units', () => {
  it('converts a decimal native amount exactly (no hand-made wei)', async () => {
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.015' });
    expect(result.status).toBe('signed-broadcast');
    const tx = Transaction.from(provider.broadcasted[0]!);
    expect(tx.value).toBe(15_000_000_000_000_000n);
    expect(tx.to).toBe(ALICE);
    expect(String(result.summary)).toContain('0.015 ETH');
  });

  it('builds ERC-20 transfer calldata from a symbol, using on-chain-verified decimals', async () => {
    mockUsdc(50_000_000n);
    approval.outcome = 'allowed-once';
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '25.5', token: 'usdc' });
    expect(result.status).toBe('signed-broadcast');
    const tx = Transaction.from(provider.broadcasted[0]!);
    expect(tx.to).toBe(USDC_BASE);
    expect(tx.value).toBe(0n);
    const decoded = erc20.decodeFunctionData('transfer', tx.data);
    expect(decoded[0]).toBe(ALICE);
    expect(decoded[1]).toBe(25_500_000n);
    // Token moves always reach a human under strict (value is 0, but it is not "free").
    expect(approval.requests).toHaveLength(1);
    expect(approval.requests[0]!.reason).toContain('Send 25.5 USDC');
    expect(approval.requests[0]!.reason).toContain(ALICE);
  });

  it('refuses amounts with more decimals than the token supports', async () => {
    mockUsdc(50_000_000n);
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '1.0000001', token: 'USDC' });
    expect(result).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
    expect(provider.broadcasted).toHaveLength(0);
  });

  it('rejects locale / scientific amount formats instead of guessing', async () => {
    for (const amount of ['1,5', '1e18', '-1', '0', 'ten']) {
      const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount });
      expect(result).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
    }
  });

  it('refuses unknown token symbols and wrong-chain token addresses', async () => {
    const unknown = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '1', token: 'PEPE' });
    expect(unknown).toMatchObject({ ok: false, code: 'UNKNOWN_TOKEN' });
    expect(String(unknown.hint)).toContain('USDC');
    // Registry token but no code at that address on this chain.
    const wrongChain = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '1', token: 'USDC' });
    expect(wrongChain).toMatchObject({ ok: false, code: 'UNKNOWN_TOKEN' });
  });

  it('refuses when on-chain decimals disagree with the registry', async () => {
    mockUsdc(50_000_000n);
    provider.calls.set(`${USDC_BASE.toLowerCase()}:${encodeErc20Read('decimals')}`, abi.encode(['uint8'], [18]));
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '1', token: 'USDC' });
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_MISMATCH' });
  });

  it('checks balances before bothering the user', async () => {
    mockUsdc(1_000_000n);
    const tokens = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '2', token: 'USDC' });
    expect(tokens).toMatchObject({ ok: false, code: 'INSUFFICIENT_FUNDS' });
    provider.balances.set(ACCOUNT_0.toLowerCase(), 10n ** 15n); // 0.001 ETH
    const native = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.001' }); // + fee > balance
    expect(native).toMatchObject({ ok: false, code: 'INSUFFICIENT_FUNDS' });
    expect(approval.requests).toHaveLength(0);
  });

  it('sends "max" native balance minus the pinned fee', async () => {
    provider.balances.set(ACCOUNT_0.toLowerCase(), 10n ** 16n); // 0.01 ETH, under the strict hard ceiling
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: 'max' });
    expect(result.status).toBe('signed-broadcast');
    const tx = Transaction.from(provider.broadcasted[0]!);
    expect(tx.value + tx.gasLimit * tx.maxFeePerGas!).toBe(10n ** 16n);
  });
});

describe('recipients', () => {
  it('rejects bad checksums and truncated addresses instead of "fixing" them', async () => {
    const badChecksum = ALICE.replace('C51812', 'c51812');
    expect(await run('wallet_transfer', { account: 'main', chainId: 8453, to: badChecksum, amount: '0.01' })).toMatchObject({ ok: false, code: 'INVALID_ADDRESS' });
    expect(await run('wallet_transfer', { account: 'main', chainId: 8453, to: '0x7099…79C8', amount: '0.01' })).toMatchObject({ ok: false, code: 'INVALID_ADDRESS' });
    expect(await run('wallet_transfer', { account: 'main', chainId: 8453, to: '0x' + '0'.repeat(40), amount: '0.01' })).toMatchObject({ ok: false, code: 'BLOCKED' });
  });

  it('resolves exact address-book labels (adding one needs approval) and ENS names', async () => {
    approval.outcome = 'rejected';
    expect(await run('wallet_address_book', { action: 'add', label: 'Alice', address: ALICE })).toMatchObject({ saved: false });
    approval.outcome = 'allowed-once';
    expect(await run('wallet_address_book', { action: 'add', label: 'Alice', address: ALICE })).toMatchObject({ saved: true });
    const prepared = await run('wallet_transfer', { account: 'main', chainId: 8453, to: 'alice', amount: '0.01', dryRun: true });
    expect(prepared.recipient).toMatchObject({ address: ALICE, via: 'address-book', label: 'Alice' });
    expect(await run('wallet_transfer', { account: 'main', chainId: 8453, to: 'Alic', amount: '0.01' })).toMatchObject({ ok: false, code: 'INVALID_RECIPIENT' });

    provider.names.set('bob.eth', BOB);
    const ens = await run('wallet_transfer', { account: 'main', chainId: 8453, to: 'bob.eth', amount: '0.01', dryRun: true });
    expect(ens.recipient).toMatchObject({ address: BOB, via: 'ens' });
    expect((ens.warnings as string[]).join('\n')).toContain('ENS');
  });

  it('warns about address-poisoning look-alikes of known contacts', async () => {
    approval.outcome = 'allowed-once';
    await run('wallet_address_book', { action: 'add', label: 'Alice', address: ALICE });
    const lookAlike = '0x70997970000000000000000000000000000079C8';
    const prepared = await run('wallet_transfer', { account: 'main', chainId: 8453, to: lookAlike, amount: '0.01', dryRun: true });
    expect((prepared.warnings as string[]).join('\n')).toContain('ADDRESS POISONING');
  });

  it('blocks sending tokens to the token contract itself', async () => {
    mockUsdc(50_000_000n);
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: USDC_BASE, amount: '1', token: 'USDC' });
    expect(result).toMatchObject({ ok: false, code: 'BLOCKED' });
  });
});

describe('prepare → confirm → execute', () => {
  it('executes exactly the prepared plan, once', async () => {
    const prepared = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01', dryRun: true });
    expect(prepared.status).toBe('prepared');
    expect(provider.broadcasted).toHaveLength(0);
    expect(prepared.willRequire).toMatchObject({ humanApproval: true, blocked: false });
    approval.outcome = 'allowed-once';
    const first = await run('wallet_send_transaction', { preparedId: prepared.preparedId });
    expect(first.status).toBe('signed-broadcast');
    const second = await run('wallet_send_transaction', { preparedId: prepared.preparedId });
    expect(second.status).toBe('already-submitted');
    expect(second.txHash).toBe(first.txHash);
    expect(provider.broadcasted).toHaveLength(1);
  });

  it('reports unknown preparedIds with a recovery hint', async () => {
    const result = await run('wallet_send_transaction', { preparedId: 'prep_nope' });
    expect(result).toMatchObject({ ok: false, code: 'PREPARED_NOT_FOUND' });
    expect(String(result.hint)).toContain('wallet_history');
  });

  it('makes retries with the same idempotencyKey safe', async () => {
    approval.outcome = 'allowed-once';
    const first = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01', idempotencyKey: 'rent-sept' });
    const retry = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01', idempotencyKey: 'rent-sept' });
    expect(retry.status).toBe('already-submitted');
    expect(retry.txHash).toBe(first.txHash);
    expect(provider.broadcasted).toHaveLength(1);
  });

  it('serializes concurrent sends so nonces never collide', async () => {
    await service.setPolicy(policyPreset('power'));
    const nonces: number[] = [];
    provider.getNonce = async () => nonces.length;
    const originalBroadcast = provider.broadcastRawTransaction.bind(provider);
    provider.broadcastRawTransaction = async (raw: string) => {
      nonces.push(Transaction.from(raw).nonce);
      return await originalBroadcast(raw);
    };
    await Promise.all([
      service.transfer({ account: 'main', chainId: 1, to: ALICE, amount: '0.001' }, approval),
      service.transfer({ account: 'main', chainId: 1, to: ALICE, amount: '0.002' }, approval),
    ]);
    expect(nonces.sort()).toEqual([0, 1]);
  });

  it('refuses to sign calls that would revert', async () => {
    provider.estimateError = Object.assign(new Error('execution reverted: ERC20: insufficient allowance'), { shortMessage: 'execution reverted: ERC20: insufficient allowance' });
    const result = await run('wallet_prepare_transaction', { account: 'main', chainId: 8453, to: USDC_BASE, data: erc20.encodeFunctionData('transfer', [ALICE, 1n]) });
    expect(result).toMatchObject({ ok: false, code: 'WOULD_REVERT' });
    expect(String(result.message)).toContain('insufficient allowance');
  });

  it('accepts amount in native units for raw calls and rejects non-integer wei', async () => {
    const prepared = await run('wallet_prepare_transaction', { account: 'main', chainId: 8453, to: ALICE, amount: '0.5' });
    expect(prepared.valueWei).toBe('500000000000000000');
    expect(await run('wallet_prepare_transaction', { account: 'main', chainId: 8453, to: ALICE, value: '0.5' })).toMatchObject({ ok: false, code: 'INVALID_AMOUNT' });
  });

  it('normalizes string chain ids from the model', async () => {
    const prepared = await run('wallet_transfer', { account: 'main', chainId: '8453', to: ALICE, amount: '0.01', dryRun: true });
    expect(prepared.chainId).toBe(8453);
    expect(await run('wallet_transfer', { account: 'main', chainId: 'base', to: ALICE, amount: '0.01', dryRun: true })).toMatchObject({ ok: false, code: 'UNKNOWN_CHAIN' });
  });
});

describe('broadcast failures and lifecycle', () => {
  it('journals before broadcast, so a lost node answer is never re-sent', async () => {
    approval.outcome = 'allowed-once';
    provider.broadcastError = Object.assign(new Error('request timeout'), { code: 'TIMEOUT' });
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01', idempotencyKey: 'k1' });
    expect(result.status).toBe('broadcast-uncertain');
    expect(String(result.next)).toContain('DO NOT send again');
    const status = await run('wallet_tx_status', { txHash: result.txHash });
    expect(status.status).toBe('unknown');
    const retry = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01', idempotencyKey: 'k1' });
    expect(retry.status).toBe('already-submitted');
  });

  it('marks definitive node rejections as rejected (safe to fix and retry)', async () => {
    approval.outcome = 'allowed-once';
    provider.broadcastError = Object.assign(new Error('insufficient funds for gas'), { code: 'INSUFFICIENT_FUNDS' });
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01' });
    expect(result.status).toBe('rejected-by-node');
    const history = (await run('wallet_history', {})).transactions as Array<Record<string, unknown>>;
    expect(history[0]).toMatchObject({ status: 'rejected' });
  });

  it('tracks status from receipts and speeds up pending transactions', async () => {
    approval.outcome = 'allowed-once';
    const sent = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01' });
    expect((await run('wallet_tx_status', { txHash: sent.txHash })).status).toBe('pending');
    const sped = await run('wallet_replace_transaction', { txHash: sent.txHash, action: 'speed-up' });
    expect(sped.status).toBe('signed-broadcast');
    const original = Transaction.from(provider.broadcasted[0]!);
    const replacement = Transaction.from(provider.broadcasted[1]!);
    expect(replacement.nonce).toBe(original.nonce);
    expect(replacement.maxFeePerGas! > original.maxFeePerGas!).toBe(true);
    expect(replacement.to).toBe(original.to);
    expect((await run('wallet_tx_status', { txHash: sent.txHash })).status).toBe('replaced');
    provider.receipts.set(String(sped.txHash).toLowerCase(), { hash: String(sped.txHash), status: 'success', blockNumber: 7, gasUsed: 21_000n });
    expect(await run('wallet_tx_status', { txHash: sped.txHash })).toMatchObject({ status: 'success', blockNumber: 7 });
    expect(await run('wallet_replace_transaction', { txHash: sped.txHash, action: 'cancel' })).toMatchObject({ ok: false, code: 'NOT_REPLACEABLE' });
  });
});

describe('gates and guardrails', () => {
  it('checks the PIN authorization before asking the human for approval', async () => {
    await service.pinSetup('1234');
    await service.pinClearDaily();
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01' });
    expect(result).toMatchObject({ ok: false, status: 'pin-required', code: 'PIN_REQUIRED' });
    expect(approval.requests).toHaveLength(0);
    const prepared = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01', dryRun: true });
    expect(prepared.willRequire).toMatchObject({ dailyPin: true });
  });

  it('fails fast on a locked vault instead of prompting the human first', async () => {
    service.lock();
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01' });
    expect(result).toMatchObject({ ok: false, code: 'VAULT_LOCKED' });
    expect(String(result.hint)).toContain('wallet_unlock');
    expect(String(result.message)).toContain('locked by the user');
    expect(approval.requests).toHaveLength(0);
  });

  it('re-opens a vault that locked itself (idle, restart) when signing, and audits it', async () => {
    service.vault.lock();
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01' });
    expect(result.status).toBe('signed-broadcast');
    const unlocked = (await service.recentAudit(50)).filter((e) => e.kind === 'vault.unlocked');
    expect(unlocked.at(-1)?.detail).toMatchObject({ source: 'env', trigger: 'signing' });
  });

  it('shares one automatic unlock between concurrent signing requests', async () => {
    service.vault.lock();
    const [a, b] = await Promise.all([
      service.signMessage({ account: accountId, message: 'a' }, approval),
      service.signMessage({ account: accountId, message: 'b' }, approval),
    ]);
    expect([a.status, b.status]).toEqual(['signed', 'signed']);
    expect((await service.recentAudit(50)).filter((e) => e.kind === 'vault.unlocked' && e.detail.trigger === 'signing')).toHaveLength(1);
  });

  it('keeps a user lock for other plugins too, with a readable error', async () => {
    service.lock();
    await expect(service.signTypedData({ account: accountId, domain: { name: 'X', chainId: 8453 }, types: { M: [{ name: 'v', type: 'uint256' }] }, primaryType: 'M', value: { v: 1 } }, approval))
      .rejects.toThrow(/locked by the user.*Settings → Web3/);
    await service.unlock();
    service.vault.lock();
    expect((await service.signMessage({ account: accountId, message: 'after' }, approval)).status).toBe('signed');
  });

  /** A service whose passphrase lookup waits until `release()`; `asked` resolves once the lookup started. */
  function gatedService(): { slow: WalletService; asked: Promise<void>; release: () => void } {
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const asked = new Promise<void>((resolve) => (started = resolve));
    const slow = new WalletService(service.vault, {
      vaultPath: dir, passphraseMode: 'manual', env: {}, rpcOverrides: {}, tokens: {}, createProvider: () => provider,
      credentials: { resolve: async () => { started(); await gate; return { value: 'pw', source: 'env' }; }, set: async () => undefined },
    });
    return { slow, asked, release };
  }

  it('a user lock during an automatic unlock wins: the keys are dropped and nothing is signed', async () => {
    const { slow, asked, release } = gatedService();
    service.vault.lock();
    const signing = slow.signMessage({ account: accountId, message: 'x' }, approval);
    await asked;
    slow.lock();
    release();
    await expect(signing).rejects.toThrow(/locked by the user/);
    expect(service.vault.unlocked).toBe(false);
    expect(approval.requests).toHaveLength(0);
  });

  it('a user lock during an explicit unlock wins and stays saved', async () => {
    const { slow, asked, release } = gatedService();
    service.vault.lock();
    const unlocking = slow.unlock();
    await asked;
    slow.lock();
    release();
    await expect(unlocking).rejects.toThrow(/locked by the user/);
    expect(slow.status()).toMatchObject({ unlocked: false, lockedByUser: true });
  });

  it('creating or importing an account does not lift a user lock', async () => {
    service.lock();
    await run('wallet_create', { label: 'second' });
    const secretFile = join(dir, 'pk.txt');
    await writeFile(secretFile, '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', { mode: 0o600 });
    await service.importAccount({ source: 'privateKey', secretFile, label: 'third' });
    expect(service.listAccounts()).toHaveLength(3);
    expect(service.vault.unlocked).toBe(false);
    expect(service.status().lockedByUser).toBe(true);
    await expect(service.signMessage({ account: accountId, message: 'x' }, approval)).rejects.toThrow(/locked by the user/);
  });

  it('keeps a user lock across a restart until an explicit unlock', async () => {
    service.lock();
    const reopen = async () => new WalletService(await WalletVault.open({ directory: dir, kdf: { N: 1024, r: 8, p: 1 } }), {
      vaultPath: dir, passphraseMode: 'manual', env: { [WALLET_PASSPHRASE_REF]: 'pw' }, rpcOverrides: {}, tokens: {}, createProvider: () => provider,
    });
    const restarted = await reopen();
    expect(restarted.status()).toMatchObject({ unlocked: false, lockedByUser: true });
    await expect(restarted.signMessage({ account: accountId, message: 'x' }, approval)).rejects.toThrow(/locked by the user/);
    await restarted.unlock();
    expect(restarted.status().lockedByUser).toBe(false);
    restarted.vault.lock();
    const fresh = await reopen();
    expect(fresh.status()).toMatchObject({ unlocked: false, lockedByUser: false });
    expect((await fresh.signMessage({ account: accountId, message: 'y' }, approval)).status).toBe('signed');
    fresh.vault.lock();
  });

  it('an explicit unlock that cannot clear the saved lock fails closed', async () => {
    service.vault.lock();
    await mkdir(join(dir, 'user-lock.json'));
    await expect(service.unlock()).rejects.toThrow();
    expect(service.status()).toMatchObject({ unlocked: false, lockedByUser: true });
    await rm(join(dir, 'user-lock.json'), { recursive: true });
  });

  it('reports a user lock that could not be saved, and still holds it in memory', async () => {
    const unsaved = new WalletService(service.vault, {
      vaultPath: join(dir, 'missing'), passphraseMode: 'manual', env: { [WALLET_PASSPHRASE_REF]: 'pw' }, rpcOverrides: {}, tokens: {}, createProvider: () => provider,
    });
    expect(() => unsaved.lock()).toThrow(/could not be saved/);
    expect(unsaved.status()).toMatchObject({ unlocked: false, lockedByUser: true });
    await expect(unsaved.signMessage({ account: accountId, message: 'x' }, approval)).rejects.toThrow(/locked by the user/);
  });

  it('re-opens an idle-locked vault for signing only, not for exports', async () => {
    service.vault.lock();
    await expect(service.exportKeystore(accountId, 'ks-pass')).rejects.toThrow(/wallet vault is locked/);
    expect(service.vault.unlocked).toBe(false);
  });

  it('says why when the vault cannot be re-opened automatically', async () => {
    const bare = new WalletService(service.vault, { vaultPath: dir, passphraseMode: 'manual', env: {}, rpcOverrides: {}, tokens: {}, createProvider: () => provider });
    service.vault.lock();
    await expect(bare.signMessage({ account: accountId, message: 'x' }, approval)).rejects.toThrow(/could not be unlocked automatically/);
  });

  it('never auto-signs token transfers under a native-value allow rule (power preset)', async () => {
    await service.setPolicy(policyPreset('power'));
    mockUsdc(10n ** 12n);
    approval.outcome = 'rejected';
    // A native transfer within the cap signs autonomously…
    expect((await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.001' })).status).toBe('signed-broadcast');
    // …but moving 1,000,000 USDC (value 0) must reach a human.
    const tokens = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '1000000', token: 'USDC' });
    expect(tokens.status).toBe('awaiting-approval-rejected');
    expect((tokens.decision as Record<string, unknown>).guardrail).toBe('intent-not-covered');
    expect(provider.broadcasted).toHaveLength(1);
  });

  it('always asks for unlimited approvals and shows the spender', async () => {
    mockUsdc(1n);
    approval.outcome = 'rejected';
    const result = await run('wallet_approve_token', { account: 'main', chainId: 8453, token: 'USDC', spender: BOB, amount: 'unlimited' });
    expect(result.status).toBe('awaiting-approval-rejected');
    expect(approval.requests[0]!.reason).toContain('UNLIMITED');
    expect(approval.requests[0]!.reason).toContain(BOB);
    const dry = await run('wallet_approve_token', { account: 'main', chainId: 8453, token: 'USDC', spender: BOB, amount: '10', dryRun: true });
    expect((dry.intent as Record<string, unknown>).amount).toBe('10000000');
    expect(erc20.decodeFunctionData('approve', erc20.encodeFunctionData('approve', [BOB, MaxUint256]))[1]).toBe(MaxUint256);
  });

  it('explains permits as what they are in the approval prompt', async () => {
    approval.outcome = 'rejected';
    const result = await run('wallet_sign_typed_data', {
      account: 'main',
      domain: { name: 'USD Coin', version: '2', chainId: '8453', verifyingContract: USDC_BASE },
      types: {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      },
      message: { owner: ACCOUNT_0, spender: BOB, value: MaxUint256.toString(), nonce: 0, deadline: 2_000_000_000 },
    });
    expect(result.status).toBe('awaiting-approval-rejected');
    expect((result.intent as Record<string, unknown>).kind).toBe('permit');
    expect(approval.requests[0]!.reason).toContain('PERMIT');
    expect(approval.requests[0]!.reason).toContain('UNLIMITED');
  });

  it('micropay preset: first x402 payment to a merchant asks, later small ones are automatic', async () => {
    await service.setPolicy(policyPreset('micropay'));
    const challenge = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '50000', asset: USDC_BASE, payTo: ALICE }] };
    approval.outcome = 'allowed-once';
    const first = await run('wallet_x402_authorize', { account: 'main', challenge });
    expect(first.status).toBe('signed');
    expect(approval.requests).toHaveLength(1);
    const second = await run('wallet_x402_authorize', { account: 'main', challenge });
    expect(second.status).toBe('signed');
    expect(approval.requests).toHaveLength(1); // no new prompt
    const big = { x402Version: 2, accepts: [{ scheme: 'exact', network: 'eip155:8453', amount: '5000000', asset: USDC_BASE, payTo: ALICE }] };
    approval.outcome = 'rejected';
    expect((await run('wallet_x402_authorize', { account: 'main', challenge: big })).status).toBe('awaiting-approval-rejected');
  });

  it('account removal needs approval and warns when not backed up', async () => {
    approval.outcome = 'rejected';
    const result = await run('wallet_remove_account', { account: 'main' });
    expect(result.removed).toBe(false);
    expect(approval.requests[0]!.reason).toContain('NOT been backed up');
    expect(service.listAccounts()).toHaveLength(1);
  });
});

describe('accounts and secrets', () => {
  it('derives the next HD account from an existing seed', async () => {
    const result = await run('wallet_create', { fromAccount: 'main', label: 'second' });
    expect(result.derived).toBe(true);
    expect((result.meta as Record<string, unknown>).address).toBe(ALICE);
  });

  it('reveals key material only through the panel, with a PIN step-up per reveal', async () => {
    await service.pinSetup('1234');
    await expect(service.revealSecretForUi({ account: 'main', kind: 'mnemonic' })).rejects.toThrow(/PIN/);
    await expect(service.revealSecretForUi({ account: 'main', kind: 'mnemonic', pin: '9999' })).rejects.toThrow(/incorrect/);
    const revealed = await service.revealSecretForUi({ account: 'main', kind: 'mnemonic', pin: '1234' });
    expect(revealed.value).toBe(HARDHAT_MNEMONIC);
    expect(service.listAccounts()[0]!.backedUp).toBe(true);
  });

  it('no tool result ever contains the private key or mnemonic', async () => {
    approval.outcome = 'allowed-once';
    const outputs = [
      await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01' }),
      await run('wallet_reveal_secret', { account: 'main', kind: 'privateKey' }),
      await run('wallet_reveal_secret', { account: 'main', kind: 'mnemonic' }),
      await run('wallet_create', { reveal: true }),
      await run('wallet_history', {}),
      await run('wallet_audit_log', {}),
    ];
    const serialized = JSON.stringify(outputs);
    expect(serialized).not.toContain(PRIVATE_KEY_0);
    expect(serialized).not.toContain(HARDHAT_MNEMONIC);
  });

  it('exports keystores to a 0600 file, returning only the path', async () => {
    approval.outcome = 'allowed-once';
    const result = await run('wallet_export_keystore', { account: 'main', keystorePassphrase: 'export-pass-1' });
    expect(result.exported).toBe(true);
    expect(String(result.path)).toContain(join(dir, 'exports'));
    expect(JSON.stringify(result)).not.toContain('"crypto"');
    const { stat } = await import('node:fs/promises');
    expect((await stat(String(result.path))).mode & 0o077).toBe(0);
  });
});

describe('tool surface', () => {
  it('marks read-only tools concurrency-safe and nothing else', () => {
    const safe = tools.filter((entry) => entry.isConcurrencySafe?.({}) === true).map((entry) => entry.name);
    expect(safe).toContain('wallet_balance');
    expect(safe).toContain('wallet_tx_status');
    for (const writer of ['wallet_transfer', 'wallet_send_transaction', 'wallet_sign_typed_data', 'wallet_x402_authorize', 'wallet_policy_set']) {
      expect(safe).not.toContain(writer);
    }
  });

  it('the bundled skill documents exactly the registered tools', async () => {
    const { readFile } = await import('node:fs/promises');
    const skill = await readFile(new URL('../skills/dsh-web3-wallet/SKILL.md', import.meta.url), 'utf8');
    const mentioned = new Set(skill.match(/wallet_[a-z0-9_]+/g) ?? []);
    const registered = new Set(tools.map((entry) => entry.name));
    for (const name of mentioned) expect(registered, `SKILL.md mentions unknown tool ${name}`).toContain(name);
    for (const name of registered) expect(mentioned, `tool ${name} is not documented in SKILL.md`).toContain(name);
  });

  it('every tool exposes an object-rooted JSON Schema (known types, descriptions on required params)', () => {
    const types = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object']);
    for (const entry of tools) {
      expect(entry.description.length, entry.name).toBeGreaterThan(20);
      expect(entry.parameters.type, entry.name).toBe('object');
      const required = new Set(entry.parameters.required ?? []);
      for (const name of required) expect(entry.parameters.properties, `${entry.name} requires unknown ${name}`).toHaveProperty([name]);
      for (const [key, spec] of Object.entries(entry.parameters.properties)) {
        // An untyped property is the DSL's `json` (any JSON value).
        if (spec.type !== undefined) expect(types.has(spec.type), `${entry.name}.${key}`).toBe(true);
        if (spec.type === 'array') expect(spec.items, `${entry.name}.${key} needs items`).toBeDefined();
        if (required.has(key) && spec.enum === undefined) expect(spec.description, `${entry.name}.${key}`).toBeDefined();
      }
    }
  });

  it('returns structured errors instead of throwing', async () => {
    const result = await run('wallet_balance', { account: 'nobody', chainId: 8453 });
    expect(result).toMatchObject({ ok: false, code: 'ACCOUNT_NOT_FOUND' });
    expect(String(result.hint)).toContain('wallet_list');
  });
});

describe('hard limits and the transfer whitelist', () => {
  it('refuses a transfer over a limit even when the human would approve', async () => {
    mockUsdc(50_000_000n);
    await service.setLimitsFromPanel({ ...service.limitsView().limits, usd: { perTx: '10' } });
    approval.outcome = 'allowed-once';
    const result = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '25', token: 'USDC' });
    expect(result.status).toBe('denied-by-policy');
    expect((result.decision as Record<string, unknown>).limit).toEqual({ code: 'LIMIT_EXCEEDED', name: 'usd.perTx' });
    expect(String((result.decision as Record<string, unknown>).reason)).toContain('Settings → Web3 → Limits');
    expect(approval.requests).toHaveLength(0);
    expect(provider.broadcasted).toHaveLength(0);
    const preview = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '25', token: 'USDC', dryRun: true });
    expect((preview.willRequire as Record<string, unknown>).blocked).toBe(true);
  });

  it('only pays whitelisted recipients when the whitelist is on', async () => {
    await service.setLimitsFromPanel({ ...service.limitsView().limits, whitelistOnly: true });
    approval.outcome = 'allowed-once';
    const blocked = await run('wallet_transfer', { account: 'main', chainId: 8453, to: ALICE, amount: '0.01' });
    expect(blocked.status).toBe('denied-by-policy');
    expect((blocked.decision as Record<string, unknown>).limit).toMatchObject({ code: 'RECIPIENT_NOT_WHITELISTED' });

    await service.pinSetup('1234');
    await service.upsertContactFromPanel({ label: 'Alice', address: ALICE, trusted: true }, '1234');
    const paid = await run('wallet_transfer', { account: 'main', chainId: 8453, to: 'Alice', amount: '0.01' });
    expect(paid.status).toBe('signed-broadcast');
    // Own accounts are always on the whitelist.
    const self = await run('wallet_transfer', { account: 'main', chainId: 8453, to: 'main', amount: '0.01', dryRun: true });
    expect((self.willRequire as Record<string, unknown>).blocked).toBe(false);
  });

  it('tightens freely but needs a configured PIN to loosen', async () => {
    const strict = { ...service.limitsView().limits, usd: { perTx: '10' } };
    await service.setLimitsFromPanel(strict);
    await expect(service.setLimitsFromPanel({ ...strict, usd: { perTx: '1000' } })).rejects.toMatchObject({ code: 'PIN_SETUP_REQUIRED' });
    await service.pinSetup('1234');
    await expect(service.setLimitsFromPanel({ ...strict, usd: {} })).rejects.toMatchObject({ code: 'PIN_REQUIRED' });
    await expect(service.setLimitsFromPanel({ ...strict, usd: {} }, '9999')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    await service.setLimitsFromPanel({ ...strict, usd: {} }, '1234');
    expect(service.limitsView().limits.usd).toEqual({});
    await expect(service.setLimitsFromPanel({ ...strict, usd: { perTx: 'lots' } })).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('whitelisting or re-pointing a contact needs the PIN; the agent cannot touch whitelisted contacts', async () => {
    await expect(service.upsertContactFromPanel({ label: 'Alice', address: ALICE, trusted: true })).rejects.toMatchObject({ code: 'PIN_SETUP_REQUIRED' });
    await service.upsertContactFromPanel({ label: 'Alice', address: ALICE }); // plain contact: no PIN
    await service.pinSetup('1234');
    await expect(service.upsertContactFromPanel({ label: 'Alice', address: BOB })).rejects.toMatchObject({ code: 'PIN_REQUIRED' });
    await service.setContactTrustedFromPanel('Alice', true, '1234');
    approval.outcome = 'allowed-once';
    const hijack = await run('wallet_address_book', { action: 'add', label: 'alice', address: BOB });
    expect(hijack).toMatchObject({ ok: false, code: 'USE_PANEL' });
    expect(service.addressBookList()[0]).toMatchObject({ address: ALICE, trusted: true });
    await service.setContactTrustedFromPanel('Alice', false); // un-whitelisting is free
    expect(service.limitsView().whitelist).toHaveLength(0);
  });
});

describe('policy changes: tighten from chat, loosen in the panel', () => {
  it('wallet_policy_set redirects loosening and custom documents to the panel', async () => {
    approval.outcome = 'allowed-once';
    const loosen = await run('wallet_policy_set', { preset: 'power' });
    expect(loosen).toMatchObject({ updated: false, status: 'use-panel' });
    const custom = await run('wallet_policy_set', { policy: { version: 1, defaultEffect: 'allow', rules: [] } });
    expect(custom).toMatchObject({ updated: false, status: 'use-panel' });
    expect(approval.requests).toHaveLength(0);
    expect((await run('wallet_policy_get', {})).preset).toBe('strict');
    const lock = await run('wallet_policy_set', { preset: 'locked' });
    expect(lock).toMatchObject({ updated: true, preset: 'locked' });
    // locked → strict loosens again: panel only.
    expect(await run('wallet_policy_set', { preset: 'strict' })).toMatchObject({ status: 'use-panel' });
  });

  it('the panel switches presets, asking for the PIN unless the change tightens', async () => {
    await expect(service.applyPresetFromPanel('micropay')).rejects.toMatchObject({ code: 'PIN_SETUP_REQUIRED' });
    await service.pinSetup('1234');
    await expect(service.applyPresetFromPanel('micropay', '0000')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    expect(await service.applyPresetFromPanel('micropay', '1234')).toMatchObject({ preset: 'micropay', tightening: false });
    expect(await service.applyPresetFromPanel('strict')).toMatchObject({ preset: 'strict', tightening: true });
    expect((await run('wallet_policy_get', {})).preset).toBe('strict');
  });
});

describe('settings-panel secrets', () => {
  it('requires a configured PIN before revealing, exporting, or removing', async () => {
    await expect(service.revealSecretForUi({ account: 'main', kind: 'mnemonic' })).rejects.toMatchObject({ code: 'PIN_SETUP_REQUIRED' });
    await expect(service.exportKeystoreFromPanel('main', 'export-pass-1')).rejects.toMatchObject({ code: 'PIN_SETUP_REQUIRED' });
    await expect(service.removeAccountFromPanel('main')).rejects.toMatchObject({ code: 'PIN_SETUP_REQUIRED' });
    await service.pinSetup('1234');
    await service.unlock();
    const exported = await service.exportKeystoreFromPanel('main', 'export-pass-1', '1234');
    expect(exported.address).toBe(ACCOUNT_0);
    expect(Object.keys(JSON.parse(exported.json)).map((key) => key.toLowerCase())).toContain('crypto');
    await expect(service.exportKeystoreFromPanel('main', 'short', '1234')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('sets the PIN authorization length: shortening is free, lengthening needs the PIN', async () => {
    await service.pinSetup('1234');
    expect((await service.pinStatus()).grantDays).toBe(1);
    await expect(service.setPinGrantDaysFromPanel(7)).rejects.toMatchObject({ code: 'PIN_REQUIRED' });
    await expect(service.setPinGrantDaysFromPanel(7, '9999')).rejects.toMatchObject({ code: 'PIN_INVALID' });
    const lengthened = await service.setPinGrantDaysFromPanel(30, '1234');
    expect(lengthened).toMatchObject({ grantDays: 30, authorized: true });
    expect(Date.parse(lengthened.authorizedUntil!) - Date.now()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    const shortened = await service.setPinGrantDaysFromPanel(1);
    expect(shortened).toMatchObject({ grantDays: 1 });
    await expect(service.setPinGrantDaysFromPanel(14 as 1)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('renames accounts for display only', async () => {
    const meta = await service.renameAccount('main', 'Daily');
    expect(meta).toMatchObject({ label: 'Daily', address: ACCOUNT_0 });
    await expect(service.renameAccount('Daily', '')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });
});

describe('tool cards', () => {
  it('titles calls with the salient input, like built-in DSH tools', () => {
    expect(tool('wallet_transfer').presentCall?.({ amount: '25', token: 'USDC', to: ALICE, chainId: 8453 })).toEqual({
      card: 'generic',
      title: '25 USDC → 0x7099…79C8 · Base',
      kind: 'execute',
    });
    expect(tool('wallet_transfer').presentCall?.({ amount: '1', to: 'vitalik.eth', chainId: 1, dryRun: true })?.title).toBe('Preview 1 native → vitalik.eth · Ethereum');
    expect(tool('wallet_balance').presentCall?.({ account: 'main', chainId: 8453 })).toMatchObject({ kind: 'read' });
    for (const entry of tools) expect(entry.presentCall, `${entry.name} has no card title`).toBeDefined();
  });
});
