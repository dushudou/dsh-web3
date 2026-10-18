# dsh-web3 钱包能力设计：功能、DSH 集成、安全与体验、Agent 调用准确性

> 2026-09-25 · 对应版本 `dsh-web3-core@0.3.0` / `dsh-web3@0.7.0`
> 本文回答四个问题，并记录本轮已实现与后续路线。已实现的部分都有单测覆盖（`pnpm run all`：235 个测试，2026-10-11）。

---

## 1. Web 钱包应该具备哪些功能？

参考 MetaMask / Rabby / Rainbow（面向人）与 Coinbase AgentKit、OKX Agentic Wallet（面向 Agent），一个完整的 EVM 钱包按能力域划分如下。✅ = 已有，🆕 = 本轮新增，🗺 = 路线图。

| 能力域 | 功能 | 状态 |
|---|---|---|
| **账户** | 创建（BIP-39）/ 导入（助记词、私钥、keystore）/ 导出 keystore / 删除 | ✅ |
| | 同一助记词派生多个地址（MetaMask “Add account”） | 🆕 `wallet_create {fromAccount}` |
| | 备份提醒（未备份标记）、面板内备份（PIN 逐次验证） | 🆕 |
| | 硬件钱包 / 外部签名器 | 🗺 |
| **网络** | 内置多链、自定义 RPC、可用 RPC 自动探测 | ✅ |
| **资产** | 原生币余额 | ✅ |
| | ERC-20 余额（默认含各链常见稳定币）、精度正确的格式化 | 🆕（修复 `Number()` 精度丢失） |
| | NFT 列表、法币估值、资产自动发现（需索引服务） | 🗺 |
| **收付款** | 原生币转账 | ✅ |
| | 人类单位金额 + 代币符号转账、`max` 全部转出 | 🆕 `wallet_transfer` |
| | 收款人：地址 / ENS / 通讯录 / 自己的账户 | 🆕 |
| | 通讯录 | 🆕 `wallet_address_book` |
| **交易生命周期** | 预览（nonce/gas/fee） | ✅ |
| | 可执行的预览（preparedId）、幂等键、交易日志 | 🆕 |
| | 状态查询、本地历史、加速 / 取消 | 🆕 `wallet_tx_status` / `wallet_history` / `wallet_replace_transaction` |
| **授权管理** | 查询 / 设置 / 撤销 ERC-20 额度 | 🆕 `wallet_allowance` / `wallet_approve_token` |
| | 全量授权扫描与一键撤销（需索引服务） | 🗺 |
| **签名** | personal_sign、EIP-712 | ✅ |
| | EIP-712 意图解码（Permit / Permit2 / EIP-3009 / 挂单） | 🆕 |
| **支付协议** | x402 exact | ✅ → 🆕 修复主网 USDC EIP-712 域、支持 v2 `amount` / `maxTimeoutSeconds` / `extra` |
| | x402 upto / MPP session | 🗺 |
| **安全** | 加密保险库（口令存 macOS 钥匙串）、自动锁、签名策略、PIN 授权、审批、审计 | ✅ |
| | 意图感知策略 + 护栏（代币金额、无限授权） | 🆕 |
| | 预检：余额、会回滚、零地址、转给代币合约本身、地址投毒、首次收款人 | 🆕 |
| | 交易模拟对账（`eth_simulateV1`）、黑名单（OFAC / ScamSniffer / 用户）、链上制裁预言机、GoPlus 信誉（可选） | ✅（§8） |
| **生态接入** | Swap / 跨链桥（聚合器）、dApp 连接（EIP-1193 / WalletConnect） | 🗺 |

---

## 2. 如何在 DSH 中支持这些功能

### 2.1 分层架构

