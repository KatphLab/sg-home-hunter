---

name: House Hunter
description: HDB Town Precinct Directory — daylight civic wayfinding workspace for Singapore commute-zone discovery.
colors:
botanical-green: "#1b5e4b"
botanical-green-deep: "#134436"
botanical-tint: "#e3efe9"
porcelain: "#f6f7f5"
warm-concrete: "#e6e9e5"
pure-white: "#ffffff"
charcoal-ink: "#1a2220"
slate-ink: "#434f4b"
architectural-rule: "#cfd5d0"
civic-vermilion: "#c83e2b"
amber-paper: "#fef3c7"
amber-ink: "#78350f"
amber-rule: "#d97706"
water-ground: "#dce8e6"
typography:
title:
fontFamily: "\"IBM Plex Sans\", \"Plus Jakarta Sans\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
fontSize: "1.05rem"
fontWeight: 700
lineHeight: 1.3
letterSpacing: "-0.02em"
headline:
fontFamily: "\"IBM Plex Sans\", \"Plus Jakarta Sans\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
fontSize: "0.92rem"
fontWeight: 700
lineHeight: 1.35
letterSpacing: "-0.01em"
body:
fontFamily: "\"IBM Plex Sans\", \"Plus Jakarta Sans\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
fontSize: "14px"
fontWeight: 400
lineHeight: 1.45
letterSpacing: "0em"
label:
fontFamily: "\"IBM Plex Sans\", \"Plus Jakarta Sans\", system-ui, -apple-system, \"Segoe UI\", Roboto, sans-serif"
fontSize: "0.78rem"
fontWeight: 600
lineHeight: 1.35
letterSpacing: "0em"
plaque:
fontFamily: "ui-monospace, \"SFMono-Regular\", Menlo, Monaco, Consolas, monospace"
fontSize: "0.76rem"
fontWeight: 700
lineHeight: 1.2
letterSpacing: "0em"
rounded:
plaque: "5px"
control: "6px"
row: "8px"
overlay: "12px"
pill: "999px"
spacing:
xs: "4px"
sm: "8px"
md: "12px"
lg: "16px"
components:
button-primary:
backgroundColor: "{colors.botanical-green}"
textColor: "{colors.pure-white}"
rounded: "{rounded.control}"
padding: "8px 14px"
button-primary-hover:
backgroundColor: "{colors.botanical-green-deep}"
button-secondary:
backgroundColor: "{colors.pure-white}"
textColor: "{colors.botanical-green}"
rounded: "{rounded.control}"
padding: "8px 14px"
button-danger:
backgroundColor: "{colors.civic-vermilion}"
textColor: "{colors.pure-white}"
rounded: "{rounded.control}"
padding: "8px 14px"
chip-active:
backgroundColor: "{colors.botanical-green}"
textColor: "{colors.pure-white}"
rounded: "{rounded.pill}"
padding: "4px 10px"
stop-plaque-bus:
backgroundColor: "{colors.charcoal-ink}"
textColor: "{colors.pure-white}"
rounded: "{rounded.plaque}"
padding: "3px 6px"
stop-plaque-rail:
backgroundColor: "{colors.botanical-green}"
textColor: "{colors.pure-white}"
rounded: "{rounded.plaque}"
padding: "3px 6px"
overlay-card:
backgroundColor: "{colors.porcelain}"
textColor: "{colors.charcoal-ink}"
rounded: "{rounded.overlay}"
padding: "12px 14px"
---

# Design System: House Hunter

## Overview

**Creative North Star: "HDB Town Precinct Directory"**

House Hunter adopts the visual discipline of Singapore HDB void-deck and town-centre wayfinding boards: high-contrast daylight porcelain panels, concrete framing, unmistakable stop-ID plaques, and honest spatial caveats. It refuses dark telemetry dashboards, property-portal listing chrome, and decorative glassmorphism so commuters can scan live searches on desktop and inspect saved 500 m housing-search zones outdoors at offline property viewings.

