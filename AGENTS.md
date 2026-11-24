## Workflow

- Use Bun only for package management and repository scripts: `bun install`, `bun run <script>`, and `bunx --no-install <tool>`.
- Work on a descriptive feature branch rather than `main`; use `.worktrees/` for isolated worktrees.
- Use focused `<type>(<scope>): <why>` commits.

## Protected tooling

Ask the user before modifying quality-gate configuration: `.dependency-cruiser.ts`, `.jscpd.json`, `biome.json`, `.semgrep.yml`, `knip.json`, `tsconfig.json`, and `bunfig.toml`. Fix findings in code rather than weakening or bypassing checks. When approved, record user sign-off in the commit message (e.g. `Approved-Config-Change: <reason>`) so reviewers can verify approval from git history.

## Implementation

- Write TypeScript modules; reuse existing modules before adding code.
- Make the smallest complete change and remove obsolete paths when replacing behavior.
- Include dependency rationale plus security and license impact in the PR or commit.
- Update documentation when public behavior or contributor workflows change.
- Use `YYYY-MM-DD` headings for changelog entries, not version numbers.
- Normalize unknown thrown values to `Error` at module boundaries. Keep user-facing errors safe and actionable while preserving useful developer diagnostics.
- For judgement-call design and review standards not enforced by linters, see `CODING_STANDARDS.md`.

## Verification

- Cover changed behavior, state transitions, contracts, and reachable errors.
- Run targeted verification and `bun run check` before claiming completion, plus `bun run test:e2e` when browser or PWA behavior changes.
- Preserve 90% line and function coverage and the inherited static-analysis gates.
- Semgrep runs in CI; run `semgrep scan --config .semgrep.yml --error .` locally when security rules or affected code change.

## Agent skills

### Issue tracker

Track issues in local Markdown under `.scratch/<feature>/`. Before creating, fetching, or updating tickets, read `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. Before assigning triage status, read `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `GLOSSARY.md` and `docs/adr/`. Before exploring domain concepts or proposing domain changes, read `docs/agents/domain.md`.
