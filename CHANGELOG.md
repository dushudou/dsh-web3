# Changelog

All notable changes to `dsh-web3` (the DSH bundle) and `dsh-web3-core` (the library). Dates are npm publish dates. The project follows [Semantic Versioning](https://semver.org/); while in `0.x`, a minor version may contain breaking changes, which are listed under **Breaking**.

## dsh-web3 0.10.0 / dsh-web3-core 0.6.0 — 2026-10-18

### Added

- Settings → Web3 → Security: choose how long one PIN entry authorizes sensitive operations — 1, 7 or 30 days (default 1, the previous behaviour). Shortening takes effect at once; lengthening asks for the PIN. Stored as `grantDays` in `pin-state.json`.

### Changed

- The PIN grant is a fixed period from the moment the PIN is entered instead of "until midnight". Grants recorded by earlier versions still last until the end of their day. `PinStatus.authorizedToday` is now `PinStatus.authorized`, with `authorizedUntil` and `grantDays` alongside (dsh-web3-core).

## dsh-web3 0.9.2 — 2026-10-17

### Fixed

- Signing failed with a bare `wallet vault is locked` after the vault auto-locked (15 minutes idle) or the host restarted, including for other plugins that sign through the wallet service (dsh-hyperliquid orders, leverage and transfers). Signing now re-opens such a vault from the stored passphrase, audited as `vault.unlocked` with `trigger: "signing"`; policy, limits, PIN and approvals still apply. A lock the user chose (panel or `wallet_lock`) is kept until an explicit unlock, also across a restart (`user-lock.json` in the vault directory) and when an account is created or imported; a lock during an automatic unlock wins. The error now says the user locked it and where to unlock, and a vault that cannot be re-opened says why. The vault status reports `lockedByUser`, and the panel's lock banner shows only for a user lock.

## dsh-web3 0.9.1 — 2026-10-17

### Changed

- **Signing audit trail.** Every audit entry of one signing request (`sign.decision`, `sign.approval`, `sign.needs-human`, and the new `sign.transaction`, plus `sign.message` / `sign.typedData`) carries the same `requestId`, the tool that started it (`via`, `callId`) and the policy preset in force (`preset`). Entries also record what was signed: the EIP-191 `messageHash`, the EIP-712 `digest` / `primaryType` / `chainId`, and for transactions the `nonce`, calldata `dataHash` and `txHash` (which links to `sign.broadcast`). The panel's audit log shows the `requestId`.
- The bundled skill covers the semi-managed and fully managed modes, the automatic budget and the `needs-human` status, and explains the audit trail.
- `wallet_policy_set` describes the agent presets and the tightening prompt states what the chosen preset does.

### Fixed

- A preview of an operation above the automatic budget (semi-managed) said an approval prompt would appear, but executing returns `needs-human` without prompting. The preview now sets `willRequire.aboveAutoBudget` and says so.
- The `needs-human` hint told the user they could approve the held operation in the settings panel, which has no such control. It now points to raising the automatic budget or switching the security mode, and tells the agent not to split the amount.
- The panel's copy for the semi-managed mode and the automatic budget said held operations "wait for your confirmation"; they are not signed and run once the user raises the budget or switches modes. It also said a blank budget item meant no automatic allowance, while a blank item has no automatic budget (only the hard ceiling applies); the copy now says so and that 0 never signs that item automatically. The READMEs now recommend `agent-semi` and describe the automatic budget and the audit trail.
- The settings panel did not offer the `agent-semi` / `agent-full` presets or a way to edit the automatic budget (`limits.auto`), so neither mode could be chosen from Settings → Web3 → Limits. Both presets are now listed first (semi-managed recommended) and the Limits tab has an "Automatic budget" section; raising it needs the PIN.

## dsh-web3 0.9.0 / dsh-web3-core 0.5.0 — 2026-10-16

### Breaking

- The `agent` policy preset is replaced by `agent-semi` and `agent-full`. Fresh vaults start in `agent-semi`; existing `policy.json` files are unchanged.
- `limits.json` gains an `auto` band. Files without it are upgraded with the default automatic budget (a tenth of the hard ceiling).

### Changed

- **Agent autonomy presets.** `agent-semi` and `agent-full`: transactions, token moves, typed data and messages are signed without a prompt, bounded by the security checks (critical → refused, high → asked), the daily PIN and two limit bands. The hard ceiling (`limits.json`, the existing caps) refuses above it in both modes; only the user can raise it. `agent-semi` also has an automatic budget (`limits.auto`, default a tenth of the ceiling): above it the operation is returned as `needs-human` and nothing is signed, so the agent can tell the user instead of stalling. `agent-full` has no automatic budget. Fresh vaults start in `agent-semi`; an existing `policy.json` is never changed by an upgrade. Switch in Settings → Web3 → Security (loosening needs the PIN). Agents can still only tighten.
- The vault's account index, signing policy, hard limits, security settings and 24h spend window follow their files on disk, so changes made by another process (the CLI, a second plugin instance) are visible without a restart.

### Fixed

- An account created after the host started (by another process) could not be used for signing until a restart: the account index was read once at open and only the accounts unlocked at startup were decrypted. Accounts are now picked up from disk and decrypted on first use with the session passphrase.
- Spend caps counted only operations signed by the same process; operations signed elsewhere in the 24h window are now included.

## dsh-web3 0.8.2 — 2026-10-16

### Fixed

- Tool parameters are registered on `ctx.tools` as object-rooted JSON Schema (`{ type: "object", properties, required }`), the projection `defineTool()` performs. They were passed in the authoring DSL, which `register()` stores as-is, so strict providers rejected every turn — DeepSeek's native model failed with `Invalid schema for function 'wallet_address_book': schema must be a JSON Schema of 'type: "object"'`. Verified identical to DSH's own projection for all 30 tools.

## dsh-web3 0.8.1 / dsh-web3-core 0.4.1 — 2026-10-13

### Changed

- The GitHub repository moved to [dushudou/dsh-web3](https://github.com/dushudou/dsh-web3) (the old `dsh-wallet` address redirects); package metadata and documentation links point at it. No code changes.

## dsh-web3 0.8.0 / dsh-web3-core 0.4.0 — 2026-10-12

### Added

- **Pre-signing security checks** on every transfer, approval, contract call, EIP-712 signature, and x402 payment, run in parallel with per-check time budgets, at prepare time and again before signing when the preview is older than 30 seconds:
  - `local`: address poisoning, first-time recipients, tokens sent to token contracts, approvals / permits to plain wallets, unlimited approvals, long-lived permits, chain-less signatures.
  - `denylist`: user denylist plus cached OFAC SDN and ScamSniffer lists, refreshed daily.
  - `sanctions`: Chainalysis on-chain sanctions oracle (Ethereum, OP, BSC, Polygon, Arbitrum, Avalanche).
  - `simulation`: `eth_simulateV1` reconciled with the decoded intent — extra outflows, wrong amounts, hidden approvals, recipients that forward funds onward (sweepers), funds reaching denylisted addresses, reverts.
  - `goplus` (opt-in): GoPlus address reputation and honeypot tokens you would receive.
- Findings escalate the decision and never loosen it: `critical` → refused even after approval, `high` → human approval even when a rule would auto-sign.
- Tools `wallet_security_check` and `wallet_denylist` (the agent can add to the denylist; removal is panel-only).
- Settings panel: security check switches, feed status and refresh, denylist management; weakening any check needs the PIN.
- Core: `runSecurityChecks`, `escalateDecision`, `Denylist`, `summarizeSimulation`, `reconcileSimulation`, `JsonRpcChainProvider.simulate`, `security.json` settings.
- DSH bundle metadata: `icon.svg`, `locale/en.json` and `locale/zh.json` display text, exported for DSH's plugin pages.
- `DSH_WEB3_DENYLIST_REFRESH=off` disables feed downloads.

### Changed

- Results now carry structured `security` (`severity`, `findings`, `checks`, `simulation`); `warnings` remains as plain text.
- Approval prompts show a **Security checks** block.

## dsh-web3 0.7.0 / dsh-web3-core 0.3.0 — 2026-10-11

### Added

- Intent decoding (ERC-20 transfer / approve, Permit, Permit2, EIP-3009, marketplace orders) and intent-aware policy guardrails; `micropay` preset.
- Hard limits (`limits.json`): transfer whitelist, stablecoin and native per-transfer / daily caps that no approval can override.
- Prepare → execute pipeline with single-use `preparedId`, idempotency keys, and a transaction journal written before broadcast; `wallet_transfer`, `wallet_approve_token`, `wallet_allowance`, `wallet_tx_status`, `wallet_history`, `wallet_replace_transaction`, `wallet_address_book`.
- Structured error codes with recovery hints; native DSH tool cards.
- Skill served through the DSH skill registry; stale `~/.dsh/skills` mirrors are cleaned up.
- macOS Keychain for the vault passphrase and PIN pepper, migrated from the plaintext credentials file.
- Settings panel tabs: Assets, Accounts, Security, Limits, Activity; PIN step-up for anything that weakens protection.

### Removed

- WebAuthn fingerprint unlock: the default `http://127.0.0.1` address cannot be a WebAuthn relying-party id.

### Breaking

- Model tools no longer return recovery phrases or private keys (`unsafeAllowModelSecretReveal` restores the old behavior; not recommended).
- Custom `allow` rules that auto-signed token transfers through selectors or value caps now ask; add `intents` and `tokenLimits` to automate them.
- The agent can only tighten the policy (`locked` / `strict`); loosening is panel-only.

## dsh-web3 0.6.0 / dsh-web3-core 0.2.1 — 2026-08-29

- `wallet_x402_authorize`: x402 `exact` payments (EIP-3009) with challenge parsing and policy gating.
- Policy rule fields `maxCountPerDay`, `cooldownSeconds`, `allowedAssets`, `firstSeenAsk`; over-cap `allow` rules downgrade to `ask`.
- 0.5.x added WebAuthn fingerprint unlock (removed in 0.7.0).

## dsh-web3 0.2.0 – 0.4.2 — 2026-08-26 to 2026-08-27

- DSH Web integration: Typert Remote `web3/*` namespace and the Web3 settings page (i18n, themes, create / import flows), `~/.dsh-web3` data directory.
- Resilient free RPC selection (`pickReachableRpc`), bundled skill injection, tools registered on `ctx.tools`.

## dsh-web3 0.1.x / dsh-web3-core 0.1.x — 2026-08-25

- First release: encrypted vault (scrypt + AES-256-GCM), HD accounts and imports, EIP-1559 / 191 / 712 signing, declarative signing policy with daily spend tracking, daily PIN, audit log, chain registry, model tools, and read-only HTTP endpoints.
