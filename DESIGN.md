# OneMap Commute Origins — reimplementation design

## 1. What a successful result means

Given a Singapore destination, an office arrival deadline and a maximum **in-vehicle** travel time, produce two lists for a housing-search pipeline: directed bus stop IDs and line-specific MRT/LRT station IDs. Include an origin only if there is positive evidence for **each of five distinct working weekdays**. Keep the journeys, dates, search scope and failures beside the lists so a consumer can tell what was actually established.

For example, with a 09:00 start and a 30-minute cap, a traveller who boards at 08:20, spends 28 minutes on vehicles and 10 minutes transferring, and arrives at 08:58 qualifies that day. A 12-minute direct ride arriving at 08:44 does not. There is no home-to-stop walk estimate, traffic margin or requirement to arrive 15 minutes early. The destination station itself is the one case that does not need planner evidence.

This is a sequential CLI with two independently runnable commands, not a property search engine or a timetable database. `discover` writes a candidate inventory; `scan` reads that inventory (or an externally supplied one), queries OneMap and writes an evidence report. The only runtime persistence besides these JSON files is a local HTTP response cache. Absence from a result never means **unreachable**: sampled departures, up to three returned alternatives, incomplete inventory and provider service coverage all limit recall.

## 2. Public command contract

```text
onemap-commute discover [--postal-code CODE] [--radius-m N] [common options]
onemap-commute scan --inventory FILE (--postal-code CODE | --destination-station ID)
    --office-start HH:MM --max-ride-minutes N [scan options] [common options]
```

| Option | Meaning and default |
|---|---|
| `--output FILE` | Both commands: full inventory or report. Default: JSON to stdout. |
| `--cache FILE` | Both: SQLite file, default `~/.cache/onemap-commute/responses.sqlite`. |
| `--credential-dir DIR` | Both: encrypted login location, default `~/.config/onemap`. |
| `--max-requests N` | Both: positive integer, default 1000 actual HTTP attempts per invocation, including authentication and retries. |
| `--requests-per-second R` | Both: rate per client, `0 < R <= 5`, default 2. |
| `--postal-code CODE` | Exactly six ASCII digits, preserved as text. Optional local discovery centre or one of the two scan destinations. |
| `--radius-m N` | Discovery only: integer 1–5000, default 5000. Validated even on grid discovery, but only changes the radius of local discovery. |
| `--destination-station ID` | Scan only: exact uppercase rail ID, no case folding, whitespace trimming, composite codes or station-name matching. |
| `--inventory FILE` | Required for both kinds of scan destination; see inventory contract below. |
| `--office-start HH:MM` | Required scan deadline in `Asia/Singapore`; clock inputs use zero-padded 24-hour hours and minutes. |
| `--max-ride-minutes N` | Required positive integer; applies to the sum of transit leg durations. |
| `--start-date DATE` | First candidate date, ISO date, default today's Singapore date. All selected dates must be in the live planner horizon. |
| `--earliest-departure HH:MM` | Scan window start, default `06:00`; strictly before the deadline on the same day. |
| `--departure-step-minutes N` | Integer 1–60, default 10. This is a search resolution, not a travel allowance. |
| `--origin-ids A,B,...` | Optional exact comma-separated inventory IDs; unknown ID is an error. No normalization. |
| `--limit-origins N` | Optional positive integer; keep at most the nearest N **after** filtering IDs. |
| `--ids-output FILE` | Scan only: also write the two ID arrays, even when the final report is partial. |

Progress (discovery cell or origin index), warnings, counts and errors go to stderr. File output is indented JSON (two spaces) with a final newline. Create parent directories; write a sibling `<filename>.new` and replace the destination atomically. No additional file format is required.

## 3. Portable data contracts

The checked-in [inventory schema](schemas/inventory.schema.json) and [result schema](schemas/result.schema.json) specify wire field names, types, defaults and bounds. The following record dictionary is sufficient to map them to another language. Arrays are ordered JSON arrays. Records reject unknown fields; use strict field types. Dates are ISO calendar dates; timestamps have an explicit offset. Generated times use Singapore time. `schema_version` defaults to the integer `1` on both root records (it is not an enum check).

