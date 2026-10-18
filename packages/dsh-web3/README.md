# dsh-web3

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-web3.svg)](https://www.npmjs.com/package/dsh-web3)
[![CI](https://github.com/dushudou/dsh-web3/actions/workflows/ci.yml/badge.svg)](https://github.com/dushudou/dsh-web3/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-web3.svg)](LICENSE)

An agent-safe EVM wallet for [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh), packaged as a DSH bundle.

## Summary

Let an agent check balances, send tokens, sign permits, and pay x402 invoices without ever holding a private key in the chat. Keys stay encrypted on your machine. Every operation passes a signing policy, hard spending limits, and pre-signing security checks (denylists, sanctions, transaction simulation) before anything is signed, and the risky ones wait for your approval. A **Web3 wallet** page in DSH Settings handles accounts, backups, PIN, limits, and the denylist.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations](#known-limitations)
- [Further Exploration](#further-exploration)

-----

## Use this package

### Requirements

- DSH `0.2.x` (the bundle declares a `@deepseek-ai/dsh-typert-protocol` peer range that DSH checks at install and startup)
- Node.js 20 or newer
- macOS for the Keychain-backed secret store (other platforms use the DSH credentials store)

### Install

```bash
dsh plugin --profile web add dsh-web3
```

Or open the **Plugins** page in the DSH Web sidebar and install `dsh-web3`. The bundle's `cordis.patch.yml` mounts the plugin as the `web3` row; with HMR on (the default `web` profile) it is live immediately, otherwise restart DSH.

Then open **Settings → Web3 wallet**: create or import a wallet, back up the recovery phrase, and set a PIN.

### Configuration

Override the `web3` row in your profile's `cordis.patch.yml`. Every field is optional:

```yaml
- id: web3
  config:
    vaultPath: ~/.dsh-web3       # vault directory (default ~/.dsh-web3)
    autoLockMs: 900000           # lock after 15 minutes idle (signing re-opens it; a lock you choose stays)
    passphrase:
      mode: auto                 # auto | env | manual
    secretStore: auto            # auto (macOS Keychain on macOS) | keychain | none
    chains:
      rpc:                       # per-chain RPC overrides
        1: https://my-eth-rpc.example
      tokens:                    # extra tokens to show balances for
        8453:
          - address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
            symbol: USDC
    disableTools: false          # true = service only, no wallet_* tools
    disableHttp: false
    unsafeAllowModelSecretReveal: false   # never turn on: secrets would enter the transcript
```

| Environment variable | Effect |
|---|---|
| `DSH_WALLET_PASSPHRASE` | Vault passphrase (`env` mode, or first in the resolution chain) |
| `DSH_WEB3_SECRET_STORE` | `keychain` / `none`; refines `secretStore: auto` |
| `DSH_WEB3_DENYLIST_REFRESH` | `off` stops the daily OFAC / ScamSniffer downloads (offline machines) |

### Settings panel

| Tab | What it does |
|---|---|
| Assets | Account and network picker, receiving address, balances, recent transactions, setup reminders |
| Accounts | Create, import (phrase / key / keystore), back up, rename, export keystore, remove |
| Security | Lock / unlock, PIN, pre-signing checks and feed status, denylist, agent permissions |
| Limits | Security mode (presets, including semi- and fully managed), spending caps (the hard ceiling) with today's usage, the semi-managed automatic budget, transfer whitelist and contacts, policy rules |
| Activity | Transaction history with explorer links, audit log (entries of one signing request share a `requestId`) |

Anything that weakens protection or exposes keys — loosening a preset or a limit, whitelisting, switching a security check off, removing a denylisted address, revealing a recovery phrase, exporting, removing an account — asks for the PIN. Tightening never asks.

### Security modes

| Preset | Signs on its own | Asks you |
|---|---|---|
| `agent-semi` (recommended, new wallets) | everything under the automatic budget, within the security checks | above the automatic budget: not signed; returns `needs-human` so the agent tells you, and it runs once you raise the budget or switch modes; high-severity findings and unlimited approvals ask; above the hard ceiling: refused |
| `strict` | nothing | everything |
| `agent-full` | everything under the hard ceiling, within the security checks | above the hard ceiling: refused (raise it in Settings → Web3 → Limits); high-severity findings and unlimited approvals ask |
| `micropay` | x402 USDC payments ≤ 1 each, ≤ 10 a day, after a merchant's first payment | everything else |
| `testnet` | small testnet operations | mainnet |
| `power` | mainnet native transfers ≤ 0.01 each, ≤ 0.05 a day | tokens, approvals, permits |
| `locked` | nothing (refuses everything) | — |

Hard limits (stablecoin and native caps, transfer whitelist) and critical security findings refuse a request even after you click approve.

The automatic budget (`auto` in `limits.json`, by default a tenth of the hard ceiling) applies to `agent-semi` only and is edited in Settings → Web3 → Limits → Automatic budget: a blank item has no automatic budget (only the hard ceiling applies); 0 never signs that item automatically. Raising or clearing it asks for the PIN.

In the audit log (`audit/audit-<date>.jsonl`) the decision, approval, hold and signature entries of one signing request share a `requestId` and record the tool that started it (`via`), the preset in force (`preset`) and a hash of what was signed (message hash, EIP-712 digest, transaction nonce / calldata hash / txHash).

### Service API (`ctx.wallet`)

Other plugins can use the same pipeline the tools use:

```ts
const prepared = await ctx.wallet.prepareTransfer({ account: 'main', chainId: 8453, to: 'alice', amount: '25', token: 'USDC' });
// prepared.summary, prepared.security.findings, prepared.willRequire
const result = await ctx.wallet.executePrepared(prepared.preparedId, approvalGateway, { toolName: 'my-plugin' });

await ctx.wallet.checkAddress({ address: '0x…', chainId: 1 });   // denylist, sanctions, look-alikes
await ctx.wallet.signTypedData({ account, domain, types, value }, approvalGateway);
await ctx.wallet.authorizeX402({ account, challenge }, approvalGateway);
```

-----

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Signing pipeline

```text
prepare  resolve recipient / token / amount → populate (nonce, gas, fees)
         → decode intent → preflight (revert, balance) → policy dry-run
         → security checks → escalate → single-use preparedId (15 min)
execute  per-account lock → refresh nonce / fees → policy → security re-check
         → vault lock + PIN authorization → human approval (when `ask`) → sign
         → journal → broadcast
```

The model only expresses intent. Recipient labels, token symbols, decimals, and calldata are resolved by the wallet; the prepared plan is exactly what gets signed; retries are safe through single-use ids, idempotency keys, and a journal written before broadcast.

### Decisions

1. **Signing policy** (`policy.json`): `allow` / `ask` / `deny` rules. Asset-moving intents (token transfers, approvals, permits) are auto-signed only by rules that list them explicitly and stay within per-token limits; unlimited approvals always ask.
2. **Hard limits** (`limits.json`): transfer whitelist and per-transfer / daily caps; a violation is `deny`.
3. **Pre-signing security checks** (`security.json`), run in parallel with per-check time budgets:

| Check | What it catches | Network |
|---|---|---|
| `local` | Address poisoning, first-time recipients, tokens sent to token contracts, approvals / permits to plain wallets, unlimited approvals, long-lived permits, chain-less signatures | chain RPC |
| `denylist` | User denylist + cached OFAC SDN and ScamSniffer lists (refreshed daily) | none at decision time |
| `sanctions` | Chainalysis sanctions oracle (Ethereum, OP, BSC, Polygon, Arbitrum, Avalanche) | chain RPC |
| `simulation` | `eth_simulateV1` reconciled with the decoded intent: extra outflows, wrong amounts, hidden approvals, recipients that forward funds onward, funds reaching denylisted addresses | chain RPC |
| `goplus` | GoPlus address reputation and honeypot tokens you would receive — **off by default**, it sends counterparty and received-token addresses to GoPlus | GoPlus API |

A `critical` finding refuses the request, `high` forces human approval even when a rule would auto-sign, `warn` / `info` are shown. Checks only ever tighten a decision. A check that cannot finish reports `SECURITY_CHECK_UNAVAILABLE`, whose weight is the user's `onUnavailable` setting.

### Secrets

- Key files are scrypt + AES-256-GCM encrypted, one per account, with the account id bound into the authentication tag.
- The vault passphrase resolves from `DSH_WALLET_PASSPHRASE`, then the macOS Keychain, then the DSH credentials store; in `auto` mode a 32-byte random passphrase is generated on first use. A passphrase found in the plaintext credentials file is moved into the Keychain.
- The PIN is stored as an scrypt hash keyed by a pepper kept in the Keychain. One entry authorizes sensitive operations for 1, 7 or 30 days (set in Settings → Web3 → Security; default 1 day). Lengthening the period needs the PIN; shortening takes effect at once.
- Tools never return recovery phrases, private keys, or the PIN; backups happen in the settings panel.

### Files (vault directory)

`vault.json` (accounts, no secrets) · `keys/<id>.json` (encrypted keys, 0600) · `policy.json` · `limits.json` · `security.json` · `denylist.json` · `denylist-feeds.json` · `address-book.json` · `tx-journal.json` · `spend-state.json` · `pin.json` · `audit/audit-<date>.jsonl`. `policy.json`, `limits.json`, `security.json`, and `denylist.json` fail closed: a corrupt file stops the vault from opening instead of silently dropping protection.

### Surfaces

- `ctx.wallet` — the service ([`src/service.ts`](src/service.ts)).
- `wallet_*` tools registered on `ctx.tools` ([`src/tools.ts`](src/tools.ts)).
- Typert Remote namespace `web3/*` for the settings panel ([`src/remote.ts`](src/remote.ts), [`client/client.js`](client/client.js)).
- Read-only HTTP routes under `/api/dsh-web3/*` where an `http` service exists.
- The `dsh-web3-wallet` skill through `ctx.skills.registerProvider`.

</details>

-----

## Model Experience

### Wallet tools

#### What the model sees

30 `wallet_*` function tools. The main ones:

| Tool | Purpose |
|---|---|
| `wallet_status`, `wallet_list`, `wallet_balance`, `wallet_chains` | State, accounts, balances, supported chains and token symbols |
| `wallet_transfer` → `wallet_send_transaction` | Transfers in human units (`amount: "25"`, `token: "USDC"`); preview with `dryRun`, execute by `preparedId` |
| `wallet_prepare_transaction`, `wallet_approve_token`, `wallet_allowance` | Contract calls and ERC-20 allowances, decoded into an intent |
| `wallet_sign_message`, `wallet_sign_typed_data`, `wallet_x402_authorize` | EIP-191 / EIP-712 signing and x402 `exact` payments |
| `wallet_tx_status`, `wallet_history`, `wallet_replace_transaction` | Status, local history, speed-up / cancel |
| `wallet_security_check`, `wallet_denylist` | Check an address before paying it; denylist an address (removal is panel-only) |
| `wallet_policy_get`, `wallet_policy_set` | Read policy and limits; tighten only |
| `wallet_address_book`, `wallet_create`, `wallet_import`, `wallet_remove_account`, `wallet_export_keystore`, `wallet_reveal_secret`, `wallet_pin_status`, `wallet_pin_verify`, `wallet_unlock`, `wallet_lock`, `wallet_audit_log` | Contacts, account lifecycle, backup guidance, gates, audit |

Results carry a `status`, a `next` hint, and structured `security.findings`; failures are `{ ok: false, code, message, hint }` with stable codes. In the DSH chat, each call shows a native tool card such as `25 USDC → 0x7099…79C8 · Base`.

#### Token effect

The tool declarations add about 18,000 characters (roughly 5–6k tokens) to every request while the plugin is loaded. Each call adds its JSON result; previews with a simulation are the largest (typically 1–3k tokens).

#### KV Cache effect

Declarations are static, so they cache with the rest of the tool list. Installing, removing, or disabling the plugin changes the tool list and invalidates the cached prefix once.

### Bundled skill

#### What the model sees

The `dsh-web3-wallet` skill appears in the session skill catalog as one line (about 350 characters, Chinese and English trigger words) that routes wallet, transfer, token, signing, x402, and wallet-policy requests to the `wallet_*` tools ahead of shell scripts or other wallet skills. Loading it adds the full playbook: intent routing, rules, flows, status handling, and how to relay security findings.

#### Token effect

The catalog line is always present; the skill body (about 11,000 characters) enters the context only when the model loads it.

#### KV Cache effect

The catalog line is static. A loaded skill body is appended like any tool result.

-----

## Known Limitations

- **Same-user boundary.** Any program running as your OS user — including an agent with unrestricted shell access — can read the vault passphrase from the login Keychain without a prompt and decrypt the key files. Keep this a hot wallet for small amounts, and do not give agents unrestricted shell access in sessions that use it.
- Policy, limits, and security checks apply only to signing through this plugin; a stolen key bypasses them.
- No hardware wallet or smart-account (session key) support yet.
- Threat intelligence is limited to OFAC, ScamSniffer, the sanctions oracle, and optional GoPlus.
- Some RPCs (for example Avalanche's public endpoint) do not support `eth_simulateV1`; on those chains the preview notes that no simulation ran.
- The code has not had an external security audit.

Report vulnerabilities privately as described in [SECURITY.md](../../SECURITY.md).

## Further Exploration

- [`dsh-web3-core`](../dsh-web3-core/README.md) — the vault, policy, intent, simulation, and denylist library this plugin builds on.
- [Wallet design](../../docs/wallet-design.md) — feature map, threat model, and change history (Chinese).
- [Bundled skill](skills/dsh-web3-wallet/SKILL.md) — the playbook the model loads.
- [Changelog](../../CHANGELOG.md)

## License

[MIT](LICENSE)