**Key Characteristics:**
- Daylight-first porcelain and warm concrete shell paired with botanical green catchment zones
- Rounded-square stop-ID plaques uniting interactive map markers, list rows, and journey detail cards
- Strict tabular numerals for stop codes, tried/matched counters, dates, and boarding/arrival clocks
- Unsoftened status tags and non-collapsible proximity caveats

## Colors

The palette is restrained and daylight-calibrated: botanical green owns the workspace header and 500 m catchment union, civic vermilion marks the workplace destination, and unmodulated porcelain/concrete neutrals keep map figure-ground separation crisp online and offline.

### Primary

- **Botanical Green** (`#1b5e4b`): Application header bar, primary search trigger, active filter chips, MRT/LRT stop plaques, and the uniform-opacity 500 m housing-search zone overlay.
- **Botanical Deep** (`#134436`): Header status pills (`Online`, inventory count) and primary button hover fill, ensuring high contrast against white text.
- **Botanical Tint** (`#e3efe9`): Active stop row selection, active mobile tab highlight, and text selection highlight.

### Secondary

- **Civic Vermilion** (`#c83e2b`): Workplace map pin (`W`), legend workplace swatch, and destructive `Stop search` action.

### Neutral

- **Porcelain** (`#f6f7f5`): Workspace rail section surfaces, floating map legend/journey overlays, and offline landmass fill.
- **Warm Concrete** (`#e6e9e5`): Rail backdrop, segmented toggle track, and muted status badges.
- **Pure White** (`#ffffff`): Form inputs, stop list rows, metric cells, and secondary button fill.
- **Charcoal Ink** (`#1a2220`): Primary body copy, metric values, and bus stop plaque fill.
- **Slate Ink** (`#434f4b`): Field labels, hints, and secondary metadata.
- **Architectural Rule** (`#cfd5d0`): 1 px structural dividers between rail sections and input borders.
- **Water Ground** (`#dce8e6`): Map canvas backdrop behind Singapore's offline coastline polygons.

### Named Rules

**The Uniform Catchment Rule.** All 500 m circles render at full opacity inside one shared SVG layer whose parent pane sits at `0.34` opacity, so overlapping zones merge cleanly without double-darkening seams.

**The Unsoftened Caveat Rule.** Offline banners, `Keep the app open` notices, and `Partial result` tags use high-contrast amber paper (`#fef3c7`) with `#78350f` ink and `#d97706` borders so critical limits never blend into decorative chrome.

## Typography

**Body & UI Font:** `"IBM Plex Sans", "Plus Jakarta Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`
**Plaque & Code Font:** `ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace`

**Character:** A compact, workhorse sans scale (1.05 rem title down to 0.74 rem micro-labels) keeps dense search parameters, counters, and stop rows readable without wasted vertical space, while monospace stop plaques lock 5-digit bus IDs and line-specific rail IDs to predictable widths.

### Hierarchy

- **Title** (`700`, `1.05rem`, `1.3` line-height, `-0.02em` tracking): Header product name (`House Hunter`).
- **Headline** (`700`, `0.92rem`, `1.35` line-height, `-0.01em` tracking): Rail section headings and selected-stop journey title.
- **Body** (`400`, `14px`, `1.45` line-height): Form hints, legend caveats, and disclaimers.
- **Label** (`600`, `0.78rem`–`0.8rem`, `1.35` line-height): Field labels, metric captions, and filter chips.
- **Plaque** (`700`, `0.76rem`, `1.2` line-height, monospace): Stop ID badges (`NS17`, `65009`) on map markers, list rows, and journey cards.

### Named Rules

**The Tabular Figures Rule.** All counters (`Stops tried`, `Matching stops`), dates, clock times, ride durations, and stop IDs enforce `font-variant-numeric: tabular-nums` so live updates never jitter.

## Layout

Desktop (`> 900px`) uses a locked full-viewport flex column (`100dvh`, `overflow: hidden`) with a compact header bar above a two-column workspace: a scrollable `400px` left civic rail and a full-height interactive Leaflet map stage.