```text
┌──────────────────────── DSH ────────────────────────┐
│ Agent ──(function call)──► ctx.tools: wallet_*       │  模型工具面：人类单位、结构化结果
│ Skill: dsh-web3-wallet (自动同步到 ~/.dsh/skills)     │  流程与铁律
│ Approval 服务 ◄──── ask 决策（完整地址/金额/风险）     │  人在回路
│ 设置 → Web3 面板 ◄── Typert Remote web3/*            │  PIN / 备份 / 导入 / 历史
└──────────────────────────┬──────────────────────────┘
                           │ ctx.wallet (WalletService)
┌──────────────────────────▼──────────────────────────┐
│ dsh-web3 service:  prepare → execute 管线            │
│   resolve(收款人/代币/金额) → populate → intent 解码   │
│   → 预检 → policy → PIN → approval → sign → journal   │
│   → broadcast                                         │
├──────────────────────────────────────────────────────┤
│ dsh-web3-core: vault · policy(+guardrails) · intent   │
│   tokens registry · journal · address book · spend    │
└──────────────────────────────────────────────────────┘
```

**原则：模型只表达意图，确定性转换全部在钱包侧完成。** 模型说“给 Alice 在 Base 上转 25 USDC”，钱包负责：标签 → 地址、符号 → 合约（仅从白名单/配置解析）、`"25"` → `25_000_000`（链上核对精度）、构造 calldata、预检、出审批文案。

### 2.2 三个接入面各司其职

| 接入面 | 用途 | 不做什么 |
|---|---|---|
| 模型工具 `wallet_*` | 查询、准备、执行、状态 | 不返回助记词/私钥/PIN |
| 审批服务（approval） | 对 `ask` 决策做一次性人工确认 | 不在 PIN 未解锁时打扰用户 |
| 设置面板（Remote `web3/*`） | PIN、导入、**备份（新）**、交易历史（新） | 不经过模型 |

### 2.3 prepare → execute 管线（本轮核心）

1. **prepare**（`wallet_transfer {dryRun}` / `wallet_prepare_transaction` / `wallet_approve_token {dryRun}`）：解析 → 填充 → 解码意图 → 预检 → 策略试算，返回 `preparedId`（15 分钟、单次使用）、`summary`、`warnings`、`willRequire{humanApproval, dailyPin, blocked}`。
2. **execute**（`wallet_send_transaction {preparedId}`）：按账户串行加锁 → 重新获取 nonce/费用（收款人/金额/数据不变）→ 策略 → **锁定检查 → PIN → 审批** → 签名 → **先写日志再广播** → 记账。

---

## 3. 安全与体验的平衡

### 3.1 威胁模型

| 威胁 | 例子 | 对策 |
|---|---|---|
| 模型出错 | wei 换算差 10^12、地址少一位、链写错 | 人类单位 + 钱包侧换算、地址不补全、校验和、链上精度核对 |
| 提示词注入 | 网页让 Agent “授权给 0xattacker” / 签 Permit | 意图解码 + 护栏：动资产的操作不被数值规则放行，无限授权永远人工 |
| 地址投毒 | 历史里混入首尾相同的假地址 | 投毒检测 warning、审批框显示完整地址 |
| 重复支付 | 超时后 Agent 重试 | 幂等键、单次 preparedId、先写日志再广播、`broadcast-uncertain` 状态 |
| 密钥泄露 | 助记词进入对话 → 发送给模型服务、写入会话日志 | 工具默认不返回密钥（`unsafeAllowModelSecretReveal` 显式开启才可），备份在面板完成且每次验证 PIN |
| 策略绕过 | `chainId: "1"`（字符串）让 deny 规则失配 | 策略引擎统一归一化 chainId |

### 3.2 分层授权：让“低风险无感、高风险可控”

