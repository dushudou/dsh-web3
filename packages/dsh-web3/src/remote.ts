/**
 * Typert Remote namespace for the DSH web settings panel.
 *
 * The built-in DSH web host exposes plugin data over the client Connection RPC
 * carrier (`/api`, endpoint `namespace/method`) through Typert Remote
 * services — raw `http.get()` routes that plugins register on their own are
 * not served by the harness webserver. This namespace mirrors the read-only
 * surface of {@link buildRoutes} plus the create/import wallet flows, so the
 * settings UI can manage a Metamask-style wallet without exposing secrets.
 *
 * Read endpoints return secret-free JSON-serializable values. Write endpoints
 * (`create`, `import`) accept secrets only in the request payload and never
 * persist them; mnemonic reveal is gated on the host approval gateway.
 *
 * @module dsh-web3/remote
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { Context } from '@deepseek-ai/cordis';
import { detectPreset, type PolicyPresetId, type WalletLimits } from 'dsh-web3-core';
import type { WalletService } from './service.js';
import { WalletError } from './errors.js';

/**
 * Mark one `@Remote(method)` method without decorator syntax. The shim mimics
 * the decorator context `addMarkerInitializer` expects and marks the real
 * prototype exactly like a standard-decorator initializer would.
 */
function markRemoteMethod(prototype: object, method: string): void {
  const decorator = Remote(method) as (method: unknown, context: unknown) => void;
  decorator(undefined, {
    name: method,
    private: false,
    static: false,
    addInitializer(fn: () => void) {
      fn.call(Object.create(prototype));
    },
  });
}

interface BalancesRequest {
  chainId?: number;
  address?: string;
}

interface AuditRequest {
  limit?: number;
}

interface CreateRequest {
  label?: string;
  words?: number;
  /** Reveal the freshly generated mnemonic (requires host approval). */
  reveal?: boolean;
}

interface ImportRequest {
  source?: 'mnemonic' | 'privateKey' | 'keystore';
  /** Secret material pasted from the UI (mnemonic / private key / keystore JSON). */
  secret?: string;
  /** Required for keystore imports. */
  keystorePassphrase?: string;
  label?: string;
  index?: number;
}

interface PinRequest {
  pin?: string;
  current?: string;
  next?: string;
}

const IMPORT_SOURCES = ['mnemonic', 'privateKey', 'keystore'] as const;

/** Failure envelope for panel calls: a message plus the stable code the UI branches on. */
function failure(error: unknown): { ok: false; error: string; code?: string } {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof WalletError ? { code: error.code } : {}),
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * `web3` Remote namespace consumed by the settings panel over the client
 * Connection RPC carrier (`/api`, endpoint `web3/<method>`).
 */
export class Web3Remote extends TypertRemoteService {
  private readonly service: WalletService;

  constructor(ctx: Context, service: WalletService) {
    super(ctx, 'web3');
    this.service = service;
  }

  /** Vault status snapshot ({@link WalletService.status}). */
  async status(request: unknown) {
    return this.service.status();
  }

  /**
   * Everything the panel's first paint needs in one round trip (secret-free):
   * vault status, accounts, gates, policy + detected preset, limits, settings.
   */
  async overview(request: unknown) {
    const policy = this.service.getPolicy();
    const pin = await this.service.pinStatus();
    return {
      status: this.service.status(),
      accounts: this.service.listAccounts(),
      pin,
      policy: { preset: detectPreset(policy) ?? 'custom', defaultEffect: policy.defaultEffect, rules: policy.rules, updatedAt: policy.updatedAt },
      ...this.service.limitsView(),
      contacts: this.service.addressBookList(),
      settings: this.service.settingsView(),
      security: this.service.securityView(),
    };
  }

  /** Replace the security check settings. Weakening any check requires `pin`. */
  async securitySet(request: unknown) {
    const query = (request ?? {}) as { settings?: unknown; pin?: string };
    try {
      await this.service.setSecuritySettingsFromPanel(query.settings, text(query.pin));
      return { ok: true, ...this.service.securityView() };
    } catch (error) {
      return failure(error);
    }
  }

  /** Add an address to the denylist (tightens: no PIN). */
  async denylistAdd(request: unknown) {
    const query = (request ?? {}) as { address?: string; label?: string; note?: string };
    try {
      if (typeof query.address !== 'string') throw new WalletError('INVALID_ARGUMENT', 'address is required');
      await this.service.denylistAdd({ address: query.address.trim(), ...(text(query.label) !== undefined ? { label: text(query.label)! } : {}), ...(text(query.note) !== undefined ? { note: text(query.note)! } : {}) }, 'panel');
      return { ok: true, ...this.service.securityView() };
    } catch (error) {
      return failure(error);
    }
  }

