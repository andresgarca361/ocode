import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { execSync } from "child_process";
import { tmpdir, homedir } from "os";
import { join } from "path";

if (process.env.NODE_ENV !== 'production') process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const HOME = homedir();
const CACHE_PATH = join(HOME, ".opencode/proxy/model-cache.json");
const CONFIG_PATH = join(HOME, ".opencode/proxy/proxy-config.json");
const NVIDIA_API_BASE = "https://integrate.api.nvidia.com/v1";
const MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_PORT = 18080;

let modelCatalog = null;
let providerConfigs = null;
const hybridSessions = new Map();

const TRUNCATION_KEYWORDS = [
  "todo", "task", "decision", "important", "note", "remember",
  "agreed", "critical", "action item", "bug", "fix", "error",
  "question", "clarify", "summary", "warning", "alert", "issue", "required"
];

function defaultConfig() {
  return { rpm: 40, modelFlash: null, modelHeavy: null, modelFlashFallback: null, modelHeavyFallback: null, autoRoute: true };
}

function loadProxyConfig() {
  try {
    if (existsSync(CONFIG_PATH)) {
      const saved = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
      return { ...defaultConfig(), ...saved };
    }
  } catch {}
  return defaultConfig();
}

function saveProxyConfig() {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(proxyConfig, null, 2));
  } catch {}
}

let proxyConfig = loadProxyConfig();
let lastRequestTime = 0;
let upstreamTimestamps = [];
let lastTruncationSummary = null;
let lastFallbackEvent = null;

async function throttleRPM() {
  const rpm = proxyConfig.rpm;
  if (rpm <= 0) return;
  const intervalMs = 60000 / rpm;
  while (true) {
    const now = Date.now();
    const nextAllowed = lastRequestTime + intervalMs;
    if (nextAllowed <= now) break;
    await new Promise(r => setTimeout(r, nextAllowed - now));
  }
  lastRequestTime = Math.max(lastRequestTime + intervalMs, Date.now());
}

