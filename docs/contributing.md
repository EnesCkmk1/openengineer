# Contributing

OpenEngineer is an MVP with a small surface. Changes should keep the runner, the store, and the verifiers testable without a network.

## Setup

Follow the README through `npm run db:migrate` and `npm test`. Use a branch. Do not commit `.env` or provider keys.

## Pull requests

- Describe the behavior change and how you verified it.
- Update the README or the docs in `docs/` when a command, flag, or guarantee changes. Do not document a command that does not exist.
- Add or adjust a unit test for policy, path, verification, and state-machine changes.
- If you change the runner's success conditions, run `npm run eval` and include the new `evals/results/latest.json` only when the numbers came from that command.
- Do not add a dependency for something the standard library already does. Prefer permissive licenses (MIT, Apache-2.0, BSD). Do not add a package with a known high or critical vulnerability.

## Safety changes

Command allowlists, path checks, and sandbox defaults fail closed. A change that executes more than the previous allowlist needs an explicit test for the new acceptance and for a nearby rejection (shell syntax, path escape, or a secret path).

Do not auto-approve network or destructive commands in the API or CLI.

## Code style

TypeScript is strict. Validate external and persisted data with the Zod schemas in `@openengineer/shared`. Throw `OpenEngineerError` with a stable `code` instead of returning a fake success. Log the error and, when a supplementary step such as the model review is skipped, record that in the report notes.

## Reporting issues

Use the bug and feature templates. Do not paste API keys, `.env` files, or private diffs.
