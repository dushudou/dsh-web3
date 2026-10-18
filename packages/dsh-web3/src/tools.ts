/**
 * Model tool definitions for the wallet plugin.
 *
 * {@link buildTools} constructs the full tool surface from a wallet service and
 * an approval gateway. Each tool has `execute(args, ctx)` and an `output`
 * declaration (JSON-Schema + render) matching the DSH `ctx.tools` registry
 * (`ToolDefinition` shape), so `wallet_*` tools appear in the agent's native
 * function catalog and can be invoked by the model.
 *
 * Design rules for agent accuracy:
 * - Human units in, exact units out: transfers take `amount: "0.05"` and a
 *   token symbol; the wallet converts with the token's real decimals.
 * - Prepare → confirm → execute by `preparedId`, so what the user confirmed
 *   is exactly what gets signed; ids are single-use and `idempotencyKey`
 *   makes retries safe.
 * - Every failure is `{ ok: false, code, message, hint }` with a next step.
 * - Key material never enters the model transcript (it would be sent to the
 *   model provider and stored in session logs); backups happen in the
 *   settings panel.
 *
 * Tools are authored in the DSH parameter DSL (an open object root whose
 * properties carry `{ type, description?, required?, enum? }`) and registered
 * as wire-level JSON Schema (`{ type: 'object', properties, required }`), the
 * same projection `defineTool()` performs. `ctx.tools.register()` stores the
 * definition as-is, so a DSL root would reach the model provider without
 * `type: "object"` — strict providers (DeepSeek) reject that.
 *
 * @module dsh-web3/tools
 */

import type { TypedDataDomain, TypedDataField } from 'ethers';
import { detectPreset, getChain, listChains, knownTokens, policyPreset, type PolicyPresetId } from 'dsh-web3-core';
import type { ApprovalGateway, WalletService } from './service.js';
import { WalletError, toToolError } from './errors.js';

/** Context passed to every tool execution. */
export interface ToolCallContext {
  callId?: string;
  signal?: AbortSignal;
  /** The DSH agent driving the call (host approval service needs `agent.session`). */
  agent?: unknown;
}

/** A rendered output block for the model. */
export interface OutputBlock {
  type: 'text' | 'image';
  text?: string;
}

/** One property in the DSH parameter DSL. */
export interface ParamSpec {
  type: string;
  description?: string;
  required?: boolean;
  enum?: unknown[];
  items?: { type: string };
  examples?: unknown;
}

/** Tool parameter schema in the DSL (open object root). */
export type ToolParameters = Record<string, ParamSpec>;

/** One property of the wire-level JSON Schema. */
export interface JsonSchemaProperty {
  /** Absent for `json` (any JSON value). */
  type?: string;
  description?: string;
  enum?: unknown[];
  examples?: unknown;
  items?: { type: string };
}

/** Wire-level parameter schema: an object root, as `defineTool()` projects it. */
export interface ParametersJsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required?: string[];
}

/**
 * Project DSL parameters onto JSON Schema exactly like DSH's
 * `parameterSchemaSpecToJsonSchema`: `json` becomes an untyped (any) schema,
 * `required: true` moves into the root `required` list.
 */
export function toParametersJsonSchema(parameters: ToolParameters): ParametersJsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  const required: string[] = [];
  for (const [key, spec] of Object.entries(parameters)) {
    properties[key] = {
      ...(spec.type !== 'json' ? { type: spec.type } : {}),
      ...(spec.description !== undefined ? { description: spec.description } : {}),
      ...(spec.enum !== undefined ? { enum: spec.enum } : {}),
      ...(spec.examples !== undefined ? { examples: spec.examples } : {}),
      ...(spec.items !== undefined ? { items: { ...spec.items } } : {}),
    };
    if (spec.required === true) required.push(key);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/** A tool as authored (DSL parameters). */
type ToolSpec = Omit<WalletTool, 'parameters'> & { parameters: ToolParameters };

/** A single model tool, DSH `ToolDefinition`-shaped (JSON Schema parameters). */
export interface WalletTool {
  name: string;
  description: string;
  parameters: ParametersJsonSchema;
  execute(args: Record<string, unknown>, ctx: ToolCallContext): Promise<unknown>;
  output: {
    schema: { type: 'object' };
    render(args: Record<string, unknown>, value: unknown): OutputBlock[];
  };
  /** Read-only tools may run in parallel with siblings (never model-visible). */
  isConcurrencySafe?(args: unknown): boolean;
  /** Native DSH tool-card header for a pending call (never model-visible). */
  presentCall?(args: unknown): { card: 'generic'; title: string; kind?: 'read' | 'edit' | 'delete' | 'execute' | 'other' } | undefined;
}

/** Options for {@link buildTools}. */
export interface BuildToolsOptions {
  service: WalletService;
  approval: ApprovalGateway;
  /**
   * UNSAFE: let `wallet_reveal_secret` / `wallet_create reveal` return key
   * material into the model transcript after human approval. Off by default:
   * the transcript is sent to the model provider and persisted in session logs.
   */
  allowModelSecretReveal?: boolean;
}

const PRESETS: PolicyPresetId[] = ['locked', 'strict', 'testnet', 'power', 'micropay', 'agent-semi', 'agent-full'];

/** What each preset means for the user, for the tighten-policy approval prompt. */
const PRESET_EFFECT: Record<PolicyPresetId, string> = {
  locked: 'All signing will be refused until you change it in Settings → Web3.',
  strict: 'Every signing request will ask for your approval.',
  micropay: 'Every signing request will ask for your approval, except small x402 USDC payments.',
  testnet: 'Small testnet operations sign automatically; mainnet asks every time.',
  power: 'Small mainnet native transfers sign automatically; tokens and approvals ask.',
  'agent-semi': 'The agent signs on its own within the automatic budget; anything above it is held for you.',
  'agent-full': 'The agent signs on its own up to the hard limits.',
};

const accountSelector: ParamSpec = { type: 'string', description: 'Account id, address, or exact label (see wallet_list).', required: true };
const chainId: ParamSpec = {
  type: 'number',
  description: 'EVM chain id: 1 Ethereum, 8453 Base, 42161 Arbitrum, 10 Optimism, 137 Polygon, 56 BSC, 11155111 Sepolia, 84532 Base Sepolia (wallet_chains lists all).',
  required: true,
};
const recipient: ParamSpec = {
  type: 'string',
  description: 'Recipient: full 0x address, ENS name (vitalik.eth), exact address-book label, or own account label. Never shorten or guess addresses.',
  required: true,
};
const idempotencyKey: ParamSpec = {
  type: 'string',
  description: 'Optional unique key for this payment intent (e.g. "rent-2026-09"). Re-using it returns the earlier result instead of paying twice.',
};

function jsonBlock(value: unknown): OutputBlock[] {
  return [{ type: 'text', text: JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v), 2) }];
}

