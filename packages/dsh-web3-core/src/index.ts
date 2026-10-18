/**
 * dsh-web3-core - agent-safe EVM wallet core.
 *
 * Everything key-related is local and encrypted at rest; every signing
 * operation is authorized by a declarative policy before a key is touched.
 *
 * @module dsh-web3-core
 */

export * from './types.js';
export * from './crypto.js';
export * from './account.js';
export * from './chains.js';
export * from './redact.js';
export * from './audit.js';
export * from './tokens.js';
export * from './intent.js';
export { TxJournal } from './journal.js';
export type { JournalEntry, JournalStatus } from './journal.js';
export { AddressBook } from './addressbook.js';
export * from './security.js';
export * from './simulate.js';
export { Denylist, DENYLIST_FEEDS, parseFeed } from './denylist.js';
export type { DenylistEntry, DenylistHit, DenylistCategory, DenylistFeedSpec, FeedState, FeedFetcher } from './denylist.js';
export {
  defaultLimits,
  validateLimits,
  normalizeLimits,
  checkLimits,
  limitUsage,
  isTighteningLimits,
  hasLimits,
} from './limits.js';
export type { WalletLimits, AssetCap, LimitRequest, LimitContext, LimitVerdict, SpendWindowEvent } from './limits.js';
export type { AddressBookEntry } from './addressbook.js';
export { WalletVault, VaultLockedError, AccountNotFoundError } from './vault.js';
export type { AccountSecret, UnlockedAccount, VaultConfig } from './vault.js';
export * from './signer.js';
export * from './provider.js';
export * from './policy/types.js';
export {
  evaluatePolicy,
  validatePolicy,
  summarizeRequest,
  selectorOfData,
  orderedRules,
  normalizeChainId,
  intentOf,
} from './policy/evaluate.js';
export { policyPreset, detectPreset } from './policy/presets.js';
export type { PolicyPresetId } from './policy/presets.js';
export { SpendTracker } from './policy/spend.js';
export {
  PinGuard,
  PinRequiredError,
  PinLockedError,
  PinInvalidError,
  PinPepperUnavailableError,
  PIN_MAX_FAILURES,
  PIN_MIN_LENGTH,
  PIN_MAX_LENGTH,
  PIN_GRANT_DAYS,
  PIN_DEFAULT_GRANT_DAYS,
} from './pin.js';
export type { PinFile, PinGrantDays, PinPepperSource, PinStateFile, PinStatus } from './pin.js';
