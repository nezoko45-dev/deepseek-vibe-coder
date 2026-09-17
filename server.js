import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRepositorySnapshot, createBranch, createAtomicCommit, createPullRequest } from "./github.js";
import { SYSTEM_PROMPT } from "./prompts.js";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const GROQ_URL = process.env.GROQ_URL || "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readConfigFile(name) {
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) return {};
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error(`${name} is not valid JSON.`); }
}

const config = readConfigFile("config.json");
const exampleConfig = readConfigFile("config.example.json");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || config.githubToken || exampleConfig.githubToken || "";
const GROQ_API_KEY = process.env.GROQ_API_KEY || config.groqApiKey || exampleConfig.groqApiKey || "";
const DEFAULT_REPO = process.env.DEFAULT_REPO || config.defaultRepo || exampleConfig.defaultRepo || "nezoko45-dev/deepseek-vibe-coder";

function send(res, status, data, type = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization"
  });
  res.end(type.startsWith("application/json") ? JSON.stringify(data, null, 2) : data);
}

function serveApp(res) {
  return send(res, 200, fs.readFileSync(path.join(__dirname, "index.html"), "utf8"), "text/html; charset=utf-8");
}

function slug(value) {
  return String(value || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "task";
}

function validRepo(repo) { return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo); }
function validPath(p) {
  return typeof p === "string" && p.length > 0 && p.length <= 240 && !p.startsWith("/") && !p.includes("..\\") && !p.includes("../") && !p.includes("\\..\\");
}

function parseAgentJson(text) {
  const cleaned = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {}
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) throw new Error("Groq returned no valid JSON coding plan.");
  return JSON.parse(match[0]);
}

async function askGroq(prompt) {
  if (!GROQ_API_KEY) throw new Error("Missing Groq API key. Add groqApiKey to config.json or config.example.json.");

  const response = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ],
      temperature: 0.1,
      max_completion_tokens: 16000
    })
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`Groq ${response.status}: ${text.slice(0, 1600)}`);

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error("Groq returned invalid JSON."); }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Groq returned no coding plan.");
  return parseAgentJson(content);
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
  const repo = String(body.repo || DEFAULT_REPO).trim();
  const base = String(body.base || "main").trim();

  if (!task) throw new Error("Missing task.");
  if (!validRepo(repo)) throw new Error("repo must look like owner/name.");
  if (!/^[A-Za-z0-9_.\/-]+$/.test(base)) throw new Error("Invalid base branch.");
  if (!GROQ_API_KEY) throw new Error("Missing Groq API key.");
  if (!GITHUB_TOKEN) throw new Error("Missing GitHub token. Groq handles the coding intelligence, while GitHub authentication is required to create branches, commits, and PRs.");

  const snapshot = await getRepositorySnapshot(GITHUB_TOKEN, repo, base);
  const prompt = [
    `USER TASK:\n${task}`,
    `TARGET REPOSITORY: ${repo}`,
    `BASE BRANCH: ${base}`,
    `REPOSITORY FILES:\n${JSON.stringify(snapshot.files)}`,
    "Return ONLY the JSON coding plan required by the system prompt. Do not explain it outside the JSON."
  ].join("\n\n");

  const plan = await askGroq(prompt);
  if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) throw new Error("Groq produced no file changes.");
  if (plan.files.length > 25) throw new Error("Groq requested too many file changes.");

  const existing = new Set(snapshot.allPaths || snapshot.files.map(x => x.path));
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
  await createBranch(GITHUB_TOKEN, repo, branch, snapshot.commitSha);
  const commit = await createAtomicCommit(GITHUB_TOKEN, repo, branch, snapshot.treeSha, snapshot.commitSha, changes, plan.commitMessage || `vibe: ${task.slice(0, 60)}`);
  const pr = await createPullRequest(GITHUB_TOKEN, repo, branch, base, plan.prTitle || `Groq coding: ${task.slice(0, 60)}`, plan.prBody || `Groq generated this change from the task:\n\n${task}`);

  return { ok: true, summary: plan.summary || "Changes generated by Groq.", repo, base, branch, commit: commit.sha, pullRequestUrl: pr.html_url, changes: changes.map(x => ({ path: x.path, action: x.action })) };
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "OPTIONS") return send(res, 204, "", "text/plain; charset=utf-8");
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && ["/", "/index.html", "/app"].includes(url.pathname)) return serveApp(res);

    if (req.method === "GET" && url.pathname === "/api/status") {
      let groqOnline = false;
      if (GROQ_API_KEY) {
        try {
          const r = await fetch("https://api.groq.com/openai/v1/models", { headers: { authorization: `Bearer ${GROQ_API_KEY}` } });
          groqOnline = r.ok;
        } catch {}
      }
      return send(res, 200, {
        name: "Groq GitHub Vibe Coder",
        status: "online",
        groqOnline,
        model: GROQ_MODEL,
        githubConfigured: Boolean(GITHUB_TOKEN),
        apiKeyRequired: true,
        deepgram: false,
        cloudflare: false,
        ollama: false
      });
    }

    if (req.method === "POST" && url.pathname === "/vibe") return send(res, 200, await vibe(await readBody(req)));
    return send(res, 404, { error: "Not found" });
  } catch (error) {
    console.error(error);
    return send(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(PORT, HOST, () => console.log(`Groq Vibe Coder running at http://${HOST}:${PORT}`));
