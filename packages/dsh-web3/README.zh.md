# dsh-web3

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-web3.svg)](https://www.npmjs.com/package/dsh-web3)
[![CI](https://github.com/dushudou/dsh-web3/actions/workflows/ci.yml/badge.svg)](https://github.com/dushudou/dsh-web3/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/dsh-web3.svg)](LICENSE)

面向 [DeepSeek Harness (DSH)](https://www.npmjs.com/package/@deepseek-ai/dsh) 的 Agent 安全 EVM 钱包，以 DSH bundle 的形式发布。

## 概要

让 Agent 帮你查余额、转代币、签 Permit、支付 x402 账单，而私钥永远不会出现在对话里。密钥只加密保存在本机。每一笔操作在签名前都要经过签名策略、硬性限额和安全检查（黑名单、制裁名单、交易模拟），有风险的操作会等你确认。DSH 设置里的 **Web3 钱包**页面负责账户、备份、PIN、限额和黑名单。

## 目录

- [使用](#使用)
- [实现原理](#实现原理)
- [模型体验](#模型体验)
- [已知限制](#已知限制)
- [延伸阅读](#延伸阅读)

-----

## 使用

### 环境要求

- DSH `0.2.x`（bundle 声明了 `@deepseek-ai/dsh-typert-protocol` 的 peer 版本范围，DSH 在安装和启动时会检查）
- Node.js 20 或更高
- macOS 上使用钥匙串保存口令（其他平台使用 DSH 凭据存储）

### 安装

```bash
dsh plugin --profile web add dsh-web3
```

也可以在 DSH Web 侧边栏的**插件**页面安装 `dsh-web3`。bundle 自带的 `cordis.patch.yml` 会以 `web3` 这一行挂载插件；开启 HMR 时（默认的 `web` profile）立即生效，否则重启 DSH。

然后打开 **设置 → Web3 钱包**：创建或导入钱包、备份助记词、设置 PIN。

### 配置

在 profile 的 `cordis.patch.yml` 里覆盖 `web3` 这一行，所有字段都可选：

```yaml
- id: web3
  config:
    vaultPath: ~/.dsh-web3       # 保险库目录（默认 ~/.dsh-web3）
    autoLockMs: 900000           # 闲置 15 分钟后锁定（签名时自动解锁；手动锁定会保持）
    passphrase:
      mode: auto                 # auto | env | manual
    secretStore: auto            # auto（macOS 上用钥匙串）| keychain | none
    chains:
      rpc:                       # 按链覆盖 RPC
        1: https://my-eth-rpc.example
      tokens:                    # 额外显示余额的代币
        8453:
          - address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
            symbol: USDC
    disableTools: false          # true = 只提供服务，不注册 wallet_* 工具
    disableHttp: false
    unsafeAllowModelSecretReveal: false   # 不要开启：密钥会进入对话记录
```

| 环境变量 | 作用 |
|---|---|
| `DSH_WALLET_PASSPHRASE` | 保险库口令（`env` 模式，或口令解析顺序的第一位） |
| `DSH_WEB3_SECRET_STORE` | `keychain` / `none`；细化 `secretStore: auto` |
| `DSH_WEB3_DENYLIST_REFRESH` | 设为 `off` 时不再每天下载 OFAC / ScamSniffer 地址库（离线机器） |

### 设置面板

| 标签页 | 功能 |
|---|---|
| 资产 | 账户与网络切换、收款地址、余额、最近交易、设置提醒 |
| 账户 | 创建、导入（助记词 / 私钥 / keystore）、备份、重命名、导出 keystore、删除 |
| 安全 | 锁定 / 解锁、PIN、签名前安全检查与地址库状态、黑名单、Agent 权限 |
| 限额 | 安全模式（预设，含半托管 / 全托管）、含今日用量的转账上限（硬顶）、半托管的自动预算、转账白名单与联系人、策略规则 |
| 记录 | 带区块浏览器链接的交易记录、审计日志（同一次签名的各条记录共用 `requestId`） |

凡是降低保护或涉及密钥的操作——放宽预设或限额、加入白名单、关闭某项安全检查、从黑名单移除地址、查看助记词、导出、删除账户——都需要输入 PIN。收紧设置不需要。

### 安全模式

| 预设 | 自动签名 | 需要你确认 |
|---|---|---|
| `agent-semi`（推荐，新钱包默认） | 自动预算以内的全部操作，受安全检查约束 | 超过自动预算：不签名，返回 `needs-human` 由 Agent 告诉你，调高自动预算或切换模式后再执行；高危发现、无限授权会询问；超过硬顶直接拒绝 |
| `strict` | 无 | 全部 |
| `agent-full` | 硬顶以内的全部操作，受安全检查约束 | 超过硬顶直接拒绝（在 设置 → Web3 → 限额 调整）；高危发现、无限授权会询问 |
| `micropay` | 商户首次付款之后，≤1 USDC/笔、≤10 USDC/天的 x402 付款 | 其他全部 |
| `testnet` | 测试网上的小额操作 | 主网 |
| `power` | 主网原生币转账，≤0.01/笔、≤0.05/天 | 代币、授权、Permit |
| `locked` | 无（拒绝一切签名） | — |

硬性限额（稳定币和原生币上限、转账白名单）以及严重级别的安全检查发现，即使你在审批框点了同意也会拒绝。

自动预算（`limits.json` 的 `auto`，默认是硬顶的十分之一）只对 `agent-semi` 生效，在 设置 → Web3 → 限额 → 自动预算 修改：某项留空表示不设自动预算、只受硬顶约束；填 0 表示该项从不自动签名。调高或清空需要 PIN。

审计日志（`audit/audit-<date>.jsonl`）里，同一次签名请求的决策、审批、挂起和签名记录共用一个 `requestId`，并记录发起工具（`via`）、当时的安全模式（`preset`）和被签内容的哈希（消息哈希、EIP-712 digest、交易 nonce / calldata 哈希 / txHash）。

### 服务 API（`ctx.wallet`）

其他插件可以使用和工具相同的流程：

```ts
const prepared = await ctx.wallet.prepareTransfer({ account: 'main', chainId: 8453, to: 'alice', amount: '25', token: 'USDC' });
// prepared.summary、prepared.security.findings、prepared.willRequire
const result = await ctx.wallet.executePrepared(prepared.preparedId, approvalGateway, { toolName: 'my-plugin' });

await ctx.wallet.checkAddress({ address: '0x…', chainId: 1 });   // 黑名单、制裁名单、相似地址
await ctx.wallet.signTypedData({ account, domain, types, value }, approvalGateway);
await ctx.wallet.authorizeX402({ account, challenge }, approvalGateway);
```

-----

## 实现原理

<details>
<summary>实现细节——点击展开</summary>

### 签名流程

```text
prepare  解析收款人 / 代币 / 金额 → 填充 nonce、gas、手续费
         → 解码意图 → 预检（会否回滚、余额）→ 策略试算
         → 安全检查 → 决策升级 → 一次性 preparedId（15 分钟有效）
execute  按账户加锁 → 刷新 nonce / 手续费 → 策略 → 安全复查
         → 保险库锁定状态 + PIN 授权 → 人工审批（`ask` 时）→ 签名
         → 写日志 → 广播
```

模型只表达意图。收款人标签、代币符号、精度和 calldata 都由钱包解析；预览的内容就是最终签名的内容；一次性 id、幂等键和"广播前先写日志"保证重试安全。

### 决策

1. **签名策略**（`policy.json`）：`allow` / `ask` / `deny` 规则。会动资产的意图（代币转账、授权、Permit）只有在规则明确列出且未超出逐代币上限时才会自动签名；无限授权永远需要人工确认。
2. **硬性限额**（`limits.json`）：转账白名单以及单笔 / 每日上限，违反即 `deny`。
3. **签名前安全检查**（`security.json`），并行执行，每项有独立的时间预算：

| 检查 | 能发现什么 | 网络依赖 |
|---|---|---|
| `local` | 地址投毒、首次收款人、把代币转给代币合约、把授权或 Permit 给普通钱包、无限授权、期限过长的 Permit、不含 chainId 的签名 | 链 RPC |
| `denylist` | 用户黑名单 + 本地缓存的 OFAC SDN 与 ScamSniffer 地址库（每天更新） | 决策时不联网 |
| `sanctions` | Chainalysis 链上制裁预言机（以太坊、OP、BSC、Polygon、Arbitrum、Avalanche） | 链 RPC |
| `simulation` | `eth_simulateV1` 模拟结果与解码意图对账：多出的转出、金额不符、隐藏授权、收款后立即转走资金的地址、资金流向黑名单地址 | 链 RPC |
| `goplus` | GoPlus 地址信誉，以及你将收到的貔貅币——**默认关闭**，开启后会把对方地址和收到的代币地址发给 GoPlus | GoPlus API |

`critical` 直接拒绝；`high` 即使规则允许自动签名也会要求人工确认；`warn` / `info` 只展示。安全检查只会收紧决策。某项检查没能完成时会生成 `SECURITY_CHECK_UNAVAILABLE`，它的严重程度由用户的 `onUnavailable` 设置决定。

### 密钥与口令

- 密钥文件每个账户一个，用 scrypt + AES-256-GCM 加密，账户 id 绑定进认证标签。
- 保险库口令的解析顺序：`DSH_WALLET_PASSPHRASE` → macOS 钥匙串 → DSH 凭据存储；`auto` 模式下首次使用时生成 32 字节随机口令。在明文凭据文件里找到的口令会被迁移进钥匙串。
- PIN 以 scrypt 哈希保存，并用存放在钥匙串里的 pepper 加固。输入一次 PIN 后，敏感操作在 1 / 7 / 30 天内无需重复输入（在 设置 → Web3 → 安全 中设置，默认 1 天）。延长时长需要 PIN，缩短立即生效。
- 工具永远不返回助记词、私钥或 PIN；备份在设置面板里完成。

### 文件（保险库目录）

`vault.json`（账户元数据，不含密钥）· `keys/<id>.json`（加密密钥，0600）· `policy.json` · `limits.json` · `security.json` · `denylist.json` · `denylist-feeds.json` · `address-book.json` · `tx-journal.json` · `spend-state.json` · `pin.json` · `audit/audit-<date>.jsonl`。`policy.json`、`limits.json`、`security.json`、`denylist.json` 损坏时保险库拒绝打开，而不是悄悄丢掉保护。

### 对外接口

- `ctx.wallet`——服务（[`src/service.ts`](src/service.ts)）。
- 注册在 `ctx.tools` 上的 `wallet_*` 工具（[`src/tools.ts`](src/tools.ts)）。
- 设置面板使用的 Typert Remote 命名空间 `web3/*`（[`src/remote.ts`](src/remote.ts)、[`client/client.js`](client/client.js)）。
- 存在 `http` 服务时，挂载在 `/api/dsh-web3/*` 下的只读 HTTP 接口。
- 通过 `ctx.skills.registerProvider` 提供的 `dsh-web3-wallet` skill。

</details>

-----

## 模型体验

### 钱包工具

#### 模型看到什么

30 个 `wallet_*` 函数工具，主要的有：

| 工具 | 用途 |
|---|---|
| `wallet_status`、`wallet_list`、`wallet_balance`、`wallet_chains` | 状态、账户、余额、支持的链与代币符号 |
| `wallet_transfer` → `wallet_send_transaction` | 用人类单位转账（`amount: "25"`、`token: "USDC"`）；`dryRun` 预览，凭 `preparedId` 执行 |
| `wallet_prepare_transaction`、`wallet_approve_token`、`wallet_allowance` | 合约调用与 ERC-20 授权，解码为意图 |
| `wallet_sign_message`、`wallet_sign_typed_data`、`wallet_x402_authorize` | EIP-191 / EIP-712 签名与 x402 `exact` 付款 |
| `wallet_tx_status`、`wallet_history`、`wallet_replace_transaction` | 交易状态、本地历史、加速 / 取消 |
| `wallet_security_check`、`wallet_denylist` | 付款前检查地址；拉黑地址（移除只能在面板） |
| `wallet_policy_get`、`wallet_policy_set` | 读取策略与限额；只能收紧 |
| `wallet_address_book`、`wallet_create`、`wallet_import`、`wallet_remove_account`、`wallet_export_keystore`、`wallet_reveal_secret`、`wallet_pin_status`、`wallet_pin_verify`、`wallet_unlock`、`wallet_lock`、`wallet_audit_log` | 联系人、账户管理、备份指引、门禁状态、审计 |

结果都带 `status`、`next` 提示和结构化的 `security.findings`；失败统一为 `{ ok: false, code, message, hint }`，错误码稳定。在 DSH 聊天里，每次调用都会显示原生工具卡片，例如 `25 USDC → 0x7099…79C8 · Base`。

#### Token 影响

插件加载期间，工具声明会给每次请求增加约 18,000 字符（约 5–6 千 token）。每次调用会追加它的 JSON 结果；带模拟的预览最大，通常 1–3 千 token。

#### KV Cache 影响

工具声明是静态的，会和其余工具列表一起被缓存。安装、移除或禁用插件会改变工具列表，使缓存前缀失效一次。

### 内置 skill

#### 模型看到什么

`dsh-web3-wallet` skill 在会话的 skill 目录里只占一行（约 350 字符，含中英文触发词），把钱包、转账、代币、签名、x402 和钱包策略相关请求路由到 `wallet_*` 工具，优先于 shell 脚本或其他钱包 skill。加载后得到完整操作手册：意图路由、铁律、标准流程、状态处理，以及如何转达安全检查结果。

#### Token 影响

目录里的一行始终存在；skill 正文（约 11,000 字符）只在模型加载时才进入上下文。

#### KV Cache 影响

目录行是静态的。加载后的 skill 正文像普通工具结果一样追加到对话中。

-----

## 已知限制

- **同用户边界。** 以你的系统用户身份运行的任何程序——包括拥有不受限 shell 权限的 Agent——都可以无提示地从登录钥匙串读出保险库口令并解密密钥文件。请把它当作只放小额资产的热钱包，并且不要在使用它的会话里给 Agent 不受限的 shell 权限。
- 策略、限额和安全检查只对经过本插件的签名生效；密钥一旦被盗，这些保护都会被绕过。
- 暂不支持硬件钱包和智能账户（会话密钥）。
- 威胁情报仅限 OFAC、ScamSniffer、制裁预言机和可选的 GoPlus。
- 部分 RPC（例如 Avalanche 官方公共节点）不支持 `eth_simulateV1`，在这些链上预览会注明没有进行模拟。
- 代码尚未经过外部安全审计。

发现漏洞请按 [SECURITY.md](../../SECURITY.md) 私下报告。

## 延伸阅读

- [`dsh-web3-core`](../dsh-web3-core/README.md)——本插件依赖的保险库、策略、意图解码、模拟与黑名单库。
- [钱包设计文档](../../docs/wallet-design.md)——功能地图、威胁模型和变更记录。
- [内置 skill](skills/dsh-web3-wallet/SKILL.md)——模型加载的操作手册。
- [更新日志](../../CHANGELOG.md)

## 许可证

[MIT](LICENSE)
