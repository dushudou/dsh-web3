/**
 * The `wallet` service (`ctx.wallet`): the full programmatic API other
 * plugins and the model tools share. Tools add approval gating; the service
 * itself is the honest surface.
 *
 * Every state-changing on-chain operation goes through one pipeline:
 *
 * ```text
 * prepare  resolve recipient/token/amount → populate → decode intent →
 *          preflight (balance, revert) → policy dry-run → security checks
 *          (denylist, sanctions, simulation, look-alikes …) → escalate
 *          → returns a single-use preparedId + human summary
 * execute  (per-account lock) re-populate fees/nonce → policy → security
 *          re-check → PIN gate → human approval (when `ask`) → sign →
 *          journal → broadcast
 * ```
 *
 * so what the user reviewed is exactly what gets signed, retries are safe
 * (single-use ids, idempotency keys, journal-before-broadcast), and the
 * human is never asked to approve something the PIN gate would then block.
 *
 * @module dsh-web3/service
 */

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { MaxUint256, TypedDataEncoder, getAddress, formatEther, formatUnits, hashMessage, keccak256 } from 'ethers';
import { randomBytes, randomUUID } from 'node:crypto';
import type { TypedDataDomain, TypedDataField } from 'ethers';
import { pinPepper, type SecretStore } from './keychain.js';
import {
  JsonRpcChainProvider,
  PIN_GRANT_DAYS,
  PinGuard,
  type PinGrantDays,
  WalletVault,
  VaultLockedError,
  accountBalances,
  classifyTransaction,
  classifyTypedData,
  encodeErc20Approve,
  encodeErc20Transfer,
  explorerUrl,
  findKnownToken,
  formatNative,
  getChain,
  knownTokens,
  normalizeChainId,
  populateTransaction,
  signMessage as coreSignMessage,
  signTransaction as coreSignTransaction,
  signTypedData as coreSignTypedData,
  describeTransaction,
  assertNoSecrets,
  escalateDecision,
  finding,
  isTighteningSecurity,
  normalizeSecuritySettings,
  runSecurityChecks,
  severityMark,
  severityRank,
  validateSecuritySettings,
  type CheckRun,
  type DenylistEntry,
  type FeedFetcher,
  type RiskFinding,
  type RiskSeverity,
  type SecuritySettings,
  type SecuritySubject,
  type SimulationSummary,
  checkLimits,
  detectPreset,
  intentOf,
  isTighteningLimits,
  limitUsage,
  normalizeLimits,
  policyPreset,
  type AccountMeta,
  type AddressBookEntry,
  type PolicyPresetId,
  type WalletLimits,
  type ChainProvider,
  type Intent,
  type JournalEntry,
  type PinStatus,
  type PolicyDecision,
  type PolicyRequest,
  type PopulatedTransaction,
  type SigningPolicy,
  type TokenSpec,
  type TransactionRequestInput,
} from 'dsh-web3-core';
import { WalletError, isDefinitiveRejection } from './errors.js';
import { buildRiskChecks, type JsonFetcher, type SecurityDeps, type SecurityHints } from './security.js';
import {
  formatAmount,
  lookAlikeOf,
  parseAmount,
  resolveAsset,
  resolveRecipient,
  tokenAllowance,
  tokenBalanceOf,
  tokenEip712Domain,
  type ResolvedAsset,
  type ResolvedRecipient,
} from './assets.js';

/** The approval seam tools route `ask` decisions through. */
export interface ApprovalGateway {
  /** Request a one-shot human approval. Returns the outcome vocabulary.
   *  `agent` is the DSH agent object (ToolExecutionInput.agent) — the host
   *  approval service derives the requesting session from `req.agent.session`. */
  request(input: {
    toolName: string;
    reason: string;
    callId?: string;
    signal?: AbortSignal;
    agent?: unknown;
  }): Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
}

/** Where a resolved provider came from, for diagnostics. */
export interface ResolvedProvider {
  provider: ChainProvider;
  chainId: number;
  rpcUrl: string;
  custom: boolean;
}

/** Tool-call context threaded into approvals. */
export interface CallContext {
  toolName: string;
  callId?: string;
  signal?: AbortSignal;
  agent?: unknown;
}

/** Audit fields that tie one signing request's entries together (see `signTrail`). */
interface SignTrail {
  requestId: string;
  /** Tool or caller that started the request. */
  via: string;
  callId?: string;
  /** Signing policy preset in force (`custom` when edited by hand). */
  preset: PolicyPresetId | 'custom';
}

/** Security checks for one operation (see dsh-web3/security). */
export interface SecurityView {
  /** Strongest finding, or `none`. */
  severity: RiskSeverity | 'none';
  /** Findings, strongest first. */
  findings: RiskFinding[];
  checks: CheckRun[];
  /** Decoded simulation (transactions on RPCs that support eth_simulateV1). */
  simulation?: SimulationSummary;
}

/** What `sendTransaction` / `executePrepared` did and produced. */
export interface SendResult {
  status:
    | 'signed-broadcast'
    | 'awaiting-approval-rejected'
    | 'denied-by-policy'
    | 'unavailable-approver'
    /** Held for the user: above the automatic budget in semi-managed mode. Nothing was signed. */
    | 'needs-human'
    /** Signed, but the node's answer was lost: DO NOT resend — check wallet_tx_status. */
    | 'broadcast-uncertain'
    /** The node rejected the signed transaction; nothing was sent. */
    | 'rejected-by-node'
    /** This preparedId / idempotencyKey was already executed; nothing new was sent. */
    | 'already-submitted';
  decision?: PolicyDecision;
  approvalOutcome?: string;
  txHash?: string;
  human?: ReturnType<typeof describeTransaction>;
  explorerUrl?: string;
  raw?: string;
  /** One-line human description of what was (or would have been) sent. */
  summary?: string;
  /** Suggested next step for an agent. */
  next?: string;
  error?: string;
  /** Security checks run right before signing. */
  security?: SecurityView;
}

/** What message signing did and produced. */
export interface SignMessageResult {
  status: 'signed' | 'awaiting-approval-rejected' | 'denied-by-policy' | 'unavailable-approver' | 'needs-human';
  decision: PolicyDecision;
  approvalOutcome?: string;
  signature?: string;
  address: string;
  intent?: Intent;
  security?: SecurityView;
}

/** The dry-run view of a prepared operation (what the model shows the user). */
export interface PreparedView {
  status: 'prepared';
  preparedId: string;
  expiresAt: string;
  summary: string;
  chainId: number;
  chainName?: string;
  from: string;
  to: string;
  valueWei: string;
  intent: Intent & { amountFormatted?: string; symbol?: string };
  recipient?: ResolvedRecipient;
  fee: { gasLimit: string; maxFee: string };
  decision: PolicyDecision;
  /** `aboveAutoBudget`: semi-managed mode will hold it (`needs-human`) instead of signing. */
  willRequire: { humanApproval: boolean; dailyPin: boolean; blocked: boolean; aboveAutoBudget: boolean };
  /** Every finding as one line (strongest first); kept for older callers. */
  warnings: string[];
  /** Structured security findings, simulation, and per-check status. */
  security: SecurityView;
  human: ReturnType<typeof describeTransaction>;
  next: string;
}

export interface WalletServiceOptions {
  vaultPath: string;
  autoLockMs?: number;
  passphraseMode: 'auto' | 'env' | 'manual';
  env: Record<string, string | undefined>;
  credentials?: {
    resolve(ref: string): Promise<{ value?: string; source?: string } | undefined>;
    set(ref: string, value: string): Promise<void>;
    unset?(ref: string): Promise<void>;
  };
  rpcOverrides: Record<string, string>;
  tokens: Record<string, TokenSpec[]>;
  /** Provider factory override (tests inject an in-memory provider). */
  createProvider?: (chainId: number, rpcUrl?: string) => ChainProvider;
  /** OS secret store (macOS Keychain) for the vault passphrase and PIN pepper. */
  keychain?: SecretStore;
  /** Mirrors the `unsafeAllowModelSecretReveal` plugin flag (shown read-only in the panel). */
  allowModelSecretReveal?: boolean;
  /** GoPlus fetch override (tests). */
  fetchJson?: JsonFetcher;
  /** Denylist feed download override (tests). */
  feedFetcher?: FeedFetcher;
}

/** A prepared, not-yet-executed operation. */
interface Plan {
  id: string;
  expiresAt: number;
  account: AccountMeta;
  chainId: number;
  request: Omit<TransactionRequestInput, 'from' | 'chainId'> & { to: string; value: bigint; data: string };
  intent: Intent;
  asset?: ResolvedAsset;
  recipient?: ResolvedRecipient;
  headline: string;
  /** Pipeline notes ("max", unverified decimals …) folded into every report. */
  notes: RiskFinding[];
  /** Latest security report and when it ran. */
  security: SecurityView;
  securityAt: number;
  idempotencyKey?: string;
  /** Hash of the transaction this plan replaces (speed-up / cancel). */
  replaces?: string;
  result?: SendResult;
}

const PREPARED_TTL_MS = 15 * 60_000;
/** A security report this fresh is reused at execution (one-shot transfers). */
const SECURITY_REUSE_MS = 30_000;
/** Minimum fee bump for a replacement transaction (geth requires +10%). */
const REPLACEMENT_BUMP_PERCENT = 15n;

/** Default vault location: `~/.dsh-web3` (plugin-owned home dot-dir). */
export function defaultVaultPath(): string {
  return resolve(join(homedir(), '.dsh-web3'));
}

/** The wallet service mounted as `ctx.wallet`. */
export class WalletService {
  readonly vault: WalletVault;
  /** Daily-PIN gate for sensitive operations (transfers, signing, export). */
  readonly pin: PinGuard;
  private readonly options: WalletServiceOptions;
  private providers = new Map<number, ChainProvider>();
  private pinReady: Promise<void>;
  private plans = new Map<string, Plan>();
  /** Per-account execution chain: serializes nonce assignment. */
  private accountLocks = new Map<string, Promise<unknown>>();
  /** TTL cache for network security lookups (sanctions oracle, GoPlus). */
  private securityCache = new Map<string, { at: number; value: unknown }>();
  /** Set by lock() (the user via the panel or wallet_lock), cleared by an explicit unlock. Mirrored in USER_LOCK_FILE. */
  private lockedByUser = false;
  /** Bumped by every lock(): an unlock that started before it must not survive it. */
  private lockEpoch = 0;
  /** In-flight automatic unlock, shared by concurrent signing requests. */
  private autoUnlocking: Promise<void> | undefined;

  constructor(vault: WalletVault, options: WalletServiceOptions) {
    this.vault = vault;
    this.options = options;
    const keychain = options.keychain;
    this.pin = new PinGuard(options.vaultPath, keychain === undefined ? {} : { pepper: (create) => pinPepper(keychain, create) });
    this.pinReady = this.pin.load();
  }

  /** Await PIN load and require a PIN authorization in force (throws when gated). */
  private async pinGate(): Promise<void> {
    await this.pinReady;
    this.pin.requireAuthorized();
  }

  // ── vault ───────────────────────────────────────────────────────────────

  /** Vault status snapshot. */
  status(): ReturnType<WalletVault['status']> & { lockedByUser: boolean } {
    this.vault.maybeAutoLock();
    // Only a user lock stops signing; an idle lock re-opens on the next signature.
    return { ...this.vault.status(), lockedByUser: !this.vault.unlocked && this.userLocked() };
  }

  /** List accounts (metadata only). */
  listAccounts(): AccountMeta[] {
    return this.vault.listAccounts();
  }

  /** Unlock the vault using the passphrase resolution chain. */
  async unlock(passphraseFile?: string, trigger?: 'signing'): Promise<{ source: string }> {
    const epoch = this.lockEpoch;
    const { passphraseFromFile } = await import('./passphrase.js');
    let passphrase: string;
    let source: string;
    if (passphraseFile !== undefined) {
      passphrase = await passphraseFromFile(passphraseFile);
      source = 'file';
    } else {
      const resolved = await this.resolveStoredPassphrase();
      passphrase = resolved.passphrase;
      source = resolved.source;
    }
    // Only an explicit unlock lifts the user's lock; signing never reaches here while it is set.
    if (!(await this.openVault(passphrase, epoch, trigger === undefined))) throw new VaultLockedError(LOCKED_BY_USER);
    await this.vault.auditAppend('vault.unlocked', { source, ...(trigger !== undefined ? { trigger } : {}) });
    return { source };
  }

  /**
   * Decrypt the keys unless lock() ran since `epoch`; then the keys are dropped
   * again and false is returned. `liftUserLock` clears the user's lock in the
   * same synchronous step as the epoch check, so a later lock() always wins.
   */
  private async openVault(passphrase: string, epoch: number, liftUserLock = false): Promise<boolean> {
    await this.vault.unlock(passphrase);
    if (epoch !== this.lockEpoch) {
      this.vault.lock();
      return false;
    }
    if (liftUserLock) {
      try {
        rmSync(join(this.options.vaultPath, USER_LOCK_FILE), { force: true });
      } catch (error) {
        // A marker left behind would lock again after a restart: fail closed.
        this.vault.lock();
        throw error;
      }
      this.lockedByUser = false;
    }
    return true;
  }

  /** Whether the user locked the vault — in this process or before a restart. */
  private userLocked(): boolean {
    return this.lockedByUser || existsSync(join(this.options.vaultPath, USER_LOCK_FILE));
  }

  /** Require an unlocked vault (account management, exports). */
  private requireUnlocked(): void {
    this.vault.maybeAutoLock();
    this.vault.ensureUnlocked();
  }

