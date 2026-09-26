interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    // Fleet #2382. Everything that isn't a timeout/abort here is a genuine
    // NETWORK-LEVEL failure — DNS resolution, connection refused, TLS handshake,
    // Cloudflare's own "Network connection lost." — meaning `fetch()` itself
    // threw and no HTTP response of any kind was ever received. Until this fix
    // that raw exception was rethrown VERBATIM: a bare `TypeError: fetch failed`
    // (or the Workers-runtime equivalent) names no upstream, carries no class
    // token, and reads exactly like a defect in OUR code — because it says
    // nothing about the call at all. It landed in `error`, the tier that means
    // "Pipeworx has a defect", for every one of the (at the time of writing)
    // ~470 packs that call this helper directly with no wrapper of their own.
    //
    // `dexscreener` hit this independently (fleet #1579) and fixed it with a
    // bespoke per-pack try/catch around `fetchWithTimeout`. That fix is correct
    // but only covers one pack; every other caller of this shared helper still
    // leaked the raw exception. Moving the same fix HERE — the one place that
    // already carries the timeout case — covers every pack that uses
    // `fetchWithTimeout` without a wrapper, for free, and without widening
    // `classifyToolError`'s regex list: the fix is giving the message a proper
    // `upstream_down:` token at the point the two facts (no response was ever
    // received, and which host we were trying to reach) are actually in hand,
    // not teaching the classifier to guess from prose after the fact.
    //
    // Safe on the same grounds as the timeout branch above: no argument a
    // caller passes can make `fetch()` itself throw a connection-level error,
    // so this is always an availability failure, never a caller mistake. Same
    // `markInternalOrigin` treatment — an origin we run that never answered is
    // still ours, not a third party's outage.
    const raw = err instanceof Error ? err.message : String(err);
    throw new Error(
      markInternalOrigin(
        `upstream_down: could not reach ${name} at all (${raw.slice(0, 160)}). ` +
          `No request reached ${name}, so this says NOTHING about whether the arguments you passed ` +
          'are valid — do not re-check them on the strength of this error. Retry shortly.',
        url,
      ),
    );
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Wikidata <-> OpenStreetMap reconciliation.
 *
 * Sourced from the Wikidata Query Service (query.wikidata.org), the Wikidata
 * API (www.wikidata.org/w/api.php) and the OpenStreetMap Overpass API
 * (overpass.kumi.systems, with overpass-api.de as fallback) — all three
 * keyless and public.
 *
 * THE JOB: given a set of Wikidata items (explicit Q-ids, or a SPARQL selector
 * that picks them out), find the OpenStreetMap features that are the same
 * real-world thing, using coordinates, cross-lingual name agreement and any
 * `wikidata=` tag OSM already carries — and say, per item, one of four
 * distinct things:
 *
 *   matched    - a confident link, with the evidence (existing wikidata= tag,
 *                which language's label agreed, distance in metres).
 *   ambiguous  - more than one plausible OSM candidate; ALL of them come back
 *                with their scores, for a human to pick. This tool never
 *                auto-resolves a borderline case — guessing is the defect.
 *   unmatched  - the OSM search actually completed and nothing plausible was
 *                there.
 *   error      - the OSM search did NOT complete for this item (the entity
 *                didn't resolve on Wikidata, carries no coordinate, or the
 *                Overpass call failed/timed out/was capped) — reported with a
 *                `reason`, and NEVER collapsed into "unmatched". A failed
 *                lookup is not evidence of absence: read that way, a mapper
 *                could add a duplicate for something that was there all
 *                along and our query just fell over.
 *
 * Built generic on purpose — take Q-ids or a SPARQL query, and any OSM tag
 * filter. Georgian power stations are the first proving case (a live
 * community reconciliation effort, September 2026), not the scope: the same
 * call reconciles any Wikidata class against any OSM tag, anywhere.
 *
 * Read-only. No write path to Wikidata, Wikipedia or OpenStreetMap exists
 * here or anywhere in this pack.
 */


async function pwFetchWikidata(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'Wikidata');
}

async function pwFetchOverpass(url: string | URL, init?: RequestInit): Promise<Response> {
  return fetchWithTimeout(url, init ?? {}, 'OpenStreetMap Overpass');
}

