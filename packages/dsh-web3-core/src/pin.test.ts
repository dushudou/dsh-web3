import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PinGuard,
  PinInvalidError,
  PinLockedError,
  PinPepperUnavailableError,
  PinRequiredError,
  PIN_MAX_FAILURES,
  PIN_MIN_LENGTH,
} from '../src/index.js';

const DAY_MS = 24 * 60 * 60 * 1000;

let dirs: string[] = [];

async function newGuard(): Promise<PinGuard> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web3-pin-'));
  dirs.push(dir);
  const guard = new PinGuard(dir);
  await guard.load();
  return guard;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  dirs = [];
});

/** Freeze only Date, so scrypt and file I/O keep running on real timers. */
function freezeClock(at: string): void {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(at));
}

describe('PinGuard', () => {
  it('starts disabled with no configured pin', async () => {
    const guard = await newGuard();
    const status = guard.status();
    expect(status.enabled).toBe(false);
    expect(status.authorized).toBe(false);
    expect(status.locked).toBe(false);
    // No gate when disabled.
    expect(() => guard.requireAuthorized()).not.toThrow();
  });

  it('setup then verify grants today authorization', async () => {
    const guard = await newGuard();
    await guard.setup('123456');
    expect(guard.enabled).toBe(true);
    expect(guard.status().authorized).toBe(false);
    const result = await guard.verify('123456');
    expect(result.ok).toBe(true);
    expect(guard.status().authorized).toBe(true);
    // Gate passes after daily auth.
    expect(() => guard.requireAuthorized()).not.toThrow();
  });

  it('wrong pin increments failures and does not authorize', async () => {
    const guard = await newGuard();
    await guard.setup('123456');
    const result = await guard.verify('000000');
    expect(result.ok).toBe(false);
    expect(guard.status().authorized).toBe(false);
    expect(guard.status().failuresRemaining).toBe(PIN_MAX_FAILURES - 1);
    expect(() => guard.requireAuthorized()).toThrow(PinRequiredError);
  });

  it('rejects a pin that is too short', async () => {
    const guard = await newGuard();
    await expect(guard.setup('12')).rejects.toThrow();
  });

  it('locks until tomorrow after PIN_MAX_FAILURES failures', async () => {
    const guard = await newGuard();
    await guard.setup('123456');
    for (let i = 0; i < PIN_MAX_FAILURES - 1; i++) {
      const result = await guard.verify('000000');
      expect(result.ok).toBe(false);
      expect(result.status.locked).toBe(false);
    }
    const last = await guard.verify('000000');
    expect(last.ok).toBe(false);
    expect(last.status.locked).toBe(true);
    expect(last.status.lockRemainingMs).toBeGreaterThan(0);
    // A correct PIN is rejected while locked.
    await expect(guard.verify('123456')).rejects.toThrow(PinLockedError);
    expect(() => guard.requireAuthorized()).toThrow(PinLockedError);
  });

  it('requires a fresh grant once the current one is cleared', async () => {
    const guard = await newGuard();
    await guard.setup('123456');
    await guard.verify('123456');
    expect(guard.status().authorized).toBe(true);
    // Simulate day rollover by clearing the grant.
    await guard.clearDaily();
    expect(guard.status().authorized).toBe(false);
    expect(() => guard.requireAuthorized()).toThrow(PinRequiredError);
  });

  it('changePin verifies the current pin first', async () => {
    const guard = await newGuard();
    await guard.setup('123456');
    await expect(guard.changePin('wrong', 'abcdef')).rejects.toThrow(PinInvalidError);
    await guard.changePin('123456', 'abcdef');
    expect(await guard.verify('abcdef')).toMatchObject({ ok: true });
    expect((await guard.verify('123456')).ok).toBe(false);
  });

  it('persists pin and state across instances (no plaintext pin on disk)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-web3-pin-'));
    dirs.push(dir);
    const first = new PinGuard(dir);
    await first.load();
    await first.setup('123456');
    await first.verify('123456');

    const raw = await readFile(join(dir, 'pin.json'), 'utf8');
    expect(raw).not.toContain('123456');
    const parsed = JSON.parse(raw) as { hash: string };
    expect(parsed.hash).toMatch(/^[0-9a-f]{64}$/);

    const second = new PinGuard(dir);
    await second.load();
    expect(second.enabled).toBe(true);
    expect(second.status().authorized).toBe(true);
    const result = await second.verify('123456');
    expect(result.ok).toBe(true);
  });
});

