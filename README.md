# DeepSeek GitHub Vibe Coder

A Cloudflare Worker that turns a plain-English coding request into a GitHub branch, atomic commit, and pull request using DeepSeek's API and raw GitHub REST `fetch()` calls.

## What it does

```text
Your coding task
      ↓
Cloudflare Worker
      ↓
Read repository files from GitHub
      ↓
DeepSeek plans the change
      ↓
Create a new vibe/* branch
      ↓
Create one atomic Git commit
      ↓
Open a GitHub Pull Request
```

No Python and no Octokit are used.

## API

`POST /vibe`

```json
{
  "repo": "nezoko45-dev/deepseek-vibe-coder",
  "base": "main",
  "task": "Add a dark mode button to the web app"
}
```

Send an authorization header:

```text
Authorization: Bearer YOUR_AGENT_KEY
```

The response includes the generated branch, commit SHA, changed files, and pull-request URL.

## Secrets

Configure these as Cloudflare Worker secrets. **Do not put them in GitHub files.**

- `DEEPSEEK_API_KEY` — DeepSeek API key.
- `GITHUB_TOKEN` — GitHub token with access to the repositories the agent should modify. For a personal setup, a fine-grained token limited to the target repositories is preferable.
- `AGENT_KEY` — a private key you invent and use when calling `/vibe`.

The public variables in `wrangler.toml` are not secrets.

## Cloudflare setup

The repository is ready for a Cloudflare Worker deployment. In the Cloudflare dashboard, create/import a Worker from this project and configure the three secrets above. The Worker entry point is `worker.js`.

For automated deployment later, a GitHub Actions workflow can be added with Cloudflare deployment credentials kept as repository secrets.

## Safety built in

The agent:

- never receives your secrets in the DeepSeek prompt;
- rejects path traversal attempts;
- limits the number and size of generated file changes;
- only updates/deletes files that exist in the repository snapshot;
- creates a separate `vibe/*` branch instead of changing `main` directly;
- makes one atomic Git commit;
- opens a pull request for review.

DeepSeek is instructed to return complete file contents, not partial patches, which keeps the Git operation deterministic.

## Important limitation

This is a coding agent bridge, not an execution sandbox. The Worker can read and modify repository files, but it does not run arbitrary project commands or tests inside the target repository. A later version can add GitHub Actions-based test/review loops.
