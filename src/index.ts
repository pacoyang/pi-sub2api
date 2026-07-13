import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi extension for a sub2api gateway.
 *
 * - Fetches the model list from GET {BASE}/v1/models and registers them as the
 *   "sub2api" provider (openai-completions).
 * - Registers a /usage command backed by GET {BASE}/v1/usage (balance and cost).
 *
 * Configuration lives entirely in ~/.pi/agent/auth.json under the provider name
 * "sub2api" (no shell env exports needed):
 *
 *   {
 *     "sub2api": {
 *       "type": "api_key",
 *       "key": "sk-...",
 *       "env": { "SUB2API_BASE_URL": "https://your-sub2api-host" }
 *     }
 *   }
 *
 * pi resolves the key from auth.json["sub2api"] for inference; this extension reads
 * the same entry for its own /v1/models and /v1/usage calls.
 *
 * Note: only openai-completions works against this gateway; openai-responses and
 * openai-codex-responses did not.
 */

const DEFAULT_BASE = "http://localhost:8080";

function agentDir(): string {
  const override = process.env.PI_CODING_AGENT_DIR;
  return override ? override.replace(/^~(?=$|\/)/, homedir()) : join(homedir(), ".pi", "agent");
}

/** Resolve a stored value: literal, or $ENV_VAR interpolation. */
function resolveValue(raw: string | undefined, scopedEnv?: Record<string, string>): string {
  if (!raw) return "";
  const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(raw);
  if (m) return scopedEnv?.[m[1]] ?? process.env[m[1]] ?? "";
  return raw;
}

function readSub2apiCredential(): { key: string; base: string } {
  try {
    const authPath = join(agentDir(), "auth.json");
    const data = JSON.parse(readFileSync(authPath, "utf-8")) as Record<
      string,
      { type?: string; key?: string; env?: Record<string, string> }
    >;
    const cred = data.sub2api;
    if (cred?.type === "api_key") {
      return {
        key: resolveValue(cred.key, cred.env),
        base: (resolveValue(cred.env?.SUB2API_BASE_URL, cred.env) || DEFAULT_BASE).replace(/\/+$/, ""),
      };
    }
  } catch {
    // auth.json missing or unparseable; fall through to env/default.
  }
  return {
    key: process.env.SUB2API_KEY ?? "",
    base: (process.env.SUB2API_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, ""),
  };
}

async function fetchJson(url: string, key: string, timeoutMs = 8000): Promise<any> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Render the GET /v1/usage response as a compact multi-line report.
function formatUsage(data: any): string {
  const lines = ["sub2api usage"];
  const row = (label: string, rest: string) => lines.push(`  ${label.padEnd(7)}  ${rest}`);
  const num = (v: unknown) => Number(v ?? 0);
  if (data?.balance != null) {
    row("balance", `${num(data.balance).toFixed(2)}${data.unit ? ` ${data.unit}` : ""}`);
  }
  const bucket = (label: string, b: any) => {
    if (b) {
      row(label, `$${num(b.cost).toFixed(2)} · ${num(b.requests).toLocaleString()} req · ${num(b.total_tokens).toLocaleString()} tok`);
    }
  };
  bucket("today", data?.usage?.today);
  bucket("total", data?.usage?.total);
  const stats: any[] = Array.isArray(data?.model_stats) ? data.model_stats : [];
  if (stats.length) {
    lines.push("  top models (by cost)");
    for (const s of [...stats].sort((a, b) => num(b.cost) - num(a.cost)).slice(0, 3)) {
      lines.push(`    ${s.model}  $${num(s.cost).toFixed(2)} · ${num(s.total_tokens).toLocaleString()} tok · ${num(s.requests).toLocaleString()} req`);
    }
  }
  return lines.join("\n");
}

export default async function (pi: ExtensionAPI) {
  const { key, base } = readSub2apiCredential();

  // Codex / gpt-5 / o-series are reasoning models; infer the flag from the id.
  const isReasoning = (id: string) => /gpt-5|codex|^o[1-9]|reason|think/i.test(id);

  let models: Array<{ id: string }> = [];
  try {
    const json = await fetchJson(`${base}/v1/models`, key);
    // Keep chat-capable models only; drop embeddings and image-generation models.
    models = ((json?.data as Array<{ id: string }>) ?? []).filter((m) => !/embedding|image/i.test(m.id));
  } catch (err) {
    console.warn(`[sub2api] models fetch failed: ${(err as Error).message}`);
  }

  if (models.length === 0) {
    // Nothing fetched: skip registration to avoid an empty provider.
    // Check the "sub2api" entry in ~/.pi/agent/auth.json and that the service is running.
    console.warn("[sub2api] no models returned, skipping registration.");
    return;
  }

  // apiKey is required by registerProvider whenever models are defined (presence is
  // validated; auth.json is not consulted here), so pass the key read from auth.json.
  // At request time pi still resolves auth.json["sub2api"] first.
  pi.registerProvider("sub2api", {
    name: "Sub2API",
    baseUrl: `${base}/v1`,
    api: "openai-completions",
    apiKey: key,
    models: models.map((m) => ({
      id: m.id,
      name: m.id,
      reasoning: isReasoning(m.id),
      // Upstream rejects reasoning_effort "minimal" (supported: none/low/medium/high/xhigh),
      // so mark that level unsupported; pi hides it and clamps a request up to "low".
      thinkingLevelMap: isReasoning(m.id) ? { minimal: null } : undefined,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400000,
      maxTokens: 128000,
    })),
  });

  console.log(`[sub2api] registered ${models.length} model(s): ${models.map((m) => m.id).join(", ")}`);

  // /usage: sub2api tracks authoritative cost/balance at GET /v1/usage (same key).
  pi.registerCommand("usage", {
    description: "Show sub2api balance and today/total cost",
    handler: async (_args, ctx) => {
      if (!key) {
        ctx.ui.notify("sub2api: no API key in auth.json", "error");
        return;
      }
      ctx.ui.notify("Fetching sub2api usage…", "info");
      try {
        const data = await fetchJson(`${base}/v1/usage`, key);
        ctx.ui.notify(formatUsage(data), "info");
      } catch (e) {
        ctx.ui.notify(`sub2api: usage unavailable — ${(e as Error).message}`, "warning");
      }
    },
  });
}