const WD_API = 'https://www.wikidata.org/w/api.php';
const WDQS_ENDPOINT = 'https://query.wikidata.org/sparql';
// kumi.systems leads, and overpass-api.de is the fallback rather than the
// primary, for the reason measured in fleet #2036 and written up at length in
// mcps/overpass/src/index.ts: overpass-api.de returns a 371-byte Apache 406 to
// our relay egress for EVERY request shape tried — both Accept values, no
// Accept at all, no UA, and a bare GET of /api/status, plus both named
// backends — while answering 200 from a residential address under all of them.
// That is an IP block wearing a 406, so no header or hop recovers it. This
// pack's OSM leg was the second casualty of it (the first being `overpass`),
// and unlike that pack it had no fallback at all, so its reconciliation was
// silently running Wikidata-only.
const OVERPASS_ENDPOINT = 'https://overpass.kumi.systems/api/interpreter';
const OVERPASS_FALLBACK = 'https://overpass-api.de/api/interpreter';

// Statuses that mean the HOST is refusing us rather than that the QUERY is
// wrong — the same set `overpass` uses. A 400 is bad QQL and a 504 is a query
// too big for any server; re-running either against a second volunteer host
// just buys the same answer twice.
const OVERPASS_HOST_REFUSED = new Set([403, 406, 429, 502, 503, 521]);
const WD_UA = 'pipeworx-mcp-geo-reconcile/1.0 (+https://pipeworx.io; bruce@mojibake.ai)';
const OVERPASS_UA = 'Pipeworx-GeoReconcile-MCP/0.1 (contact@mojibake.ai)';

const MAX_BATCH_IDS = 50; // wbgetentities' own documented pipe-joined-ids cap
const MAX_REFUSED_ID_RETRIES = 8;
const MAX_ENTITIES = 200; // total items reconciled in one call, however sourced
const MAX_SPARQL_ROWS = 200;

const DEFAULT_RADIUS_M = 300;
const MIN_RADIUS_M = 10;
const MAX_RADIUS_M = 20000;

const DEFAULT_OVERPASS_TIMEOUT_S = 25;
const MIN_OVERPASS_TIMEOUT_S = 5;
const MAX_OVERPASS_TIMEOUT_S = 180;
const OVERPASS_ELEMENT_CAP = 4000; // if Overpass returns exactly this many, treat as capped/truncated

// Classification thresholds on the combined 0..1 score.
const CONFIDENT_THRESHOLD = 0.55;
const CONFIDENT_MARGIN = 0.15; // gap over the runner-up required to call it confident, not ambiguous
const MIN_PLAUSIBLE = 0.25;

// Overpass + Nominatim answer 429 then 521 from Cloudflare Worker egress while
// both return 200 from a laptop with the same headers (measured against this
// exact host, fleet #1246) — the gateway injects an egress-proxy hop for the
// `overpass` and `veterinary-fda` slugs for the same reason. `geo-reconcile`
// is in that same slug list in workers/gateway/src/index.ts. Wikidata's own
// hosts (www.wikidata.org, query.wikidata.org) are NOT affected and are
// fetched directly, matching the wikidata / wikidata-sparql packs.
let PROXY: { url: string; token: string } | null = null;

async function relay(
  target: string,
  init: { method?: string; body?: string; contentType?: string },
): Promise<Response | null> {
  if (!PROXY) return null;
  return pwFetchOverpass(PROXY.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${PROXY.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: target,
      method: init.method ?? 'GET',
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.contentType ? { contentType: init.contentType } : {}),
      userAgent: OVERPASS_UA,
    }),
  });
}

// ── Tool definition ──────────────────────────────────────────────────

const LANGUAGES_DESC =
  'Comma/pipe-joined language codes to compare, e.g. "ka,ru,en" — the shape needed when the same ' +
  'real-world place has different names in different languages (his own example: a Georgian power ' +
  'station named differently in Georgian, Russian and English). Every requested language\x27s label ' +
  'is fetched and compared against every OSM name tag (name, name:<lang>, alt_name, int_name, ' +
  'official_name); a match in ANY requested language counts as name agreement, and the response says ' +
  'which one. Default "en" — pass the full set you actually need, an English-only comparison both ' +
  'misses real matches and can manufacture false ones.';

