const API = "https://api.github.com";

function headers(token, extra = {}) {
  return {
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "deepseek-vibe-coder",
    authorization: `Bearer ${token}`,
    ...extra
  };
}

async function request(token, path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: headers(token, options.headers)
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data).slice(0, 1500)}`);
  return data;
}

export async function getRepositorySnapshot(token, repo, branch, limits = {}) {
  const maxFiles = limits.maxFiles || 80;
  const maxBytes = limits.maxBytes || 140000;
  const head = await request(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
  const commitSha = head.object.sha;
  const commit = await request(token, `/repos/${repo}/git/commits/${commitSha}`);
  const tree = await request(token, `/repos/${repo}/git/trees/${commit.tree.sha}?recursive=1`);

  const textExt = /\.(js|mjs|cjs|ts|tsx|jsx|html?|css|json|md|txt|xml|yaml|yml|toml|ini|cfg|py|java|cs|cpp|h|hpp|go|rs|php|rb|lua|sql|sh|bat|ps1)$/i;
  const candidates = (tree.tree || [])
    .filter(x => x.type === "blob" && textExt.test(x.path))
    .slice(0, maxFiles);

  const files = [];
  let used = 0;
  for (const item of candidates) {
    if (used >= maxBytes) break;
    const blob = await request(token, `/repos/${repo}/git/blobs/${item.sha}`);
    const content = blob.encoding === "base64"
      ? atob(blob.content.replace(/\n/g, ""))
      : String(blob.content || "");
    const remaining = maxBytes - used;
    const clipped = content.length > remaining ? content.slice(0, remaining) + "\n/* [clipped by agent] */" : content;
    files.push({ path: item.path, content: clipped });
    used += clipped.length;
  }

  return { repo, branch, commitSha, treeSha: commit.tree.sha, files };
}

export async function createBranch(token, repo, branch, sha) {
  return request(token, `/repos/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha })
  });
}

export async function createAtomicCommit(token, repo, branch, baseTreeSha, parentSha, changes, message) {
  const elements = [];
  for (const change of changes) {
    if (change.action === "delete") {
      elements.push({ path: change.path, mode: "100644", type: "blob", sha: null });
      continue;
    }
    const blob = await request(token, `/repos/${repo}/git/blobs`, {
      method: "POST",
      body: JSON.stringify({ content: change.content ?? "", encoding: "utf-8" })
    });
    elements.push({ path: change.path, mode: "100644", type: "blob", sha: blob.sha });
  }

  const tree = await request(token, `/repos/${repo}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTreeSha, tree: elements })
  });
  const commit = await request(token, `/repos/${repo}/git/commits`, {
    method: "POST",
    body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] })
  });
  await request(token, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha, force: false })
  });
  return commit;
}

export async function createPullRequest(token, repo, head, base, title, body) {
  return request(token, `/repos/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, head, base, body })
  });
}