| Record | Fields and meaning |
|---|---|
| `Point` | WGS84 numbers `latitude` in [1.0, 1.6], `longitude` in [103.4, 104.3]. |
| `Stop` | `id` string, `kind` (`bus` or `rail`), `name` string, `point`, `source_id` nullable string (default null; set by discovery for expanded interchanges). |
| `Inventory` | `schema_version`, `scope` string, `fetched_at` timestamp, `stops: Stop[]`, `discovery_errors: string[]` (default empty). Reject duplicate `(kind,id)` pairs on input. |
| `Service` | `id`, `name`, `mode`, all strings; preserve provider values and transit-leg order. |
| `Journey` | `origin_id`, `service_date`, `boarding_at`, `arrival_at`; nonnegative integer `ride_seconds`, `elapsed_seconds`, `walking_seconds`, `waiting_seconds`, `early_arrival_seconds` (0–900); `services: Service[]`, `query_time` (`HH:MM:SS`), `query_mode`. See §6 for the clocks behind these fields. |
| `DayResult` | `service_date`, `status`, `journeys: Journey[]`, `query_errors: string[]` (default empty). |
| `OriginResult` | `stop: Stop`, `status`, `days: DayResult[]` in attempt order. An early stop yields a prefix, not five fabricated negative days. |
| `Coverage` | `exhaustive`, `scan_completed`, `origin_scope_limited` booleans; `inventory_scope`, `earliest_departure` strings; integer `inventory_count`, `selected_count`, `processed_count`, `unprocessed_count`, `api_requests`, `cache_hits`, `departure_step_minutes`; `limitations: string[]`. |
| `Report` | `schema_version`, `generated_at`, `office_postal_code`, `destination_station_id`, `office: Point`, `office_address`, `office_start`, `max_in_vehicle_minutes`, `early_arrival_minutes` (15), `service_dates`, `bus_stop_ids`, `mrt_lrt_ids`, `origins: OriginResult[]`, `coverage: Coverage`. |
| IDs-only projection | Object containing only `bus_stop_ids` and `mrt_lrt_ids`, copied from the final report. Both are arrays of strings, including when empty. |

Enforce these constraints in code, not just via JSON Schema: exactly one destination identity is non-null (either field defaults to null if absent); a bus ID full-matches `[0-9]{5}`, and a rail ID full-matches `[A-Z]{1,3}(?:[0-9]{1,2}[A-Z]?)?`; stop ID and kind must agree. Use the target language's **whole-string** match, not a substring match or a literal copy of the schemas' regex-engine-specific `\A` and `\z` anchors. Keep leading zeros, letter-only rail codes and station suffixes. Neither proximity nor a shared interchange name makes IDs equivalent.

## 4. OneMap adapter and cache

Separate the transport from three domain operations: `searchPostal(code) → (point, address, exactMatchCount)`, `nearby(point, kind, radius) → provider rows`, and `route(start, end, date, departure, mode) → plan`. They share one request counter, limiter and cache per invocation. The scheduler needs to distinguish **budget exhausted**, **failed query**, and **successful empty plan**.

### Authentication and transport

REST root: `https://www.onemap.gov.sg`. MCP endpoint: `https://public-onemap-gateway-hoaiixjtvz.gateway.bedrock-agentcore.ap-southeast-1.amazonaws.com/mcp`.

1. Look for the token for the requested API: `ONEMAP_TOKEN` for REST, `ONEMAP_MCP_TOKEN` for MCP. Send REST `Authorization: <token>` **without** a bearer prefix, MCP `Authorization: Bearer <token>`. Tokens are not interchangeable. Check the response cache before obtaining a token.
2. Without an external token, reuse the corresponding in-memory access token only if its epoch-second `expiry_timestamp` is more than 300 seconds away. Otherwise read `ONEMAP_EMAIL` and `ONEMAP_PASSWORD` if both are set; failing that, use the Fernet key in `<credential-dir>/key` to decrypt `<credential-dir>/credentials.enc` and read `email` and `password` from the decrypted JSON. Environment variables come from the process; there is no project `.env` loader.
3. REST login: POST JSON `{email,password}` to `/api/auth/post/getToken`. MCP login: POST the same JSON to `/api/mcp/auth/v1/token/refresh`, read `refresh_token`, then POST `{email,refreshToken: <that token>}` to `/api/mcp/auth/v1/token`. Both final responses require `access_token` and `expiry_timestamp`. Keep them only in memory. On the first resource 401, force reissuance once; if the rejected token was supplied by environment, fail rather than trying a different login.
4. Auth requests send and accept JSON. Data requests send `Content-Type: application/json`, `Accept: application/json, text/event-stream`. Use HTTPS, no redirects, 60-second timeout. For event streams normalize CRLF to LF, split on blank lines, concatenate the `data:` lines of a block with newlines (strip leading whitespace after `data:`), and decode the first nonempty data block as JSON. Otherwise decode the whole body as JSON.
5. Before **every** wire attempt, check the global budget, space request starts at least `1/R` seconds apart using a monotonic clock, and increment the counter. Retry network/timeout failures and HTTP 429, 500, 502, 503, 504 up to three times after the initial attempt, sleeping 1, 2, 4 seconds respectively. Other HTTP failures are errors, except for the explicit 401 and routing 404 handling. Do not put bodies, headers or credentials in diagnostics.

