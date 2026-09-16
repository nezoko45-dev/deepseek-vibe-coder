# DeepSeek GitHub Vibe Coder

A local Windows-friendly browser app that turns a plain-English coding request into a GitHub branch, atomic commit, and pull request using DeepSeek and the GitHub REST API.

**No Cloudflare. No Python. No Octokit.**

## How it works

```text
Your coding task
      ↓
Chrome UI
      ↓
Local Node backend
      ↓
Read repository files from GitHub
      ↓
DeepSeek plans the change
      ↓
Create a vibe/* branch
      ↓
Create one atomic Git commit
      ↓
Open a GitHub Pull Request
```

## Windows quick start

1. Make a copy of `config.example.json` named `config.json`.
2. Put your DeepSeek API key and GitHub token into `config.json`.
3. Double-click `start.bat`.
4. The backend runs at `http://127.0.0.1:8787`.
5. Open that address in Chrome.

`config.json` is ignored by Git so your keys are not committed.

## Configuration

```json
{
  "deepseekApiKey": "YOUR_DEEPSEEK_API_KEY",
  "githubToken": "YOUR_GITHUB_TOKEN",
  "deepseekModel": "deepseek-v4-pro",
  "defaultRepo": "nezoko45-dev/deepseek-vibe-coder"
}
```

The GitHub token needs permission to read the target repository, create branches/commits, and create pull requests.

## Request API

The local backend accepts:

`POST /vibe`

```json
{
  "repo": "nezoko45-dev/deepseek-vibe-coder",
  "base": "main",
  "task": "Add a dark mode button to the web app"
}
```

The response includes the generated branch, commit SHA, changed files, and pull-request URL.

## Safety built in

- Secrets stay in local `config.json` and are never included in the DeepSeek repository prompt.
- Path traversal is rejected.
- Generated file count and file size are limited.
- Updates/deletes are restricted to files that exist in the repository.
- Changes are made on a separate `vibe/*` branch.
- Each request creates one atomic Git commit.
- A pull request is opened instead of changing `main` directly.

## Limitation

This agent can read and modify GitHub repository files, but it does not execute arbitrary commands inside the target repository. Tests can be added later through a controlled CI workflow.