  /**
   * Require an unlocked vault for signing, before any PIN check or approval
   * prompt. A vault that locked itself (idle timeout, host restart) is
   * re-opened from the stored passphrase — the agent could call wallet_unlock
   * anyway, and policy, limits, PIN and approvals still apply. A lock the user
   * chose stays, across restarts, until an explicit unlock: signing fails with
   * a message saying who has to unlock.
   */
  private async requireSigningUnlocked(): Promise<void> {
    this.vault.maybeAutoLock();
    if (!this.vault.unlocked) {
      if (this.userLocked()) throw new VaultLockedError(LOCKED_BY_USER);
      this.autoUnlocking ??= this.unlock(undefined, 'signing')
        .then(() => undefined)
        .finally(() => (this.autoUnlocking = undefined));
      try {
        await this.autoUnlocking;
      } catch (error) {
        throw error instanceof VaultLockedError ? error : new VaultLockedError(lockedAutoFailed(error));
      }
      if (!this.vault.unlocked && this.userLocked()) throw new VaultLockedError(LOCKED_BY_USER);
    }
    this.vault.ensureUnlocked();
  }

  /** Lock the vault (zeroize decrypted key material) and revoke PIN authorization. */
  lock(): void {
    this.lockEpoch += 1;
    this.lockedByUser = true;
    this.vault.lock();
    void this.pinReady.then(() => this.pin.clearDaily()).catch(() => undefined);
    try {
      writeFileSync(join(this.options.vaultPath, USER_LOCK_FILE), JSON.stringify({ lockedAt: new Date().toISOString() }), { mode: 0o600 });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`The wallet is locked, but the lock could not be saved (${reason}): it lasts until DSH restarts.`);
    }
  }

  // ── PIN gate ──────────────────────────────────────────────────────

  /** PIN gate status (secret-free). */
  async pinStatus(): Promise<PinStatus> {
    await this.pinReady;
    return this.pin.status();
  }

  /** Verify a PIN (UI-only path; the PIN never enters model context). */
  async pinVerify(pin: string): Promise<{ ok: boolean; status: PinStatus }> {
    await this.pinReady;
    return this.pin.verify(pin);
  }

  /** Configure an initial PIN (UI-only). */
  async pinSetup(pin: string): Promise<PinStatus> {
    await this.pinReady;
    await this.pin.setup(pin);
    return this.pin.status();
  }

  /** Change the PIN after verifying the current one (UI-only). */
  async pinChange(current: string, next: string): Promise<PinStatus> {
    await this.pinReady;
    await this.pin.changePin(current, next);
    return this.pin.status();
  }

  /** Revoke the current authorization (manual lock / UI). */
  async pinClearDaily(): Promise<PinStatus> {
    await this.pinReady;
    await this.pin.clearDaily();
    return this.pin.status();
  }

  /**
   * Settings panel: how long one PIN entry authorizes sensitive operations.
   * Shortening needs no PIN; lengthening is a step-up, like any loosening.
   */
  async setPinGrantDaysFromPanel(days: PinGrantDays, pin?: string): Promise<PinStatus> {
    await this.pinReady;
    if (!PIN_GRANT_DAYS.includes(days)) throw new WalletError('INVALID_ARGUMENT', 'PIN authorization must be 1, 7 or 30 days');
    const current = this.pin.grantDays;
    const lengthening = days > current;
    if (lengthening) await this.stepUp(pin, `lengthen the PIN authorization to ${days} days`);
    await this.pin.setGrantDays(days);
    await this.vault.auditAppend('pin.grant', { via: 'panel', days, previousDays: current, lengthening });
    return this.pin.status();
  }

  // ── accounts ────────────────────────────────────────────────────────────

  /** Create a fresh HD account. The mnemonic is returned ONCE (never stored
   *  in plaintext, never logged); callers must gate display on approval. */
  async createAccount(input: { label?: string; words?: 12 | 15 | 18 | 21 | 24 } = {}): Promise<{ meta: AccountMeta; mnemonic: string }> {
    const epoch = this.lockEpoch;
    const passphrase = await this.effectivePassphrase();
    const result = await this.vault.createAccount(input, passphrase);
    // A user lock stays: the new key file is written, the vault is not opened.
    if (!this.vault.unlocked && !this.userLocked()) await this.openVault(passphrase, epoch);
    return result;
  }

  /** Derive the next HD account from an existing account's seed ("Add account"). */
  async deriveAccount(input: { fromAccount: string; label?: string; index?: number }): Promise<{ meta: AccountMeta }> {
    this.requireUnlocked();
    const source = this.vault.requireAccount(input.fromAccount);
    return await this.vault.deriveAccount({
      fromAccountId: source.id,
      ...(input.label !== undefined ? { label: input.label } : {}),
      ...(input.index !== undefined ? { index: input.index } : {}),
    });
  }

  /** Import an account from secret material held in a file (never tool args). */
  async importAccount(input: {
    source: 'mnemonic' | 'privateKey' | 'keystore';
    secretFile: string;
    keystorePassphraseFile?: string;
    label?: string;
    index?: number;
  }): Promise<{ meta: AccountMeta }> {
    const { readSecretFile } = await import('./secretFile.js');
    const epoch = this.lockEpoch;
    const passphrase = await this.effectivePassphrase();
    const secret = await readSecretFile(input.secretFile);
    let result: { meta: AccountMeta };
    if (input.source === 'mnemonic') {
      result = await this.vault.importMnemonic(
        { mnemonic: secret, label: input.label, index: input.index },
        passphrase,
      );
    } else if (input.source === 'privateKey') {
      result = await this.vault.importPrivateKey({ privateKey: secret, label: input.label }, passphrase);
    } else {
      if (input.keystorePassphraseFile === undefined) {
        throw new Error('keystore import requires keystorePassphraseFile');
      }
      const keystorePassphrase = await readSecretFile(input.keystorePassphraseFile);
      result = await this.vault.importKeystore(
        { keystoreJson: secret, keystorePassphrase, label: input.label },
        passphrase,
      );
    }
    if (!this.vault.unlocked && !this.userLocked()) await this.openVault(passphrase, epoch);
    return result;
  }

  /** The passphrase to use for new key material: the live one when unlocked,
   *  otherwise the resolution chain. Keeps every key file decryptable by the
   *  passphrase the vault currently holds. */
  private async effectivePassphrase(): Promise<string> {
    if (this.vault.unlocked) {
      const current = this.vault.currentPassphrase();
      if (current !== undefined) return current;
    }
    return (await this.resolveStoredPassphrase()).passphrase;
  }

  /** Run the passphrase resolution chain; audits a keychain migration. */
  private async resolveStoredPassphrase(): Promise<{ passphrase: string; source: string }> {
    const { resolvePassphrase } = await import('./passphrase.js');
    const resolved = await resolvePassphrase(this.options.passphraseMode, this.options.env, this.options.credentials, {
      ...(this.options.keychain !== undefined ? { keychain: this.options.keychain } : {}),
      allowGenerate: this.vault.listAccounts().length === 0,
    });
    if (resolved.migrated === true) {
      await this.vault.auditAppend('passphrase.migrated', { from: 'credentials-file', to: 'keychain' });
    }
    return resolved;
  }

  /** Remove an account after approval + PIN authorization. */
  async removeAccount(accountId: string): Promise<AccountMeta> {
    await this.pinGate();
    return await this.vault.removeAccount(accountId);
  }

  // ── chain providers ─────────────────────────────────────────────────────

  /**
   * Resolve a provider for a chain (cached). Public free RPC endpoints change
   * often, so when no custom RPC override is configured the first *reachable*
   * built-in endpoint is picked (one-time per chain, then cached).
   */
  async providerFor(chainId: number | string): Promise<ResolvedProvider> {
    // Normalize: model arguments may arrive as a numeric string ("1").
    const id = requireChainId(chainId);
    const cached = this.providers.get(id);
    if (cached !== undefined) {
      return { provider: cached, chainId: id, rpcUrl: (cached as unknown as { __rpcUrl?: string }).__rpcUrl ?? '', custom: true };
    }
    const custom = this.options.rpcOverrides[String(id)];
    const chain = getChain(id);
    if (custom === undefined && chain === undefined && this.options.createProvider === undefined) {
      throw new WalletError(
        'UNKNOWN_CHAIN',
        `unknown chain ${String(id)}`,
        'Call wallet_chains for supported chain ids, or add an rpc override in the wallet plugin config.',
      );
    }
    let rpcUrl: string | undefined;
    if (this.options.createProvider !== undefined) {
      rpcUrl = custom ?? chain?.rpc[0];
      const provider = this.options.createProvider(id, rpcUrl);
      (provider as unknown as { __rpcUrl?: string }).__rpcUrl = rpcUrl ?? '';
      this.providers.set(id, provider);
      return { provider, chainId: id, rpcUrl: rpcUrl ?? '', custom: custom !== undefined };
    }
    const candidates = custom !== undefined ? [custom] : chain?.rpc ?? [];
    const { pickReachableRpc } = await import('dsh-web3-core');
    rpcUrl = await pickReachableRpc(candidates);
    const provider = JsonRpcChainProvider.forChainId(id, rpcUrl);
    (provider as unknown as { __rpcUrl?: string }).__rpcUrl = rpcUrl ?? '';
    this.providers.set(id, provider);
    return {
      provider,
      chainId: id,
      rpcUrl: rpcUrl ?? '',
      custom: custom !== undefined,
    };
  }

  /** Watch tokens configured for a chain (UI balances). */
  tokensFor(chainId: number): TokenSpec[] {
    return this.options.tokens[String(chainId)] ?? [];
  }

  /**
   * Native + token balances for an account on a chain. `tokens` (symbols or
   * addresses) narrows the list; by default configured + well-known tokens
   * are queried.
   */
  async balances(account: AccountMeta, chainId: number | string, tokens?: string[]): Promise<{
    chainId: number;
    chainName?: string;
    native: { symbol: string; balanceWei: string; formatted: string };
    tokens: Array<{ address: string; symbol?: string; balance: string; formatted?: string; decimals?: number }>;
  }> {
    this.vault.maybeAutoLock();
    const id = requireChainId(chainId);
    const { provider } = await this.providerFor(id);
    let specs: TokenSpec[];
    if (tokens !== undefined && tokens.length > 0) {
      specs = [];
      for (const ref of tokens) {
        const configured = this.tokensFor(id).find((spec) => spec.address.toLowerCase() === ref.toLowerCase() || spec.symbol?.toLowerCase() === ref.toLowerCase());
        const known = findKnownToken(id, ref);
        if (configured !== undefined) specs.push(configured);
        else if (known !== undefined) specs.push({ address: known.address, symbol: known.symbol, decimals: known.decimals });
        else if (/^0x[0-9a-fA-F]{40}$/.test(ref)) specs.push({ address: getAddress(ref) });
        else throw new WalletError('UNKNOWN_TOKEN', `token "${ref}" is not known on chain ${String(id)}`, 'Pass the token contract address instead.');
      }
    } else {
      const configured = this.tokensFor(id);
      const seen = new Set(configured.map((spec) => spec.address.toLowerCase()));
      specs = [
        ...configured,
        ...knownTokens(id)
          .filter((token) => !seen.has(token.address.toLowerCase()))
          .map((token) => ({ address: token.address, symbol: token.symbol, decimals: token.decimals })),
      ];
    }
    const result = await accountBalances(provider, account.address, specs);
    const chain = getChain(id);
    return {
      chainId: id,
      ...(chain !== undefined ? { chainName: chain.name } : {}),
      native: { symbol: chain?.symbol ?? 'ETH', balanceWei: result.native.balanceWei, formatted: result.native.formatted },
      tokens: result.tokens.map((token) => ({
        address: token.address,
        ...(token.symbol !== undefined ? { symbol: token.symbol } : {}),
        ...(token.decimals !== undefined ? { decimals: token.decimals } : {}),
        balance: token.balance.toString(),
        ...(token.formatted !== undefined ? { formatted: token.formatted } : {}),
      })),
    };
  }

  /** Current ERC-20 allowance granted by an account to a spender. */
  async allowance(input: { account: string; chainId: number | string; token: string; spender: string }): Promise<{
    token: string;
    symbol: string;
    spender: string;
    allowance: string;
    formatted: string;
    unlimited: boolean;
  }> {
    const meta = this.vault.requireAccount(input.account);
    const id = requireChainId(input.chainId);
    const { provider } = await this.providerFor(id);
    const asset = await resolveAsset(provider, id, input.token, this.tokensFor(id));
    if (asset.kind !== 'erc20') throw new WalletError('INVALID_ARGUMENT', 'native coins have no allowances');
    const spender = await this.resolveAddressOnly(input.spender, id);
    const value = await tokenAllowance(provider, asset.address, meta.address, spender);
    if (value === undefined) throw new WalletError('RPC_ERROR', 'could not read allowance from the token contract');
    return {
      token: asset.address,
      symbol: asset.symbol,
      spender,
      allowance: value.toString(),
      formatted: formatAmount(value, asset.decimals, asset.symbol),
      unlimited: value >= 2n ** 128n,
    };
  }

  // ── address book ────────────────────────────────────────────────────────

  addressBookList(): ReturnType<WalletVault['addressBook']['list']> {
    return this.vault.addressBook.list();
  }

  async addressBookAdd(input: { label: string; address: string; note?: string; chainIds?: number[] }) {
    const existing = this.vault.addressBook.get(input.label);
    if (existing?.trusted === true) {
      throw new WalletError(
        'USE_PANEL',
        `"${existing.label}" is on the transfer whitelist; whitelisted contacts can only be edited in DSH Settings → Web3 → Limits`,
        'Ask the user to edit this contact in the settings panel. Do not save it under another label.',
      );
    }
    try {
      const entry = await this.vault.addressBook.upsert(input);
      await this.vault.auditAppend('addressbook.upsert', { label: entry.label, address: entry.address });
      return entry;
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
    }
  }

  async addressBookRemove(label: string) {
    const removed = await this.vault.addressBook.remove(label);
    if (removed !== undefined) await this.vault.auditAppend('addressbook.remove', { label: removed.label, address: removed.address });
    return removed;
  }

  // ── prepare: resolve + preflight + policy dry-run ───────────────────────

  /**
   * Prepare a native or ERC-20 transfer from human inputs.
   * `amount` is a decimal string in whole units ("0.05"), or "max".
   */
  async prepareTransfer(input: {
    account: string;
    chainId: number | string;
    to: string;
    amount: string;
    token?: string;
    idempotencyKey?: string;
  }): Promise<PreparedView> {
    this.vault.maybeAutoLock();
    const account = this.vault.requireAccount(input.account);
    const chainId = requireChainId(input.chainId);
    const { provider } = await this.providerFor(chainId);
    const recipient = await this.recipientFor(input.to, chainId);
    const asset = await resolveAsset(provider, chainId, input.token, this.tokensFor(chainId));
    const isMax = String(input.amount).trim().toLowerCase() === 'max';
    const notes: RiskFinding[] = [];

    let request: Plan['request'];
    if (asset.kind === 'native') {
      let value: bigint;
      const pinned: Partial<Plan['request']> = {};
      if (isMax) {
        // Pin gas + fees so the execution-time re-population cannot push the
        // total above the balance.
        const probe = await populateTransaction({ from: account.address, chainId, to: recipient.address, value: 0n }, provider);
        const cost = probe.gasLimit * (probe.maxFeePerGas ?? probe.gasPrice ?? 0n);
        const balance = await provider.getBalance(account.address);
        value = balance - cost;
        if (value <= 0n) {
          throw new WalletError('INSUFFICIENT_FUNDS', `balance ${formatAmount(balance, asset.decimals, asset.symbol)} does not cover the network fee`);
        }
        Object.assign(pinned, {
          gasLimit: probe.gasLimit,
          ...(probe.maxFeePerGas !== undefined ? { maxFeePerGas: probe.maxFeePerGas, maxPriorityFeePerGas: probe.maxPriorityFeePerGas } : {}),
          ...(probe.gasPrice !== undefined ? { gasPrice: probe.gasPrice, type: 0 as const } : {}),
        });
        notes.push(finding('prepare', 'MAX_AMOUNT', 'info', `"max" sends the whole balance minus the network fee (${formatAmount(value, asset.decimals, asset.symbol)})`));
      } else {
        value = parseAmount(input.amount, asset.decimals, asset.symbol);
      }
      request = { to: recipient.address, value, data: '0x', ...pinned };
    } else {
      if (recipient.address.toLowerCase() === asset.address.toLowerCase()) {
        throw new WalletError('BLOCKED', `recipient is the ${asset.symbol} token contract itself; tokens sent there are lost`, 'Ask the user for the real recipient address.');
      }
      let amount: bigint;
      if (isMax) {
        const balance = await tokenBalanceOf(provider, asset.address, account.address);
        if (balance === undefined || balance === 0n) throw new WalletError('INSUFFICIENT_FUNDS', `no ${asset.symbol} balance to send`);
        amount = balance;
      } else {
        amount = parseAmount(input.amount, asset.decimals, asset.symbol);
      }
      request = { to: asset.address, value: 0n, data: encodeErc20Transfer(recipient.address, amount) };
      if (!asset.verified) {
        notes.push(finding('prepare', 'UNVERIFIED_DECIMALS', 'warn', `could not verify ${asset.symbol} decimals on-chain; using ${asset.source} metadata (${String(asset.decimals)})`, asset.address));
      }
    }

    return await this.plan({ account, chainId, request, asset, recipient, notes, idempotencyKey: input.idempotencyKey });
  }

  /** Prepare an ERC-20 approval (`amount`: decimal, "0" to revoke, or "unlimited"). */
  async prepareApprove(input: { account: string; chainId: number | string; token: string; spender: string; amount: string }): Promise<PreparedView> {
    this.vault.maybeAutoLock();
    const account = this.vault.requireAccount(input.account);
    const chainId = requireChainId(input.chainId);
    const { provider } = await this.providerFor(chainId);
    const asset = await resolveAsset(provider, chainId, input.token, this.tokensFor(chainId));
    if (asset.kind !== 'erc20') throw new WalletError('INVALID_ARGUMENT', 'approvals apply to ERC-20 tokens, not the native coin');
    const spender = await this.recipientFor(input.spender, chainId);
    const raw = String(input.amount).trim().toLowerCase();
    const amount = raw === 'unlimited' ? MaxUint256 : raw === '0' ? 0n : parseAmount(input.amount, asset.decimals, asset.symbol);
    return await this.plan({
      account,
      chainId,
      request: { to: asset.address, value: 0n, data: encodeErc20Approve(spender.address, amount) },
      asset,
      recipient: spender,
      notes: [],
    });
  }

  /**
   * Dry-run a raw transaction: populate + decode + evaluate policy. No key
   * material touched. Returns a preparedId `wallet_send_transaction` can execute.
   * `value` is wei; `amount` (native units, e.g. "0.01") is the safer alternative.
   */
  async prepareTransaction(input: TransactionRequestInput & { amount?: string; idempotencyKey?: string }): Promise<PreparedView & { chainName?: string }> {
    this.vault.maybeAutoLock();
    const account = this.vault.requireAccount(input.from);
    const chainId = requireChainId(input.chainId);
    const chain = getChain(chainId);
    const value = valueOf(input, chain?.decimals ?? 18, chain?.symbol ?? 'ETH');
    const data = input.data ?? '0x';
    if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) throw new WalletError('INVALID_ARGUMENT', 'data must be 0x-prefixed, even-length hex');
    const recipient = await this.recipientFor(input.to, chainId);
    return await this.plan({
      account,
      chainId,
      request: {
        to: recipient.address,
        value,
        data,
        ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
        ...(input.gasLimit !== undefined ? { gasLimit: input.gasLimit } : {}),
      },
      recipient,
      notes: [],
      idempotencyKey: input.idempotencyKey,
    });
  }

  /** Build a plan: populate, decode, preflight, dry-run policy, store. */
  private async plan(input: {
    account: AccountMeta;
    chainId: number;
    request: Plan['request'];
    asset?: ResolvedAsset;
    recipient?: ResolvedRecipient;
    notes: RiskFinding[];
    idempotencyKey?: string;
    replaces?: string;
  }): Promise<PreparedView> {
    this.prunePlans();
    const { provider } = await this.providerFor(input.chainId);
    const populated = await populateTransaction({ ...input.request, from: input.account.address, chainId: input.chainId }, provider);
    const intent = classifyTransaction({ to: populated.to, value: populated.value, data: populated.data });
    const policyDecision = this.evaluate(input.account, input.chainId, populated, intent);
    // A policy denial is the most useful answer; skip preflight and checks for it.
    let security: SecurityView;
    if (policyDecision.effect === 'deny') {
      security = notesOnly(input.notes);
    } else {
      const notes = [...input.notes, ...(await this.preflight(provider, input.account, populated, intent, input.asset))];
      security = await this.assess(this.txSubject(input.account, input.chainId, populated, intent), { ...(input.recipient !== undefined ? { recipient: input.recipient } : {}) }, notes);
    }
    const decision = escalateDecision(policyDecision, security);
    const plan: Plan = {
      id: `prep_${randomUUID()}`,
      expiresAt: Date.now() + PREPARED_TTL_MS,
      account: input.account,
      chainId: input.chainId,
      request: input.request,
      intent,
      ...(input.asset !== undefined ? { asset: input.asset } : {}),
      ...(input.recipient !== undefined ? { recipient: input.recipient } : {}),
      headline: headlineFor(intent, populated, input.chainId, input.asset, input.recipient),
      notes: input.notes,
      security,
      securityAt: Date.now(),
      ...(input.idempotencyKey !== undefined ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.replaces !== undefined ? { replaces: input.replaces } : {}),
    };
    this.plans.set(plan.id, plan);
    return await this.viewOf(plan, populated, decision);
  }

  /**
   * Hard preflight: failures that make signing pointless (would revert, not
   * enough funds) throw; soft issues come back as notes for the report.
   * Counterparty risk is the job of the security checks.
   */
  private async preflight(
    provider: ChainProvider,
    account: AccountMeta,
    populated: PopulatedTransaction,
    intent: Intent,
    asset: ResolvedAsset | undefined,
  ): Promise<RiskFinding[]> {
    const notes: RiskFinding[] = [];
    if (populated.estimateError !== undefined) {
      throw new WalletError(
        'WOULD_REVERT',
        `the transaction would fail on-chain: ${populated.estimateError}`,
        'Nothing was signed. Check the parameters, balance, and allowances; do not retry unchanged.',
      );
    }
    const chain = getChain(populated.chainId);
    const symbol = chain?.symbol ?? 'ETH';
    const maxFee = populated.gasLimit * (populated.maxFeePerGas ?? populated.gasPrice ?? 0n);
    const nativeBalance = await provider.getBalance(account.address).catch(() => undefined);
    if (nativeBalance !== undefined && nativeBalance < populated.value + maxFee) {
      throw new WalletError(
        'INSUFFICIENT_FUNDS',
        `${account.label} has ${formatEther(nativeBalance)} ${symbol}; needs ${formatEther(populated.value)} ${symbol} + up to ${formatEther(maxFee)} ${symbol} network fee`,
        'Tell the user the shortfall; do not lower the amount without asking.',
        { balanceWei: nativeBalance.toString(), neededWei: (populated.value + maxFee).toString() },
      );
    }
    if (intent.kind === 'token-transfer' && asset?.kind === 'erc20' && intent.amount !== undefined) {
      const balance = await tokenBalanceOf(provider, asset.address, account.address);
      if (balance === undefined) notes.push(finding('prepare', 'BALANCE_UNKNOWN', 'warn', `could not read the ${asset.symbol} balance; the transfer may fail`, asset.address));
      else if (balance < BigInt(intent.amount)) {
        throw new WalletError(
          'INSUFFICIENT_FUNDS',
          `${account.label} has ${formatAmount(balance, asset.decimals, asset.symbol)}; tried to send ${formatAmount(intent.amount, asset.decimals, asset.symbol)}`,
          'Tell the user the shortfall; do not lower the amount without asking.',
        );
      }
    }
    return notes;
  }

  // ── security checks ─────────────────────────────────────────────────────

  private securityDeps(): SecurityDeps {
    return {
      settings: () => this.vault.getSecuritySettings(),
      providerFor: async (chainId) => (await this.providerFor(chainId)).provider,
      denylist: this.vault.denylist,
      knownCounterparties: (from) => this.knownCounterparties(from),
      isOwnAccount: (address) => this.isOwnAccount(address),
      isTrustedContact: (address) => this.vault.addressBook.isTrusted(address),
      ...(this.options.fetchJson !== undefined ? { fetchJson: this.options.fetchJson } : {}),
      cache: this.securityCache,
    };
  }

  private isOwnAccount(address: string): boolean {
    const lower = address.toLowerCase();
    return this.vault.listAccounts().some((meta) => meta.address.toLowerCase() === lower);
  }

  /** Run every enabled check for one operation. */
  private async assess(subject: SecuritySubject, hints: SecurityHints, notes: RiskFinding[]): Promise<SecurityView> {
    const built = buildRiskChecks(this.securityDeps(), subject, hints);
    const report = await runSecurityChecks(built.checks, subject, { onUnavailable: this.vault.getSecuritySettings().onUnavailable, extraFindings: notes });
    // The simulation promise is settled once its check finished; never wait on a timed-out one.
    const simulation = await Promise.race([built.simulation(), Promise.resolve(undefined)]);
    return { ...report, ...(simulation !== undefined ? { simulation } : {}) };
  }

  /** The security subject of a populated transaction. */
  private txSubject(account: AccountMeta, chainId: number, populated: PopulatedTransaction, intent: Intent): SecuritySubject {
    const counterparties: SecuritySubject['counterparties'] = [];
    const recipient = intent.recipient ?? (intent.kind === 'native-transfer' ? populated.to : undefined);
    if (recipient !== undefined) counterparties.push({ role: 'recipient', address: recipient });
    if (intent.spender !== undefined) counterparties.push({ role: 'spender', address: intent.spender });
    if (intent.kind !== 'native-transfer') counterparties.push({ role: 'contract', address: populated.to });
    return {
      kind: 'transaction',
      chainId,
      from: account.address,
      intent,
      tx: { to: populated.to, value: populated.value, data: populated.data, gasLimit: populated.gasLimit },
      counterparties,
    };
  }

  /** Lower-cased addresses the user has dealt with (address book, own accounts, past recipients). */
  private knownCounterparties(from: string): Set<string> {
    const known = new Set<string>();
    for (const entry of this.vault.addressBook.list()) known.add(entry.address.toLowerCase());
    for (const meta of this.vault.listAccounts()) known.add(meta.address.toLowerCase());
    const lowerFrom = from.toLowerCase();
    for (const event of this.vault.spend.events()) {
      if (event.from.toLowerCase() === lowerFrom && event.to !== undefined) known.add(event.to.toLowerCase());
    }
    return known;
  }

  private async recipientFor(input: string, chainId: number): Promise<ResolvedRecipient> {
    return await resolveRecipient(input, chainId, {
      vault: this.vault,
      addressBook: this.vault.addressBook,
      ensProvider: async () => (await this.providerFor(1)).provider,
    });
  }

  private async resolveAddressOnly(input: string, chainId: number): Promise<string> {
    return (await this.recipientFor(input, chainId)).address;
  }

  private evaluate(account: AccountMeta, chainId: number, populated: PopulatedTransaction, intent: Intent): PolicyDecision {
    return this.decide({
      type: 'signTransaction',
      account: { address: account.address },
      chainId,
      to: populated.to,
      value: populated.value.toString(),
      data: populated.data,
      intent,
    });
  }

  private async viewOf(plan: Plan, populated: PopulatedTransaction, decision: PolicyDecision): Promise<PreparedView> {
    const security = plan.security;
    const human = describeTransaction(populated);
    const chain = getChain(plan.chainId);
    const maxFee = populated.gasLimit * (populated.maxFeePerGas ?? populated.gasPrice ?? 0n);
    const pin = await this.pinStatus();
    const aboveAutoBudget = isBudgetHold(decision, security);
    const willRequire = {
      humanApproval: decision.effect === 'ask' && !aboveAutoBudget,
      aboveAutoBudget,
      dailyPin: pin.enabled && !pin.authorized,
      blocked: decision.effect === 'deny',
    };
    const display = intentDisplay(plan.intent, plan.asset);
    return {
      status: 'prepared',
      preparedId: plan.id,
      expiresAt: new Date(plan.expiresAt).toISOString(),
      summary: plan.headline,
      chainId: plan.chainId,
      ...(chain !== undefined ? { chainName: chain.name } : {}),
      from: plan.account.address,
      to: populated.to,
      valueWei: populated.value.toString(),
      intent: { ...plan.intent, ...display },
      ...(plan.recipient !== undefined ? { recipient: plan.recipient } : {}),
      fee: { gasLimit: populated.gasLimit.toString(), maxFee: `${formatEther(maxFee)} ${chain?.symbol ?? 'ETH'}` },
      decision,
      willRequire,
      warnings: warningLines(security.findings),
      security,
      human,
      next: willRequire.blocked
        ? blockedNext(decision)
        : aboveAutoBudget
          ? `Executing would return needs-human without signing. ${NEEDS_HUMAN_NEXT}`
          : `Show the user the summary${security.findings.length > 0 ? ' AND every security finding' : ''}, get explicit confirmation, then call wallet_send_transaction with { preparedId: "${plan.id}" }.` +
          (severityRank(security.severity) >= severityRank('high') ? ' There are HIGH-risk findings: relay each one to the user word for word and let the user decide; never dismiss them yourself.' : '') +
          (willRequire.dailyPin ? ' The user must first enter the PIN in DSH Settings → Web3 to authorize signing.' : '') +
          (willRequire.humanApproval ? ' A human approval prompt will appear when executing.' : ''),
    };
  }

  private prunePlans(): void {
    const now = Date.now();
    for (const [id, plan] of this.plans) {
      // Keep executed plans until expiry so duplicate executes stay idempotent.
      if (plan.expiresAt < now) this.plans.delete(id);
    }
  }

  // ── execute ─────────────────────────────────────────────────────────────

  /** Execute a prepared operation exactly as reviewed (fees/nonce refreshed). */
  async executePrepared(preparedId: string, approval: ApprovalGateway | undefined, context: CallContext): Promise<SendResult> {
    const plan = this.plans.get(preparedId);
    if (plan === undefined || plan.expiresAt < Date.now()) {
      throw new WalletError(
        'PREPARED_NOT_FOUND',
        `preparedId ${preparedId} is unknown or expired (valid ${String(PREPARED_TTL_MS / 60_000)} min)`,
        'Check wallet_history first (it may already have been sent); otherwise prepare again and re-confirm with the user.',
      );
    }
    return await this.withAccountLock(plan.account.address, async () => await this.executePlan(plan, approval, context));
  }

  private async executePlan(plan: Plan, approval: ApprovalGateway | undefined, context: CallContext): Promise<SendResult> {
    if (plan.result !== undefined && ['signed-broadcast', 'broadcast-uncertain'].includes(plan.result.status)) {
      return { ...plan.result, status: 'already-submitted', next: 'This preparedId was already executed; use wallet_tx_status with the txHash.' };
    }
    if (plan.idempotencyKey !== undefined) {
      const existing = this.vault.journal.byIdempotencyKey(plan.idempotencyKey);
      if (existing !== undefined && existing.status !== 'rejected') {
        return {
          status: 'already-submitted',
          txHash: existing.hash,
          summary: existing.summary,
          explorerUrl: explorerUrl(existing.chainId, 'tx', existing.hash),
          next: `idempotencyKey "${plan.idempotencyKey}" was already used for ${existing.hash} (status ${existing.status}); nothing new was sent.`,
        };
      }
    }
    const { provider } = await this.providerFor(plan.chainId);
    const account = plan.account;
    const populated = await populateTransaction({ ...plan.request, from: account.address, chainId: plan.chainId }, provider);
    if (populated.estimateError !== undefined) {
      throw new WalletError('WOULD_REVERT', `the transaction would now fail on-chain: ${populated.estimateError}`, 'Nothing was signed. Chain state changed since preparing; re-check with the user.');
    }
    const human = describeTransaction(populated);
    // Re-check right before signing unless the prepare-time report is seconds old.
    if (Date.now() - plan.securityAt > SECURITY_REUSE_MS) {
      plan.security = await this.assess(
        this.txSubject(account, plan.chainId, populated, plan.intent),
        { ...(plan.recipient !== undefined ? { recipient: plan.recipient } : {}) },
        plan.notes,
      );
      plan.securityAt = Date.now();
    }
    const security = plan.security;
    const decision = escalateDecision(this.evaluate(account, plan.chainId, populated, plan.intent), security);
    const trail = this.signTrail(context);
    await this.vault.auditAppend('sign.decision', {
      ...trail,
      type: 'signTransaction',
      accountId: account.id,
      address: account.address,
      effect: decision.effect,
      ruleId: decision.ruleId,
      guardrail: decision.guardrail,
      limit: decision.limit?.name,
      reason: decision.reason,
      chainId: plan.chainId,
      to: populated.to,
      valueWei: populated.value.toString(),
      intent: plan.intent.kind,
      risk: decision.risk,
    });

    if (decision.effect === 'deny') {
      return (plan.result = { status: 'denied-by-policy', decision, summary: plan.headline, security, next: blockedNext(decision) });
    }
    if (isBudgetHold(decision, security)) {
      await this.holdForUser(account, decision, plan.headline, trail);
      return (plan.result = { status: 'needs-human', decision, summary: plan.headline, security, next: NEEDS_HUMAN_NEXT });
    }
    // Lock + PIN before approval: never ask the human to approve something
    // the vault lock or the PIN gate would then refuse.
    await this.requireSigningUnlocked();
    await this.pinGate();
    if (decision.effect === 'ask') {
      if (approval === undefined) return (plan.result = { status: 'unavailable-approver', decision, summary: plan.headline, security });
      const outcome = await approval.request({
        toolName: context.toolName,
        callId: context.callId,
        signal: context.signal,
        agent: context.agent,
        reason: approvalTextFor(plan, populated, decision, security.findings),
      });
      await this.vault.auditAppend('sign.approval', { ...trail, outcome, accountId: account.id, address: account.address });
      if (outcome !== 'allowed-once') {
        return (plan.result = {
          status: 'awaiting-approval-rejected',
          decision,
          approvalOutcome: outcome,
          summary: plan.headline,
          security,
          next: 'The user did not approve. Do not retry unless the user asks again.',
        });
      }
    }

    await this.requireSigningUnlocked();
    const unlocked = await this.vault.unlockedAccount(account.id);
    const signed = await coreSignTransaction(unlocked.wallet, populated);
    await this.vault.auditAppend('sign.transaction', {
      ...trail,
      accountId: account.id,
      address: account.address,
      chainId: plan.chainId,
      to: populated.to,
      valueWei: populated.value.toString(),
      nonce: populated.nonce,
      dataHash: keccak256(populated.data),
      txHash: signed.hash,
      intent: plan.intent.kind,
      ...(plan.replaces !== undefined ? { replaces: plan.replaces } : {}),
    });
    // Journal BEFORE broadcast: if the node's answer is lost we still know the
    // hash, and the agent can check instead of paying twice.
    await this.vault.journal.add({
      hash: signed.hash,
      chainId: plan.chainId,
      from: account.address,
      to: populated.to,
      nonce: populated.nonce,
      valueWei: populated.value.toString(),
      data: populated.data,
      type: populated.type,
      gasLimit: populated.gasLimit.toString(),
      ...(populated.maxFeePerGas !== undefined ? { maxFeePerGas: populated.maxFeePerGas.toString() } : {}),
      ...(populated.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: populated.maxPriorityFeePerGas.toString() } : {}),
      ...(populated.gasPrice !== undefined ? { gasPrice: populated.gasPrice.toString() } : {}),
      intent: plan.intent,
      summary: plan.headline,
      status: 'unknown',
      submittedAt: Date.now(),
      ...(plan.idempotencyKey !== undefined ? { idempotencyKey: plan.idempotencyKey } : {}),
      ...(plan.replaces !== undefined ? { replaces: plan.replaces } : {}),
    });

    let txHash: string;
    try {
      txHash = await provider.broadcastRawTransaction(signed.raw);
    } catch (error) {
      const message = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
      if (isDefinitiveRejection(error)) {
        await this.vault.journal.update(signed.hash, { status: 'rejected', error: message });
        return (plan.result = { status: 'rejected-by-node', decision, txHash: signed.hash, summary: plan.headline, error: message, next: 'Nothing was sent. Fix the cause (see error) before preparing again.' });
      }
      await this.vault.journal.update(signed.hash, { error: message });
      await this.recordSpend(plan, populated, signed.hash);
      return (plan.result = {
        status: 'broadcast-uncertain',
        decision,
        txHash: signed.hash,
        summary: plan.headline,
        explorerUrl: explorerUrl(plan.chainId, 'tx', signed.hash),
        error: message,
        next: `The transaction was signed but the node did not confirm receipt. DO NOT send again — call wallet_tx_status with txHash ${signed.hash} first.`,
      });
    }
    await this.vault.journal.update(signed.hash, { status: 'pending', ...(txHash.toLowerCase() !== signed.hash.toLowerCase() ? { error: `node returned hash ${txHash}` } : {}) });
    if (plan.replaces !== undefined) await this.vault.journal.update(plan.replaces, { status: 'replaced', replacedBy: signed.hash });
    await this.recordSpend(plan, populated, signed.hash);
    const result: SendResult = {
      status: 'signed-broadcast',
      decision,
      txHash: signed.hash,
      human,
      summary: plan.headline,
      explorerUrl: explorerUrl(plan.chainId, 'tx', signed.hash),
      security,
      next: 'Broadcast. Report the txHash/explorer link; use wallet_tx_status to confirm it was mined.',
    };
    // Defense in depth: never let key material ride along in results.
    assertNoSecrets(result, [unlocked.reveal().privateKey]);
    return (plan.result = result);
  }

  private async recordSpend(plan: Plan, populated: PopulatedTransaction, txHash: string): Promise<void> {
    if (plan.replaces !== undefined) return; // replacements move the same value once
    const tokenMove = plan.intent.kind === 'token-transfer' && plan.intent.token !== undefined && plan.intent.amount !== undefined;
    await this.vault.recordSignedTransaction({
      account: plan.account,
      chainId: plan.chainId,
      to: populated.to,
      valueWei: populated.value.toString(),
      txHash,
      ...(plan.intent.recipient !== undefined ? { recipient: plan.intent.recipient } : {}),
      ...(tokenMove ? { token: plan.intent.token!, tokenAmount: plan.intent.amount! } : {}),
    });
  }

  private async withAccountLock<T>(address: string, fn: () => Promise<T>): Promise<T> {
    const key = address.toLowerCase();
    const previous = this.accountLocks.get(key) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    this.accountLocks.set(key, run.catch(() => undefined));
    return await run;
  }

  /** One-shot transfer: prepare + execute (the reviewed plan is what is signed). */
  async transfer(
    input: { account: string; chainId: number | string; to: string; amount: string; token?: string; idempotencyKey?: string },
    approval: ApprovalGateway | undefined,
    context: CallContext = { toolName: 'wallet_transfer' },
  ): Promise<SendResult & { warnings?: string[] }> {
    if (input.idempotencyKey !== undefined) {
      const existing = this.vault.journal.byIdempotencyKey(input.idempotencyKey);
      if (existing !== undefined && existing.status !== 'rejected') {
        return {
          status: 'already-submitted',
          txHash: existing.hash,
          summary: existing.summary,
          explorerUrl: explorerUrl(existing.chainId, 'tx', existing.hash),
          next: `idempotencyKey "${input.idempotencyKey}" was already used for ${existing.hash} (status ${existing.status}); nothing new was sent.`,
        };
      }
    }
    const prepared = await this.prepareTransfer(input);
    const result = await this.executePrepared(prepared.preparedId, approval, context);
    return { ...result, ...(prepared.warnings.length > 0 ? { warnings: prepared.warnings } : {}) };
  }

  /**
   * Full flow for a raw transaction: prepare + execute. Kept for
   * programmatic callers (`ctx.wallet.sendTransaction`).
   */
  async sendTransaction(
    input: TransactionRequestInput & { amount?: string; idempotencyKey?: string },
    approval: ApprovalGateway | undefined,
    context: CallContext = { toolName: 'wallet_send_transaction' },
  ): Promise<SendResult> {
    const prepared = await this.prepareTransaction(input);
    return await this.executePrepared(prepared.preparedId, approval, context);
  }

  // ── transaction lifecycle ───────────────────────────────────────────────

  /** Status of a transaction (journal + chain receipt). */
  async txStatus(input: { txHash: string; chainId?: number | string }): Promise<{
    txHash: string;
    status: JournalEntry['status'] | 'not-found';
    chainId: number;
    blockNumber?: number;
    gasUsed?: string;
    summary?: string;
    explorerUrl?: string;
    replacedBy?: string;
    next: string;
  }> {
    const hash = String(input.txHash ?? '').trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new WalletError('INVALID_ARGUMENT', 'txHash must be a 0x-prefixed 32-byte hash');
    const entry = this.vault.journal.get(hash);
    const chainId = entry?.chainId ?? normalizeChainId(input.chainId);
    if (chainId === undefined) throw new WalletError('TX_NOT_FOUND', 'transaction is not in the local journal', 'Pass chainId to look it up on-chain.');
    const { provider } = await this.providerFor(chainId);
    const receipt = await provider.getTransactionReceipt(hash);
    let status: JournalEntry['status'] | 'not-found' = entry?.status ?? 'not-found';
    if (receipt !== null && receipt.status !== 'pending') {
      status = receipt.status;
      if (entry !== undefined && entry.status !== status) {
        await this.vault.journal.update(hash, { status, ...(receipt.blockNumber !== null ? { blockNumber: receipt.blockNumber } : {}), gasUsed: receipt.gasUsed.toString() });
      }
    }
    const next =
      status === 'success'
        ? 'Confirmed on-chain.'
        : status === 'reverted'
          ? 'Mined but reverted: the fee was paid, nothing else happened. Tell the user; do not resend without understanding why.'
          : status === 'pending' || status === 'unknown'
            ? 'Not mined yet. Wait and check again; if stuck for long, offer wallet_replace_transaction (speed-up). Do not send a duplicate.'
            : status === 'replaced'
              ? `Replaced by ${entry?.replacedBy ?? 'another transaction'}; check that one.`
              : status === 'rejected'
                ? 'Rejected by the node; nothing was sent.'
                : 'Not found on this chain.';
    return {
      txHash: hash,
      status,
      chainId,
      ...(receipt?.blockNumber !== undefined && receipt?.blockNumber !== null ? { blockNumber: receipt.blockNumber } : {}),
      ...(receipt !== null ? { gasUsed: receipt.gasUsed.toString() } : {}),
      ...(entry?.summary !== undefined ? { summary: entry.summary } : {}),
      explorerUrl: explorerUrl(chainId, 'tx', hash),
      ...(entry?.replacedBy !== undefined ? { replacedBy: entry.replacedBy } : {}),
      next,
    };
  }

  /** Locally journaled transactions, newest first. */
  history(input: { account?: string; chainId?: number | string; limit?: number } = {}): Array<Omit<JournalEntry, 'data'> & { dataLengthBytes: number; explorerUrl?: string }> {
    const from = input.account !== undefined ? this.vault.requireAccount(input.account).address : undefined;
    const chainId = normalizeChainId(input.chainId);
    return this.vault.journal
      .list({ ...(from !== undefined ? { from } : {}), ...(chainId !== undefined ? { chainId } : {}), limit: Math.min(Math.max(input.limit ?? 20, 1), 100) })
      .map(({ data, ...rest }) => {
        const url = explorerUrl(rest.chainId, 'tx', rest.hash);
        return { ...rest, dataLengthBytes: (data.length - 2) / 2, ...(url !== undefined ? { explorerUrl: url } : {}) };
      });
  }

  /**
   * Speed up (same tx, higher fee) or cancel (0-value self-send) a pending
   * transaction by reusing its nonce. Goes through the same policy / PIN /
   * approval pipeline.
   */
  async replaceTransaction(
    input: { txHash: string; action: 'speed-up' | 'cancel' },
    approval: ApprovalGateway | undefined,
    context: CallContext = { toolName: 'wallet_replace_transaction' },
  ): Promise<SendResult> {
    const entry = this.vault.journal.get(input.txHash);
    if (entry === undefined) throw new WalletError('TX_NOT_FOUND', 'only transactions sent by this wallet can be replaced', 'Check wallet_history for the hash.');
    if (!['pending', 'unknown'].includes(entry.status)) {
      throw new WalletError('NOT_REPLACEABLE', `transaction is ${entry.status}, not pending`);
    }
    const { provider } = await this.providerFor(entry.chainId);
    const receipt = await provider.getTransactionReceipt(entry.hash);
    if (receipt !== null && receipt.status !== 'pending') {
      await this.vault.journal.update(entry.hash, { status: receipt.status });
      throw new WalletError('NOT_REPLACEABLE', `transaction was already mined (${receipt.status})`);
    }
    const account = this.vault.requireAccount(entry.from);
    const fees = await provider.getFeeData();
    const bump = (old: string | undefined, current: bigint | undefined): bigint | undefined => {
      if (old === undefined && current === undefined) return undefined;
      const bumped = old !== undefined ? (BigInt(old) * (100n + REPLACEMENT_BUMP_PERCENT)) / 100n + 1n : 0n;
      return current !== undefined && current > bumped ? current : bumped;
    };
    const feeFields =
      entry.type === 2
        ? { maxFeePerGas: bump(entry.maxFeePerGas, fees.maxFeePerGas)!, maxPriorityFeePerGas: bump(entry.maxPriorityFeePerGas, fees.maxPriorityFeePerGas)! }
        : { gasPrice: bump(entry.gasPrice, fees.gasPrice)!, type: 0 as const };
    const request: Plan['request'] =
      input.action === 'cancel'
        ? { to: account.address, value: 0n, data: '0x', nonce: entry.nonce, gasLimit: 21_000n, ...feeFields }
        : { to: entry.to, value: BigInt(entry.valueWei), data: entry.data, nonce: entry.nonce, gasLimit: BigInt(entry.gasLimit), ...feeFields };
    const prepared = await this.plan({
      account,
      chainId: entry.chainId,
      request,
      notes: [finding('prepare', 'REPLACEMENT', 'info', input.action === 'cancel' ? `cancels ${entry.hash} (0-value self-send with the same nonce)` : `speeds up ${entry.hash} with a higher fee`)],
      replaces: entry.hash,
    });
    return await this.executePrepared(prepared.preparedId, approval, context);
  }

  // ── message / typed-data signing ────────────────────────────────────────

  /** Sign an EIP-191 message under policy + approval. */
  async signMessage(
    input: { account: string; message: string },
    approval: ApprovalGateway | undefined,
    context: CallContext = { toolName: 'wallet_sign_message' },
  ): Promise<SignMessageResult> {
    this.vault.maybeAutoLock();
    const meta = this.vault.requireAccount(input.account);
    if (typeof input.message !== 'string') throw new WalletError('INVALID_ARGUMENT', 'message must be a string');
    const decision = this.decide({
      type: 'signMessage',
      account: { address: meta.address },
      message: input.message,
    });
    const trail = this.signTrail(context);
    const messageHash = hashMessage(input.message);
    await this.vault.auditAppend('sign.decision', {
      ...trail,
      type: 'signMessage',
      accountId: meta.id,
      address: meta.address,
      effect: decision.effect,
      ruleId: decision.ruleId,
      reason: decision.reason,
      messageLength: Buffer.byteLength(input.message, 'utf8'),
      messageHash,
    });
    if (decision.effect === 'deny') return { status: 'denied-by-policy', decision, address: meta.address };
    await this.requireSigningUnlocked();
    await this.pinGate();
    if (decision.effect === 'ask') {
      if (approval === undefined) return { status: 'unavailable-approver', decision, address: meta.address };
      const outcome = await approval.request({
        toolName: context.toolName,
        callId: context.callId,
        signal: context.signal,
        agent: context.agent,
        reason: `Sign a personal message as ${meta.address} (${meta.label})?\n\nMessage (${String(Buffer.byteLength(input.message, 'utf8'))} bytes):\n${truncate(input.message, 400)}`,
      });
      await this.vault.auditAppend('sign.approval', { ...trail, outcome, accountId: meta.id, address: meta.address });
      if (outcome !== 'allowed-once') {
        return { status: 'awaiting-approval-rejected', decision, approvalOutcome: outcome, address: meta.address };
      }
    }
    await this.requireSigningUnlocked();
    const account = await this.vault.unlockedAccount(meta.id);
    const { signature } = await coreSignMessage(account.wallet, input.message);
    await this.vault.auditAppend('sign.message', { ...trail, accountId: meta.id, address: meta.address, messageHash, signature });
    const result: SignMessageResult = { status: 'signed', decision, signature, address: meta.address };
    assertNoSecrets(result, [account.reveal().privateKey]);
    return result;
  }

  /** Sign EIP-712 typed data under policy + approval (permit-aware). */
  async signTypedData(
    input: {
      account: string;
      domain: TypedDataDomain;
      types: Record<string, TypedDataField[]>;
      value: Record<string, unknown>;
      /** Optional human context shown in the approval prompt (e.g. the paid resource). */
      purpose?: string;
      /** Extra findings from the caller (e.g. x402 asset checks). Not a tool parameter. */
      extraFindings?: RiskFinding[];
    },
    approval: ApprovalGateway | undefined,
    context: CallContext = { toolName: 'wallet_sign_typed_data' },
  ): Promise<SignMessageResult> {
    this.vault.maybeAutoLock();
    const meta = this.vault.requireAccount(input.account);
    if (input.domain === undefined || input.types === undefined || input.value === undefined) {
      throw new WalletError('INVALID_ARGUMENT', 'domain, types, and value are all required (value = the EIP-712 message object)');
    }
    const types = Object.fromEntries(Object.entries(input.types).filter(([name]) => name !== 'EIP712Domain'));
    const chainId = normalizeChainId(input.domain.chainId);
    const domain: TypedDataDomain = { ...input.domain, ...(chainId !== undefined ? { chainId } : {}) };
    const intent = classifyTypedData({ domain, types, value: input.value });
    const typedDataJson = JSON.stringify({ domain, types, value: input.value }, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
    const policyDecision = this.decide({
      type: 'signTypedData',
      account: { address: meta.address },
      ...(chainId !== undefined ? { chainId } : {}),
      ...(typeof domain.verifyingContract === 'string' ? { to: domain.verifyingContract } : {}),
      typedData: typedDataJson,
      intent,
    });
    const security =
      policyDecision.effect === 'deny'
        ? notesOnly(input.extraFindings ?? [])
        : await this.assess(this.typedDataSubject(meta, chainId, domain, intent), {}, input.extraFindings ?? []);
    const decision = escalateDecision(policyDecision, security);
    const trail = this.signTrail(context);
    // Malformed types fail later at signing; the audit just goes without the hash.
    const digest = attempt(() => TypedDataEncoder.hash(domain, types, input.value));
    const primaryType = attempt(() => TypedDataEncoder.getPrimaryType(types));
    await this.vault.auditAppend('sign.decision', {
      ...trail,
      type: 'signTypedData',
      accountId: meta.id,
      address: meta.address,
      effect: decision.effect,
      ruleId: decision.ruleId,
      guardrail: decision.guardrail,
      limit: decision.limit?.name,
      reason: decision.reason,
      chainId,
      verifyingContract: domain.verifyingContract,
      primaryType,
      digest,
      intent: intent.kind,
      risk: decision.risk,
    });
    if (decision.effect === 'deny') return { status: 'denied-by-policy', decision, address: meta.address, intent, security };
    if (isBudgetHold(decision, security)) {
      await this.holdForUser(meta, decision, intent.kind, trail);
      return { status: 'needs-human', decision, address: meta.address, intent, security };
    }
    await this.requireSigningUnlocked();
    await this.pinGate();
    if (decision.effect === 'ask') {
      if (approval === undefined) return { status: 'unavailable-approver', decision, address: meta.address, intent, security };
      const outcome = await approval.request({
        toolName: context.toolName,
        callId: context.callId,
        signal: context.signal,
        agent: context.agent,
        reason: typedDataApprovalText(meta, domain, intent, typedDataJson, decision, input.purpose, security.findings),
      });
      await this.vault.auditAppend('sign.approval', { ...trail, outcome, accountId: meta.id, address: meta.address });
      if (outcome !== 'allowed-once') {
        return { status: 'awaiting-approval-rejected', decision, approvalOutcome: outcome, address: meta.address, intent, security };
      }
    }
    await this.requireSigningUnlocked();
    const account = await this.vault.unlockedAccount(meta.id);
    const { signature } = await coreSignTypedData(account.wallet, domain, types, input.value);
    await this.vault.auditAppend('sign.typedData', { ...trail, accountId: meta.id, address: meta.address, digest, signature, intent: intent.kind });
    // A signed transfer authorization is a payment: count it toward caps.
    if (intent.kind === 'transfer-authorization' && intent.token !== undefined && intent.amount !== undefined && intent.recipient !== undefined && chainId !== undefined) {
      await this.vault.recordSignedAuthorization({ account: meta, chainId, token: intent.token, tokenAmount: intent.amount, recipient: intent.recipient });
    }
    const result: SignMessageResult = { status: 'signed', decision, signature, address: meta.address, intent, security };
    assertNoSecrets(result, [account.reveal().privateKey]);
    return result;
  }

  /** The security subject of an EIP-712 signature. */
  private typedDataSubject(meta: AccountMeta, chainId: number | undefined, domain: TypedDataDomain, intent: Intent): SecuritySubject {
    const counterparties: SecuritySubject['counterparties'] = [];
    if (intent.recipient !== undefined) counterparties.push({ role: 'recipient', address: intent.recipient });
    if (intent.spender !== undefined) counterparties.push({ role: 'spender', address: intent.spender });
    if (typeof domain.verifyingContract === 'string' && /^0x[0-9a-fA-F]{40}$/.test(domain.verifyingContract)) {
      counterparties.push({ role: 'verifying-contract', address: getAddress(domain.verifyingContract.toLowerCase()) });
    }
    return { kind: 'typed-data', ...(chainId !== undefined ? { chainId } : {}), from: meta.address, intent, counterparties };
  }

  // ── x402 payment authorization ─────────────────────────────────────────

  /**
   * Authorize an x402 payment: parse the challenge (v1 or v2), build an
   * EIP-3009 TransferWithAuthorization typed-data payload with the token's
   * real EIP-712 domain, and sign it under the signing policy (same PIN +
   * approval gates as any typed-data sign; `tokenLimits` apply).
   * Returns the signature plus the `authorization` object so callers can
   * assemble the PAYMENT-SIGNATURE / X-PAYMENT header.
   */
  async authorizeX402(
    input: { account: string; challenge: unknown; amount?: string; ttlSeconds?: number },
    approval: ApprovalGateway | undefined,
    context: Partial<CallContext> = {},
  ): Promise<
    | { status: 'signed'; signature: string; authorization: { from: string; to: string; value: string; validAfter: number; validBefore: number; nonce: string }; payTo: string; asset: string; chainId: number; amount: string; amountFormatted?: string; expiresAt: number; resource?: string; decision: PolicyDecision; address: string; x402Version: number; scheme: 'exact'; network: string; security?: SecurityView }
    | { status: 'awaiting-approval-rejected' | 'denied-by-policy' | 'unavailable-approver' | 'needs-human'; decision: PolicyDecision; address: string; security?: SecurityView }
  > {
    const challenge = normalizeX402Challenge(input.challenge);
    const chainId = resolveX402ChainId(challenge);
    let asset: string;
    let payTo: string;
    try {
      asset = getAddress(challenge.asset);
      payTo = getAddress(challenge.payTo);
    } catch {
      throw new WalletError('INVALID_ADDRESS', 'x402 challenge carries an invalid asset or payTo address');
    }
    const maxAmount = challenge.maxAmountRequired;
    if (!/^\d+$/.test(maxAmount)) throw new WalletError('INVALID_AMOUNT', 'x402 amount must be a decimal atomic-unit string');
    const amount = input.amount ?? maxAmount;
    if (!/^\d+$/.test(amount)) throw new WalletError('INVALID_AMOUNT', 'x402 amount must be a decimal atomic-unit string');
    if (BigInt(amount) > BigInt(maxAmount)) throw new WalletError('INVALID_AMOUNT', 'x402 amount exceeds maxAmountRequired (the amount the service asked for)');
    const ttlCap = challenge.maxTimeoutSeconds !== undefined ? Math.min(3600, challenge.maxTimeoutSeconds) : 3600;
    const ttlSeconds = Math.max(60, Math.min(input.ttlSeconds ?? 300, ttlCap));
    const now = Math.floor(Date.now() / 1000);
    const nonce = '0x' + randomBytes(32).toString('hex');
    const domainInfo = await this.eip712DomainFor(chainId, asset, challenge.extra);
    const domain: TypedDataDomain = { name: domainInfo.name, version: domainInfo.version, chainId, verifyingContract: asset };
    const types: Record<string, TypedDataField[]> = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };
    const from = this.vault.requireAccount(input.account).address;
    // validAfter slightly in the past tolerates small clock skew at the facilitator.
    const authorization = { from, to: payTo, value: amount, validAfter: now - 30, validBefore: now + ttlSeconds, nonce };
    const known = findKnownToken(chainId, asset);
    const amountFormatted = known !== undefined ? formatAmount(amount, known.decimals, known.symbol) : undefined;
    const purpose = [
      `x402 payment${amountFormatted !== undefined ? ` of ${amountFormatted}` : ''} to ${payTo}`,
      challenge.resource !== undefined ? `for ${challenge.resource}` : undefined,
      challenge.description !== undefined ? `(${truncate(challenge.description, 120)})` : undefined,
      `valid ${String(ttlSeconds)}s`,
    ]
      .filter((part) => part !== undefined)
      .join(' ');
    const extraFindings =
      known === undefined
        ? [finding('x402', 'X402_UNKNOWN_ASSET', 'warn', `the payment asset ${asset} is not a token this wallet knows on chain ${String(chainId)}; x402 normally uses USDC`, asset)]
        : [];
    const result = await this.signTypedData(
      { account: input.account, domain, types, value: authorization, purpose, extraFindings },
      approval,
      { ...context, toolName: context.toolName ?? 'wallet_x402_authorize' },
    );
    if (result.status !== 'signed') {
      return { status: result.status, decision: result.decision, address: result.address, ...(result.security !== undefined ? { security: result.security } : {}) };
    }
    return {
      status: 'signed',
      signature: result.signature as string,
      authorization,
      payTo,
      asset,
      chainId,
      amount,
      ...(amountFormatted !== undefined ? { amountFormatted } : {}),
      expiresAt: (now + ttlSeconds) * 1000,
      ...(challenge.resource !== undefined ? { resource: challenge.resource } : {}),
      decision: result.decision,
      address: result.address,
      x402Version: challenge.x402Version,
      scheme: 'exact',
      network: challenge.network ?? `eip155:${String(chainId)}`,
      ...(result.security !== undefined ? { security: result.security } : {}),
    };
  }

  /**
   * The token's EIP-712 domain: server-declared `extra.name/version` first,
   * then the curated registry, then the token contract itself. Signing with a
   * wrong domain silently yields a signature the token rejects.
   */
  private async eip712DomainFor(chainId: number, asset: string, extra: Record<string, unknown> | undefined): Promise<{ name: string; version: string }> {
    if (typeof extra?.name === 'string' && typeof extra?.version === 'string') return { name: extra.name, version: extra.version };
    const known = findKnownToken(chainId, asset)?.eip712;
    if (known !== undefined) return known;
    const { provider } = await this.providerFor(chainId);
    const onChain = await tokenEip712Domain(provider, asset);
    if (onChain !== undefined) return onChain;
    throw new WalletError(
      'UNKNOWN_TOKEN',
      `cannot determine the EIP-712 domain (name/version) of token ${asset} on chain ${String(chainId)}`,
      'The x402 challenge should include extra.name and extra.version; pass the full challenge object.',
    );
  }

  // ── policy + hard limits ────────────────────────────────────────────────

  /**
   * Audit fields shared by every entry of one signing request, so the
   * decision, approval, hold and signature can be read back as one record.
   */
  private signTrail(context: CallContext): SignTrail {
    return {
      requestId: `sig-${randomUUID()}`,
      via: context.toolName,
      ...(context.callId !== undefined ? { callId: context.callId } : {}),
      preset: detectPreset(this.vault.getPolicy()) ?? 'custom',
    };
  }

  /** Record a hold for the user. Nothing is signed; no prompt blocks the agent. */
  private async holdForUser(meta: Pick<AccountMeta, 'id' | 'address'>, decision: PolicyDecision, what: string, trail: SignTrail): Promise<void> {
    await this.vault.auditAppend('sign.needs-human', {
      ...trail,
      accountId: meta.id,
      address: meta.address,
      what,
      limit: decision.limit?.name,
      reason: decision.reason,
    });
  }

  /**
   * The decision for one request, after the limits. Above the hard ceiling
   * the request is refused in every mode. In semi-managed mode, a request that
   * fits the ceiling but not the automatic budget is held for the human
   * (`ask` with guardrail `auto-budget`, which `executePlan` turns into
   * `needs-human` instead of prompting).
   */
  private decide(request: PolicyRequest): PolicyDecision {
    const decision = this.vault.evaluateSignPolicy(request);
    if (decision.effect === 'deny') return decision;
    const intent = intentOf(request) ?? { kind: 'message' as const };
    const limits = this.vault.getLimits();
    const check = {
      ...(request.chainId !== undefined ? { chainId: request.chainId } : {}),
      valueWei: BigInt(request.value ?? 0),
      intent,
    };
    const context = { isWhitelisted: (address: string) => this.isWhitelisted(address), recentSpend: this.vault.spend.windowEvents() };
    const verdict = checkLimits(limits, check, context);
    if (!verdict.ok) {
      return {
        ...decision,
        effect: 'deny',
        ruleId: `limit:${verdict.limit}`,
        reason: `${verdict.reason}. This is a hard limit: only the user can change it, in DSH Settings → Web3 → Limits.`,
        limit: { code: verdict.code, name: verdict.limit },
      };
    }
    if (decision.effect !== 'allow' || this.vault.getPolicy().autonomy !== 'semi') return decision;
    const budget = checkLimits(limits, check, context, Date.now(), 'auto');
    if (budget.ok) return decision;
    return {
      ...decision,
      effect: 'ask',
      guardrail: 'auto-budget',
      reason: `${budget.reason}. Above the automatic budget, so it is held for the user (the hard limit is higher; see DSH Settings → Web3 → Limits)`,
      limit: { code: budget.code, name: budget.limit },
    };
  }

  /** Own accounts and trusted contacts. */
  private isWhitelisted(address: string): boolean {
    const lower = address.toLowerCase();
    return this.vault.addressBook.isTrusted(address) || this.vault.listAccounts().some((meta) => meta.address.toLowerCase() === lower);
  }

  /** Current hard limits plus today's wallet-wide usage (secret-free). */
  limitsView(): { limits: WalletLimits; usage: ReturnType<typeof limitUsage>; whitelist: AddressBookEntry[] } {
    const limits = this.vault.getLimits();
    return {
      limits,
      usage: limitUsage(limits, this.vault.spend.windowEvents()),
      whitelist: this.vault.addressBook.list().filter((entry) => entry.trusted === true),
    };
  }

  // ── security settings, denylist, address checks ─────────────────────────

  /** Security settings, feed status, and the user denylist (secret-free). */
  securityView(): { settings: SecuritySettings; feeds: ReturnType<WalletVault['denylist']['feedStatus']>; denylist: DenylistEntry[] } {
    return { settings: this.vault.getSecuritySettings(), feeds: this.vault.denylist.feedStatus(), denylist: this.vault.denylist.list() };
  }

  /** Replace the security settings from the panel. Weakening any check requires `pin`. */
  async setSecuritySettingsFromPanel(next: unknown, pin?: string): Promise<SecuritySettings> {
    const errors = validateSecuritySettings(next);
    if (errors.length > 0) throw new WalletError('INVALID_ARGUMENT', `invalid security settings: ${errors.join('; ')}`);
    const current = this.vault.getSecuritySettings();
    const normalized = normalizeSecuritySettings(next);
    const tightening = isTighteningSecurity(current, normalized);
    if (!tightening) await this.stepUp(pin, 'weaken the transaction security checks');
    const saved = await this.vault.setSecuritySettings(normalized);
    await this.vault.auditAppend('security.settings', { tightening, simulation: saved.simulation, sanctionsOracle: saved.sanctionsOracle, goplus: saved.goplus, onUnavailable: saved.onUnavailable, feeds: saved.feeds });
    // Newly enabled feeds download in the background.
    if (Object.entries(saved.feeds).some(([id, on]) => on && !current.feeds[id as keyof SecuritySettings['feeds']])) {
      void this.refreshDenylistFeeds().catch(() => undefined);
    }
    return saved;
  }

  /** Add an address to the denylist. Always tightens, so the agent may call it. */
  async denylistAdd(input: { address: string; label?: string; note?: string }, actor: 'agent' | 'panel'): Promise<DenylistEntry> {
    let entry: DenylistEntry;
    try {
      entry = await this.vault.denylist.add(input);
    } catch (error) {
      throw new WalletError('INVALID_ADDRESS', error instanceof Error ? error.message : String(error), 'Pass a full, checksummed 0x address.');
    }
    await this.vault.auditAppend('denylist.add', { address: entry.address, label: entry.label, actor });
    return entry;
  }

  /** Remove an address from the denylist (panel only; loosens, so PIN step-up). */
  async denylistRemoveFromPanel(address: string, pin?: string): Promise<DenylistEntry | undefined> {
    await this.stepUp(pin, 'remove an address from the denylist');
    const removed = await this.vault.denylist.remove(address);
    if (removed !== undefined) await this.vault.auditAppend('denylist.remove', { address: removed.address });
    return removed;
  }

  /** Download stale (or, with `force`, all) enabled denylist feeds. */
  async refreshDenylistFeeds(options: { force?: boolean } = {}): Promise<ReturnType<WalletVault['denylist']['feedStatus']>> {
    const settings = this.vault.getSecuritySettings();
    const status = await this.vault.denylist.refreshFeeds({
      enabled: settings.feeds,
      ...(this.options.feedFetcher !== undefined ? { fetcher: this.options.feedFetcher } : {}),
      ...(options.force === true ? { force: true } : {}),
    });
    return status;
  }

  /**
   * Check one address before paying it: denylist, sanctions oracle, look-alikes
   * of known contacts, GoPlus (when enabled), and whether it has code.
   */
  async checkAddress(input: { address: string; chainId: number | string; account?: string }): Promise<{
    address: string;
    chainId: number;
    via: ResolvedRecipient['via'];
    kind: 'wallet' | 'contract' | 'delegated-wallet' | 'unknown';
    known: boolean;
    severity: SecurityView['severity'];
    findings: RiskFinding[];
    checks: CheckRun[];
    next: string;
  }> {
    const chainId = requireChainId(input.chainId);
    const resolved = await this.recipientFor(input.address, chainId);
    const accounts = this.vault.listAccounts();
    const from = input.account !== undefined ? this.vault.requireAccount(input.account).address : (accounts[0]?.address ?? '0x0000000000000000000000000000000000000000');
    const subject: SecuritySubject = {
      kind: 'transaction',
      chainId,
      from,
      intent: { kind: 'native-transfer', recipient: resolved.address },
      counterparties: [{ role: 'recipient', address: resolved.address }],
    };
    const security = await this.assess(subject, { recipient: resolved }, []);
    const { provider } = await this.providerFor(chainId);
    const code = await provider.getCode(resolved.address).catch(() => undefined);
    const kind = code === undefined ? 'unknown' : code === '0x' || code === '' ? 'wallet' : code.toLowerCase().startsWith('0xef0100') ? 'delegated-wallet' : 'contract';
    const known = this.knownCounterparties(from).has(resolved.address.toLowerCase());
    const next =
      security.severity === 'critical'
        ? 'Do NOT pay this address: the wallet will refuse. Tell the user why.'
        : security.severity === 'high'
          ? 'High risk: relay every finding to the user word for word before doing anything else.'
          : 'No blocking findings. Still confirm the full address with the user before paying.';
    return { address: resolved.address, chainId, via: resolved.via, kind, known, severity: security.severity, findings: security.findings, checks: security.checks, next };
  }

  /**
   * Step-up confirmation for settings-panel actions that weaken protection or
   * expose secrets: a PIN must be configured, and it is re-verified now
   * (through the throttled check, so wrong guesses count toward the lockout).
   */
  private async stepUp(pin: string | undefined, action: string): Promise<void> {
    await this.pinReady;
    if (!this.pin.enabled) {
      throw new WalletError('PIN_SETUP_REQUIRED', `set up a PIN before you ${action}`, 'Open DSH Settings → Web3 → Security and set a PIN first.');
    }
    if (typeof pin !== 'string' || pin.length === 0) throw new WalletError('PIN_REQUIRED', `enter your PIN to ${action}`);
    const { ok } = await this.pin.verify(pin);
    if (!ok) throw new WalletError('PIN_INVALID', 'incorrect PIN', 'Check the PIN; repeated failures lock the gate until tomorrow.');
    await this.vault.auditAppend('stepup.verified', { action });
  }

  /** Settings panel: replace the hard limits. Loosening needs the PIN. */
  async setLimitsFromPanel(next: WalletLimits, pin?: string): Promise<WalletLimits> {
    const current = this.vault.getLimits();
    let normalized: WalletLimits;
    try {
      normalized = normalizeLimits(next);
    } catch (error) {
      throw new WalletError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
    }
    const tightening = isTighteningLimits(current, normalized);
    if (!tightening) await this.stepUp(pin, 'loosen wallet limits');
    const saved = await this.vault.setLimits(normalized);
    await this.vault.auditAppend('limits.updated', {
      via: 'panel',
      tightening,
      whitelistOnly: saved.whitelistOnly,
      usd: saved.usd,
      native: saved.native,
    });
    return saved;
  }

  /** Settings panel: switch the signing policy to a preset. Anything but tightening needs the PIN. */
  async applyPresetFromPanel(preset: PolicyPresetId, pin?: string): Promise<{ preset: PolicyPresetId; tightening: boolean }> {
    if (!POLICY_PRESETS.includes(preset)) throw new WalletError('INVALID_ARGUMENT', `unknown preset "${preset}"`);
    const tightening = isTighteningPreset(detectPreset(this.vault.getPolicy()), preset);
    if (!tightening) await this.stepUp(pin, `switch the signing policy to "${preset}"`);
    await this.vault.setPolicy(policyPreset(preset));
    await this.vault.auditAppend('policy.updated', { via: 'panel', preset, tightening });
    return { preset, tightening };
  }

  /**
   * Model tools: apply a preset only when it tightens the policy. Loosening
   * (or replacing a custom policy) is a settings-panel action, so a prompt
   * injection that talks the agent into "relaxing" limits gets nowhere.
   */
  canAgentApplyPreset(preset: PolicyPresetId): boolean {
    return isTighteningPreset(detectPreset(this.vault.getPolicy()), preset);
  }

  /**
   * Settings panel: add or edit a contact. Whitelisting it, or re-pointing an
   * existing label at a different address, needs the PIN.
   */
  async upsertContactFromPanel(
    input: { label: string; address: string; note?: string; trusted?: boolean },
    pin?: string,
  ): Promise<AddressBookEntry> {
    const existing = this.vault.addressBook.get(input.label);
    const readdressed = existing !== undefined && existing.address.toLowerCase() !== String(input.address).toLowerCase();
    if (input.trusted === true && existing?.trusted !== true) await this.stepUp(pin, 'add an address to the transfer whitelist');
    else if (readdressed) await this.stepUp(pin, `change the address saved for "${existing.label}"`);
    try {
      const entry = await this.vault.addressBook.upsert({
        label: input.label,
        address: input.address,
        ...(input.note !== undefined && input.note !== '' ? { note: input.note } : {}),
        ...(input.trusted !== undefined ? { trusted: input.trusted } : {}),
      });
      await this.vault.auditAppend('addressbook.upsert', { label: entry.label, address: entry.address, trusted: entry.trusted === true, via: 'panel' });
      return entry;
    } catch (error) {
      if (error instanceof WalletError) throw error;
      throw new WalletError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
    }
  }

  /** Settings panel: whitelist / un-whitelist a saved contact. Whitelisting needs the PIN. */
  async setContactTrustedFromPanel(label: string, trusted: boolean, pin?: string): Promise<AddressBookEntry> {
    const existing = this.vault.addressBook.get(label);
    if (existing === undefined) throw new WalletError('INVALID_ARGUMENT', `no contact labelled "${label}"`);
    if (trusted && existing.trusted !== true) await this.stepUp(pin, 'add an address to the transfer whitelist');
    const entry = await this.vault.addressBook.setTrusted(label, trusted);
    await this.vault.auditAppend('addressbook.trust', { label: entry.label, address: entry.address, trusted, via: 'panel' });
    return entry;
  }

  /** Settings panel: rename an account (display only). */
  async renameAccount(account: string, label: string): Promise<AccountMeta> {
    const meta = this.vault.requireAccount(account);
    try {
      return await this.vault.renameAccount(meta.id, label);
    } catch (error) {
      throw new WalletError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
    }
  }

  /** Settings panel: remove an account after a PIN step-up. */
  async removeAccountFromPanel(account: string, pin?: string): Promise<AccountMeta> {
    const meta = this.vault.requireAccount(account);
    await this.stepUp(pin, `remove account ${meta.label}`);
    return await this.vault.removeAccount(meta.id);
  }

  /** Settings panel: export a keystore JSON to the browser (never through the model) after a PIN step-up. */
  async exportKeystoreFromPanel(account: string, keystorePassphrase: string, pin?: string): Promise<{ json: string; address: string }> {
    if (typeof keystorePassphrase !== 'string' || keystorePassphrase.length < 8) {
      throw new WalletError('INVALID_ARGUMENT', 'keystore password must be at least 8 characters');
    }
    const meta = this.vault.requireAccount(account);
    await this.stepUp(pin, `export a keystore for ${meta.label}`);
    this.requireUnlocked();
    const exported = await this.vault.exportKeystore(meta.id, keystorePassphrase);
    await this.vault.auditAppend('keystore.exported', { address: exported.address, via: 'panel' });
    return exported;
  }

  /** Secret-free settings the panel shows read-only (they live in the profile config). */
  settingsView(): { autoLockMs: number; passphraseMode: string; keychain: boolean; modelSecretReveal: boolean; vaultPath: string } {
    return {
      autoLockMs: this.options.autoLockMs ?? this.vault.autoLockMs,
      passphraseMode: this.options.passphraseMode,
      keychain: this.options.keychain !== undefined,
      modelSecretReveal: this.options.allowModelSecretReveal === true,
      vaultPath: this.options.vaultPath,
    };
  }

  // ── policy, secrets, audit ──────────────────────────────────────────────

  /** Current signing policy. */
  getPolicy(): SigningPolicy {
    return this.vault.getPolicy();
  }

  /** Replace the signing policy (tools gate this behind approval). */
  async setPolicy(policy: SigningPolicy): Promise<void> {
    await this.pinGate();
    await this.vault.setPolicy(policy);
    await this.vault.auditAppend('policy.updated', {
      defaultEffect: policy.defaultEffect,
      ruleCount: policy.rules.length,
    });
  }

  /** Reveal key material (programmatic API; model tools never return it). */
  async revealSecret(
    accountId: string,
    kind: 'mnemonic' | 'privateKey',
  ): Promise<{ address: string; kind: string; value: string }> {
    await this.pinGate();
    this.requireUnlocked();
    const account = await this.vault.unlockedAccount(accountId);
    const secret = account.reveal();
    if (kind === 'mnemonic') {
      if (secret.mnemonic === undefined) throw new Error('account has no mnemonic (imported from a raw key)');
      return { address: account.meta.address, kind, value: secret.mnemonic };
    }
    return { address: account.meta.address, kind, value: secret.privateKey };
  }

  /**
   * Reveal for the settings panel: a step-up check that re-verifies the PIN
   * on every reveal (a daily grant is not enough to display key material).
   * A PIN must be configured first — anything that can reach the panel API
   * would otherwise be able to read the seed.
   */
  async revealSecretForUi(input: { account: string; kind: 'mnemonic' | 'privateKey'; pin?: string }): Promise<{ address: string; kind: string; value: string }> {
    const meta = this.vault.requireAccount(input.account);
    await this.stepUp(input.pin, 'reveal key material');
    this.requireUnlocked();
    const account = await this.vault.unlockedAccount(meta.id);
    const secret = account.reveal();
    const value = input.kind === 'mnemonic' ? secret.mnemonic : secret.privateKey;
    if (value === undefined) throw new WalletError('INVALID_ARGUMENT', 'account has no mnemonic (imported from a raw key); reveal the private key instead');
    await this.vault.auditAppend('secret.revealed', { accountId: meta.id, address: meta.address, kind: input.kind, via: 'ui' });
    if (input.kind === 'mnemonic' && meta.backedUp !== true) await this.vault.markBackedUp(meta.id);
    return { address: meta.address, kind: input.kind, value };
  }

  /** Export an account as a Web3 Secret Storage keystore JSON. */
  async exportKeystore(accountId: string, keystorePassphrase: string): Promise<{ json: string; address: string }> {
    await this.pinGate();
    this.requireUnlocked();
    return await this.vault.exportKeystore(accountId, keystorePassphrase);
  }

  /** Export a keystore to a 0600 file under `<vault>/exports/`; returns only the path. */
  async exportKeystoreToFile(accountId: string, keystorePassphrase: string): Promise<{ path: string; address: string }> {
    if (typeof keystorePassphrase !== 'string' || keystorePassphrase.length < 8) {
      throw new WalletError('INVALID_ARGUMENT', 'keystorePassphrase must be at least 8 characters');
    }
    const { json, address } = await this.exportKeystore(accountId, keystorePassphrase);
    const dir = join(this.options.vaultPath, 'exports');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const path = join(dir, `keystore-${address}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await writeFile(path, json, { mode: 0o600 });
    await this.vault.auditAppend('keystore.exported', { address, path });
    return { path, address };
  }

  /** Recent audit entries (secret-free by construction). */
  async recentAudit(limit = 30): Promise<Array<{ ts: number; kind: string; detail: Record<string, unknown> }>> {
    return await this.vault.audit.recent(2, limit);
  }

  /** Format wei using a chain's native unit (display helper). */
  formatWei(wei: string | bigint, chainId?: number): string {
    const symbol = getChain(chainId ?? 0)?.symbol ?? 'ETH';
    return `${formatNative(wei)} ${symbol}`;
  }

  /** Build a request the policy engine understands (kept for API compatibility). */
  policyRequestFor(input: TransactionRequestInput): PolicyRequest {
    const data = input.data ?? '0x';
    return {
      type: 'signTransaction',
      account: { address: input.from },
      chainId: requireChainId(input.chainId),
      to: input.to,
      value: input.value !== undefined ? BigInt(input.value).toString() : '0',
      data,
      intent: classifyTransaction({ to: input.to, value: input.value, data }),
    };
  }
}

// ── helpers ───────────────────────────────────────────────────────────────

function requireChainId(value: unknown): number {
  const id = normalizeChainId(value);
  if (id === undefined || !Number.isInteger(id) || id <= 0) {
    throw new WalletError('UNKNOWN_CHAIN', `invalid chainId ${JSON.stringify(value)}`, 'Pass a numeric EVM chain id, e.g. 1 (Ethereum), 8453 (Base). See wallet_chains.');
  }
  return id;
}

/** Native value from `amount` (human units) or `value` (wei); never both. */
function valueOf(input: { value?: string | bigint; amount?: string }, decimals: number, symbol: string): bigint {
  if (input.amount !== undefined && input.value !== undefined) {
    throw new WalletError('INVALID_ARGUMENT', 'pass either amount (native units) or value (wei), not both');
  }
  if (input.amount !== undefined) return parseAmount(input.amount, decimals, symbol);
  if (input.value === undefined) return 0n;
  const raw = typeof input.value === 'bigint' ? input.value.toString() : String(input.value).trim();
  if (!/^\d+$/.test(raw)) {
    throw new WalletError('INVALID_AMOUNT', `value "${raw}" must be an integer number of wei`, 'Prefer the amount parameter with a decimal in native units, e.g. amount: "0.01".');
  }
  return BigInt(raw);
}

/** A report made of pipeline notes only (no checks ran). */
function notesOnly(notes: RiskFinding[]): SecurityView {
  const findings = [...notes].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
  return { severity: findings[0]?.severity ?? 'none', findings, checks: [] };
}

/** One line per finding; high/critical carry a visible mark. */
function warningLines(findings: RiskFinding[]): string[] {
  return findings.map((entry) => (severityRank(entry.severity) >= severityRank('high') ? `${severityMark(entry.severity)}: ${entry.message}` : entry.message));
}

/** Findings for an approval prompt: a security block, strongest first. */
function findingLines(findings: RiskFinding[]): string[] {
  if (findings.length === 0) return [];
  return ['', 'Security checks:', ...findings.map((entry) => `${severityMark(entry.severity)} ${entry.message}`)];
}

/** What the agent should do with a denied request. */
function blockedNext(decision: PolicyDecision): string {
  if (decision.ruleId?.startsWith('security:') === true) {
    return 'Blocked by a security check (see security.findings). Tell the user exactly why. Do not retry, split the payment, change the route, or look for another way to send it.';
  }
  return 'Blocked by the signing policy. Explain the policy reason to the user; do not try to work around it.';
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function chainLabel(chainId: number): string {
  const chain = getChain(chainId);
  return chain !== undefined ? `${chain.shortName} (chain ${String(chainId)})` : `chain ${String(chainId)}`;
}

function intentDisplay(intent: Intent, asset: ResolvedAsset | undefined): { amountFormatted?: string; symbol?: string } {
  if (intent.amount === undefined) return {};
  if (intent.kind === 'native-transfer') {
    return {};
  }
  if (asset?.kind === 'erc20') return { amountFormatted: formatAmount(intent.amount, asset.decimals, asset.symbol), symbol: asset.symbol };
  return {};
}

function who(recipient: ResolvedRecipient | undefined, address: string | undefined): string {
  if (address === undefined) return 'unknown';
  if (recipient !== undefined && recipient.address.toLowerCase() === address.toLowerCase() && recipient.label !== undefined) {
    return `${recipient.label} (${address})`;
  }
  return address;
}

function headlineFor(intent: Intent, tx: PopulatedTransaction, chainId: number, asset: ResolvedAsset | undefined, recipient: ResolvedRecipient | undefined): string {
  const chain = getChain(chainId);
  const symbol = chain?.symbol ?? 'ETH';
  const on = `on ${chainLabel(chainId)}`;
  const tokenAmount = (amount: string | undefined): string =>
    amount === undefined ? 'tokens' : asset?.kind === 'erc20' ? formatAmount(amount, asset.decimals, asset.symbol) : `${amount} units of token ${intent.token ?? tx.to}`;
  switch (intent.kind) {
    case 'native-transfer':
      return `Send ${formatAmount(tx.value, chain?.decimals ?? 18, symbol)} to ${who(recipient, tx.to)} ${on}`;
    case 'token-transfer':
      return `Send ${tokenAmount(intent.amount)} to ${who(recipient, intent.recipient)} ${on}`;
    case 'token-approve':
      return `Allow ${who(recipient, intent.spender)} to spend ${intent.unlimited === true ? `UNLIMITED ${asset?.symbol ?? 'tokens'}` : tokenAmount(intent.amount)} ${on}`;
    case 'token-revoke':
      return `Revoke ${who(recipient, intent.spender)}'s permission on ${asset?.symbol ?? intent.token ?? tx.to} ${on}`;
    case 'nft-approval':
      return `Allow ${intent.spender ?? 'operator'} to move ALL NFTs of collection ${tx.to} ${on}`;
    case 'nft-transfer':
      return `Transfer NFT from collection ${tx.to} to ${intent.recipient ?? 'unknown'} ${on}`;
    default:
      return `Call contract ${tx.to}${intent.method !== undefined ? ` (${intent.method})` : ''}${tx.value > 0n ? ` with ${formatAmount(tx.value, chain?.decimals ?? 18, symbol)}` : ''} ${on}`;
  }
}

