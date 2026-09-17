import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { getRepositorySnapshot, createBranch, createAtomicCommit, createPullRequest } from "./github.js";
import { SYSTEM_PROMPT } from "./prompts.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const DEEPGRAM_AGENT_URL = process.env.DEEPGRAM_AGENT_URL || "wss://agent.deepgram.com/v1/agent/converse";
const DEEPGRAM_MODEL = process.env.DEEPGRAM_MODEL || "gpt-5-mini";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const file = path.join(__dirname, "config.json");
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("config.json is not valid JSON."); }
}
const config = loadConfig();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || config.githubToken || "";
const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY || config.deepgramApiKey || "";
const DEFAULT_REPO = process.env.DEFAULT_REPO || config.defaultRepo || "nezoko45-dev/deepseek-vibe-coder";

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" });
  res.end(type.startsWith("application/json") ? JSON.stringify(data, null, 2) : data);
}
function serveApp(res) { return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), "text/html; charset=utf-8"); }
function slug(value) { return String(value || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "task"; }
function validRepo(repo) { return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo); }
function validPath(p) { return typeof p === "string" && p.length > 0 && p.length <= 240 && !p.startsWith("/") && !p.includes("..\\") && !p.includes("../") && !p.includes("\\..\\"); }
function parseAgentJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Deepgram's coding agent returned no valid JSON plan.");
  return JSON.parse(match[0]);
}

async function askDeepgram(prompt) {
  if (!DEEPGRAM_API_KEY) throw new Error("Missing Deepgram API key. Add deepgramApiKey to config.json.");
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(DEEPGRAM_AGENT_URL, { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } });
    let settled = false;
    let answer = "";
    let audioDone = false;
    const timer = setTimeout(() => finish(reject, new Error("Deepgram coding agent timed out.")), 120000);
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); try { ws.close(); } catch {} fn(value); };
    ws.on("open", () => {
      ws.send(JSON.stringify({
        type: "Settings",
        audio: { input: { encoding: "linear16", sample_rate: 24000 }, output: { encoding: "linear16", sample_rate: 24000, container: "none" } },
        agent: {
          language: "en",
          listen: { provider: { type: "deepgram", model: "flux-general-en" } },
          speak: { provider: { type: "deepgram", model: "aura-2-asteria-en" } },
          think: [
            { provider: { type: "open_ai", model: DEEPGRAM_MODEL, temperature: 0.15 }, prompt: SYSTEM_PROMPT },
            { provider: { type: "open_ai", model: "gpt-4.1-mini", temperature: 0.15 }, prompt: SYSTEM_PROMPT }
          ]
        },
        flags: { history: true }
      }));
      ws.send(JSON.stringify({ type: "InjectUserMessage", content: prompt }));
    });
    ws.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "Error" || msg.type === "AgentError") return finish(reject, new Error(msg.description || msg.message || msg.code || "Deepgram agent error."));
      if (msg.type === "Warning" && msg.code === "THINK_REQUEST_FAILED") return finish(reject, new Error(`Deepgram LLM request failed: ${msg.description || "both configured think providers failed"}`));
      if (msg.type === "History") {
        const messages = msg.history || msg.messages || [];
        const latest = [...messages].reverse().find(x => x.role === "assistant" && x.content);
        if (latest) answer = latest.content;
      }
      if (msg.type === "AgentAudioDone") audioDone = true;
      if (answer && audioDone) {
        try { finish(resolve, parseAgentJson(answer)); }
        catch (err) { finish(reject, err); }
      }
    });
    ws.on("error", err => finish(reject, new Error(`Deepgram connection failed: ${err.message}`)));
    ws.on("close", () => {
      if (settled) return;
      if (answer) { try { finish(resolve, parseAgentJson(answer)); } catch (err) { finish(reject, err); } }
      else finish(reject, new Error("Deepgram coding agent closed before returning a result."));
    });
  });
}

async function readBody(req) {
  let text = "";
  for await (const chunk of req) { text += chunk; if (text.length > 200000) throw new Error("Request body is too large."); }
  return JSON.parse(text || "{}");
}

