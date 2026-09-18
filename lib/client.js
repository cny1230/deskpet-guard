/**
 * deskpet-guard — client 面板（**手写产物，无构建**）。
 *
 * 为什么手写：本机没有 dsh 源码检出（tsc 不可用），也没有 node_modules
 * （tsdown 装不上），所以 src/client/index.ts 编译不出产物。而面板本身只是
 * DOM，不需要打包器 —— 这里直接按 DSH 的 ModuleLoader 约定产出 lib/client.js。
 * 约定抄自一个**确证可用**的同构产物：
 *   D:\keep-records\super-injector-pkg\package\lib\client.js
 *     · 外层 window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
 *     · exports.apply / exports.inject = ['slots']
 *     · ctx.effect(() => ctx.slots.inject(<slot>, () => ctx.slots.register({
 *         name: <slot>, id, order?, label: () => string, component: () => ({ render(), dispose?() })
 *       })), 'label')
 * 合法 slot 白名单（injector 侧校验）：conversation.view / settings.section /
 * shell.overlay / sidebar.footer.action / conversation.input.dock 等。
 *
 * 本文件挂两个 slot：
 *   · shell.overlay       → 常驻右下角的小桌宠（表情 + 一句话 + 新事件角标）
 *   · conversation.view   → 会话侧栏详情面板（统计 + 候选目标两步确认 + 事件流）
 * 两者的数据面都是 host 的本地 HTTP API（lib/api.js）：
 *   GET  /deskpet-guard/api/status
 *   GET  /deskpet-guard/api/events?limit=N
 *   POST /deskpet-guard/api/scan
 *   POST /deskpet-guard/api/prepare-kill   { targetPid }
 *   POST /deskpet-guard/api/confirm-kill   { confirmToken }
 * 变更类 POST 必须带自定义头 x-deskpet-guard: 1（同源 + 预检闸门，见 api.js）。
 *
 * 安全：所有来自系统的字符串（进程名/路径/域名）一律用 textContent 写入，
 * 绝不用 innerHTML —— 否则一个精心命名的进程就能在面板里注入标记。
 */