  /** Remove an address from the denylist (loosens: PIN step-up). */
  async denylistRemove(request: unknown) {
    const query = (request ?? {}) as { address?: string; pin?: string };
    try {
      if (typeof query.address !== 'string') throw new WalletError('INVALID_ARGUMENT', 'address is required');
      await this.service.denylistRemoveFromPanel(query.address, text(query.pin));
      return { ok: true, ...this.service.securityView() };
    } catch (error) {
      return failure(error);
    }
  }

  /** Re-download the enabled denylist feeds now. */
  async denylistRefresh(request: unknown) {
    try {
      await this.service.refreshDenylistFeeds({ force: true });
      return { ok: true, ...this.service.securityView() };
    } catch (error) {
      return failure(error);
    }
  }

  /** Unlock the vault (passphrase resolves from the credentials store / env). */
  async unlock(request: unknown) {
    try {
      return { ok: true, ...(await this.service.unlock()), status: this.service.status() };
    } catch (error) {
      return failure(error);
    }
  }

  /** Lock the vault and revoke today's PIN grant. */
  async lock(request: unknown) {
    this.service.lock();
    return { ok: true, status: this.service.status() };
  }

  /** Replace the hard limits. Loosening requires `pin` (step-up). */
  async limitsSet(request: unknown) {
    const query = (request ?? {}) as { limits?: WalletLimits; pin?: string };
    try {
      await this.service.setLimitsFromPanel(query.limits as WalletLimits, text(query.pin));
      return { ok: true, ...this.service.limitsView() };
    } catch (error) {
      return failure(error);
    }
  }

  /** Switch the signing policy to a preset. Anything but tightening requires `pin`. */
  async policyPreset(request: unknown) {
    const query = (request ?? {}) as { preset?: string; pin?: string };
    try {
      return { ok: true, ...(await this.service.applyPresetFromPanel(query.preset as PolicyPresetId, text(query.pin))) };
    } catch (error) {
      return failure(error);
    }
  }

  /** Add or edit a contact. Whitelisting or re-addressing requires `pin`. */
  async contactUpsert(request: unknown) {
    const query = (request ?? {}) as { label?: string; address?: string; note?: string; trusted?: boolean; pin?: string };
    if (typeof query.label !== 'string' || typeof query.address !== 'string') return { ok: false, error: 'label and address are required' };
    try {
      const entry = await this.service.upsertContactFromPanel(
        {
          label: query.label,
          address: query.address.trim(),
          ...(typeof query.note === 'string' ? { note: query.note } : {}),
          ...(typeof query.trusted === 'boolean' ? { trusted: query.trusted } : {}),
        },
        text(query.pin),
      );
      return { ok: true, entry };
    } catch (error) {
      return failure(error);
    }
  }

  /** Whitelist / un-whitelist a contact. Whitelisting requires `pin`. */
  async contactTrust(request: unknown) {
    const query = (request ?? {}) as { label?: string; trusted?: boolean; pin?: string };
    if (typeof query.label !== 'string' || typeof query.trusted !== 'boolean') return { ok: false, error: 'label and trusted are required' };
    try {
      return { ok: true, entry: await this.service.setContactTrustedFromPanel(query.label, query.trusted, text(query.pin)) };
    } catch (error) {
      return failure(error);
    }
  }

  /** Remove a contact (never weakens protection, so no PIN). */
  async contactRemove(request: unknown) {
    const query = (request ?? {}) as { label?: string };
    if (typeof query.label !== 'string') return { ok: false, error: 'label is required' };
    try {
      const removed = await this.service.addressBookRemove(query.label);
      return { ok: true, removed: removed !== undefined };
    } catch (error) {
      return failure(error);
    }
  }

  /** Rename an account (display only). */
  async accountRename(request: unknown) {
    const query = (request ?? {}) as { account?: string; label?: string };
    if (typeof query.account !== 'string' || typeof query.label !== 'string') return { ok: false, error: 'account and label are required' };
    try {
      return { ok: true, meta: await this.service.renameAccount(query.account, query.label) };
    } catch (error) {
      return failure(error);
    }
  }

  /** Remove an account. Requires `pin` (step-up). */
  async accountRemove(request: unknown) {
    const query = (request ?? {}) as { account?: string; pin?: string };
    if (typeof query.account !== 'string') return { ok: false, error: 'account is required' };
    try {
      return { ok: true, meta: await this.service.removeAccountFromPanel(query.account, text(query.pin)) };
    } catch (error) {
      return failure(error);
    }
  }

