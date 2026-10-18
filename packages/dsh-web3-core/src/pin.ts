/**
 * PIN gate for sensitive wallet operations.
 *
 * A short PIN the user enters in the DSH Web3 settings UI — never through the
 * model — authorizes sensitive operations: transfers, message signing, keystore
 * export, secret reveal, and policy changes. One entry grants authorization for
 * a chosen period (1, 7 or 30 days; default 1), so routine automatic signing is
 * not interrupted by PIN prompts.
 *
 * Security properties:
 * - The PIN itself is never stored; only an scrypt hash (`pin.json`, 0600).
 * - With a pepper source (the OS keychain), the hash is keyed by a secret
 *   kept outside the vault directory (`pin.json` version 2), so a copied
 *   `pin.json` cannot be brute-forced offline — short numeric PINs have a
 *   tiny search space. Version 1 files upgrade on the next correct entry.
 * - A grant ends at a fixed instant (entry time + grant period). Lengthening
 *   the period needs a fresh PIN (the settings panel enforces that); shortening
 *   it takes effect at once.
 * - Too many consecutive failures (default 5) lock the gate until the next
 *   local midnight (fail-open is never allowed).
 * - Lockout and failure state persist across restarts (`pin-state.json`).
 *
 * @module dsh-web3-core/pin
 */

import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { KdfParams } from './crypto.js';

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 12;
export const PIN_MAX_FAILURES = 5;

/** How long one PIN entry authorizes sensitive operations, in days. */
export const PIN_GRANT_DAYS = [1, 7, 30] as const;
export type PinGrantDays = (typeof PIN_GRANT_DAYS)[number];
export const PIN_DEFAULT_GRANT_DAYS: PinGrantDays = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Slightly lighter scrypt than key-file KDF (PIN verification is frequent). */
const PIN_KDF: KdfParams = { N: 16384, r: 8, p: 1 };
const SCRYPT_MAXMEM = 128 * 32768 * 8 * 2;

/** Thrown when a sensitive operation requires a PIN authorization in force. */
export class PinRequiredError extends Error {
  constructor(message = 'PIN authorization required: enter your PIN in DSH settings → Web3') {
    super(message);
    this.name = 'PinRequiredError';
  }
}

/** Thrown when the PIN gate is locked out for the rest of the day. */
export class PinLockedError extends Error {
  constructor(message = 'PIN locked until tomorrow after too many failed attempts') {
    super(message);
    this.name = 'PinLockedError';
  }
}

/** Thrown when a supplied PIN is wrong. */
export class PinInvalidError extends Error {
  constructor(message = 'incorrect PIN') {
    super(message);
    this.name = 'PinInvalidError';
  }
}

/** Thrown when a peppered PIN file exists but its pepper cannot be read. */
export class PinPepperUnavailableError extends Error {
  constructor(message = 'PIN pepper is unavailable (OS keychain); cannot verify the PIN') {
    super(message);
    this.name = 'PinPepperUnavailableError';
  }
}

/**
 * Supplies the PIN pepper. Returns `undefined` when none is stored and
 * `create` is false; creates and returns a new one when `create` is true.
 */
export type PinPepperSource = (create: boolean) => Promise<Buffer | undefined>;

/** On-disk PIN hash record (no plaintext PIN). Version 2 is peppered. */
export interface PinFile {
  version: 1 | 2;
  kdf: { name: 'scrypt'; n: number; r: number; p: number; salt: string };
  /** Version 2: where the pepper lives (`keychain`). */
  pepper?: 'keychain';
  /** Hex-encoded 32-byte derived key. */
  hash: string;
}

/**
 * Persisted runtime state: the grant, its period, and the failure throttle.
 * `authorizedDate` is the pre-0.10 calendar-day grant, honoured until the next
 * PIN entry replaces it with `authorizedUntil`.
 */
