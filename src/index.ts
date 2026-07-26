import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi extension for a sub2api gateway.
 *
 * - Fetches the model list from GET {BASE}/v1/models and registers them as the
 *   "sub2api" provider, picking the wire protocol per model (see PROTOCOL below).
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
 * SUB2API_PROTOCOL may be added to that env block to force a protocol; leaving
 * it out picks one per model (see PROTOCOL below).
 *
 * pi resolves the key from auth.json["sub2api"] for inference; this extension reads
 * the same entry for its own /v1/models and /v1/usage calls.
 *
 * PROTOCOL
 * sub2api dispatches on the platform of the API key's group, not on the request
 * path: an Anthropic-account key serves /v1/messages natively and translates
 * /v1/chat/completions down to it, while an OpenAI-account key does the reverse.
 * The non-native path costs a translation hop, so Claude models are registered
 * as anthropic-messages and everything else as openai-completions.
 *
 * Each side also has a group flag that closes its non-native path outright:
 * claude_code_only rejects /v1/chat/completions, and an OpenAI group rejects
 * /v1/messages unless allow_messages_dispatch is on (it defaults to off). Only
 * the second one can bite the rule above, and only for a key whose /v1/models
 * lists Claude ids while its group is OpenAI-platform — an operator has to put
 * those ids in an account's model_mapping for that to happen. The gateway says
 * so plainly when it does ("This group does not allow /v1/messages dispatch"),
 * so that case is left to SUB2API_PROTOCOL rather than probed for: "auto"
 * (default) | "anthropic" | "openai".
 *
 * Note: openai-responses and openai-codex-responses do not work against this
 * gateway; the OpenAI side must stay on openai-completions.
 */

const DEFAULT_BASE = "http://localhost:8080";

/** Wire protocol used to talk to the gateway. */
type Protocol = "anthropic" | "openai";

/** Per-model protocol selection: follow the model id, or force one protocol. */
type ProtocolMode = "auto" | Protocol;

function parseProtocolMode(raw: string, source = "SUB2API_PROTOCOL"): ProtocolMode {
  const value = raw.trim().toLowerCase();
  if (value === "" || value === "auto") return "auto";
  if (value === "anthropic" || value === "anthropic-messages") return "anthropic";
  if (value === "openai" || value === "openai-completions") return "openai";
  console.warn(`[sub2api] unknown ${source} "${raw}", falling back to "auto" (anthropic | openai | auto).`);
  return "auto";
}

/**
 * Read the protocol override from one config source. SUB2API_API was the name
 * up to 0.2.2 and still works: silently ignoring it would drop an override
 * someone set to route around a gateway restriction.
 */
function readProtocolMode(lookup: (name: string) => string | undefined): ProtocolMode {
  const current = lookup("SUB2API_PROTOCOL");
  if (current) return parseProtocolMode(current);

  const legacy = lookup("SUB2API_API");
  if (legacy) {
    console.warn("[sub2api] SUB2API_API has been renamed to SUB2API_PROTOCOL; the old name still works.");
    return parseProtocolMode(legacy, "SUB2API_API");
  }
  return "auto";
}

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

function readSub2apiCredential(): { key: string; base: string; protocol: ProtocolMode } {
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
        protocol: readProtocolMode((name) => resolveValue(cred.env?.[name], cred.env)),
      };
    }
  } catch {
    // auth.json missing or unparseable; fall through to env/default.
  }
  return {
    key: process.env.SUB2API_KEY ?? "",
    base: (process.env.SUB2API_BASE_URL ?? DEFAULT_BASE).replace(/\/+$/, ""),
    protocol: readProtocolMode((name) => process.env[name]),
  };
}

/**
 * Pull a human-readable message out of an error body. Gateways answer with
 * `{ code, message }`, OpenAI-style `{ error: { message, code } }`, or plain text;
 * anything unrecognised falls back to the (truncated) raw body.
 */
function describeErrorBody(body: string): string {
  const text = body.trim();
  if (!text) return "";
  try {
    const json = JSON.parse(text);
    const err = json?.error ?? json;
    const code = err?.code ?? err?.type;
    const message = err?.message ?? err?.error ?? (typeof err === "string" ? err : undefined);
    if (code || message) return [code, message].filter(Boolean).join(": ");
  } catch {
    // Not JSON; fall through to the raw text.
  }
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

async function fetchJson(url: string, key: string, timeoutMs = 8000): Promise<any> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // Network-level failure (DNS, refused connection, timeout): name the endpoint too.
    // fetch reports these as a bare "fetch failed"; the real syscall error is in `cause`.
    const e = err as Error & { cause?: { code?: string; message?: string } };
    const cause = e.cause?.code ?? e.cause?.message;
    const reason =
      e.name === "TimeoutError"
        ? `timed out after ${timeoutMs}ms`
        : `${e.message}${cause ? ` (${cause})` : ""}`;
    throw new Error(`GET ${url} failed — ${reason}`);
  }
  // statusText is empty over HTTP/2, so only append it when present.
  const status = `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`;
  let body: string;
  try {
    body = await res.text();
  } catch (err) {
    throw new Error(`GET ${url} → ${status} but the body could not be read — ${(err as Error).message}`);
  }
  if (!res.ok) {
    const detail = describeErrorBody(body);
    throw new Error(`GET ${url} → ${status}${detail ? ` — ${detail}` : ""}`);
  }
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`GET ${url} → ${status} but the body is not JSON — ${describeErrorBody(body)}`);
  }
}

/** Everything pi needs to know about one model, beyond its id. */
interface ModelSpec {
  protocol: Protocol;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
}

const isClaudeModel = (id: string) => /claude/i.test(id);

