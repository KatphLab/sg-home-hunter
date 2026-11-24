# Changelog

## 2026-11-24

- Initialize House Hunter from `KatphLab/ts-bun-template`, preserving the existing commute design and local credentials file.
- Configure engineering skills for local Markdown issues, default triage labels, and single-context domain documentation.
- Replace `Makefile` with `justfile`; use `just install` for dependency and hook setup.
- Move the commute design to `docs/DESIGN.md` and update the README link.

## 2026-11-06

- Enable weekly Dependabot pull requests for patch-only updates to all production and development packages using the native Bun ecosystem.
- Wait seven days after a package release before proposing version updates, satisfying the Semgrep cooldown policy without changing the weekly patch-only schedule.
- Leave dependency versions unchanged in this setup; updates require review and merging.

## 2026-11-02

- Create the Bun/TypeScript template from `ts-pnpm-template`, retaining its strict TypeScript, Biome, dependency-cruiser, Knip, jscpd, Semgrep, Danger, and Git-hook checks.
- Use Bun 1.4.4 for installation, development, bundling, and execution; resolve all development dependencies to their latest stable releases.
- Use Bun's built-in test runner with 90% line and function coverage; omit statement/branch thresholds and remove Vitest.
- Migrate Biome configuration to 2.6.4 without relaxing rules and deny dependency lifecycle scripts with an empty trust list.
- Adapt GitHub Actions and the unprivileged production container to Bun; pin actions to the latest release commits.
- Compile the TypeScript Danger policy with Bun before running it, since Danger's TypeScript loader requires a compiler API removed in TypeScript 7.