window.__ModuleLoader__.load({
	id: "deskpet-guard",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const inject = ["slots"];
		const API = "/deskpet-guard/api";
		const POLL_MS = 3000;

		const MOODS = {
			watching: { face: "( ◕‿◕ )", label: "守着", color: "#2ecc71", tone: "calm" },
			alert: { face: "( ◉_◉ )", label: "留意", color: "#f1c40f", tone: "warn" },
			panic: { face: "( ✖﹏✖ )", label: "高危", color: "#e74c3c", tone: "danger" },
			unknown: { face: "( ・_・)", label: "未采样", color: "#8899aa", tone: "calm" },
		};
		const SEVERITY_COLOR = {
			critical: "#e74c3c",
			high: "#f39c12",
			medium: "#f1c40f",
			low: "#8bc34a",
			info: "#8899aa",
		};

		function el(tag, cls, text) {
			const node = document.createElement(tag);
			if (cls) node.className = cls;
			if (text !== undefined) node.textContent = String(text);
			return node;
		}

		const styles = `
.dpg-root{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;line-height:1.6;color:var(--theme-text,#ddd)}
.dpg-panel{padding:14px 16px;max-width:760px}
.dpg-card{border:1px solid var(--theme-border,#333);border-radius:10px;padding:12px;margin-bottom:12px;background:var(--theme-input-bg,rgba(127,127,127,.06))}
.dpg-hero{display:flex;align-items:center;gap:14px}
.dpg-face{font-size:22px;letter-spacing:1px;white-space:nowrap}
.dpg-hero .dpg-face{font-size:30px}
.dpg-hero-main{flex:1;min-width:0}
.dpg-headline{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpg-sub{color:var(--theme-text-secondary,#888);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpg-chips{display:flex;flex-wrap:wrap;gap:6px;margin:10px 0 0}
.dpg-chip{border:1px solid var(--theme-border,#333);border-radius:999px;padding:2px 9px;font-size:11px;color:var(--theme-text-secondary,#999)}
.dpg-chip b{color:var(--theme-text,#ddd);font-weight:600}
.dpg-btn{background:var(--theme-accent,#4a9eff);color:#fff;border:none;border-radius:6px;padding:5px 11px;cursor:pointer;font-size:11px;white-space:nowrap;font-family:inherit}
.dpg-btn.ghost{background:transparent;border:1px solid var(--theme-border,#444);color:var(--theme-text,#ccc)}
.dpg-btn.danger{background:transparent;border:1px solid #e74c3c;color:#e74c3c}
.dpg-btn:disabled{opacity:.45;cursor:not-allowed}
.dpg-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:10px}
.dpg-warn{border-left:3px solid #f39c12;background:rgba(243,156,18,.08);padding:8px 10px;border-radius:0 6px 6px 0;margin-top:10px;font-size:11px;white-space:pre-wrap}
.dpg-err{border-left:3px solid #e74c3c;background:rgba(231,76,60,.08);padding:8px 10px;border-radius:0 6px 6px 0;margin-top:10px;font-size:11px;white-space:pre-wrap}
.dpg-list{list-style:none;margin:10px 0 0;padding:0;max-height:260px;overflow:auto}
.dpg-item{display:flex;gap:8px;align-items:baseline;padding:6px 8px;border:1px solid var(--theme-border,#333);border-radius:7px;margin-bottom:5px}
.dpg-item .t{font-weight:600;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpg-item .d{color:var(--theme-text-secondary,#888);font-size:11px;white-space:nowrap}
.dpg-sev{font-size:10px;padding:1px 6px;border-radius:999px;color:#111;font-weight:700;white-space:nowrap}
.dpg-target{display:flex;gap:8px;align-items:center;padding:7px 9px;border:1px solid rgba(231,76,60,.45);border-radius:7px;margin-bottom:6px}
.dpg-target .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dpg-target .d{color:var(--theme-text-secondary,#888);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:45%}
.dpg-foot{color:var(--theme-text-secondary,#888);font-size:10px;margin-top:10px;word-break:break-all}
.dpg-pet{position:fixed;right:16px;bottom:16px;z-index:2147483000;display:flex;align-items:center;gap:9px;padding:8px 12px;border-radius:999px;border:1px solid var(--theme-border,#444);background:var(--theme-panel-bg,rgba(20,22,26,.92));box-shadow:0 6px 22px rgba(0,0,0,.35);cursor:default;max-width:340px}
.dpg-pet .dpg-headline{font-size:11px}
.dpg-pet .dpg-badge{font-size:10px;font-weight:700;padding:1px 6px;border-radius:999px;background:#e74c3c;color:#fff}
.dpg-pet .dpg-pop{position:absolute;right:0;bottom:calc(100% + 8px);width:300px;max-height:240px;overflow:auto;border:1px solid var(--theme-border,#444);border-radius:10px;background:var(--theme-panel-bg,rgba(20,22,26,.96));padding:8px;box-shadow:0 6px 22px rgba(0,0,0,.35)}
`;

		let stylesInjected = false;
		/** 样式只注入一次（两个 slot 共用；HMR/重复渲染也不会叠加）。 */
		function ensureStyles() {
			if (stylesInjected || typeof document === "undefined") return;
			const existing = document.getElementById("deskpet-guard-styles");
			if (!existing) {
				const node = document.createElement("style");
				node.id = "deskpet-guard-styles";
				node.textContent = styles;
				document.head.appendChild(node);
			}
			stylesInjected = true;
		}

		function fetchJson(path, init) {
			const opts = Object.assign({ headers: {} }, init || {});
			opts.headers = Object.assign({ "x-deskpet-guard": "1" }, opts.headers || {});
			if (opts.body !== undefined) opts.headers["content-type"] = "application/json";
			return fetch(API + path, opts).then((res) =>
				res.json().then(
					(json) => (res.ok ? json : Promise.reject(new Error((json && json.error) || "HTTP " + res.status))),
					() => Promise.reject(new Error("响应不是 JSON（HTTP " + res.status + "）")),
				),
			);
		}

		/** 两个 slot 共用一条轮询：一个 interval，引用计数订阅。 */
		const feed = {
			status: null,
			events: [],
			error: null,
			newEvents: 0,
			lastSeenEvents: null,
			listeners: new Set(),
			timer: null,
			inflight: false,
			subscribe(fn) {
				this.listeners.add(fn);
				if (!this.timer) {
					this.refresh();
					this.timer = window.setInterval(() => this.refresh(), POLL_MS);
				}
				fn(this);
				return () => {
					this.listeners.delete(fn);
					if (this.listeners.size === 0 && this.timer) {
						window.clearInterval(this.timer);
						this.timer = null;
					}
				};
			},
			emit() {
				for (const fn of Array.from(this.listeners)) {
					try {
						fn(this);
					} catch (e) {
						/* 单个订阅者出错不拖垮另一个 */
					}
				}
			},
			async refresh() {
				if (this.inflight) return;
				this.inflight = true;
				try {
					const status = await fetchJson("/status");
					const events = await fetchJson("/events?limit=30");
					this.status = status;
					const list = (events && events.events) || [];
					const newestSeq = list.length ? list[list.length - 1].seq ?? list.length : null;
					if (this.lastSeenEvents !== null && newestSeq !== null && newestSeq > this.lastSeenEvents) {
						this.newEvents += 1;
					}
					this.lastSeenEvents = newestSeq;
					this.events = list;
					this.error = null;
				} catch (e) {
					this.error = String((e && e.message) || e);
				} finally {
					this.inflight = false;
					this.emit();
				}
			},
			markRead() {
				this.newEvents = 0;
				this.emit();
			},
		};

		function moodOf(status) {
			const key = (status && status.mood) || ((status && status.status && status.status.mood) || "unknown");
			return MOODS[key] || MOODS.unknown;
		}
		function statusBody(res) {
			return (res && (res.status || res)) || null;
		}
		function fmtTime(ms) {
			if (!ms) return "—";
			try {
				return new Date(ms).toLocaleTimeString();
			} catch {
				return "—";
			}
		}
		function shortSev(f) {
			return String((f && f.severity) || "info").toUpperCase();
		}

		/** 桌宠：shell.overlay */
		function renderPet(ctx) {
			ensureStyles();
			const root = el("div", "dpg-root dpg-pet");
			const face = el("span", "dpg-face");
			const main = el("div", "dpg-hero-main");
			const headline = el("div", "dpg-headline");
			const sub = el("div", "dpg-sub");
			const badge = el("span", "dpg-badge");
			const pop = el("div", "dpg-pop");
			main.append(headline, sub);
			root.append(face, main, badge);
			root.style.position = "fixed";
			root.append(pop);

			let popOpen = false;
			const setOpen = (open) => {
				popOpen = open;
				pop.style.display = open ? "block" : "none";
				if (open) feed.markRead();
				root.style.cursor = "pointer";
			};
			setOpen(false);
			root.addEventListener("click", () => setOpen(!popOpen));

			const unbind = feed.subscribe((f) => {
				const m = moodOf(f.status);
				// ⚠️ 数据在内层 status 对象里（/status 响应顶层的 mood/headline 只是镜像，
				// 可能缺失）—— 早期只读顶层，导致桌宠永远显示"尚无采样"（截图自查抓到）
				const st = statusBody(f.status);
				face.textContent = m.face;
				face.style.color = m.color;
				root.style.borderColor = f.error ? "#e74c3c" : m.color;
				headline.textContent = f.error
					? "守护 API 不可达"
					: (st && (st.headline || st.mood)) || "尚无采样";
				sub.textContent = f.error
					? f.error.slice(0, 60)
					: "采样 " + fmtTime(st && st.atMs) + " · " + m.label;
				badge.textContent = String(f.newEvents);
				badge.style.display = f.newEvents > 0 ? "inline-block" : "none";

				pop.textContent = "";
				const rows = f.events.slice(-6).reverse();
				if (!rows.length) {
					pop.append(el("div", "dpg-sub", f.error ? "（无数据）" : "暂无告警事件"));
				}
				for (const ev of rows) {
					const row = el("div", "dpg-item");
					const chip = el("span", "dpg-sev", shortSev(ev));
					chip.style.background = SEVERITY_COLOR[ev.severity] || "#8899aa";
					row.append(chip, el("span", "t", ev.title || ev.ruleId || "?"));
					pop.append(row);
				}
			});
			return { render: () => root, dispose: unbind };
		}

		/** 详情面板：conversation.view */
		function renderPanel(ctx) {
			ensureStyles();
			const root = el("div", "dpg-root dpg-panel");

			const card = el("div", "dpg-card");
			const hero = el("div", "dpg-hero");
			const face = el("span", "dpg-face");
			const heroMain = el("div", "dpg-hero-main");
			const headline = el("div", "dpg-headline");
			const sub = el("div", "dpg-sub");
			heroMain.append(headline, sub);
			hero.append(face, heroMain);
			const chips = el("div", "dpg-chips");
			const actions = el("div", "dpg-actions");
			const refreshBtn = el("button", "dpg-btn ghost", "立即重扫");
			actions.append(refreshBtn);
			card.append(hero, chips, actions);

			const probeBox = el("div", "dpg-warn");
			probeBox.style.display = "none";
			probeBox.textContent = "";
			const errBox = el("div", "dpg-err");
			errBox.style.display = "none";
			errBox.textContent = "";
			const killBox = el("div");
			const eventBox = el("div");
			const foot = el("div", "dpg-foot");

			root.append(card, errBox, probeBox, killBox, eventBox, foot);

			let lastStatus = null;
			// 处置流程是**跨渲染周期**的状态：轮询每 3 秒会重画 killBox，
			// 如果把"已生成的确认单"只放在 DOM 里，用户在 3 秒内没点完就被冲掉
			// （截图自查当场抓到）。所以状态挂在闭包上，每次重画都从状态还原。
			let pending = null; // { targetPid, plan }
			let notice = ""; // 上一次处置的结果提示

			function chip(label, value) {
				const c = el("span", "dpg-chip");
				c.append(document.createTextNode(label + " "), el("b", undefined, value));
				return c;
			}

			function confirmSummary(plan) {
				const t = plan.confirmTarget;
				return (
					(plan.warning || "") +
					"\n\n本次目标：" + (t ? "pid=" + t.pid + " " + (t.process || "") : "(无)") +
					"\ntoken: " + (plan.confirmToken || "(无)") +
					"\ntoken 一次性、10 分钟内有效；在你点下「我已确认后果」之前不会执行任何动作。"
				);
			}

			function renderKill() {
				killBox.textContent = "";
				const targets = (lastStatus && lastStatus.killTargets) || [];
				if (!targets.length && !pending && !notice) return;

				const box = el("div", "dpg-card");
				box.append(el("div", "dpg-headline", "候选处置目标 · 逐个确认（一次只终止一个）"));
				if (notice) box.append(el("div", "dpg-warn", notice));
				if (!targets.length) {
					box.append(el("div", "dpg-sub", "当前没有 critical 级候选目标。"));
				}

				targets.forEach((t) => {
					const row = el("div", "dpg-target");
					const info = el("div", "t");
					info.append(el("div", undefined, "pid=" + t.pid + "  " + (t.process || "?")));
					info.append(el("div", "dpg-sub", (t.reason || "") + (t.remote ? " → " + t.remote : "")));
					const btn = el("button", "dpg-btn danger", "确认终止");
					btn.addEventListener("click", () => {
						btn.disabled = true;
						btn.textContent = "生成确认单…";
						fetchJson("/prepare-kill", { method: "POST", body: JSON.stringify({ targetPid: t.pid }) })
							.then((plan) => {
								pending = { targetPid: t.pid, plan };
								notice = "";
							})
							.catch((e) => {
								notice = "生成确认单失败：" + String((e && e.message) || e);
							})
							.finally(() => {
								btn.disabled = false;
								btn.textContent = "确认终止";
								renderKill();
							});
					});
					row.append(info, btn);
					box.append(row);
				});

				if (pending && pending.plan) {
					const plan = pending.plan;
					box.append(el("div", "dpg-warn", confirmSummary(plan)));
					const area = el("div", "dpg-actions");
					const go = el("button", "dpg-btn danger", "我已确认后果，执行终止");
					const cancel = el("button", "dpg-btn ghost", "取消");
					cancel.addEventListener("click", () => {
						pending = null;
						renderKill();
					});
					go.addEventListener("click", () => {
						go.disabled = true;
						go.textContent = "执行中…";
						fetchJson("/confirm-kill", {
							method: "POST",
							body: JSON.stringify({ confirmToken: plan.confirmToken }),
						})
							.then((res) => {
								notice = res.ok
									? "已终止 pid=" + (res.killed || []).join(",")
									: "终止未执行：" + (res.error || "未知原因");
							})
							.catch((e) => {
								notice = "终止失败：" + String((e && e.message) || e);
							})
							.finally(() => {
								pending = null;
								renderKill();
							});
					});
					area.append(go, cancel);
					box.append(area);
				}
				killBox.append(box);
			}

			function renderEvents(f) {
				eventBox.textContent = "";
				const box = el("div", "dpg-card");
				box.append(el("div", "dpg-headline", "最近事件（guard-events.jsonl，只追加）"));
				const list = el("ul", "dpg-list");
				const rows = f.events.slice(-20).reverse();
				if (!rows.length) {
					list.append(el("li", "dpg-sub", f.error ? "（API 不可达）" : "暂无事件"));
				}
				for (const ev of rows) {
					const li = el("li", "dpg-item");
					const chipEl = el("span", "dpg-sev", shortSev(ev));
					chipEl.style.background = SEVERITY_COLOR[ev.severity] || "#8899aa";
					const t = el("span", "t", ev.title || ev.ruleId || "?");
					const d = el("span", "d", fmtTime(ev.atMs));
					li.append(chipEl, t, d);
					list.append(li);
				}
				box.append(list);
				eventBox.append(box);
			}

			refreshBtn.addEventListener("click", () => {
				refreshBtn.disabled = true;
				refreshBtn.textContent = "扫描中…";
				fetchJson("/scan", { method: "POST", body: "{}" })
					.then((res) => {
						notice = res.mood
							? "本次重扫：" + res.mood.mood + " — " + res.mood.headline
							: notice;
						feed.refresh();
					})
					.catch((e) => {
						notice = "重扫失败：" + String((e && e.message) || e);
					})
					.finally(() => {
						refreshBtn.disabled = false;
						refreshBtn.textContent = "立即重扫";
						renderKill();
					});
			});

			const unbind = feed.subscribe((f) => {
				const st = statusBody(f.status);
				lastStatus = st;
				const mood = moodOf(f.status);
				face.textContent = mood.face;
				face.style.color = mood.color;
				headline.textContent = f.error
					? "守护 API 不可达"
					: (st && (st.headline || st.mood)) || "尚无采样结果";
				sub.textContent = f.error
					? API
					: "最近采样 " + fmtTime(st && st.atMs) + " · 第 " + ((st && st.cycles) || 0) + " 轮 · " + mood.label;

				errBox.style.display = f.error ? "block" : "none";
				errBox.textContent = f.error
					? "读取 " + API + "/status 失败：" + f.error + "\n（守护进程没跑 / 插件没注入 / 面板路径与 host 前缀不一致，三者之一）"
					: "";

				chips.textContent = "";
				if (st) {
					chips.append(
						chip("agent 进程", st.agentProcessCount ?? 0),
						chip("外发连接", st.egressConnections ?? 0),
						chip("打包产物", st.bundleArtifacts ?? 0),
						chip("活跃告警", st.activeFindings ?? 0),
						chip("最坏级别", st.worstSeverity || "—"),
						chip("候选目标", (st.killTargets || []).length),
					);
				}

				const errs = (st && st.probeErrors) || [];
				probeBox.style.display = errs.length ? "block" : "none";
				probeBox.textContent = errs.length
					? "⚠ 探针降级（R0）：" + errs.join("；") + "\n这表示判定能力不完整，不等于本机安全。"
					: "";

				renderKill();
				renderEvents(f);

				foot.textContent =
					"dataDir: " + ((f.status && f.status.dataDir) || "?") +
					" · API: " + API +
					" · 版本: " + ((f.status && f.status.version) || "?");
			});

			return { render: () => root, dispose: unbind };
		}

		/**
		 * 两个 slot 的注册。
		 * ⚠️ slot 名必须写成**字面量**：注入器在注入前用正则
		 *   /register\(\{[\s\S]*?name:\s*['"](slot...)['"]/
		 * 做骨架自检（缺字面量 → 直接阻断注入，理由"缺合法 name"）。
		 * 动态拼 slot 名即使宿主能跑通，也会被这道静态闸门拦下 —— 见
		 * test/client-bundle.test.mjs 里同名回归用例。
		 */
		function registerPanelSlot(ctx) {
			ctx.effect(
				() =>
					ctx.slots.inject("conversation.view", () =>
						ctx.slots.register({
							name: "conversation.view",
							id: "deskpet-guard-panel",
							order: 40,
							label: () => "守护",
							component: () => renderPanel(ctx),
						}),
					),
				"deskpet-guard: conversation.view",
			);
		}

		function registerPetSlot(ctx) {
			ctx.effect(
				() =>
					ctx.slots.inject("shell.overlay", () =>
						ctx.slots.register({
							name: "shell.overlay",
							id: "deskpet-guard-pet",
							order: 60,
							label: () => "桌宠",
							component: () => renderPet(ctx),
						}),
					),
				"deskpet-guard: shell.overlay",
			);
		}

		function apply(ctx) {
			// 两个 slot 各自独立 try：缺一个不该拖垮另一个（也就不会拖垮整块前端）
			try {
				registerPanelSlot(ctx);
			} catch (e) {
				/* 详情面板注册失败不影响桌宠 */
			}
			try {
				registerPetSlot(ctx);
			} catch (e) {
				/* 桌宠注册失败不影响详情面板 */
			}
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
