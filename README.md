# @pipeworx/geo-reconcile

Reconciles Wikidata items against OpenStreetMap features — the join a
community mapping effort needs before linking or adding anything. Give a set
of Wikidata Q-ids (or a SPARQL selector that picks out an arbitrary class,
e.g. "every power station in country X") and an OSM tag filter; get back one
of four DISTINCT verdicts per item — `matched`, `ambiguous`, `unmatched`, or
`error` — scored on an existing `wikidata=` tag, cross-lingual name agreement,
and distance. Built generic; Georgian power stations are the first proving
case, not the scope.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1683+ live data sources.

## Tools

- `reconcile_wikidata_osm({qids | sparql, osm_filter, languages, radius_m, overpass_timeout_s})` —
  resolves each Wikidata item's coordinate (P625) and labels in the requested
  languages, runs one Overpass bbox search for `osm_filter` covering every
  item, and classifies each item:
  - `matched` — a confident link, with the evidence: an existing `wikidata=`
    tag (ground truth) or name agreement + distance.
  - `ambiguous` — 2+ plausible OSM candidates (or 2+ OSM features already
    tagged with the SAME Wikidata item, a data conflict) — ALL returned with
    scores, never auto-resolved.
  - `unmatched` — the OSM search completed and nothing plausible was there.
  - `error` — the search did NOT complete for this item: it didn't resolve
    on Wikidata, carries no coordinate, or the Overpass call
    failed/timed-out/was capped. Never collapsed into `unmatched` — a failed
    lookup is not evidence of absence.

## Auth

Keyless. All three upstreams (Wikidata API, Wikidata Query Service,
OpenStreetMap Overpass API) are free and require no key.

Overpass calls are relayed through Pipeworx's egress proxy when the gateway
provides one — `overpass-api.de` answers 429 then 521 to direct Cloudflare
Worker egress while returning 200 to the same request from elsewhere
(observed against this same host, fleet #1246; also true of the standalone
`overpass` pack). A standalone (non-gateway) deployment of this pack calls
Overpass directly and works from any non-Cloudflare-Worker environment
without relay configuration.

The OSM leg goes to `overpass.kumi.systems` FIRST and falls back to
`overpass-api.de`, because the latter now refuses the relay's egress as well —
406 to every request shape tried, including a bare `GET /api/status`, while
answering 200 to all of them from a residential address (fleet #2036). Until
2026-09-15 this pack had no fallback, so whenever that refusal was in force
the reconciliation ran Wikidata-only and reported its OSM leg as `error`.

## Data sources

- <https://www.wikidata.org/w/api.php> (`action=wbgetentities`) — labels and
  the P625 coordinate claim for each resolved item.
- <https://query.wikidata.org/sparql> — runs a caller-supplied SPARQL SELECT
  to discover the item set when `sparql` is given instead of `qids`.
- <https://overpass.kumi.systems/api/interpreter> — the OSM feature search
  within the bounding box covering every resolved item's coordinate, with
  <https://overpass-api.de/api/interpreter> as fallback.

Notes for the next person:

- **A `wikidata=` tag that points at a DIFFERENT item than the one being
  reconciled is treated as negative evidence, not ignored.** OSM sometimes
  models several Wikidata-listed units as one combined feature (e.g. Georgia's
  Vartsikhe I–IV are four separate Wikidata items but the OSM `way`s for I, II
  and IV nearby are already tagged for Vartsikhe's *aggregate* Wikidata item,
  Q4104053) — silently letting name+distance "match" a unit to that already-
  claimed feature would tell a mapper to re-tag something that is correctly
  tagged for something else. Any such conflict forces the candidate's score to
  0 (excluding it from `matched`/`ambiguous`) and is surfaced separately in
  `nearby_conflicting_tags` so a human can see the granularity mismatch rather
  than have it silently disappear.
- **Overpass can answer HTTP 200 for a query that ran out of time or memory
  mid-execution**, with a top-level `remark` field and partial (sometimes
  empty) `elements` — read naively, that is byte-for-byte indistinguishable
  from "genuinely found nothing". This pack checks `remark` for
  timeout/rate-limit/runtime-error language and treats a match there as a
  failed call (every affected item becomes `error`), never as a real empty
  result.
- **`out center tags <N>;` is capped** (currently 4000 elements) rather than
  left unbounded, because an unbounded query over a large area can itself be
  the thing that times out. If Overpass returns exactly the cap, `cap_hit` is
  set on the response and any item that would otherwise have come back
  `unmatched` is reported as `error` instead — completeness for that area is
  not guaranteed under a capped result, so "nothing found" is not a claim this
  pack is willing to make.
- **A `sparql` selector only needs to bind `?item`.** Labels and coordinates
  are always fetched separately via `wbgetentities`, so the SPARQL does not
  need to select them itself — this keeps the selection query simple and
  reuses one consistent label/coordinate path regardless of how the item set
  was chosen.
- Verified live (2026-09-10) against Georgia's power stations: of 171 Wikidata
  items resolved, 23 OSM features already carried a `wikidata=` tag matching
  one of them — all 23 were recovered as `matched`, zero false positives. 87
  items had no P625 coordinate yet (a real, current gap in the Wikidata data,
  not a bug here) and correctly came back `error`, not `unmatched`.
- **Re-checking that 23 against OSM directly will give you 24 — and the extra
  one is not a regression.** Independently verified 2026-09-10 (fleet #1813):
  a Georgia-wide `nwr["power"="plant"]["wikidata"]` Overpass query returns 27
  features carrying 24 *distinct* `wikidata=` values. Twenty-three of those 24
  items are in the class selection above (`wdt:P31/wdt:P279* wd:Q159719`,
  `wdt:P17 wd:Q230`) and all 23 come back `matched`, every one justified by
  the existing tag rather than by name+distance. The 24th is **Q4104053**, the
  *aggregate* Vartsikhe plant — the same granularity mismatch described two
  bullets up. It is absent because the selector never asked about it, not
  because the pack lost it. Compare against the reconciled item set, not
  against a bare Overpass count, or you will chase a phantom.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "geo-reconcile": {
      "url": "https://gateway.pipeworx.io/geo-reconcile/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/geo-reconcile/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1683+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/reconcile_wikidata_osm \
  -H 'Content-Type: application/json' \
  -d '{"qids":["Q162887","Q3650523","Q4501177"],"osm_filter":"power=plant","languages":"ka,ru,en","radius_m":2000}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/reconcile_wikidata_osm`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "geo-reconcile": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-geo-reconcile"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-geo-reconcile
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Geo Reconcile data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