function htmlEscape(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function formatContextSize(tokens) {
  if (tokens >= 1000000) {
    const m = tokens / 1000000;
    return `${m % 1 === 0 ? m : m.toFixed(1)}M (~${Math.round(tokens / 4 / 1000)}k words)`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${k % 1 === 0 ? k : k.toFixed(1)}k (~${Math.round(tokens / 4)} words)`;
  }
  return `${tokens} tokens`;
}

function getModelContext(modelId) {
  if (!modelCatalog || !modelId) return 128000;
  const info = modelCatalog.models[modelId];
  return info?.context || 128000;
}

function estimateTokens(text) {
  if (typeof text === "string") return Math.ceil(text.length / 4);
  if (Array.isArray(text)) return text.reduce((sum, part) => {
    if (typeof part === "string") return sum + Math.ceil(part.length / 4);
    if (part && typeof part === "object") return sum + Math.ceil(JSON.stringify(part).length / 4);
    return sum;
  }, 0);
  if (text && typeof text === "object") return Math.ceil(JSON.stringify(text).length / 4);
  return 0;
}

function estimateMessagesTokens(messages) {
  return messages.reduce((sum, m) => {
    let msgTokens = estimateTokens(m.content);
    if (m.tool_calls) msgTokens += estimateTokens(m.tool_calls);
    if (m.function_call) msgTokens += estimateTokens(m.function_call);
    if (m.name) msgTokens += Math.ceil(m.name.length / 4);
    return sum + msgTokens;
  }, 0);
}

function calculateContextBudget(modelContext) {
  return Math.floor(modelContext * 0.75);
}

function hasKeywords(message, keywords) {
  const text = typeof message.content === "string"
    ? message.content
    : (Array.isArray(message.content) ? message.content.map(p => p.type === "text" ? p.text : "").join(" ") : JSON.stringify(message.content));
  const lower = text.toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

function hasToolContent(message) {
  if (message.tool_calls) return true;
  if (message.role === "tool" || message.role === "function") return true;
  if (Array.isArray(message.content) && message.content.some(p => p.type === "tool-call" || p.type === "tool_use" || p.type === "tool-result")) return true;
  return false;
}

function truncateMessages(messages, targetBudget) {
  if (messages.length === 0) return { messages, truncated: false, keptCount: 0, droppedCount: 0, tokensEstimate: 0, targetBudget, keywordsFound: [] };

  const systemIdx = messages.findIndex(m => m.role === "system");
  const firstUserIdx = messages.findIndex((m, i) => m.role === "user" && i !== systemIdx);

  const anchorIndices = new Set();
  if (systemIdx !== -1) anchorIndices.add(systemIdx);
  if (firstUserIdx !== -1) anchorIndices.add(firstUserIdx);

  const recentCount = Math.min(3, messages.length);
  for (let i = messages.length - recentCount; i < messages.length; i++) {
    anchorIndices.add(i);
  }

  const keywordIndices = new Set();
  const keywordsFound = [];
  for (let i = 0; i < messages.length; i++) {
    if (anchorIndices.has(i)) continue;
    if (hasKeywords(messages[i], TRUNCATION_KEYWORDS)) {
      keywordIndices.add(i);
      const text = typeof messages[i].content === "string" ? messages[i].content : "";
      for (const kw of TRUNCATION_KEYWORDS) {
        if (text.toLowerCase().includes(kw.toLowerCase()) && !keywordsFound.includes(kw)) {
          keywordsFound.push(kw);
        }
      }
    }
  }

  const toolIndices = new Set();
  for (let i = 0; i < messages.length; i++) {
    if (anchorIndices.has(i) || keywordIndices.has(i)) continue;
    if (hasToolContent(messages[i])) toolIndices.add(i);
  }

  const midIndices = [];
  for (let i = 0; i < messages.length; i++) {
    if (anchorIndices.has(i) || keywordIndices.has(i) || toolIndices.has(i)) continue;
    midIndices.push(i);
  }
  const midFromEnd = midIndices.slice(-10);
  const midFromStart = midIndices.slice(0, 5);
  const midPriority = new Set([...midFromStart, ...midFromEnd]);

  const orderedPriority = [
    ...Array.from(anchorIndices).sort((a, b) => a - b),
    ...Array.from(keywordIndices).sort((a, b) => a - b),
    ...Array.from(toolIndices).sort((a, b) => a - b),
    ...Array.from(midPriority).sort((a, b) => a - b),
    ...midIndices.filter(i => !midPriority.has(i)),
  ];

  const keptIndices = new Set();
  let usedTokens = 0;

  for (const idx of orderedPriority) {
    const msgTokens = estimateTokens(messages[idx].content);
    if (msgTokens > targetBudget * 0.4 && keptIndices.size > 0 && !anchorIndices.has(idx)) continue;
    if (usedTokens + msgTokens > targetBudget) {
      if (anchorIndices.has(idx)) {
        usedTokens += msgTokens;
        keptIndices.add(idx);
      }
      continue;
    }
    usedTokens += msgTokens;
    keptIndices.add(idx);
  }

  const result = [];
  const sortedIndices = Array.from(keptIndices).sort((a, b) => a - b);
  for (const idx of sortedIndices) {
    result.push(messages[idx]);
  }

  const droppedCount = messages.length - result.length;
  const truncated = droppedCount > 0;
  const tokensEstimate = estimateMessagesTokens(result);

  return { messages: result, truncated, keptCount: result.length, droppedCount, tokensEstimate, targetBudget, keywordsFound };
}

function updateVirtualModelContexts() {
  if (!modelCatalog) return;
  const vp = modelCatalog.providers.proxy;
  if (!vp) return;
  const flashCtx = proxyConfig.modelFlash ? getModelContext(proxyConfig.modelFlash) : 128000;
  const heavyCtx = proxyConfig.modelHeavy ? getModelContext(proxyConfig.modelHeavy) : 128000;
  const fbFlashCtx = proxyConfig.modelFlashFallback ? getModelContext(proxyConfig.modelFlashFallback) : 128000;
  const fbHeavyCtx = proxyConfig.modelHeavyFallback ? getModelContext(proxyConfig.modelHeavyFallback) : 128000;
  const flashMin = Math.min(flashCtx, fbFlashCtx);
  const hybridCtx = Math.min(flashCtx, heavyCtx, fbFlashCtx, fbHeavyCtx);
  const vms = { flash: flashMin, heavy: heavyCtx, hybrid: hybridCtx, "flash-default": flashMin, "heavy-default": heavyCtx };
  for (const [vm, ctx] of Object.entries(vms)) {
    if (vp.models[vm]) {
      vp.models[vm].context = ctx;
      modelCatalog.models[`proxy/${vm}`].context = ctx;
    }
  }
}

function serveConfigPage(res) {
  const allModelIds = [];
  for (const [pid, p] of Object.entries(modelCatalog.providers)) {
    for (const [mid, minfo] of Object.entries(p.models)) {
      allModelIds.push({ id: `${pid}/${mid}`, provider: pid, context: minfo.context || 128000 });
    }
  }
  const modelOptions = allModelIds
    .map(m => `<option value="${htmlEscape(m.id)}">${htmlEscape(m.id)} [${formatContextSize(m.context)}]</option>`)
    .join("\n");
  const modelContextsJSON = JSON.stringify(Object.fromEntries(allModelIds.map(m => [m.id, m.context])));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>OpenCode Proxy Config</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; }
.card { background: #16213e; border-radius: 12px; padding: 32px; max-width: 580px; width: 100%; box-shadow: 0 8px 32px rgba(0,0,0,0.4); }
h1 { font-size: 22px; margin-bottom: 24px; color: #00d2ff; text-align: center; }
label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: #a0a0c0; text-transform: uppercase; letter-spacing: 0.5px; }
select, input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1px solid #2a2a4a; background: #0f3460; color: #e0e0e0; font-size: 14px; margin-bottom: 16px; outline: none; transition: border-color 0.2s; }
select:focus, input:focus { border-color: #00d2ff; }
button { width: 100%; padding: 12px; border-radius: 8px; border: none; background: #00d2ff; color: #1a1a2e; font-size: 16px; font-weight: 700; cursor: pointer; transition: background 0.2s; margin-bottom: 12px; }
button:hover { background: #00b8d4; }
button.secondary { background: #2a2a4a; color: #e0e0e0; }
button.secondary:hover { background: #3a3a5a; }
.status { text-align: center; font-size: 13px; margin-top: 8px; min-height: 20px; }
.status.ok { color: #4caf50; }
.status.err { color: #f44336; }
.label-row { display: flex; justify-content: space-between; align-items: baseline; }
.label-row span { font-size: 12px; color: #606080; }
.model-count { text-align: center; font-size: 12px; color: #606080; margin-bottom: 16px; }
.context-info { font-size: 11px; color: #7090c0; margin-top: -12px; margin-bottom: 12px; padding-left: 4px; }
.summary-box { background: #1a3d1a; border: 1px solid #4caf50; border-radius: 6px; padding: 10px 14px; font-size: 12px; color: #a5d6a7; margin-bottom: 16px; display: none; line-height: 1.6; }
.summary-box .lbl { color: #81c784; font-weight: 600; }
.summary-box .val { color: #c8e6c9; }
.summary-box .wrn { color: #ffcc80; }
.section-divider { border: none; border-top: 1px solid #2a2a4a; margin: 16px 0; }
.fallback-label { font-size: 12px; color: #606080; font-style: italic; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="card">
<h1>OpenCode Universal Proxy</h1>
<p class="model-count">${Object.keys(modelCatalog.models).length} models across ${Object.keys(modelCatalog.providers).length} providers</p>
<form id="configForm">
<label>Flash Model (fast/cheap)</label>
<select id="modelFlash">
<option value="">--- Auto ---</option>
${modelOptions}
</select>
<div id="flashContext" class="context-info"></div>
<label>Heavy Reasoning Model (powerful)</label>
<select id="modelHeavy">
<option value="">--- Auto ---</option>
${modelOptions}
</select>
<div id="heavyContext" class="context-info"></div>
<label>Requests Per Minute (RPM)</label>
<input type="number" id="rpm" min="1" max="600" value="${proxyConfig.rpm}">
<div class="label-row">
<label style="margin-bottom:0">Auto-route by task difficulty</label>
<span id="autoRouteLabel">ON</span>
</div>
<div style="display:flex;gap:8px;margin-bottom:16px">
<button type="button" id="autoRouteBtn" class="secondary" style="flex:1;margin-bottom:0">Toggle Auto-Route</button>
</div>
<hr class="section-divider">
<p class="fallback-label">Fallback models (used if primary returns rate-limit or error)</p>
<label>Fallback Flash Model</label>
<select id="modelFlashFallback">
<option value="">--- None ---</option>
${modelOptions}
</select>
<div id="flashFallbackContext" class="context-info"></div>
<label>Fallback Heavy Model</label>
<select id="modelHeavyFallback">
<option value="">--- None ---</option>
${modelOptions}
</select>
<div id="heavyFallbackContext" class="context-info"></div>
<button type="submit">Save Configuration</button>
</form>
<div id="contextSummary" class="summary-box"></div>
<div id="status" class="status"></div>
</div>
<script>
const modelContexts = ${modelContextsJSON};
const form = document.getElementById("configForm");
const status = document.getElementById("status");
const autoRouteBtn = document.getElementById("autoRouteBtn");
const autoRouteLabel = document.getElementById("autoRouteLabel");
let autoRoute = ${proxyConfig.autoRoute};
function fmtCtx(tokens) {
  if (!tokens) return "";
  if (tokens >= 1000000) return (tokens/1000000).toFixed(tokens%1000000===0?0:1) + "M (~" + Math.round(tokens/4/1000) + "k words)";
  if (tokens >= 1000) return (tokens/1000).toFixed(tokens%1000===0?0:1) + "k (~" + Math.round(tokens/4) + " words)";
  return tokens + " tokens";
}
function updateCtx(selId, dispId) {
  var v = document.getElementById(selId).value;
  var d = document.getElementById(dispId);
  d.textContent = v && modelContexts[v] ? "Context window: " + fmtCtx(modelContexts[v]) : "";
}
function updateSummary() {
  var fv = document.getElementById("modelFlash").value;
  var hv = document.getElementById("modelHeavy").value;
  var fc = modelContexts[fv] || 0;
  var hc = modelContexts[hv] || 0;
  var ffv = document.getElementById("modelFlashFallback").value;
  var fhv = document.getElementById("modelHeavyFallback").value;
  var ffc = modelContexts[ffv] || 0;
  var fhc = modelContexts[fhv] || 0;
  var box = document.getElementById("contextSummary");
  if (!fv && !hv) { box.style.display = "none"; return; }
  var h = "";
  if (fv) h += '<span class="lbl">Flash:</span> <span class="val">' + fmtCtx(fc) + '</span><br>';
  if (hv) h += '<span class="lbl">Heavy:</span> <span class="val">' + fmtCtx(hc) + '</span><br>';
  if (ffv) h += '<span class="lbl">Fallback Flash:</span> <span class="val">' + fmtCtx(ffc) + '</span><br>';
  if (fhv) h += '<span class="lbl">Fallback Heavy:</span> <span class="val">' + fmtCtx(fhc) + '</span><br>';
  if (fv && hv && fc > 0 && hc > 0) {
    var ratio = (hc / fc).toFixed(1);
    h += '<span class="lbl">Context ratio:</span> <span class="val">1:' + ratio + '</span>';
    if (parseFloat(ratio) > 50) h += ' <span class="wrn">\\u26a0 Large ratio - Flash will truncate heavily</span>';
    h += '<br>';
  }
  h += '<span class="val" style="font-size:11px;color:#90a0b0">Truncation preserves: system prompt, first user msg, recent 3 msgs, keywords (todo/decision/bug...), tool calls. Escalates to heavy if flash cannot fit.</span>';
  box.innerHTML = h;
  box.style.display = "block";
}
[["modelFlash","flashContext"],["modelHeavy","heavyContext"],["modelFlashFallback","flashFallbackContext"],["modelHeavyFallback","heavyFallbackContext"]].forEach(function(pair) {
  document.getElementById(pair[0]).addEventListener("change", function() { updateCtx(pair[0],pair[1]); updateSummary(); });
});
async function loadConfig() {
  try {
    var r = await fetch("/config");
    var cfg = await r.json();
    document.getElementById("modelFlash").value = cfg.modelFlash || "";
    document.getElementById("modelHeavy").value = cfg.modelHeavy || "";
    document.getElementById("modelFlashFallback").value = cfg.modelFlashFallback || "";
    document.getElementById("modelHeavyFallback").value = cfg.modelHeavyFallback || "";
    document.getElementById("rpm").value = cfg.rpm;
    autoRoute = cfg.autoRoute !== false;
    autoRouteLabel.textContent = autoRoute ? "ON" : "OFF";
    updateCtx("modelFlash","flashContext");
    updateCtx("modelHeavy","heavyContext");
    updateCtx("modelFlashFallback","flashFallbackContext");
    updateCtx("modelHeavyFallback","heavyFallbackContext");
    updateSummary();
  } catch {}
}
autoRouteBtn.onclick = function() { autoRoute = !autoRoute; autoRouteLabel.textContent = autoRoute ? "ON" : "OFF"; };
form.onsubmit = async function(e) {
  e.preventDefault();
  status.className = "status";
  status.textContent = "Saving...";
  try {
    var r = await fetch("/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelFlash: document.getElementById("modelFlash").value || null,
        modelHeavy: document.getElementById("modelHeavy").value || null,
        modelFlashFallback: document.getElementById("modelFlashFallback").value || null,
        modelHeavyFallback: document.getElementById("modelHeavyFallback").value || null,
        rpm: parseInt(document.getElementById("rpm").value) || 40,
        autoRoute,
      }),
    });
    if (r.ok) {
      var data = await r.json();
      status.className = "status ok";
      var fc = data.flashModelContext ? fmtCtx(data.flashModelContext) : "N/A";
      var hc = data.heavyModelContext ? fmtCtx(data.heavyModelContext) : "N/A";
      var ffc = data.flashFallbackModelContext ? fmtCtx(data.flashFallbackModelContext) : "none";
      var fhc = data.heavyFallbackModelContext ? fmtCtx(data.heavyFallbackModelContext) : "none";
      var msg = "Saved! Flash: " + fc + " | Heavy: " + hc;
      if (ffc !== "none") msg += " | FB Flash: " + ffc;
      if (fhc !== "none") msg += " | FB Heavy: " + fhc;
      if (data.ratio && parseFloat(data.ratio) > 50) msg += " \\u26a0 Ratio 1:" + data.ratio;
      status.textContent = msg;
    } else {
      var err = await r.text();
      status.className = "status err";
      status.textContent = "Error: " + err;
    }
  } catch (e) {
    status.className = "status err";
    status.textContent = "Network error: " + e.message;
  }
};
loadConfig();
<\/script>
</div>
</html>`);
}

async function fetchJSON(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status} ${res.statusText}`);
  return res.json();
}

function curlFetchJSON(url, headers = {}) {
  const tmpFile = join(tmpdir(), `opencode-proxy-${Date.now()}.json`);
  try {
    const headerArgs = Object.entries(headers).map(([k, v]) => `-H "${k}: ${v}"`).join(" ");
    execSync(`curl -sf ${headerArgs} -o "${tmpFile}" "${url}"`, { timeout: 30000, maxBuffer: 100 * 1024 * 1024 });
    const data = JSON.parse(readFileSync(tmpFile, "utf-8"));
    return data;
  } catch (err) {
    throw new Error(`curl ${url} failed: ${err.message}`);
  } finally {
    try { unlinkSync(tmpFile); } catch {}
  }
}

async function fetchNVIDIAModels(apiKey) {
  if (!apiKey) {
    console.error("[proxy] no NVIDIA_API_KEY, skipping NVIDIA live model fetch");
    return [];
  }
  try {
    const data = curlFetchJSON(`${NVIDIA_API_BASE}/models`, {
      Authorization: `Bearer ${apiKey}`,
    });
    console.log(`[proxy] NVIDIA API returned ${data.data?.length || 0} models`);
    return (data.data || []).map((m) => m.id);
  } catch (err) {
    console.error(`[proxy] NVIDIA model fetch failed: ${err.message}`);
    return [];
  }
}

function loadAuthKeys() {
  const authPath = join(HOME, ".local/share/opencode/auth.json");
  if (!existsSync(authPath)) return {};
  try {
    return JSON.parse(readFileSync(authPath, "utf-8"));
  } catch {
    return {};
  }
}

function getEnvKeys() {
  const keys = {};
  const env = process.env;
  if (env.NVIDIA_API_KEY) keys.nvidia = env.NVIDIA_API_KEY;
  if (env.ANTHROPIC_API_KEY) keys.anthropic = env.ANTHROPIC_API_KEY;
  if (env.OPENAI_API_KEY) keys.openai = env.OPENAI_API_KEY;
  if (env.GOOGLE_GENERATIVE_AI_API_KEY) keys.google = env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (env.XAI_API_KEY) keys.xai = env.XAI_API_KEY;
  if (env.DEEPSEEK_API_KEY) keys.deepseek = env.DEEPSEEK_API_KEY;
  if (env.MISTRAL_API_KEY) keys.mistral = env.MISTRAL_API_KEY;
  if (env.GROQ_API_KEY) keys.groq = env.GROQ_API_KEY;
  if (env.OPENROUTER_API_KEY) keys.openrouter = env.OPENROUTER_API_KEY;
  if (env.TOGETHER_AI_API_KEY) keys.togetherai = env.TOGETHER_AI_API_KEY;
  if (env.COHERE_API_KEY) keys.cohere = env.COHERE_API_KEY;
  if (env.FIREWORKS_API_KEY) keys.fireworks_ai = env.FIREWORKS_API_KEY;
  if (env.CEREBRAS_API_KEY) keys.cerebras = env.CEREBRAS_API_KEY;
  if (env.PERPLEXITY_API_KEY) keys.perplexity = env.PERPLEXITY_API_KEY;
  if (env.GITHUB_TOKEN) keys["github-copilot"] = env.GITHUB_TOKEN;
  return keys;
}

function resolveAPIKey(providerId) {
  const envKeys = getEnvKeys();
  if (envKeys[providerId]) return envKeys[providerId];
  const authKeys = loadAuthKeys();
  const auth = authKeys[providerId];
  if (auth && auth.key) return auth.key;
  const accountPath = join(HOME, ".local/share/opencode/account.json");
  try {
    if (existsSync(accountPath)) {
      const acct = JSON.parse(readFileSync(accountPath, "utf-8"));
      const activeId = acct.active?.[providerId];
      if (activeId && acct.accounts?.[activeId]?.credential?.key) {
        return acct.accounts[activeId].credential.key;
      }
    }
  } catch {}
  return null;
}

async function buildModelCatalog() {
  console.log("[proxy] fetching provider catalog from models.dev...");
  let providersData;
  try {
    providersData = curlFetchJSON(MODELS_DEV_URL);
  } catch (curlErr) {
    console.error(`[proxy] curl failed for models.dev: ${curlErr.message}, trying fetch...`);
    try {
      providersData = await fetchJSON(MODELS_DEV_URL);
    } catch (fetchErr) {
      console.error(`[proxy] fetch also failed: ${fetchErr.message}`);
      const cached = loadCachedCatalog();
      if (cached) {
        console.log("[proxy] using cached catalog as fallback");
        return cached;
      }
      throw new Error("cannot reach models.dev and no cache available");
    }
  }
  const allProviders = {};
  const allModels = {};

  for (const [providerId, providerInfo] of Object.entries(providersData)) {
    const apiKey = resolveAPIKey(providerId);
    const apiBase = providerInfo.api || "";
    const npm = providerInfo.npm || "";
    const envVars = providerInfo.env || [];

    const hasKey = !!apiKey || envVars.length === 0 || envVars.some((e) => process.env[e]);

    allProviders[providerId] = {
      id: providerId,
      name: providerInfo.name || providerId,
      api: apiBase,
      npm,
      env: envVars,
      hasKey,
      models: {},
    };

    for (const [modelId, modelInfo] of Object.entries(providerInfo.models || {})) {
      allModels[`${providerId}/${modelId}`] = {
        provider: providerId,
        id: modelId,
        name: modelInfo.name || modelId,
        reasoning: !!modelInfo.reasoning,
        tool_call: !!modelInfo.tool_call,
        attachment: !!modelInfo.attachment,
        temperature: modelInfo.temperature !== false,
        context: modelInfo.limit?.context || 128000,
        output: modelInfo.limit?.output || 8192,
        cost: modelInfo.cost || { input: 0, output: 0 },
        modalities: modelInfo.modalities || { input: ["text"], output: ["text"] },
      };
      allProviders[providerId].models[modelId] = allModels[`${providerId}/${modelId}`];
    }
  }

  const nvidiaKey = resolveAPIKey("nvidia");
  if (nvidiaKey) {
    const nvidiaLiveModels = await fetchNVIDIAModels(nvidiaKey);
    const nvidiaProvider = allProviders.nvidia;
    const nvidiaStaticModelIds = new Set(Object.keys(nvidiaProvider.models));
    for (const liveId of nvidiaLiveModels) {
      if (!nvidiaStaticModelIds.has(liveId)) {
        const newModel = {
          provider: "nvidia",
          id: liveId,
          name: liveId,
          reasoning: false,
          tool_call: true,
          attachment: false,
          temperature: true,
          context: 128000,
          output: 8192,
          cost: { input: 0, output: 0 },
          modalities: { input: ["text"], output: ["text"] },
          live: true,
        };
        allProviders.nvidia.models[liveId] = newModel;
        allModels[`nvidia/${liveId}`] = newModel;
      }
    }
    console.log(`[proxy] NVIDIA total models after merge: ${Object.keys(allProviders.nvidia.models).length}`);
  }

  const proxyProvider = {
    id: "proxy",
    name: "Universal Proxy",
    api: `http://127.0.0.1:${parseInt(process.env.PROXY_PORT || "18080", 10)}/v1`,
    npm: "@ai-sdk/openai-compatible",
    env: [],
    hasKey: true,
    models: {},
  };
  const virtualModels = ["flash", "heavy", "hybrid", "flash-default", "heavy-default"];
  for (const vm of virtualModels) {
    const fullId = `proxy/${vm}`;
    proxyProvider.models[vm] = {
      provider: "proxy",
      id: vm,
      name: `Proxy ${vm}`,
      reasoning: vm.includes("heavy"),
      tool_call: true,
      attachment: false,
      temperature: true,
      context: 128000,
      output: 8192,
      cost: { input: 0, output: 0 },
      modalities: { input: ["text"], output: ["text"] },
      virtual: true,
    };
    allModels[fullId] = proxyProvider.models[vm];
  }
  allProviders.proxy = proxyProvider;

  try {
    writeFileSync(CACHE_PATH, JSON.stringify({ providers: allProviders, models: allModels }, null, 2));
    console.log(`[proxy] catalog cached to ${CACHE_PATH}`);
  } catch {}

  return { providers: allProviders, models: allModels };
}

