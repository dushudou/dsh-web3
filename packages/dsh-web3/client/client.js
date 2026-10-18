window.__ModuleLoader__.load({
	id: "dsh-web3",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");
		const h = React.createElement;

		// ── DSH primitives (local fallbacks keep the panel usable on older hosts) ──
		let P = {};
		try {
			P = require("@deepseek-ai/dsh-client-ui-primitives") || {};
		} catch (e) {
			P = {};
		}
		const has = (name) => typeof P[name] === "function" || (P[name] !== null && typeof P[name] === "object" && P[name].$$typeof !== undefined);

		// ── styles: DSH tokens only, so light/dark and brand follow the host ──
		const CSS = `
.dshw{display:flex;flex-direction:column;gap:20px;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary)}
.dshw-tabs{margin-bottom:4px}
.dshw-section{display:flex;flex-direction:column}
.dshw-sectionHead{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;padding-bottom:4px}
.dshw-sectionTitle{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshw-sectionDesc{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshw-row{display:flex;align-items:center;gap:12px;padding:12px 0;min-height:32px}
.dshw-row+.dshw-row{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dshw-rowMain{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.dshw-rowLabel{font-size:13px;font-weight:500;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshw-rowHint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.dshw-rowControl{display:flex;align-items:center;gap:8px;flex:none}
.dshw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.dshw-dim{color:var(--dsw-alias-label-tertiary)}
.dshw-error{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary));font-size:12px}
.dshw-ok{color:var(--dsw-alias-state-success-primary);font-size:12px}
.dshw-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px}
.dshw-banner{display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-label-primary);font-size:12px}
.dshw-banner .dshw-rowControl{margin-left:auto}
.dshw-bannerInfo{background:var(--dsw-alias-bg-layer-2)}
.dshw-empty{padding:16px 0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshw-hero{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:8px 0 4px}
.dshw-heroTitle{margin:0;font-size:15px;font-weight:600}
.dshw-heroText{margin:0;font-size:12px;color:var(--dsw-alias-label-secondary);max-width:420px}
.dshw-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshw-actionsEnd{justify-content:flex-end}
.dshw-sectionHead .dshw-actions{flex:none;flex-wrap:nowrap;white-space:nowrap}
.dshw-avatar{width:28px;height:28px;border-radius:50%;flex:none}
.dshw-picker{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshw-select{height:32px;padding:0 28px 0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;appearance:none;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 14px) 14px,calc(100% - 10px) 14px;background-size:4px 4px;background-repeat:no-repeat;cursor:pointer}
.dshw-select:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dshw-amount{font-variant-numeric:tabular-nums;font-size:13px;font-weight:500}
.dshw-balanceHero{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dshw-address{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.dshw-field{display:flex;flex-direction:column;gap:6px;margin-bottom:12px}
.dshw-fieldLabel{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.dshw-fullInput{width:100%;box-sizing:border-box}
.dshw-fullInput input{width:100%;min-width:0}
.dshw-textarea{box-sizing:border-box;width:100%;min-height:84px;padding:8px 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;resize:vertical}
.dshw-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.dshw-capInput{width:120px}
.dshw-capInput input{text-align:right}
.dshw-words{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;margin:4px 0}
.dshw-word{display:flex;gap:6px;align-items:center;padding:6px 8px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.dshw-wordIndex{min-width:16px;color:var(--dsw-alias-label-dimmed);font-size:11px}
.dshw-secretBox{padding:10px;border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;word-break:break-all}
.dshw-preset{display:flex;align-items:flex-start;gap:10px;padding:12px 0;cursor:pointer;background:none;border:none;text-align:left;font:inherit;color:inherit;width:100%}
.dshw-preset+.dshw-preset{border-top:0.5px solid var(--dsw-alias-border-l2)}
.dshw-preset:disabled{cursor:default}
.dshw-radio{width:16px;height:16px;border-radius:50%;border:1px solid var(--dsw-alias-border-l4);flex:none;margin-top:2px;box-sizing:border-box}
.dshw-radioOn{border:5px solid var(--dsw-alias-state-business-primary)}
.dshw-rule{display:flex;align-items:center;gap:8px;padding:6px 0;font-size:12px}
.dshw-plain{background:none;border:none;padding:0;font:inherit;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px}
.dshw-plain:hover{color:var(--dsw-alias-label-primary)}
.dshw-link{color:var(--dsw-alias-link,var(--dsw-alias-state-business-primary));text-decoration:none;font-size:12px}
.dshw-link:hover{text-decoration:underline}
.dshw-fbBtn{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border-radius:var(--dsw-radius-md);border:0.5px solid var(--dsw-alias-border-l4);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}
.dshw-fbBtn:disabled{opacity:.45;cursor:default}
.dshw-fbPrimary{background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);border-color:transparent}
.dshw-fbInput{height:32px;padding:0 8px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;box-sizing:border-box}
.dshw-fbTag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:var(--dsw-radius-xs,4px);font-size:11px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}
.dshw-fbTag-success{color:var(--dsw-alias-state-success-primary)}
.dshw-fbTag-warning{color:var(--dsw-alias-state-warn-primary)}
.dshw-fbTag-danger{color:var(--dsw-alias-state-error-primary)}
.dshw-fbOverlay{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;background:var(--dsw-alias-bg-mask-1,rgba(0,0,0,.4))}
.dshw-fbDialog{width:min(420px,calc(100vw - 32px));display:flex;flex-direction:column;gap:14px;padding:20px 24px;border-radius:var(--dsw-radius-panel,12px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}
.dshw-fbDialog h2{margin:0;font-size:16px;font-weight:600}
.dshw-fbTabs{display:flex;gap:4px}
`;
		const STYLE_ID = "dsh-web3/wallet-panel.css";
		if (typeof document !== "undefined") {
			let tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(STYLE_ID) + "]");
			if (tag === null) {
				tag = document.createElement("style");
				tag.dataset.plugin = "dsh-web3";
				tag.dataset.pluginCss = STYLE_ID;
				document.head.appendChild(tag);
			}
			tag.textContent = CSS;
		}

		// ── primitive adapters ─────────────────────────────────────────────
		function Btn(props) {
			const variant = props.variant || "outline";
			if (has("Button")) {
				return h(P.Button, { variant, size: props.size || "sm", disabled: props.disabled, onClick: props.onClick, title: props.title, type: "button" }, props.children);
			}
			return h("button", { type: "button", className: "dshw-fbBtn" + (variant === "primary" ? " dshw-fbPrimary" : ""), disabled: props.disabled, onClick: props.onClick, title: props.title }, props.children);
		}

		function TextInput(props) {
			const common = {
				value: props.value,
				placeholder: props.placeholder,
				type: props.type || "text",
				onChange: (e) => props.onChange(e.target.value),
				onKeyDown: props.onEnter ? (e) => { if (e.key === "Enter") props.onEnter(); } : undefined,
				autoFocus: props.autoFocus,
				autoComplete: props.autoComplete || "off",
				spellCheck: false,
				inputMode: props.inputMode,
				"aria-label": props.label,
			};
			if (has("Input")) return h(P.Input, Object.assign({ className: props.className }, common));
			return h("input", Object.assign({ className: "dshw-fbInput " + (props.className || "") }, common));
		}

		function Toggle(props) {
			if (has("Switch")) return h(P.Switch, { checked: !!props.checked, onChange: props.onChange, label: props.label, disabled: props.disabled });
			return h("input", { type: "checkbox", checked: !!props.checked, disabled: props.disabled, "aria-label": props.label, onChange: (e) => props.onChange(e.target.checked) });
		}

		function Check(props) {
			if (has("Checkbox")) return h(P.Checkbox, { checked: !!props.checked, onChange: props.onChange, label: props.label, disabled: props.disabled });
			return h("label", { className: "dshw-rowHint", style: { display: "inline-flex", gap: "6px", alignItems: "center", cursor: "pointer" } },
				h("input", { type: "checkbox", checked: !!props.checked, disabled: props.disabled, onChange: (e) => props.onChange(e.target.checked) }),
				props.label,
			);
		}

		function Badge(props) {
			if (has("Tag")) return h(P.Tag, { tone: props.tone || "neutral" }, props.children);
			return h("span", { className: "dshw-fbTag dshw-fbTag-" + (props.tone || "neutral") }, props.children);
		}

		function Dot(props) {
			if (has("StateDot")) return h(P.StateDot, { state: props.state, size: 8 });
			return null;
		}

		function Dialog(props) {
			if (!props.open) return null;
			if (has("Modal")) {
				return h(P.Modal, { open: true, onClose: props.onClose, title: props.title, description: props.description, closeLabel: props.closeLabel, footer: props.footer }, props.children);
			}
			return h("div", { className: "dshw-fbOverlay", onClick: (e) => { if (e.target === e.currentTarget) props.onClose(); } },
				h("div", { className: "dshw-fbDialog", role: "dialog", "aria-modal": "true", "aria-label": props.title },
					h("h2", null, props.title),
					props.description ? h("div", { className: "dshw-rowHint" }, props.description) : null,
					props.children,
					props.footer ? h("div", { className: "dshw-actions dshw-actionsEnd" }, props.footer) : null,
				),
			);
		}

		function Tabs(props) {
			const items = props.items.map((item) => ({ value: item.value, label: item.label, id: "dshw-tab-" + item.value, panelId: "dshw-panel-" + item.value }));
			if (has("SegmentedTabs")) return h("div", { className: "dshw-tabs" }, h(P.SegmentedTabs, { items, value: props.value, onChange: props.onChange, label: props.label }));
			return h("div", { className: "dshw-tabs dshw-fbTabs", role: "tablist" },
				items.map((item) => h("button", {
					key: item.value, id: item.id, role: "tab", type: "button", "aria-selected": item.value === props.value,
					className: "dshw-fbBtn" + (item.value === props.value ? " dshw-fbPrimary" : ""),
					onClick: () => props.onChange(item.value),
				}, item.label)),
			);
		}

		function Segments(props) {
			if (has("SegmentedControl")) return h(P.SegmentedControl, { id: props.id, value: props.value, options: props.options, onChange: props.onChange, label: props.label });
			return h("div", { className: "dshw-fbTabs" }, props.options.map((option) => h("button", {
				key: option.value, type: "button", className: "dshw-fbBtn" + (option.value === props.value ? " dshw-fbPrimary" : ""),
				onClick: () => props.onChange(option.value),
			}, option.label)));
		}

		/** Overflow actions: the DSH menu when present, plain buttons otherwise. */
		function MoreMenu(props) {
			const [open, setOpen] = React.useState(false);
			if (has("Menu")) {
				return h(P.Menu, {
					open,
					align: "end",
					onClose: () => setOpen(false),
					anchor: h(Btn, { variant: "ghost", onClick: () => setOpen(!open), title: t("more") }, t("more") + " ▾"),
					items: props.items.map((item) => ({ id: item.id, label: item.label, danger: item.danger === true, disabled: item.disabled === true })),
					onSelect: (id) => {
						setOpen(false);
						const item = props.items.find((entry) => entry.id === id);
						if (item) item.onSelect();
					},
				});
			}
			return h(React.Fragment, null, props.items.map((item) => h(Btn, { key: item.id, variant: "ghost", disabled: item.disabled, onClick: item.onSelect }, item.label)));
		}

		function copyText(text) {
			if (has("writeClipboard")) return Promise.resolve(P.writeClipboard(text));
			if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
			return Promise.reject(new Error("clipboard unavailable"));
		}

		// ── locale ─────────────────────────────────────────────────────────
		const NS = "dsh-web3";
		const MESSAGES = {
			zh: {
				nav: "Web3 钱包",
				tabAssets: "资产", tabAccounts: "账户", tabSecurity: "安全", tabLimits: "限额", tabActivity: "记录", tabsLabel: "钱包设置",
				loading: "正在加载钱包…", loadFailed: "钱包插件未响应", retry: "重试", refresh: "刷新",
				cancel: "取消", confirm: "确认", save: "保存", saving: "保存中…", saved: "已保存", done: "完成", back: "返回", close: "关闭", edit: "编辑", remove: "删除", add: "添加",
				copy: "复制", copied: "已复制", optional: "（可选）", more: "更多",
				// onboarding
				welcomeTitle: "开始使用 Web3 钱包",
				welcomeText: "密钥只加密保存在本机。Agent 可以帮你查询和发起交易，但每一笔都受安全模式、限额和你的审批约束。",
				createWallet: "创建新钱包", importWallet: "导入钱包",
				// banners
				bannerLocked: "你锁定了钱包，解锁前不会签名。", unlock: "解锁", lock: "锁定",
				bannerNoPin: "还没有设置 PIN。设置后才能查看助记词、导出、删除账户和放宽限额。", setPin: "设置 PIN",
				bannerBackup: "有账户还没有备份助记词，设备丢失将无法找回资产。", backupNow: "去备份",
				bannerPinToday: "今日尚未验证 PIN，Agent 发起的签名会先要求验证。", verifyPin: "验证 PIN",
				// assets
				account: "账户", network: "网络", address: "收款地址", balances: "资产", hideZero: "隐藏零余额",
				balanceLoading: "正在读取链上余额…", balanceFailed: "读取余额失败", noTokens: "该网络上没有余额",
				testnet: "测试网", recentTx: "最近交易", viewAll: "查看全部",
				// accounts
				accountsTitle: "账户", accountsDesc: "同一助记词可派生多个地址；导入的账户单独加密保存。",
				notBackedUp: "未备份", hd: "助记词", imported: "已导入",
				rename: "重命名", backup: "备份", exportKeystore: "导出 Keystore", removeAccount: "删除账户",
				renameTitle: "重命名账户", labelPlaceholder: "例如：日常、交易",
				createTitle: "创建新钱包", createDesc: "生成新的助记词。请在下一步抄写并妥善保管。",
				accountLabel: "账户名称", words: "助记词长度", wordsN: "{n} 个单词", createBtn: "创建",
				createdTitle: "抄写你的助记词", createdDesc: "按顺序抄写到纸上并离线保管。任何拿到它的人都能转走全部资产；DSH 和 Agent 永远不会向你索要。",
				createdCheck: "我已抄写并妥善保管", createFailed: "创建失败",
				importTitle: "导入钱包", importDesc: "密钥只在本机加密保存，不会经过对话或模型。",
				srcMnemonic: "助记词", srcPrivateKey: "私钥", srcKeystore: "Keystore 文件",
				mnemonicPlaceholder: "用空格分隔的 12–24 个单词", privateKeyPlaceholder: "0x 开头的 64 位十六进制私钥", keystorePlaceholder: "粘贴 Keystore JSON",
				keystorePassword: "Keystore 密码", derivationIndex: "派生序号", importBtn: "导入", importFailed: "导入失败", importEmpty: "请输入要导入的内容",
				backupTitle: "备份账户", backupDesc: "密钥只显示在此页面，不会进入对话。请确认周围无人、无屏幕共享。",
				revealMnemonic: "显示助记词", revealPrivateKey: "显示私钥", noMnemonic: "该账户由私钥导入，没有助记词。",
				riskRevealTitle: "显示私钥？", riskRevealText: "私钥可以直接控制该账户的全部资产。只在离线、私密的环境下查看，切勿截图或发送给任何人。", riskAck: "我了解风险",
				exportTitle: "导出 Keystore", exportDesc: "用你设置的密码加密导出为 JSON 文件，可导入 MetaMask 等钱包。", exportPassword: "Keystore 密码（至少 8 位）", exportConfirm: "再次输入密码", exportBtn: "导出并下载", passwordMismatch: "两次输入的密码不一致", passwordShort: "密码至少 8 位", exported: "已下载 Keystore 文件",
				riskRemoveTitle: "删除账户？", riskRemoveText: "删除后该账户的加密密钥会从本机移除。没有备份将永久失去资产。", riskRemoveUnbacked: "⚠ 该账户尚未备份！",
				removed: "账户已删除",
				// security
				vaultSection: "钱包", vaultState: "保险库", unlocked: "已解锁", locked: "已锁定",
				vaultHint: "锁定后内存中的密钥会被清除。", autoLock: "自动锁定", autoLockValue: "闲置 {n} 分钟后", configHint: "在插件配置中修改",
				dataDir: "数据目录", keySource: "口令来源", keySourceAuto: "系统凭据（自动）", keySourceKeychain: "macOS 钥匙串（自动）", keySourceEnv: "环境变量", keySourceManual: "手动",
				authSection: "身份验证", authDesc: "输入一次 PIN 后，Agent 发起的签名在所选授权时长内无需重复输入（1 / 7 / 30 天）；查看助记词、导出、删除、放宽限额每次都要输入。",
				pin: "PIN", pinOff: "未设置", pinAuthorized: "已授权", pinUntil: "已授权，有效至 {t}", pinNotToday: "未授权", pinGrant: "授权时长", pinGrantHint: "输入一次 PIN 后，在此时长内签名无需重复输入。延长时长需要 PIN，缩短立即生效。", grant1: "1 天", grant7: "7 天", grant30: "30 天", pinGrantSaved: "授权时长已更新", pinLocked: "输错次数过多，已锁定到明天",
				pinSetup: "设置 PIN", pinChange: "修改 PIN", pinVerify: "验证", pinRevoke: "撤销授权",
				pinSetupTitle: "设置 PIN", pinChangeTitle: "修改 PIN", pinVerifyTitle: "验证 PIN",
				pinNew: "新 PIN（4–12 位）", pinRepeat: "再次输入", pinCurrent: "当前 PIN", pinTooShort: "PIN 需为 4–12 位", pinMismatch: "两次输入不一致",
				agentSection: "Agent 权限", agentDesc: "Agent 只能通过工具发起操作，以下规则无法被对话内容改变。",
				agentSecrets: "密钥不进入对话", agentSecretsHint: "助记词、私钥、PIN 不会返回给模型或写入会话日志。",
				agentSecretsOff: "已关闭（不安全）", agentOn: "已启用",
				agentLoosen: "Agent 只能收紧安全设置", agentLoosenHint: "放宽安全模式、提高限额、添加白名单只能在此面板完成并输入 PIN。",
				agentApproval: "每笔交易人工审批", agentApprovalHint: "由下方「限额 → 安全模式」决定哪些操作需要你确认。",
				// limits
				presetSection: "安全模式", presetDesc: "决定哪些操作可以自动签名，哪些需要你确认。",
				"preset_agent-semi": "半托管（推荐）", "preset_agent-semiDesc": "Agent 在自动预算内自行签名；超出自动预算的操作不签名并告诉你，需要你调高自动预算或切换模式后再执行；超出硬性上限直接拒绝。严重风险拒绝，高风险和无限额授权需确认。",
				"preset_agent-full": "全托管", "preset_agent-fullDesc": "Agent 在硬性上限内自行签名，不设自动预算；超出上限直接拒绝。严重风险拒绝，高风险和无限额授权需确认。",
				preset_strict: "严格", preset_strictDesc: "每一笔签名都需要你在审批框确认。",
				preset_micropay: "小额支付", preset_micropayDesc: "在严格模式基础上，x402 小额 USDC 付款（≤1/笔，≤10/天）自动完成；新商户首次付款仍需确认。",
				preset_testnet: "测试网自治", preset_testnetDesc: "测试网上小额操作自动签名，主网仍逐笔确认。",
				preset_power: "进阶", preset_powerDesc: "主网小额原生币转账（≤0.01/笔，≤0.05/天）自动签名；代币和授权仍需确认。",
				preset_locked: "锁定", preset_lockedDesc: "拒绝所有签名，只能查询。",
				preset_custom: "自定义策略", preset_customDesc: "当前策略包含 {n} 条自定义规则。切换预设会替换它们。",
				presetChanged: "安全模式已切换",
				whitelistSection: "转账白名单", whitelistDesc: "开启后，转账和 x402 付款只能付给白名单联系人或你自己的账户。合约交互仍按安全模式审批。",
				whitelistOnly: "仅允许向白名单转账", whitelistEmpty: "还没有联系人。", trusted: "白名单",
				contactLabel: "名称", contactAddress: "完整 0x 地址", contactNote: "备注", contactAdd: "添加联系人", contactAddDesc: "保存后可以在转账时直接说名称。加入白名单需要输入 PIN。", contactTrusted: "加入白名单", contactSaved: "联系人已保存",
				capsSection: "转账上限", capsDesc: "硬性上限：超出直接拒绝，即使在审批框点了同意也不会签名。留空表示不限制。",
				usdPerTx: "稳定币 · 单笔", usdPerDay: "稳定币 · 每日", usdHint: "USDC / USDT / DAI 按 1 美元计，跨链合计。",
				nativePerTx: "{s} · 单笔", nativePerDay: "{s} · 每日", nativeHint: "覆盖所有以 {s} 为原生币的网络。",
				usedToday: "今日已用 {v}", includeTestnets: "测试网也适用", capsSaved: "上限已保存", unlimited: "不限",
				autoSection: "自动预算", autoDesc: "半托管模式下，Agent 在此预算内自动签名；超出预算但未超硬性上限的操作不会签名，Agent 会告诉你，调高预算后可再执行。留空表示该项不设自动预算，只受硬性上限约束；填 0 表示该项每次都不自动签名。", autoInactive: "当前安全模式不使用自动预算，切换到半托管后生效。", autoSaved: "自动预算已保存",
				advanced: "策略规则", advancedShow: "查看 {n} 条规则", advancedHide: "收起",
				// activity
				activityTx: "交易", activityAudit: "审计日志", txEmpty: "钱包还没有发出过交易。", auditEmpty: "暂无记录。", explorer: "浏览器",
				st_pending: "待确认", st_success: "成功", st_reverted: "失败", st_rejected: "被拒绝", st_replaced: "已替换", st_unknown: "未知", "st_broadcast-uncertain": "待查证",
				// transaction security
				checksSection: "交易安全检查", checksDesc: "每笔转账、授权和签名在签名前都会自动检查。严重风险会被直接拒绝（审批也无法放行），高风险必须由你确认。",
				chkSimulation: "交易模拟", chkSimulationHint: "签名前在链上模拟，核对实际资产变化与请求是否一致，并识别收款后立即转走资金的地址。",
				chkSanctions: "链上制裁名单", chkSanctionsHint: "查询 Chainalysis 链上制裁预言机（以太坊、Arbitrum、OP、Polygon、BSC、Avalanche）。",
				chkOfac: "OFAC 制裁地址库", chkScam: "ScamSniffer 诈骗地址库", feedCount: "{n} 个地址", feedUpdated: "更新于 {t}", feedNever: "尚未下载", feedError: "上次更新失败：{e}",
				chkGoplus: "GoPlus 地址与代币信誉", chkGoplusHint: "开启后会把收款方 / 授权对象的地址，以及模拟中你将收到的代币地址发送给 GoPlus 查询（不发送你的地址和金额）。",
				onUnavailable: "检查无法完成时", onUnavailableHint: "例如网络故障或第三方服务超时。", unavailWarn: "仅提示", unavailAsk: "需要确认", unavailDeny: "拒绝",
				refreshFeeds: "立即更新", checksSaved: "安全检查设置已保存", feedsRefreshed: "地址库已更新",
				denySection: "黑名单", denyDesc: "向这些地址转账或授权会被直接拒绝。Agent 可以添加，移除需要你输入 PIN。", denyEmpty: "黑名单为空。",
				denyAdd: "添加地址", denyAddDesc: "之后向该地址的转账、授权和签名都会被拒绝。", denyLabel: "原因（可选）", denyAdded: "已加入黑名单", denyRemoved: "已从黑名单移除",
				// pin step-up
				stepUpTitle: "输入 PIN 确认", stepUpText: "此操作会降低安全保护或涉及密钥，需要验证 PIN。",
				stepUpSetupText: "此操作需要 PIN 保护，请先在「安全」中设置 PIN。", goSetPin: "去设置",
				pinWrong: "PIN 不正确", pinLockedNow: "输错次数过多，今天已锁定",
			},
			en: {
				nav: "Web3 wallet",
				tabAssets: "Assets", tabAccounts: "Accounts", tabSecurity: "Security", tabLimits: "Limits", tabActivity: "Activity", tabsLabel: "Wallet settings",
				loading: "Loading wallet…", loadFailed: "The wallet plugin is not responding", retry: "Retry", refresh: "Refresh",
				cancel: "Cancel", confirm: "Confirm", save: "Save", saving: "Saving…", saved: "Saved", done: "Done", back: "Back", close: "Close", edit: "Edit", remove: "Remove", add: "Add",
				copy: "Copy", copied: "Copied", optional: "(optional)", more: "More",
				welcomeTitle: "Set up your Web3 wallet",
				welcomeText: "Keys stay encrypted on this machine. The agent can look things up and start transactions, but every one is bound by your security mode, limits, and approvals.",
				createWallet: "Create a new wallet", importWallet: "Import a wallet",
				bannerLocked: "You locked the wallet; nothing is signed until you unlock it.", unlock: "Unlock", lock: "Lock",
				bannerNoPin: "No PIN yet. You need one to view recovery phrases, export, remove accounts, or loosen limits.", setPin: "Set PIN",
				bannerBackup: "Some accounts are not backed up. Losing this device would lose their funds.", backupNow: "Back up",
				bannerPinToday: "PIN not verified today; agent-started signing will ask for it first.", verifyPin: "Verify PIN",
				account: "Account", network: "Network", address: "Receiving address", balances: "Assets", hideZero: "Hide zero balances",
				balanceLoading: "Reading on-chain balances…", balanceFailed: "Could not read balances", noTokens: "No balances on this network",
				testnet: "testnet", recentTx: "Recent transactions", viewAll: "View all",
				accountsTitle: "Accounts", accountsDesc: "One recovery phrase can derive many addresses; imported accounts are encrypted separately.",
				notBackedUp: "Not backed up", hd: "Recovery phrase", imported: "Imported",
				rename: "Rename", backup: "Back up", exportKeystore: "Export keystore", removeAccount: "Remove account",
				renameTitle: "Rename account", labelPlaceholder: "e.g. Daily, Trading",
				createTitle: "Create a new wallet", createDesc: "Generates a new recovery phrase. You will write it down in the next step.",
				accountLabel: "Account name", words: "Phrase length", wordsN: "{n} words", createBtn: "Create",
				createdTitle: "Write down your recovery phrase", createdDesc: "Copy it on paper, in order, and keep it offline. Anyone with it can take every asset; DSH and the agent will never ask for it.",
				createdCheck: "I have written it down and stored it safely", createFailed: "Could not create the wallet",
				importTitle: "Import a wallet", importDesc: "Secrets are encrypted on this machine and never pass through the chat or the model.",
				srcMnemonic: "Recovery phrase", srcPrivateKey: "Private key", srcKeystore: "Keystore file",
				mnemonicPlaceholder: "12–24 words separated by spaces", privateKeyPlaceholder: "64 hex characters, 0x-prefixed", keystorePlaceholder: "Paste the keystore JSON",
				keystorePassword: "Keystore password", derivationIndex: "Derivation index", importBtn: "Import", importFailed: "Import failed", importEmpty: "Enter what to import",
				backupTitle: "Back up account", backupDesc: "Secrets are shown only on this page and never enter the chat. Make sure nobody is watching and no screen is shared.",
				revealMnemonic: "Show recovery phrase", revealPrivateKey: "Show private key", noMnemonic: "This account was imported from a private key and has no recovery phrase.",
				riskRevealTitle: "Show the private key?", riskRevealText: "A private key controls every asset in the account. View it only offline and in private; never screenshot or share it.", riskAck: "I understand the risk",
				exportTitle: "Export keystore", exportDesc: "Encrypts the account with a password you choose and downloads it as JSON (works with MetaMask and others).", exportPassword: "Keystore password (8+ characters)", exportConfirm: "Repeat the password", exportBtn: "Export and download", passwordMismatch: "The passwords do not match", passwordShort: "Use at least 8 characters", exported: "Keystore downloaded",
				riskRemoveTitle: "Remove this account?", riskRemoveText: "Its encrypted key will be deleted from this machine. Without a backup the funds are lost for good.", riskRemoveUnbacked: "⚠ This account is not backed up!",
				removed: "Account removed",
				vaultSection: "Wallet", vaultState: "Vault", unlocked: "Unlocked", locked: "Locked",
				vaultHint: "Locking wipes decrypted keys from memory.", autoLock: "Auto-lock", autoLockValue: "After {n} min idle", configHint: "Change it in the plugin config",
				dataDir: "Data directory", keySource: "Passphrase source", keySourceAuto: "System credentials (automatic)", keySourceKeychain: "macOS Keychain (automatic)", keySourceEnv: "Environment variable", keySourceManual: "Manual",
				authSection: "Verification", authDesc: "One PIN entry covers agent-started signing for the chosen period (1, 7 or 30 days); viewing secrets, exporting, removing, and loosening limits ask for it every time.",
				pin: "PIN", pinOff: "Not set", pinAuthorized: "Authorized", pinUntil: "Authorized until {t}", pinNotToday: "Not authorized", pinGrant: "Authorization length", pinGrantHint: "One PIN entry covers signing for this long. Lengthening needs the PIN; shortening applies at once.", grant1: "1 day", grant7: "7 days", grant30: "30 days", pinGrantSaved: "Authorization length updated", pinLocked: "Too many attempts; locked until tomorrow",
				pinSetup: "Set PIN", pinChange: "Change PIN", pinVerify: "Verify", pinRevoke: "Revoke authorization",
				pinSetupTitle: "Set a PIN", pinChangeTitle: "Change PIN", pinVerifyTitle: "Verify PIN",
				pinNew: "New PIN (4–12 characters)", pinRepeat: "Repeat it", pinCurrent: "Current PIN", pinTooShort: "Use 4–12 characters", pinMismatch: "The entries do not match",
				agentSection: "Agent permissions", agentDesc: "The agent acts only through wallet tools; nothing said in a chat can change these rules.",
				agentSecrets: "Secrets never enter the chat", agentSecretsHint: "Recovery phrases, private keys, and the PIN are never returned to the model or written to session logs.",
				agentSecretsOff: "Off (unsafe)", agentOn: "On",
				agentLoosen: "The agent can only tighten security", agentLoosenHint: "Loosening the security mode, raising limits, and whitelisting happen only here, confirmed with your PIN.",
				agentApproval: "Human approval per transaction", agentApprovalHint: "Limits → Security mode decides which operations need your confirmation.",
				presetSection: "Security mode", presetDesc: "Decides what can be signed automatically and what needs your confirmation.",
				"preset_agent-semi": "Semi-managed (recommended)", "preset_agent-semiDesc": "The agent signs on its own within the automatic budget; anything above it is not signed and is reported to you, to run once you raise the budget or switch modes; anything above the hard limits is refused. Critical risks are refused; high risks and unlimited approvals ask.",
				"preset_agent-full": "Fully managed", "preset_agent-fullDesc": "The agent signs on its own up to the hard limits, with no automatic budget; anything above them is refused. Critical risks are refused; high risks and unlimited approvals ask.",
				preset_strict: "Strict", preset_strictDesc: "Every signature waits for your approval.",
				preset_micropay: "Micropayments", preset_micropayDesc: "Strict, plus small x402 USDC payments (≤1 each, ≤10 a day) go through automatically; a new merchant's first payment still asks.",
				preset_testnet: "Testnet autonomy", preset_testnetDesc: "Small testnet operations sign automatically; mainnet still asks every time.",
				preset_power: "Power", preset_powerDesc: "Small mainnet native transfers (≤0.01 each, ≤0.05 a day) sign automatically; tokens and approvals still ask.",
				preset_locked: "Locked", preset_lockedDesc: "Refuses every signature; read-only.",
				preset_custom: "Custom policy", preset_customDesc: "The current policy has {n} custom rules. Picking a preset replaces them.",
				presetChanged: "Security mode changed",
				whitelistSection: "Transfer whitelist", whitelistDesc: "When on, transfers and x402 payments may only go to whitelisted contacts or your own accounts. Contract interactions still follow the security mode.",
				whitelistOnly: "Only send to the whitelist", whitelistEmpty: "No contacts yet.", trusted: "Whitelisted",
				contactLabel: "Name", contactAddress: "Full 0x address", contactNote: "Note", contactAdd: "Add contact", contactAddDesc: "Saved contacts can be named in transfer requests. Whitelisting asks for your PIN.", contactTrusted: "Add to whitelist", contactSaved: "Contact saved",
				capsSection: "Spending limits", capsDesc: "Hard limits: anything over them is refused, even if you click approve. Leave blank for no limit.",
				usdPerTx: "Stablecoins · per transfer", usdPerDay: "Stablecoins · per day", usdHint: "USDC / USDT / DAI count as $1, summed across chains.",
				nativePerTx: "{s} · per transfer", nativePerDay: "{s} · per day", nativeHint: "Covers every network whose native coin is {s}.",
				usedToday: "Used today: {v}", includeTestnets: "Apply on testnets too", capsSaved: "Limits saved", unlimited: "No limit",
				autoSection: "Automatic budget", autoDesc: "In semi-managed mode the agent signs on its own within this budget; anything above it but within the hard limits is not signed and the agent tells you, so you can raise the budget and run it again. Leave blank for no automatic budget on that item (only the hard limits apply); enter 0 to never sign that item automatically.", autoInactive: "The current security mode does not use the automatic budget; it applies once you switch to semi-managed.", autoSaved: "Automatic budget saved",
				advanced: "Policy rules", advancedShow: "Show {n} rules", advancedHide: "Hide",
				activityTx: "Transactions", activityAudit: "Audit log", txEmpty: "This wallet has not sent any transactions.", auditEmpty: "Nothing yet.", explorer: "Explorer",
				st_pending: "Pending", st_success: "Success", st_reverted: "Failed", st_rejected: "Rejected", st_replaced: "Replaced", st_unknown: "Unknown", "st_broadcast-uncertain": "Unconfirmed",
				checksSection: "Transaction security checks", checksDesc: "Every transfer, approval, and signature is checked before signing. Critical risks are refused (even an approval cannot pass them); high risks always need your confirmation.",
				chkSimulation: "Transaction simulation", chkSimulationHint: "Simulates on-chain before signing, checks the real asset changes match the request, and spots recipients that immediately forward funds.",
				chkSanctions: "On-chain sanctions list", chkSanctionsHint: "Queries the Chainalysis sanctions oracle (Ethereum, Arbitrum, OP, Polygon, BSC, Avalanche).",
				chkOfac: "OFAC sanctioned addresses", chkScam: "ScamSniffer scam addresses", feedCount: "{n} addresses", feedUpdated: "updated {t}", feedNever: "not downloaded yet", feedError: "last update failed: {e}",
				chkGoplus: "GoPlus address & token reputation", chkGoplusHint: "Sends recipient / spender addresses, and the tokens a simulation says you would receive, to GoPlus (never your address or amounts).",
				onUnavailable: "When a check cannot finish", onUnavailableHint: "E.g. a network error or a third-party timeout.", unavailWarn: "Warn", unavailAsk: "Ask me", unavailDeny: "Refuse",
				refreshFeeds: "Update now", checksSaved: "Security checks saved", feedsRefreshed: "Address lists updated",
				denySection: "Denylist", denyDesc: "Transfers and approvals to these addresses are refused. The agent can add entries; removing one needs your PIN.", denyEmpty: "The denylist is empty.",
				denyAdd: "Add address", denyAddDesc: "Transfers, approvals, and signatures involving this address will be refused.", denyLabel: "Reason (optional)", denyAdded: "Added to the denylist", denyRemoved: "Removed from the denylist",
				stepUpTitle: "Confirm with your PIN", stepUpText: "This weakens a protection or touches key material, so your PIN is required.",
				stepUpSetupText: "This needs PIN protection. Set a PIN under Security first.", goSetPin: "Set PIN",
				pinWrong: "Incorrect PIN", pinLockedNow: "Too many attempts; locked for today",
			},
		};

		let localeSvc = null;
		let connectionSvc = null;
		let t = (key) => (MESSAGES.en[key] !== undefined ? MESSAGES.en[key] : key);
		function fmt(text, vars) {
			return String(text).replace(/\{(\w+)\}/g, (_, name) => (vars && vars[name] !== undefined ? String(vars[name]) : ""));
		}
		function useLocaleVersion() {
			return React.useSyncExternalStore(
				React.useCallback((onChange) => (localeSvc && typeof localeSvc.subscribe === "function" ? localeSvc.subscribe(onChange) : () => {}), []),
				React.useCallback(() => {
					const snapshot = localeSvc && typeof localeSvc.getSnapshot === "function" ? localeSvc.getSnapshot() : null;
					return snapshot && typeof snapshot.revision === "number" ? snapshot.revision : 0;
				}, []),
			);
		}

		// ── host calls (Typert Remote `web3/*` over the Connection RPC carrier) ──
		class ApiError extends Error {
			constructor(message, code) {
				super(message);
				this.code = code;
			}
		}
		async function api(method, request) {
			if (connectionSvc === null) throw new ApiError("connection not ready");
			const envelope = await connectionSvc.rpc.call("/api", "web3/" + method, { args: { request: request === undefined ? null : request } });
			let value = envelope;
			if (envelope !== null && typeof envelope === "object" && envelope.ok === false && envelope.error !== undefined && typeof envelope.error === "object") {
				throw new ApiError(envelope.error.message || "request failed");
			}
			if (envelope !== null && typeof envelope === "object" && envelope.ok === true && "value" in envelope) value = envelope.value;
			if (value !== null && typeof value === "object" && value.ok === false) throw new ApiError(value.error || "request failed", value.code);
			return value;
		}

		// ── formatting ─────────────────────────────────────────────────────
		function shortAddress(address) {
			const text = String(address || "");
			return text.length > 14 ? text.slice(0, 6) + "…" + text.slice(-4) : text;
		}
		function trimAmount(value) {
			const text = String(value === undefined || value === null ? "0" : value);
			if (!text.includes(".")) return text;
			const [whole, fraction] = text.split(".");
			const kept = fraction.slice(0, 6).replace(/0+$/, "");
			return kept.length > 0 ? whole + "." + kept : whole;
		}
		function avatarStyle(address) {
			const hex = String(address || "0x0").slice(2, 14).padEnd(12, "0");
			const a = parseInt(hex.slice(0, 4), 16) % 360;
			const b = (a + 40 + (parseInt(hex.slice(4, 8), 16) % 120)) % 360;
			return { background: "linear-gradient(135deg, hsl(" + a + " 65% 58%), hsl(" + b + " 70% 45%))" };
		}
		function when(ts) {
			try {
				return new Date(ts).toLocaleString();
			} catch (e) {
				return String(ts);
			}
		}
		function downloadText(filename, text) {
			const blob = new Blob([text], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const link = document.createElement("a");
			link.href = url;
			link.download = filename;
			document.body.appendChild(link);
			link.click();
			link.remove();
			setTimeout(() => URL.revokeObjectURL(url), 1000);
		}

		// ── layout pieces (mirror DSH settings rows) ───────────────────────
		function Section(props) {
			return h("section", { className: "dshw-section" },
				props.title ? h("div", { className: "dshw-sectionHead" },
					h("div", null,
						h("h3", { className: "dshw-sectionTitle" }, props.title),
						props.desc ? h("p", { className: "dshw-sectionDesc" }, props.desc) : null,
					),
					props.actions ? h("div", { className: "dshw-actions" }, props.actions) : null,
				) : null,
				h("div", null, props.children),
			);
		}
		function Row(props) {
			return h("div", { className: "dshw-row" },
				props.leading || null,
				h("div", { className: "dshw-rowMain" },
					h("div", { className: "dshw-rowLabel" }, props.label),
					props.hint ? h("div", { className: "dshw-rowHint" }, props.hint) : null,
				),
				props.children ? h("div", { className: "dshw-rowControl" }, props.children) : null,
			);
		}
		function Banner(props) {
			return h("div", { className: "dshw-banner" + (props.info ? " dshw-bannerInfo" : "") },
				h("div", null, props.text),
				props.action ? h("div", { className: "dshw-rowControl" }, props.action) : null,
			);
		}
		function Notice(props) {
			if (!props.message) return null;
			return h("div", { className: props.message.ok ? "dshw-ok" : "dshw-error", role: "status" }, props.message.text);
		}
		function CopyButton(props) {
			const [copied, setCopied] = React.useState(false);
			return h(Btn, {
				variant: "ghost",
				onClick: () => copyText(props.text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }).catch(() => {}),
			}, copied ? t("copied") : t("copy"));
		}

		// ── PIN step-up: one dialog, shown only when the server asks for it ──
		const StepUpContext = React.createContext(null);

		function useStepUp() {
			return React.useContext(StepUpContext);
		}

		function StepUpProvider(props) {
			const [request, setRequest] = React.useState(null);
			const [pin, setPin] = React.useState("");
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);

			const run = React.useCallback(async (call) => {
				try {
					return await call(undefined);
				} catch (e) {
					if (!(e instanceof ApiError) || (e.code !== "PIN_REQUIRED" && e.code !== "PIN_SETUP_REQUIRED")) throw e;
					return await new Promise((resolve, reject) => {
						setPin("");
						setError(null);
						setRequest({ call, resolve, reject, setup: e.code === "PIN_SETUP_REQUIRED" });
					});
				}
			}, []);

			const cancel = () => {
				if (request) request.reject(Object.assign(new Error("cancelled"), { cancelled: true }));
				setRequest(null);
			};
			const submit = async () => {
				if (!request || pin.length < 4) return;
				setBusy(true);
				setError(null);
				try {
					const value = await request.call(pin);
					setRequest(null);
					request.resolve(value);
				} catch (e) {
					if (e instanceof ApiError && e.code === "PIN_INVALID") setError(t("pinWrong"));
					else if (e instanceof ApiError && e.code === "PIN_LOCKED") {
						setRequest(null);
						request.reject(new ApiError(t("pinLockedNow"), "PIN_LOCKED"));
					} else {
						setRequest(null);
						request.reject(e);
					}
				} finally {
					setPin("");
					setBusy(false);
				}
			};

			const dialog = request === null ? null : request.setup
				? h(Dialog, {
					open: true, onClose: cancel, title: t("stepUpTitle"), closeLabel: t("close"), description: t("stepUpSetupText"),
					footer: [
						h(Btn, { key: "c", variant: "ghost", onClick: cancel }, t("cancel")),
						h(Btn, { key: "g", variant: "primary", onClick: () => { cancel(); props.onGoSecurity(); } }, t("goSetPin")),
					],
				})
				: h(Dialog, {
					open: true, onClose: cancel, title: t("stepUpTitle"), closeLabel: t("close"), description: t("stepUpText"),
					footer: [
						h(Btn, { key: "c", variant: "ghost", onClick: cancel }, t("cancel")),
						h(Btn, { key: "s", variant: "primary", disabled: busy || pin.length < 4, onClick: () => void submit() }, busy ? "…" : t("confirm")),
					],
				},
				h("div", { className: "dshw-field" },
					h(TextInput, { type: "password", value: pin, onChange: setPin, onEnter: () => void submit(), autoFocus: true, label: t("pin"), placeholder: t("pin"), inputMode: "numeric", autoComplete: "one-time-code" }),
					error ? h("div", { className: "dshw-error" }, error) : null,
				));

			return h(StepUpContext.Provider, { value: run }, props.children, dialog);
		}

		/** Run an action, surfacing success/failure as a message (cancelled step-ups are silent). */
		function useAction(onSuccess) {
			const [busy, setBusy] = React.useState(false);
			const [message, setMessage] = React.useState(null);
			const act = React.useCallback(async (fn, okText) => {
				setBusy(true);
				setMessage(null);
				try {
					const value = await fn();
					if (okText) setMessage({ ok: true, text: okText });
					if (onSuccess) onSuccess(value);
					return value;
				} catch (e) {
					if (!(e && e.cancelled)) setMessage({ ok: false, text: (e && e.message) || String(e) });
					return undefined;
				} finally {
					setBusy(false);
				}
			}, [onSuccess]);
			return { busy, message, setMessage, act };
		}

		// ── data ───────────────────────────────────────────────────────────
		function useOverview() {
			const [state, setState] = React.useState({ loading: true, error: null, data: null });
			const load = React.useCallback(async () => {
				try {
					const data = await api("overview");
					setState({ loading: false, error: null, data });
				} catch (e) {
					setState((prev) => ({ loading: false, error: (e && e.message) || String(e), data: prev.data }));
				}
			}, []);
			React.useEffect(() => { void load(); }, [load]);
			return { state, reload: load };
		}

		// ── banners ────────────────────────────────────────────────────────
		function Banners(props) {
			const data = props.data;
			const items = [];
			const unbacked = data.accounts.some((a) => a.mnemonicId !== undefined && a.backedUp !== true);
			if (!data.status.unlocked && data.status.lockedByUser) {
				items.push(h(Banner, { key: "lock", text: t("bannerLocked"), action: h(Btn, { variant: "primary", disabled: props.busy, onClick: props.onUnlock }, t("unlock")) }));
			}
			if (!data.pin.enabled) {
				items.push(h(Banner, { key: "pin", text: t("bannerNoPin"), action: h(Btn, { variant: "outline", onClick: () => props.go("security") }, t("setPin")) }));
			} else if (unbacked) {
				items.push(h(Banner, { key: "bk", text: t("bannerBackup"), action: h(Btn, { variant: "outline", onClick: () => props.go("accounts") }, t("backupNow")) }));
			}
			return items.length === 0 ? null : h("div", { className: "dshw", style: { gap: "8px" } }, items);
		}

		// ── Assets ─────────────────────────────────────────────────────────
		function AssetsTab(props) {
			const data = props.data;
			const accounts = data.accounts;
			const [accountId, setAccountId] = React.useState(accounts[0] ? accounts[0].id : "");
			const [chains, setChains] = React.useState([]);
			const [chainId, setChainId] = React.useState(8453);
			const [hideZero, setHideZero] = React.useState(true);
			const [balances, setBalances] = React.useState({ loading: false, error: null, value: null });
			const [history, setHistory] = React.useState([]);
			const account = accounts.find((a) => a.id === accountId) || accounts[0];

			React.useEffect(() => {
				api("chains").then((r) => setChains((r && r.chains) || [])).catch(() => setChains([]));
			}, []);
			React.useEffect(() => {
				if (!accounts.some((a) => a.id === accountId) && accounts[0]) setAccountId(accounts[0].id);
			}, [accounts, accountId]);
			const loadBalances = React.useCallback(async () => {
				if (!account) return;
				setBalances({ loading: true, error: null, value: null });
				try {
					const value = await api("balances", { chainId: Number(chainId), address: account.address });
					setBalances({ loading: false, error: null, value });
				} catch (e) {
					setBalances({ loading: false, error: (e && e.message) || String(e), value: null });
				}
			}, [account && account.address, chainId]);
			React.useEffect(() => { void loadBalances(); }, [loadBalances]);
			React.useEffect(() => {
				if (!account) return;
				api("history", { account: account.id, limit: 5 }).then((r) => setHistory((r && r.transactions) || [])).catch(() => setHistory([]));
			}, [account && account.id]);

			if (!account) return null;
			const value = balances.value;
			const rows = value ? [{ symbol: value.native.symbol, formatted: value.native.formatted, native: true }].concat(
				value.tokens.map((token) => ({ symbol: token.symbol || shortAddress(token.address), formatted: token.formatted !== undefined ? token.formatted : token.balance, address: token.address })),
			) : [];
			const visible = hideZero ? rows.filter((row) => row.native || Number(row.formatted) !== 0) : rows;
			const mainnets = chains.filter((c) => !c.testnet);
			const testnets = chains.filter((c) => c.testnet);

			return h("div", { className: "dshw" },
				h("div", { className: "dshw-picker" },
					h("select", { className: "dshw-select", value: account.id, "aria-label": t("account"), onChange: (e) => setAccountId(e.target.value) },
						accounts.map((a) => h("option", { key: a.id, value: a.id }, a.label + " · " + shortAddress(a.address)))),
					h("select", { className: "dshw-select", value: String(chainId), "aria-label": t("network"), onChange: (e) => setChainId(Number(e.target.value)) },
						chains.length === 0 ? h("option", { value: String(chainId) }, String(chainId)) : null,
						mainnets.length > 0 ? h("optgroup", { label: "Mainnet" }, mainnets.map((c) => h("option", { key: c.chainId, value: String(c.chainId) }, c.name))) : null,
						testnets.length > 0 ? h("optgroup", { label: t("testnet") }, testnets.map((c) => h("option", { key: c.chainId, value: String(c.chainId) }, c.name))) : null,
					),
					h(Btn, { variant: "ghost", onClick: () => void loadBalances(), disabled: balances.loading }, t("refresh")),
				),
				h(Section, { title: t("address") },
					h("div", { className: "dshw-row" },
						h("div", { className: "dshw-avatar", style: avatarStyle(account.address), "aria-hidden": "true" }),
						h("div", { className: "dshw-rowMain" },
							h("div", { className: "dshw-rowLabel" }, account.label, account.backedUp !== true && account.mnemonicId !== undefined ? h(Badge, { tone: "warning" }, t("notBackedUp")) : null),
							h("div", { className: "dshw-mono" }, account.address),
						),
						h("div", { className: "dshw-rowControl" }, h(CopyButton, { text: account.address })),
					),
				),
				h(Section, {
					title: t("balances"),
					actions: h(Check, { checked: hideZero, onChange: setHideZero, label: t("hideZero") }),
				},
				balances.loading ? h("div", { className: "dshw-empty" }, t("balanceLoading"))
					: balances.error ? h("div", { className: "dshw-empty" }, h("span", { className: "dshw-error" }, t("balanceFailed") + ": " + balances.error))
						: visible.length === 0 ? h("div", { className: "dshw-empty" }, t("noTokens"))
							: visible.map((row) => h("div", { className: "dshw-row", key: row.symbol + (row.address || "") },
								h("div", { className: "dshw-rowMain" },
									h("div", { className: "dshw-rowLabel" }, row.symbol),
									row.address ? h("div", { className: "dshw-rowHint dshw-mono" }, shortAddress(row.address)) : h("div", { className: "dshw-rowHint" }, value.chainName || ""),
								),
								h("div", { className: "dshw-rowControl dshw-amount" }, trimAmount(row.formatted)),
							)),
				),
				h(Section, {
					title: t("recentTx"),
					actions: history.length > 0 ? h("button", { className: "dshw-plain", type: "button", onClick: () => props.go("activity") }, t("viewAll")) : null,
				}, history.length === 0 ? h("div", { className: "dshw-empty" }, t("txEmpty")) : history.map((tx) => h(TxRow, { key: tx.hash, tx }))),
			);
		}

		function statusTone(status) {
			if (status === "success") return "success";
			if (status === "reverted" || status === "rejected") return "danger";
			if (status === "replaced") return "neutral";
			return "warning";
		}

		function TxRow(props) {
			const tx = props.tx;
			const label = t("st_" + tx.status);
			return h("div", { className: "dshw-row" },
				h("div", { className: "dshw-rowMain" },
					h("div", { className: "dshw-rowLabel" }, tx.summary || shortAddress(tx.hash)),
					h("div", { className: "dshw-rowHint" }, when(tx.submittedAt) + " · ", h("span", { className: "dshw-mono", title: tx.hash }, shortAddress(tx.hash))),
				),
				h("div", { className: "dshw-rowControl" },
					tx.explorerUrl ? h("a", { className: "dshw-link", href: tx.explorerUrl, target: "_blank", rel: "noreferrer" }, t("explorer")) : null,
					h(Badge, { tone: statusTone(tx.status) }, label === "st_" + tx.status ? String(tx.status) : label),
				),
			);
		}

		// ── Accounts ───────────────────────────────────────────────────────
		function AccountsTab(props) {
			const data = props.data;
			const stepUp = useStepUp();
			const { busy, message, act } = useAction(props.reload);
			const [renaming, setRenaming] = React.useState(null);
			const [label, setLabel] = React.useState("");
			const [removing, setRemoving] = React.useState(null);
			const [ack, setAck] = React.useState(false);

			const saveRename = () => {
				const target = renaming;
				setRenaming(null);
				void act(() => api("accountRename", { account: target.id, label }), t("saved"));
			};
			const confirmRemove = () => {
				const target = removing;
				setRemoving(null);
				setAck(false);
				void act(() => stepUp((pin) => api("accountRemove", { account: target.id, pin })), t("removed"));
			};

			return h("div", { className: "dshw" },
				h(Section, {
					title: t("accountsTitle"),
					desc: t("accountsDesc"),
					actions: [
						h(Btn, { key: "i", variant: "outline", onClick: props.onImport }, t("importWallet")),
						h(Btn, { key: "c", variant: "primary", onClick: props.onCreate }, t("createWallet")),
					],
				},
				h(Notice, { message }),
				data.accounts.map((a) => h("div", { className: "dshw-row", key: a.id },
					h("div", { className: "dshw-avatar", style: avatarStyle(a.address), "aria-hidden": "true" }),
					h("div", { className: "dshw-rowMain" },
						h("div", { className: "dshw-rowLabel" },
							a.label,
							h(Badge, { tone: "quiet" }, a.mnemonicId !== undefined ? t("hd") : t("imported")),
							a.mnemonicId !== undefined && a.backedUp !== true ? h(Badge, { tone: "warning" }, t("notBackedUp")) : null,
						),
						h("div", { className: "dshw-rowHint dshw-mono", title: a.address }, shortAddress(a.address)),
					),
					h("div", { className: "dshw-rowControl" },
						h(CopyButton, { text: a.address }),
						h(Btn, { variant: a.backedUp !== true && a.mnemonicId !== undefined ? "primary" : "ghost", onClick: () => props.onBackup(a) }, t("backup")),
						h(MoreMenu, {
							items: [
								{ id: "rename", label: t("rename"), onSelect: () => { setRenaming(a); setLabel(a.label); } },
								{ id: "export", label: t("exportKeystore"), onSelect: () => props.onExport(a) },
								{ id: "remove", label: t("removeAccount"), danger: true, disabled: busy, onSelect: () => { setAck(false); setRemoving(a); } },
							],
						}),
					),
				))),
				h(Dialog, {
					open: renaming !== null, onClose: () => setRenaming(null), title: t("renameTitle"), closeLabel: t("close"),
					footer: [
						h(Btn, { key: "c", variant: "ghost", onClick: () => setRenaming(null) }, t("cancel")),
						h(Btn, { key: "s", variant: "primary", disabled: label.trim().length === 0, onClick: saveRename }, t("save")),
					],
				}, h(TextInput, { value: label, onChange: setLabel, onEnter: saveRename, autoFocus: true, label: t("accountLabel"), placeholder: t("labelPlaceholder"), className: "dshw-fullInput" })),
				removing === null ? null : has("RiskConfirmation")
					? h(P.RiskConfirmation, {
						open: true,
						title: t("riskRemoveTitle"),
						description: (removing.mnemonicId !== undefined && removing.backedUp !== true ? t("riskRemoveUnbacked") + " " : "") + t("riskRemoveText") + " " + removing.label + " · " + removing.address,
						acknowledgeLabel: t("riskAck"), cancelLabel: t("cancel"), closeLabel: t("close"), confirmLabel: t("removeAccount"),
						acknowledged: ack, onAcknowledgedChange: setAck, onCancel: () => setRemoving(null), onConfirm: confirmRemove,
					})
					: h(Dialog, {
						open: true, onClose: () => setRemoving(null), title: t("riskRemoveTitle"), closeLabel: t("close"), description: t("riskRemoveText"),
						footer: [h(Btn, { key: "c", variant: "ghost", onClick: () => setRemoving(null) }, t("cancel")), h(Btn, { key: "r", variant: "primary", disabled: !ack, onClick: confirmRemove }, t("removeAccount"))],
					}, h(Check, { checked: ack, onChange: setAck, label: t("riskAck") })),
			);
		}

		function FlowShell(props) {
			return h("div", { className: "dshw" },
				h("div", { className: "dshw-actions" }, h(Btn, { variant: "ghost", onClick: props.onBack }, "← " + t("back"))),
				h(Section, { title: props.title, desc: props.desc }, props.children),
			);
		}

		function WordGrid(props) {
			return h("div", { className: "dshw-words" }, props.words.map((word, index) =>
				h("div", { className: "dshw-word", key: index }, h("span", { className: "dshw-wordIndex" }, String(index + 1)), h("span", null, word))));
		}

		function CreateFlow(props) {
			const [label, setLabel] = React.useState("");
			const [words, setWords] = React.useState("12");
			const [phrase, setPhrase] = React.useState(null);
			const [saved, setSaved] = React.useState(false);
			const { busy, message, act } = useAction();
			React.useEffect(() => () => setPhrase(null), []);
			const create = () => act(async () => {
				const result = await api("create", { label: label.trim() || undefined, words: Number(words), reveal: true });
				if (!result || typeof result.mnemonic !== "string") throw new Error(t("createFailed"));
				setPhrase(result.mnemonic.split(" "));
			});
			if (phrase !== null) {
				return h(FlowShell, { title: t("createdTitle"), desc: t("createdDesc"), onBack: props.onDone },
					h(WordGrid, { words: phrase }),
					h("div", { className: "dshw-row" }, h(Check, { checked: saved, onChange: setSaved, label: t("createdCheck") })),
					h("div", { className: "dshw-actions dshw-actionsEnd" }, h(Btn, { variant: "primary", disabled: !saved, onClick: () => { setPhrase(null); props.onDone(); } }, t("done"))),
				);
			}
			return h(FlowShell, { title: t("createTitle"), desc: t("createDesc"), onBack: props.onBack },
				h("div", { className: "dshw-field", style: { marginTop: "12px" } },
					h("label", { className: "dshw-fieldLabel" }, t("accountLabel") + " " + t("optional")),
					h(TextInput, { value: label, onChange: setLabel, placeholder: t("labelPlaceholder"), className: "dshw-fullInput", label: t("accountLabel") }),
				),
				h("div", { className: "dshw-field" },
					h("label", { className: "dshw-fieldLabel" }, t("words")),
					h(Segments, { id: "dshw-words", value: words, onChange: setWords, label: t("words"), options: ["12", "24"].map((n) => ({ value: n, label: fmt(t("wordsN"), { n }) })) }),
				),
				h(Notice, { message }),
				h("div", { className: "dshw-actions dshw-actionsEnd" }, h(Btn, { variant: "primary", disabled: busy, onClick: () => void create() }, busy ? "…" : t("createBtn"))),
			);
		}

		function ImportFlow(props) {
			const [source, setSource] = React.useState("mnemonic");
			const [secret, setSecret] = React.useState("");
			const [password, setPassword] = React.useState("");
			const [label, setLabel] = React.useState("");
			const { busy, message, setMessage, act } = useAction();
			React.useEffect(() => () => { setSecret(""); setPassword(""); }, []);
			const submit = () => {
				if (secret.trim().length === 0) return setMessage({ ok: false, text: t("importEmpty") });
				void act(async () => {
					await api("import", { source, secret: secret.trim(), keystorePassphrase: source === "keystore" ? password : undefined, label: label.trim() || undefined });
					setSecret("");
					setPassword("");
					props.onDone();
				});
			};
			const placeholder = source === "mnemonic" ? t("mnemonicPlaceholder") : source === "privateKey" ? t("privateKeyPlaceholder") : t("keystorePlaceholder");
			return h(FlowShell, { title: t("importTitle"), desc: t("importDesc"), onBack: props.onBack },
				h("div", { className: "dshw-field", style: { marginTop: "12px" } },
					h(Segments, {
						id: "dshw-import-source", value: source, onChange: (v) => { setSource(v); setSecret(""); }, label: t("importTitle"),
						options: [{ value: "mnemonic", label: t("srcMnemonic") }, { value: "privateKey", label: t("srcPrivateKey") }, { value: "keystore", label: t("srcKeystore") }],
					}),
				),
				h("div", { className: "dshw-field" },
					h("textarea", { className: "dshw-textarea", value: secret, placeholder, spellCheck: false, autoComplete: "off", onChange: (e) => setSecret(e.target.value), "aria-label": placeholder }),
				),
				source === "keystore" ? h("div", { className: "dshw-field" },
					h("label", { className: "dshw-fieldLabel" }, t("keystorePassword")),
					h(TextInput, { type: "password", value: password, onChange: setPassword, className: "dshw-fullInput", label: t("keystorePassword") }),
				) : null,
				h("div", { className: "dshw-field" },
					h("label", { className: "dshw-fieldLabel" }, t("accountLabel") + " " + t("optional")),
					h(TextInput, { value: label, onChange: setLabel, placeholder: t("labelPlaceholder"), className: "dshw-fullInput", label: t("accountLabel") }),
				),
				h(Notice, { message }),
				h("div", { className: "dshw-actions dshw-actionsEnd" }, h(Btn, { variant: "primary", disabled: busy, onClick: submit }, busy ? "…" : t("importBtn"))),
			);
		}

		function BackupFlow(props) {
			const account = props.account;
			const stepUp = useStepUp();
			const hasMnemonic = account.mnemonicId !== undefined;
			const [secret, setSecret] = React.useState(null);
			const [risk, setRisk] = React.useState(false);
			const [ack, setAck] = React.useState(false);
			const { busy, message, act } = useAction();
			React.useEffect(() => () => setSecret(null), []);
			const reveal = (kind) => act(async () => {
				const result = await stepUp((pin) => api("reveal", { account: account.id, kind, pin }));
				setSecret({ kind, value: result.value });
			});
			const close = () => { setSecret(null); props.onDone(); };
			return h(FlowShell, { title: t("backupTitle") + " · " + account.label, desc: t("backupDesc"), onBack: close },
				h("div", { className: "dshw-row" }, h("div", { className: "dshw-rowMain" }, h("div", { className: "dshw-mono" }, account.address))),
				secret === null
					? h("div", { className: "dshw" },
						hasMnemonic ? null : h("div", { className: "dshw-rowHint" }, t("noMnemonic")),
						h(Notice, { message }),
						h("div", { className: "dshw-actions" },
							hasMnemonic ? h(Btn, { variant: "primary", disabled: busy, onClick: () => void reveal("mnemonic") }, t("revealMnemonic")) : null,
							h(Btn, { variant: "outline", disabled: busy, onClick: () => { setAck(false); setRisk(true); } }, t("revealPrivateKey")),
						),
					)
					: h("div", { className: "dshw" },
						secret.kind === "mnemonic" ? h(WordGrid, { words: secret.value.split(" ") }) : h("div", { className: "dshw-secretBox" }, secret.value),
						h("div", { className: "dshw-actions dshw-actionsEnd" }, h(CopyButton, { text: secret.value }), h(Btn, { variant: "primary", onClick: close }, t("done"))),
					),
				risk && has("RiskConfirmation") ? h(P.RiskConfirmation, {
					open: true, title: t("riskRevealTitle"), description: t("riskRevealText"), acknowledgeLabel: t("riskAck"), cancelLabel: t("cancel"), closeLabel: t("close"),
					confirmLabel: t("revealPrivateKey"), acknowledged: ack, onAcknowledgedChange: setAck,
					onCancel: () => setRisk(false), onConfirm: () => { setRisk(false); void reveal("privateKey"); },
				}) : risk ? h(Dialog, {
					open: true, onClose: () => setRisk(false), title: t("riskRevealTitle"), description: t("riskRevealText"), closeLabel: t("close"),
					footer: [h(Btn, { key: "c", variant: "ghost", onClick: () => setRisk(false) }, t("cancel")), h(Btn, { key: "r", variant: "primary", disabled: !ack, onClick: () => { setRisk(false); void reveal("privateKey"); } }, t("revealPrivateKey"))],
				}, h(Check, { checked: ack, onChange: setAck, label: t("riskAck") })) : null,
			);
		}

		function ExportFlow(props) {
			const account = props.account;
			const stepUp = useStepUp();
			const [password, setPassword] = React.useState("");
			const [repeat, setRepeat] = React.useState("");
			const { busy, message, setMessage, act } = useAction();
			React.useEffect(() => () => { setPassword(""); setRepeat(""); }, []);
			const submit = () => {
				if (password.length < 8) return setMessage({ ok: false, text: t("passwordShort") });
				if (password !== repeat) return setMessage({ ok: false, text: t("passwordMismatch") });
				void act(async () => {
					const result = await stepUp((pin) => api("exportKeystore", { account: account.id, password, pin }));
					downloadText("keystore-" + result.address + ".json", result.json);
					setPassword("");
					setRepeat("");
				}, t("exported"));
			};
			return h(FlowShell, { title: t("exportTitle") + " · " + account.label, desc: t("exportDesc"), onBack: props.onDone },
				h("div", { className: "dshw-field", style: { marginTop: "12px" } },
					h("label", { className: "dshw-fieldLabel" }, t("exportPassword")),
					h(TextInput, { type: "password", value: password, onChange: setPassword, className: "dshw-fullInput", label: t("exportPassword"), autoComplete: "new-password" }),
				),
				h("div", { className: "dshw-field" },
					h("label", { className: "dshw-fieldLabel" }, t("exportConfirm")),
					h(TextInput, { type: "password", value: repeat, onChange: setRepeat, onEnter: submit, className: "dshw-fullInput", label: t("exportConfirm"), autoComplete: "new-password" }),
				),
				h(Notice, { message }),
				h("div", { className: "dshw-actions dshw-actionsEnd" }, h(Btn, { variant: "primary", disabled: busy, onClick: submit }, busy ? "…" : t("exportBtn"))),
			);
		}

		// ── Security ───────────────────────────────────────────────────────
		function PinDialog(props) {
			const mode = props.mode;
			const [current, setCurrent] = React.useState("");
			const [value, setValue] = React.useState("");
			const [repeat, setRepeat] = React.useState("");
			const [error, setError] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			React.useEffect(() => () => { setCurrent(""); setValue(""); setRepeat(""); }, []);
			const valid = (pin) => pin.length >= 4 && pin.length <= 12;
			const submit = async () => {
				setError(null);
				if (mode !== "verify") {
					if (!valid(value)) return setError(t("pinTooShort"));
					if (value !== repeat) return setError(t("pinMismatch"));
				}
				setBusy(true);
				try {
					if (mode === "setup") await api("pinSetup", { pin: value });
					else if (mode === "change") await api("pinChange", { current, next: value });
					else {
						const result = await api("pinVerify", { pin: value });
						if (!result || result.ok !== true) throw new ApiError(t("pinWrong"));
					}
					props.onDone();
				} catch (e) {
					setError(e instanceof ApiError && /incorrect|invalid/i.test(e.message) ? t("pinWrong") : (e && e.message) || String(e));
				} finally {
					setBusy(false);
				}
			};
			const title = mode === "setup" ? t("pinSetupTitle") : mode === "change" ? t("pinChangeTitle") : t("pinVerifyTitle");
			return h(Dialog, {
				open: true, onClose: props.onClose, title, closeLabel: t("close"),
				footer: [
					h(Btn, { key: "c", variant: "ghost", onClick: props.onClose }, t("cancel")),
					h(Btn, { key: "s", variant: "primary", disabled: busy || value.length < 4, onClick: () => void submit() }, busy ? "…" : t("confirm")),
				],
			},
			mode === "change" ? h("div", { className: "dshw-field" }, h(TextInput, { type: "password", value: current, onChange: setCurrent, autoFocus: true, label: t("pinCurrent"), placeholder: t("pinCurrent"), className: "dshw-fullInput" })) : null,
			h("div", { className: "dshw-field" }, h(TextInput, { type: "password", value, onChange: setValue, onEnter: mode === "verify" ? () => void submit() : undefined, autoFocus: mode !== "change", label: mode === "verify" ? t("pin") : t("pinNew"), placeholder: mode === "verify" ? t("pin") : t("pinNew"), className: "dshw-fullInput", inputMode: "numeric" })),
			mode === "verify" ? null : h("div", { className: "dshw-field" }, h(TextInput, { type: "password", value: repeat, onChange: setRepeat, onEnter: () => void submit(), label: t("pinRepeat"), placeholder: t("pinRepeat"), className: "dshw-fullInput", inputMode: "numeric" })),
			error ? h("div", { className: "dshw-error" }, error) : null);
		}

		function feedHint(feed) {
			if (!feed) return t("feedNever");
			const parts = [];
			if (feed.count > 0) parts.push(fmt(t("feedCount"), { n: feed.count }));
			parts.push(feed.fetchedAt ? fmt(t("feedUpdated"), { t: when(feed.fetchedAt) }) : t("feedNever"));
			if (feed.error) parts.push(fmt(t("feedError"), { e: feed.error }));
			return parts.join(" · ");
		}

		function ChecksSection(props) {
			const stepUp = useStepUp();
			const settings = props.security.settings;
			const feeds = {};
			(props.security.feeds || []).forEach((feed) => { feeds[feed.id] = feed; });
			const { busy, message, act } = useAction(props.reload);
			const save = (patch) => act(() => stepUp((pin) => api("securitySet", { settings: Object.assign({}, settings, patch), pin })), t("checksSaved"));
			const toggle = (key, label) => h(Toggle, { checked: settings[key] === true, label, disabled: busy, onChange: (v) => void save({ [key]: v }) });
			const feedToggle = (id, label) => h(Toggle, { checked: settings.feeds[id] === true, label, disabled: busy, onChange: (v) => void save({ feeds: Object.assign({}, settings.feeds, { [id]: v }) }) });
			return h(Section, {
				title: t("checksSection"), desc: t("checksDesc"),
				actions: h(Btn, { variant: "ghost", disabled: busy, onClick: () => void act(() => api("denylistRefresh"), t("feedsRefreshed")) }, t("refreshFeeds")),
			},
				h(Notice, { message }),
				h(Row, { label: t("chkSimulation"), hint: t("chkSimulationHint") }, toggle("simulation", t("chkSimulation"))),
				h(Row, { label: t("chkSanctions"), hint: t("chkSanctionsHint") }, toggle("sanctionsOracle", t("chkSanctions"))),
				h(Row, { label: t("chkOfac"), hint: feedHint(feeds.ofac) }, feedToggle("ofac", t("chkOfac"))),
				h(Row, { label: t("chkScam"), hint: feedHint(feeds.scamsniffer) }, feedToggle("scamsniffer", t("chkScam"))),
				h(Row, { label: t("chkGoplus"), hint: t("chkGoplusHint") }, toggle("goplus", t("chkGoplus"))),
				h(Row, { label: t("onUnavailable"), hint: t("onUnavailableHint") },
					h(Segments, {
						id: "dshw-unavailable", value: settings.onUnavailable, label: t("onUnavailable"),
						options: [{ value: "warn", label: t("unavailWarn") }, { value: "ask", label: t("unavailAsk") }, { value: "deny", label: t("unavailDeny") }],
						onChange: (v) => { if (v !== settings.onUnavailable) void save({ onUnavailable: v }); },
					})),
			);
		}

		function DenylistSection(props) {
			const stepUp = useStepUp();
			const entries = props.security.denylist || [];
			const { busy, message, act } = useAction(props.reload);
			const [draft, setDraft] = React.useState(null);
			const valid = draft !== null && /^0x[0-9a-fA-F]{40}$/.test(draft.address.trim());
			const add = () => {
				if (!valid) return;
				const value = draft;
				setDraft(null);
				void act(() => api("denylistAdd", { address: value.address.trim(), label: value.label.trim() || undefined }), t("denyAdded"));
			};
			return h(Section, {
				title: t("denySection"), desc: t("denyDesc"),
				actions: h(Btn, { variant: "outline", disabled: busy, onClick: () => setDraft({ address: "", label: "" }) }, t("denyAdd")),
			},
				h(Notice, { message }),
				entries.length === 0 ? h("div", { className: "dshw-empty" }, t("denyEmpty")) : entries.map((entry) => h("div", { className: "dshw-row", key: entry.address },
					h("div", { className: "dshw-rowMain" },
						h("div", { className: "dshw-rowLabel" }, entry.label || shortAddress(entry.address)),
						h("div", { className: "dshw-rowHint dshw-mono" }, entry.address),
					),
					h("div", { className: "dshw-rowControl" },
						h(Btn, { variant: "ghost", disabled: busy, onClick: () => void act(() => stepUp((pin) => api("denylistRemove", { address: entry.address, pin })), t("denyRemoved")) }, t("remove"))),
				)),
				h(Dialog, {
					open: draft !== null, onClose: () => setDraft(null), title: t("denyAdd"), description: t("denyAddDesc"), closeLabel: t("close"),
					footer: [
						h(Btn, { key: "c", variant: "ghost", onClick: () => setDraft(null) }, t("cancel")),
						h(Btn, { key: "s", variant: "primary", disabled: !valid, onClick: add }, t("add")),
					],
				}, draft === null ? null : [
					h("div", { key: "a", className: "dshw-field" },
						h("label", { className: "dshw-fieldLabel" }, t("contactAddress")),
						h(TextInput, { value: draft.address, onChange: (v) => setDraft(Object.assign({}, draft, { address: v })), autoFocus: true, label: t("contactAddress"), placeholder: "0x…", className: "dshw-fullInput" })),
					h("div", { key: "l", className: "dshw-field" },
						h("label", { className: "dshw-fieldLabel" }, t("denyLabel")),
						h(TextInput, { value: draft.label, onChange: (v) => setDraft(Object.assign({}, draft, { label: v })), onEnter: add, label: t("denyLabel"), className: "dshw-fullInput" })),
				]),
			);
		}

		function SecurityTab(props) {
			const data = props.data;
			const pin = data.pin;
			const settings = data.settings || {};
			const [dialog, setDialog] = React.useState(null);
			const { busy, message, act } = useAction(props.reload);
			const stepUp = useStepUp();
			const pinState = !pin.enabled ? t("pinOff") : pin.locked ? t("pinLocked") : pin.authorized ? (pin.authorizedUntil ? fmt(t("pinUntil"), { t: when(pin.authorizedUntil) }) : t("pinAuthorized")) : t("pinNotToday");
			const pinDot = !pin.enabled ? "idle" : pin.locked ? "error" : pin.authorized ? "done" : "warning";
			const keySource = settings.passphraseMode === "env" ? t("keySourceEnv") : settings.passphraseMode === "manual" ? t("keySourceManual") : settings.keychain ? t("keySourceKeychain") : t("keySourceAuto");

			return h("div", { className: "dshw" },
				h(Notice, { message }),
				h(Section, { title: t("vaultSection") },
					h(Row, { label: [h(Dot, { key: "d", state: data.status.unlocked ? "done" : "idle" }), " ", data.status.unlocked ? t("unlocked") : t("locked")], hint: t("vaultHint") },
						data.status.unlocked
							? h(Btn, { variant: "outline", disabled: busy, onClick: () => void act(() => api("lock")) }, t("lock"))
							: h(Btn, { variant: "primary", disabled: busy, onClick: () => void act(() => api("unlock")) }, t("unlock")),
					),
					h(Row, { label: t("autoLock"), hint: t("configHint") }, h("span", { className: "dshw-dim" }, fmt(t("autoLockValue"), { n: Math.round((settings.autoLockMs || data.status.autoLockMs || 0) / 60000) }))),
					h(Row, { label: t("keySource") }, h("span", { className: "dshw-dim" }, keySource)),
					settings.vaultPath ? h(Row, { label: t("dataDir"), hint: h("span", { className: "dshw-mono" }, settings.vaultPath) }) : null,
				),
				h(Section, { title: t("authSection"), desc: t("authDesc") },
					h(Row, { label: [h(Dot, { key: "d", state: pinDot }), " ", t("pin")], hint: pinState },
						!pin.enabled ? h(Btn, { variant: "primary", onClick: () => setDialog("setup") }, t("pinSetup"))
							: [
								!pin.authorized && !pin.locked ? h(Btn, { key: "v", variant: "primary", onClick: () => setDialog("verify") }, t("pinVerify")) : null,
								pin.authorized ? h(Btn, { key: "r", variant: "ghost", disabled: busy, onClick: () => void act(() => api("pinLock")) }, t("pinRevoke")) : null,
								h(Btn, { key: "c", variant: "ghost", onClick: () => setDialog("change") }, t("pinChange")),
							],
					),
					pin.enabled ? h(Row, { label: t("pinGrant"), hint: t("pinGrantHint") },
						[1, 7, 30].map((days) => h(Btn, {
							key: days,
							variant: pin.grantDays === days ? "primary" : "ghost",
							disabled: busy || pin.grantDays === days,
							onClick: () => void act(() => stepUp((code) => api("pinGrantDays", { days, pin: code })), t("pinGrantSaved")),
						}, t("grant" + days))),
					) : null,
				),
				data.security ? h(ChecksSection, { security: data.security, reload: props.reload }) : null,
				data.security ? h(DenylistSection, { security: data.security, reload: props.reload }) : null,
				h(Section, { title: t("agentSection"), desc: t("agentDesc") },
					h(Row, { label: t("agentSecrets"), hint: t("agentSecretsHint") }, settings.modelSecretReveal ? h(Badge, { tone: "danger" }, t("agentSecretsOff")) : h(Badge, { tone: "success" }, t("agentOn"))),
					h(Row, { label: t("agentLoosen"), hint: t("agentLoosenHint") }, h(Badge, { tone: "success" }, t("agentOn"))),
					h(Row, { label: t("agentApproval"), hint: t("agentApprovalHint") }, h(Btn, { variant: "ghost", onClick: () => props.go("limits") }, t("tabLimits") + " →")),
				),
				dialog ? h(PinDialog, { mode: dialog, onClose: () => setDialog(null), onDone: () => { setDialog(null); props.reload(); } }) : null,
			);
		}

		// ── Limits ─────────────────────────────────────────────────────────
		const PRESETS = ["agent-semi", "agent-full", "strict", "micropay", "testnet", "power", "locked"];

		function capText(value) {
			return value === undefined || value === null ? "" : String(value);
		}

		function LimitsTab(props) {
			const data = props.data;
			const stepUp = useStepUp();
			const limits = data.limits;
			const usage = data.usage || { usdSpentToday: "0", nativeSpentToday: {} };
			const { busy, message, act } = useAction(props.reload);
			const auto = limits.auto || { usd: {}, native: {} };
			const capsFrom = () => ({
				usdPerTx: capText(limits.usd.perTx), usdPerDay: capText(limits.usd.perDay),
				ethPerTx: capText(limits.native.ETH && limits.native.ETH.perTx), ethPerDay: capText(limits.native.ETH && limits.native.ETH.perDay),
				includeTestnets: limits.includeTestnets === true,
				autoUsdPerTx: capText(auto.usd.perTx), autoUsdPerDay: capText(auto.usd.perDay),
				autoEthPerTx: capText(auto.native.ETH && auto.native.ETH.perTx), autoEthPerDay: capText(auto.native.ETH && auto.native.ETH.perDay),
			});
			const [caps, setCaps] = React.useState(capsFrom);
			React.useEffect(() => {
				setCaps(capsFrom());
			}, [limits.updatedAt]);
			const [showRules, setShowRules] = React.useState(false);
			const [contact, setContact] = React.useState(null);

			const saveLimits = (next, okText) => act(() => stepUp((pin) => api("limitsSet", { limits: next, pin })), okText);
			const native = Object.assign({}, limits.native);
			const capsDirty = caps.usdPerTx !== capText(limits.usd.perTx) || caps.usdPerDay !== capText(limits.usd.perDay)
				|| caps.ethPerTx !== capText(limits.native.ETH && limits.native.ETH.perTx) || caps.ethPerDay !== capText(limits.native.ETH && limits.native.ETH.perDay)
				|| caps.includeTestnets !== (limits.includeTestnets === true);
			const saveCaps = () => {
				const eth = {};
				if (caps.ethPerTx.trim() !== "") eth.perTx = caps.ethPerTx.trim();
				if (caps.ethPerDay.trim() !== "") eth.perDay = caps.ethPerDay.trim();
				const nextNative = Object.assign({}, native);
				if (eth.perTx !== undefined || eth.perDay !== undefined) nextNative.ETH = eth;
				else delete nextNative.ETH;
				const usd = {};
				if (caps.usdPerTx.trim() !== "") usd.perTx = caps.usdPerTx.trim();
				if (caps.usdPerDay.trim() !== "") usd.perDay = caps.usdPerDay.trim();
				void saveLimits(Object.assign({}, limits, { usd, native: nextNative, includeTestnets: caps.includeTestnets }), t("capsSaved"));
			};
			const autoDirty = caps.autoUsdPerTx !== capText(auto.usd.perTx) || caps.autoUsdPerDay !== capText(auto.usd.perDay)
				|| caps.autoEthPerTx !== capText(auto.native.ETH && auto.native.ETH.perTx) || caps.autoEthPerDay !== capText(auto.native.ETH && auto.native.ETH.perDay);
			const saveAuto = () => {
				const eth = {};
				if (caps.autoEthPerTx.trim() !== "") eth.perTx = caps.autoEthPerTx.trim();
				if (caps.autoEthPerDay.trim() !== "") eth.perDay = caps.autoEthPerDay.trim();
				const nextNative = Object.assign({}, auto.native);
				if (eth.perTx !== undefined || eth.perDay !== undefined) nextNative.ETH = eth;
				else delete nextNative.ETH;
				const usd = {};
				if (caps.autoUsdPerTx.trim() !== "") usd.perTx = caps.autoUsdPerTx.trim();
				if (caps.autoUsdPerDay.trim() !== "") usd.perDay = caps.autoUsdPerDay.trim();
				void saveLimits(Object.assign({}, limits, { auto: { usd, native: nextNative } }), t("autoSaved"));
			};
			const choosePreset = (preset) => {
				if (preset === data.policy.preset) return;
				void act(() => stepUp((pin) => api("policyPreset", { preset, pin })), t("presetChanged"));
			};
			const contactValid = contact !== null && contact.label.trim() !== "" && /^0x[0-9a-fA-F]{40}$/.test(contact.address.trim());
			const addContact = () => {
				if (!contactValid) return;
				const draft = contact;
				setContact(null);
				void act(() => stepUp((pin) => api("contactUpsert", { label: draft.label.trim(), address: draft.address.trim(), note: draft.note.trim() || undefined, trusted: draft.trusted, pin })), t("contactSaved"));
			};
			const capInput = (key, label) => h(TextInput, {
				value: caps[key], onChange: (v) => setCaps(Object.assign({}, caps, { [key]: v.replace(/[^0-9.]/g, "") })),
				placeholder: t("unlimited"), label, className: "dshw-capInput", inputMode: "decimal",
			});
			const custom = data.policy.preset === "custom";

			return h("div", { className: "dshw" },
				h(Notice, { message }),
				h(Section, { title: t("presetSection"), desc: t("presetDesc") },
					custom ? h("div", { className: "dshw-preset" },
						h("span", { className: "dshw-radio dshw-radioOn" }),
						h("span", { className: "dshw-rowMain" },
							h("span", { className: "dshw-rowLabel" }, t("preset_custom")),
							h("span", { className: "dshw-rowHint" }, fmt(t("preset_customDesc"), { n: data.policy.rules.length })),
						),
					) : null,
					PRESETS.map((preset) => h("button", {
						key: preset, type: "button", className: "dshw-preset", disabled: busy, role: "radio", "aria-checked": data.policy.preset === preset,
						onClick: () => choosePreset(preset),
					},
					h("span", { className: "dshw-radio" + (data.policy.preset === preset ? " dshw-radioOn" : "") }),
					h("span", { className: "dshw-rowMain" },
						h("span", { className: "dshw-rowLabel" }, t("preset_" + preset)),
						h("span", { className: "dshw-rowHint" }, t("preset_" + preset + "Desc")),
					))),
				),
				h(Section, { title: t("capsSection"), desc: t("capsDesc") },
					h(Row, { label: t("usdPerTx"), hint: t("usdHint") }, capInput("usdPerTx", t("usdPerTx")), h("span", { className: "dshw-dim" }, "USD")),
					h(Row, { label: t("usdPerDay"), hint: fmt(t("usedToday"), { v: "$" + trimAmount(usage.usdSpentToday) }) }, capInput("usdPerDay", t("usdPerDay")), h("span", { className: "dshw-dim" }, "USD")),
					h(Row, { label: fmt(t("nativePerTx"), { s: "ETH" }), hint: fmt(t("nativeHint"), { s: "ETH" }) }, capInput("ethPerTx", "ETH"), h("span", { className: "dshw-dim" }, "ETH")),
					h(Row, { label: fmt(t("nativePerDay"), { s: "ETH" }), hint: usage.nativeSpentToday.ETH !== undefined ? fmt(t("usedToday"), { v: trimAmount(usage.nativeSpentToday.ETH) + " ETH" }) : null }, capInput("ethPerDay", "ETH"), h("span", { className: "dshw-dim" }, "ETH")),
					h(Row, { label: t("includeTestnets") }, h(Toggle, { checked: caps.includeTestnets, label: t("includeTestnets"), onChange: (v) => setCaps(Object.assign({}, caps, { includeTestnets: v })) })),
					h("div", { className: "dshw-actions dshw-actionsEnd", style: { paddingTop: "8px" } },
						h(Btn, { variant: "primary", disabled: busy || !capsDirty, onClick: saveCaps }, busy ? t("saving") : t("save"))),
				),
				h(Section, { title: t("autoSection"), desc: t("autoDesc") },
					data.policy.preset !== "agent-semi" ? h("div", { className: "dshw-rowHint" }, t("autoInactive")) : null,
					h(Row, { label: t("usdPerTx"), hint: t("usdHint") }, capInput("autoUsdPerTx", t("usdPerTx")), h("span", { className: "dshw-dim" }, "USD")),
					h(Row, { label: t("usdPerDay") }, capInput("autoUsdPerDay", t("usdPerDay")), h("span", { className: "dshw-dim" }, "USD")),
					h(Row, { label: fmt(t("nativePerTx"), { s: "ETH" }), hint: fmt(t("nativeHint"), { s: "ETH" }) }, capInput("autoEthPerTx", "ETH"), h("span", { className: "dshw-dim" }, "ETH")),
					h(Row, { label: fmt(t("nativePerDay"), { s: "ETH" }) }, capInput("autoEthPerDay", "ETH"), h("span", { className: "dshw-dim" }, "ETH")),
					h("div", { className: "dshw-actions dshw-actionsEnd", style: { paddingTop: "8px" } },
						h(Btn, { variant: "primary", disabled: busy || !autoDirty, onClick: saveAuto }, busy ? t("saving") : t("save"))),
				),
				h(Section, {
					title: t("whitelistSection"),
					desc: t("whitelistDesc"),
					actions: h(Btn, { variant: "outline", disabled: busy, onClick: () => setContact({ label: "", address: "", note: "", trusted: true }) }, t("contactAdd")),
				},
					h(Row, { label: t("whitelistOnly") },
						h(Toggle, { checked: limits.whitelistOnly, label: t("whitelistOnly"), disabled: busy, onChange: (v) => void saveLimits(Object.assign({}, limits, { whitelistOnly: v }), t("saved")) })),
					data.contacts.length === 0 ? h("div", { className: "dshw-empty" }, t("whitelistEmpty")) : data.contacts.map((entry) => h("div", { className: "dshw-row", key: entry.label },
						h("div", { className: "dshw-avatar", style: avatarStyle(entry.address), "aria-hidden": "true" }),
						h("div", { className: "dshw-rowMain" },
							h("div", { className: "dshw-rowLabel" }, entry.label, entry.trusted ? h(Badge, { tone: "success" }, t("trusted")) : null),
							h("div", { className: "dshw-rowHint dshw-mono" }, entry.address),
						),
						h("div", { className: "dshw-rowControl" },
							h(Toggle, { checked: entry.trusted === true, label: t("trusted"), disabled: busy, onChange: (v) => void act(() => stepUp((pin) => api("contactTrust", { label: entry.label, trusted: v, pin }))) }),
							h(Btn, { variant: "ghost", disabled: busy, onClick: () => void act(() => api("contactRemove", { label: entry.label })) }, t("remove")),
						),
					)),
				),
				h(Dialog, {
					open: contact !== null, onClose: () => setContact(null), title: t("contactAdd"), description: t("contactAddDesc"), closeLabel: t("close"),
					footer: [
						h(Btn, { key: "c", variant: "ghost", onClick: () => setContact(null) }, t("cancel")),
						h(Btn, { key: "s", variant: "primary", disabled: !contactValid, onClick: addContact }, t("save")),
					],
				}, contact === null ? null : [
					h("div", { key: "l", className: "dshw-field" },
						h("label", { className: "dshw-fieldLabel" }, t("contactLabel")),
						h(TextInput, { value: contact.label, onChange: (v) => setContact(Object.assign({}, contact, { label: v })), autoFocus: true, label: t("contactLabel"), className: "dshw-fullInput" })),
					h("div", { key: "a", className: "dshw-field" },
						h("label", { className: "dshw-fieldLabel" }, t("contactAddress")),
						h(TextInput, { value: contact.address, onChange: (v) => setContact(Object.assign({}, contact, { address: v })), label: t("contactAddress"), placeholder: "0x…", className: "dshw-fullInput" })),
					h("div", { key: "n", className: "dshw-field" },
						h("label", { className: "dshw-fieldLabel" }, t("contactNote") + " " + t("optional")),
						h(TextInput, { value: contact.note, onChange: (v) => setContact(Object.assign({}, contact, { note: v })), onEnter: addContact, label: t("contactNote"), className: "dshw-fullInput" })),
					h(Check, { key: "t", checked: contact.trusted, onChange: (v) => setContact(Object.assign({}, contact, { trusted: v })), label: t("contactTrusted") }),
				]),
				h(Section, {
					title: t("advanced"),
					actions: h("button", { className: "dshw-plain", type: "button", onClick: () => setShowRules(!showRules) }, showRules ? t("advancedHide") : fmt(t("advancedShow"), { n: data.policy.rules.length })),
				}, showRules ? data.policy.rules.map((rule) => h("div", { className: "dshw-rule", key: rule.id },
					h(Badge, { tone: rule.effect === "allow" ? "success" : rule.effect === "deny" ? "danger" : "warning" }, rule.effect),
					h("span", { className: rule.enabled === false ? "dshw-dim" : undefined }, rule.description || rule.id),
				)) : null),
			);
		}

		// ── Activity ───────────────────────────────────────────────────────
		function auditText(entry) {
			const d = entry.detail || {};
			const parts = [];
			if (d.effect) parts.push(String(d.effect));
			if (d.intent) parts.push(String(d.intent));
			if (d.limit) parts.push("limit " + String(d.limit));
			if (d.preset) parts.push(String(d.preset));
			if (d.label) parts.push(String(d.label));
			if (d.address) parts.push(shortAddress(d.address));
			if (d.to) parts.push("→ " + shortAddress(d.to));
			if (d.outcome) parts.push(String(d.outcome));
			if (d.via) parts.push("via " + String(d.via));
			if (d.requestId) parts.push(String(d.requestId));
			return parts.join(" · ");
		}

		function ActivityTab() {
			const [view, setView] = React.useState("tx");
			const [state, setState] = React.useState({ loading: true, error: null, tx: [], audit: [] });
			const load = React.useCallback(async () => {
				setState((prev) => Object.assign({}, prev, { loading: true }));
				try {
					const [history, audit] = await Promise.all([api("history", { limit: 50 }), api("audit", { limit: 60 })]);
					setState({ loading: false, error: null, tx: (history && history.transactions) || [], audit: (audit && audit.entries) || [] });
				} catch (e) {
					setState({ loading: false, error: (e && e.message) || String(e), tx: [], audit: [] });
				}
			}, []);
			React.useEffect(() => { void load(); }, [load]);
			return h("div", { className: "dshw" },
				h("div", { className: "dshw-picker" },
					h(Segments, { id: "dshw-activity", value: view, onChange: setView, label: t("tabActivity"), options: [{ value: "tx", label: t("activityTx") }, { value: "audit", label: t("activityAudit") }] }),
					h(Btn, { variant: "ghost", onClick: () => void load(), disabled: state.loading }, t("refresh")),
				),
				state.error ? h("div", { className: "dshw-error" }, state.error) : null,
				h(Section, null, view === "tx"
					? (state.tx.length === 0 ? h("div", { className: "dshw-empty" }, state.loading ? t("loading") : t("txEmpty")) : state.tx.map((tx) => h(TxRow, { key: tx.hash, tx })))
					: (state.audit.length === 0 ? h("div", { className: "dshw-empty" }, state.loading ? t("loading") : t("auditEmpty")) : state.audit.map((entry, index) => h("div", { className: "dshw-row", key: String(entry.ts) + ":" + index },
						h("div", { className: "dshw-rowMain" },
							h("div", { className: "dshw-rowLabel" }, h("span", { className: "dshw-mono" }, String(entry.kind))),
							h("div", { className: "dshw-rowHint" }, when(entry.ts) + (auditText(entry) ? " · " + auditText(entry) : "")),
						),
					)))),
			);
		}

		// ── panel ──────────────────────────────────────────────────────────
		function Onboarding(props) {
			return h("div", { className: "dshw-hero" },
				h("h3", { className: "dshw-heroTitle" }, t("welcomeTitle")),
				h("p", { className: "dshw-heroText" }, t("welcomeText")),
				h("div", { className: "dshw-actions" },
					h(Btn, { variant: "primary", onClick: props.onCreate }, t("createWallet")),
					h(Btn, { variant: "outline", onClick: props.onImport }, t("importWallet")),
				),
			);
		}

		function WalletPanel() {
			useLocaleVersion();
			const { state, reload } = useOverview();
			const [tab, setTab] = React.useState("assets");
			const [flow, setFlow] = React.useState(null);
			const [unlocking, setUnlocking] = React.useState(false);
			const go = React.useCallback((next) => { setFlow(null); setTab(next); }, []);
			const finish = React.useCallback(() => { setFlow(null); void reload(); }, [reload]);

			let body;
			if (state.loading && state.data === null) body = h("div", { className: "dshw-empty" }, t("loading"));
			else if (state.data === null) {
				body = h("div", { className: "dshw" },
					h("div", { className: "dshw-error" }, t("loadFailed") + ": " + String(state.error)),
					h("div", { className: "dshw-actions" }, h(Btn, { variant: "outline", onClick: () => void reload() }, t("retry"))));
			} else if (flow !== null) {
				if (flow.kind === "create") body = h(CreateFlow, { onBack: () => setFlow(null), onDone: finish });
				else if (flow.kind === "import") body = h(ImportFlow, { onBack: () => setFlow(null), onDone: finish });
				else if (flow.kind === "backup") body = h(BackupFlow, { account: flow.account, onDone: finish });
				else body = h(ExportFlow, { account: flow.account, onDone: finish });
			} else if (state.data.accounts.length === 0) {
				body = h(Onboarding, { onCreate: () => setFlow({ kind: "create" }), onImport: () => setFlow({ kind: "import" }) });
			} else {
				const data = state.data;
				const common = { data, reload, go };
				const panels = {
					assets: () => h(AssetsTab, common),
					accounts: () => h(AccountsTab, Object.assign({}, common, {
						onCreate: () => setFlow({ kind: "create" }),
						onImport: () => setFlow({ kind: "import" }),
						onBackup: (account) => setFlow({ kind: "backup", account }),
						onExport: (account) => setFlow({ kind: "export", account }),
					})),
					security: () => h(SecurityTab, common),
					limits: () => h(LimitsTab, common),
					activity: () => h(ActivityTab, common),
				};
				body = h("div", { className: "dshw" },
					h(Tabs, {
						value: tab, onChange: setTab, label: t("tabsLabel"),
						items: [
							{ value: "assets", label: t("tabAssets") },
							{ value: "accounts", label: t("tabAccounts") },
							{ value: "security", label: t("tabSecurity") },
							{ value: "limits", label: t("tabLimits") },
							{ value: "activity", label: t("tabActivity") },
						],
					}),
					tab === "assets" ? h(Banners, {
						data, go, busy: unlocking,
						onUnlock: () => { setUnlocking(true); api("unlock").catch(() => undefined).finally(() => { setUnlocking(false); void reload(); }); },
					}) : null,
					h("div", { role: "tabpanel", id: "dshw-panel-" + tab, "aria-labelledby": "dshw-tab-" + tab }, panels[tab]()),
				);
			}
			return h(StepUpProvider, { onGoSecurity: () => go("security") }, h("div", { className: "dshw" }, body));
		}

		// ── plugin wiring ──────────────────────────────────────────────────
		const inject = ["connection", "slots", "locale"];

		function apply(c) {
			connectionSvc = c.get ? c.get("connection") : undefined;
			const slots = c.get ? c.get("slots") : c.slots;
			if (slots === undefined) return;
			if (c.locale && typeof c.locale.register === "function") {
				localeSvc = c.locale;
				c.effect(() => c.locale.register(NS, MESSAGES), "dsh-web3: dictionaries");
				if (typeof c.locale.bind === "function") t = c.locale.bind(NS);
			}
			slots.inject("settings.section", () => slots.register({
				name: "settings.section",
				id: "web3",
				order: 250,
				label: () => t("nav"),
				locale: NS,
			}, WalletPanel));
		}

		exports.apply = apply;
		exports.inject = inject;
		// Render hooks for smoke tests (ignored by the DSH loader).
		exports.__testing = {
			AssetsTab, AccountsTab, SecurityTab, ChecksSection, DenylistSection, LimitsTab, ActivityTab, Banners, Onboarding, StepUpProvider, CreateFlow, ImportFlow, BackupFlow, ExportFlow, PinDialog,
			messages: MESSAGES,
			setConnection: (connection) => { connectionSvc = connection; },
		};
		return module.exports;
	},
});