### Request/response mapping

| Operation | Wire contract |
|---|---|
| Postal | GET `/api/common/elastic/search` with `searchVal=CODE`, `returnGeom=Y`, `getAddrDetails=Y`, `pageNum=1`. Filter `results` to `POSTAL == CODE`; no exact result is an error. Use **first** exact row's numeric `LATITUDE`, `LONGITUDE` and `ADDRESS`, in provider order. Count exact rows on that page; a scan warns if more than one. |
| Nearby | POST to MCP with `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":TOOL,"arguments":{"latitude":LAT_TEXT,"longitude":LON_TEXT,"radius_in_meters":N}}}`. `TOOL` is `nearby___bus_stops` or `nearby___mrt_stations`. Reject `result.isError` if true. Join the `text` fields of `result.content` entries of type `text` with newlines; parse that string as a JSON array. |
| Routing | GET `/api/public/routingsvc/route`, query parameters in order: `start=lat,lon`, `end=lat,lon`, `routeType=pt`, `mode=bus\|rail\|transit` (one value), `date=MM-DD-YYYY`, `time=HH:MM:SS`, `numItineraries=3`. URL-encode the query. Times are **departure** probes; no `arriveBy`. Require `plan` object with `itineraries` array, possibly empty. |

Only for a routing 404, inspect up to 8192 bytes of JSON error body. Read `error`, or `message` if `error` is absent. Exactly `No route found between the specified locations` or `No bus route found between the specified locations` becomes the successful, cacheable `{"plan":{"itineraries":[]}}`. All other 404s, including `Unable to get MRT route`, are failures, not negative timetable evidence.

### Persistence and resume

SQLite table: `responses(key TEXT PRIMARY KEY, expires REAL, body TEXT)`. Key = lowercase hex SHA-256 of UTF-8 JSON `[method, fullEncodedURL, payloadOrNull]`, without auth headers. For byte-compatible keys use recursively sorted object keys, Python `json.dumps` default separators (`, ` and `: `), ASCII escaping and the same coordinate/query formatting. Store the decoded JSON envelope as text; expiry is wall-clock Unix seconds. On `expires > now`, decode, increment `cache_hits`, return without budget or authentication. On miss, require a JSON object without a top-level `error` key; insert or replace and commit. TTL: 21,600 seconds for postal/routing, 86,400 for nearby. Envelope caching precedes operation-specific validation; a malformed plan or a nested tool error can therefore recur from cache. Never cache auth requests/responses.

The reference client initializes `PRAGMA user_version=1`. On a pre-v1 cache it first removes rows with `plan.itineraries == []` or undecodable/non-object JSON, because older clients lost the cause of routing 404s. For a fresh database there are no rows to invalidate. Resume means **re-run the command**: recompute from the beginning, using any unexpired responses for free. Reports are not read as a work queue.

## 5. Discovery and scan setup

**Discovery.** With a postal code, resolve its point, run one cell, and set scope to `local_radius:{radius}m@{latitude},{longitude}`. Otherwise take the Cartesian product below, outer loop latitude, inner loop longitude. Use 5000 m in all 70 cells. Record `national_grid:bbox=1.16,103.60,1.48,104.12;radius=5000m;not_official_census`.

```text
latitudes:   1.16  1.22  1.28  1.34  1.40  1.46  1.48
longitudes: 103.60 103.66 103.72 103.78 103.84 103.90 103.96 104.02 104.08 104.12
```

