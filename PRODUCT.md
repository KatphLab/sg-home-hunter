# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain TypeScript + HTML/CSS + Leaflet (bundled by Bun), deployed to static hosting (e.g. GitHub Pages or Cloudflare Pages; all asset and manifest paths must work cleanly on root or subpath static hosts).

## Users

House hunters in Singapore who know their workplace (a six-digit Singapore postal code or an exact, line-specific MRT/LRT station ID), office start time, and maximum in-vehicle ride cap, and want to discover which neighbourhoods to look in without already knowing Singapore stop IDs or having a neighbourhood shortlist. Used on both desktop and phone, including on-site at property viewings while offline.

## Product Purpose

Help a Singapore house hunter identify neighbourhoods within 500 m straight-line distance of public transit stops that offer a qualifying commute to their workplace on one displayed workday, backed by inspectable single-journey evidence, and keep the last completed housing-search zone usable offline.

## Positioning

A zero-backend, client-only PWA that signs directly into the house hunter's own OneMap account from the browser (no proxy or shared API key), scans a bundled dated island-wide stop inventory breadth-first so distant stops receive a first departure check before nearby stops receive another, enforces an in-vehicle-only ride cap separate from walking and waiting, and stays strictly honest about straight-line proximity, single-date evidence, and non-exhaustiveness.

## Operating Context

- **Search session (online):** User signs in directly to OneMap with their own email and password (password is not saved when a token suffices; credentials and tokens are never logged), reviews the exact search date and bundled inventory date, sees the warning that closing the app stops the search, and monitors live results as patches appear while distinguishing stops tried from matching stops. They may stop early for an explicitly labelled partial result.
- **Property viewing (offline):** User reopens the installed PWA on their phone offline without signing in again to inspect the last completed workplace, housing-search zone, selectable stops, journey details, and original search date, office start time, and ride cap. Starting, stopping, or closing a subsequent search must leave the last completed result intact until another search completes.

## Capabilities and Constraints

- **Workplace:** Exact six-digit Singapore postal code (preserving leading zeros) resolved via OneMap, or an exact line-specific MRT/LRT station ID from the bundled inventory. Choosing a station targets its place (reachable by bus and on foot, not only its rail line). Only the exact destination station ID qualifies automatically with zero ride time at office start; a different line ID at the same point and a stop coincident with a postal workplace do not.
- **Search date:** First Monday–Friday strictly after today in Singapore (`Asia/Singapore`) that is not a public holiday, including observed public holidays. Evaluates one displayed workday, not a five-weekday confirmation.
- **Qualifying journey:** First transit boarding must be at the exact candidate stop; boarding and arrival (including any final walk) must occur on the search date; sum of in-vehicle transit intervals must not exceed the ride cap (walking and waiting excluded); arrival must fall inclusively within 15 minutes before office start through office start (arriving early and waiting at work does not qualify).
- **Housing-search zone:** Union of 500 m straight-line circles around qualifying stops with visually merged overlaps, preserved disconnected patches, and individually selectable stops, labelled "Within 500 m of a qualifying stop." Must clearly convey straight-line proximity (not a verified walking route) and that unshaded areas are not proven unreachable.
- **Account & error boundary:** Direct browser requests to OneMap; require a connected account only for new searches, never for reading a saved offline result. Unreadable sign-in responses must report "Couldn’t sign in to OneMap," never "Wrong password."
- **Out of scope:** Property listings, evaluating a particular home, walking routes from a flat, exhaustive coverage or daily reliability guarantees, ranking every departure, five-weekday confirmation, background searches after closing the PWA, starting new searches offline, and any backend proxy or shared OneMap account.
- **Undecided:** Final static hosting provider/origin URL (e.g. GitHub Pages vs Cloudflare Pages) and whether OneMap CORS permits direct sign-in from that eventual production origin.

## Brand Commitments

- **Product name:** House Hunter.
- **Domain vocabulary:** Use the exact terms defined in `GLOSSARY.md` (`Workplace`, `Search date`, `Arrival window`, `Ride cap`, `Qualifying journey`, `Qualifying stop`, `Housing-search zone`).
- **Required attribution:** Display OneMap / Singapore Land Authority attribution (`OneMap © contributors | Singapore Land Authority`) when showing OneMap tiles.
- **No additional brand commitments** (no custom logo, tagline, or visual identity constraints established yet).

## Evidence on Hand

- Product specification: `.scratch/commute-zones/spec.md`
- Domain glossary: `GLOSSARY.md`
- Feasibility note in spec: a local WebKit browser signed in directly to OneMap and read an authenticated transit plan from localhost (production-origin CORS remains unverified).
- Open transit datasets verified for bundling: BusRouter SG bus stops (`data.busrouter.sg`) and SGRailData MRT/LRT stations (`cheeaun/sgraildata`).
- **Absences not to fabricate:** No user testimonials, no verified walking-route claims, no live-schedule reliability statistics, and no real OneMap credentials in code or tests.

## Product Principles

1. **Honesty over false precision:** Label 500 m zones as straight-line proximity, frame each journey as one match for one displayed date, distinguish tried from matched stops, and never imply unshaded areas are unreachable.
2. **Progressive island-wide discovery:** Check distant stops on a first pass before revisiting nearby stops so early leads span the island and appear live while the search runs.
3. **Offline resilience for the last completed map:** Never overwrite a completed search when starting, stopping, or abandoning a new one; keep the saved map, constraints, and evidence usable without tiles or sign-in.
4. **Strict client-only account boundary:** Keep credentials and tokens strictly in the user's browser session, never behind a proxy, never logged, and never blame the password when a sign-in response cannot be read.
5. **Equal access beyond the map:** Provide a full accessible stop and journey list synced with the map so every recommendation can be evaluated without using the map.

## Accessibility & Inclusion

- Users who cannot use the interactive map must have an accessible list of the exact same qualifying stops and journey details (stop name, ID, boarding time, services, arrival time) to evaluate every recommendation without relying on map interaction.
