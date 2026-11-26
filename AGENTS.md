## Workflow

- Use Bun only for package management and repository scripts: `bun install`, `bun run <script>`, and `bunx --no-install <tool>`.
- Work on a descriptive feature branch rather than `main`, using the current worktree by default. Create an isolated worktree under `.worktrees/` only when required for parallel work or to preserve unrelated local changes.
- Use focused `<type>(<scope>): <why>` commits.

## Protected tooling

Ask the user before modifying quality-gate configuration: `.dependency-cruiser.ts`, `.jscpd.json`, `biome.json`, `.semgrep.yml`, `knip.json`, `tsconfig.json`, and `bunfig.toml`. Fix findings in code rather than weakening or bypassing checks. When approved, record user sign-off in the commit message (e.g. `Approved-Config-Change: <reason>`) so reviewers can verify approval from git history.

## Implementation

- Make the smallest complete change and remove obsolete paths when replacing behavior.
- Before editing or reviewing modules, error boundaries, E2E/PWA tests, protected configs, dependencies, docs, or changelog entries, read `CODING_STANDARDS.md`.

## Verification

- Cover changed behavior, state transitions, contracts, and reachable errors.
- Run `bun run fix` then `bun run check` before claiming completion, plus `bun run semgrep` when security-sensitive code changes and `bun run test:e2e` when browser or PWA behavior changes.

## Agent skills

### Issue tracker

Track issues in local Markdown under `.scratch/<feature>/`. Before creating, fetching, or updating tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before assigning triage status, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. Before exploring domain concepts or proposing domain changes, read `docs/agents/domain.md`.
