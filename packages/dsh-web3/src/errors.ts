/**
 * Structured wallet errors for model tools.
 *
 * An agent that receives a raw exception string tends to guess — retry the
 * same call, re-type an address, or invent a fix. Every failure a tool
 * returns instead carries a stable `code` plus a `hint` naming the next
 * concrete step, so the model can recover deterministically.
 *
 * @module dsh-web3/errors
 */

import { AccountNotFoundError, PinLockedError, PinRequiredError, VaultLockedError } from 'dsh-web3-core';

/** Stable error codes surfaced to the model. */
export type WalletErrorCode =
  | 'VAULT_LOCKED'
  | 'ACCOUNT_NOT_FOUND'
  | 'PIN_REQUIRED'
  | 'PIN_LOCKED'
  | 'PIN_SETUP_REQUIRED'
  | 'PIN_INVALID'
  | 'USE_PANEL'
  | 'INVALID_ADDRESS'
  | 'INVALID_RECIPIENT'
  | 'INVALID_AMOUNT'
  | 'INVALID_ARGUMENT'
  | 'UNKNOWN_TOKEN'
  | 'TOKEN_MISMATCH'
  | 'UNKNOWN_CHAIN'
  | 'INSUFFICIENT_FUNDS'
  | 'WOULD_REVERT'
  | 'BLOCKED'
  | 'PREPARED_NOT_FOUND'
  | 'TX_NOT_FOUND'
  | 'NOT_REPLACEABLE'
  | 'NONCE_CONFLICT'
  | 'REPLACEMENT_UNDERPRICED'
  | 'RPC_ERROR'
  | 'INTERNAL';

/** A wallet failure with a machine-readable code and a next-step hint. */
export class WalletError extends Error {
  readonly code: WalletErrorCode;
  readonly hint?: string;
  readonly details?: Record<string, unknown>;

  constructor(code: WalletErrorCode, message: string, hint?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'WalletError';
    this.code = code;
    if (hint !== undefined) this.hint = hint;
    if (details !== undefined) this.details = details;
  }
}

/** The shape every failed tool call returns. */
export interface ToolErrorResult {
  ok: false;
  status: 'error' | 'pin-required' | 'pin-locked';
  code: WalletErrorCode;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
}

const PIN_REQUIRED_MESSAGE =
  '该操作是敏感操作，需要 PIN 授权（授权有效期为用户在面板设置的 1 / 7 / 30 天）。请引导用户前往 DSH 设置 → Web3 面板的“PIN 安全”区域输入 PIN 完成授权，然后重试。PIN 只通过界面输入，绝不通过对话传递，也不要询问用户在此输入 PIN。';
const PIN_LOCKED_MESSAGE = 'PIN 连续输错次数过多，已锁定至今日结束。请明天再试，或在 DSH 设置 → Web3 查看锁定倒计时。';

/** ethers v6 attaches a string `code` to its errors. */
function ethersCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) {
    const short = (error as { shortMessage?: unknown }).shortMessage;
    return typeof short === 'string' && short.length > 0 ? short : error.message;
  }
  return String(error);
}

/**
 * Map any thrown value to a structured tool result. Known wallet, vault,
 * PIN, and ethers failures get specific codes; anything else is `INTERNAL`.
 */
export function toToolError(error: unknown): ToolErrorResult {
  if (error instanceof WalletError) {
    return {
      ok: false,
      status: 'error',
      code: error.code,
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
      ...(error.details !== undefined ? { details: error.details } : {}),
    };
  }
  if (error instanceof PinRequiredError) {
    return { ok: false, status: 'pin-required', code: 'PIN_REQUIRED', message: PIN_REQUIRED_MESSAGE, hint: 'Ask the user to enter the PIN in DSH Settings → Web3 → PIN to authorize, then retry the same call.' };
  }
  if (error instanceof PinLockedError) {
    return { ok: false, status: 'pin-locked', code: 'PIN_LOCKED', message: PIN_LOCKED_MESSAGE, hint: 'Do not retry today.' };
  }
  if (error instanceof VaultLockedError) {
    return { ok: false, status: 'error', code: 'VAULT_LOCKED', message: error.message, hint: 'Follow the message: if the user locked the wallet, ask them before unlocking; otherwise call wallet_unlock, then retry the same call.' };
  }
  if (error instanceof AccountNotFoundError) {
    return {
      ok: false,
      status: 'error',
      code: 'ACCOUNT_NOT_FOUND',
      message: error.message,
      hint: 'Call wallet_list and pass an account id, address, or exact label.',
    };
  }
  const code = ethersCode(error);
  const message = messageOf(error);
  switch (code) {
    case 'INSUFFICIENT_FUNDS':
      return { ok: false, status: 'error', code: 'INSUFFICIENT_FUNDS', message, hint: 'Check wallet_balance; the account cannot cover amount + network fee.' };
    case 'NONCE_EXPIRED':
      return { ok: false, status: 'error', code: 'NONCE_CONFLICT', message, hint: 'A transaction with this nonce was already mined; check wallet_history before retrying.' };
    case 'REPLACEMENT_UNDERPRICED':
      return { ok: false, status: 'error', code: 'REPLACEMENT_UNDERPRICED', message, hint: 'Use wallet_replace_transaction (speed-up) for the pending transaction instead of sending a new one.' };
    case 'CALL_EXCEPTION':
      return { ok: false, status: 'error', code: 'WOULD_REVERT', message, hint: 'The contract call reverts; check parameters, balances, and allowances.' };
    case 'INVALID_ARGUMENT':
    case 'BAD_DATA':
      return {
        ok: false,
        status: 'error',
        code: /address/i.test(message) ? 'INVALID_ADDRESS' : 'INVALID_ARGUMENT',
        message,
        hint: /address/i.test(message)
          ? 'Use the exact 0x address (a mixed-case address with a bad checksum is rejected as a likely typo).'
          : 'Fix the argument and retry.',
      };
    case 'NETWORK_ERROR':
    case 'TIMEOUT':
    case 'SERVER_ERROR':
      return { ok: false, status: 'error', code: 'RPC_ERROR', message, hint: 'The RPC node failed; retry once, or configure a custom RPC in the plugin config.' };
    default:
      break;
  }
  if (/unknown chain/i.test(message)) {
    return { ok: false, status: 'error', code: 'UNKNOWN_CHAIN', message, hint: 'Call wallet_chains for supported chain ids, or add an rpc override in the plugin config.' };
  }
  return { ok: false, status: 'error', code: 'INTERNAL', message };
}

/** Whether a broadcast failure is a definitive node rejection (tx never entered the mempool). */
export function isDefinitiveRejection(error: unknown): boolean {
  const code = ethersCode(error);
  if (code !== undefined && ['INSUFFICIENT_FUNDS', 'NONCE_EXPIRED', 'REPLACEMENT_UNDERPRICED', 'INVALID_ARGUMENT'].includes(code)) return true;
  // JSON-RPC error bodies ({ error: { code, message } }) are node verdicts; transport failures are not.
  const inner = (error as { error?: { code?: unknown } } | null)?.error;
  return inner !== undefined && typeof inner?.code === 'number';
}