| 层级 | 场景 | 交互 |
|---|---|---|
| L0 自动 | 测试网、本地链；规则显式覆盖且在额度内的操作（如 `micropay`：≤1 USDC/笔、≤10/天的 x402 支付） | 无感 |
| L1 首次确认 | 新收款人 / 新商户（`firstSeenAsk`）、超出额度 | 一次审批，之后回到 L0 |
| L2 每次确认 | 主网代币转账、授权、Permit、合约调用 | 审批框（完整地址、真实金额、手续费上限、风险提示） |
| L3 强制人工 | 无限授权、`setApprovalForAll`、Permit2 批量 | 护栏强制 `ask`，任何规则都无法自动放行 |
| L4 面板专属 | 查看助记词/私钥、设置/修改 PIN | 只在设置面板，每次验证 PIN |
| 全局 | PIN 授权（输入一次，有效 1 / 7 / 30 天，默认 1 天）、自动锁定、审计日志 | — |

**护栏（guardrails）是本轮最重要的安全修复。** 旧策略只看原生币 `value`，而 ERC-20 转账和授权的 `value` 都是 0：`power` 预设中“主网 ≤0.01 ETH 自动签名”的规则会自动签下 `transfer(攻击者, 全部 USDC)` 或无限 `approve`。现在：

- 策略请求携带解码后的 `intent`（`token-transfer` / `token-approve` / `permit` / `transfer-authorization` …）。
- `allow` 规则只有在 `match.intents` **显式列出**该意图时才能自动放行动资产的操作；带金额的意图还必须命中 `tokenLimits`（逐代币的单笔/24h 上限）。
- 无限授权类意图永远降级为 `ask`；`defaultEffect: allow` 也不覆盖动资产的意图。
- 新增 `recipients` 匹配器按**真实收款人**（而非代币合约）匹配；首次收款人/冷却期也按真实收款人计算。

**体验上的取舍：**
- PIN 在审批**之前**检查：不会出现“用户点了批准，结果因 PIN 未解锁而失败”。
- 锁定状态同样在审批前检查。用户主动锁定（面板或 `wallet_lock`）是明确选择：不自动解锁，重启后仍保持（保险库目录下的 `user-lock.json`），直到显式解锁。闲置超时或宿主重启造成的锁定不是用户的选择：签名时用已保存的口令自动解锁并写审计（`vault.unlocked`，`trigger: "signing"`），策略、限额、PIN、审批照常生效。Agent 本来就能调用 `wallet_unlock` 无交互解锁，所以这不会削弱防护，只是避免签名莫名失败。
- 预览时就告诉 Agent 需要什么（`willRequire`），Agent 可以一次性把“先解锁 PIN、会弹审批框”说清楚。
- `micropay` 预设让 x402 小额付费真正无感：每个新商户只确认一次。

### 3.3 已知边界（诚实说明）

- **同用户进程边界**：如果 Agent 拥有与钱包同一系统用户的 shell 权限，它理论上可以读取凭据库中的保险库口令并自行解密密钥——任何进程内的软件闸门都无法防御这一点。需要强隔离时的方向：`passphrase.mode: manual` 且口令只在面板输入、不落盘；或进程外签名器（独立系统用户 / 系统钥匙串 + 用户在场验证 / 硬件钱包）。已列入路线图。
- **本地模拟有限**：`WOULD_REVERT` 基于 `eth_estimateGas`，能发现回滚但不能展示“资产变化”；完整模拟需接入 trace/模拟服务。
- **代币白名单是人工维护的**：`tokens.ts` 中的地址与精度在转账时会与链上 `decimals()` 交叉核对，不一致直接拒绝。

---

## 4. 如何确保 Agent 准确无误地调用

准确性问题的根源是“让模型做它不擅长的确定性工作”。对策是把这些工作全部收回到钱包里，并让每一步的结果都可被机器判定。