async function vibe(body) {
  const task = String(body.task || "").trim();
  const repo = String(body.repo || DEFAULT_REPO).trim();
  const base = String(body.base || "main").trim();
  if (!task) throw new Error("Missing task.");
  if (!validRepo(repo)) throw new Error("repo must look like owner/name.");
  if (!/^[A-Za-z0-9_.\/-]+$/.test(base)) throw new Error("Invalid base branch.");
  if (!DEEPGRAM_API_KEY) throw new Error("Missing Deepgram API key.");
  if (!GITHUB_TOKEN) throw new Error("Missing GitHub token. Deepgram handles the coding intelligence, while GitHub authentication is still required to create branches, commits, and PRs.");

  const snapshot = await getRepositorySnapshot(GITHUB_TOKEN, repo, base);
  const prompt = [
    `USER TASK:\n${task}`,
    `TARGET REPOSITORY: ${repo}`,
    `BASE BRANCH: ${base}`,
    `REPOSITORY FILES:\n${JSON.stringify(snapshot.files)}`,
    "Return ONLY the JSON coding plan required by the system prompt. Do not explain it outside the JSON."
  ].join("\n\n");
  const plan = await askDeepgram(prompt);
  if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) throw new Error("Deepgram produced no file changes.");
  if (plan.files.length > 25) throw new Error("Deepgram requested too many file changes.");
  const existing = new Set(snapshot.allPaths || snapshot.files.map(x => x.path));
  const changes = plan.files.map(x => ({ path: String(x.path || ""), action: String(x.action || "update"), content: x.content == null ? null : String(x.content) }));
  for (const change of changes) {
    if (!validPath(change.path)) throw new Error(`Invalid file path: ${change.path}`);
    if (!["create", "update", "delete"].includes(change.action)) throw new Error(`Invalid action for ${change.path}`);
    if (change.action === "create" && existing.has(change.path)) throw new Error(`File already exists: ${change.path}`);
    if ((change.action === "update" || change.action === "delete") && !existing.has(change.path)) throw new Error(`File does not exist: ${change.path}`);
    if (change.action !== "delete" && (change.content || "").length > 100000) throw new Error(`File too large: ${change.path}`);
  }
  const branch = `vibe/${Date.now()}-${slug(task)}`;
  await createBranch(GITHUB_TOKEN, repo, branch, snapshot.commitSha);
  const commit = await createAtomicCommit(GITHUB_TOKEN, repo, branch, snapshot.treeSha, snapshot.commitSha, changes, plan.commitMessage || `vibe: ${task.slice(0, 60)}`);
  const pr = await createPullRequest(GITHUB_TOKEN, repo, branch, base, plan.prTitle || `Deepgram coding: ${task.slice(0, 60)}`, plan.prBody || `Deepgram generated this change from the task:\n\n${task}`);
  return { ok: true, summary: plan.summary || "Changes generated by Deepgram's coding agent.", repo, base, branch, commit: commit.sha, pullRequestUrl: pr.html_url, changes: changes.map(x => ({ path: x.path, action: x.action })) };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "", "text/plain; charset=utf-8");
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/app")) return serveApp(res);
    if (req.method === "GET" && url.pathname === "/api/status") {
      let deepgramOnline = false;
      if (DEEPGRAM_API_KEY) {
        try { const r = await fetch("https://api.deepgram.com/v1/projects", { headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` } }); deepgramOnline = r.ok; } catch {}
      }
      return send(res, 200, { name: "Deepgram GitHub Vibe Coder", status: "online", deepgramOnline, model: DEEPGRAM_MODEL, githubConfigured: Boolean(GITHUB_TOKEN), apiKeyRequired: true, cloudflare: false, ollama: false });
    }
    if (req.method === "POST" && url.pathname === "/vibe") return send(res, 200, await vibe(await readBody(req)));
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(PORT, HOST, () => console.log(`Deepgram Vibe Coder running at http://${HOST}:${PORT}`));