For each cell request bus, then rail. Map row `id`, `name`, `lat`, `lon` to `Stop`; convert coordinates to numbers. Only at this provider boundary, convert a JSON integer bus ID in [0,99999] to a zero-padded five-digit string; do **not** repair malformed strings, floats or booleans. For rail, accept a provider composite only if it consists entirely of valid codes separated by literal ` / `; emit one stop per code with identical name/point and the exact composite as `source_id`. Ordinary stops have null `source_id`. If validation fails, record the one-based cell, row, kind and error type, omit that row and keep its siblings. On cell/kind query failure record cell, kind and error type and continue. On budget exhaustion record its location and return the partial inventory immediately. Across cells, last valid row wins by `(kind,id)`; sort output by `(kind,id)` lexically. Stamp `fetched_at` when returning. A grid inventory is not an official census.

**Destination.** Load and validate the entire scan inventory first. A station must match exactly one `rail` stop by ID, before any origin filtering. Use its point and name for `office` and `office_address`; no postal lookup, name search, nearest station or building fallback. For an invalid inventory or missing station give an actionable safe destination error. In postal mode use the exact lookup above; do not equate a coincident stop with the office.

**Dates.** Starting at `start-date` (inclusive), inspect offsets 0 through 31; keep the first non-holiday occurrence of each weekday Monday–Friday. Use the Singapore public-holiday calendar **including observed holidays**, for the start year and next year (reference lock: `holidays` 0.109). Return the five dates in chronological order, not weekday-number order; fail if not found. A holiday Monday defers *Monday*; a second Tuesday cannot replace it. At scan time reject if any selected date falls outside `[Singapore today, today + 30 days]` inclusive.

**Origin selection.** Filter by exact requested IDs, if supplied. Sort by `(great-circle distance to office, kind, id)` ascending, using haversine distance with Earth radius 6,371,000 m and angles in radians. Apply the optional nearest-N limit, then reject an empty selection. The user's ID list order does not determine processing order.

## 6. What counts as journey evidence

Evaluate every item in a probe's `plan.itineraries`. An empty array is a successful no-match. A valid but nonqualifying itinerary is skipped. A malformed item encountered during evaluation fails **the probe as a whole**; do not retain its valid siblings as though the probe succeeded.

1. Construct an offset-aware office deadline for the service date in Singapore. Read itinerary and leg `startTime`/`endTime` as finite, nonnegative **epoch milliseconds**, not seconds or local clock strings; booleans are not numbers. Convert to Singapore instants. Require end ≥ start. Require a nonempty leg array of objects; every examined leg interval must lie inside the itinerary, in order, without overlap. Gaps and zero-length intervals are allowed. `walkLimitExceeded` and leg `transitLeg`, if present, must be boolean; both default false.
2. `WALK` contributes only walking time. `BUS`, `SUBWAY`, `TRAM`, `RAIL` are transit even if `transitLeg` is false or missing. Any other nonempty mode (e.g. `CAR`) disqualifies the itinerary, regardless of flag. Missing/invalid mode is malformed. Sum the actual transit-leg intervals for `ride_seconds`; do not use a planner summary, the duration of a transfer, or overall elapsed time.
3. The **first transit leg** establishes `boarding_at` and the boarded ID. From its `from` object use `stopCode` if non-null; require a string and compare it unchanged. Only if null/absent, use the suffix after the last `:` of a nonempty string `stopId`. Numeric codes here are malformed, not padded. The resulting ID must exactly match the requested origin. An initial walk is allowed, but walking to a different boarding stop, being on an intermediate stop list, or boarding the opposite direction is not evidence for this origin.
4. For each transit leg retain `{id,name,mode}`. Present non-null `routeId`, `routeShortName`, `routeLongName`, `route` must be strings. For `name` take first nonempty of short name, long name, `route`, `routeId`; for `id` take first nonempty of `routeId`, `route`, chosen name. Missing usable identification is malformed. Do not infer Express, City Direct or any service category from these strings.
5. Use itinerary `endTime` as **office arrival**, including final walks. Boarding and arrival must both be on the requested Singapore date. Reject no-transit journeys, `walkLimitExceeded=true`, wrong boarding ID, or failure of either inclusive test below. Evaluate at full timestamp precision before truncating output metrics to whole seconds.

```text
0 <= deadline - arrival <= 900 seconds
sum(transit leg end - start) <= max_ride_minutes * 60 seconds
```