  /** Export an encrypted keystore JSON straight to the browser. Requires `pin` (step-up). */
  async exportKeystore(request: unknown) {
    const query = (request ?? {}) as { account?: string; password?: string; pin?: string };
    if (typeof query.account !== 'string' || typeof query.password !== 'string') return { ok: false, error: 'account and password are required' };
    try {
      return { ok: true, ...(await this.service.exportKeystoreFromPanel(query.account, query.password, text(query.pin))) };
    } catch (error) {
      return failure(error);
    }
  }

  /** List all accounts (metadata only). */
  async accounts(request: unknown) {
    return { accounts: this.service.listAccounts() };
  }

  /** Native + configured token balances. Query: chainId, address. */
  async balances(request: unknown) {
    const query = (request ?? {}) as BalancesRequest;
    if (!Number.isFinite(Number(query.chainId)) || typeof query.address !== 'string') {
      return { ok: false, error: 'query parameters "chainId" and "address" are required' };
    }
    try {
      const meta = this.service.vault.requireAccount(query.address);
      return await this.service.balances(meta, Number(query.chainId));
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Current signing policy. */
  async policy(request: unknown) {
    return { policy: this.service.getPolicy() };
  }

  /** Recent audit entries. Query: limit (default 30). */
  async audit(request: unknown) {
    const query = (request ?? {}) as AuditRequest;
    const limit = Number(query.limit);
    const entries = await this.service.recentAudit(Number.isFinite(limit) ? limit : 30);
    return { entries };
  }

  /** Built-in chain registry. */
  async chains(request: unknown) {
    const { listChains } = await import('dsh-web3-core');
    return { chains: listChains() };
  }

  /**
   * Create a fresh HD account (Metamask-style "create a new wallet").
   *
   * The mnemonic is generated once and returned when `reveal` is true. Unlike
   * the agent tool `wallet_create` (which keeps its reveal behind the
   * session-bound approval gateway), this panel endpoint is a user-initiated
   * local UI action: the person sitting in front of DSH web clicked "create
   * wallet", which is itself the authorization. The DSH approval service is
   * built for in-turn agent tool calls (`req.agent.session` + open turn) and
   * cannot be satisfied from a settings-panel RPC carrier — so this endpoint
   * intentionally does not route through it. Agent access to mnemonics stays
   * gated on `wallet_create`'s approval.
   */
  async create(request: unknown) {
    const query = (request ?? {}) as CreateRequest;
    if (query.words !== undefined && ![12, 15, 18, 21, 24].includes(query.words)) {
      return { ok: false, error: 'words must be one of 12, 15, 18, 21, 24' };
    }
    try {
      const result = await this.service.createAccount({
        label: query.label,
        words: query.words as 12 | 15 | 18 | 21 | 24 | undefined,
      });
      if (query.reveal !== true) {
        return { meta: result.meta, mnemonicRevealed: false };
      }
      await this.service.vault.auditAppend('remote.create_reveal', {
        accountId: result.meta.id,
        address: result.meta.address,
      });
      return { meta: result.meta, mnemonic: result.mnemonic, mnemonicRevealed: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Import an account from pasted secret material (mnemonic / private key /
   * keystore JSON). The secret is staged in a 0600 temp file and deleted
   * after import — never logged, never persisted by the wallet.
   */
  async import(request: unknown) {
    const query = (request ?? {}) as ImportRequest;
    if (!IMPORT_SOURCES.includes(query.source as (typeof IMPORT_SOURCES)[number])) {
      return { ok: false, error: 'source must be "mnemonic", "privateKey", or "keystore"' };
    }
    if (typeof query.secret !== 'string' || query.secret.trim().length === 0) {
      return { ok: false, error: 'secret is required' };
    }
    if (query.source === 'keystore' && typeof query.keystorePassphrase !== 'string') {
      return { ok: false, error: 'keystore import requires keystorePassphrase' };
    }
    const source = query.source as 'mnemonic' | 'privateKey' | 'keystore';
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web3-import-'));
    let keystorePassphraseFile: string | undefined;
    try {
      const secretFile = join(dir, 'secret');
      await writeFile(secretFile, query.secret, { mode: 0o600 });
      if (query.source === 'keystore') {
        keystorePassphraseFile = join(dir, 'passphrase');
        await writeFile(keystorePassphraseFile, query.keystorePassphrase as string, { mode: 0o600 });
      }
      const { meta } = await this.service.importAccount({
        source,
        secretFile,
        keystorePassphraseFile,
        label: query.label,
        index: query.index,
      });
      return { meta };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Reveal a mnemonic / private key for backup (settings panel only — model
   * tools never return key material). Re-verifies the PIN on every call when
   * a PIN is configured (step-up: today's grant alone is not enough).
   */
  async reveal(request: unknown) {
    const query = (request ?? {}) as { account?: string; kind?: string; pin?: string };
    if (typeof query.account !== 'string' || (query.kind !== 'mnemonic' && query.kind !== 'privateKey')) {
      return { ok: false, error: 'account and kind ("mnemonic" | "privateKey") are required' };
    }
    try {
      const secret = await this.service.revealSecretForUi({
        account: query.account,
        kind: query.kind,
        ...(typeof query.pin === 'string' ? { pin: query.pin } : {}),
      });
      return { ok: true, ...secret, pin: await this.service.pinStatus() };
    } catch (error) {
      return { ...failure(error), pin: await this.service.pinStatus() };
    }
  }

  /** Transactions signed by this wallet (local journal, newest first). */
  async history(request: unknown) {
    const query = (request ?? {}) as { limit?: number; account?: string };
    try {
      return {
        transactions: this.service.history({
          ...(typeof query.account === 'string' ? { account: query.account } : {}),
          limit: Number.isFinite(Number(query.limit)) ? Number(query.limit) : 20,
        }),
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Saved contacts. */
  async addressBook(request: unknown) {
    return { entries: this.service.addressBookList() };
  }

  // ── PIN gate (UI-only; PIN never enters model context) ────────────

  /** PIN gate status (secret-free). */
  async pinStatus(request: unknown) {
    return { pin: await this.service.pinStatus() };
  }

  /** Verify a PIN entered in the settings panel (grants today's auth). */
  async pinVerify(request: unknown) {
    const query = (request ?? {}) as PinRequest;
    if (typeof query.pin !== 'string' || query.pin.length === 0) {
      return { ok: false, error: 'pin is required' };
    }
    try {
      const result = await this.service.pinVerify(query.pin);
      if (!result.ok && !result.status.locked) {
        return { ok: false, error: 'incorrect PIN', pin: result.status };
      }
      return { ok: result.ok, pin: result.status };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        pin: await this.service.pinStatus(),
      };
    }
  }

  /** Configure an initial PIN. */
  async pinSetup(request: unknown) {
    const query = (request ?? {}) as PinRequest;
    if (typeof query.pin !== 'string' || query.pin.length === 0) {
      return { ok: false, error: 'pin is required' };
    }
    try {
      const status = await this.service.pinSetup(query.pin);
      return { ok: true, pin: status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Change the PIN after verifying the current one. */
  async pinChange(request: unknown) {
    const query = (request ?? {}) as PinRequest;
    if (typeof query.current !== 'string' || typeof query.next !== 'string') {
      return { ok: false, error: 'current and next pin are required' };
    }
    try {
      const status = await this.service.pinChange(query.current, query.next);
      return { ok: true, pin: status };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /** Revoke the current authorization (manual lock). */
  async pinLock(request: unknown) {
    return { ok: true, pin: await this.service.pinClearDaily() };
  }

  /** Set how long one PIN entry authorizes sensitive operations (1, 7 or 30 days). */
  async pinGrantDays(request: unknown) {
    const query = (request ?? {}) as { days?: unknown; pin?: string };
    if (query.days !== 1 && query.days !== 7 && query.days !== 30) {
      return { ok: false, error: 'days must be 1, 7 or 30' };
    }
    try {
      const status = await this.service.setPinGrantDaysFromPanel(query.days, text(query.pin));
      return { ok: true, pin: status };
    } catch (error) {
      return failure(error);
    }
  }

}

for (const method of [
  'status',
  'overview',
  'unlock',
  'lock',
  'limitsSet',
  'policyPreset',
  'securitySet',
  'denylistAdd',
  'denylistRemove',
  'denylistRefresh',
  'contactUpsert',
  'contactTrust',
  'contactRemove',
  'accountRename',
  'accountRemove',
  'exportKeystore',
  'accounts',
  'balances',
  'policy',
  'audit',
  'chains',
  'create',
  'import',
  'reveal',
  'history',
  'addressBook',
  'pinStatus',
  'pinVerify',
  'pinSetup',
  'pinChange',
  'pinLock',
  'pinGrantDays',
]) {
  markRemoteMethod(Web3Remote.prototype, method);
}