| 机制 | 解决的问题 | 实现 |
|---|---|---|
| 人类单位输入 | wei / 精度换算错误 | `amount: "0.05"`、`token: "USDC"`；拒绝 `1,5`、`1e18`、超精度小数 |
| 确定性解析 | 代币地址幻觉、收款人歧义 | 符号只查配置/白名单；标签精确匹配；地址不补全；链上核对精度与合约存在性 |
| prepare → execute | 用户确认的与实际签的不一致 | `preparedId` 绑定收款人/金额/数据，执行时只刷新 nonce/费用 |
| 幂等与日志 | 超时重试导致重复付款 | `idempotencyKey`、单次 `preparedId`、广播前写日志、`already-submitted` / `broadcast-uncertain` |
| 结构化错误 | 模型面对异常字符串时乱猜 | `{ ok:false, code, message, hint }`，21 个稳定错误码，每个带下一步 |
| 状态 → 下一步 | 模型不知道何时该停 | 每个结果带 `status` 与 `next`；SKILL.md 中有完整对照表 |
| 预检 warnings | 模型不知道哪些情况要特别提醒用户 | 投毒、首次收款人、合约收款人、ENS 解析、无限授权 |
| 输入归一化 | `"8453"` 与 `8453` 行为不同 | chainId 统一归一化，非法值返回 `UNKNOWN_CHAIN` |
| 并发安全 | 并行调用导致 nonce 冲突 | 按账户串行执行；只读工具标记 `isConcurrencySafe` |
| 文档与工具一致 | 技能文档与实际参数不符（旧文档写的是 `message`，实际是 `value`） | 重写 SKILL.md；单测保证文档中的工具名与注册工具**完全一致**、参数符合 DSH DSL |

---

## 5. 本轮改动清单

**dsh-web3-core 0.3.0**
- `intent.ts`：交易/EIP-712 意图解码；ERC-20 编码与读取辅助。
- `tokens.ts`：各链常见代币白名单（含 EIP-712 域）。
- `policy`：`intents` / `recipients` / `tokenLimits` 匹配器、护栏、chainId 归一化、`micropay` 预设；本地链/测试网预设显式覆盖代币意图。
- `spend`：逐代币 24h 累计。
- `journal.ts`：交易日志；`addressbook.ts`：通讯录。
- `vault`：`deriveAccount`、`recordSignedAuthorization`。
- `signer`：`populateTransaction` 报告 `estimateError`（不再静默用 200k gas 签会回滚的交易）。
- `provider`：`resolveName`（ENS）、代币余额格式化精度修复。

**dsh-web3 0.7.0**
- `service.ts`：prepare → execute 管线、预检、日志、状态/历史/加速/取消、授权、通讯录、面板备份、keystore 导出到文件、x402 修复。
- `tools.ts`：新增 `wallet_transfer`、`wallet_approve_token`、`wallet_allowance`、`wallet_tx_status`、`wallet_history`、`wallet_replace_transaction`、`wallet_address_book`；统一错误包装；密钥默认不进对话；删除账户/导出 keystore 需审批。
- `errors.ts`、`assets.ts`：错误码与资产/收款人解析。
- `remote.ts` + 面板：`web3/reveal`（每次验证 PIN 的备份）、`web3/history`、`web3/addressBook`；账户“备份”按钮、未备份标记、最近交易卡片。
- `config`：`unsafeAllowModelSecretReveal`（默认 false）。
- 依赖改为 `dsh-web3-core: workspace:^`（此前插件实际链接的是 npm 上的旧版 core）。

**行为变更（升级须知）**
- `wallet_reveal_secret` / `wallet_create {reveal}` 默认不再返回密钥，改为指引到面板；需旧行为请设置 `unsafeAllowModelSecretReveal: true`。
- 仅靠 `selectors` / 数值上限放行代币转账的自定义 `allow` 规则，现在会降级为 `ask`；需自动化时请在规则中加入 `intents` 与 `tokenLimits`。
- 审批文案改为“摘要 + 完整地址 + 真实金额”格式。
- x402 的 `validAfter` 提前 30 秒以容忍结算方时钟偏差。

## 6. 路线图

