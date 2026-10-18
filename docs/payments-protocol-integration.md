# dsh-web3 无感安全交易 & 第三方支付协议集成设计

> 迭代任务（每 30 分钟一轮），本文档为第 1 轮产出（2026-08-29）。

## 一、第三方协议调研结论

### x402（Coinbase）—— 值得集成 ✅
- **定位**：permissionless、crypto-native 的机器间支付（M2M）标准。HTTP 402 "Payment Required" 触发，另支持 MCP / A2A / 自定义传输。
- **支付流程**（基于 EIP-712/EIP-3009 的真实实现）：
  1. 服务端返回 `X-PAYMENT` 挑战头（payTo 地址、asset 合约、maxAmountRequired、资源 URL）
  2. 客户端用钱包做 **EIP-712 签名**（如 USDC 的 `TransferWithAuthorization`：from/to/value/validAfter/validBefore/nonce）——离线授权，不上链
  3. 服务端把签名载荷转发给 facilitator 验证（余额、nonce 防重放）
  4. facilitator 中继结算（替客户端付 gas），链上确认后通知
- **与我们钱包的关系**：`wallet_sign_typed_data` 正是 x402 客户端签名源。集成后 DSH agent 可无感为外部服务付费。
- **要点**：签名用 `eth_signTypedData_v4`；nonce 用 bytes32 随机值防重放；有效窗口（如 5 分钟）限时；生产依赖中心化 facilitator（Coinbase 官方 $0.001/tx 超出 1K 免费）；SIWx 会话（2026-03）支持跳过重复付费。Base 生态活跃。
- **风险**：facilitator 中心化（Hydra 等去中心化替代仍在论文阶段）；签名请求需 UI 展示人读字段。

### MPP（Machine Payments Protocol，Stripe + Tempo）—— 暂不集成，借鉴设计 ⚠️
- **定位**：enterprise-ready、多结算轨道（Stripe fiat + Tempo stablecoin）。已提交 IETF Internet-Draft。
- **两种支付意图**：
  - **Charge intent**：一次性支付，**与 x402 exact flow 等价且向后兼容**
  - **Session intent**（核心差异）：agent 存入 escrow 合约（~500ms），之后每个请求发**累计 EIP-712 签名 voucher**；服务端 `ecrecover` 验证（无需 RPC/DB），亚 100ms 延迟；微支付低至 $0.0001/请求；会话结束**批量结算为一笔链上交易**并自动退款
- **SDK/中间件**：TS/Python/Rust；Next.js/Hono/Express/CF Workers/FastAPI/Deno/Bun；HTTP/MCP/JSON-RPC。
- **不集成理由**：主结算链是 Tempo（VC 背书 L1）；fiat 集成依赖 Stripe 且仅美国企业可用；与个人开源 EOA 钱包定位不符。
- **借鉴**：session 流式 + 批量结算思想可纳入远期路线（智能账户化后）。

### 四协议栈（agentic commerce 全景）
| 协议 | 发起方 | 层 |
|---|---|---|
| ACP | OpenAI + Stripe | 结账流/商品发现 |
| AP2 | Google/A2A | 授权与信任（集成 x402 结算）|
| x402 | Coinbase | permissionless 稳定币结算 |
| MPP | Stripe + Tempo | 多轨结算 + 流式会话 |

## 二、无感安全交易交互方案（分层授权）

**目标**：agent 高频小额无感、关键交易可控安全。核心是**分层授权**（复用现有 policy engine + PIN 门禁）：

| 层级 | 场景 | 交互 | 现状 |
|---|---|---|---|
| L0 | 白名单地址 + 小额 | policy allow，**无感自动** | policy engine 已支持 |
| L1 | 常规交易/签名 | PIN 授权（输入一次，有效期内免输）+ approval ask | 已实现 |
| L2 | 大额 / 新地址 / 揭示私钥 | PIN（每次重验）+ approval | 已实现 |
| 全局 | 任何交易 | 每日限额、速率限制、地址信誉、稳定币默认 | 待加 |

**无感机制选项**（探索结论）：
1. ~~**WebAuthn / Touch ID 指纹解锁**~~：已实现后又移除（2026-10-11，见三.y A）——默认的 127.0.0.1 地址无法作为 WebAuthn rpId。
2. **会话密钥（session keys，ERC-4337）**（远期）：临时受限签名者（合约级强制：目标合约、金额上限、有效期、预算）。需要智能账户化（ERC-4337 或 EIP-7702）。Base/OP/Polygon/Arbitrum 均已支持 ERC-4337。
3. **EIP-7702**：EOA 临时委托合约逻辑，无需迁移即可获得 AA 能力（Pectra 已上线）。
4. **Paymaster gas 抽象**：USDC 付 gas，agent 无需持有 ETH。

**关键判断**：当前 EOA + 插件策略层，最快实现"无感安全"的路径是 **策略分层 + 每日限额**；会话密钥/智能账户作为 Phase 3 远期演进（需部署合约，改动大）。

## 三、集成路线（分阶段）

