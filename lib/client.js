/**
 * dsh-turn-usage client bundle.
 *
 * Adds two readouts to the DeepSeek Harness web UI:
 *  1. Per-turn row (slot: conversation.chat.turnTail) under every completed
 *     turn: input tokens split into cache-miss / cache-hit, output tokens,
 *     and the estimated price of that single conversation.
 *  2. Session-level line (slot: conversation.composer.dock, next to the
 *     shipped StatsLine): totals over the loaded window plus estimated cost.
 *
 * Data comes straight from each AssistantMessageNode's provider-reported
 * `usage` (uncachedInputTokens / cacheReadTokens / cacheWriteTokens /
 * outputTokens) and `provenance.model` for pricing.
 *
 * Pricing is configurable: edit DEFAULT_PRICES below, or override at runtime
 * through localStorage["dsh.turnUsage.prices"] as a JSON object of the same
 * shape (merged over the defaults). Prices are CNY per 1M tokens.
 */
window.__ModuleLoader__.load({
  id: "dsh-turn-usage",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");

    // The built-in "产物" (deliverables) plugin shares the turn-tail chain; we
    // require its exported component so our elected entry can render it too.
    // Guarded: if the plugin is absent, we simply render the usage row alone.
    let deliverables = null;
    try {
      deliverables = require("@deepseek-ai/dsh-client-ui-deliverables");
    } catch (_e) {
      deliverables = null;
    }

    // ------------------------------------------------------------------ config
    const PRICE_STORAGE_KEY = "dsh.turnUsage.prices";
    const EDITOR_HEIGHT_KEY = "dsh.turnUsage.editorHeight";
    const MODEL_OVERRIDE_KEY = "dsh.turnUsage.model";
    const RECORDS_KEY = "dsh.turnUsage.records";

    // ------------------------------------------------------------ config store
    /**
     * Reactive config store. The source of truth is browser localStorage, but
     * every write is ALSO mirrored to the Host user-settings document
     * (namespace "dsh-turn-usage", registered by the host half) and restored
     * from it on load — the desktop app serves on a random port each launch,
     * which would otherwise wipe localStorage (per-origin) and reset the
     * config to defaults.
     */
    let settingsScope = null;
    // Host file-persistence channel (GET /api/dsh-turn-usage/config on boot,
    // token-guarded POST on every save). Null until the boot GET succeeds.
    let configToken = null;
    const configListeners = new Set();
    let configState = null;
    const CONFIG_KEYS = {
      prices: PRICE_STORAGE_KEY,
      model: MODEL_OVERRIDE_KEY,
      records: RECORDS_KEY
    };

    function readConfig() {
      try {
        return {
          prices: window.localStorage.getItem(PRICE_STORAGE_KEY) ?? "",
          model: window.localStorage.getItem(MODEL_OVERRIDE_KEY) ?? "",
          records: window.localStorage.getItem(RECORDS_KEY) ?? ""
        };
      } catch (_e) {
        return { prices: "", model: "", records: "" };
      }
    }

    function getConfigSnapshot() {
      configState = configState ?? readConfig();
      return configState;
    }

    function subscribeConfig(listener) {
      configListeners.add(listener);
      return () => configListeners.delete(listener);
    }

    /** Apply a partial config update to localStorage + notify (no scope write). */
    function applyLocalConfig(partial) {
      const next = Object.assign({}, getConfigSnapshot(), partial);
      configState = next;
      for (const field of Object.keys(partial)) {
        const key = CONFIG_KEYS[field];
        if (key === void 0) continue;
        const value = partial[field];
        try {
          if (value === "" || value === null || value === void 0) window.localStorage.removeItem(key);
          else window.localStorage.setItem(key, value);
        } catch (_e) { /* ignore storage errors */ }
      }
      for (const fn of [...configListeners]) fn();
    }

    /** Set one config field: localStorage + Host mirror + notify. */
    function setConfigField(field, value) {
      applyLocalConfig({ [field]: value });
      if (settingsScope !== null) {
        settingsScope.set(field, value ?? "").catch(() => {});
      }
      pushHostConfig();
    }

    /**
     * POST the whole config to the Host file-persistence route. Fire-and-
     * forget: on older hosts (route missing) this silently no-ops and the
     * plugin degrades to localStorage.
     */
    function pushHostConfig() {
      if (configToken === null) return;
      const snap = getConfigSnapshot();
      const body = { token: configToken };
      for (const field of Object.keys(CONFIG_KEYS)) {
        const value = snap[field];
        if (typeof value === "string") body[field] = value;
      }
      try {
        window.fetch("/api/dsh-turn-usage/config", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        }).catch(() => {});
      } catch (_e) { /* fetch unavailable */ }
    }

    /**
     * Boot-time load from the Host config file: apply any non-empty saved
     * fields into localStorage (source of truth for the sync store) and keep
     * the write token. Failures are silent — the plugin still works with
     * localStorage alone.
     */
    async function loadHostConfig() {
      try {
        const response = await window.fetch("/api/dsh-turn-usage/config", { method: "GET" });
        if (!response.ok) return;
        const data = await response.json();
        if (data === null || typeof data !== "object" || data.ok !== true) return;
        if (typeof data.token === "string" && data.token !== "") configToken = data.token;
        const saved = data.config;
        if (saved === null || typeof saved !== "object") return;
        const partial = {};
        for (const field of Object.keys(CONFIG_KEYS)) {
          const value = saved[field];
          if (typeof value === "string" && value !== "") partial[field] = value;
        }
        if (Object.keys(partial).length > 0) applyLocalConfig(partial);
      } catch (_e) { /* route missing on older hosts — degrade to localStorage */ }
    }

    // Prices in CNY per 1M tokens.
    //   input     : cache-MISS input (also billed for writing the cache)
    //   cacheRead : cache-HIT input
    //   cacheWrite: provider-reported cache write tokens
    //   output    : completion tokens
    //
    // Official DeepSeek rates (api-docs.deepseek.com/zh-cn/quick_start/pricing/):
    // current flat rates until 2026-08-16; from 2026-08-17 00:00 (Beijing)
    // peak/off-peak pricing starts — models with `switchAt` + `peak`/`offPeak`
    // rows switch automatically by Beijing time (peak 09:00-12:00, 14:00-18:00;
    // off-peak = half of peak).
    const DEFAULT_PRICES = {
      "deepseek-v4-flash": {
        input: 1.0, cacheRead: 0.02, cacheWrite: 1.0, output: 2.0,
        switchAt: "2026-08-17T00:00:00+08:00",
        offPeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 },
        peak: { input: 3.0, cacheRead: 0.10, cacheWrite: 3.0, output: 9.0 }
      },
      "deepseek-v4-pro": {
        input: 3.0, cacheRead: 0.025, cacheWrite: 3.0, output: 6.0,
        switchAt: "2026-08-17T00:00:00+08:00",
        offPeak: { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 },
        peak: { input: 9.0, cacheRead: 0.30, cacheWrite: 9.0, output: 27.0 }
      },
      // Legacy models, unchanged official rates.
      "deepseek-chat": { input: 2.0, cacheRead: 0.5, cacheWrite: 2.0, output: 8.0 },
      "deepseek-reasoner": { input: 4.0, cacheRead: 1.0, cacheWrite: 4.0, output: 16.0 },
      "*": { input: 1.0, cacheRead: 0.02, cacheWrite: 1.0, output: 2.0 }
    };

    function pricesTable() {
      const raw = getConfigSnapshot().prices;
      if (raw !== "") {
        try {
          const parsed = JSON.parse(raw);
          if (parsed !== null && typeof parsed === "object") {
            return Object.assign({}, DEFAULT_PRICES, parsed);
          }
        } catch (_e) {
          /* fall through to defaults */
        }
      }
      return DEFAULT_PRICES;
    }

    /** Current hour in Beijing (Asia/Shanghai); falls back to local hour. */
    function beijingHour(now) {
      try {
        const parts = new Intl.DateTimeFormat("en-US", {
          timeZone: "Asia/Shanghai",
          hour: "numeric",
          hour12: false
        }).formatToParts(now);
        const hour = parts.find((part) => part.type === "hour");
        return hour ? Number(hour.value) % 24 : now.getHours();
      } catch (_e) {
        return now.getHours();
      }
    }

    /** Peak window: 09:00-12:00 and 14:00-18:00 Beijing time. */
    function isPeakHour(hour) {
      return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18);
    }

    /**
     * Resolve a table entry to the flat row to bill with:
     * a `switchAt` + `peak`/`offPeak` shape picks by Beijing time once the
     * switch date has passed; anything else is used as-is.
     */
    function resolveRow(entry, now) {
      if (entry !== null && typeof entry === "object") {
        const peak = entry.peak;
        const offPeak = entry.offPeak;
        if (peak !== null && typeof peak === "object" && offPeak !== null && typeof offPeak === "object") {
          const switchAt = typeof entry.switchAt === "string" ? Date.parse(entry.switchAt) : NaN;
          if (isFinite(switchAt) && now.getTime() >= switchAt) {
            return isPeakHour(beijingHour(now)) ? peak : offPeak;
          }
        }
      }
      return entry;
    }

    /**
     * The harness client does not project the per-step model onto conversation
     * nodes, so pricing cannot derive it per call. The user-set override
     * (localStorage "dsh.turnUsage.model") takes precedence; otherwise the
     * per-node field is used when present, and finally "*" (see README).
     */
    function activeModel(nodeModel) {
      const override = getConfigSnapshot().model;
      if (override !== "") return override;
      return typeof nodeModel === "string" && nodeModel !== "" ? nodeModel : null;
    }

    /** Best price row for a model name, walking exact -> deepseek-* family -> "*". */
    function priceFor(model) {
      const table = pricesTable();
      const now = new Date();
      let entry;
      const resolved = activeModel(model);
      if (resolved !== null) {
        if (table[resolved] !== void 0) entry = table[resolved];
        else if (resolved.startsWith("deepseek-")) {
          const family = "deepseek-" + resolved.slice("deepseek-".length).split("-")[0];
          if (table[family] !== void 0) entry = table[family];
        }
      }
      if (entry === void 0) entry = table["*"];
      return resolveRow(entry, now);
    }

    // ------------------------------------------------------------------ folding
    /**
     * Fold assistant-step usage into buckets + last model.
     *
     * Reads the chat view nodes' `data.usage` (the projection state) rather
     * than the legacy nodes' final-node usage, so INTERRUPTED steps — whose
     * final node carries no usage field but whose `data.usage` may have been
     * set by a usage chunk before the stop — are still counted. Running steps
     * are excluded until their turn closes.
     * @param nodes - chat view nodes from `s.chat.nodes.values()`.
     * @param turn - optional turn number filter.
     * @param includeRunning - also fold still-running steps' usage-so-far
     *   (used for the live cost of the latest task).
     */
    function foldNodes(nodes, turn, includeRunning) {
      const acc = {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        model: null,
        steps: 0
      };
      for (const node of nodes) {
        if (node === null || typeof node !== "object" || node.kind !== "assistant-step") continue;
        const data = node.data;
        if (data === null || typeof data !== "object") continue;
        if (data.status === "running" && !includeRunning) continue;
        const nodeTurn = data.turn;
        if (turn !== void 0 && nodeTurn !== turn) continue;
        const u = data.usage;
        if (u === null || typeof u !== "object") continue;
        // Raw provider usage uses `inputTokens` (uncached); the durable
        // projection renames it `uncachedInputTokens` — accept either.
        acc.uncachedInputTokens += Number(u.inputTokens ?? u.uncachedInputTokens) || 0;
        acc.cacheReadTokens += Number(u.cacheReadTokens) || 0;
        acc.cacheWriteTokens += Number(u.cacheWriteTokens) || 0;
        acc.outputTokens += Number(u.outputTokens) || 0;
        acc.steps += 1;
        const finalNode = data.finalNode;
        if (finalNode !== null && typeof finalNode === "object") {
          const model = (finalNode.provenance !== null && typeof finalNode.provenance === "object" && finalNode.provenance.model) ||
            (finalNode.requestConfig !== null && typeof finalNode.requestConfig === "object" && finalNode.requestConfig.model);
          if (typeof model === "string") acc.model = model;
        }
      }
      return acc;
    }

    function totalTokens(fold) {
      return fold.uncachedInputTokens + fold.cacheReadTokens + fold.cacheWriteTokens + fold.outputTokens;
    }

    /** Estimated cost in CNY for one fold. */
    function costOf(fold) {
      const p = priceFor(fold.model);
      return (
        fold.uncachedInputTokens * p.input +
        fold.cacheReadTokens * p.cacheRead +
        fold.cacheWriteTokens * p.cacheWrite +
        fold.outputTokens * p.output
      ) / 1e6;
    }

    /** Cache-hit share of billed prompt-side input, rounded percent or null. */
    function hitPercent(fold) {
      const billed = fold.uncachedInputTokens + fold.cacheReadTokens + fold.cacheWriteTokens;
      if (billed <= 0) return null;
      return Math.round((fold.cacheReadTokens / billed) * 100);
    }

    /** Whole-log billed input (projection shape helper). */
    function billedInputTokens(usage) {
      return usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
    }

    /**
     * Latest task's estimated cost, live: the highest turn with usage data
     * (a running turn counts its usage-so-far); null when nothing has usage.
     */
    function latestTaskCost(store) {
      const nodes = store.values();
      let maxTurn = -1;
      for (const node of nodes) {
        if (node === null || typeof node !== "object" || node.kind !== "assistant-step") continue;
        const data = node.data;
        if (data === null || typeof data !== "object") continue;
        const u = data.usage;
        if (u !== null && typeof u === "object" && typeof data.turn === "number" && data.turn > maxTurn) {
          maxTurn = data.turn;
        }
      }
      if (maxTurn < 0) return null;
      const fold = foldNodes(nodes, maxTurn, true);
      return fold.steps > 0 && totalTokens(fold) > 0 ? costOf(fold) : null;
    }

    /** Compact duration replicating the built-in StatsLine format. */
    function formatDuration(ms) {
      const s = ms / 1e3;
      if (s < 60) return `${Math.round(s * 10) / 10}s`;
      const whole = Math.round(s);
      return `${Math.floor(whole / 60)}m${whole % 60}s`;
    }

    /** Decode-throughput figure replicating the built-in format. */
    function formatTokensPerSecond(tps) {
      const clamped = Math.max(0, tps);
      return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
    }

    /**
     * Window-scoped display totals fallback (mirrors the built-in deriveStats)
     * for assemblies without the `sessionStats` projection.
     */
    function deriveStatsFallback(nodes) {
      const turns = new Set();
      let steps = 0, llmMs = 0, toolMs = 0, ttftMs = 0, ttftSteps = 0, decodeMs = 0, decodeTokens = 0;
      for (const node of nodes) {
        if (node === null || typeof node !== "object") continue;
        if (node.kind === "assistant") {
          steps += 1;
          if (typeof node.turn === "number") turns.add(node.turn);
          const timing = node.timing;
          if (timing !== null && typeof timing === "object") {
            const start = timing.stepStartTime;
            const first = timing.firstTokenTime;
            const done = timing.completedTime;
            if (typeof start === "number" && typeof first === "number") {
              ttftMs += first - start;
              ttftSteps += 1;
            }
            if (typeof first === "number" && typeof done === "number") {
              decodeMs += done - first;
              const u = node.usage;
              if (u !== null && typeof u === "object" && typeof u.outputTokens === "number") decodeTokens += u.outputTokens;
            }
            if (typeof start === "number" && typeof done === "number") llmMs += done - start;
          }
        } else if (node.kind === "tool-result") {
          if (typeof node.callTime === "number" && typeof node.time === "number") toolMs += Math.max(0, node.time - node.callTime);
        }
      }
      return { turns: turns.size, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens };
    }

    // ------------------------------------------------------------------ format
    function formatTokens(n) {
      if (n < 1000) return String(Math.round(n));
      if (n < 1e6) {
        const v = n / 1e3;
        return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + "K";
      }
      const v = n / 1e6;
      return (v >= 100 ? v.toFixed(0) : v.toFixed(1)) + "M";
    }

    function formatCost(cny) {
      if (!isFinite(cny) || cny <= 0) return "¥0";
      if (cny >= 1) return "¥" + cny.toFixed(2);
      if (cny >= 0.01) return "¥" + cny.toFixed(4);
      // tiny amounts: keep 3 significant digits, trim trailing zeros
      return "¥" + cny.toPrecision(3).replace(/\.?0+$/, "");
    }

    // ------------------------------------------------------------------ styles
    const rowStyle = {
      display: "flex",
      alignItems: "center",
      flexWrap: "wrap",
      gap: "10px",
      fontSize: 11,
      lineHeight: "16px",
      color: "var(--dsw-alias-label-secondary)",
      fontVariantNumeric: "tabular-nums",
      padding: "2px 0"
    };
    const segStyle = { display: "inline-flex", alignItems: "baseline", gap: 4 };
    const labelStyle = { color: "var(--dsw-alias-label-tertiary)" };
    const numStyle = { color: "var(--dsw-alias-label-primary)", fontWeight: 500 };
    const costStyle = { color: "var(--dsw-state-business-primary, var(--dsw-alias-label-primary))", fontWeight: 600 };
    const sepStyle = { color: "var(--dsw-alias-label-tertiary)", opacity: 0.7 };

    function Seg({ label, children }) {
      return react_jsx_runtime.jsxs("span", { style: segStyle, children: [
        react_jsx_runtime.jsx("span", { style: labelStyle, children: label }),
        react_jsx_runtime.jsx("span", { style: numStyle, children })
      ] });
    }

    function Row({ children }) {
      const items = [];
      for (let i = 0; i < children.length; i++) {
        if (i > 0) items.push(react_jsx_runtime.jsx("span", { style: sepStyle, children: "·" }, "sep" + i));
        items.push(react_jsx_runtime.jsx(react.Fragment, { children: children[i] }, "seg" + i));
      }
      return react_jsx_runtime.jsx("div", { style: rowStyle, children: items });
    }

    function usageSegs(fold, opts) {
      const segs = [];
      const miss = fold.uncachedInputTokens;
      const hit = fold.cacheReadTokens;
      const write = fold.cacheWriteTokens;
      if (opts.showInput !== false) {
        if (miss > 0 || hit > 0) {
          segs.push(react_jsx_runtime.jsx(Seg, {
            label: "输入",
            children: react_jsx_runtime.jsxs("span", { children: [
              formatTokens(miss) + "未命中",
              hit > 0 ? react_jsx_runtime.jsxs("span", { children: [" ", formatTokens(hit), "命中"] }) : null
            ] })
          }, "in"));
          if (write > 0) segs.push(react_jsx_runtime.jsx(Seg, { label: "写缓存", children: formatTokens(write) }, "write"));
        }
      }
      if (fold.outputTokens > 0 || opts.showEmptyOutput) {
        segs.push(react_jsx_runtime.jsx(Seg, { label: "输出", children: formatTokens(fold.outputTokens) }, "out"));
      }
      const hitPct = hitPercent(fold);
      if (hitPct !== null && opts.showHit !== false) {
        segs.push(react_jsx_runtime.jsx(Seg, { label: "命中率", children: hitPct + "%" }, "hit"));
      }
      if (opts.showCost !== false) {
        const cost = costOf(fold);
        segs.push(react_jsx_runtime.jsx("span", {
          style: Object.assign({}, segStyle, { color: "var(--dsw-alias-label-tertiary)" }),
          children: react_jsx_runtime.jsxs("span", { children: [
            "费用", " ",
            react_jsx_runtime.jsx("span", { style: costStyle, children: "≈" + formatCost(cost) })
          ] })
        }, "cost"));
      }
      return segs;
    }

    // ------------------------------------------------------------- turn row
    /**
     * One compact line under each completed turn: usage + cost.
     *
     * The `conversation.chat.turnTail` chain elects a SINGLE entry, and the
     * built-in deliverables plugin ("产物") claims the same chain when a turn
     * produced files. This entry therefore runs first (priority -1) and
     * COMPOSES the produced-files card itself (via the deliverables plugin's
     * exported component), so the usage row and the 产物 card both render.
     */
    const TurnUsageRow = react.memo(function TurnUsageRow(props) {
      const turnLoc = props.turn !== null && typeof props.turn === "object" ? props.turn : null;
      const turnNum = turnLoc ? turnLoc.turn : props.turn;
      // Re-render when the price config changes (host mirror on load, or edits),
      // so per-turn costs recompute against the current table.
      react.useSyncExternalStore(subscribeConfig, getConfigSnapshot);
      // `legacy.nodes` is a stable array that changes when steps finalize (the
      // re-render trigger); `s.chat.nodes` is a stable live store read fresh
      // inside the memo (its values() reflects later flushes).
      const legacy = props.useSession((s) => s.chat.legacy.nodes);
      const store = props.useSession((s) => s.chat.nodes);
      const fold = react.useMemo(() => foldNodes(store.values(), turnNum), [store, legacy, turnNum]);
      const produced = react.useMemo(() => {
        if (deliverables === null || typeof deliverables.producedForClosing !== "function") return [];
        if (turnLoc === null || turnLoc.data === void 0 || typeof turnLoc.data.get !== "function") return [];
        const data = turnLoc.data.get("deliverables");
        return data === void 0 ? [] : deliverables.producedForClosing(data, props.seq);
      }, [turnLoc, props.seq]);
      // 真实模型：优先取该轮内 header 发布的值，其次 turn/start 继承的值，
      // 再次该轮 fold 的模型，最后回退到配置里的模型下拉覆盖值。
      const modelInfo = turnLoc !== null && turnLoc.data !== void 0 && typeof turnLoc.data.get === "function"
        ? (turnLoc.data.get("turn-usage-header") ?? turnLoc.data.get("turn-usage-model")) : void 0;
      const effectiveModel = (() => {
        if (modelInfo !== null && typeof modelInfo === "object" && typeof modelInfo.model === "string" && modelInfo.model !== "") return modelInfo.model;
        if (typeof fold.model === "string" && fold.model !== "") return fold.model;
        const configured = getConfigSnapshot().model;
        return typeof configured === "string" && configured !== "" ? configured : null;
      })();
      const priced = react.useMemo(() => (
        effectiveModel !== fold.model ? Object.assign({}, fold, { model: effectiveModel }) : fold
      ), [fold, effectiveModel]);
      const hasUsage = fold.steps > 0 && totalTokens(fold) > 0;
      // 记录该轮消耗（模型 + 四个桶 + 费用）到 localStorage
      react.useEffect(() => {
        if (!hasUsage) return;
        try {
          const cost = costOf(priced);
          const raw = getConfigSnapshot().records;
          let records = [];
          try {
            const parsed = raw !== "" ? JSON.parse(raw) : [];
            if (Array.isArray(parsed)) records = parsed;
          } catch (_e) { /* start fresh */ }
          const rec = {
            sessionId: props.sessionId,
            turn: turnNum,
            model: effectiveModel,
            miss: fold.uncachedInputTokens,
            hit: fold.cacheReadTokens,
            write: fold.cacheWriteTokens,
            out: fold.outputTokens,
            cost,
            time: Date.now()
          };
          const idx = records.findIndex((r) => r !== null && typeof r === "object" && r.turn === turnNum && r.sessionId === props.sessionId);
          if (idx >= 0) records[idx] = rec;
          else records.push(rec);
          setConfigField("records", JSON.stringify(records));
        } catch (_e) { /* ignore storage errors */ }
      }, [turnNum, priced, hasUsage, effectiveModel, props.sessionId]);
      if (!hasUsage && produced.length === 0) return null;
      const kids = [];
      if (hasUsage) {
        const segs = [];
        if (effectiveModel !== null) {
          segs.push(react_jsx_runtime.jsx(Seg, { label: "模型", children: effectiveModel }, "model"));
        }
        segs.push(...usageSegs(priced, { showHit: false }));
        kids.push(react_jsx_runtime.jsx(Row, { children: segs }, "usage"));
      }
      if (produced.length > 0 && deliverables !== null && typeof deliverables.ProducedFiles === "function") {
        kids.push(react_jsx_runtime.jsx(deliverables.ProducedFiles, {
          matched: produced,
          openFile: props.openFile,
          isLoopback: props.isLoopback,
          useHostDescription: props.useHostDescription,
          t: props.tDeliv
        }, "produced"));
      }
      return react_jsx_runtime.jsxs("div", { children: kids });
    });

    // ------------------------------------------------------- merged stats line
    /**
     * Shadows the built-in StatsLine (same cell id "stats", lower priority) and
     * renders its full content — turn/step counts, durations, TTFT / tok/s,
     * cache-hit share, input/output tokens — with the LATEST task's estimated
     * cost appended inside the token-count group.
     */
    const statsLineRootStyle = {
      textAlign: "center",
      maxWidth: "var(--dsh-chat-content-width)",
      boxSizing: "border-box",
      width: "100%",
      padding: "4px calc(var(--dsh-composer-side-clearance) + 16px) 0px",
      color: "var(--dsw-alias-label-tertiary)",
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
      margin: "0 auto",
      fontSize: 12,
      lineHeight: "20px",
      display: "block",
      overflow: "hidden"
    };
    const statsLineSepStyle = { color: "var(--dsw-alias-separator-primary)", margin: "0 10px" };

    const MergedStatsLine = react.memo(function MergedStatsLine({ useSession, useProjection, t }) {
      // Re-render when the price config changes so the latest-task cost recomputes.
      react.useSyncExternalStore(subscribeConfig, getConfigSnapshot);
      const settledNodes = useSession((s) => s.chat.legacy.nodes);
      const store = useSession((s) => s.chat.nodes);
      // `partial` changes on every stream chunk while a turn runs — the live
      // trigger so the latest-task cost updates in real time.
      const partial = useSession((s) => s.partial);
      const usage = useProjection("tokenUsage");
      const projected = useProjection("sessionStats");

      const latestCost = react.useMemo(() => latestTaskCost(store), [store, settledNodes, partial]);
      const stats = react.useMemo(() => projected ?? deriveStatsFallback(settledNodes), [projected, settledNodes]);

      const groups = [];
      if (stats.steps > 0) {
        groups.push(t("stats.counts", { turns: stats.turns, steps: stats.steps }));
        const durations = [];
        if (stats.llmMs > 0) durations.push(t("stats.llm", { duration: formatDuration(stats.llmMs) }));
        if (stats.toolMs > 0) durations.push(t("stats.toolCall", { duration: formatDuration(stats.toolMs) }));
        if (durations.length > 0) groups.push(durations.join(" · "));
        const speeds = [];
        if (stats.ttftSteps > 0) speeds.push(t("stats.ttftAverage", { duration: formatDuration(stats.ttftMs / stats.ttftSteps) }));
        if (stats.decodeMs > 0) speeds.push(t("stats.tokensPerSecond", { throughput: formatTokensPerSecond(stats.decodeTokens / (stats.decodeMs / 1e3)) }));
        if (speeds.length > 0) groups.push(speeds.join(" · "));
      }
      if (usage !== void 0 && (billedInputTokens(usage) > 0 || usage.outputTokens > 0)) {
        const cacheHit = hitPercent(usage);
        if (cacheHit !== null) groups.push(t("stats.cacheHit", { percent: cacheHit }));
        let tokens = t("stats.tokens", {
          input: formatTokens(billedInputTokens(usage)),
          output: formatTokens(usage.outputTokens)
        });
        if (latestCost !== null) tokens += " · 最新任务累计费用 ≈" + formatCost(latestCost);
        groups.push(tokens);
      } else if (latestCost !== null) {
        groups.push("最新任务累计费用 ≈" + formatCost(latestCost));
      }

      if (groups.length === 0) return null;
      const line = groups.join(" | ");
      const rootRef = react.useRef(null);
      const [truncated, setTruncated] = react.useState(false);
      react.useLayoutEffect(() => {
        const el = rootRef.current;
        if (el === null) return;
        const measure = () => setTruncated(el.scrollWidth > el.clientWidth);
        measure();
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
      }, [line]);
      return react_jsx_runtime.jsx("div", {
        ref: rootRef,
        style: statsLineRootStyle,
        title: truncated ? line : void 0,
        children: groups.map((group, i) => react_jsx_runtime.jsxs(react.Fragment, {
          children: [
            i > 0 && react_jsx_runtime.jsxs(react_jsx_runtime.Fragment, {
              children: [
                react_jsx_runtime.jsx("span", { style: statsLineSepStyle, "aria-hidden": true, children: "|" }),
                " "
              ]
            }),
            react_jsx_runtime.jsx("span", { children: group })
          ]
        }, group))
      });
    });

    // ------------------------------------------------------- settings row
    /** Simple centered modal dialog styled with the app's design tokens. */
    function Dialog({ title, children }) {
      return react_jsx_runtime.jsxs("div", {
        style: {
          position: "fixed",
          inset: 0,
          zIndex: 1000,
          background: "rgba(0, 0, 0, 0.45)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center"
        },
        children: [
          react_jsx_runtime.jsxs("div", {
            style: {
              boxSizing: "border-box",
              width: 380,
              maxWidth: "calc(100vw - 32px)",
              background: "var(--dsw-specific-menu, var(--dsw-alias-bg-layer-3))",
              border: "1px solid var(--dsw-alias-border-inverted)",
              borderRadius: 12,
              boxShadow: "var(--dsw-shadow-lv3)",
              padding: "16px 18px",
              color: "var(--dsw-alias-label-primary)",
              fontSize: 13
            },
            children: [
              react_jsx_runtime.jsx("div", {
                style: { fontSize: 14, fontWeight: 500, lineHeight: "22px", marginBottom: 12 },
                children: title
              }),
              children
            ]
          })
        ]
      });
    }

    /** One labeled form row inside a dialog. */
    function Field({ label, children }) {
      return react_jsx_runtime.jsxs("div", {
        style: { marginBottom: 10 },
        children: [
          react_jsx_runtime.jsx("div", {
            style: { fontSize: 12, color: "var(--dsw-alias-label-secondary)", lineHeight: "18px", marginBottom: 4 },
            children: label
          }),
          children
        ]
      });
    }

    /** Settings -> General row: edit the price table as JSON (saved to localStorage). */
    function PriceSettingsRow() {
      const [text, setText] = react.useState(() => JSON.stringify(pricesTable(), null, 2));
      const [status, setStatus] = react.useState(null);
      const [model, setModel] = react.useState(() => getConfigSnapshot().model || "");
      const [showAdd, setShowAdd] = react.useState(false);
      const [showEdit, setShowEdit] = react.useState(false);
      const [showRecords, setShowRecords] = react.useState(false);
      const [recordsList, setRecordsList] = react.useState([]);
      const [addForm, setAddForm] = react.useState({ name: "", cacheRead: "", cacheMiss: "", cacheWrite: "", output: "" });
      const [editForm, setEditForm] = react.useState({ model: "", cacheRead: "", cacheMiss: "", cacheWrite: "", output: "" });
      const [dialogMsg, setDialogMsg] = react.useState(null);
      const areaRef = react.useRef(null);
      const editedRef = react.useRef(false);
      // Re-render on config changes (host mirror on load, or edits elsewhere)
      // and refresh the editor text/model when the config changed externally.
      const cfg = react.useSyncExternalStore(subscribeConfig, getConfigSnapshot);
      react.useEffect(() => {
        if (editedRef.current) return;
        setText(cfg.prices === "" ? JSON.stringify(DEFAULT_PRICES, null, 2) : cfg.prices);
        setModel(cfg.model);
      }, [cfg]);

      // Restore a previously saved editor height; persist manual resizes.
      react.useLayoutEffect(() => {
        const el = areaRef.current;
        if (el === null) return;
        try {
          const saved = Number(window.localStorage.getItem(EDITOR_HEIGHT_KEY));
          if (isFinite(saved) && saved >= 120) el.style.height = saved + "px";
        } catch (_e) { /* ignore */ }
        if (typeof ResizeObserver === "undefined") return;
        const observer = new ResizeObserver(() => {
          try {
            window.localStorage.setItem(EDITOR_HEIGHT_KEY, String(el.offsetHeight));
          } catch (_e) { /* ignore */ }
        });
        observer.observe(el);
        return () => observer.disconnect();
      }, []);

      /** Validate one model row: flat {input,..,output} or switchAt+peak/offPeak. */
      const validateRow = (key, row) => {
        if (row === null || typeof row !== "object" || Array.isArray(row)) throw new Error("行 " + key + " 需要是 JSON 对象");
        const targets = [];
        if (row.peak !== void 0 || row.offPeak !== void 0) {
          if (row.peak === null || typeof row.peak !== "object") throw new Error(key + ".peak 需要是对象");
          if (row.offPeak === null || typeof row.offPeak !== "object") throw new Error(key + ".offPeak 需要是对象");
          targets.push(row.peak, row.offPeak);
        } else {
          targets.push(row);
        }
        for (const target of targets) {
          for (const field of ["input", "cacheRead", "cacheWrite", "output"]) {
            if (typeof target[field] !== "number" || !isFinite(target[field]) || target[field] < 0) {
              throw new Error(key + "." + field + " 必须是 >= 0 的数字");
            }
          }
        }
        if (row.switchAt !== void 0 && (typeof row.switchAt !== "string" || isNaN(Date.parse(row.switchAt)))) {
          throw new Error(key + ".switchAt 需要是日期字符串，例如 2026-08-17T00:00:00+08:00");
        }
      };

      const save = () => {
        try {
          const parsed = JSON.parse(text);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            setStatus({ ok: false, msg: "需要 JSON 对象，例如 {\"deepseek-v4-flash\": {...}}" });
            return;
          }
          for (const key of Object.keys(parsed)) validateRow(key, parsed[key]);
          setConfigField("prices", JSON.stringify(parsed));
          const trimmedModel = model.trim();
          setConfigField("model", trimmedModel);
          editedRef.current = false;
          setStatus({ ok: true, msg: "已保存 ✓（价格行与累计费用即时生效）" });
        } catch (error) {
          setStatus({ ok: false, msg: "JSON 无效：" + (error instanceof Error ? error.message : String(error)) });
        }
      };

      const reset = () => {
        setConfigField("prices", "");
        setConfigField("model", "");
        setText(JSON.stringify(DEFAULT_PRICES, null, 2));
        setModel("");
        editedRef.current = false;
        setStatus({ ok: true, msg: "已恢复默认价格 ✓" });
      };

      /** Parse the current textarea JSON into a table object, or null when invalid. */
      const parseTable = () => {
        try {
          const parsed = JSON.parse(text);
          if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
        } catch (_e) { /* fall through */ }
        return null;
      };

      /** Validate the four dialog price fields; null + message on error. */
      const parsePrices = (form) => {
        const nums = {};
        for (const [key, label] of [["cacheMiss", "缓存未命中"], ["cacheRead", "缓存命中"], ["cacheWrite", "缓存写入"], ["output", "输出"]]) {
          const raw = String(form[key]).trim();
          if (raw === "") {
            setDialogMsg({ ok: false, msg: "请填写「" + label + "」价格" });
            return null;
          }
          const value = Number(raw);
          if (!isFinite(value) || value < 0) {
            setDialogMsg({ ok: false, msg: "「" + label + "」需要是 >= 0 的数字" });
            return null;
          }
          nums[key] = value;
        }
        return nums;
      };

      /** Write a table to config store + textarea, close nothing, report status. */
      const commitTable = (table, msg) => {
        const json = JSON.stringify(table, null, 2);
        setConfigField("prices", json);
        setText(json);
        editedRef.current = false;
        setStatus({ ok: true, msg });
      };

      const openAdd = () => {
        setAddForm({ name: "", cacheRead: "", cacheMiss: "", cacheWrite: "", output: "" });
        setDialogMsg(null);
        setShowAdd(true);
      };

      const saveAdd = () => {
        const table = parseTable();
        if (table === null) {
          setDialogMsg({ ok: false, msg: "价格表 JSON 无效，请先修复文本框内容再添加" });
          return;
        }
        const name = addForm.name.trim();
        if (name === "") {
          setDialogMsg({ ok: false, msg: "请填写模型名" });
          return;
        }
        const nums = parsePrices(addForm);
        if (nums === null) return;
        if (table[name] !== void 0) {
          setDialogMsg({ ok: false, msg: "模型 " + name + " 已存在，请用「修改模型」" });
          return;
        }
        table[name] = { input: nums.cacheMiss, cacheRead: nums.cacheRead, cacheWrite: nums.cacheWrite, output: nums.output };
        commitTable(table, "已添加模型 " + name + " ✓");
        setShowAdd(false);
      };

      const openEdit = () => {
        const table = parseTable();
        const keys = table === null ? [] : Object.keys(table);
        const first = keys.length > 0 ? keys[0] : "";
        loadEditForm(table, first);
        setDialogMsg(null);
        setShowEdit(true);
      };

      const loadEditForm = (table, selected) => {
        const row = table !== null && selected !== "" && table[selected] !== void 0 ? table[selected] : null;
        if (row !== null && typeof row === "object") {
          setEditForm({
            model: selected,
            cacheRead: String(row.cacheRead ?? ""),
            cacheMiss: String(row.input ?? ""),
            cacheWrite: String(row.cacheWrite ?? ""),
            output: String(row.output ?? "")
          });
        } else {
          setEditForm({ model: selected, cacheRead: "", cacheMiss: "", cacheWrite: "", output: "" });
        }
      };

      const saveEdit = () => {
        const table = parseTable();
        if (table === null) {
          setDialogMsg({ ok: false, msg: "价格表 JSON 无效，请先修复文本框内容再修改" });
          return;
        }
        const selected = editForm.model;
        if (selected === "" || table[selected] === void 0) {
          setDialogMsg({ ok: false, msg: "请选择要修改的模型" });
          return;
        }
        const nums = parsePrices(editForm);
        if (nums === null) return;
        const existing = table[selected];
        const next = existing !== null && typeof existing === "object" ? Object.assign({}, existing) : {};
        next.input = nums.cacheMiss;
        next.cacheRead = nums.cacheRead;
        next.cacheWrite = nums.cacheWrite;
        next.output = nums.output;
        table[selected] = next;
        commitTable(table, "已更新模型 " + selected + " ✓");
        setShowEdit(false);
      };

      const openRecords = () => {
        let records = [];
        try {
          const raw = getConfigSnapshot().records;
          const parsed = raw !== "" ? JSON.parse(raw) : [];
          if (Array.isArray(parsed)) records = parsed;
        } catch (_e) { /* empty */ }
        setRecordsList(records);
        setDialogMsg(null);
        setShowRecords(true);
      };

      const clearRecords = () => {
        setConfigField("records", "");
        setRecordsList([]);
      };

      const copyRecordsCsv = () => {
        try {
          const header = ["sessionId", "turn", "model", "miss", "hit", "write", "out", "cost", "time"];
          const lines = [header.join(",")];
          for (const rec of recordsList) {
            if (rec === null || typeof rec !== "object") continue;
            const vals = header.map((k) => {
              const v = rec[k];
              const s = v === null || v === void 0 ? "" : String(v);
              return s.includes(",") || s.includes('"') ? '"' + s.replaceAll('"', '""') + '"' : s;
            });
            lines.push(vals.join(","));
          }
          window.navigator.clipboard.writeText(lines.join("\n")).then(() => {
            setDialogMsg({ ok: true, msg: "CSV 已复制到剪贴板 ✓" });
          }).catch(() => {
            setDialogMsg({ ok: false, msg: "复制失败，请手动选择复制" });
          });
        } catch (_e) {
          setDialogMsg({ ok: false, msg: "复制失败：" + (_e instanceof Error ? _e.message : String(_e)) });
        }
      };

      const rowStyle = {
        borderBottom: "1px solid var(--dsw-alias-border-l2)",
        padding: "16px 0",
        display: "flex",
        gap: "12px"
      };
      const textStyle = {
        flex: "1",
        minWidth: "0",
        display: "flex",
        flexDirection: "column",
        gap: "6px"
      };
      const titleStyle = { color: "var(--dsw-alias-label-primary)", fontSize: 14, lineHeight: "22px" };
      const descStyle = { color: "var(--dsw-alias-label-tertiary)", fontSize: 12, lineHeight: "18px" };
      const areaStyle = {
        boxSizing: "border-box",
        width: "100%",
        minHeight: 360,
        resize: "vertical",
        background: "var(--dsw-alias-bg-base)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        padding: "8px 10px",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        fontSize: 12,
        lineHeight: "18px"
      };
      const btnStyle = {
        background: "var(--dsw-alias-bg-module-platform)",
        color: "var(--dsw-alias-label-primary)",
        border: "none",
        borderRadius: 8,
        height: 28,
        padding: "0 12px",
        fontSize: 13,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 6
      };
      const primaryBtnStyle = Object.assign({}, btnStyle, {
        background: "var(--dsw-alias-state-business-primary)",
        color: "#fff"
      });
      const btnRowStyle = { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" };
      const statusStyle = {
        fontSize: 12,
        lineHeight: "18px",
        color: status === null ? "var(--dsw-alias-label-tertiary)"
          : status.ok ? "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))"
          : "var(--dsw-alias-state-error-primary)"
      };
      const modelRowStyle = { display: "flex", alignItems: "center", gap: "8px" };
      const modelInputStyle = {
        boxSizing: "border-box",
        width: 220,
        height: 30,
        background: "var(--dsw-alias-bg-base)",
        color: "var(--dsw-alias-label-primary)",
        border: "1px solid var(--dsw-alias-border-l2)",
        borderRadius: 8,
        padding: "0 10px",
        fontSize: 13
      };
      const dialogInputStyle = Object.assign({}, modelInputStyle, { width: "100%" });
      const dialogMsgStyle = {
        fontSize: 12,
        lineHeight: "18px",
        marginTop: 4,
        color: dialogMsg !== null && dialogMsg.ok
          ? "var(--dsw-alias-state-success-primary, var(--dsw-alias-label-secondary))"
          : "var(--dsw-alias-state-error-primary)"
      };
      const dialogBtnRowStyle = { display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 };
      const cellStyle = {
        padding: "4px 8px",
        color: "var(--dsw-alias-label-primary)",
        borderTop: "1px solid var(--dsw-alias-border-l1)",
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums"
      };

      const editTable = parseTable();
      const editKeys = editTable === null ? [] : Object.keys(editTable);
      const editRow = editTable !== null && editForm.model !== "" && editTable[editForm.model] !== void 0
        ? editTable[editForm.model] : null;
      const editHasPeak = editRow !== null && typeof editRow === "object" && (editRow.peak !== void 0 || editRow.offPeak !== void 0);
      // 当前模型下拉：价格表里的全部模型；若已选模型不在表中则额外保留为一项
      const modelKeys = editTable === null ? [] : Object.keys(editTable);
      const modelOptions = model !== "" && !modelKeys.includes(model) ? [model, ...modelKeys] : modelKeys;

      return react_jsx_runtime.jsxs(react.Fragment, {
        children: [
          react_jsx_runtime.jsx("div", {
            style: rowStyle,
            children: react_jsx_runtime.jsxs("div", {
              style: textStyle,
              children: [
                react_jsx_runtime.jsx("div", { style: titleStyle, children: "Token 价格表（dsh-turn-usage）" }),
                react_jsx_runtime.jsx("div", {
                  style: descStyle,
                  children: "每百万 token 价格（人民币 ¥）。可用「添加模型/修改模型」按钮操作，或直接编辑 JSON：模型名 -> { input: 未命中输入, cacheRead: 缓存命中, cacheWrite: 写缓存, output: 输出 }。需要峰谷自动切换时用 { switchAt, peak, offPeak } 结构（北京时间高峰 09:00-12:00、14:00-18:00，空闲为高峰一半）。窗口高度可拖动，会自动记住。"
                }),
                react_jsx_runtime.jsxs("div", {
                  style: modelRowStyle,
                  children: [
                    react_jsx_runtime.jsx("span", { style: descStyle, children: "当前模型（用于定价匹配，留空=按 * 兜底价）：" }),
                    react_jsx_runtime.jsx("select", {
                      style: modelInputStyle,
                      value: model,
                      onChange: (event) => {
                        const next = event.target.value;
                        setModel(next);
                        setConfigField("model", next);
                        setStatus(null);
                      },
                      children: [
                        react_jsx_runtime.jsx("option", { value: "", children: "（留空，按 * 兜底价）" }),
                        modelOptions.map((key) => react_jsx_runtime.jsx("option", { value: key, children: key }, key))
                      ]
                    })
                  ]
                }),
                react_jsx_runtime.jsx("textarea", {
                  ref: areaRef,
                  style: areaStyle,
                  value: text,
                  spellCheck: false,
                  onChange: (event) => {
                    editedRef.current = true;
                    setText(event.target.value);
                    setStatus(null);
                  }
                }),
                react_jsx_runtime.jsxs("div", {
                  style: btnRowStyle,
                  children: [
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: primaryBtnStyle,
                      onClick: openAdd,
                      children: "添加模型"
                    }),
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: btnStyle,
                      onClick: openEdit,
                      children: "修改模型"
                    }),
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: btnStyle,
                      onClick: openRecords,
                      children: "消耗记录"
                    }),
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: btnStyle,
                      onClick: save,
                      children: "保存 JSON"
                    }),
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: btnStyle,
                      onClick: reset,
                      children: "恢复默认"
                    }),
                    react_jsx_runtime.jsx("span", { style: statusStyle, children: status === null ? "修改保存后，对话下方的费用行会立即按新价格重新计算。" : status.msg })
                  ]
                })
              ]
            })
          }),
          showAdd && react_jsx_runtime.jsx(Dialog, {
            title: "添加模型价格",
            children: react_jsx_runtime.jsxs(react.Fragment, {
              children: [
                react_jsx_runtime.jsx(Field, {
                  label: "模型名（如 deepseek-v4-flash）",
                  children: react_jsx_runtime.jsx("input", {
                    style: dialogInputStyle,
                    value: addForm.name,
                    placeholder: "deepseek-v4-flash",
                    spellCheck: false,
                    onChange: (event) => {
                      setAddForm(Object.assign({}, addForm, { name: event.target.value }));
                      setDialogMsg(null);
                    }
                  })
                }),
                react_jsx_runtime.jsx(Field, {
                  label: "缓存命中（¥ / Mtokens）",
                  children: react_jsx_runtime.jsx("input", {
                    type: "number",
                    min: 0,
                    step: "any",
                    style: dialogInputStyle,
                    value: addForm.cacheRead,
                    onChange: (event) => {
                      setAddForm(Object.assign({}, addForm, { cacheRead: event.target.value }));
                      setDialogMsg(null);
                    }
                  })
                }),
                react_jsx_runtime.jsx(Field, {
                  label: "缓存未命中（¥ / Mtokens）",
                  children: react_jsx_runtime.jsx("input", {
                    type: "number",
                    min: 0,
                    step: "any",
                    style: dialogInputStyle,
                    value: addForm.cacheMiss,
                    onChange: (event) => {
                      setAddForm(Object.assign({}, addForm, { cacheMiss: event.target.value }));
                      setDialogMsg(null);
                    }
                  })
                }),
                react_jsx_runtime.jsx(Field, {
                  label: "缓存写入（¥ / Mtokens）",
                  children: react_jsx_runtime.jsx("input", {
                    type: "number",
                    min: 0,
                    step: "any",
                    style: dialogInputStyle,
                    value: addForm.cacheWrite,
                    onChange: (event) => {
                      setAddForm(Object.assign({}, addForm, { cacheWrite: event.target.value }));
                      setDialogMsg(null);
                    }
                  })
                }),
                react_jsx_runtime.jsx(Field, {
                  label: "输出（¥ / Mtokens）",
                  children: react_jsx_runtime.jsx("input", {
                    type: "number",
                    min: 0,
                    step: "any",
                    style: dialogInputStyle,
                    value: addForm.output,
                    onChange: (event) => {
                      setAddForm(Object.assign({}, addForm, { output: event.target.value }));
                      setDialogMsg(null);
                    }
                  })
                }),
                dialogMsg !== null && react_jsx_runtime.jsx("div", { style: dialogMsgStyle, children: dialogMsg.msg }),
                react_jsx_runtime.jsxs("div", {
                  style: dialogBtnRowStyle,
                  children: [
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: btnStyle,
                      onClick: () => setShowAdd(false),
                      children: "取消"
                    }),
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: primaryBtnStyle,
                      onClick: saveAdd,
                      children: "保存"
                    })
                  ]
                })
              ]
            })
          }),
          showEdit && react_jsx_runtime.jsx(Dialog, {
            title: "修改模型价格",
            children: react_jsx_runtime.jsxs(react.Fragment, {
              children: [
                react_jsx_runtime.jsx(Field, {
                  label: "选择模型",
                  children: react_jsx_runtime.jsx("select", {
                    style: dialogInputStyle,
                    value: editForm.model,
                    onChange: (event) => {
                      loadEditForm(editTable, event.target.value);
                      setDialogMsg(null);
                    },
                    children: editKeys.map((key) => react_jsx_runtime.jsx("option", { value: key, children: key }, key))
                  })
                }),
                editHasPeak && react_jsx_runtime.jsx("div", {
                  style: Object.assign({}, descStyle, { marginBottom: 8 }),
                  children: "该模型配置了峰谷结构（switchAt/peak/offPeak），本次修改仅更新平铺价，峰谷价不变。"
                }),
                react_jsx_runtime.jsx(Field, {
                  label: "缓存命中（¥ / Mtokens）",
                  children: react_jsx_runtime.jsx("input", {
                    type: "number",
                    min: 0,
                    step: "any",
                    style: dialogInputStyle,
                    value: editForm.cacheRead,
                    onChange: (event) => {
                      setEditForm(Object.assign({}, editForm, { cacheRead: event.target.value }));
                      setDialogMsg(null);
                    }
                  })
                }),
                react_jsx_runtime.jsx(Field, {
                  label: "缓存未命中（¥ / Mtokens）",
                  children: react_jsx_runtime.jsx("input", {
                    type: "number",
                    min: 0,
                    step: "any",
                    style: dialogInputStyle,
                    value: editForm.cacheMiss,
                    onChange: (event) => {
                      setEditForm(Object.assign({}, editForm, { cacheMiss: event.target.value }));
                      setDialogMsg(null);
                    }
                  })
                }),
                react_jsx_runtime.jsx(Field, {
                  label: "缓存写入（¥ / Mtokens）",
                  children: react_jsx_runtime.jsx("input", {
                    type: "number",
                    min: 0,
                    step: "any",
                    style: dialogInputStyle,
                    value: editForm.cacheWrite,
                    onChange: (event) => {
                      setEditForm(Object.assign({}, editForm, { cacheWrite: event.target.value }));
                      setDialogMsg(null);
                    }
                  })
                }),
                react_jsx_runtime.jsx(Field, {
                  label: "输出（¥ / Mtokens）",
                  children: react_jsx_runtime.jsx("input", {
                    type: "number",
                    min: 0,
                    step: "any",
                    style: dialogInputStyle,
                    value: editForm.output,
                    onChange: (event) => {
                      setEditForm(Object.assign({}, editForm, { output: event.target.value }));
                      setDialogMsg(null);
                    }
                  })
                }),
                dialogMsg !== null && react_jsx_runtime.jsx("div", { style: dialogMsgStyle, children: dialogMsg.msg }),
                react_jsx_runtime.jsxs("div", {
                  style: dialogBtnRowStyle,
                  children: [
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: btnStyle,
                      onClick: () => setShowEdit(false),
                      children: "取消"
                    }),
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: primaryBtnStyle,
                      onClick: saveEdit,
                      children: "保存"
                    })
                  ]
                })
              ]
            })
          }),
          showRecords && react_jsx_runtime.jsx(Dialog, {
            title: "消耗记录（按轮次 · 模型 · token · 费用）",
            children: react_jsx_runtime.jsxs(react.Fragment, {
              children: [
                recordsList.length === 0
                  ? react_jsx_runtime.jsx("div", { style: descStyle, children: "暂无记录。完成一轮对话后，这里会记录每轮的模型、四个 token 桶和估算费用。" })
                  : react_jsx_runtime.jsx("div", {
                    style: {
                      maxHeight: 320,
                      overflowY: "auto",
                      border: "1px solid var(--dsw-alias-border-l2)",
                      borderRadius: 8,
                      background: "var(--dsw-alias-bg-base)"
                    },
                    children: react_jsx_runtime.jsx("table", {
                      style: { borderCollapse: "collapse", width: "100%", fontSize: 12, lineHeight: "18px" },
                      children: [
                        react_jsx_runtime.jsx("thead", {
                          children: react_jsx_runtime.jsx("tr", {
                            children: ["轮", "模型", "未命中", "命中", "写入", "输出", "费用"].map((h) => react_jsx_runtime.jsx("th", {
                              style: {
                                position: "sticky",
                                top: 0,
                                background: "var(--dsw-alias-bg-module-platform)",
                                color: "var(--dsw-alias-label-secondary)",
                                padding: "4px 8px",
                                textAlign: "left",
                                fontWeight: 500,
                                whiteSpace: "nowrap"
                              },
                              children: h
                            }, h))
                          })
                        }),
                        react_jsx_runtime.jsx("tbody", {
                          children: recordsList.map((rec, i) => {
                            if (rec === null || typeof rec !== "object") return null;
                            return react_jsx_runtime.jsx("tr", {
                              style: i % 2 === 1 ? { background: "var(--dsw-alias-interactive-bg-hover)" } : void 0,
                              children: [
                                react_jsx_runtime.jsx("td", { style: cellStyle, children: String(rec.turn ?? "") }),
                                react_jsx_runtime.jsx("td", { style: cellStyle, children: rec.model ?? "（未知）" }),
                                react_jsx_runtime.jsx("td", { style: cellStyle, children: formatTokens(rec.miss ?? 0) }),
                                react_jsx_runtime.jsx("td", { style: cellStyle, children: formatTokens(rec.hit ?? 0) }),
                                react_jsx_runtime.jsx("td", { style: cellStyle, children: formatTokens(rec.write ?? 0) }),
                                react_jsx_runtime.jsx("td", { style: cellStyle, children: formatTokens(rec.out ?? 0) }),
                                react_jsx_runtime.jsx("td", { style: cellStyle, children: formatCost(rec.cost ?? 0) })
                              ]
                            }, "rec" + i);
                          })
                        })
                      ]
                    })
                  }),
                recordsList.length > 0 && react_jsx_runtime.jsxs("div", {
                  style: Object.assign({}, dialogBtnRowStyle, { justifyContent: "space-between" }),
                  children: [
                    react_jsx_runtime.jsx("span", {
                      style: descStyle,
                      children: "共 " + recordsList.length + " 轮 · 总费用 " + formatCost(recordsList.reduce((sum, r) => sum + (r !== null && typeof r === "object" ? (r.cost || 0) : 0), 0))
                    }),
                    react_jsx_runtime.jsxs("div", {
                      style: { display: "flex", gap: 8 },
                      children: [
                        react_jsx_runtime.jsx("button", {
                          type: "button",
                          style: btnStyle,
                          onClick: clearRecords,
                          children: "清空记录"
                        }),
                        react_jsx_runtime.jsx("button", {
                          type: "button",
                          style: primaryBtnStyle,
                          onClick: copyRecordsCsv,
                          children: "复制 CSV"
                        })
                      ]
                    })
                  ]
                }),
                dialogMsg !== null && react_jsx_runtime.jsx("div", { style: dialogMsgStyle, children: dialogMsg.msg }),
                react_jsx_runtime.jsxs("div", {
                  style: dialogBtnRowStyle,
                  children: [
                    react_jsx_runtime.jsx("button", {
                      type: "button",
                      style: btnStyle,
                      onClick: () => {
                        setShowRecords(false);
                        setDialogMsg(null);
                      },
                      children: "关闭"
                    })
                  ]
                })
              ]
            })
          })
        ]
      });
    }

    // ------------------------------------------------------- model definitions
    /**
     * The client conversation nodes do NOT project the model, but
     * `request/header` events carry `header.config` (provider/model). Headers
     * are only logged when they CHANGE or a loop resumes — most turns reuse the
     * previous header — so a single definition keyed by header events would
     * leave most turns without a model. Two definitions solve it:
     *  - `turn-usage-header`: publishes the model for turns that log a header.
     *  - `turn-usage-model`: keyed by turn/start, inherits the header in force
     *    from the previous header context, so EVERY turn gets a model.
     */
    const turnUsageHeaderDefinition = {
      kind: "turn-usage-header",
      match: (event) => event.type === "request/header" ? {
        id: "header:" + event.seq,
        role: "start"
      } : null,
      start: (context, match) => {
        const config = match.event.data?.header?.config;
        const location = match.location;
        const turn = location !== null && typeof location === "object" && (location.kind === "turn" || location.kind === "step")
          ? location.turn.turn : void 0;
        return {
          seq: match.event.seq,
          turn,
          model: config !== null && typeof config === "object" && typeof config.model === "string" ? config.model : null,
          provider: config !== null && typeof config === "object" && typeof config.provider === "string" ? config.provider : null
        };
      },
      update: (context) => context.state,
      buildLocationData: (context, scope) => {
        if (scope !== "turn" || context.state === void 0) return null;
        if (typeof context.state.turn !== "number" || typeof context.state.model !== "string") return null;
        return {
          kind: "turn",
          turn: context.state.turn,
          key: "turn-usage-header",
          value: {
            model: context.state.model,
            ...typeof context.state.provider === "string" ? { provider: context.state.provider } : {}
          }
        };
      }
    };

    const turnUsageModelDefinition = {
      kind: "turn-usage-model",
      match: (event) => event.type === "turn/start" ? {
        id: "turn:" + event.data.turn,
        role: "start"
      } : null,
      start: (context, match, reader) => {
        const previous = reader.previous("turn-usage-header")?.state;
        return {
          turn: match.event.data.turn,
          model: previous !== null && typeof previous === "object" && typeof previous.model === "string" ? previous.model : null,
          provider: previous !== null && typeof previous === "object" && typeof previous.provider === "string" ? previous.provider : null
        };
      },
      update: (context) => context.state,
      buildLocationData: (context, scope) => {
        if (scope !== "turn" || context.state === void 0) return null;
        if (typeof context.state.turn !== "number" || typeof context.state.model !== "string") return null;
        return {
          kind: "turn",
          turn: context.state.turn,
          key: "turn-usage-model",
          value: {
            model: context.state.model,
            ...typeof context.state.provider === "string" ? { provider: context.state.provider } : {}
          }
        };
      }
    };

    // ------------------------------------------------------------------ apply
    /** Services required by this plugin. */
    const inject = ["slots", "locale", "connection", "conversationEvents", "settingsScope"];

    function apply(ctx) {
      const connection = ctx.get("connection");
      let tDeliv = () => "";
      try {
        tDeliv = ctx.locale.bind("deliverables");
      } catch (_e) { /* deliverables dictionaries may not be registered yet */ }
      // Bind the Host-persisted config scope; restore values into localStorage
      // so the sync config store reflects the last saved state across restarts
      // (the desktop app's port changes per launch, wiping per-origin storage).
      try {
        settingsScope = ctx.settingsScope.bind({ namespace: "dsh-turn-usage" });
        settingsScope.load().then(() => {
          const snap = settingsScope.getSnapshot();
          const values = snap !== null && typeof snap === "object" && snap.value !== void 0 && typeof snap.value === "object"
            ? snap.value : null;
          if (values !== null) {
            const partial = {};
            if (typeof values.prices === "string" && values.prices !== "") partial.prices = values.prices;
            if (typeof values.model === "string" && values.model !== "") partial.model = values.model;
            if (typeof values.records === "string" && values.records !== "") partial.records = values.records;
            if (Object.keys(partial).length > 0) applyLocalConfig(partial);
          }
        }).catch(() => {});
      } catch (_e) {
        settingsScope = null;
      }
      // Boot-time load from the Host config file (the durable JSON file the
      // host half keeps under <DSH_HOME>/storages). This is the primary
      // cross-restart channel; the settings-scope mirror above is secondary.
      loadHostConfig();
      ctx.conversationEvents.register(turnUsageHeaderDefinition);
      ctx.conversationEvents.register(turnUsageModelDefinition);
      ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register({
        name: "conversation.chat.turnTail",
        // Elect this entry first; it composes the produced-files card itself so
        // both the usage row and the 产物 card render (see TurnUsageRow).
        priority: -1,
        select: (owner) => (owner !== null && typeof owner === "object" && owner.turn !== void 0
          ? { turn: owner.turn, seq: owner.seq }
          : null),
        inject: () => ({
          isLoopback: connection.isLoopback,
          hooks: { hostDescription: connection.hostDescription },
          tDeliv
        })
      }, TurnUsageRow));
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        // Same cell as the shipped StatsLine; a lower priority shadows it and
        // our MergedStatsLine renders the whole line (with the latest-task
        // cost appended to the token group) in its place.
        id: "stats",
        priority: -1,
        locale: "conversation"
      }, MergedStatsLine));
      ctx.slots.inject("settings.general.item", () => ctx.slots.register({
        name: "settings.general.item",
        id: "turn-usage-prices",
        order: 30
      }, PriceSettingsRow));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