const tools: McpToolExport['tools'] = [
  {
    name: 'reconcile_wikidata_osm',
    description:
      'Reconcile a set of Wikidata items against OpenStreetMap features of a given tag — the join Wikidata<->OSM ' +
      'community mapping efforts need before editing anything. Give either explicit Q-ids ("qids") or a SPARQL ' +
      'query that selects them ("sparql", must bind ?item to a wd:Q... URI — used to discover an arbitrary class, ' +
      'e.g. "every power station in country X"), plus an OSM tag filter ("osm_filter", e.g. "power=plant"). ' +
      'Fetches each item\x27s coordinate (P625) and labels in the requested languages, searches OSM within ' +
      'radius_m of each, and scores candidates on THREE signals: an existing `wikidata=` tag (ground truth when ' +
      'present), cross-lingual name agreement, and distance. Returns one of four DISTINCT states per item: ' +
      '"matched" (confident link + evidence), "ambiguous" (2+ plausible candidates, ALL returned with scores — ' +
      'never auto-resolved), "unmatched" (the OSM search completed and found nothing plausible), or "error" ' +
      '(the search did NOT complete — no Wikidata coordinate, the item didn\x27t resolve, or the Overpass call ' +
      'failed/timed out/was capped). "error" is never collapsed into "unmatched": a failed lookup is not evidence ' +
      'a thing is missing from OSM. Read-only — this does not write to Wikidata, Wikipedia or OpenStreetMap.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        qids: {
          description:
            `Wikidata Q-ids to reconcile, up to ${MAX_ENTITIES} — an array of strings or a comma/pipe-joined ` +
            'string (e.g. ["Q162887","Q3650523"] or "Q162887,Q3650523"). Provide this OR "sparql".',
          oneOf: [{ type: 'array', items: { type: 'string' } }, { type: 'string' }],
        },
        sparql: {
          type: 'string',
          description:
            `A SPARQL SELECT that binds ?item to the Wikidata items to reconcile (up to ${MAX_SPARQL_ROWS} used) — ` +
            'e.g. "SELECT ?item WHERE { ?item wdt:P31/wdt:P279* wd:Q159719 . ?item wdt:P17 wd:Q230 . }" for every ' +
            'power station (Q159719) in Georgia (Q230). Labels and coordinates are fetched separately per item, ' +
            'so this query only needs to pick the set — it does not need to select labels or coordinates itself. ' +
            'Provide this OR "qids".',
        },
        osm_filter: {
          type: 'string',
          description:
            'OSM tag filter(s) candidates must carry, as key=value, e.g. "power=plant" — or several alternatives ' +
            'comma-joined, e.g. "power=plant,power=generator" (OR-ed together). Required.',
        },
        languages: { type: 'string', description: LANGUAGES_DESC },
        radius_m: {
          type: 'number',
          description: `Search radius in metres around each item\x27s coordinate, ${MIN_RADIUS_M}-${MAX_RADIUS_M} (default ${DEFAULT_RADIUS_M}). An OSM feature carrying a matching wikidata= tag is still recognised as "matched" even if it falls outside this radius — the tag is ground truth.`,
        },
        overpass_timeout_s: {
          type: 'number',
          description:
            `Timeout passed to the Overpass query itself, ${MIN_OVERPASS_TIMEOUT_S}-${MAX_OVERPASS_TIMEOUT_S} seconds ` +
            `(default ${DEFAULT_OVERPASS_TIMEOUT_S}). Lower it to fail fast over a large area rather than wait.`,
        },
      },
      required: ['osm_filter'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  // Gateway-injected relay credentials for the Overpass hop only (see PROXY
  // above). Captured and deleted before any argument validation runs, so they
  // can never be echoed back or mistaken for a query parameter.
  PROXY =
    typeof args._proxyUrl === 'string' && typeof args._proxyToken === 'string'
      ? { url: args._proxyUrl, token: args._proxyToken }
      : null;
  delete args._proxyUrl;
  delete args._proxyToken;

  switch (name) {
    case 'reconcile_wikidata_osm':
      return reconcile(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── Wikidata: resolving the item set + fetching labels/coordinates ───

type WdStatement = {
  rank?: string;
  mainsnak?: { datavalue?: { type: string; value: unknown } };
};
type WdEntity = {
  id: string;
  missing?: string;
  labels?: Record<string, { value: string }>;
  claims?: Record<string, WdStatement[]>;
};

async function wdGetEntities(ids: string, languages: string): Promise<{
  entities?: Record<string, WdEntity>;
  error?: { code?: string; id?: string; info?: string };
}> {
  const res = await pwFetchWikidata(
    `${WD_API}?${new URLSearchParams({
      action: 'wbgetentities', ids, format: 'json', languages, props: 'labels|claims',
    })}`,
    { headers: { Accept: 'application/json', 'User-Agent': WD_UA } },
  );
  if (!res.ok) throw new Error(`Wikidata API error: HTTP ${res.status}`);
  return res.json();
}

/** Extract a P625 coordinate, preferring a "preferred"-rank statement, then
 *  "normal", over "deprecated" — falling back to the first statement present. */
function extractCoord(entity: WdEntity): { lat: number; lon: number } | null {
  const stmts = entity.claims?.P625 ?? [];
  const usable = stmts.filter((s) => s.rank !== 'deprecated');
  const ranked = usable.find((s) => s.rank === 'preferred')
    ?? usable.find((s) => s.rank === 'normal')
    ?? usable[0]
    ?? stmts[0];
  const dv = ranked?.mainsnak?.datavalue;
  if (!dv || dv.type !== 'globecoordinate') return null;
  const v = dv.value as { latitude?: number; longitude?: number };
  if (typeof v.latitude !== 'number' || typeof v.longitude !== 'number') return null;
  return { lat: v.latitude, lon: v.longitude };
}

interface ResolvedItem {
  qid: string;
  labels: Record<string, string>;
  lat: number | null;
  lon: number | null;
}

/**
 * Batch-resolve Q-ids to labels (in the requested languages) + coordinate.
 * Mirrors the wikidata pack's own get_entities: an id outside the item-id
 * range makes wbgetentities refuse the WHOLE batch with a top-level
 * no-such-entity error (HTTP 200) rather than marking just that id missing —
 * naive handling would read that as every id in the batch failing. Drop the
 * named offending id and retry; each pass removes exactly one, bounded by
 * MAX_REFUSED_ID_RETRIES so a batch of garbage ids costs a handful of round
 * trips, not one per id.
 */
async function resolveEntities(
  qids: string[],
  languages: string[],
): Promise<{ resolved: Map<string, ResolvedItem>; notFound: string[] }> {
  const resolved = new Map<string, ResolvedItem>();
  const notFound: string[] = [];
  const fetchLangs = Array.from(new Set([...languages, 'en'])).join('|');

  for (let i = 0; i < qids.length; i += MAX_BATCH_IDS) {
    const batch = qids.slice(i, i + MAX_BATCH_IDS);
    let pending = [...batch];
    let data: Awaited<ReturnType<typeof wdGetEntities>> = {};
    const maxRetries = Math.min(batch.length, MAX_REFUSED_ID_RETRIES);
    for (let attempt = 0; pending.length; attempt++) {
      data = await wdGetEntities(pending.join('|'), fetchLangs);
      const refused = data.error?.code === 'no-such-entity' ? String(data.error.id ?? '').trim().toUpperCase() : '';
      if (!refused) break;
      notFound.push(refused);
      const next = pending.filter((q) => q !== refused);
      if (next.length === pending.length || attempt >= maxRetries) { pending = next; break; }
      pending = next;
    }
    for (const qid of pending) {
      const ent = data.entities?.[qid];
      if (!ent || ent.missing !== undefined) { notFound.push(qid); continue; }
      const labels: Record<string, string> = {};
      for (const lang of languages) {
        const v = ent.labels?.[lang]?.value;
        if (v) labels[lang] = v;
      }
      const coord = extractCoord(ent);
      resolved.set(qid, { qid, labels, lat: coord?.lat ?? null, lon: coord?.lon ?? null });
    }
  }
  return { resolved, notFound };
}

/** Run a caller-supplied SPARQL SELECT and pull out every ?item Q-id bound. */
async function resolveQidsFromSparql(sparql: string): Promise<{ qids: string[]; truncated: boolean }> {
  const encoded = encodeURIComponent(sparql);
  const res = encoded.length <= 4000
    ? await pwFetchWikidata(`${WDQS_ENDPOINT}?query=${encoded}`, {
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': WD_UA },
    })
    : await pwFetchWikidata(WDQS_ENDPOINT, {
      method: 'POST',
      headers: { Accept: 'application/sparql-results+json', 'User-Agent': WD_UA, 'Content-Type': 'application/sparql-query' },
      body: sparql,
    });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Wikidata Query Service rejected "sparql": HTTP ${res.status} — ${summarizeErrorBody(body) || 'no further detail in the response'}`);
  }
  const data = (await res.json()) as { results?: { bindings?: Array<Record<string, { value: string }>> } };
  const bindings = data.results?.bindings ?? [];
  const qids: string[] = [];
  for (const b of bindings) {
    const uri = b.item?.value ?? '';
    const m = /\/entity\/(Q\d+)$/.exec(uri);
    if (m && !qids.includes(m[1])) qids.push(m[1]);
  }
  const truncated = qids.length > MAX_SPARQL_ROWS;
  return { qids: qids.slice(0, MAX_SPARQL_ROWS), truncated };
}

// ── Overpass: bbox candidate search ───────────────────────────────────

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

/** "power=plant,power=generator" -> Overpass QL bracket filters, OR-ed. Each
 *  clause must be key=value; anything else is rejected before it ever reaches
 *  Overpass, since a malformed clause silently interpreted as "search for
 *  this literal key" would misreport what was actually searched. */
function parseOsmFilter(raw: string): string[] {
  const clauses = raw.split(',').map((c) => c.trim()).filter(Boolean);
  if (!clauses.length) {
    throw new Error('Required argument "osm_filter" is missing. Pass an OSM tag like "power=plant", or several comma-joined like "power=plant,power=generator".');
  }
  return clauses.map((c) => {
    const eq = c.indexOf('=');
    if (eq < 1 || eq === c.length - 1) {
      throw new Error(`osm_filter clause "${c}" is not a valid "key=value" pair.`);
    }
    const k = c.slice(0, eq).trim();
    const v = c.slice(eq + 1).trim();
    return `["${k}"="${v}"]`;
  });
}

function bboxFrom(points: Array<{ lat: number; lon: number }>, radius_m: number): { south: number; west: number; north: number; east: number } {
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const padLat = (radius_m * 1.3) / 111_320;
  const padLon = (radius_m * 1.3) / (111_320 * Math.max(0.1, Math.cos((midLat * Math.PI) / 180)));
  return {
    south: Math.min(...lats) - padLat,
    north: Math.max(...lats) + padLat,
    west: Math.min(...lons) - padLon,
    east: Math.max(...lons) + padLon,
  };
}

async function overpassSearch(
  filters: string[],
  bbox: { south: number; west: number; north: number; east: number },
  timeout_s: number,
): Promise<{ elements: OverpassElement[]; capHit: boolean }> {
  const bboxStr = `${bbox.south},${bbox.west},${bbox.north},${bbox.east}`;
  const clauses = filters
    .map((f) => `  node${f}(${bboxStr});\n  way${f}(${bboxStr});\n  relation${f}(${bboxStr});`)
    .join('\n');
  const qql = `[out:json][timeout:${timeout_s}];\n(\n${clauses}\n);\nout center tags ${OVERPASS_ELEMENT_CAP};`;

  const body = `data=${encodeURIComponent(qql)}`;

  const post = async (endpoint: string): Promise<Response> =>
    (await relay(endpoint, { method: 'POST', body, contentType: 'application/x-www-form-urlencoded' }))
      ?? (await pwFetchOverpass(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': OVERPASS_UA },
        body,
      }));

  // A refusal and a hang both mean "ask the other host": kumi is a single
  // volunteer instance and was down for part of 2026-09-15, so treating only
  // refusals as fallback-worthy would leave this leg dark for the whole of any
  // such window.
  let res: Response;
  try {
    res = await post(OVERPASS_ENDPOINT);
    if (OVERPASS_HOST_REFUSED.has(res.status)) {
      const fallbackRes = await post(OVERPASS_FALLBACK);
      // When BOTH refuse, report the PRIMARY's status. The fallback refuses us
      // unconditionally, so its generic 406 would displace the primary's
      // actionable one (a 429 says "retry shortly") with something that reads
      // as a bad query. Same reasoning as mcps/overpass.
      if (!OVERPASS_HOST_REFUSED.has(fallbackRes.status)) res = fallbackRes;
    }
  } catch {
    res = await post(OVERPASS_FALLBACK);
  }

  if (res.status === 429) throw new Error('Overpass: rate-limited (HTTP 429). The OSM search did not run — try again shortly, or narrow the area/tag.');
  if (res.status === 504) throw new Error('Overpass: query timed out (HTTP 504). The OSM search did not complete — raise overpass_timeout_s, or narrow the area/tag.');
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Overpass rejected the query: HTTP ${res.status} — ${summarizeErrorBody(t) || 'no further detail in the response'}`);
  }
  const data = (await res.json()) as { elements?: OverpassElement[]; remark?: string };
  // Overpass can answer HTTP 200 for a query that ran out of time or memory
  // mid-execution, with the partial (sometimes empty) results it managed to
  // gather PLUS a top-level `remark` saying so — this is the exact trap the
  // whole tool exists to avoid: read naively, a "timed out, here is nothing"
  // response is byte-for-byte indistinguishable from "genuinely found
  // nothing". Treat any such remark as a failed call, not a real answer.
  if (data.remark && /time.?out|too many|runtime error|rate.?limit/i.test(data.remark)) {
    throw new Error(`Overpass returned HTTP 200 but reported it did not complete: "${data.remark}". Treating as failed rather than as a real (possibly empty) result.`);
  }
  const elements = data.elements ?? [];
  return { elements, capHit: elements.length >= OVERPASS_ELEMENT_CAP };
}

// ── Scoring ────────────────────────────────────────────────────────────

function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

/** Case/script-neutral normalization: strips diacritics (helps Latin/Cyrillic
 *  comparisons), lowercases, and reduces to whitespace-joined word tokens.
 *  Georgian script has no case or diacritics, so it passes through unchanged
 *  apart from tokenization. */
function normalizeName(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** 0..1 similarity: exact match after normalization, substring containment,
 *  or word-token Jaccard overlap — whichever is highest. */
function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  let score = 0;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) score = Math.max(score, 0.85);
  const ta = new Set(na.split(' '));
  const tb = new Set(nb.split(' '));
  const inter = [...ta].filter((t) => tb.has(t)).length;
  const union = new Set([...ta, ...tb]).size;
  if (union > 0) score = Math.max(score, inter / union);
  return score;
}