- **Phase 1（近期）**：策略分层强化（每日限额、新地址要求确认）。
- **Phase 2**：x402 客户端集成——新增 `wallet_x402_authorize` 工具（接收 X-PAYMENT 挑战 → 组装 EIP-712/EIP-3009 载荷 → 走 PIN/approval → 返回签名 → 填 PAYMENT-SIGNATURE 头）。DSH agent 从而能无感为 x402 服务付费。
- **Phase 3（可选）**：ERC-4337 智能账户化 + session keys（需评估部署成本与合约审计）。

## 三.x wallet_x402_authorize 工具设计（步骤 2 产出，2026-08-29）

### 1. 定位
把"agent 遇到 HTTP 402 → 授权支付 → 回填签名头"的 x402 客户端流程封装成一个工具，供 DSH agent 调用。签名能力复用现有 `service.signTypedData`（EIP-712），新增 x402 专属的：挑战解析、EIP-3009 载荷组装、金额/收款校验、安全门禁。

### 2. 工具 schema（对齐现有 DSH 参数 DSL）
```
name: wallet_x402_authorize
description: Authorize an x402 payment: parse the challenge, build an EIP-3009
  TransferWithAuthorization, and sign it under the signing policy. Returns the
  signed payload for the PAYMENT-SIGNATURE / X-PAYMENT header.
parameters:
  account:      string, required   # 支付账户 id/address/label
  challenge:    json,   required   # 服务端 402 响应里的挑战（见下）
  amount:       string, optional   # 授权金额（原子单位，<= maxAmountRequired），缺省=maxAmountRequired
  ttlSeconds:   number, optional   # 有效窗口秒数，缺省 300，上限 3600
```

### 3. 挑战解析（normalize）
接受两种 x402 v2 形态：
- **accepts 数组**：`{ x402Version, accepts: [{ scheme, network, maxAmountRequired, asset, payTo }] }`，取 scheme==="exact" 的首项
- **扁平对象**：`{ maxAmountRequired, resource, description, payTo, asset, network }`
- network 字符串 → chainId 映射（内置表 + 用户可扩展）：
  `eip155:<n>` → `<n>`；`base`→8453、`base-sepolia`→84532、`ethereum-mainnet`→1、`polygon`→137、`arbitrum`→42161、`optimism`→10、`bsc`→56；未知网络返回错误并提示用 `eip155:<chainId>` 或配置 chainId。
- 校验：`payTo`/`asset` 为合法地址；`maxAmountRequired` 为十进制非负整数；金额 `amount <= maxAmountRequired`；`scheme !== "exact"` 时拒绝（本工具只支持 exact 一次性授权）。

### 4. EIP-3009 TransferWithAuthorization 载荷组装
```
domain:  { name: "USDC", version: "2", chainId, verifyingContract: asset }   // asset=USDC 合约地址；name/version 可按资产调整
types:   TransferWithAuthorization = [from, to, value, validAfter, validBefore, nonce]
message: { from: account.address, to: payTo,
           value: amount, validAfter: now, validBefore: now + ttlSeconds,
           nonce: randomBytes(32) hex }
```
- nonce：crypto.randomBytes(32)，防重放；同一签名只允许一次性结算
- 输出除 `signature` 外，回传完整 `authorization` 对象（from/to/value/validAfter/validBefore/nonce）供 agent 组装 `PAYMENT-SIGNATURE` 头（Base64 JSON payload）
- 返回结构：`{ status, signature, authorization, payTo, asset, chainId, amount, expiresAt, resource? }`

### 5. 安全与门禁
- 走与 `wallet_sign_typed_data` 相同的 policy 判定 + approval + PIN 授权门禁；approval reason 用**人读字段**（金额、收款方、资产、资源、有效期）防钓鱼——绝不让 agent 盲签
- 校验链：`chainId` 必须在支持的链集合内；`asset` 建议只允许稳定币（USDC/USDT/DAI/EURC 白名单，可配置）
- 金额上限受 L0-L2 分层授权约束（可复用：白名单+小额无感，否则 ask）
- 私钥永不外泄：签名在 vault 内完成，返回只有 signature

### 6. Facilitator 选择建议
- **生产首选**：Coinbase CDP 官方 facilitator（最成熟，超出 1K 免费后 $0.001/tx，Base/Ethereum/Polygon/Solana 已生产）
- **备选**：自托管开源 facilitator（数据/隐私敏感场景）
- **观望**：去中心化 Hydra 网络（BFT+质押，解决 facilitator 中心化，仍属论文/早期，不进入本期）
- 集成方式：插件不内置 facilitator，仅输出签名载荷，由 agent/上层 HTTP 层把载荷交回服务端（服务端自己接 facilitator）。插件层面保持"只签名、不结算"，降低信任面。

### 7. 与现有工具的关系
- 复用 `service.signTypedData`（已含 policy/PIN/approval 全套），新增 `service.authorizeX402` 封装层（解析→组装→签名→回传）
- 对 agent 的 skill 描述同步新增 `wallet_x402_authorize` 使用示例（遇到 402 时如何调用、如何回填头）

