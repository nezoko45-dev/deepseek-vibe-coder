import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRepositorySnapshot, createBranch, createAtomicCommit, createPullRequest } from "./github.js";
import { SYSTEM_PROMPT } from "./prompts.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const QWEN_URL = process.env.QWEN_URL || "http://127.0.0.1:11434/api/chat";
const QWEN_MODEL = process.env.QWEN_MODEL || "qwen3-coder:30b";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadConfig() {
  const file = path.join(__dirname, "config.json");
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("config.json is not valid JSON."); }
}
const config = loadConfig();
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || config.githubToken || "";
const DEFAULT_REPO = process.env.DEFAULT_REPO || config.defaultRepo || "nezoko45-dev/deepseek-vibe-coder";

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "content-type": type, "access-control-allow-origin": "*", "access-control-allow-methods": "GET,POST,OPTIONS", "access-control-allow-headers": "content-type,authorization" });
  res.end(type.startsWith("application/json") ? JSON.stringify(data, null, 2) : data);
}
function serveApp(res) { return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), "text/html; charset=utf-8"); }
function slug(value) { return String(value || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "task"; }
function validRepo(repo) { return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo); }
function validPath(p) { return typeof p === "string" && p.length > 0 && p.length <= 240 && !p.startsWith("/") && !p.includes("..\\") && !p.includes("../") && !p.includes("\\..\\"); }

async function askQwen(messages) {
  let response;
  try {
    response = await fetch(QWEN_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: QWEN_MODEL, messages, stream: false, format: "json", options: { temperature: 0.15 } })
    });
  } catch {
    throw new Error(`Qwen is not running. Install/start Ollama and make sure ${QWEN_MODEL} is available locally.`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`Qwen/Ollama ${response.status}: ${text.slice(0, 1200)}`);
  let data;
  try { data = JSON.parse(text); } catch { throw new Error("Qwen returned invalid Ollama JSON."); }
  const content = data?.message?.content;
  if (!content) throw new Error("Qwen returned no message content.");
  try { return JSON.parse(content); }
  catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("Qwen returned invalid coding-plan JSON.");
    return JSON.parse(match[0]);
  }
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
  if (!GITHUB_TOKEN) throw new Error("Missing GitHub token. Qwen itself needs no API key, but GitHub write access still requires a token.");
  const snapshot = await getRepositorySnapshot(GITHUB_TOKEN, repo, base);
  const prompt = [`USER TASK:\n${task}`, `TARGET REPOSITORY: ${repo}`, `BASE BRANCH: ${base}`, `REPOSITORY FILES:\n${JSON.stringify(snapshot.files)}`].join("\n\n");
  const plan = await askQwen([{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: prompt }]);
  if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) throw new Error("Qwen produced no file changes.");
  if (plan.files.length > 25) throw new Error("Qwen requested too many file changes.");
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
  const pr = await createPullRequest(GITHUB_TOKEN, repo, branch, base, plan.prTitle || `Qwen coding: ${task.slice(0, 60)}`, plan.prBody || `Qwen generated this change from the task:\n\n${task}`);
  return { ok: true, summary: plan.summary || "Changes generated by local Qwen.", repo, base, branch, commit: commit.sha, pullRequestUrl: pr.html_url, changes: changes.map(x => ({ path: x.path, action: x.action })) };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "", "text/plain; charset=utf-8");
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html" || url.pathname === "/app")) return serveApp(res);
    if (req.method === "GET" && url.pathname === "/api/status") {
      let qwenOnline = false;
      try { const r = await fetch(QWEN_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: QWEN_MODEL, messages: [{ role: "user", content: "Reply with OK." }], stream: false }) }); qwenOnline = r.ok; } catch {}
      return send(res, 200, { name: "Qwen GitHub Vibe Coder", status: "online", qwenOnline, model: QWEN_MODEL, githubConfigured: Boolean(GITHUB_TOKEN), apiKeyRequired: false, cloudflare: false });
    }
    if (req.method === "POST" && url.pathname === "/vibe") return send(res, 200, await vibe(await readBody(req)));
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});
server.listen(PORT, HOST, () => console.log(`Qwen Vibe Coder running at http://${HOST}:${PORT}`));
