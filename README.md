# Deepgram GitHub Vibe Coder

A local Windows-friendly browser app that turns a plain-English coding request into a GitHub branch, atomic commit, and pull request using Deepgram's Voice Agent pipeline and the GitHub REST API.

**No Cloudflare. No Python. No Ollama. No 19 GB local coding model.**

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
Deepgram Voice Agent + managed LLM
      ↓
Structured coding plan
      ↓
Create a vibe/* branch
      ↓
Create one atomic Git commit
      ↓
Open a GitHub Pull Request
```

Deepgram's Voice Agent API provides a single WebSocket pipeline for speech, LLM reasoning, and responses, and supports managed LLM providers plus function calling. citeturn0search1turn0search3

## Windows quick start

1. Install Node.js 20 or newer.
2. Double-click `start.bat`.
3. On first launch, the app creates `config.json` from `config.example.json`.
4. Put your Deepgram API key and GitHub token into `config.json`.
5. Double-click `start.bat` again.
6. Chrome opens at `http://127.0.0.1:8787`.

The launcher automatically installs the small `ws` WebSocket package if needed. You do **not** need Ollama or a large local model.

`config.json` is ignored by Git so your keys are not committed.

## Configuration

```json
{
  "deepgramApiKey": "YOUR_DEEPGRAM_API_KEY",
  "githubToken": "YOUR_GITHUB_TOKEN",
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

- Secrets stay in local `config.json` and are never included in the repository prompt.
- Path traversal is rejected.
- Generated file count and file size are limited.
- Updates/deletes are restricted to files that exist in the repository.
- Changes are made on a separate `vibe/*` branch.
- Each request creates one atomic Git commit.
- A pull request is opened instead of changing `main` directly.

## Limitation

This agent can read and modify GitHub repository files, but it does not execute arbitrary commands inside the target repository. Tests can be added later through a controlled CI workflow.