function loadCachedCatalog() {
  if (!existsSync(CACHE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function getProviderAPIBase(providerId) {
  if (!modelCatalog) return null;
  const provider = modelCatalog.providers[providerId];
  if (!provider) return null;
  let base = provider.api || "";
  const envVarMatches = base.match(/\$\{([^}]+)\}/g);
  if (envVarMatches) {
    for (const match of envVarMatches) {
      const varName = match.slice(2, -1);
      const val = process.env[varName] || "";
      base = base.replace(match, val);
    }
  }
  return base || null;
}

function checkReasoningRequest(reqBody) {
  const messages = reqBody.messages || [];
  const lastMsg = messages[messages.length - 1];
  const text = lastMsg?.content || "";
  const content = typeof text === "string" ? text : JSON.stringify(text);
  const reasoningKeywords = ["debug", "analyze", "reason", "math", "proof", "step-by-step", "explain why", "architecture", "deep", "complex", "refactor", "optimize", "security"];
  return reasoningKeywords.some(kw => content.toLowerCase().includes(kw));
}

function getSessionKey(reqBody) {
  const msgs = reqBody.messages || [];
  if (msgs.length === 0) return "_empty";
  const sys = msgs.find(m => m.role === "system");
  const firstUser = msgs.find(m => m.role === "user");
  const fp = (sys ? (typeof sys.content === "string" ? sys.content.slice(0, 200) : "sys") : "")
           + "|"
           + (firstUser ? (typeof firstUser.content === "string" ? firstUser.content.slice(0, 200) : "user") : "");
  return fp || "_empty";
}

function resolveHybridModel(reqBody) {
  if (!proxyConfig.modelFlash && !proxyConfig.modelHeavy) {
    return { error: "proxy models not configured: set flash or heavy model in config page" };
  }
  if (!proxyConfig.modelFlash) return proxyConfig.modelHeavy;
  if (!proxyConfig.modelHeavy) return proxyConfig.modelFlash;

  const msgs = reqBody.messages || [];
  const key = getSessionKey(reqBody);
  let session = hybridSessions.get(key);
  if (!session) {
    session = {};
    hybridSessions.set(key, session);
  }
  session.lastAccess = Date.now();

  const lastAssistantMsg = [...msgs].reverse().find(m => m.role === "assistant");
  const lastUserMsg = [...msgs].reverse().find(m => m.role === "user");

  const hadToolCalls = lastAssistantMsg &&
    (lastAssistantMsg.tool_calls ||
     (Array.isArray(lastAssistantMsg.content) &&
      lastAssistantMsg.content.some(p => p.type === "tool-call" || p.type === "tool_use")));

  const recentToolMsgs = msgs.slice(-6).filter(m => m.role === "tool" || m.role === "function");
  const hasToolErrors = recentToolMsgs.some(m => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return /error|exception|fail|timeout|not found|undefined|reject|denied|permission|forbidden/i.test(text.slice(0, 500));
  });

  const lastUserText = lastUserMsg
    ? (typeof lastUserMsg.content === "string" ? lastUserMsg.content : JSON.stringify(lastUserMsg.content))
    : "";

  const reasoningKeywords = ["debug", "analyze", "reason", "math", "proof", "step-by-step", "explain why", "architecture", "deep", "complex", "refactor", "optimize", "security", "design", "plan", "review", "migrate", "rearchitect", "overhaul", "restructure"];
  const hasReasoningKw = reasoningKeywords.some(kw => lastUserText.toLowerCase().includes(kw));

  const estimatedTokens = msgs.reduce((sum, m) => {
    const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + text.length / 4;
  }, 0);
  const isLargeContext = estimatedTokens > 15000;

  const isDowngradeEligible = /^(yes|ok|thanks|continue|next|keep going|go on|done|finish|sure|go ahead|proceed|retry|y|n)$/i.test(lastUserText.trim());

  const isContinue = /^(continue|next|keep going|go on|more|\.\.\.)$/i.test(lastUserText.trim());

  function requiredSimple(n) {
    return Math.min(3 * Math.max(n, 1), 15);
  }

  function setModel(model) {
    if (session.currentModel !== model) {
      if (model === proxyConfig.modelHeavy) {
        session.escalationCount = (session.escalationCount || 0) + 1;
      }
      session.currentModel = model;
      session.consecContinue = 0;
    }
  }

  if (hasToolErrors && proxyConfig.modelHeavy) {
    setModel(proxyConfig.modelHeavy);
    session.consecSimple = 0;
    return proxyConfig.modelHeavy;
  }

  if (hasReasoningKw && proxyConfig.modelHeavy) {
    setModel(proxyConfig.modelHeavy);
    session.consecSimple = 0;
    return proxyConfig.modelHeavy;
  }

  if (isLargeContext && proxyConfig.modelHeavy && session.currentModel !== proxyConfig.modelHeavy) {
    setModel(proxyConfig.modelHeavy);
    session.consecSimple = 0;
    return proxyConfig.modelHeavy;
  }

  if (hadToolCalls && session.currentModel) {
    session.consecSimple = 0;
    session.consecContinue = 0;
    return session.currentModel;
  }

  if (session.currentModel === proxyConfig.modelFlash && proxyConfig.modelHeavy) {
    if (isContinue) {
      session.consecContinue = (session.consecContinue || 0) + 1;
      if (session.consecContinue >= 3) {
        setModel(proxyConfig.modelHeavy);
        session.consecSimple = 0;
        session.consecContinue = 0;
        return proxyConfig.modelHeavy;
      }
    } else {
      session.consecContinue = 0;
    }
  }

  if (session.currentModel === proxyConfig.modelHeavy) {
    if (isDowngradeEligible) {
      session.consecSimple = (session.consecSimple || 0) + 1;
      if (session.consecSimple >= requiredSimple(session.escalationCount || 0)) {
        setModel(proxyConfig.modelFlash);
        session.consecSimple = 0;
        return proxyConfig.modelFlash;
      }
    } else {
      session.consecSimple = 0;
    }
    return proxyConfig.modelHeavy;
  }

  if (session.currentModel) {
    return session.currentModel;
  }

  session.currentModel = proxyConfig.modelFlash;
  session.consecSimple = 0;
  session.escalationCount = 0;
  session.consecContinue = 0;
  return proxyConfig.modelFlash;
}

function resolveProxyModel(reqBody) {
  let model = reqBody.model || "";
  if (!(model === "proxy" || model.startsWith("proxy/"))) return reqBody;

  const sub = model.split("/")[1] || "";
  if (sub === "flash" && proxyConfig.modelFlash) {
    model = proxyConfig.modelFlash;
  } else if (sub === "heavy" && proxyConfig.modelHeavy) {
    model = proxyConfig.modelHeavy;
  } else if (sub === "hybrid") {
    const resolved = resolveHybridModel(reqBody);
    if (resolved.error) return resolved;
    model = resolved;
  } else if (sub === "flash-default" || sub === "heavy-default") {
    if (sub === "flash-default" && proxyConfig.modelFlash) {
      model = proxyConfig.modelFlash;
    } else if (sub === "heavy-default" && proxyConfig.modelHeavy) {
      model = proxyConfig.modelHeavy;
    } else {
      return { error: `proxy model not configured: set ${sub} model in config page` };
    }
  } else if (proxyConfig.autoRoute) {
    const isReasoning = checkReasoningRequest(reqBody);
    if (isReasoning && proxyConfig.modelHeavy) {
      model = proxyConfig.modelHeavy;
    } else if (proxyConfig.modelFlash) {
      model = proxyConfig.modelFlash;
    }
  } else if (proxyConfig.modelFlash) {
    model = proxyConfig.modelFlash;
  } else {
    return { error: "no proxy models configured: set flash or heavy model in config page" };
  }
  return { ...reqBody, model };
}

async function streamResponse(response, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
  } catch {}
  res.end();
}