/** An in-memory pepper store standing in for the OS keychain. */
function pepperStore(): { source: (create: boolean) => Promise<Buffer | undefined>; value: () => Buffer | undefined; drop: () => void } {
  let pepper: Buffer | undefined;
  return {
    source: async (create) => {
      if (pepper === undefined && create) pepper = randomBytes(32);
      return pepper;
    },
    value: () => pepper,
    drop: () => {
      pepper = undefined;
    },
  };
}

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web3-pin-'));
  dirs.push(dir);
  return dir;
}

describe('PinGuard with a keychain pepper', () => {
  it('writes a version 2 record keyed by the pepper', async () => {
    const dir = await tempDir();
    const store = pepperStore();
    const guard = new PinGuard(dir, { pepper: store.source });
    await guard.load();
    await guard.setup('1234');
    const file = JSON.parse(await readFile(join(dir, 'pin.json'), 'utf8')) as { version: number; pepper?: string };
    expect(file).toMatchObject({ version: 2, pepper: 'keychain' });
    expect(store.value()).toBeDefined();
    expect((await guard.verify('1234')).ok).toBe(true);
    expect((await guard.verify('4321')).ok).toBe(false);
  });

  it('cannot be verified with the pin.json alone (different pepper)', async () => {
    const dir = await tempDir();
    const first = new PinGuard(dir, { pepper: pepperStore().source });
    await first.load();
    await first.setup('1234');
    const attacker = new PinGuard(dir, { pepper: pepperStore().source });
    await attacker.load();
    // A fresh pepper source has nothing stored, so it fails closed.
    await expect(attacker.verify('1234')).rejects.toBeInstanceOf(PinPepperUnavailableError);
  });

  it('fails closed without counting a failure when the pepper is gone', async () => {
    const dir = await tempDir();
    const store = pepperStore();
    const guard = new PinGuard(dir, { pepper: store.source });
    await guard.load();
    await guard.setup('1234');
    store.drop();
    await expect(guard.verify('1234')).rejects.toBeInstanceOf(PinPepperUnavailableError);
    expect(guard.status().failuresRemaining).toBe(PIN_MAX_FAILURES);
    const unpeppered = new PinGuard(dir);
    await unpeppered.load();
    await expect(unpeppered.verify('1234')).rejects.toBeInstanceOf(PinPepperUnavailableError);
  });

  it('upgrades a version 1 record on the next correct entry', async () => {
    const dir = await tempDir();
    const legacy = new PinGuard(dir);
    await legacy.load();
    await legacy.setup('1234');
    expect(JSON.parse(await readFile(join(dir, 'pin.json'), 'utf8')).version).toBe(1);

    const store = pepperStore();
    const guard = new PinGuard(dir, { pepper: store.source });
    await guard.load();
    expect((await guard.verify('9999')).ok).toBe(false);
    expect(JSON.parse(await readFile(join(dir, 'pin.json'), 'utf8')).version).toBe(1);
    expect((await guard.verify('1234')).ok).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'pin.json'), 'utf8')).version).toBe(2);
    expect((await guard.verify('1234')).ok).toBe(true);
  });
});

