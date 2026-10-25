# Roadmap

This list matches the tree as of the 0.1.0 MVP. Shipped means there is code and a test or an executable command. Planned means it is not implemented.

## Shipped

- Local git repository registration and Node.js project detection. Other ecosystems are detected and not executed.
- Preservation of uncommitted work in the primary checkout, with a regression test.
- Per-task git worktree and branch, base commit, and diff.
- Plan, clarification pause, implement, test, bounded repair, and independent verification.
- OpenAI-compatible and Anthropic adapters, plus an explicitly labeled scripted test double.
- Docker command sandbox and an opt-in process sandbox that fails closed unless acknowledged.
- Command allowlist, approval gate, path jail, secret-path denylist, timeouts, output caps, and audit steps.
- Cancellation, budgets, and startup recovery of interrupted runs.
- PostgreSQL persistence via Prisma migrations.
- Fastify API, React dashboard, and CLI (`run`, `status`, `cancel`, `diff`, `report`, `repos`, `serve`).
- Evaluation harness with two scripted configurations and checked-in output from a real run.
- GitHub Actions for typecheck, lint, test, build, and eval.

## Planned

- Resume an interrupted run from its checkpoint instead of marking it failed.
- Verifiers for Python, Go, and Rust.
- Opening a pull request or pushing a branch. The product will still not merge by itself.
- Authentication and a remote execution service.
- OpenTelemetry export. Steps, durations, and token counts are already stored.
- Worktree garbage collection.
- A published baseline that uses a hosted model under the same tasks and limits.
- Plugin tools. New tools should stay typed and policy-checked.
- Multi-user tenancy. The current threat model is a single developer on localhost.

## Non-goals for the MVP

- A chat product with no repository.
- Automatic merge or deploy.
- Claiming that a model review proves correctness.
- A silent fallback from Docker to host execution.