function isRateLimitError(errorObj) {
  if (!errorObj?.message) return false;
  const msg = String(errorObj.message).toLowerCase();
  return msg.includes("429") || msg.includes("rate") || msg.includes("limit") || msg.includes("quota") || msg.includes("too many") || msg.includes("capacity");
}

function applyTruncation(reqBody, model) {
  const modelContext = getModelContext(model);
  const budget = calculateContextBudget(modelContext);
  const messages = reqBody.messages || [];
  const inputTokens = estimateMessagesTokens(messages);

  if (inputTokens <= budget) {
    return { reqBody, truncated: false };
  }

  const truncResult = truncateMessages(messages, budget);

  if (truncResult.messages.length === 0 && messages.length > 0) {
    return { reqBody, truncated: false, oversized: true };
  }

  if (truncResult.tokensEstimate > budget * 1.1) {
    return { reqBody, truncated: false, oversized: true };
  }

  lastTruncationSummary = {
    model,
    keptMessages: truncResult.keptCount,
    droppedMessages: truncResult.droppedCount,
    tokensEstimate: truncResult.tokensEstimate,
    targetBudget: truncResult.targetBudget,
    keywordsPreserved: truncResult.keywordsFound,
    timestamp: Date.now(),
  };
  console.log(`[proxy] truncation: model=${model}, kept=${truncResult.keptCount} msgs, dropped=${truncResult.droppedCount} msgs, budget=${truncResult.tokensEstimate}/${truncResult.targetBudget} tokens, keywords=${truncResult.keywordsFound.join(",")}`);

  return { reqBody: { ...reqBody, messages: truncResult.messages }, truncated: true };
}