Mobile (`<= 900px`) switches to a map-first single-pane workspace paired with a persistent bottom navigation bar (`Search` | `Map` | `Stops (N)`). Opening the app with a saved completed search automatically activates the `Map` view so house hunters offline at viewings land directly on the housing-search zone, with the legend tucked top-right away from zoom controls and the journey card docked above the tab bar.

## Elevation & Depth

Elevation follows **one-method separation**: docked rail panels and inputs use flat `1px solid #cfd5d0` architectural rules with zero drop shadows, while floating map overlays (`.map-legend`, `.journey-card`) and map plaques drop borders and lift via compact structural shadows (`0 6px 16px rgba(26, 34, 32, 0.16)`).

### Named Rules

**The Single-Boundary Elevation Rule.** Never stack a `1px` card border underneath a soft drop shadow; choose a crisp border for docked surfaces or a shadow for floating map overlays.

## Shapes

- **Stop Plaques (`5px` radius):** Rounded-square civic badges (`min-width: 52px` in lists, `44px` on map markers) matching Singapore street/bus-stop signage.
- **Controls & Inputs (`6px` radius):** Crisp rectangular form inputs, buttons, and metric cells.
- **Stop List Rows (`8px` radius):** Full-width interactive buttons separating each qualifying stop cleanly inside the rail.
- **Floating Overlays (`12px` radius):** Map legend and selected-stop journey detail card.
- **Status Pills & Filter Chips (`999px` radius):** Small state indicators and mode toggles only.

## Components

### Buttons

- **Shape:** Slightly rounded architectural rectangle (`6px` radius).
- **Primary (`Start search`):** Botanical green (`#1b5e4b`) with white text (`8px 14px` padding), darkening to `#134436` on hover and `0.5` opacity when offline or disconnected.
- **Secondary (`Connect OneMap`):** Pure white fill with `1px` botanical green border and `#1b5e4b` text; fills with `#e3efe9` on hover.
- **Danger (`Stop search`):** Civic vermilion (`#c83e2b`) with white text, shown only while a search is running.
- **Ghost (`Disconnect`, `Close`):** Transparent fill with `1px solid #cfd5d0` rule.

### Stop Plaques (Signature Component)

- **Bus stops:** Charcoal ink (`#1a2220`) fill with white monospace ID; preserves leading zeros (`01012`).
- **MRT / LRT stations:** Botanical green (`#1b5e4b`) fill with white monospace ID (`NS17`).
- **Map Selection State:** Selecting a stop scales its marker plaque (`1.18x`) with a high-contrast `#fde047` highlight ring while dimming unselected map plaques to `0.62` opacity and highlighting its synced list row in `#e3efe9`.

### Chips & Segmented Controls

- **Mode Filters (`All`, `MRT / LRT`, `Bus`):** Pill chips (`999px`) toggling from white/bordered to solid `#1b5e4b` when active.
- **Workplace Switcher (`Postal code`, `MRT / LRT station`):** Recessed concrete track (`#e6e9e5`) lifting the active choice onto a crisp white tab.

### Floating Map Overlays

- **Legend (`Within 500 m of a qualifying stop.`):** Porcelain (`#f6f7f5`), `12px` radius, `0 6px 16px` shadow, pinned bottom-left on desktop and top-right on mobile.
- **Journey Card:** Porcelain (`#f6f7f5`), `12px` radius, `0 8px 22px` shadow, showing selected stop plaque, boarding/arrival times, ride minutes, service chain, and single-date disclaimer.

## Do's and Don'ts

### Do:

- **Do** keep `Search date`, `Inventory date`, and the `Keep the app open while searching` warning visible without accordions before starting a search.
- **Do** preserve uniform 500 m catchment opacity using one shared SVG renderer inside `commuteZonePane`.
- **Do** keep `Stops tried` and `Matching stops` visually distinct in tabular figures.

### Don't:

- **Don't** add drop shadows to 1 px bordered rail panels or borders to shadowed floating overlays.
- **Don't** use eyebrow labels, numbered section headers (`01 / 02`), one-sided accent bars on rounded boxes, or `backdrop-filter` glass blurs.
- **Don't** gate saved offline map viewing behind OneMap sign-in.