## 三.y Phase 1 无感交互细化（步骤 3 产出，2026-08-29）

### A. WebAuthn 指纹解锁（已移除，2026-10-11）

曾在 web3 0.5.x–0.7.x 实现，现已整体删除。原因：`dsh web` 默认地址是 `http://127.0.0.1:3080`，而 WebAuthn 规范不允许 IP 地址作为 rpId，指纹注册/校验在默认地址下无法工作；且它只是 PIN 的"加速替代"，并不提升密钥本身的安全。每日授权只保留 PIN；本地密钥安全改为 macOS 钥匙串（钱包口令 + PIN 哈希 pepper）。

### B. 每日限额与地址信誉策略字段设计

**现有 policy 已内建**（无需重复造）：`maxValuePerDay`（rolling 24h 日额度，spend.ts 已跟踪）、`to`/`from` 白名单、`minTxValue`/`maxTxValue`、`chainIds`/`selectors`/`type`。

**Phase 1 建议新增字段**（`PolicyRuleMatch` 扩展，兼容旧策略）：
| 字段 | 类型 | 语义 |
|---|---|---|
| `maxCountPerDay` | number | 该规则下每日最大操作笔数（配合 maxValuePerDay，防高频小额刷） |
| `cooldownSeconds` | number | 同一 `to` 地址两次操作最小间隔（防连环套） |
| `allowedAssets` | string[] | 仅允许的操作代币/合约地址（稳定币白名单，防混入高波动资产） |
| `firstSeenAsk` | boolean | 新地址（从未在 spend 状态出现）强制 ask，老白名单地址 allow |

**地址信誉模型**（轻量，本地）：
- 信誉数据并入 spend 状态文件（`~/.dsh-web3/spend-state.json` 或新 `address-book.json`）：
  `{ address → { firstSeenTs, txCount, totalWei, lastSeenTs, riskFlags[] } }`
- 规则引擎在评估时注入 `accountReputation`；`firstSeenAsk:true` 时新地址无条件 ask（已有默认行为，显式化）
- 不做链上信誉查询（无外部依赖），保持本地自持

**预设调整**：`strict` 预设加入 `maxCountPerDay`/`cooldownSeconds`；新增 `guard` 预设（面向大额：默认 deny + 白名单 allow + 双重确认）。

## 四.x 实现状态与交付（2026-08-29 收尾）

- **已发布包**（npm 公开，latest）：
  - `dsh-web3-core@0.2.1`（策略分层字段 + `PinGuard.markAuthorizedToday`）
  - `dsh-web3@0.6.0`（WebAuthn 后端 + 前端指纹卡片 + x402 工具）
- **Phase 1 策略分层**（core 0.2.0）：`maxCountPerDay`/`cooldownSeconds`/`allowedAssets`/`firstSeenAsk`；allow 规则超限自动降级 ask（堵住原日额度超限仍放行的缺口）；84 单测全过。
- **Phase 1 无感交互**（web3 0.5.0/0.5.1，**2026-10-11 已移除**，见三.y A）：`BiometricStore`（`~/.dsh-web3/webauthn.json` 仅存公钥+计数器）、6 个 biometric remote 方法、`wallet_biometric_status` 工具、设置面板"指纹解锁"卡片（WebAuthn 注册/校验/禁用 + CBOR 公钥解析 + 回退 PIN）；39 单测全过。
- **Phase 2 x402**（web3 0.6.0）：`wallet_x402_authorize` 工具——accepts/扁平挑战解析、eip155/命名网络→chainId、EIP-3009 组装、nonce 防重放、ttl 60-3600s、金额上限校验、复用 policy+approval+PIN 门禁、只签名不结算；42 单测全过。
- **skill 集成说明**：dsh-web3 以 DSH 插件形式提供**模型工具 surface**（status/balance/send_transaction/sign_message/sign_typed_data/x402_authorize 等），安装插件后 agent 天然可调用，无需额外 skill 注入机制；DSH 设置面板（web3 Remote）承载需人参与的交互（PIN/审批/建包导入）。
- **端到端验证状态**：服务端单测全过（core 84 + web3 42）；运行实例确认（0.6.0 加载、client.js 200、lib 含 x402）。真实浏览器端（审批 UI、Touch ID 指纹弹窗、agent 实调 x402）需用户在带 Touch ID 的浏览器操作确认——待用户验证项。

## 四、参考来源
- x402/Hydra 去中心化 facilitator 论文：aka.doubaocdn.com/s/jVSPI3rrlS
- MPP 官方解析（Formo）：formo.so/blog/mpp-machine-payments-protocol-explained
- x402 + EIP-3009 USDC 真实实现（Netlify/MetaMask）：tubone-project24.xyz/2026/05/08/x402-protocol-ai-agent-micropayment
- ERC-4337 session keys（Rhinestone/ZeroDev/Safe）：web3aiblog.com、rebelfi.io、docs.erc4337.io、blockeden.xyz、screk.com