async function proxyRequest(reqBody, fallbackAttempted = false) {
  await throttleRPM();

  const resolved = resolveProxyModel(reqBody);
  if (resolved.error) {
    return { error: { message: resolved.error, type: "config_error" } };
  }
  reqBody = resolved;

  let model = reqBody.model || "";

  const truncResult = applyTruncation(reqBody, model);
  if (truncResult.truncated) {
    reqBody = { ...reqBody, messages: truncResult.messages };
  } else if (truncResult.oversized) {
    if (model === proxyConfig.modelFlash && proxyConfig.modelHeavy) {
      console.log(`[proxy] flash context exceeded even after truncation, escalating to heavy`);
      model = proxyConfig.modelHeavy;
      const heavyBudget = calculateContextBudget(getModelContext(model));
      const inputTokens = estimateMessagesTokens(reqBody.messages || []);
      if (inputTokens > heavyBudget) {
        const heavyTrunc = truncateMessages(reqBody.messages, heavyBudget);
        if (heavyTrunc.truncated) {
          lastTruncationSummary = {
            model,
            keptMessages: heavyTrunc.keptCount,
            droppedMessages: heavyTrunc.droppedCount,
            tokensEstimate: heavyTrunc.tokensEstimate,
            targetBudget: heavyTrunc.targetBudget,
            keywordsPreserved: heavyTrunc.keywordsFound,
            timestamp: Date.now(),
            escalatedFromFlash: true,
          };
          console.log(`[proxy] truncation (escalated): model=${model}, kept=${heavyTrunc.keptCount} msgs, dropped=${heavyTrunc.droppedCount} msgs`);
          reqBody = { ...reqBody, model, messages: heavyTrunc.messages };
        } else {
          reqBody = { ...reqBody, model };
        }
      } else {
        reqBody = { ...reqBody, model };
      }
    } else if (!fallbackAttempted && proxyConfig.modelHeavyFallback) {
      console.log(`[proxy] primary heavy context exceeded, trying fallback heavy: ${proxyConfig.modelHeavyFallback}`);
      lastFallbackEvent = { from: model, to: proxyConfig.modelHeavyFallback, reason: "context_oversize", timestamp: Date.now() };
      model = proxyConfig.modelHeavyFallback;
      const fbBudget = calculateContextBudget(getModelContext(model));
      const fbTrunc = truncateMessages(reqBody.messages, fbBudget);
      if (fbTrunc.truncated) {
        reqBody = { ...reqBody, model, messages: fbTrunc.messages };
      } else {
        reqBody = { ...reqBody, model };
      }
    } else {
      return { error: { message: "Context too large even after truncation. Try splitting conversation or using a model with larger context.", type: "context_error" } };
    }
  }

  const [providerId, ...modelParts] = model.split("/");
  const modelId = modelParts.join("/");
  const apiKey = resolveAPIKey(providerId);

  const apiBase = getProviderAPIBase(providerId);
  if (!apiBase) {
    return { error: { message: `no API base found for provider: ${providerId}`, type: "config_error" } };
  }

  const provider = modelCatalog?.providers[providerId];
  const npm = provider?.npm || "";
  const providerType = detectProviderType(providerId, npm);

  let url, headers, body;

  if (providerType === "anthropic") {
    url = `${apiBase}/messages`;
    headers = { "anthropic-version": "2023-06-01", "content-type": "application/json" };
    if (apiKey) headers["x-api-key"] = apiKey;
    body = convertToAnthropicFormat(reqBody, modelId);
  } else if (providerType === "google") {
    const isStream = !!reqBody.stream;
    const modelPath = modelId.includes("/") ? modelId : `models/${modelId}`;
    if (isStream) {
      url = `${apiBase}/${modelPath}:streamGenerateContent?alt=sse`;
    } else {
      url = `${apiBase}/${modelPath}:generateContent`;
    }
    headers = { "content-type": "application/json" };
    if (apiKey) headers["x-goog-api-key"] = apiKey;
    body = convertToGoogleFormat(reqBody, modelId);
  } else {
    url = `${apiBase}/chat/completions`;
    headers = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    body = { ...reqBody, model: modelId };
    if (body.stream && !body.stream_options) {
      body.stream_options = { include_usage: true };
    }
  }

  const now = Date.now();
  upstreamTimestamps.push(now);
  const cutoff = now - 60000;
  upstreamTimestamps = upstreamTimestamps.filter(t => t > cutoff);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      const errorMsg = `upstream ${response.status}: ${errText}`;
      if (!fallbackAttempted && isRateLimitError({ message: errorMsg })) {
        let fallbackModel = null;
        const isFlashModel = model === proxyConfig.modelFlash;
        const isHeavyModel = model === proxyConfig.modelHeavy;
        if (isFlashModel && proxyConfig.modelFlashFallback) {
          fallbackModel = proxyConfig.modelFlashFallback;
        } else if (isHeavyModel && proxyConfig.modelHeavyFallback) {
          fallbackModel = proxyConfig.modelHeavyFallback;
        }
        if (fallbackModel) {
          console.log(`[proxy] rate limit on ${model}, falling back to ${fallbackModel}`);
          lastFallbackEvent = { from: model, to: fallbackModel, reason: "rate_limit", timestamp: Date.now() };
          const fallbackBody = { ...reqBody, model: fallbackModel };
          return await proxyRequest(fallbackBody, true);
        }
      }
      return { error: { message: errorMsg, type: "upstream_error" } };
    }

    return response;
  } catch (err) {
    console.error(`[proxy] fetch to ${url} failed:`, err.message, err.cause?.message || "");
    if (!fallbackAttempted) {
      let fallbackModel = null;
      const isFlashModel = model === proxyConfig.modelFlash;
      const isHeavyModel = model === proxyConfig.modelHeavy;
      if (isFlashModel && proxyConfig.modelFlashFallback) {
        fallbackModel = proxyConfig.modelFlashFallback;
      } else if (isHeavyModel && proxyConfig.modelHeavyFallback) {
        fallbackModel = proxyConfig.modelHeavyFallback;
      }
      if (fallbackModel) {
        console.log(`[proxy] network error on ${model}, falling back to ${fallbackModel}`);
        lastFallbackEvent = { from: model, to: fallbackModel, reason: "network_error", timestamp: Date.now() };
        const fallbackBody = { ...reqBody, model: fallbackModel };
        return await proxyRequest(fallbackBody, true);
      }
    }
    return { error: { message: `fetch failed: ${err.message}`, type: "network_error" } };
  }
}

