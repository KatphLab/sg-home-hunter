# Domain Docs

This repo uses a single-context layout: `GLOSSARY.md` at the repo root and architecture decision records under `docs/adr/`.

## Before exploring

Read the root `GLOSSARY.md` and any ADRs under `docs/adr/` relevant to the area being explored.

If these files do not exist, proceed silently. Do not flag their absence or suggest creating them upfront. `/domain-modeling`, reached via `/grill-with-docs` and `/improve-codebase-architecture`, creates them lazily when terms or decisions are resolved.

## Use the glossary's vocabulary

When naming domain concepts in issues, proposals, hypotheses, or tests, use the glossary's terms rather than synonyms it explicitly avoids.

If a needed concept is missing, reconsider whether the project uses it; note genuine gaps for `/domain-modeling`.

## Flag ADR conflicts

If a proposal contradicts an existing ADR, surface the conflict explicitly, identifying the ADR and why the decision is worth reopening.