/**
 * Context and output limits per Claude generation, mirroring pi's built-in
 * anthropic model table. Ids newer than that table get the 1M context their
 * generation ships with but a conservative output cap — an under-declared
 * maxTokens only shortens replies, while an over-declared one is a hard 400.
 * First match wins.
 */
const CLAUDE_SPECS: Array<[RegExp, Omit<ModelSpec, "protocol" | "reasoning">]> = [
  [/opus-4-6/, { contextWindow: 1000000, maxTokens: 128000, thinkingLevelMap: { xhigh: "max" } }],
  [/opus-4-7/, { contextWindow: 1000000, maxTokens: 128000, thinkingLevelMap: { xhigh: "xhigh" } }],
  [/opus-4-8|opus-5|fable-5|sonnet-4-6|sonnet-5/, { contextWindow: 1000000, maxTokens: 64000 }],
  [/opus-4-[01]|opus-4-2025/, { contextWindow: 200000, maxTokens: 32000 }],
  [/claude-3-(5-)?(haiku|sonnet|opus)/, { contextWindow: 200000, maxTokens: 8192 }],
];
const CLAUDE_FALLBACK: Omit<ModelSpec, "protocol" | "reasoning"> = { contextWindow: 200000, maxTokens: 64000 };

// Everything before Claude 3.7 predates extended thinking.
const isReasoningClaude = (id: string) => !/claude-3-(?!7-)/i.test(id);

// Codex / gpt-5 / o-series are reasoning models; infer the flag from the id.
const isReasoningOpenAI = (id: string) => /gpt-5|codex|^o[1-9]|reason|think/i.test(id);

/**
 * Limits and thinking support follow the model itself; only the wire protocol
 * follows SUB2API_PROTOCOL. Keeping the two apart means forcing a protocol does not
 * silently hand a model the other family's context window.
 */
function resolveModelSpec(id: string, mode: ProtocolMode): ModelSpec {
  const isClaude = isClaudeModel(id);
  const protocol: Protocol = mode === "auto" ? (isClaude ? "anthropic" : "openai") : mode;

  const { reasoning, thinkingLevelMap, ...limits } = isClaude
    ? { reasoning: isReasoningClaude(id), ...(CLAUDE_SPECS.find(([re]) => re.test(id))?.[1] ?? CLAUDE_FALLBACK) }
    : { reasoning: isReasoningOpenAI(id), thinkingLevelMap: undefined, contextWindow: 400000, maxTokens: 128000 };

  return {
    protocol,
    reasoning,
    ...limits,
    // On the OpenAI path upstream rejects reasoning_effort "minimal" (supported:
    // none/low/medium/high/xhigh), so mark that level unsupported; pi hides it
    // and clamps a request up to "low".
    thinkingLevelMap: protocol === "openai" ? (reasoning ? { minimal: null } : undefined) : thinkingLevelMap,
  };
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
  const { key, base, protocol: protocolMode } = readSub2apiCredential();

  const modelsUrl = `${base}/v1/models`;
  if (!key) {
    console.warn(`[sub2api] no API key found — set auth.json["sub2api"].key or $SUB2API_KEY; requests to ${modelsUrl} will be unauthenticated.`);
  }

  let models: Array<{ id: string }> = [];
  let fetchFailed = false;
  try {
    const json = await fetchJson(modelsUrl, key);
    // Keep chat-capable models only; drop embeddings and image-generation models.
    models = ((json?.data as Array<{ id: string }>) ?? []).filter((m) => !/embedding|image/i.test(m.id));
  } catch (err) {
    fetchFailed = true;
    console.warn(`[sub2api] models fetch failed: ${(err as Error).message}`);
  }

  if (models.length === 0) {
    // Nothing fetched: skip registration to avoid an empty provider.
    // Check the "sub2api" entry in ~/.pi/agent/auth.json and that the service is running.
    console.warn(
      fetchFailed
        ? `[sub2api] skipping registration — see the error above (endpoint: ${modelsUrl}, config: ${join(agentDir(), "auth.json")} → "sub2api").`
        : `[sub2api] ${modelsUrl} returned no usable models, skipping registration.`,
    );
    return;
  }

  const specs = models.map((m) => ({ id: m.id, spec: resolveModelSpec(m.id, protocolMode) }));

  // The Anthropic SDK appends /v1/messages to its baseURL, while the OpenAI one
  // appends /chat/completions to a base that already ends in /v1.
  const baseUrlFor = (protocol: Protocol) => (protocol === "anthropic" ? base : `${base}/v1`);

  // apiKey is required by registerProvider whenever models are defined (presence is
  // validated; auth.json is not consulted here), so pass the key read from auth.json.
  // At request time pi still resolves auth.json["sub2api"] first.
  pi.registerProvider("sub2api", {
    name: "Sub2API",
    baseUrl: baseUrlFor("openai"),
    api: "openai-completions",
    apiKey: key,
    models: specs.map(({ id, spec }) => ({
      id,
      name: id,
      api: spec.protocol === "anthropic" ? "anthropic-messages" : "openai-completions",
      baseUrl: baseUrlFor(spec.protocol),
      reasoning: spec.reasoning,
      thinkingLevelMap: spec.thinkingLevelMap,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: spec.contextWindow,
      maxTokens: spec.maxTokens,
    })),
  });

  const byProtocol = (protocol: Protocol) => specs.filter((s) => s.spec.protocol === protocol).map((s) => s.id);
  const summary = (["anthropic", "openai"] as const)
    .map((protocol) => ({ protocol, ids: byProtocol(protocol) }))
    .filter(({ ids }) => ids.length > 0)
    .map(({ protocol, ids }) => `${protocol === "anthropic" ? "anthropic-messages" : "openai-completions"}: ${ids.join(", ")}`)
    .join(" | ");
  console.log(`[sub2api] registered ${specs.length} model(s) — ${summary}`);

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