function detectProviderType(providerId, npm) {
  if (providerId === "anthropic" || npm.includes("anthropic") || providerId.includes("claudinio")) return "anthropic";
  if (providerId === "google" || providerId === "google-vertex" || npm.includes("google")) return "google";
  return "openai_compatible";
}

function convertToAnthropicFormat(reqBody, modelId) {
  const msgs = reqBody.messages || [];
  const systemMsg = msgs.find((m) => m.role === "system");
  const nonSystem = msgs.filter((m) => m.role !== "system");
  const messages = nonSystem.map((m) => {
    let role = m.role;
    if (role === "system") role = "user";
    let content = m.content;
    if (typeof content === "string") {
      content = [{ type: "text", text: content }];
    } else if (Array.isArray(content)) {
      content = content.map((part) => {
        if (part.type === "text") return { type: "text", text: part.text };
        if (part.type === "image_url") {
          const url = part.image_url?.url || "";
          if (url.startsWith("data:")) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              return { type: "image", source: { type: "base64", media_type: match[1], data: match[2] } };
            }
          }
          return { type: "text", text: url };
        }
        return { type: "text", text: JSON.stringify(part) };
      });
    }
    return { role, content };
  });
  const body = {
    model: modelId,
    messages,
    max_tokens: reqBody.max_tokens || 4096,
    temperature: reqBody.temperature,
    top_p: reqBody.top_p,
    stop_sequences: reqBody.stop || undefined,
    stream: reqBody.stream || false,
  };
  if (systemMsg) {
    body.system = typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content);
  }
  if (reqBody.tools) {
    body.tools = reqBody.tools.map((t) => ({
      name: t.function?.name || t.name,
      description: t.function?.description || t.description,
      input_schema: t.function?.parameters || t.input_schema,
    }));
    if (reqBody.tool_choice) {
      if (typeof reqBody.tool_choice === "string") {
        body.tool_choice = { type: reqBody.tool_choice };
      } else if (reqBody.tool_choice.function?.name) {
        body.tool_choice = { type: "tool", name: reqBody.tool_choice.function.name };
      } else {
        body.tool_choice = reqBody.tool_choice;
      }
    }
  }
  return body;
}