/** Approval prompt text: full addresses (never truncated — poisoning), real amounts, warnings. */
function approvalTextFor(plan: Plan, tx: PopulatedTransaction, decision: PolicyDecision, findings: RiskFinding[]): string {
  const chain = getChain(plan.chainId);
  const symbol = chain?.symbol ?? 'ETH';
  const maxFee = tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice ?? 0n);
  const lines = [
    plan.headline,
    '',
    `From:    ${plan.account.label} — ${tx.from}`,
  ];
  if (plan.intent.kind === 'native-transfer') {
    lines.push(`To:      ${who(plan.recipient, tx.to)}${plan.recipient !== undefined ? ` [${plan.recipient.via}]` : ''}`);
  } else {
    if (plan.intent.recipient !== undefined) lines.push(`To:      ${who(plan.recipient, plan.intent.recipient)}${plan.recipient !== undefined ? ` [${plan.recipient.via}]` : ''}`);
    if (plan.intent.spender !== undefined) lines.push(`Spender: ${who(plan.recipient, plan.intent.spender)}`);
    lines.push(`Contract: ${tx.to}${plan.asset?.kind === 'erc20' ? ` (${plan.asset.symbol}, ${plan.asset.source})` : ''}`);
    if (tx.value > 0n) lines.push(`Value:   ${formatAmount(tx.value, chain?.decimals ?? 18, symbol)}`);
    if (plan.intent.kind === 'contract-call') lines.push(`Calldata: ${String((tx.data.length - 2) / 2)} bytes, selector ${tx.data.slice(0, 10)}`);
  }
  lines.push(`Network fee: up to ${formatEther(maxFee)} ${symbol} (gas limit ${tx.gasLimit.toString()}${tx.maxFeePerGas !== undefined ? ` @ ≤ ${formatUnits(tx.maxFeePerGas, 'gwei')} gwei` : ''})`);
  lines.push(`Nonce: ${String(tx.nonce)}`);
  lines.push(...findingLines(findings));
  lines.push('', `Policy: ${decision.reason}`);
  return lines.join('\n');
}