/** OSM tags that plausibly carry a place name, beyond the plain "name". */
const OSM_NAME_TAG_PREFIXES = ['name', 'alt_name', 'int_name', 'official_name', 'short_name', 'old_name'];

function osmNameTags(tags: Record<string, string>): Array<{ tag: string; value: string }> {
  const out: Array<{ tag: string; value: string }> = [];
  for (const [k, v] of Object.entries(tags)) {
    if (!v) continue;
    const base = k.split(':')[0];
    if (OSM_NAME_TAG_PREFIXES.includes(base)) out.push({ tag: k, value: v });
  }
  return out;
}

interface Candidate {
  type: string; id: number; osm_url: string;
  name: string | null; distance_m: number | null;
  wikidata_tag: string | null;
  wikidata_tag_conflict: boolean;
  name_match: { language: string; osm_tag: string; osm_value: string; score: number } | null;
  score: number;
}

function scoreCandidate(
  el: OverpassElement,
  entity: ResolvedItem,
  radius_m: number,
): Candidate {
  const tags = el.tags ?? {};
  const lat = el.lat ?? el.center?.lat ?? null;
  const lon = el.lon ?? el.center?.lon ?? null;
  const distance_m = entity.lat != null && entity.lon != null && lat != null && lon != null
    ? haversineM(entity.lat, entity.lon, lat, lon)
    : null;

  const wikidataTag = tags.wikidata ?? null;
  const tagMatches = wikidataTag === entity.qid;
  // This OSM feature already carries a wikidata= tag pointing at a DIFFERENT
  // item. That is strong evidence AGAINST it being a fresh match for this
  // entity — OSM already asserts it is something else — so it must never
  // silently win on name+distance alone. Forcing the score to 0 here is what
  // keeps a case like Tbilsresi (one OSM relation for the whole plant, and
  // separate Wikidata items for each generating unit) from being reported as
  // "matched" for a unit that in truth has no distinct OSM feature yet.
  const tagConflict = wikidataTag != null && !tagMatches;

  let bestName: Candidate['name_match'] = null;
  for (const [lang, label] of Object.entries(entity.labels)) {
    for (const { tag, value } of osmNameTags(tags)) {
      const s = nameSimilarity(label, value);
      if (!bestName || s > bestName.score) bestName = { language: lang, osm_tag: tag, osm_value: value, score: s };
    }
  }

  const nameScore = bestName?.score ?? 0;
  const distanceScore = distance_m != null ? Math.max(0, 1 - distance_m / radius_m) : 0;
  const score = tagMatches ? 1 : tagConflict ? 0 : Math.min(1, 0.6 * nameScore + 0.4 * distanceScore);

  return {
    type: el.type, id: el.id, osm_url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    name: tags.name ?? null, distance_m,
    wikidata_tag: wikidataTag,
    wikidata_tag_conflict: tagConflict,
    name_match: bestName && bestName.score > 0 ? bestName : null,
    score: Math.round(score * 1000) / 1000,
  };
}