function convertToGoogleFormat(reqBody, modelId) {
  const msgs = reqBody.messages || [];
  const systemMsg = msgs.find((m) => m.role === "system");
  const nonSystem = msgs.filter((m) => m.role !== "system");
  const contents = nonSystem.map((m) => {
    const role = m.role === "assistant" ? "model" : m.role === "system" ? "user" : m.role;
    let parts;
    if (typeof m.content === "string") {
      parts = [{ text: m.content }];
    } else if (Array.isArray(m.content)) {
      parts = m.content.map((part) => {
        if (part.type === "text") return { text: part.text };
        if (part.type === "image_url") {
          return { inlineData: { mimeType: "image/jpeg", data: part.image_url?.url?.replace(/^data:image\/\w+;base64,/, "") || "" } };
        }
        return { text: JSON.stringify(part) };
      });
    } else {
      parts = [{ text: String(m.content) }];
    }
    return { role, parts };
  });
  const body = {
    contents,
    generationConfig: {
      maxOutputTokens: reqBody.max_tokens,
      temperature: reqBody.temperature,
      topP: reqBody.top_p,
      topK: reqBody.top_k,
      frequencyPenalty: reqBody.frequency_penalty,
      presencePenalty: reqBody.presence_penalty,
      stopSequences: reqBody.stop || undefined,
      seed: reqBody.seed,
    },
  };
  if (systemMsg) {
    const instr = typeof systemMsg.content === "string" ? systemMsg.content : JSON.stringify(systemMsg.content);
    body.systemInstruction = { role: "user", parts: [{ text: instr }] };
  }
  if (reqBody.tools) {
    body.tools = reqBody.tools.map((t) => ({
      functionDeclarations: [{
        name: t.function?.name || t.name,
        description: t.function?.description || t.description,
        parameters: t.function?.parameters || t.parameters,
      }],
    }));
  }
  return body;
}

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${DEFAULT_PORT}`);

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/config.html")) {
    serveConfigPage(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/config") {
    const flashCtx = proxyConfig.modelFlash ? getModelContext(proxyConfig.modelFlash) : null;
    const heavyCtx = proxyConfig.modelHeavy ? getModelContext(proxyConfig.modelHeavy) : null;
    const fbFlashCtx = proxyConfig.modelFlashFallback ? getModelContext(proxyConfig.modelFlashFallback) : null;
    const fbHeavyCtx = proxyConfig.modelHeavyFallback ? getModelContext(proxyConfig.modelHeavyFallback) : null;
    const ratio = (flashCtx && heavyCtx && flashCtx > 0) ? (heavyCtx / flashCtx).toFixed(1) : null;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      rpm: proxyConfig.rpm,
      modelFlash: proxyConfig.modelFlash,
      modelHeavy: proxyConfig.modelHeavy,
      modelFlashFallback: proxyConfig.modelFlashFallback,
      modelHeavyFallback: proxyConfig.modelHeavyFallback,
      autoRoute: proxyConfig.autoRoute,
      flashModelContext: flashCtx,
      heavyModelContext: heavyCtx,
      flashFallbackModelContext: fbFlashCtx,
      heavyFallbackModelContext: fbHeavyCtx,
      ratio,
      warning: (ratio && parseFloat(ratio) > 50) ? `Flash context is ${ratio}x smaller than heavy - aggressive truncation will be applied` : null,
    }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/config") {
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const newConfig = JSON.parse(body);
      if (newConfig.rpm !== undefined) proxyConfig.rpm = Math.max(1, Math.min(600, parseInt(newConfig.rpm) || 40));
      if (newConfig.modelFlash !== undefined) proxyConfig.modelFlash = newConfig.modelFlash;
      if (newConfig.modelHeavy !== undefined) proxyConfig.modelHeavy = newConfig.modelHeavy;
      if (newConfig.modelFlashFallback !== undefined) proxyConfig.modelFlashFallback = newConfig.modelFlashFallback;
      if (newConfig.modelHeavyFallback !== undefined) proxyConfig.modelHeavyFallback = newConfig.modelHeavyFallback;
      if (newConfig.autoRoute !== undefined) proxyConfig.autoRoute = !!newConfig.autoRoute;
      saveProxyConfig();
      updateVirtualModelContexts();

      const flashCtx = proxyConfig.modelFlash ? getModelContext(proxyConfig.modelFlash) : null;
      const heavyCtx = proxyConfig.modelHeavy ? getModelContext(proxyConfig.modelHeavy) : null;
      const fbFlashCtx = proxyConfig.modelFlashFallback ? getModelContext(proxyConfig.modelFlashFallback) : null;
      const fbHeavyCtx = proxyConfig.modelHeavyFallback ? getModelContext(proxyConfig.modelHeavyFallback) : null;
      const ratio = (flashCtx && heavyCtx && flashCtx > 0) ? (heavyCtx / flashCtx).toFixed(1) : null;

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        config: proxyConfig,
        flashModelContext: flashCtx,
        heavyModelContext: heavyCtx,
        flashFallbackModelContext: fbFlashCtx,
        heavyFallbackModelContext: fbHeavyCtx,
        ratio,
        warning: (ratio && parseFloat(ratio) > 50) ? `Flash context is ${ratio}x smaller than heavy - aggressive truncation will be applied` : null,
      }));
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid JSON" }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const allModelIds = [];
    for (const [providerId, provider] of Object.entries(modelCatalog.providers)) {
      for (const [modelId, minfo] of Object.entries(provider.models)) {
        allModelIds.push({ id: `${providerId}/${modelId}`, object: "model", provider: providerId, context: minfo.context });
      }
    }
    res.end(JSON.stringify({ object: "list", data: allModelIds }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/providers") {
    res.writeHead(200, { "Content-Type": "application/json" });
    const providerSummary = {};
    for (const [pid, p] of Object.entries(modelCatalog.providers)) {
      providerSummary[pid] = {
        name: p.name,
        hasKey: p.hasKey,
        modelCount: Object.keys(p.models).length,
        api: p.api,
        npm: p.npm,
      };
    }
    res.end(JSON.stringify(providerSummary));
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", providers: Object.keys(modelCatalog.providers).length, models: Object.keys(modelCatalog.models).length }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let reqBody;
    try {
      reqBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
      return;
    }

    const result = await proxyRequest(reqBody);

    if (result.error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (result instanceof Response || result.body) {
      const isStream = reqBody.stream && result.headers?.get("content-type")?.includes("text/event-stream");
      if (isStream) {
        await streamResponse(result, res);
      } else {
        const text = await result.text();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(text);
      }
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/messages") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let reqBody;
    try {
      reqBody = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid JSON body" } }));
      return;
    }

    const openaiBody = {
      model: reqBody.model,
      messages: [],
      max_tokens: reqBody.max_tokens,
      temperature: reqBody.temperature,
      top_p: reqBody.top_p,
      top_k: reqBody.top_k,
      stop: reqBody.stop_sequences,
      stream: reqBody.stream || false,
    };

    if (reqBody.system) {
      openaiBody.messages.push({ role: "system", content: reqBody.system });
    }
    for (const m of reqBody.messages || []) {
      openaiBody.messages.push({
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : c))
          : m.content,
      });
    }
    if (reqBody.tools) {
      openaiBody.tools = reqBody.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
    }

    const result = await proxyRequest(openaiBody);

    if (result.error) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result));
      return;
    }

    if (result instanceof Response || result.body) {
      const text = await result.text();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(text);
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "POST" && url.pathname === "/v1/refresh") {
    console.log("[proxy] refreshing model catalog...");
    const catalog = await buildModelCatalog();
    modelCatalog = catalog;
    updateVirtualModelContexts();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "refreshed", providers: Object.keys(catalog.providers).length, models: Object.keys(catalog.models).length }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    const now = Date.now();
    const cutoff = now - 60000;
    const recent = upstreamTimestamps.filter(t => t > cutoff);
    const intervals = [];
    for (let i = 1; i < recent.length; i++) {
      intervals.push(recent[i] - recent[i-1]);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      rpm: proxyConfig.rpm,
      upstreamCountLast60s: recent.length,
      lastRequestAgo: recent.length ? (now - recent[recent.length-1]) + "ms" : "none",
      minIntervalMs: intervals.length ? Math.min(...intervals) : null,
      maxIntervalMs: intervals.length ? Math.max(...intervals) : null,
      avgIntervalMs: intervals.length ? (intervals.reduce((a,b) => a+b, 0) / intervals.length).toFixed(0) : null,
      lastTruncationSummary,
      lastFallbackEvent,
      modelFlash: proxyConfig.modelFlash,
      modelHeavy: proxyConfig.modelHeavy,
      modelFlashFallback: proxyConfig.modelFlashFallback,
      modelHeavyFallback: proxyConfig.modelHeavyFallback,
      flashContext: proxyConfig.modelFlash ? getModelContext(proxyConfig.modelFlash) : null,
      heavyContext: proxyConfig.modelHeavy ? getModelContext(proxyConfig.modelHeavy) : null,
    }));
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: { message: `unknown route: ${req.method} ${url.pathname}` } }));
}

async function main() {
  const port = parseInt(process.env.PROXY_PORT || String(DEFAULT_PORT), 10);

  console.log("[proxy] building model catalog at startup...");
  const catalog = await buildModelCatalog();
  modelCatalog = catalog;

  updateVirtualModelContexts();

  const providerCount = Object.keys(catalog.providers).length;
  const modelCount = Object.keys(catalog.models).length;
  console.log(`[proxy] catalog ready: ${providerCount} providers, ${modelCount} models`);

  const flashCtx = proxyConfig.modelFlash ? getModelContext(proxyConfig.modelFlash) : "N/A";
  const heavyCtx = proxyConfig.modelHeavy ? getModelContext(proxyConfig.modelHeavy) : "N/A";
  console.log(`[proxy] flash model: ${proxyConfig.modelFlash || "none"} (context: ${flashCtx})`);
  console.log(`[proxy] heavy model: ${proxyConfig.modelHeavy || "none"} (context: ${heavyCtx})`);
  if (proxyConfig.modelFlashFallback) console.log(`[proxy] fallback flash: ${proxyConfig.modelFlashFallback} (context: ${getModelContext(proxyConfig.modelFlashFallback)})`);
  if (proxyConfig.modelHeavyFallback) console.log(`[proxy] fallback heavy: ${proxyConfig.modelHeavyFallback} (context: ${getModelContext(proxyConfig.modelHeavyFallback)})`);

  const server = createServer(handleRequest);
  setInterval(() => {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [key, session] of hybridSessions) {
      if (session.lastAccess && session.lastAccess < cutoff) {
        hybridSessions.delete(key);
      }
    }
  }, 5 * 60 * 1000).unref();
  server.listen(port, () => {
    console.log(`[proxy] opencode universal proxy listening on http://127.0.0.1:${port}`);
    console.log(`[proxy] endpoints:`);
    console.log(`[proxy]   GET  /                     - config UI with context display`);
    console.log(`[proxy]   GET  /v1/models             - list all available models`);
    console.log(`[proxy]   GET  /v1/providers          - list all providers with key status`);
    console.log(`[proxy]   POST /v1/chat/completions   - openai-compatible proxy`);
    console.log(`[proxy]   POST /v1/messages            - anthropic-compatible proxy`);
    console.log(`[proxy]   POST /v1/refresh             - refresh model catalog from models.dev + NVIDIA API`);
    console.log(`[proxy]   GET  /api/stats              - stats (RPM, truncation, fallback)`);
    console.log(`[proxy]   GET  /health                 - health check`);
  });
}

main().catch((err) => {
  console.error("[proxy] fatal:", err);
  process.exit(1);
});