1. **进程外签名器**：独立系统用户或系统钥匙串（用户在场验证），关闭“同用户 shell 可解密”这一边界。
2. ~~**交易模拟**~~：已完成（§8，`eth_simulateV1` 对账）。
3. ~~**地址信誉**~~：已完成（§8，黑名单库 + 制裁预言机 + 可选 GoPlus）。
4. **索引能力**：代币自动发现、NFT、全量授权扫描与撤销、完整历史（含转入）。
5. **Swap / 跨链**：接聚合器报价，复用 prepare → execute 与护栏。
6. **智能账户**：ERC-4337 / EIP-7702 session key，把额度约束从插件层下沉到合约层。

---

## 7. 2026-10-07 增补：优先调用 · 安全 · 设置面板（适配 DSH 0.2）

### 7.1 让 DSH 优先使用本插件

| 手段 | 做法 |
|---|---|
| 原生 skill 注册 | 通过 `ctx.skills.registerProvider` 以 bundled 来源提供 `dsh-web3-wallet`（DSH ≥ 0.2），插件加载即进入每个会话的 skill 目录，卸载即消失；不再往 `~/.dsh/skills` 写文件。 |
| 目录描述即路由 | DSH 的 skill 目录只展示 `name: description`（截断到 500 字），`whenToUse` 不展示。描述改为中英双语触发词，并明确“优先于 shell / 脚本 / curl / 其他钱包技能”。 |
| 意图路由表 | SKILL.md 开头加入“用户想做什么 → 首选工具”表（参考 OKX Agentic Wallet 的 Intent Routing），模型加载后一步定位工具。 |
| 旧镜像清理 | 用户目录（rank 400）会覆盖 bundled（rank 600）。启动时删除内容与已发布版本哈希一致或带托管标记的旧镜像；用户改过的副本保留并告警。 |
| 原生工具卡片 | 每个 `wallet_*` 工具实现 `presentCall`，聊天里显示 `25 USDC → 0x7099…79C8 · Base` 这类标题，与内置工具一致。 |
| 测试隔离 | vitest 全局把 `DSH_HOME` 指向临时目录——此前跑测试会把开发版 SKILL.md 写进真实 `~/.dsh/skills`。 |

### 7.2 安全：硬性限额 + “Agent 只能收紧”

- **硬性限额（`limits.json`）**：转账白名单、稳定币单笔/每日上限（美元计、跨链合计）、原生币单笔/每日上限（按币种）。在策略之后判定，违反即 `deny`，**审批框点同意也无法放行**；决策带 `decision.limit` 并写入审计。
- **Agent 只能收紧**：`wallet_policy_set` 只接受 `locked` / `strict` 且必须真的更严格；放宽或自定义文档返回 `status: "use-panel"`。Agent 不能修改白名单联系人（`USE_PANEL`）。
- **面板 step-up**：放宽限额/预设、加白名单、改联系人地址、查看助记词、导出、删除账户，都要求**已设置 PIN** 并当场输入；收紧不打扰用户。step-up 走带节流的校验，错误次数计入锁定。
- **修复 PIN 暴力破解口**：`PinGuard.changePin` 之前校验当前 PIN 不计失败次数，可经 `web3/pinChange` 无限尝试；现在走 `verify()` 节流。
- **失败即关闭**：`limits.json` 损坏时保险库拒绝打开，而不是静默丢掉上限。

### 7.3 设置面板（参考 OKX 功能，交互与 DSH 原生一致）

| OKX Agentic Wallet | dsh-web3 面板 |
|---|---|
| 余额 / 持仓、地址 | 资产：账户 + 网络切换、收款地址、余额、最近交易 |
| 账户管理、导出 | 账户：创建 / 导入 / 备份 / 重命名 / 导出 Keystore（浏览器下载）/ 删除 |
| 单笔限额、每日限额、白名单 | 限额：安全模式、稳定币与原生币上限（含今日用量）、转账白名单与联系人 |
| 审计日志、交易记录 | 记录：交易（浏览器链接）+ 审计日志 |
| 登录与安全 | 安全：锁定/解锁、PIN、Agent 权限说明 |

