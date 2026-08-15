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
      try {
        const raw = window.localStorage.getItem(PRICE_STORAGE_KEY);
        if (raw !== null) {
          const parsed = JSON.parse(raw);
          if (parsed !== null && typeof parsed === "object") {
            return Object.assign({}, DEFAULT_PRICES, parsed);
          }
        }
      } catch (_e) {
        /* fall through to defaults */
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
      try {
        const override = window.localStorage.getItem(MODEL_OVERRIDE_KEY);
        if (override !== null && override.trim() !== "") return override.trim();
      } catch (_e) { /* ignore */ }
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
      const hasUsage = fold.steps > 0 && totalTokens(fold) > 0;
      if (!hasUsage && produced.length === 0) return null;
      const kids = [];
      if (hasUsage) {
        kids.push(react_jsx_runtime.jsx(Row, {
          children: usageSegs(fold, { showHit: false })
        }, "usage"));
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
    /** Settings -> General row: edit the price table as JSON (saved to localStorage). */
    function PriceSettingsRow() {
      const [text, setText] = react.useState(() => JSON.stringify(pricesTable(), null, 2));
      const [status, setStatus] = react.useState(null);
      const [model, setModel] = react.useState(() => {
        try {
          return window.localStorage.getItem(MODEL_OVERRIDE_KEY) || "";
        } catch (_e) { return ""; }
      });
      const areaRef = react.useRef(null);

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
          window.localStorage.setItem(PRICE_STORAGE_KEY, JSON.stringify(parsed));
          const trimmedModel = model.trim();
          if (trimmedModel === "") window.localStorage.removeItem(MODEL_OVERRIDE_KEY);
          else window.localStorage.setItem(MODEL_OVERRIDE_KEY, trimmedModel);
          setStatus({ ok: true, msg: "已保存 ✓（价格行与累计费用即时生效）" });
        } catch (error) {
          setStatus({ ok: false, msg: "JSON 无效：" + (error instanceof Error ? error.message : String(error)) });
        }
      };

      const reset = () => {
        window.localStorage.removeItem(PRICE_STORAGE_KEY);
        window.localStorage.removeItem(MODEL_OVERRIDE_KEY);
        setText(JSON.stringify(DEFAULT_PRICES, null, 2));
        setModel("");
        setStatus({ ok: true, msg: "已恢复默认价格 ✓" });
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
      const btnRowStyle = { display: "flex", alignItems: "center", gap: "8px" };
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

      return react_jsx_runtime.jsx("div", {
        style: rowStyle,
        children: react_jsx_runtime.jsxs("div", {
          style: textStyle,
          children: [
            react_jsx_runtime.jsx("div", { style: titleStyle, children: "Token 价格表（dsh-turn-usage）" }),
            react_jsx_runtime.jsx("div", {
              style: descStyle,
              children: "每百万 token 价格（人民币 ¥）。JSON 对象：模型名 -> { input: 未命中输入, cacheRead: 缓存命中, cacheWrite: 写缓存, output: 输出 }。需要峰谷自动切换时用 { switchAt, peak, offPeak } 结构（北京时间高峰 09:00-12:00、14:00-18:00，空闲为高峰一半）。窗口高度可拖动，会自动记住。"
            }),
            react_jsx_runtime.jsxs("div", {
              style: modelRowStyle,
              children: [
                react_jsx_runtime.jsx("span", { style: descStyle, children: "当前模型（用于定价匹配，留空=按 * 兜底价）：" }),
                react_jsx_runtime.jsx("input", {
                  style: modelInputStyle,
                  value: model,
                  placeholder: "deepseek-v4-flash",
                  spellCheck: false,
                  onChange: (event) => {
                    setModel(event.target.value);
                    setStatus(null);
                  }
                })
              ]
            }),
            react_jsx_runtime.jsx("textarea", {
              ref: areaRef,
              style: areaStyle,
              value: text,
              spellCheck: false,
              onChange: (event) => {
                setText(event.target.value);
                setStatus(null);
              }
            }),
            react_jsx_runtime.jsxs("div", {
              style: btnRowStyle,
              children: [
                react_jsx_runtime.jsx("button", {
                  type: "button",
                  style: btnStyle,
                  onClick: save,
                  children: "保存"
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
      });
    }

    // ------------------------------------------------------------------ apply
    /** Services required by this plugin. */
    const inject = ["slots", "locale", "connection"];

    function apply(ctx) {
      const connection = ctx.get("connection");
      let tDeliv = () => "";
      try {
        tDeliv = ctx.locale.bind("deliverables");
      } catch (_e) { /* deliverables dictionaries may not be registered yet */ }
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