/** Declare a JSON-object output rendered as pretty JSON text. */
function jsonOutput(_args: Record<string, unknown>, value: unknown): OutputBlock[] {
  return jsonBlock(value);
}

const OUTPUT = { schema: { type: 'object' as const }, render: jsonOutput };
const readOnly = (): boolean => true;

/** Wrap an executor so every failure becomes a structured, actionable result. */
function guarded(execute: WalletTool['execute']): WalletTool['execute'] {
  return async (args, ctx) => {
    try {
      return await execute(args ?? {}, ctx ?? {});
    } catch (error) {
      return toToolError(error);
    }
  };
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  if (typeof value !== 'string') throw new WalletError('INVALID_ARGUMENT', `${key} must be a string`);
  return value;
}

function requireStr(args: Record<string, unknown>, key: string): string {
  const value = str(args, key);
  if (value === undefined) throw new WalletError('INVALID_ARGUMENT', `${key} is required`);
  return value;
}

function jsonArg(args: Record<string, unknown>, key: string): unknown {
  const value = args[key];
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      throw new WalletError('INVALID_ARGUMENT', `${key} must be a JSON object`);
    }
  }
  return value;
}

/**
 * Build the full wallet tool surface.
 *
 * @param options - the wallet service and approval gateway.
 * @returns an array of tool descriptors ready for registration.
 */