全部使用 DSH primitives（SegmentedTabs、Switch、Modal、RiskConfirmation、Menu、Tag、Button、Input）与 `--dsw-*` 主题变量，扁平的设置行 + 0.5px 分隔线与原生设置页一致；深浅色、中英文随宿主切换。设置导航图标由 DSH 外壳按 section id 固定，第三方 section 统一为齿轮，这是原生行为。

### 7.4 验证

- 单测：核心 + 插件共 228 个（限额、白名单、step-up、预设收紧判定、skill provider 与旧镜像清理、面板包加载与中英文案一致）。
- 端到端：在隔离的 `DSH_HOME` + 临时保险库中启动 DSH 0.2.0-rc.2，经真实 `/api` RPC 跑通创建、限额收紧/放宽、PIN step-up、预设切换、白名单、助记词 PIN 校验，以及会话 skill 目录（来自插件包、旧镜像已删除）。
- 视觉：无头 Chrome 打开 设置 → Web3 钱包，逐个标签页、菜单与弹窗截图（深色/浅色），无运行时错误。

### 7.5 2026-10-11 增补：移除 WebAuthn，本地秘密改存 macOS 钥匙串

- **移除 WebAuthn 指纹解锁**：`dsh web` 默认地址 `http://127.0.0.1:3080` 不能作为 WebAuthn rpId，默认部署下指纹注册/校验无法工作；它只是 PIN 的快捷方式，并不提升密钥安全。相关存储、remote 方法、工具与面板卡片已全部删除，每日授权只保留 PIN。
- **钥匙串（`secretStore: auto | keychain | none`，默认 macOS 上 `auto` 即钥匙串）**：通过 `/usr/bin/security` 读写（无原生模块），值经 stdin 传入、不出现在进程列表里，写入后回读确认；条目在服务 `dsh-web3` 下，账户名包含保险库路径，不同保险库互不共享。
  - **保险库口令**：解析顺序中钥匙串优先于明文凭据文件；发现明文副本时自动迁入钥匙串，写入失败则保留明文副本，不丢口令。
  - **PIN pepper**：PIN 哈希改为以钥匙串中 32 字节 pepper 做 HMAC 后再派生（PIN 文件 v2）。只偷走 PIN 文件无法离线暴力破解；v1 旧文件继续可校验。pepper 读不到时报 `PinPepperUnavailableError`，不降级为无 pepper 校验。
- **验证**：235 个单测全部通过（含钥匙串优先、明文迁移、写入失败回退）；真实钥匙串冒烟测试（写入、覆盖、pepper 稳定、删除）通过。

---

## 8. 2026-10-12 增补：签名前安全检查（风险引擎，core 0.4.0 / web3 0.8.0）

### 8.1 要解决的问题

此前的预检结果只是字符串 `warnings`，**不影响放行决策**：`power` 预设会自动签署 ≤0.01 ETH 的主网转账，即使预检报了 `ADDRESS POISONING RISK`，这条警告也只返回给 Agent，审批框不会出现；被提示词注入的 Agent 可以直接无视。签名路径（Permit、x402）则完全没有预检。

### 8.2 设计

```text
prepare / execute / signTypedData / x402
        │  SecuritySubject（意图、链、交易、相关地址及其角色）
        ▼
 RiskCheck[] 并行执行，每项有独立时间预算
   local · denylist · sanctions · simulation · goplus(可选)
        ▼
 RiskFinding { code, severity, message, check, address }
        ▼
 escalateDecision：critical → deny，high → ask，只收紧不放宽
        ▼
 最终 decision = 策略 → 硬性限额 → 安全检查
```