`elapsed_seconds` is arrival minus **boarding**, not time since query or itinerary start. `early_arrival_seconds` is deadline minus arrival. `walking_seconds` is itinerary `walkTime` if supplied, else sum of walk intervals. `waiting_seconds` is itinerary `waitingTime` if supplied, else max(0, itinerary duration minus durations of **all** legs). Supplied walk/wait totals must be finite, nonnegative numbers. These totals may include time before boarding; they need not sum with ride time to `elapsed_seconds`. Record the originating probe time and mode separately from the actual trip times and services.

**Representative selection** (apply within each response and again over the day's collected journeys): deduplicate by `(origin_id, service_date, boarding_at, arrival_at, ordered list of (service.id, service.name, service.mode))`, keeping the first observation and its query metadata. Pick (1) latest boarding, tie shortest ride; (2) shortest ride, tie latest boarding; (3) remaining candidates in ascending `(arrival_at, ride_seconds)`. Skip already selected trips and stop at five. Preserve encounter order for otherwise tied options. Equal ride duration alone does not mean the same trip.

## 7. Scan scheduler and status rules

Construct a single-day sample grid from earliest departure by repeatedly adding the step while time ≤ deadline. Do **not** append a deadline off the grid. Order times by proximity to `deadline − (max_ride_minutes + 15 minutes)`, breaking ties earlier first. The anchor affects order only; it does not narrow the window. Format probe times as `HH:MM:SS`. Example: `08:05` to `09:00`, step 15, cap 30 → query times `08:20`, `08:05`, `08:35`, `08:50`, in that order.

```text
for stop in selected origins (nearest first):
    if station destination and stop.id equals its ID:
        emit five qualified identity days (see below)
    else:
        modes = [bus, transit] for bus, [rail, transit] for rail
        grid = [(time, mode) for time in ordered times for mode in modes]
        preferred = []
        for date in chronological service dates:
            found = []; errors = []
            for pair in stable_unique(preferred followed by grid):
                request and evaluate; add qualifying journeys to found
                on failed query: record error and continue
                on budget exhaustion: record request_budget_exhausted and break
                on dates after the first: break as soon as found is nonempty
            select representatives from found; emit this day and its errors
            if budget exhausted or no representatives: break date loop
            preferred = stable_unique(query pairs of this day's representatives)
        emit origin result from collected days
    checkpoint report if an output path was supplied
    if this origin recorded request_budget_exhausted: stop scanning origins
```

The first date is searched across **all** sampled pairs even after a positive result, budget permitting. Later dates probe the **previous successful day's** pairs first and may qualify via a different service. Ordinary query errors include date, departure, mode and error type, not upstream text. They do not interrupt other probes. Never infer other origins from a returned route.

| Level | Decision, in precedence order |
|---|---|
| Day | Any retained journey → `qualified` (keep any errors too). Else any error or exhausted budget → `incomplete`. Else → `not_established`. |
| Origin | Five qualified days → `qualified`. Else exhaustion or any incomplete day → `incomplete`. Else → `not_established`. Stop on a day without evidence: that origin can no longer meet the five-day requirement. |
| Whole scan | `scan_completed=true` only if every selected origin has been processed, no budget exhaustion was recorded, no origin is incomplete and **no attempted day has query errors**. A clean `not_established` result does not prevent completion. `exhaustive=false` always. |

**Identity case:** if the selected origin is the exact destination station ID, make no route requests for it. Emit one journey per date: both instants at that day's office deadline; all five duration metrics zero; empty service list; `query_time` = deadline with seconds; `query_mode="at_destination"`. This is explicit identity evidence, not a fabricated API response. Other line IDs at the same point do not qualify by identity.

## 8. Reporting, partial results and exits

Populate the two ID arrays from **qualified origins only**, split by kind and sorted as strings. Inventory uniqueness ensures no duplicate IDs. Keep origins in processing order. `inventory_count` is the size of the supplied inventory, `selected_count` is after filtering/limiting, `processed_count` includes a partially evaluated origin once recorded, `unprocessed_count = selected_count − processed_count`. Do not emit records for unprocessed origins. In a single CLI run, `origin_scope_limited = (selected_count != inventory_count)`; this flag says nothing about how local the input inventory already was.

Copy the inventory scope and sampling parameters into coverage. Record cumulative network attempts and cache hits at each checkpoint. Include limitations: sampled forward search and provider alternative limit; unguaranteed special/private service coverage; no service-category inference; in-vehicle-only budget; no home walk or reliability padding; five-date validity; first-day versus later-day search; no unverified intermediate origins. Append each inventory error prefixed `Inventory discovery: ` and, only in postal mode, the first-exact-match/multiple-buildings caveat. Inventory errors describe the candidate set; alone they do not turn a clean scan of its selected stops into an incomplete scan.

Write the full report after each processed origin **only when** `--output` is set. Always emit the final report once at the end, then write the optional IDs file. `generated_at` is the report construction time. Coverage may be partial even when an ID is valid: do not erase five-day positive evidence because a different probe failed.

| Exit | Meaning |
|---|---|
| `0` | Discovery recorded no errors, or the selected sampled scan completed cleanly. Not an exhaustiveness claim. |
| `2` | Usage/configuration or unrecoverable top-level failure (e.g. bad inventory, unresolved destination, authentication/budget failure during postal lookup, file error). Emit a safe diagnostic. |
| `3` | Discovery wrote an inventory with errors, or scan wrote a report with `scan_completed=false`. Auth/provider errors inside cell or route loops are recorded there rather than automatically treated as top-level failures. |

## 9. Proving a port offline

Implement in dependency order: contracts and pure date/time rules; itinerary evaluation; scheduler over an injected route operation; OneMap adapter/cache; finally discovery, CLI and output. This keeps the hard decisions testable without credentials. The following are parity checks, not instructions to query live historical dates.

| Input or scenario | Expected observation |
|---|---|
| Provider integer bus ID `123` vs string `"123"`; rail `NE1 / CC29` | `"00123"` for the integer, row error for the string; two rail stops each retaining `source_id="NE1 / CC29"`. One bad row does not discard the next. |
| Date selection starting 2026-12-31 | `2026-12-31, 2027-01-04, 2027-01-05, 2027-01-06, 2027-01-08`: New Year's Day defers Friday. Test the calendar without the live CLI horizon. |
| [Captured bus→MRT response](tests/fixtures/bus_mrt_coast.json), use its origin/date/query, deadline 09:00, cap 30 | Retain bus `66421` → service `116` → `NE` (`BUS`, `SUBWAY`). First option: 1,219 s riding, 85 s walking, 127 s waiting, 1,431 s boarding-to-arrival. Transfer time is not deducted from the ride cap. |
| Arrival exactly 08:45 or 09:00 for a 09:00 deadline; exactly 1,800 s on vehicles at cap 30 | Qualifies if the origin and other checks pass. A millisecond outside either inclusive bound fails before rounding. A different first boarding ID, even with the same times, fails. |
| Two probes return the same trip; another trip has equal duration but a different service | First two collapse, preserving the first query pair; third remains eligible. First day searches on; next day stops after its first successful pair. |
| Four qualified days and one valid empty day vs one failed probe and no positive evidence on that day | Origin `not_established` vs `incomplete`; neither enters IDs. A failed alternative alongside five positive days keeps the ID but makes the run exit `3`. |
| Budget runs out mid-origin | Report includes the attempted day/error and partial origin, excludes unprocessed origins. Within TTL an identical rerun reuses responses with zero wire cost per hit. |
| Exact station is the sole selected origin | Five `at_destination` journeys and the station in `mrt_lrt_ids`; zero routing and postal calls. |

**Historical end-to-end references.** [Campus pilot](examples/ACCEPTANCE.md): eight selected origins, five dates, result bus `65009, 65709`, rail `NE16, NE17, PE6` ([full report](examples/live-results.json), [ID projection](examples/live-ids.json)). [Punggol Coast station run](examples/COAST_ACCEPTANCE.md): 246 selected of a separately prepared subset, 89 rail and 7 bus IDs qualified, 146 not established and 4 incomplete. All selected origins were processed, yet completion was false. Its [report](examples/coast-results.json) combines independent runs; sharding, summary generation and the separately derived stricter boarding-to-arrival list are **not CLI features**. The national inventory is discovery output, not proof that every stop was routed. Use captured data to compare semantics, not as an oracle for future live schedules, request counts or generation timestamps.

**Source map.** Under `src/onemap_commute/`: `models.py` defines the wire records; `calendar.py` selects dates; `journeys.py` evaluates and ranks evidence; `scanner.py` schedules probes and resolves statuses; `client.py` owns HTTP/auth/cache; `discovery.py` builds inventories; `cli.py` binds arguments, resolves destinations, selects origins and writes reports. `pyproject.toml` maps the executable to `cli.main`. The [offline tests](tests/) exercise these boundaries; no web UI, background worker or external agent is required.