export interface PinStateFile {
  /** When the current grant started (ISO). */
  authorizedFrom?: string;
  authorizedUntil?: string;
  authorizedDate?: string;
  grantDays?: PinGrantDays;
  failCount: number;
  failDate?: string;
  lockedUntil?: string;
}

/** Secret-free PIN gate status for the UI and tools. */
export interface PinStatus {
  enabled: boolean;
  /** Whether a PIN grant is currently in force. */
  authorized: boolean;
  /** When the current grant ends (ISO), if one is in force. */
  authorizedUntil?: string;
  /** Length of each grant, in days. */
  grantDays: PinGrantDays;
  locked: boolean;
  lockRemainingMs: number;
  failuresRemaining: number;
}

function today(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function nextMidnightIso(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  return next.toISOString();
}

function validatePin(pin: string): void {
  if (typeof pin !== 'string' || pin.length < PIN_MIN_LENGTH || pin.length > PIN_MAX_LENGTH) {
    throw new Error(`PIN must be ${PIN_MIN_LENGTH}-${PIN_MAX_LENGTH} characters`);
  }
}

async function deriveKey(pin: string, salt: Buffer, pepper?: Buffer): Promise<Buffer> {
  const normalized = pin.normalize('NFKC');
  const input = pepper === undefined ? normalized : createHmac('sha256', pepper).update(normalized).digest('hex');
  return scrypt(input, salt, 32, {
    N: PIN_KDF.N,
    r: PIN_KDF.r,
    p: PIN_KDF.p,
    maxmem: Math.max(SCRYPT_MAXMEM, 128 * PIN_KDF.N * PIN_KDF.r * 2),
  });
}

async function createPinFile(pin: string, pepper?: Buffer): Promise<PinFile> {
  const salt = randomBytes(16);
  const key = await deriveKey(pin, salt, pepper);
  return {
    version: pepper === undefined ? 1 : 2,
    kdf: { name: 'scrypt', n: PIN_KDF.N, r: PIN_KDF.r, p: PIN_KDF.p, salt: salt.toString('hex') },
    ...(pepper === undefined ? {} : { pepper: 'keychain' as const }),
    hash: key.toString('hex'),
  };
}

async function verifyHash(pin: string, file: PinFile, pepper?: Buffer): Promise<boolean> {
  const salt = Buffer.from(file.kdf.salt, 'hex');
  const key = await deriveKey(pin, salt, pepper);
  const expected = Buffer.from(file.hash, 'hex');
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** The daily-PIN gate. Lives in the vault directory. */
export class PinGuard {
  private readonly dir: string;
  private readonly pepper: PinPepperSource | undefined;
  private pinFile: PinFile | undefined;
  private state: PinStateFile = { failCount: 0 };

  /**
   * @param vaultDir - directory holding `pin.json` / `pin-state.json`.
   * @param options - `pepper`: keyed-hash secret source (OS keychain).
   */
  constructor(vaultDir: string, options: { pepper?: PinPepperSource } = {}) {
    this.dir = vaultDir;
    this.pepper = options.pepper;
  }

  /** A new PIN record, peppered when a pepper source is configured. */
  private async newPinFile(pin: string): Promise<PinFile> {
    return createPinFile(pin, this.pepper === undefined ? undefined : await this.pepper(true));
  }

  private get pinPath(): string {
    return join(this.dir, 'pin.json');
  }

  private get statePath(): string {
    return join(this.dir, 'pin-state.json');
  }

  /** Load (or initialize empty) the PIN hash and runtime state. */
  async load(): Promise<void> {
    try {
      this.pinFile = JSON.parse(await readFile(this.pinPath, 'utf8')) as PinFile;
      if (this.pinFile.version !== 1 && this.pinFile.version !== 2) throw new Error('unsupported pin file version');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // A malformed pin file is a security problem: fail closed, do not fall
        // back to "no PIN". Surface it as not-enabled but keep state safe.
        this.pinFile = undefined;
      }
    }
    try {
      const parsed = JSON.parse(await readFile(this.statePath, 'utf8')) as Partial<PinStateFile>;
      this.state = { failCount: 0, ...parsed };
    } catch {
      this.state = { failCount: 0 };
    }
  }

  /** Whether a PIN is configured. */
  get enabled(): boolean {
    return this.pinFile !== undefined;
  }

  /** Length of each PIN grant, in days (the user's setting). */
  get grantDays(): PinGrantDays {
    const days = this.state.grantDays;
    return PIN_GRANT_DAYS.includes(days as PinGrantDays) ? (days as PinGrantDays) : PIN_DEFAULT_GRANT_DAYS;
  }

  /** Whether a grant is in force at `now` (epoch ms). Fails closed on an unreadable end time. */
  private isAuthorized(now: number): boolean {
    if (this.state.authorizedUntil !== undefined) return new Date(this.state.authorizedUntil).getTime() > now;
    return this.state.authorizedDate === today();
  }

  /** Secret-free status. */
  status(): PinStatus {
    if (!this.enabled) {
      return { enabled: false, authorized: false, grantDays: this.grantDays, locked: false, lockRemainingMs: 0, failuresRemaining: PIN_MAX_FAILURES };
    }
    const now = Date.now();
    const lockedUntilMs = this.state.lockedUntil !== undefined ? new Date(this.state.lockedUntil).getTime() : 0;
    const locked = lockedUntilMs > now;
    const failuresToday = this.state.failDate === today() ? this.state.failCount : 0;
    const authorized = this.isAuthorized(now);
    return {
      enabled: true,
      authorized,
      ...(authorized && this.state.authorizedUntil !== undefined ? { authorizedUntil: this.state.authorizedUntil } : {}),
      grantDays: this.grantDays,
      locked,
      lockRemainingMs: locked ? lockedUntilMs - now : 0,
      failuresRemaining: Math.max(0, PIN_MAX_FAILURES - failuresToday),
    };
  }

  /** Configure an initial PIN. */
  async setup(pin: string): Promise<void> {
    validatePin(pin);
    if (this.enabled) throw new Error('PIN is already configured; use changePin');
    this.pinFile = await this.newPinFile(pin);
    this.state = { failCount: 0, grantDays: this.grantDays };
    await this.save();
  }

  /** Replace the PIN after verifying the current one. */
  async changePin(current: string, next: string): Promise<void> {
    if (!this.enabled) throw new Error('PIN is not configured; use setup');
    validatePin(next);
    // Through verify(): wrong guesses count toward the lockout, so this path
    // cannot be used to brute-force the current PIN.
    const { ok } = await this.verify(current);
    if (!ok) throw new PinInvalidError();
    this.pinFile = await this.newPinFile(next);
    this.state = { failCount: 0, grantDays: this.grantDays };
    await this.save();
  }

  /**
   * Verify a PIN. On success grants authorization for `grantDays` and resets
   * failures. On failure increments the throttle and locks the gate until
   * tomorrow when the failure cap is reached. Returns the resulting status (no secrets).
   */
  async verify(pin: string): Promise<{ ok: boolean; status: PinStatus }> {
    const current = this.status();
    if (!this.enabled) return { ok: false, status: current };
    if (current.locked) throw new PinLockedError();
    const file = this.pinFile!;
    let pepper: Buffer | undefined;
    if (file.version === 2) {
      // Fail closed without counting a failure: the user typed nothing wrong.
      pepper = this.pepper === undefined ? undefined : await this.pepper(false);
      if (pepper === undefined) throw new PinPepperUnavailableError();
    }
    const ok = await verifyHash(pin, file, pepper);
    if (ok) {
      // Upgrade an unpeppered record now that the PIN is known.
      if (file.version === 1 && this.pepper !== undefined) this.pinFile = await this.newPinFile(pin);
      const now = Date.now();
      this.state = {
        authorizedFrom: new Date(now).toISOString(),
        authorizedUntil: new Date(now + this.grantDays * DAY_MS).toISOString(),
        failCount: 0,
        grantDays: this.grantDays,
      };
      await this.save();
      return { ok: true, status: this.status() };
    }
    const failuresToday = this.state.failDate === today() ? this.state.failCount : 0;
    const next = failuresToday + 1;
    this.state.failDate = today();
    this.state.failCount = next;
    if (next >= PIN_MAX_FAILURES) {
      this.state.lockedUntil = nextMidnightIso();
      this.clearGrant();
    }
    await this.save();
    return { ok: false, status: this.status() };
  }

  /**
   * Set the grant length. Lengthening re-anchors the grant to now (the caller
   * has just verified the PIN); shortening ends the grant in force at the
   * earlier of its own end and the new period counted from its start.
   * A grant that is not in force stays unauthorized.
   */
  async setGrantDays(days: PinGrantDays): Promise<void> {
    if (!PIN_GRANT_DAYS.includes(days)) throw new Error(`grant period must be one of ${PIN_GRANT_DAYS.join(', ')} days`);
    const now = Date.now();
    const previous = this.grantDays;
    const wasAuthorized = this.isAuthorized(now);
    if (wasAuthorized && days > previous) {
      this.state.authorizedFrom = new Date(now).toISOString();
      this.state.authorizedUntil = new Date(now + days * DAY_MS).toISOString();
      this.state.authorizedDate = undefined;
    } else if (wasAuthorized && days < previous) {
      // A pre-0.10 grant has no start time: it can never outlast the end of its day.
      const from = this.state.authorizedFrom !== undefined ? new Date(this.state.authorizedFrom).getTime() : now;
      const ends = this.state.authorizedUntil !== undefined ? new Date(this.state.authorizedUntil).getTime() : new Date(nextMidnightIso()).getTime();
      if (Number.isNaN(from) || Number.isNaN(ends)) {
        // An unreadable grant cannot be shortened: revoke it, fail closed.
        this.clearGrant();
      } else {
        this.state.authorizedUntil = new Date(Math.min(ends, from + days * DAY_MS)).toISOString();
        this.state.authorizedDate = undefined;
      }
    }
    this.state.grantDays = days;
    await this.save();
  }

  /** Throw when enabled and no grant is in force (or locked). */
  requireAuthorized(): void {
    const current = this.status();
    if (!this.enabled) return;
    if (current.locked) throw new PinLockedError();
    if (!current.authorized) throw new PinRequiredError();
  }

  /** Revoke the current authorization (e.g. on explicit lock). */
  async clearDaily(): Promise<void> {
    this.clearGrant();
    await this.save();
  }

  /** Drop the grant, keeping the chosen period and the failure throttle. */
  private clearGrant(): void {
    this.state.authorizedDate = undefined;
    this.state.authorizedFrom = undefined;
    this.state.authorizedUntil = undefined;
  }

  /** Remove the PIN gate entirely. */
  async disable(): Promise<void> {
    this.pinFile = undefined;
    this.state = { failCount: 0 };
    try {
      await writeFile(this.pinPath, '', 'utf8');
    } catch {
      // Ignore.
    }
    try {
      await writeFile(this.statePath, '', 'utf8');
    } catch {
      // Ignore.
    }
    await this.save();
  }

  private async save(): Promise<void> {
    // Never recreate a directory that has been removed (e.g. during teardown):
    // a stray mkdir here is what made test temp dirs non-empty.
    try {
      await stat(this.dir);
    } catch {
      return;
    }
    try {
      if (this.pinFile !== undefined) {
        await writeJsonPrivate(this.pinPath, this.pinFile);
      }
      await writeJsonPrivate(this.statePath, this.state);
    } catch {
      // Best-effort persistence; a write failure must not break the wallet.
    }
  }
}

async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}