- **结构化结果**：`PreparedView.security = { severity, findings, checks, simulation }`；`warnings` 保留为同样内容的纯文本，兼容旧调用方。审批框新增「Security checks」区块。
- **执行前复查**：预览超过 30 秒后执行时重新检查（链上状态、黑名单都可能变化）；一步完成的转账复用刚做的检查。
- **失败策略**：检查超时或出错生成 `SECURITY_CHECK_UNAVAILABLE`，严重程度由用户设置 `onUnavailable`（warn / ask / deny）决定；RPC 不支持模拟属于“跳过”，只给 info。
- **只收紧**：Agent 可以拉黑地址（`wallet_denylist add`），不能移除；面板里关闭任何检查、放宽 `onUnavailable`、移除黑名单都需要 PIN。`security.json` 与 `denylist.json` 损坏时保险库拒绝打开（失败即关闭），下载的黑名单缓存损坏则重新下载。

### 8.3 检查项

| 检查 | 发现（严重程度） | 依赖 |
|---|---|---|
| `local` | 地址投毒 `ADDRESS_POISONING`(high)、授权给普通钱包 `APPROVAL_TO_EOA`(high)、无限授权(high)、收款方是代币合约(high)、首次收款人(warn)、收款方是合约/7702 委托账户(warn)、Permit 期限过长(warn)、签名不含 chainId(warn)、ENS 解析(info) | 链 RPC |
| `denylist` | `DENYLISTED_ADDRESS`(critical)：用户黑名单、OFAC SDN 以太坊地址、ScamSniffer 诈骗库 | 本地缓存（每日更新） |
| `sanctions` | `SANCTIONED_ADDRESS`(critical)：Chainalysis 链上制裁预言机 `0x40C5…C8fb` | 链 RPC（1/10/56/137/42161/43114） |
| `simulation` | 多出的转出、金额不符、隐藏授权、收款后立即转走（清扫地址）、资金流向黑名单地址、模拟回滚(high/critical)；合约调用的资产变化(info)、只出不进(warn) | 链 RPC（`eth_simulateV1`） |
| `goplus` | 盗币/钓鱼/制裁地址(critical)、其他恶意标记(high)、收到貔貅币(high) | GoPlus API，默认关闭 |

### 8.4 外部依赖的核实（2026-10-11）

- OFAC：`0xB10C/ofac-sanctioned-digital-currency-addresses` 的 `sanctioned_addresses_ETH.json`（120 个地址）；ScamSniffer：`scam-database/blacklist/address.json`（2530 个地址）。均为 JSON 数组，下载失败或内容为空时保留旧列表。
- Chainalysis 预言机：`eth_getCode` 确认部署于以太坊、OP、BSC、Polygon、Arbitrum、Avalanche，Base 与 Gnosis 没有；用 OFAC 地址实测返回 `true`、普通地址返回 `false`。
- `eth_simulateV1`：默认 RPC 中以太坊（publicnode / drpc）、OP、BSC、Polygon、Base、Arbitrum、Gnosis 支持；cloudflare-eth 与 Avalanche 官方 RPC 不支持（降级为 info）。`traceTransfers` 把原生币转账报告为 `0xeeee…eeee` 发出的 Transfer 日志。
- 实测发现：hardhat 测试账户 #2（`0x3C44…93BC`）在 Base 主网上是一个清扫合约，收到 ETH 后同一笔交易内转给 `0xCc04…3B95`；模拟检查据此判为 `RECIPIENT_FORWARDS_FUNDS`(high)。
- GoPlus：`address_security` 与 `token_security` 无需 API key；OFAC 地址返回 `stealing_attack`、`sanctioned`、`blacklist_doubt`。

### 8.5 验证

- 单测：核心 + 插件共 260 个（新增引擎/升级/设置/黑名单/模拟对账 11 个，插件端到端 14 个）。
- 真实网络：Base 上的真实模拟抓到清扫地址；黑名单库真实下载；对 OFAC 地址的检查由黑名单、制裁预言机、GoPlus 三个来源同时判为 critical，并行总耗时约 1.5 秒。
- 面板：React 服务端渲染确认安全检查与黑名单区块正常显示（含下载失败状态），后端为旧版本时不显示新区块、不报错。

