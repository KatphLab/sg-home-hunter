# Issue tracker: Local Markdown

Issues and specs for this repo live as Markdown files in `.scratch/`.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`.
- The spec is `.scratch/<feature-slug>/spec.md`.
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file.
- Triage state is recorded as a `Status:` line near the top of each issue file. See `triage-labels.md` for the role strings.
- Append comments and conversation history under a `## Comments` heading.

## Publishing and fetching

When a skill says to publish to the issue tracker, create the appropriate file under `.scratch/<feature-slug>/`, creating directories as needed. When fetching a ticket, read the referenced file; users may supply its path or issue number.

## Wayfinding operations

Used by `/wayfinder`. The map has one child file per ticket.

- Map: `.scratch/<effort>/map.md`, containing Notes / Decisions-so-far / Fog.
- Child ticket: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records `research`, `prototype`, `grilling`, or `task`; a `Status:` line records `claimed` or `resolved` when applicable.
- Blocking: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every listed ticket is resolved.
- Frontier: scan the issues directory for open, unblocked, unclaimed tickets; first by number wins.
- Claim: set `Status: claimed` and save before working.
- Resolve: append an answer under `## Answer`, set `Status: resolved`, then append a gist and link to the map's Decisions-so-far section.