export function buildTools(options: BuildToolsOptions): WalletTool[] {
  const { service, approval } = options;
  const allowReveal = options.allowModelSecretReveal === true;
  const ctxOf = (toolName: string, ctx: ToolCallContext) => ({ toolName, callId: ctx.callId, signal: ctx.signal, agent: ctx.agent });

  const panelPolicyMessage =
    '放宽安全设置（切换到更自主的安全模式，如半托管 / 全托管 / testnet / power / micropay，自定义规则、提高限额或自动预算、加入白名单）只能由用户在 DSH 设置 → Web3 → 限额 中完成，并需要输入 PIN 确认。请把这一点告诉用户，不要尝试其他方式绕过。';
  const panelBackupMessage =
    '出于安全考虑，助记词/私钥不会通过对话返回（对话内容会发送给模型服务并写入会话日志）。请引导用户前往 DSH 设置 → Web3 → 账户，点击对应账户的「备份」，在界面中输入 PIN 后查看。';

  const specs: ToolSpec[] = [
    // ── status & session ────────────────────────────────────────────────
    {
      name: 'wallet_status',
      description:
        'Wallet overview: locked/unlocked, account count, policy summary, and PIN authorization state. Call first before any wallet work.',
      parameters: {},
      execute: guarded(async () => {
        const { limits } = service.limitsView();
        return {
          ...service.status(),
          pin: await service.pinStatus(),
          preset: detectPreset(service.getPolicy()) ?? 'custom',
          limits: { whitelistOnly: limits.whitelistOnly, usd: limits.usd, native: limits.native },
        };
      }),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_unlock',
      description: 'Unlock the vault. The passphrase resolves automatically (env / credentials store) — never ask the user for it. Optional 0600 passphraseFile (deleted after use).',
      parameters: {
        passphraseFile: { type: 'string', description: 'Absolute path to a 0600 file containing the passphrase (manual setups only).' },
      },
      execute: guarded(async (args) => service.unlock(str(args, 'passphraseFile'))),
      output: OUTPUT,
    },
    {
      name: 'wallet_lock',
      description: 'Lock the vault (drops decrypted keys from memory) and revoke today\'s PIN grant. Only when the user asks.',
      parameters: {},
      execute: guarded(async () => {
        service.lock();
        return { locked: true };
      }),
      output: OUTPUT,
    },

    // ── accounts ────────────────────────────────────────────────────────
    {
      name: 'wallet_list',
      description: 'List vault accounts (id, label, address, source, backedUp). No secrets.',
      parameters: {},
      execute: guarded(async () => ({ accounts: service.listAccounts() })),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_create',
      description:
        'Create an account. Default: a new wallet with a fresh BIP-39 mnemonic. With fromAccount: derive the next address from that account\'s existing seed (MetaMask "Add account", same backup). The mnemonic is never returned here — the user backs it up in DSH Settings → Web3.',
      parameters: {
        label: { type: 'string', description: 'Human-readable label, e.g. "Trading".' },
        words: { type: 'number', enum: [12, 15, 18, 21, 24], description: 'Mnemonic word count for a new wallet. Default 12.' },
        fromAccount: { type: 'string', description: 'Derive from this account\'s seed instead of creating a new mnemonic.' },
        reveal: { type: 'boolean', description: 'Deprecated: backups happen in the settings panel.' },
      },
      execute: guarded(async (args, ctx) => {
        const label = str(args, 'label');
        const fromAccount = str(args, 'fromAccount');
        if (fromAccount !== undefined) {
          const { meta } = await service.deriveAccount({ fromAccount, ...(label !== undefined ? { label } : {}) });
          return { meta, derived: true, mnemonicRevealed: false };
        }
        const result = await service.createAccount({ label, words: args.words as 12 | 15 | 18 | 21 | 24 | undefined });
        if (args.reveal !== true) {
          return { meta: result.meta, mnemonicRevealed: false, backup: 'Remind the user to back up the mnemonic in DSH Settings → Web3 → Accounts → Backup.' };
        }
        if (!allowReveal) {
          await service.vault.auditAppend('tool.reveal_redirected', { accountId: result.meta.id });
          return { meta: result.meta, mnemonicRevealed: false, status: 'use-panel', message: panelBackupMessage };
        }
        const outcome = await approval.request({
          ...ctxOf('wallet_create', ctx),
          reason: `Reveal the mnemonic for new account ${result.meta.address} (${result.meta.label}) INTO THE CHAT TRANSCRIPT? It will be sent to the model provider and stored in session logs.`,
        });
        if (outcome === 'allowed-once') return { meta: result.meta, mnemonic: result.mnemonic, mnemonicRevealed: true };
        await service.vault.auditAppend('tool.reveal_denied', { accountId: result.meta.id, outcome });
        return { meta: result.meta, mnemonicRevealed: false };
      }),
      output: OUTPUT,
    },
    {
      name: 'wallet_import',
      description:
        'Import an account from a 0600 secret file (mnemonic, private key, or keystore JSON); the file is deleted after reading. Prefer telling the user to import in DSH Settings → Web3 → Import — never ask them to paste secrets into chat.',
      parameters: {
        source: { type: 'string', enum: ['mnemonic', 'privateKey', 'keystore'], description: 'Type of secret material.', required: true },
        secretFile: { type: 'string', description: 'Absolute path to a 0600 file containing the secret.', required: true },
        keystorePassphraseFile: { type: 'string', description: 'Required for keystore: path to the keystore passphrase file.' },
        label: { type: 'string', description: 'Human-readable label.' },
        index: { type: 'number', description: 'HD derivation index for mnemonic imports (default 0).' },
      },
      execute: guarded(async (args) =>
        service.importAccount({
          source: requireStr(args, 'source') as 'mnemonic' | 'privateKey' | 'keystore',
          secretFile: requireStr(args, 'secretFile'),
          keystorePassphraseFile: str(args, 'keystorePassphraseFile'),
          label: str(args, 'label'),
          index: args.index as number | undefined,
        }),
      ),
      output: OUTPUT,
    },
    {
      name: 'wallet_remove_account',
      description: 'Remove an account from the vault (deletes its encrypted key; irreversible without a backup). Requires human approval + PIN authorization.',
      parameters: { account: accountSelector },
      execute: guarded(async (args, ctx) => {
        const meta = service.vault.requireAccount(requireStr(args, 'account'));
        const outcome = await approval.request({
          ...ctxOf('wallet_remove_account', ctx),
          reason: `Remove account ${meta.label} — ${meta.address} from the wallet?${meta.backedUp === true ? '' : '\n⚠ This account has NOT been backed up: its funds become unrecoverable.'}`,
        });
        if (outcome !== 'allowed-once') return { removed: false, approvalOutcome: outcome };
        return { removed: true, meta: await service.removeAccount(meta.id) };
      }),
      output: OUTPUT,
    },

    // ── chains, balances, contacts ──────────────────────────────────────
    {
      name: 'wallet_chains',
      description: 'Supported EVM chains (id, name, native symbol, testnet flag, explorer) and the well-known token symbols usable on each.',
      parameters: {},
      execute: guarded(async () => ({
        chains: listChains().map((chain) => ({
          chainId: chain.chainId,
          name: chain.name,
          symbol: chain.symbol,
          testnet: chain.testnet,
          explorer: chain.explorer,
          tokens: knownTokens(chain.chainId).map((token) => token.symbol),
        })),
      })),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_balance',
      description: 'Native + token balances for an account on one chain (formatted in whole units). Default tokens: configured + well-known (USDC, USDT …).',
      parameters: {
        account: accountSelector,
        chainId,
        tokens: { type: 'array', items: { type: 'string' }, description: 'Optional token symbols or contract addresses to query.' },
      },
      execute: guarded(async (args) => {
        const meta = service.vault.requireAccount(requireStr(args, 'account'));
        const tokens = Array.isArray(args.tokens) ? (args.tokens as unknown[]).map(String) : undefined;
        return service.balances(meta, args.chainId as number, tokens);
      }),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_address_book',
      description:
        'Saved contacts, so recipients can be referred to by name. action=list (read-only), add, remove. add/remove require human approval because labels are shown to the user in payment approvals.',
      parameters: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], required: true },
        label: { type: 'string', description: 'Contact name (add/remove). Exact match is used when resolving recipients.' },
        address: { type: 'string', description: 'Full 0x address (add).' },
        note: { type: 'string', description: 'Optional note (add).' },
        chainIds: { type: 'array', items: { type: 'number' }, description: 'Optional: restrict the contact to these chains (add).' },
      },
      execute: guarded(async (args, ctx) => {
        const action = requireStr(args, 'action');
        if (action === 'list') return { entries: service.addressBookList() };
        const label = requireStr(args, 'label');
        if (action === 'add') {
          const address = requireStr(args, 'address');
          const outcome = await approval.request({ ...ctxOf('wallet_address_book', ctx), reason: `Save contact "${label}" = ${address}?\nPayments to "${label}" will go to this exact address.` });
          if (outcome !== 'allowed-once') return { saved: false, approvalOutcome: outcome };
          const chainIds = Array.isArray(args.chainIds) ? (args.chainIds as unknown[]).map(Number) : undefined;
          return { saved: true, entry: await service.addressBookAdd({ label, address, note: str(args, 'note'), ...(chainIds !== undefined ? { chainIds } : {}) }) };
        }
        if (action === 'remove') {
          const outcome = await approval.request({ ...ctxOf('wallet_address_book', ctx), reason: `Remove contact "${label}" from the address book?` });
          if (outcome !== 'allowed-once') return { removed: false, approvalOutcome: outcome };
          const removed = await service.addressBookRemove(label);
          return { removed: removed !== undefined, ...(removed !== undefined ? { entry: removed } : {}) };
        }
        throw new WalletError('INVALID_ARGUMENT', `unknown action "${action}"`, 'Use list, add, or remove.');
      }),
      output: OUTPUT,
    },

    // ── security ────────────────────────────────────────────────────────
    {
      name: 'wallet_security_check',
      description:
        'Check an address BEFORE paying or approving it: denylist (OFAC sanctions + scam database + user list), on-chain sanctions oracle, look-alikes of known contacts (address poisoning), wallet vs contract, and GoPlus reputation when the user enabled it. Read-only. Every transfer, approval, and signature is checked automatically anyway; use this when the user asks "is this address safe?" or before suggesting a new payee.',
      parameters: {
        address: { type: 'string', description: 'Full 0x address, ENS name, or exact address-book label.', required: true },
        chainId,
        account: { type: 'string', description: 'Optional: the account that would pay (for "have I paid this before" and look-alike checks).' },
      },
      execute: guarded(async (args) =>
        service.checkAddress({ address: requireStr(args, 'address'), chainId: args.chainId as number, ...(str(args, 'account') !== undefined ? { account: str(args, 'account')! } : {}) }),
      ),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_denylist',
      description:
        'The wallet denylist: addresses it refuses to pay or grant permissions to (critical finding, no approval can override). action=list (read-only) or add (e.g. when the user says an address scammed them). Removing an address loosens protection: it returns status "use-panel"; tell the user to remove it in DSH Settings → Web3 → Security (PIN-confirmed).',
      parameters: {
        action: { type: 'string', enum: ['list', 'add', 'remove'], required: true },
        address: { type: 'string', description: 'Full 0x address (add/remove).' },
        label: { type: 'string', description: 'Short reason shown in findings, e.g. "phishing site payee" (add).' },
        note: { type: 'string', description: 'Optional longer note (add).' },
      },
      execute: guarded(async (args) => {
        const action = requireStr(args, 'action');
        if (action === 'list') {
          const view = service.securityView();
          return { entries: view.denylist, feeds: view.feeds.map(({ id, name, count, fetchedAt }) => ({ id, name, count, enabled: view.settings.feeds[id], ...(fetchedAt !== undefined ? { fetchedAt } : {}) })) };
        }
        if (action === 'add') {
          const entry = await service.denylistAdd({ address: requireStr(args, 'address'), ...(str(args, 'label') !== undefined ? { label: str(args, 'label')! } : {}), ...(str(args, 'note') !== undefined ? { note: str(args, 'note')! } : {}) }, 'agent');
          return { added: true, entry };
        }
        if (action === 'remove') {
          await service.vault.auditAppend('tool.denylist_remove_redirected', { address: str(args, 'address') });
          return {
            removed: false,
            status: 'use-panel',
            message: '从黑名单移除地址会降低安全保护，只能由用户在 DSH 设置 → Web3 → 安全 中完成，并需要输入 PIN 确认。请把这一点告诉用户。',
          };
        }
        throw new WalletError('INVALID_ARGUMENT', `unknown action "${action}"`, 'Use list, add, or remove.');
      }),
      output: OUTPUT,
    },

    // ── sending ─────────────────────────────────────────────────────────
    {
      name: 'wallet_transfer',
      description:
        'Send native coin or an ERC-20 token using HUMAN units: amount "0.05" + token "USDC" (the wallet converts with the token\'s real decimals — never convert to wei yourself). Recommended flow: call with dryRun=true, show the user `summary` and every `security.findings` entry (HIGH/CRITICAL ones word for word), get confirmation, then execute with wallet_send_transaction { preparedId }. Without dryRun it prepares and sends in one step (policy / PIN authorization / human approval still apply).',
      parameters: {
        account: accountSelector,
        chainId,
        to: recipient,
        amount: { type: 'string', description: 'Decimal amount in whole units, e.g. "25" or "0.015", or "max" for the full balance (minus fee for native).', required: true, examples: ['0.01', '25', 'max'] },
        token: { type: 'string', description: 'Token symbol (USDC, USDT, DAI, WETH …) or contract address. Omit for the chain\'s native coin (ETH, POL, BNB …).' },
        dryRun: { type: 'boolean', description: 'Only prepare and return the summary + preparedId; nothing is signed.' },
        idempotencyKey,
      },
      execute: guarded(async (args, ctx) => {
        const input = {
          account: requireStr(args, 'account'),
          chainId: args.chainId as number,
          to: requireStr(args, 'to'),
          amount: requireStr(args, 'amount'),
          ...(str(args, 'token') !== undefined ? { token: str(args, 'token')! } : {}),
          ...(str(args, 'idempotencyKey') !== undefined ? { idempotencyKey: str(args, 'idempotencyKey')! } : {}),
        };
        if (args.dryRun === true) return await service.prepareTransfer(input);
        return await service.transfer(input, approval, ctxOf('wallet_transfer', ctx));
      }),
      output: OUTPUT,
    },
    {
      name: 'wallet_prepare_transaction',
      description:
        'Dry-run a raw contract call / transaction: fills nonce, gas, fees; decodes what it does (token transfer, approval …); checks balance and revert; evaluates the signing policy. Nothing is signed. Returns a preparedId for wallet_send_transaction. For plain transfers use wallet_transfer instead.',
      parameters: {
        account: accountSelector,
        chainId,
        to: { type: 'string', description: 'Contract or recipient address.', required: true },
        amount: { type: 'string', description: 'Native coin to attach, in whole units (e.g. "0.01"). Preferred over value.' },
        value: { type: 'string', description: 'Native coin to attach, in wei (integer string). Use amount instead unless you already have exact wei.' },
        data: { type: 'string', description: 'Calldata (0x-prefixed hex).' },
        idempotencyKey,
      },
      execute: guarded(async (args) => {
        const meta = service.vault.requireAccount(requireStr(args, 'account'));
        return await service.prepareTransaction({
          from: meta.address,
          chainId: args.chainId as number,
          to: requireStr(args, 'to'),
          ...(str(args, 'value') !== undefined ? { value: str(args, 'value')! } : {}),
          ...(str(args, 'amount') !== undefined ? { amount: str(args, 'amount')! } : {}),
          ...(str(args, 'data') !== undefined ? { data: str(args, 'data')! } : {}),
          ...(str(args, 'idempotencyKey') !== undefined ? { idempotencyKey: str(args, 'idempotencyKey')! } : {}),
        });
      }),
      output: OUTPUT,
    },
    {
      name: 'wallet_send_transaction',
      description:
        'Execute a transaction. Preferred: { preparedId } from wallet_transfer(dryRun) / wallet_prepare_transaction / wallet_approve_token — signs exactly what the user reviewed (fees and nonce refreshed). Alternatively pass raw fields (account, chainId, to, amount|value, data) for a one-shot send. Flow: policy → PIN authorization → human approval (when required) → sign → broadcast. If status is "broadcast-uncertain", NEVER resend: check wallet_tx_status.',
      parameters: {
        preparedId: { type: 'string', description: 'Id returned by a prepare / dryRun call (valid 15 minutes, single use).' },
        account: { type: 'string', description: 'Raw mode: account id, address, or label.' },
        chainId: { type: 'number', description: 'Raw mode: EVM chain id.' },
        to: { type: 'string', description: 'Raw mode: contract or recipient address.' },
        amount: { type: 'string', description: 'Raw mode: native coin in whole units (e.g. "0.01"). Preferred over value.' },
        value: { type: 'string', description: 'Raw mode: native coin in wei (integer string).' },
        data: { type: 'string', description: 'Raw mode: calldata (0x-prefixed hex).' },
        idempotencyKey,
      },
      execute: guarded(async (args, ctx) => {
        const context = ctxOf('wallet_send_transaction', ctx);
        const preparedId = str(args, 'preparedId');
        if (preparedId !== undefined) return await service.executePrepared(preparedId, approval, context);
        if (str(args, 'account') === undefined || str(args, 'to') === undefined || args.chainId === undefined) {
          throw new WalletError('INVALID_ARGUMENT', 'pass preparedId, or account + chainId + to for a raw send');
        }
        const meta = service.vault.requireAccount(requireStr(args, 'account'));
        return await service.sendTransaction(
          {
            from: meta.address,
            chainId: args.chainId as number,
            to: requireStr(args, 'to'),
            ...(str(args, 'value') !== undefined ? { value: str(args, 'value')! } : {}),
            ...(str(args, 'amount') !== undefined ? { amount: str(args, 'amount')! } : {}),
            ...(str(args, 'data') !== undefined ? { data: str(args, 'data')! } : {}),
            ...(str(args, 'idempotencyKey') !== undefined ? { idempotencyKey: str(args, 'idempotencyKey')! } : {}),
          },
          approval,
          context,
        );
      }),
      output: OUTPUT,
    },
    {
      name: 'wallet_approve_token',
      description:
        'Set an ERC-20 allowance for a spender (a DeFi contract). amount in whole units, "0" to revoke, or "unlimited" (always requires human approval — avoid unless the user insists). Use dryRun=true to review first.',
      parameters: {
        account: accountSelector,
        chainId,
        token: { type: 'string', description: 'Token symbol or contract address.', required: true },
        spender: { type: 'string', description: 'Spender contract address (or address-book label).', required: true },
        amount: { type: 'string', description: 'Allowance in whole units, "0" to revoke, or "unlimited".', required: true },
        dryRun: { type: 'boolean', description: 'Only prepare; returns preparedId.' },
      },
      execute: guarded(async (args, ctx) => {
        const prepared = await service.prepareApprove({
          account: requireStr(args, 'account'),
          chainId: args.chainId as number,
          token: requireStr(args, 'token'),
          spender: requireStr(args, 'spender'),
          amount: requireStr(args, 'amount'),
        });
        if (args.dryRun === true) return prepared;
        return await service.executePrepared(prepared.preparedId, approval, ctxOf('wallet_approve_token', ctx));
      }),
      output: OUTPUT,
    },
    {
      name: 'wallet_allowance',
      description: 'Read the current ERC-20 allowance an account has granted to a spender.',
      parameters: {
        account: accountSelector,
        chainId,
        token: { type: 'string', description: 'Token symbol or contract address.', required: true },
        spender: { type: 'string', description: 'Spender address.', required: true },
      },
      execute: guarded(async (args) =>
        service.allowance({ account: requireStr(args, 'account'), chainId: args.chainId as number, token: requireStr(args, 'token'), spender: requireStr(args, 'spender') }),
      ),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },

    // ── transaction lifecycle ───────────────────────────────────────────
    {
      name: 'wallet_tx_status',
      description: 'Status of a transaction: pending / success / reverted / replaced / unknown, with block and explorer link. Use after sending, and ALWAYS before retrying anything.',
      parameters: {
        txHash: { type: 'string', description: '0x transaction hash.', required: true },
        chainId: { type: 'number', description: 'Only needed for transactions not sent by this wallet.' },
      },
      execute: guarded(async (args) => service.txStatus({ txHash: requireStr(args, 'txHash'), ...(args.chainId !== undefined ? { chainId: args.chainId as number } : {}) })),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_history',
      description: 'Transactions this wallet signed (local journal, newest first) with summaries and statuses. Not a full on-chain history (incoming transfers are not listed).',
      parameters: {
        account: { type: 'string', description: 'Filter by account.' },
        chainId: { type: 'number', description: 'Filter by chain.' },
        limit: { type: 'number', description: 'Max entries (default 20, max 100).' },
      },
      execute: guarded(async (args) => ({
        transactions: service.history({
          ...(str(args, 'account') !== undefined ? { account: str(args, 'account')! } : {}),
          ...(args.chainId !== undefined ? { chainId: args.chainId as number } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
        }),
      })),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_replace_transaction',
      description: 'Speed up (same transaction, higher fee) or cancel (0-value self-send) a PENDING transaction sent by this wallet, reusing its nonce. Goes through policy / PIN / approval.',
      parameters: {
        txHash: { type: 'string', description: 'Hash of the pending transaction.', required: true },
        action: { type: 'string', enum: ['speed-up', 'cancel'], required: true },
      },
      execute: guarded(async (args, ctx) =>
        service.replaceTransaction(
          { txHash: requireStr(args, 'txHash'), action: requireStr(args, 'action') as 'speed-up' | 'cancel' },
          approval,
          ctxOf('wallet_replace_transaction', ctx),
        ),
      ),
      output: OUTPUT,
    },

    // ── signatures ──────────────────────────────────────────────────────
    {
      name: 'wallet_sign_message',
      description: 'Sign an EIP-191 personal message (e.g. Sign-In with Ethereum). Policy, PIN authorization and human approval apply.',
      parameters: {
        account: accountSelector,
        message: { type: 'string', description: 'The exact message text to sign.', required: true },
      },
      execute: guarded(async (args, ctx) =>
        service.signMessage({ account: requireStr(args, 'account'), message: requireStr(args, 'message') }, approval, ctxOf('wallet_sign_message', ctx)),
      ),
      output: OUTPUT,
    },
    {
      name: 'wallet_sign_typed_data',
      description:
        'Sign EIP-712 typed data. The wallet decodes Permit / Permit2 / TransferWithAuthorization / marketplace orders and gates them like token moves (a permit signature alone lets the spender take tokens). Never sign payloads from untrusted pages without showing the user what they grant. For x402 payments use wallet_x402_authorize.',
      parameters: {
        account: accountSelector,
        domain: { type: 'json', description: 'EIP-712 domain object (name, version, chainId, verifyingContract).', required: true },
        types: { type: 'json', description: 'EIP-712 type definitions (EIP712Domain entry optional).', required: true },
        value: { type: 'json', description: 'The EIP-712 message object to sign.' },
        message: { type: 'json', description: 'Alias of value (some dApps call it "message"). Pass one of the two.' },
      },
      execute: guarded(async (args, ctx) => {
        const value = jsonArg(args, 'value') ?? jsonArg(args, 'message');
        return await service.signTypedData(
          {
            account: requireStr(args, 'account'),
            domain: jsonArg(args, 'domain') as TypedDataDomain,
            types: jsonArg(args, 'types') as Record<string, TypedDataField[]>,
            value: value as Record<string, unknown>,
          },
          approval,
          ctxOf('wallet_sign_typed_data', ctx),
        );
      }),
      output: OUTPUT,
    },
    {
      name: 'wallet_x402_authorize',
      description:
        'Pay for an HTTP 402 (x402) resource: pass the 402 response body as `challenge` ({ x402Version, accepts: [...] } or a flat requirements object; v1 maxAmountRequired or v2 amount). Builds and signs an EIP-3009 TransferWithAuthorization with the token\'s real EIP-712 domain. Only "exact" scheme on EVM chains. Returns signature + authorization for the X-PAYMENT / PAYMENT-SIGNATURE header. Policy tokenLimits can make small payments automatic (preset "micropay").',
      parameters: {
        account: accountSelector,
        challenge: { type: 'json', description: 'The x402 challenge (402 response body) — pass it unmodified.', required: true },
        amount: { type: 'string', description: 'Atomic units to authorize (<= the required amount). Default: the required amount.' },
        ttlSeconds: { type: 'number', description: 'Validity window in seconds (default 300, capped by maxTimeoutSeconds and 3600).' },
      },
      execute: guarded(async (args, ctx) =>
        service.authorizeX402(
          {
            account: requireStr(args, 'account'),
            challenge: jsonArg(args, 'challenge'),
            ...(str(args, 'amount') !== undefined ? { amount: str(args, 'amount')! } : {}),
            ...(typeof args.ttlSeconds === 'number' ? { ttlSeconds: args.ttlSeconds } : {}),
          },
          approval,
          ctxOf('wallet_x402_authorize', ctx),
        ),
      ),
      output: OUTPUT,
    },

    // ── policy ──────────────────────────────────────────────────────────
    {
      name: 'wallet_policy_get',
      description:
        'Current signing policy (allow / ask / deny rules, detected preset) and the hard limits: transfer whitelist, per-transaction and daily caps for stablecoins (USD) and native coins, with today\'s usage. Limits refuse even human-approved requests and are changed only by the user in DSH Settings → Web3 → Limits.',
      parameters: {},
      execute: guarded(async () => {
        const policy = service.getPolicy();
        return { preset: detectPreset(policy) ?? 'custom', policy, presets: PRESETS, ...service.limitsView() };
      }),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_policy_set',
      description:
        'Tighten the signing policy with a preset, e.g. agent-full → agent-semi, anything → strict (every operation asks a human) or locked (no signing at all). Fresh vaults start in agent-semi. Requires human approval + PIN authorization. Loosening — a more autonomous preset (agent-semi / agent-full / power / testnet / micropay from a stricter one), custom rules, raising limits or the automatic budget, whitelisting — is never done by the agent: it returns status "use-panel"; tell the user to change it in DSH Settings → Web3 → Limits (PIN-confirmed). Only call when the user explicitly asks.',
      parameters: {
        preset: { type: 'string', enum: PRESETS, description: 'Preset to apply. Only tightening changes are applied here.', required: true },
      },
      execute: guarded(async (args, ctx) => {
        if (args.policy !== undefined) {
          await service.vault.auditAppend('tool.policy_set_redirected', { reason: 'custom-document' });
          return { updated: false, status: 'use-panel', message: panelPolicyMessage };
        }
        const preset = requireStr(args, 'preset') as PolicyPresetId;
        if (!PRESETS.includes(preset)) throw new WalletError('INVALID_ARGUMENT', `unknown preset "${preset}"`, `Use one of: ${PRESETS.join(', ')}`);
        if (!service.canAgentApplyPreset(preset)) {
          await service.vault.auditAppend('tool.policy_set_redirected', { preset });
          return { updated: false, preset, status: 'use-panel', message: panelPolicyMessage };
        }
        const outcome = await approval.request({
          ...ctxOf('wallet_policy_set', ctx),
          reason: `Tighten the wallet signing policy to preset "${preset}"? ${PRESET_EFFECT[preset]}`,
        });
        if (outcome !== 'allowed-once') {
          await service.vault.auditAppend('tool.policy_set_denied', { outcome });
          return { updated: false, approvalOutcome: outcome };
        }
        await service.setPolicy(policyPreset(preset));
        return { updated: true, preset };
      }),
      output: OUTPUT,
    },

    // ── secrets & backup ────────────────────────────────────────────────
    {
      name: 'wallet_reveal_secret',
      description: allowReveal
        ? 'Reveal the mnemonic or private key INTO THE TRANSCRIPT after human approval + PIN authorization. Only on explicit user request.'
        : 'Backup guidance: mnemonics/private keys are never returned to the chat. Returns instructions to reveal them in DSH Settings → Web3 (PIN protected).',
      parameters: {
        account: accountSelector,
        kind: { type: 'string', enum: ['mnemonic', 'privateKey'], description: 'Which secret.', required: true },
      },
      execute: guarded(async (args, ctx) => {
        const meta = service.vault.requireAccount(requireStr(args, 'account'));
        const kind = requireStr(args, 'kind') as 'mnemonic' | 'privateKey';
        if (!allowReveal) {
          await service.vault.auditAppend('tool.reveal_redirected', { accountId: meta.id, kind });
          return { address: meta.address, kind, revealed: false, status: 'use-panel', message: panelBackupMessage };
        }
        const outcome = await approval.request({
          ...ctxOf('wallet_reveal_secret', ctx),
          reason: `Reveal the ${kind} for account ${meta.address} (${meta.label}) INTO THE CHAT TRANSCRIPT? It will be sent to the model provider and stored in session logs.`,
        });
        if (outcome !== 'allowed-once') {
          await service.vault.auditAppend('tool.reveal_denied', { accountId: meta.id, kind, outcome });
          return { address: meta.address, kind, revealed: false };
        }
        const secret = await service.revealSecret(meta.id, kind);
        return { ...secret, revealed: true };
      }),
      output: OUTPUT,
    },
    {
      name: 'wallet_export_keystore',
      description:
        'Export an account as an encrypted Web3 Secret Storage keystore file (0600, under the vault exports folder). Returns only the file path. Requires human approval + PIN authorization. Note: the passphrase you pass is visible in the transcript — suggest the user change it after import elsewhere.',
      parameters: {
        account: accountSelector,
        keystorePassphrase: { type: 'string', description: 'Passphrase (min 8 chars) to encrypt the keystore with.', required: true },
      },
      execute: guarded(async (args, ctx) => {
        const meta = service.vault.requireAccount(requireStr(args, 'account'));
        const outcome = await approval.request({
          ...ctxOf('wallet_export_keystore', ctx),
          reason: `Export an encrypted keystore file for ${meta.label} — ${meta.address}?`,
        });
        if (outcome !== 'allowed-once') return { exported: false, approvalOutcome: outcome };
        return { exported: true, ...(await service.exportKeystoreToFile(meta.id, requireStr(args, 'keystorePassphrase'))) };
      }),
      output: OUTPUT,
    },

    // ── human gates ─────────────────────────────────────────────────────
    {
      name: 'wallet_pin_status',
      description: 'PIN gate status: configured, authorized (and until when), locked out. Sensitive operations need a PIN grant in force; the user sets its length (1, 7 or 30 days) in the panel.',
      parameters: {},
      execute: guarded(async () => ({ pin: await service.pinStatus() })),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_pin_verify',
      description:
        'Check whether a PIN authorization is in force. There is NO pin argument: the user enters the PIN only in DSH Settings → Web3 (it never passes through the model).',
      parameters: {},
      execute: guarded(async () => {
        const status = await service.pinStatus();
        if (status.enabled && !status.locked && !status.authorized) {
          return {
            authorized: false,
            message:
              '尚未通过 PIN 授权或授权已过期。请引导用户前往 DSH 设置 → Web3 面板的“PIN 安全”区域输入 PIN（授权时长可选 1 / 7 / 30 天），完成后再重试该操作。不要要求用户在此输入 PIN。',
            pin: status,
          };
        }
        return { authorized: status.enabled && status.authorized, pin: status };
      }),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
    {
      name: 'wallet_audit_log',
      description: 'Recent security audit entries: signing decisions, approvals, policy changes. Secret-free.',
      parameters: {
        limit: { type: 'number', description: 'Maximum entries to return. Default 30.' },
      },
      execute: guarded(async (args) => ({ entries: await service.recentAudit(typeof args.limit === 'number' ? args.limit : 30) })),
      output: OUTPUT,
      isConcurrencySafe: readOnly,
    },
  ];

  return specs.map((spec): WalletTool => {
    const present = PRESENTERS[spec.name];
    return {
      ...spec,
      parameters: toParametersJsonSchema(spec.parameters),
      ...(present !== undefined ? { presentCall: (args: unknown) => ({ card: 'generic' as const, ...present(asRecord(args)) }) } : {}),
    };
  });
}

