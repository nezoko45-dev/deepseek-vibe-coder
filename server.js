import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRepositorySnapshot, createBranch, createAtomicCommit, createPullRequest } from "./github.js";
import { SYSTEM_PROMPT } from "./prompts.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data, null, 2) : data);
}

function slug(value) {
  return String(value || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "task";
}

function validRepo(repo) { return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo); }
function validPath(p) { return typeof p === "string" && p.length > 0 && p.length <= 240 && !p.startsWith("/") && !p.includes("..\\") && !p.includes("../") && !p.includes("\\..\\"); }

async function askDeepSeek(messages) {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) throw new Error("Missing DEEPSEEK_API_KEY environment variable.");
  const response = await fetch(process.env.DEEPSEEK_API_URL || "https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || "deepseek-v4-pro",
      messages,
      temperature: 0.15,
      response_format: { type: "json_object" }
    })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`DeepSeek ${response.status}: ${text.slice(0, 1200)}`);
  const data = JSON.parse(text);
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("DeepSeek returned no message content.");
  try { return JSON.parse(content); }
  catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("DeepSeek returned invalid JSON.");
    return JSON.parse(match[0]);
  }
}

async function readBody(req) {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 200000) throw new Error("Request body is too large.");
  }
  return JSON.parse(text || "{}");
}

async function vibe(body) {
  const task = String(body.task || "").trim();
  const repo = String(body.repo || process.env.DEFAULT_REPO || "").trim();
  const base = String(body.base || "main").trim();
  if (!task) throw new Error("Missing task.");
  if (!validRepo(repo)) throw new Error("repo must look like owner/name.");
  if (!/^[A-Za-z0-9_.\/-]+$/.test(base)) throw new Error("Invalid base branch.");
  if (!process.env.GITHUB_TOKEN) throw new Error("Missing GITHUB_TOKEN environment variable.");

  const snapshot = await getRepositorySnapshot(process.env.GITHUB_TOKEN, repo, base);
  const prompt = [
    `USER TASK:\n${task}`,
    `TARGET REPOSITORY: ${repo}`,
    `BASE BRANCH: ${base}`,
    `REPOSITORY FILES:\n${JSON.stringify(snapshot.files)}`
  ].join("\n\n");

  const plan = await askDeepSeek([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: prompt }
  ]);
  if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) throw new Error("DeepSeek produced no file changes.");
  if (plan.files.length > 25) throw new Error("DeepSeek requested too many file changes.");

  const existing = new Set(snapshot.files.map(x => x.path));
  const changes = plan.files.map(x => ({
    path: String(x.path || ""),
    action: String(x.action || "update"),
    content: x.content == null ? null : String(x.content)
  }));
  for (const change of changes) {
    if (!validPath(change.path)) throw new Error(`Invalid file path: ${change.path}`);
    if (!["create", "update", "delete"].includes(change.action)) throw new Error(`Invalid action for ${change.path}`);
    if (change.action === "create" && existing.has(change.path)) throw new Error(`File already exists: ${change.path}`);
    if ((change.action === "update" || change.action === "delete") && !existing.has(change.path)) throw new Error(`File does not exist: ${change.path}`);
    if (change.action !== "delete" && (change.content || "").length > 100000) throw new Error(`File too large: ${change.path}`);
  }

  const branch = `vibe/${Date.now()}-${slug(task)}`;
  await createBranch(process.env.GITHUB_TOKEN, repo, branch, snapshot.commitSha);
  const commit = await createAtomicCommit(process.env.GITHUB_TOKEN, repo, branch, snapshot.treeSha, snapshot.commitSha, changes, plan.commitMessage || `vibe: ${task.slice(0, 60)}`);
  const pr = await createPullRequest(process.env.GITHUB_TOKEN, repo, branch, base, plan.prTitle || `Vibe coding: ${task.slice(0, 60)}`, plan.prBody || `DeepSeek generated this change from the task:\n\n${task}`);
  return { ok: true, summary: plan.summary || "Changes generated.", repo, base, branch, commit: commit.sha, pullRequestUrl: pr.html_url, changes: changes.map(x => ({ path: x.path, action: x.action })) };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "", "text/plain; charset=utf-8");
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/") {
      return send(res, 200, { name: "DeepSeek GitHub Vibe Coder", status: "online", endpoint: "POST /vibe" });
    }
    if (req.method === "GET" && url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");
      return send(res, 200, html, "text/html; charset=utf-8");
    }
    if (req.method === "POST" && url.pathname === "/vibe") {
      const result = await vibe(await readBody(req));
      return send(res, 200, result);
    }
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => console.log(`DeepSeek Vibe Coder running at http://${HOST}:${PORT}`));
