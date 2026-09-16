import { askDeepSeek } from "./deepseek.js";
import { SYSTEM_PROMPT } from "./prompts.js";
import { getRepositorySnapshot, createBranch, createAtomicCommit, createPullRequest } from "./github.js";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS }
  });
}

function slug(value) {
  return String(value || "task").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42) || "task";
}

function validRepo(repo) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo);
}

function validPath(path) {
  return typeof path === "string" && path.length > 0 && path.length <= 240 && !path.startsWith("/") && !path.includes("..\\") && !path.includes("../") && !path.includes("\\..\\");
}

function auth(request, env) {
  const configured = env.AGENT_KEY;
  if (!configured) return false;
  const value = request.headers.get("authorization") || "";
  return value === `Bearer ${configured}`;
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return json({ name: "DeepSeek GitHub Vibe Coder", status: "online", endpoint: "POST /vibe" });
    }

    if (url.pathname !== "/vibe" || request.method !== "POST") {
      return json({ error: "Not found" }, 404);
    }

    if (!auth(request, env)) return json({ error: "Unauthorized. Configure AGENT_KEY and send Authorization: Bearer <key>." }, 401);
    if (!env.DEEPSEEK_API_KEY || !env.GITHUB_TOKEN) return json({ error: "Missing DEEPSEEK_API_KEY or GITHUB_TOKEN secret." }, 503);

    let body;
    try { body = await request.json(); } catch { return json({ error: "Request body must be JSON." }, 400); }

    const task = String(body.task || "").trim();
    const repo = String(body.repo || env.DEFAULT_REPO || "").trim();
    const base = String(body.base || "main").trim();
    if (!task) return json({ error: "Missing task." }, 400);
    if (!validRepo(repo)) return json({ error: "repo must look like owner/name." }, 400);
    if (!/^[A-Za-z0-9_.\/-]+$/.test(base)) return json({ error: "Invalid base branch." }, 400);

    try {
      const snapshot = await getRepositorySnapshot(env.GITHUB_TOKEN, repo, base);
      const prompt = [
        `USER TASK:\n${task}`,
        `TARGET REPOSITORY: ${repo}`,
        `BASE BRANCH: ${base}`,
        `REPOSITORY FILES:`,
        JSON.stringify(snapshot.files)
      ].join("\n\n");

      const plan = await askDeepSeek(env, [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
      ]);

      if (!plan || !Array.isArray(plan.files) || plan.files.length === 0) {
        return json({ error: "DeepSeek produced no file changes.", plan }, 422);
      }
      if (plan.files.length > 25) return json({ error: "DeepSeek requested too many file changes." }, 422);

      const existing = new Set(snapshot.files.map(x => x.path));
      const changes = plan.files.map(change => ({
        path: String(change.path || ""),
        action: String(change.action || "update"),
        content: change.content == null ? null : String(change.content)
      }));

      for (const change of changes) {
        if (!validPath(change.path)) throw new Error(`Invalid file path: ${change.path}`);
        if (!['create', 'update', 'delete'].includes(change.action)) throw new Error(`Invalid action for ${change.path}`);
        if (change.action === "create" && existing.has(change.path)) throw new Error(`DeepSeek tried to create existing file: ${change.path}`);
        if ((change.action === "update" || change.action === "delete") && !existing.has(change.path)) throw new Error(`DeepSeek tried to ${change.action} missing file: ${change.path}`);
        if (change.action !== "delete" && change.content.length > 100000) throw new Error(`File too large: ${change.path}`);
      }

      const branch = `vibe/${Date.now()}-${slug(task)}`;
      await createBranch(env.GITHUB_TOKEN, repo, branch, snapshot.commitSha);
      const commit = await createAtomicCommit(
        env.GITHUB_TOKEN,
        repo,
        branch,
        snapshot.treeSha,
        snapshot.commitSha,
        changes,
        plan.commitMessage || `vibe: ${task.slice(0, 60)}`
      );
      const pr = await createPullRequest(
        env.GITHUB_TOKEN,
        repo,
        branch,
        base,
        plan.prTitle || `Vibe coding: ${task.slice(0, 60)}`,
        plan.prBody || `DeepSeek generated this change from the task:\n\n${task}`
      );

      return json({
        ok: true,
        summary: plan.summary || "Changes generated.",
        repo,
        base,
        branch,
        commit: commit.sha,
        pullRequest: pr.html_url,
        files: changes.map(x => ({ path: x.path, action: x.action }))
      });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 500);
    }
  }
};