function typedDataApprovalText(
  meta: AccountMeta,
  domain: TypedDataDomain,
  intent: Intent,
  typedDataJson: string,
  decision: PolicyDecision,
  purpose: string | undefined,
  findings: RiskFinding[],
): string {
  const chainId = normalizeChainId(domain.chainId);
  const known = intent.token !== undefined && chainId !== undefined ? findKnownToken(chainId, intent.token) : undefined;
  const amount =
    intent.unlimited === true
      ? 'UNLIMITED'
      : intent.amount !== undefined
        ? known !== undefined
          ? formatAmount(intent.amount, known.decimals, known.symbol)
          : `${intent.amount} atomic units of ${intent.token ?? 'token'}`
        : undefined;
  const headline: Record<string, string> = {
    permit: `PERMIT: let ${intent.spender ?? 'a spender'} spend ${amount ?? 'your tokens'} — signing this is enough for them to take the tokens, no transaction needed`,
    'permit-transfer': `PERMIT2 TRANSFER: let ${intent.spender ?? 'a spender'} transfer ${amount ?? 'your tokens'} out of your wallet`,
    'transfer-authorization': `PAYMENT: authorize ${amount ?? 'a token transfer'} to ${intent.recipient ?? 'unknown'}`,
    order: 'MARKETPLACE ORDER: this signature can sell your assets',
    'token-revoke': 'Revoke a token permission',
  };
  const lines = [
    headline[intent.kind] ?? `Sign EIP-712 typed data (${intent.method ?? 'unknown type'})`,
    '',
    `Signer: ${meta.label} — ${meta.address}`,
    `Domain: ${String(domain.name ?? '?')} v${String(domain.version ?? '?')} on ${chainId !== undefined ? chainLabel(chainId) : 'unspecified chain'}, contract ${String(domain.verifyingContract ?? 'none')}`,
  ];
  if (purpose !== undefined) lines.push(`Purpose: ${purpose}`);
  if (intent.deadline !== undefined) lines.push(`Valid until: ${new Date(intent.deadline * 1000).toISOString()}`);
  lines.push(...findingLines(findings));
  lines.push(`Payload: ${truncate(typedDataJson, 400)}`, '', `Policy: ${decision.reason}`);
  return lines.join('\n');
}

