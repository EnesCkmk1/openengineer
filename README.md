# OpenEngineer

OpenEngineer is a local tool that lets an AI agent change a repository in an isolated git worktree, run the project's checks, and report what actually happened. It does not merge, push, or deploy.

The repository started as an MIT license and a placeholder README. Everything else in this tree is the implementation described below.

## What it does

1. Registers a local git repository and detects its Node package manager, scripts, and test runner.
2. Turns a natural-language task into a structured plan. It pauses when a critical fact is missing.
3. Creates a branch and git worktree from `HEAD`. Uncommitted work in your checkout is left untouched and is not part of the task.
4. Edits files with typed tools. Commands go through an allowlist. Network, installs, and destructive git commands require approval. Shell syntax is rejected.
5. Runs detected test, lint, typecheck, and build commands. Failures go back to the agent until the repair limit, budget, or a hard error stops the run.
6. Verifies the result independently. A model review is stored as supplementary evidence and cannot override a failed check.
7. Writes a report with the diff, check results, token accounting, duration, and sandbox mode.

Task states are `queued`, `inspecting`, `planning`, `implementing`, `testing`, `repairing`, `verifying`, `completed`, `failed`, `cancelled`, and `awaiting_approval`.

## Requirements

- Node.js 22 or newer
- PostgreSQL 16
- Git
- Docker, if you want the default command sandbox

Docker is the default sandbox. This environment and GitHub Actions do not assume a Docker daemon is usable, so tests and the checked-in evaluation run with the explicit process sandbox. That mode is not a security boundary. See [docs/security.md](docs/security.md).

## Setup

```bash
npm install
cp .env.example .env
```

Start PostgreSQL. With Docker:

```bash
docker compose up -d
```

Without Docker, create a database that matches `DATABASE_URL` in `.env`. Then:

```bash
npm run db:generate
npm run db:migrate
```

Set a model provider in `.env`:

- `OPENENGINEER_MODEL_PROVIDER=openai` and `OPENAI_API_KEY`
- or `OPENENGINEER_MODEL_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`

Both adapters speak the provider HTTP APIs directly. `OPENAI_BASE_URL` can point at any OpenAI-compatible endpoint. The `scripted` provider is a deterministic test double. It is not an agent and refuses to start unless `OPENENGINEER_SCRIPTED_FILE` points at a program JSON file. `evals/fixtures/session-bugfix.json` only replays the session-app expiry fix. It does not plan or edit any other task.

Pull the sandbox image before the first Docker run. OpenEngineer does not pull images itself:

```bash
docker pull node:22-bookworm-slim
```

To run commands without Docker, you must opt in twice:

```bash
OPENENGINEER_SANDBOX=process
OPENENGINEER_ALLOW_PROCESS_SANDBOX=true
```

## Run the app

Development, API on `127.0.0.1:3001` and the dashboard on `127.0.0.1:5173`:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

`npm start` serves the API and, when `packages/web/dist` exists, the dashboard.

Prepare a disposable copy of the sample project:

```bash
npm run examples:init
```

That writes a git repository to `.openengineer/session-app` (or a path you pass). The sample's `isSessionValid` accepts expired sessions. Its tests describe the intended behavior and fail until the comparison is fixed.

To exercise the runner without a hosted model, opt into the process sandbox and the scripted fixture. This is a replay of one edit, and the process sandbox is not a security boundary:

```bash
OPENENGINEER_SANDBOX=process \
OPENENGINEER_ALLOW_PROCESS_SANDBOX=true \
OPENENGINEER_MODEL_PROVIDER=scripted \
OPENENGINEER_SCRIPTED_FILE=./evals/fixtures/session-bugfix.json \
npm run cli -- run "Fix the bug where expired sessions are accepted." --repo .openengineer/session-app
```

## CLI

```bash
npm run cli -- repos add .openengineer/session-app
npm run cli -- run "Fix the bug where expired sessions are accepted and add regression tests." --repo .openengineer/session-app
npm run cli -- status <taskId>
npm run cli -- diff <taskId>
npm run cli -- report <taskId>
npm run cli -- report <taskId> --json
npm run cli -- cancel <taskId>
npm run cli -- serve
```

`run` flags:

| Flag | Meaning |
| --- | --- |
| `--repo <path>` | Required local git repository |
| `--sandbox docker\|process` | Overrides `OPENENGINEER_SANDBOX` for this run |
| `--provider openai\|anthropic\|scripted` | Overrides the model provider |
| `--script <file>` | Scripted program file |
| `--max-repairs <n>` | Repair attempts |
| `--max-tool-calls <n>` | Tool-call budget |
| `--timeout-ms <n>` | Task duration budget |
| `--command-timeout-ms <n>` | Per-command timeout |
| `--json` | Print the final report as JSON |

Exit codes for `run`: `0` completed, `2` failed, `3` cancelled, `4` waiting for approval, `1` usage or startup error.

There is no `openengineer eval` command. The evaluation suite is `npm run eval`.

## Tests

```bash
npm run typecheck
npm run lint
npm test
npm run eval
```

Integration tests use `postgresql://openengineer:openengineer@127.0.0.1:5432/openengineer_test` and ignore `DATABASE_URL`, so they do not wipe a development database. Create that database before `npm test`.

## Layout

| Path | Role |
| --- | --- |
| `packages/core` | Agent loop, tools, git worktrees, sandbox, verification |
| `packages/db` | Prisma schema, migrations, PostgreSQL store |
| `packages/api` | Fastify API |
| `packages/web` | React dashboard |
| `packages/cli` | Command-line interface |
| `packages/eval` | Repeatable task suite and metrics |
| `examples/session-app` | Fixture with a real expiry bug |
| `docs/` | Architecture, security, evaluation, contributing, roadmap |

## Limits

- Node.js projects are the only ones the verifier executes. Python, Go, and Rust are detected and then left as `not_run`.
- One API process runs tasks in-process. There is no queue service and no authentication. Bind to localhost.
- A crash mid-run is marked `failed` with `interrupted` on the next startup. The steps remain. The run is not resumed automatically.
- Approved commands are at-least-once if the process dies after approval and before the command result is stored.
- The checked-in evaluation numbers are from the scripted provider. They are not a language-model score.

See [docs/architecture.md](docs/architecture.md), [docs/security.md](docs/security.md), [docs/evaluation.md](docs/evaluation.md), and [docs/roadmap.md](docs/roadmap.md).