describe('PinGuard grant period', () => {
  it('defaults to a one-day grant that ends at a fixed instant', async () => {
    freezeClock('2026-10-18T08:00:00Z');
    const guard = await newGuard();
    await guard.setup('123456');
    expect(guard.status().grantDays).toBe(1);
    await guard.verify('123456');
    expect(guard.status().authorizedUntil).toBe(new Date(Date.parse('2026-10-18T08:00:00Z') + DAY_MS).toISOString());
    vi.setSystemTime(new Date(Date.parse('2026-10-19T07:59:59Z')));
    expect(guard.status().authorized).toBe(true);
    vi.setSystemTime(new Date(Date.parse('2026-10-19T08:00:01Z')));
    expect(guard.status().authorized).toBe(false);
    expect(() => guard.requireAuthorized()).toThrow(PinRequiredError);
  });

  it('a seven-day grant lasts a week, a thirty-day grant a month', async () => {
    freezeClock('2026-10-18T08:00:00Z');
    const guard = await newGuard();
    await guard.setup('123456');
    await guard.setGrantDays(7);
    await guard.verify('123456');
    vi.setSystemTime(new Date(Date.parse('2026-10-24T08:00:00Z')));
    expect(guard.status().authorized).toBe(true);
    vi.setSystemTime(new Date(Date.parse('2026-10-25T08:00:01Z')));
    expect(guard.status().authorized).toBe(false);

    await guard.verify('123456');
    await guard.setGrantDays(30);
    vi.setSystemTime(new Date(Date.parse('2026-11-16T08:00:00Z')));
    expect(guard.status()).toMatchObject({ authorized: true, grantDays: 30 });
  });

  it('lengthening a live grant re-anchors it to now', async () => {
    freezeClock('2026-10-18T08:00:00Z');
    const guard = await newGuard();
    await guard.setup('123456');
    await guard.verify('123456');
    await guard.setGrantDays(30);
    expect(guard.status().authorizedUntil).toBe(new Date(Date.parse('2026-10-18T08:00:00Z') + 30 * DAY_MS).toISOString());
  });

  it('shortening a live grant caps it at the new period', async () => {
    freezeClock('2026-10-18T08:00:00Z');
    const guard = await newGuard();
    await guard.setup('123456');
    await guard.setGrantDays(30);
    await guard.verify('123456');
    vi.setSystemTime(new Date(Date.parse('2026-10-20T08:00:00Z')));
    await guard.setGrantDays(1);
    // Two days into a thirty-day grant, a one-day period ends at once.
    expect(guard.status().authorized).toBe(false);
    expect(guard.status().grantDays).toBe(1);
  });

  it('revokes an unreadable grant instead of half-shortening it', async () => {
    freezeClock('2026-10-18T08:00:00Z');
    const dir = await tempDir();
    const guard = new PinGuard(dir);
    await guard.load();
    await guard.setup('123456');
    await guard.setGrantDays(30);
    await guard.verify('123456');
    const state = JSON.parse(await readFile(join(dir, 'pin-state.json'), 'utf8')) as Record<string, unknown>;
    await writeFile(join(dir, 'pin-state.json'), JSON.stringify({ ...state, authorizedFrom: 'bad' }), 'utf8');
    const reloaded = new PinGuard(dir);
    await reloaded.load();
    await reloaded.setGrantDays(1);
    expect(reloaded.status()).toMatchObject({ authorized: false, grantDays: 1 });
  });

  it('keeps the chosen period across a PIN change and a clear', async () => {
    const guard = await newGuard();
    await guard.setup('123456');
    await guard.setGrantDays(7);
    await guard.changePin('123456', 'abcdef');
    expect(guard.status()).toMatchObject({ grantDays: 7, authorized: false });
    await guard.verify('abcdef');
    await guard.clearDaily();
    expect(guard.status().grantDays).toBe(7);
  });

  it('rejects periods other than 1, 7 and 30 days', async () => {
    const guard = await newGuard();
    await guard.setup('123456');
    await expect(guard.setGrantDays(14 as 1)).rejects.toThrow(/1, 7, 30/);
  });

  it('honours a pre-0.10 calendar-day grant until the next PIN entry', async () => {
    freezeClock('2026-10-18T08:00:00Z');
    const dir = await tempDir();
    const first = new PinGuard(dir);
    await first.load();
    await first.setup('123456');
    await writeFile(join(dir, 'pin-state.json'), JSON.stringify({ authorizedDate: '2026-10-18', failCount: 0 }), 'utf8');
    const guard = new PinGuard(dir);
    await guard.load();
    expect(guard.status()).toMatchObject({ authorized: true, grantDays: 1 });
    expect(guard.status().authorizedUntil).toBeUndefined();
    vi.setSystemTime(new Date(Date.parse('2026-10-19T08:00:00Z')));
    expect(guard.status().authorized).toBe(false);
  });
});