/** Normalized x402 payment requirements (v1 `maxAmountRequired` or v2 `amount`). */
interface X402Requirements {
  x402Version: number;
  payTo: string;
  asset: string;
  maxAmountRequired: string;
  resource?: string;
  description?: string;
  network?: string;
  scheme?: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** Normalize an x402 challenge (accepts-array or flat form, v1 or v2). */
function normalizeX402Challenge(raw: unknown): X402Requirements {
  if (raw === null || typeof raw !== 'object') throw new WalletError('INVALID_ARGUMENT', 'x402 challenge is required (the JSON body of the 402 response)');
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.x402Version === 'number' ? obj.x402Version : 1;
  let item = obj;
  if (Array.isArray(obj.accepts)) {
    const chosen = obj.accepts.find((entry: unknown) => (entry as Record<string, unknown>)?.scheme === 'exact') ?? obj.accepts[0];
    if (chosen === undefined || typeof chosen !== 'object') throw new WalletError('INVALID_ARGUMENT', 'x402 challenge has no accepts entry');
    item = chosen as Record<string, unknown>;
  }
  const payTo = item.payTo;
  const asset = item.asset;
  const maxAmountRequired = item.maxAmountRequired ?? item.amount;
  if (typeof payTo !== 'string' || typeof asset !== 'string' || typeof maxAmountRequired !== 'string') {
    throw new WalletError('INVALID_ARGUMENT', 'x402 challenge requires payTo, asset and maxAmountRequired/amount (atomic units)');
  }
  const scheme = typeof item.scheme === 'string' ? item.scheme : undefined;
  if (scheme !== undefined && scheme !== 'exact') throw new WalletError('INVALID_ARGUMENT', `x402 scheme "${scheme}" not supported (only "exact")`);
  const resource = typeof item.resource === 'string' ? item.resource : typeof (obj.resource as { url?: unknown })?.url === 'string' ? (obj.resource as { url: string }).url : undefined;
  return {
    x402Version: version,
    payTo,
    asset,
    maxAmountRequired,
    ...(resource !== undefined ? { resource } : {}),
    ...(typeof item.description === 'string' ? { description: item.description } : {}),
    ...(typeof item.network === 'string' ? { network: item.network } : {}),
    ...(scheme !== undefined ? { scheme } : {}),
    ...(typeof item.maxTimeoutSeconds === 'number' ? { maxTimeoutSeconds: item.maxTimeoutSeconds } : {}),
    ...(item.extra !== null && typeof item.extra === 'object' ? { extra: item.extra as Record<string, unknown> } : {}),
  };
}

const X402_NETWORK_CHAINS: Record<string, number> = {
  base: 8453,
  'base-sepolia': 84532,
  'ethereum-mainnet': 1,
  ethereum: 1,
  mainnet: 1,
  sepolia: 11155111,
  polygon: 137,
  'polygon-amoy': 80002,
  arbitrum: 42161,
  optimism: 10,
  bsc: 56,
  avalanche: 43114,
  gnosis: 100,
};

/** Resolve an x402 network spec to a numeric chain id. */
function resolveX402ChainId(challenge: { network?: string; chainId?: number }): number {
  if (typeof challenge.chainId === 'number' && Number.isInteger(challenge.chainId)) return challenge.chainId;
  const network = challenge.network;
  if (network === undefined || network === '') throw new WalletError('INVALID_ARGUMENT', 'x402 challenge has no chainId and no network');
  const eip155 = network.match(/^eip155:(\d+)$/);
  if (eip155 !== null) return Number(eip155[1]);
  const named = X402_NETWORK_CHAINS[network.toLowerCase()];
  if (named !== undefined) return named;
  throw new WalletError('UNKNOWN_CHAIN', `unsupported x402 network "${network}"`, 'Only EVM networks are supported; use eip155:<chainId>.');
}

/** Presets in order of how much they let the wallet sign on its own. */
/** A decision that holds the operation for the user instead of signing (semi-managed budget). */
function isBudgetHold(decision: PolicyDecision, security: SecurityView): boolean {
  if (decision.effect !== 'ask' || decision.guardrail !== 'auto-budget') return false;
  // A high or critical security finding is a risk question: it goes to the approval prompt, not to a hold.
  return !security.findings.some((finding) => finding.severity === 'high' || finding.severity === 'critical');
}

const NEEDS_HUMAN_NEXT =
  'This is above the automatic budget, so nothing was signed. Tell the user the amount and why. To let it through they can raise the automatic budget in DSH Settings → Web3 → Limits, or switch the security mode there (strict asks per operation). Retry once only after the user says they changed it; never split the amount to fit the budget.';

/** Marks a lock the user chose, so it survives a host restart (removed by an explicit unlock). */
const USER_LOCK_FILE = 'user-lock.json';

const LOCKED_BY_USER =
  'The Web3 wallet was locked by the user, so nothing was signed. Ask the user to unlock it in DSH Settings → Web3 (or whether you may call wallet_unlock), then retry the same call.';

function lockedAutoFailed(error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `The Web3 wallet is locked and could not be unlocked automatically (${reason}), so nothing was signed. Ask the user to unlock it in DSH Settings → Web3, then retry the same call.`;
}

function attempt<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

const POLICY_PRESETS: PolicyPresetId[] = ['locked', 'strict', 'testnet', 'power', 'micropay', 'agent-semi', 'agent-full'];
const PRESET_RANK: Record<PolicyPresetId, number> = { locked: 0, strict: 1, micropay: 2, testnet: 2, power: 3, 'agent-semi': 4, 'agent-full': 5 };

/**
 * Whether switching from `current` (undefined = custom policy) to `next`
 * strictly reduces autonomy. `locked` always tightens; nothing else tightens
 * a custom policy, whose strictness cannot be compared.
 */
export function isTighteningPreset(current: PolicyPresetId | undefined, next: PolicyPresetId): boolean {
  if (next === 'locked') return true;
  if (current === undefined) return false;
  if (current === next) return true;
  return PRESET_RANK[next] < PRESET_RANK[current];
}