type ReconcileState = 'matched' | 'ambiguous' | 'unmatched' | 'error';

interface EntityResult {
  qid: string; labels: Record<string, string>;
  coordinates: { latitude: number; longitude: number } | null;
  state: ReconcileState;
  reason?: string;
  matched_osm?: Candidate;
  candidates?: Candidate[];
  nearby_conflicting_tags?: Candidate[];
  note?: string;
}

function classify(entity: ResolvedItem, elements: OverpassElement[], radius_m: number, capHit: boolean): EntityResult {
  const base = {
    qid: entity.qid,
    labels: entity.labels,
    coordinates: entity.lat != null && entity.lon != null ? { latitude: entity.lat, longitude: entity.lon } : null,
  };

  const withinRadius = elements.filter((el) => {
    const lat = el.lat ?? el.center?.lat ?? null;
    const lon = el.lon ?? el.center?.lon ?? null;
    if (entity.lat == null || entity.lon == null || lat == null || lon == null) return false;
    return haversineM(entity.lat, entity.lon, lat, lon) <= radius_m;
  });
  const tagMatched = elements.filter((el) => el.tags?.wikidata === entity.qid);
  const considered = [...new Set([...tagMatched, ...withinRadius])];
  const scored = considered.map((el) => scoreCandidate(el, entity, radius_m)).sort((a, b) => b.score - a.score);
  // Within-radius features already claimed by a DIFFERENT Wikidata item. Kept
  // separately so they can be surfaced even on an unmatched/error verdict —
  // "the nearest thing here is already somebody else's" is evidence worth
  // showing a reviewer, not something to discard silently.
  const conflicts = scored.filter((c) => c.wikidata_tag_conflict).slice(0, 5);

  if (tagMatched.length === 1) {
    return {
      ...base, state: 'matched', matched_osm: scored.find((c) => c.wikidata_tag === entity.qid),
      note: 'Matched on an existing wikidata= tag already present in OpenStreetMap (ground truth) — cross-checked against name agreement and distance for transparency.',
    };
  }
  if (tagMatched.length > 1) {
    return {
      ...base, state: 'ambiguous', candidates: scored,
      note: `${tagMatched.length} different OSM features already carry wikidata=${entity.qid} — that is a data conflict in OSM itself, not a fresh match to propose. Needs human review, not auto-resolution.`,
    };
  }

  const conflictNote = conflicts.length
    ? ` ${conflicts.length} nearby OSM feature(s) within radius already carry a wikidata= tag for a DIFFERENT item (see nearby_conflicting_tags) — this may be a modeling-granularity mismatch (e.g. one OSM feature covering several Wikidata-listed units) rather than an empty area.`
    : '';

  const plausible = scored.filter((c) => c.score >= MIN_PLAUSIBLE);
  if (!plausible.length) {
    if (capHit) {
      return {
        ...base, state: 'error',
        nearby_conflicting_tags: conflicts.length ? conflicts : undefined,
        reason: `Overpass returned the maximum ${OVERPASS_ELEMENT_CAP} elements for this query — the result set was capped and completeness in this area is not guaranteed. No candidate was found in the (possibly incomplete) data, so this is NOT evidence the OSM feature is missing.${conflictNote}`,
      };
    }
    return {
      ...base, state: 'unmatched',
      nearby_conflicting_tags: conflicts.length ? conflicts : undefined,
      note: `No plausible OSM candidate within ${radius_m} m and no existing wikidata= tag. The OSM search completed; this reports a genuine absence, not a failed lookup.${conflictNote}`,
    };
  }
  const [top, runnerUp] = plausible;
  const confident = top.score >= CONFIDENT_THRESHOLD && (!runnerUp || top.score - runnerUp.score >= CONFIDENT_MARGIN);
  if (confident) {
    return { ...base, state: 'matched', matched_osm: top, note: 'Matched on name agreement + distance (no existing wikidata= tag on this feature yet).' };
  }
  return {
    ...base, state: 'ambiguous', candidates: plausible,
    nearby_conflicting_tags: conflicts.length ? conflicts : undefined,
    note: `${plausible.length} plausible OSM candidate(s), none clearly the best — surfaced for human review rather than guessed.${conflictNote}`,
  };
}

