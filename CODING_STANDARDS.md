# Coding Standards

Judgement-call engineering and review standards not directly enforced by Biome, TypeScript, Dependency Cruiser, Knip, jscpd, or Semgrep.

## Module cohesion and decomposition

- Keep entrypoints thin. Split UI/app modules once orchestration, state management, and DOM rendering diverge (for example `src/app/main.ts`, `src/app/search-controller.ts`, and `src/app/dom-render.ts`).
- Prefer single-purpose modules with explicit contracts over multi-responsibility coordinators that stay under per-function line/complexity limits only by accumulating unrelated helpers.

## Error boundaries and user messaging

- Normalize unknown thrown values to `Error` at module boundaries and preserve actionable diagnostics for developers without leaking sensitive inputs (never log or store passwords or tokens).
- Keep user-facing failure copy accurate to the failure mode—never blame credentials for network, HTTP status, or response-parsing errors.

## Browser, PWA, and E2E testing

- Use `page.context().route(...)` rather than `page.route(...)` whenever the Service Worker (`sw.js`) is active, so Service Worker fetches are intercepted consistently.
- Assert hidden-by-default DOM state (`toBeHidden()`) and custom Leaflet overlay pane rendering/opacity deterministically in E2E tests instead of relying solely on visual inspection.

## Protected tooling reviews

- Edits to protected quality-gate configuration listed in [AGENTS.md](AGENTS.md) require explicit user approval.
- Reviewers evaluating git diffs without chat history should check commit messages/trailers for `Approved-Config-Change:` before flagging a protected-config edit as a process violation.

## Dependencies and documentation

- Include rationale plus security and license impact in the commit or PR whenever adding or changing runtime dependencies.
- Update documentation when public behavior or contributor workflows change, and use `YYYY-MM-DD` headings (not version numbers) for changelog entries.
