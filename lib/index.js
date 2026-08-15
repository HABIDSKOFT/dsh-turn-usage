/**
 * dsh-turn-usage host half.
 *
 * Durable config-file persistence for the browser half. The DeepSeek Harness
 * desktop app serves on a random port each launch, so browser localStorage
 * (per-origin) is silently wiped on every restart — the config used to revert
 * to defaults. This half owns a plain JSON file,
 *
 *   <DSH_HOME>/storages/dsh-turn-usage.json
 *
 * which survives restarts, and exposes it to the browser through two
 * loopback-only endpoints on the web server:
 *
 *   GET  /api/dsh-turn-usage/config  -> { token, config }   (startup load)
 *   POST /api/dsh-turn-usage/config  -> { token, prices?, model?, records? }
 *
 * The POST is guarded by a per-process random token that only same-origin
 * pages can read (the GET response carries no CORS headers), so a foreign
 * web page cannot write the file. Every write lands in the JSON file
 * atomically (tmp + rename) and, when the settings service exists, is also
 * pushed into the "dsh-turn-usage" settings namespace (which persists to the
 * Host settings document) — two independent durable copies.
 *
 * On startup the file is loaded and seeded as the `base` layer of the
 * settings namespace, so the resolved value carries the saved config even
 * before the browser writes anything; `scope.watch` mirrors later changes
 * back into the file.
 */
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";

const NAMESPACE = "dsh-turn-usage";
const CONFIG_PATH = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "storages", "dsh-turn-usage.json");
const CONFIG_ROUTE = "/api/dsh-turn-usage/config";
const CONFIG_FIELDS = ["prices", "model", "records"];

/** Durable fields mirrored from the browser half. */
const SettingsSchema = z.object({
  prices: z.string().default(""),
  model: z.string().default(""),
  records: z.string().default("")
}).default({});

/** In-memory mirror of the config file (module-level; one host process). */
let configFile = loadConfigFile();
/** Random per-process token the browser must echo on writes. */
let configToken = randomBytes(16).toString("hex");

/** Read the config file once at startup; any corruption degrades to {}. */
function loadConfigFile() {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    const out = {};
    if (parsed !== null && typeof parsed === "object") {
      for (const field of CONFIG_FIELDS) {
        const value = parsed[field];
        if (typeof value === "string" && value !== "") out[field] = value;
      }
    }
    return out;
  } catch (_e) {
    /* first run or corrupt file — start empty */
    return {};
  }
}

/** Persist the config atomically (tmp + rename); failures are logged, never fatal. */
async function saveConfigFile(ctx, cfg) {
  try {
    await mkdir(dirname(CONFIG_PATH), { recursive: true });
    const tmp = `${CONFIG_PATH}.tmp`;
    await writeFile(tmp, JSON.stringify(cfg, null, 2), "utf8");
    await rename(tmp, CONFIG_PATH);
    configFile = cfg;
  } catch (error) {
    ctx?.logger?.warn?.(`dsh-turn-usage: saving config file failed: ${String(error)}`);
  }
}

/** Write a JSON response. */
function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache"
  });
  res.end(body);
}

/** Whether a peer socket address is loopback (IPv4-mapped IPv6 normalized). */
function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  const a = address.toLowerCase();
  if (a === "::1") return true;
  const ipv4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  const octets = ipv4.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
  if (typeof value !== "string") return null;
  const host = value.trim().toLowerCase();
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    if (close <= 1) return null;
    const suffix = host.slice(close + 1);
    if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
    return host.slice(1, close);
  }
  const firstColon = host.indexOf(":");
  const lastColon = host.lastIndexOf(":");
  if (firstColon !== lastColon) return host;
  if (lastColon === -1) return host.replace(/\.$/, "");
  if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
  return host.slice(0, lastColon).replace(/\.$/, "");
}

function isLoopbackHostHeader(req) {
  const name = hostNameOf(req.headers.host);
  return name === "localhost" || isLoopbackAddress(name);
}

/** Loopback fence on the PEER SOCKET address, Host header as an extra check. */
function isLoopback(req) {
  return isLoopbackAddress(req.socket?.remoteAddress) && isLoopbackHostHeader(req);
}

/**
 * GET -> token + current config (same-origin pages can read the token).
 * POST -> token-guarded config write; merges into the file and the settings
 * namespace when available.
 */
function handleConfig(ctx, req, res) {
  if (!isLoopback(req)) {
    json(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  if (req.method === "GET") {
    json(res, 200, { ok: true, token: configToken, config: { ...configFile } });
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { ok: false, error: "method-not-allowed" });
    return;
  }
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 1_000_000) req.destroy();
  });
  req.on("end", () => {
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch (_e) {
      json(res, 400, { ok: false, error: "bad-json" });
      return;
    }
    if (parsed === null || typeof parsed !== "object" || parsed.token !== configToken) {
      json(res, 403, { ok: false, error: "bad-token" });
      return;
    }
    const next = {};
    for (const field of CONFIG_FIELDS) {
      const value = parsed[field];
      if (typeof value === "string") next[field] = value;
    }
    const merged = { ...configFile, ...next };
    configFile = merged;
    saveConfigFile(ctx, merged).then(() => {
      const settings = ctx.get("settings");
      if (settings !== void 0 && typeof settings.update === "function") {
        settings.update(NAMESPACE, { ...merged }).catch(() => {});
      }
      json(res, 200, { ok: true, config: { ...merged } });
    }).catch(() => {
      json(res, 500, { ok: false, error: "write-failed" });
    });
  });
}

/** Host plugin body. */
function apply(ctx) {
  ctx.inject(["settings"], (settingsCtx) => {
    try {
      const scope = settingsCtx.settings.register(settingsNamespace(NAMESPACE), SettingsSchema, { base: { ...configFile } });
      // Mirror every resolved change (user edits from the browser half or the
      // settings document) back into the JSON file.
      scope.watch((next) => {
        if (next === null || typeof next !== "object") return;
        const cfg = {};
        for (const field of CONFIG_FIELDS) {
          const value = next[field];
          if (typeof value === "string") cfg[field] = value;
        }
        saveConfigFile(ctx, cfg);
      });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-turn-usage: settings registration failed: ${String(error)}`);
    }
  });
  ctx.inject(["webServer"], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: "exact",
      path: CONFIG_ROUTE,
      handler: (req, res) => handleConfig(ctx, req, res)
    }), "dsh-turn-usage: config route");
  });
}

export { apply, CONFIG_PATH, CONFIG_ROUTE };