// ── tool-card presentation (DSH UI; never model-visible) ─────────────────

type Presenter = (args: Record<string, unknown>) => { title: string; kind?: 'read' | 'edit' | 'delete' | 'execute' | 'other' };

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

/** Shorten only bare 0x addresses; ENS names and labels are shown as typed. */
function party(value: unknown): string {
  const raw = text(value) ?? '?';
  return /^0x[0-9a-fA-F]{40}$/.test(raw) ? `${raw.slice(0, 6)}…${raw.slice(-4)}` : raw;
}

function chainName(value: unknown): string | undefined {
  const id = Number(value);
  if (!Number.isFinite(id)) return undefined;
  const chain = getChain(id);
  return chain === undefined ? `chain ${String(id)}` : chain.shortName;
}

function joinTitle(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ');
}

const read = (title: string): ReturnType<Presenter> => ({ title, kind: 'read' });

const PRESENTERS: Record<string, Presenter> = {
  wallet_status: () => read('Wallet status'),
  wallet_unlock: () => ({ title: 'Unlock wallet', kind: 'other' }),
  wallet_lock: () => ({ title: 'Lock wallet', kind: 'other' }),
  wallet_list: () => read('Accounts'),
  wallet_create: (args) => ({ title: joinTitle(text(args.fromAccount) !== undefined ? 'New address' : 'New wallet', text(args.label)), kind: 'edit' }),
  wallet_import: (args) => ({ title: joinTitle('Import account', text(args.source), text(args.label)), kind: 'edit' }),
  wallet_remove_account: (args) => ({ title: joinTitle('Remove account', party(args.account)), kind: 'delete' }),
  wallet_chains: () => read('Supported chains'),
  wallet_balance: (args) => read(joinTitle(`Balance ${party(args.account)}`, chainName(args.chainId))),
  wallet_address_book: (args) => {
    const action = text(args.action) ?? 'list';
    if (action === 'list') return read('Address book');
    return { title: joinTitle(action === 'add' ? 'Save contact' : 'Remove contact', text(args.label), action === 'add' ? party(args.address) : undefined), kind: action === 'add' ? 'edit' : 'delete' };
  },
  wallet_security_check: (args) => read(joinTitle(`Security check ${party(args.address)}`, chainName(args.chainId))),
  wallet_denylist: (args) => {
    const action = text(args.action) ?? 'list';
    if (action === 'list') return read('Denylist');
    return { title: joinTitle(action === 'add' ? 'Denylist address' : 'Remove from denylist', party(args.address)), kind: action === 'add' ? 'edit' : 'delete' };
  },
  wallet_transfer: (args) => ({
    title: joinTitle(`${args.dryRun === true ? 'Preview ' : ''}${text(args.amount) ?? '?'} ${text(args.token) ?? 'native'} → ${party(args.to)}`, chainName(args.chainId)),
    kind: args.dryRun === true ? 'read' : 'execute',
  }),
  wallet_prepare_transaction: (args) => read(joinTitle(`Preview call → ${party(args.to)}`, chainName(args.chainId))),
  wallet_send_transaction: (args) => ({ title: text(args.preparedId) !== undefined ? 'Send prepared transaction' : joinTitle(`Send → ${party(args.to)}`, chainName(args.chainId)), kind: 'execute' }),
  wallet_approve_token: (args) => ({
    title: joinTitle(`${args.dryRun === true ? 'Preview ' : ''}Approve ${text(args.amount) ?? '?'} ${text(args.token) ?? ''} → ${party(args.spender)}`, chainName(args.chainId)),
    kind: args.dryRun === true ? 'read' : 'execute',
  }),
  wallet_allowance: (args) => read(joinTitle(`Allowance ${text(args.token) ?? ''} → ${party(args.spender)}`, chainName(args.chainId))),
  wallet_tx_status: (args) => read(joinTitle(`Transaction ${party(args.txHash).length > 20 ? `${String(args.txHash).slice(0, 10)}…` : party(args.txHash)}`, chainName(args.chainId))),
  wallet_history: () => read('Transaction history'),
  wallet_replace_transaction: (args) => ({ title: joinTitle(text(args.action) === 'cancel' ? 'Cancel transaction' : 'Speed up transaction', text(args.txHash)?.slice(0, 10)), kind: 'execute' }),
  wallet_sign_message: (args) => ({ title: joinTitle('Sign message', party(args.account)), kind: 'execute' }),
  wallet_sign_typed_data: (args) => ({ title: joinTitle('Sign typed data', party(args.account)), kind: 'execute' }),
  wallet_x402_authorize: (args) => ({ title: joinTitle('x402 payment', party(args.account)), kind: 'execute' }),
  wallet_policy_get: () => read('Policy & limits'),
  wallet_policy_set: (args) => ({ title: joinTitle('Set policy', text(args.preset)), kind: 'edit' }),
  wallet_reveal_secret: (args) => ({ title: joinTitle('Backup guidance', party(args.account)), kind: 'other' }),
  wallet_export_keystore: (args) => ({ title: joinTitle('Export keystore', party(args.account)), kind: 'other' }),
  wallet_pin_status: () => read('PIN status'),
  wallet_pin_verify: () => read('PIN check'),
  wallet_audit_log: () => read('Audit log'),
};
