# OpenEngineer

OpenEngineer is a local tool that lets an AI agent change a repository in an isolated git worktree, run the project's checks, and report what actually happened. It does not merge, push, or deploy.

## What it does

1. Registers a local git repository and detects its Node package manager, scripts, and test runner.
2. Turns a natural-language task into a structured plan. It pauses when a critical fact is missing.
3. Creates a branch and git worktree from `HEAD`. Uncommitted work in your checkout is left untouched and is not part of the task.
4. Edits files with typed tools. Commands go through an allowlist. Network, installs, and destructive git commands require approval. Shell syntax is rejected.
5. Runs detected test, lint, typecheck, and build commands. Failures go back to the agent until the repair limit, budget, or a hard error stops the run.
6. Verifies the result independently. A model review is stored as supplementary evidence and cannot override a failed check.
7. Writes a report with the diff, check results, token accounting, duration, and sandbox mode.

Task states are `queued`, `inspecting`, `planning`, `implementing`, `testing`, `repairing`, `verifying`, `completed`, `failed`, `cancelled`, and `awaiting_approval`.

## Example

`examples/session-app` is a small app with one bug. `isSessionValid` treats an expired session as valid:

```js
export function isSessionValid(session, now) {
  if (!session?.id || !session?.userId) return false;
  // BUG: inverted comparison accepts expired sessions and rejects active ones.
  return session.expiresAt <= now;
}
```

`expiresAt` is an exclusive deadline. The tests already require a session to be valid only while `now` is before that instant, so `npm test` fails until the comparison is fixed.

After [setup](#setup), copy the fixture into its own git repository and give OpenEngineer the task:

```bash
npm run examples:init

npm run cli -- run "Fix the bug where expired sessions are accepted." --repo .openengineer/session-app
```

That needs a configured model provider and the Docker image from the setup section. To replay this one edit without a model key, use the scripted fixture. It performs the change below. It does not read the repository and decide the fix, and the process sandbox is not a security boundary:

```bash
npm run examples:init

OPENENGINEER_SANDBOX=process \
OPENENGINEER_ALLOW_PROCESS_SANDBOX=true \
OPENENGINEER_MODEL_PROVIDER=scripted \
OPENENGINEER_SCRIPTED_FILE=./evals/fixtures/session-bugfix.json \
npm run cli -- run "Fix the bug where expired sessions are accepted." --repo .openengineer/session-app
```

The CLI prints one line per recorded step, then the report. This is a shortened trace from a scripted run. The id on the first line is the one you pass to `diff` and `report`:

```text
task 41bc31fe-3ffa-4bbb-a23b-466bc50b8ebf queued
[inspecting] inspection inspect_repository (completed)
[planning] model plan (completed)
[planning] plan submit_plan (completed)
[implementing] git create_worktree (completed)
[implementing] model implement (completed)
[implementing] tool edit_file (completed)
[implementing] tool finish (completed)
[testing] verification checks (completed)
[verifying] verification checks (completed)
[verifying] review ai_review (completed)

Status: completed
Verification: passed
Sandbox: process
Branch: openengineer/41bc31fe-3ffa-4bbb-a23b-466bc50b8ebf
- Tests: passed (npm test)
- Lint: passed (npm run lint)
- Diff inspection: passed
Tokens: 1548 in / 88 out (heuristic)
Estimated cost USD: unavailable
Repair attempts: 0
```

State changes such as `[planning] state planning` are printed too. They are left out above.

Token counts on the scripted provider are a character-length heuristic. A hosted model reports its own usage, and the estimated cost stays `unavailable` when the model has no price in the table. Durations move between machines.

```bash
npm run cli -- diff <taskId>
npm run cli -- report <taskId>
```

The diff is one line in the worktree:

```diff
 export function isSessionValid(session, now) {
   if (!session?.id || !session?.userId) return false;
   // BUG: inverted comparison accepts expired sessions and rejects active ones.
-  return session.expiresAt <= now;
+  return session.expiresAt > now;
 }
```

`.openengineer/session-app` still contains `<=`. The fix is only on branch `openengineer/<taskId>`. Nothing is merged.

The same task in the dashboard shows the step list, this diff, and the verification section. A model review is stored under the checks and cannot change a failed one to passed.

## Requirements

- Node.js 22 or newer
- PostgreSQL 16
- Git
- Docker, if you want the default command sandbox

Docker is the default sandbox. GitHub Actions pulls `node:22-bookworm-slim` and runs the Docker integration test. The checked-in evaluation still uses the process sandbox, so its numbers do not depend on container startup. That mode is not a security boundary. See [docs/security.md](docs/security.md).

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

The session-app walkthrough, including the command that runs without a model key, is in [Example](#example).

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