// ── Argument parsing + orchestration ──────────────────────────────────

function parseQids(arg: unknown): string[] {
  let raw: string[];
  if (Array.isArray(arg)) raw = arg.map((x) => String(x));
  else if (arg != null && String(arg).trim() !== '') raw = String(arg).split(/[,|]/);
  else raw = [];
  return Array.from(new Set(raw.map((s) => s.trim().toUpperCase()).filter(Boolean)));
}

function parseLanguages(arg: unknown): string[] {
  const codes = String(arg ?? '').split(/[,|]/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  return codes.length ? codes : ['en'];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

async function reconcile(args: Record<string, unknown>): Promise<unknown> {
  const qidsArg = parseQids(args.qids);
  const sparqlArg = typeof args.sparql === 'string' ? args.sparql.trim() : '';
  if (!qidsArg.length && !sparqlArg) {
    throw new Error('Provide either "qids" (Wikidata Q-ids to reconcile) or "sparql" (a SPARQL SELECT that binds ?item to pick them).');
  }
  const filters = parseOsmFilter(String(args.osm_filter ?? ''));
  const languages = parseLanguages(args.languages);
  const radius_m = clamp(Number(args.radius_m) || DEFAULT_RADIUS_M, MIN_RADIUS_M, MAX_RADIUS_M);
  const overpassTimeoutS = clamp(Number(args.overpass_timeout_s) || DEFAULT_OVERPASS_TIMEOUT_S, MIN_OVERPASS_TIMEOUT_S, MAX_OVERPASS_TIMEOUT_S);

  // ── Step 1: resolve the Q-id set ──
  let qids = qidsArg;
  let sparqlTruncated = false;
  if (sparqlArg) {
    let sparqlQids: string[];
    try {
      ({ qids: sparqlQids, truncated: sparqlTruncated } = await resolveQidsFromSparql(sparqlArg));
    } catch (err) {
      // The selection step itself failed — we never got a set of items to
      // look up, so there is nothing to classify per-item. This is a whole-
      // call failure, not a batch of "unmatched" items.
      return {
        query_ok: false,
        reason: `Could not resolve "sparql" against the Wikidata Query Service: ${(err as Error).message}`,
        results: [],
        summary: { matched: 0, ambiguous: 0, unmatched: 0, error: 0 },
      };
    }
    qids = Array.from(new Set([...qids, ...sparqlQids]));
  }
  const totalRequested = qids.length;
  const truncatedEntities = qids.length > MAX_ENTITIES;
  qids = qids.slice(0, MAX_ENTITIES);

  // ── Step 2: resolve labels + coordinates for each item ──
  const { resolved, notFound } = await resolveEntities(qids, languages);

  const withCoords: ResolvedItem[] = [];
  const noCoordResults: EntityResult[] = [];
  for (const qid of qids) {
    const item = resolved.get(qid);
    if (!item) continue; // handled via notFound below
    if (item.lat == null || item.lon == null) {
      noCoordResults.push({
        qid, labels: item.labels, coordinates: null, state: 'error',
        reason: 'This Wikidata item has no coordinate (P625) recorded, so no OSM search area could be built. Not evidence it is unmapped — Wikidata itself has no location for it yet.',
      });
    } else {
      withCoords.push(item);
    }
  }
  const notFoundResults: EntityResult[] = notFound.map((qid) => ({
    qid, labels: {}, coordinates: null, state: 'error',
    reason: 'This id did not resolve on Wikidata (bad format, deleted, or does not exist) — the OSM search never ran for it.',
  }));

  // ── Step 3: single Overpass search over the bbox covering every resolved coordinate ──
  let osm: { query_ok: boolean; bbox: unknown; total: number; cap_hit: boolean; filter_clauses: string[]; error?: string };
  let entityResults: EntityResult[] = [];

  if (!withCoords.length) {
    // Nothing to search — every item is already accounted for above (either
    // not_found or no coordinate), each with its own specific reason. No
    // Overpass call was needed, so nothing here failed.
    osm = { query_ok: true, bbox: null, total: 0, cap_hit: false, filter_clauses: filters };
  } else {
    const bbox = bboxFrom(withCoords.map((p) => ({ lat: p.lat as number, lon: p.lon as number })), radius_m);
    try {
      const { elements, capHit } = await overpassSearch(filters, bbox, overpassTimeoutS);
      osm = { query_ok: true, bbox, total: elements.length, cap_hit: capHit, filter_clauses: filters };
      entityResults = withCoords.map((item) => classify(item, elements, radius_m, capHit));
    } catch (err) {
      // The Overpass call itself failed (rate-limit, timeout, malformed
      // filter, upstream error) — EVERY item that needed an OSM search gets
      // "error" with the real reason. This must never render as "unmatched":
      // a failed lookup here would tell a mapper an OSM feature is missing
      // when the truth is our query fell over, and they would add a duplicate.
      const message = (err as Error).message;
      osm = { query_ok: false, bbox, total: 0, cap_hit: false, filter_clauses: filters, error: message };
      entityResults = withCoords.map((item) => ({
        qid: item.qid, labels: item.labels,
        coordinates: { latitude: item.lat as number, longitude: item.lon as number },
        state: 'error', reason: `The OpenStreetMap search did not complete: ${message}`,
      }));
    }
  }

  const results = [...entityResults, ...noCoordResults, ...notFoundResults];
  const summary = { matched: 0, ambiguous: 0, unmatched: 0, error: 0 };
  for (const r of results) summary[r.state]++;

  return {
    requested: { qids: totalRequested, via_sparql: Boolean(sparqlArg), truncated_at_max_entities: truncatedEntities, sparql_result_truncated: sparqlTruncated },
    resolved_count: resolved.size,
    not_found: notFound,
    languages,
    radius_m,
    osm,
    summary,
    results,
    source: 'Wikidata Query Service (query.wikidata.org) + Wikidata API (www.wikidata.org) + OpenStreetMap Overpass API (overpass.kumi.systems, falling back to overpass-api.de)',
  };
}

export default { tools, callTool, meter: { credits: 3 } } satisfies McpToolExport;
