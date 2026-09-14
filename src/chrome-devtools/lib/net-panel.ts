/**
 * The DevTools panel's OWN NetworkLog — the THIRD network log this tool can read.
 *
 * 1. The recorder buffer (`record` / `har --last`): CDP events captured since THIS
 *    tool's background recorder started.
 * 2. chrome-devtools-mcp `list_network_requests`: CDP events since THAT MCP session
 *    attached. `includePreservedRequests` only reaches back over the last few
 *    navigations inside its own log.
 * 3. This one: `NetworkLog.instance().requests()` inside the DevTools FRONTEND,
 *    which "Preserve log" has been filling since the user opened the panel.
 *
 * Only the third holds the history a user means when they say "my Network tab shows
 * 600 rows". Neither of the other two can be made to replay it — a second
 * `Network.enable` on the page target does not backfill, and the panel's rows never
 * existed as events in either buffer.
 *
 * Proven live 2026-09-09 (631 requests) with the reference script at
 * `.claude/work/2026-09-09-1536-dump-devtools-network-log.js`.
 */
import { logger } from "@genesiscz/utils/logger";
import { makeMatcher, type Target } from "./cdp.ts";
import type { HarEntry, HarFile } from "./har/types.ts";

const { log } = logger.scoped("chrome-devtools:net-panel");

/** Every DevTools frontend shares ONE url, so the url can only classify — never identify. */
export const DEVTOOLS_URL_PREFIX = "devtools://";

/** What the frontend prefixes its window title with: `DevTools - <host><path>`. */
export const DEVTOOLS_TITLE_PREFIX = "DevTools - ";

export function isDevToolsTarget(target: { url: string }): boolean {
    return target.url.startsWith(DEVTOOLS_URL_PREFIX);
}

/** `DevTools - app.example.com/portal` -> `app.example.com/portal`; null when it is not an inspector title. */
export function devtoolsSubject(title: string): string | null {
    if (!title.startsWith(DEVTOOLS_TITLE_PREFIX)) {
        return null;
    }

    const subject = title.slice(DEVTOOLS_TITLE_PREFIX.length).trim();

    return subject.length > 0 ? subject : null;
}

/** `https://app.example.com/portal/search#/` -> `app.example.com/portal/search`, the shape DevTools titles itself with. */
export function pageSubject(url: string): string | null {
    try {
        const parsed = new URL(url);

        return `${parsed.host}${parsed.pathname}`;
    } catch (err) {
        log.debug({ err, url }, "page url did not parse, so it has no DevTools title subject");

        return null;
    }
}

function normalizeSubject(value: string): string {
    return value.replace(/\/+$/, "").toLowerCase();
}

/**
 * Does this inspector title belong to that page? DevTools truncates long titles, so a
 * prefix match in EITHER direction counts; an empty subject must never match anything.
 */
export function subjectMatches(inspector: string | null, page: string | null): boolean {
    if (!inspector || !page) {
        return false;
    }

    const a = normalizeSubject(inspector);
    const b = normalizeSubject(page);

    if (a.length === 0 || b.length === 0) {
        return false;
    }

    return a.startsWith(b) || b.startsWith(a);
}

/** The same two subjects naming the same page, rather than one merely starting with the other. */
export function subjectEquals(inspector: string | null, page: string | null): boolean {
    if (!inspector || !page) {
        return false;
    }

    const a = normalizeSubject(inspector);

    return a.length > 0 && a === normalizeSubject(page);
}

/** Thrown when no DevTools window can be tied to `--match`; carries what IS open so the CLI can print it. */
export class NoDevToolsTargetError extends Error {
    constructor(
        readonly wanted: string,
        readonly page: Target | null,
        readonly inspectorTitles: string[]
    ) {
        super(`no open DevTools window for "${wanted}"`);
        this.name = "NoDevToolsTargetError";
    }
}

/**
 * Thrown when `--match` leaves the pick to chance, on either side of the walk.
 *
 * `tab`: the substring named several open tabs, and reading the first one's panel is a
 * coin toss the caller never sees.
 * `inspector`: one tab, but several inspectors tie to it. A page on the site root
 * normalizes to the bare host, and a bare host is a prefix of EVERY inspector subject on
 * that host, so the first hit reads a different tab's log and says nothing.
 */
export class AmbiguousDevToolsTargetError extends Error {
    constructor(
        readonly wanted: string,
        readonly kind: "tab" | "inspector",
        /** Tab urls for `tab`, inspector window titles for `inspector`. */
        readonly candidates: string[],
        /** The tab the walk started from; null when the tabs themselves were ambiguous. */
        readonly page: Target | null
    ) {
        super(
            kind === "tab"
                ? `"${wanted}" matches ${candidates.length} open tabs, so the pick would be a guess`
                : `"${wanted}" ties to ${candidates.length} DevTools windows, so the pick would be a guess`
        );
        this.name = "AmbiguousDevToolsTargetError";
    }
}

/**
 * The one tied candidate `--match` can name on its own.
 *
 * `--match` is a substring test, so handing back the FIRST tied candidate does not
 * disambiguate anything: one candidate is routinely a prefix of another (".../admin"
 * inside ".../admin/users"), so re-running reprints the identical tie, or — on the
 * inspector side — degrades into "no open DevTools window" for a window that is open.
 * The LONGEST candidate cannot be a proper substring of any other, so it is the one
 * that resolves.
 *
 * Null when the longest is not unique: two tabs on the same url cannot be told apart by
 * `--match` at all, and printing a command that cannot work is worse than saying so.
 */
export function disambiguatingMatch(candidates: string[]): string | null {
    const longest = [...candidates].sort((a, z) => z.length - a.length)[0];

    if (longest === undefined || candidates.filter((c) => c === longest).length > 1) {
        return null;
    }

    return longest;
}

export interface DevToolsPick {
    devtools: Target;
    /** The inspected tab, when `--match` reached the inspector through it. */
    page: Target | null;
    /** `title` when --match named the inspector itself, `page` when we walked from the inspected tab. */
    via: "title" | "page";
    /**
     * False when the inspector was accepted on a PREFIX of the page subject rather than on
     * the subject itself.
     *
     * That case has to stay allowed: DevTools truncates a long title, and the truncated form
     * is a prefix of the page subject. But an inspector sitting on the site ROOT is a prefix
     * of every deeper tab on that host too, so accepting one when it is the only candidate is
     * a guess — and a guess that reads a DIFFERENT tab's log is the exact failure this module
     * exists to prevent. The caller says so out loud instead of passing it off as a match.
     */
    exactSubject: boolean;
}

/**
 * Resolve the DevTools window for `--match`.
 *
 * 🛑 Never pick by url. Every open inspector reports the same
 * `devtools://devtools/bundled/devtools_app.html`, so a url-based pick grabs whichever
 * one happens to be first and dumps a DIFFERENT tab's network log. The title is the
 * only discriminator, and on Brave these targets report `type: "page"` in /json/list,
 * so type cannot classify them either.
 */
export function pickDevToolsTarget(list: Target[], wanted: string): DevToolsPick {
    const inspectors = list.filter(isDevToolsTarget);
    const pages = list.filter((t) => !isDevToolsTarget(t) && (t.type === "page" || t.type === undefined));
    const matches = makeMatcher(wanted);
    const matchedPages = pages.filter((p) => matches(p.url) || matches(p.title ?? ""));

    // 1. --match may name the inspector outright: --match 'DevTools - app.example.com'.
    //    Exactly one hit is unambiguous; several mean we must go through the page instead.
    const byTitle = inspectors.filter((t) => matches(t.title ?? ""));
    if (byTitle.length === 1) {
        // --match named the inspector itself, so nothing was inferred from a page subject.
        return { devtools: byTitle[0], page: matchedPages[0] ?? null, via: "title", exactSubject: true };
    }

    // 2. Otherwise walk from the inspected tab. Which tab has to be settled FIRST: taking
    //    the first of several matches reads one tab's panel while the caller named two.
    if (matchedPages.length > 1) {
        throw new AmbiguousDevToolsTargetError(
            wanted,
            "tab",
            matchedPages.map((p) => p.url),
            null
        );
    }

    // 3. One tab, so its host+path is what DevTools titles itself with. An exact subject
    //    wins outright; a prefix match is only trusted when it is the ONLY one, because a
    //    root-path page prefix-matches every inspector on its host.
    const page = matchedPages[0] ?? null;

    if (page) {
        const subject = pageSubject(page.url);
        const candidates = inspectors.filter((t) => subjectMatches(devtoolsSubject(t.title ?? ""), subject));
        const exact = candidates.filter((t) => subjectEquals(devtoolsSubject(t.title ?? ""), subject));

        if (exact.length === 1) {
            return { devtools: exact[0], page, via: "page", exactSubject: true };
        }

        if (exact.length === 0 && candidates.length === 1) {
            return { devtools: candidates[0], page, via: "page", exactSubject: false };
        }

        if (candidates.length > 1) {
            throw new AmbiguousDevToolsTargetError(
                wanted,
                "inspector",
                (exact.length > 1 ? exact : candidates).map((t) => t.title ?? ""),
                page
            );
        }
    }

    throw new NoDevToolsTargetError(
        wanted,
        page,
        inspectors.map((t) => t.title ?? "")
    );
}

/**
 * The eval that runs INSIDE the DevTools frontend.
 *
 * Two traps are baked in deliberately:
 * - `logs.NetworkLog` is the MODULE; the class is `logs.NetworkLog.NetworkLog`.
 * - `r.url` is a getter over private fields. It must be called ON the request
 *   (`v.call(obj)`); extracting it first throws `Cannot read properties of undefined`.
 *
 * It returns RAW urls and no headers at all. Stripping happens on the TypeScript side,
 * and headers are never collected in the first place, so a Set-Cookie or Authorization
 * value cannot leak through this door even when a caller asks for full urls.
 */
export const PANEL_DUMP_SCRIPT = `async () => {
    const logs = await import("./models/logs/logs.js");
    const NetworkLog = logs.NetworkLog.NetworkLog;
    const requests = NetworkLog.instance().requests();

    const pick = (obj, name) => {
        try {
            const v = obj[name];
            return typeof v === "function" ? v.call(obj) : v;
        } catch (e) {
            // A field the running DevTools build does not expose is absent, not fatal.
            return undefined;
        }
    };

    const rows = [];
    for (const r of requests) {
        const type = pick(r, "resourceType");
        const typeName = type ? pick(type, "name") || pick(type, "title") : undefined;
        rows.push({
            url: String(pick(r, "url") || ""),
            method: String(pick(r, "requestMethod") || ""),
            status: Number(pick(r, "statusCode") || 0),
            resourceType: String(typeName || type || ""),
            mimeType: String(pick(r, "mimeType") || ""),
            startTime: Number(pick(r, "startTime") || 0),
            endTime: Number(pick(r, "endTime") || 0),
            wallIssueTime: Number(pick(r, "wallIssueTime") || 0),
            transferSize: Number(pick(r, "transferSize") || 0),
            resourceSize: Number(pick(r, "resourceSize") || 0),
            failed: Boolean(pick(r, "failed")),
            fromCache: Boolean(pick(r, "cached")),
        });
    }

    return { count: requests.length, inspector: String(document.title || ""), rows: rows };
}`;

/**
 * How long the one-shot panel read may take.
 *
 * `Runtime.evaluate` over an OPEN socket never times out by itself: a frontend whose main
 * thread is wedged simply never answers, and the verb would wait forever with no output.
 */
export const PANEL_READ_TIMEOUT_MS = 30_000;

/** Race `work` against a deadline, without leaving the loser as an unhandled rejection. */
export async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    // NOT an unhandled-rejection guard: `Promise.race` subscribes to every promise it is
    // given, so a rejection arriving after the deadline won is already handled and silently
    // discarded (measured — with a live `process.on("unhandledRejection")` listener the
    // no-catch form fires zero times while a plain rejected promise fires once). What this
    // line adds is the LOG: without it a frontend that answered late, and with an error,
    // leaves no trace of why.
    work.catch((err: unknown) => log.debug({ err }, "raced work rejected after its deadline"));

    try {
        return await Promise.race([
            work,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), ms);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export interface PanelRequest {
    url: string;
    method: string;
    status: number;
    resourceType: string;
    mimeType: string;
    startTime: number;
    endTime: number;
    wallIssueTime: number;
    transferSize: number;
    resourceSize: number;
    failed: boolean;
    fromCache: boolean;
}

export interface PanelDump {
    count: number;
    inspector: string;
    rows: PanelRequest[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function str(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Read the eval result without trusting its shape — a DevTools build change must not crash the verb. */
export function parsePanelDump(value: unknown): PanelDump {
    const root = asRecord(value);

    if (!root) {
        throw new Error("the DevTools eval returned no object — is the Network panel open on that tab?");
    }

    const rawRows = Array.isArray(root.rows) ? root.rows : [];
    const rows: PanelRequest[] = [];

    for (const raw of rawRows) {
        const r = asRecord(raw);

        if (!r) {
            continue;
        }

        rows.push({
            url: str(r.url),
            method: str(r.method),
            status: num(r.status),
            resourceType: str(r.resourceType),
            mimeType: str(r.mimeType),
            startTime: num(r.startTime),
            endTime: num(r.endTime),
            wallIssueTime: num(r.wallIssueTime),
            transferSize: num(r.transferSize),
            resourceSize: num(r.resourceSize),
            failed: r.failed === true,
            fromCache: r.fromCache === true,
        });
    }

    return { count: num(root.count) || rows.length, inspector: str(root.inspector), rows };
}

/**
 * origin + pathname, nothing else.
 *
 * The query string and fragment are where OAuth `?code=`, `#access_token=`, session ids
 * and search terms live, so the default view drops them outright rather than trying to
 * recognise which parameter is a secret.
 */
export function stripUrl(url: string): string {
    try {
        const parsed = new URL(url);

        // `data:` and `javascript:` have no query string to cut: the url IS the resource.
        // A base64 image floods stdout and an inline script can carry a bearer token, so
        // the payload is named and dropped rather than reprinted.
        if (parsed.protocol === "data:") {
            // `data:[<mediatype>][;base64],<data>` — everything before the first comma is
            // the declared type, and the payload cannot reach into it.
            const comma = parsed.pathname.indexOf(",");
            const mime = comma > 0 ? parsed.pathname.slice(0, comma).split(";")[0] : "";

            return mime ? `data:${mime},[payload dropped]` : "data:[payload dropped]";
        }

        if (parsed.protocol === "javascript:") {
            // There is no delimiter inside inline code, so nothing of it can be kept.
            return "javascript:[inline code dropped]";
        }

        // A blob url's pathname is a whole inner url, so origin + pathname glues two
        // origins together: "https://app.example.comhttps://app.example.com/9f0e".
        if (parsed.protocol === "blob:") {
            return `blob:${stripUrl(parsed.pathname)}`;
        }

        if (parsed.origin && parsed.origin !== "null") {
            return `${parsed.origin}${parsed.pathname}`;
        }

        // Every other opaque-origin scheme (file:, chrome-extension:, anything custom)
        // still has a usable path, and rebuilding it from parts would invent an authority
        // that "weird::/thing" never had. The textual cut below keeps it verbatim.
    } catch (err) {
        log.debug({ err, url }, "unparseable request url; falling back to a textual query/hash cut");
    }

    return url.split("?")[0].split("#")[0];
}

/**
 * Is this url its own payload?
 *
 * `--full-urls` means "keep the query string and fragment", and the shared HAR sanitizer
 * it hands off to only redacts `?name=value` pairs and the fragment. A `data:` or
 * `javascript:` url has neither, so it would pass through that sanitizer untouched and
 * land in the file in full — the one thing the default view had just been taught not to do.
 */
export function hasInlinePayload(url: string): boolean {
    try {
        const protocol = new URL(url).protocol;

        return protocol === "data:" || protocol === "javascript:";
    } catch (err) {
        log.debug({ err, url }, "url did not parse while classifying inline payloads");

        return false;
    }
}

export function hostOf(url: string): string {
    try {
        return new URL(url).host;
    } catch (err) {
        log.debug({ err, url }, "unparseable request url has no host");

        return "(unparsed)";
    }
}

export interface PanelSummaryRow {
    method: string;
    status: number;
    resourceType: string;
    url: string;
}

export interface PanelSummary {
    count: number;
    inspector: string;
    hosts: Record<string, number>;
    methods: Record<string, number>;
    statuses: Record<string, number>;
    resourceTypes: Record<string, number>;
    failed: number;
    documents: PanelSummaryRow[];
}

function bump(into: Record<string, number>, key: string): void {
    into[key] = (into[key] ?? 0) + 1;
}

export const DEFAULT_DOCUMENT_LIMIT = 40;

/** Histograms plus the document hops, with every url already reduced to origin+pathname. */
export function summarizePanel(dump: PanelDump, opts: { documentLimit?: number } = {}): PanelSummary {
    const limit = opts.documentLimit ?? DEFAULT_DOCUMENT_LIMIT;
    const hosts: Record<string, number> = {};
    const methods: Record<string, number> = {};
    const statuses: Record<string, number> = {};
    const resourceTypes: Record<string, number> = {};
    const documents: PanelSummaryRow[] = [];
    let failed = 0;

    for (const row of dump.rows) {
        bump(hosts, hostOf(row.url) || "(none)");
        bump(methods, row.method || "?");
        bump(statuses, String(row.status));
        bump(resourceTypes, row.resourceType || "?");

        if (row.failed) {
            failed += 1;
        }

        if (/document/i.test(row.resourceType) && documents.length < limit) {
            documents.push({
                method: row.method,
                status: row.status,
                resourceType: row.resourceType,
                url: stripUrl(row.url),
            });
        }
    }

    return {
        count: dump.count,
        inspector: dump.inspector,
        hosts,
        methods,
        statuses,
        resourceTypes,
        failed,
        documents,
    };
}

function entryTimeMs(row: PanelRequest): number {
    const delta = (row.endTime - row.startTime) * 1000;

    return Number.isFinite(delta) && delta > 0 ? Math.round(delta) : 0;
}

/**
 * A HAR of the panel rows.
 *
 * Headers, cookies and post bodies are absent BY CONSTRUCTION: the eval never collects
 * them, so this export cannot carry an Authorization header or a password no matter what
 * flags a caller passes. Urls are stripped to origin+pathname unless `fullUrls` is set,
 * and the caller is expected to run `sanitizeHar()` over the result when it is.
 */
export function panelDumpToHar(dump: PanelDump, opts: { fullUrls?: boolean; capturedAt?: Date } = {}): HarFile {
    const capturedAt = opts.capturedAt ?? new Date();
    const entries: HarEntry[] = dump.rows.map((row, index) => {
        const key = `panel-${index}`;
        const startedDateTime =
            row.wallIssueTime > 0 ? new Date(row.wallIssueTime * 1000).toISOString() : capturedAt.toISOString();

        return {
            cache: {},
            startedDateTime,
            time: entryTimeMs(row),
            request: {
                method: row.method || "GET",
                // `--full-urls` widens what is kept for REAL requests. An inline payload
                // has no query string to keep, so no flag may reprint it whole.
                url: opts.fullUrls && !hasInlinePayload(row.url) ? row.url : stripUrl(row.url),
                queryString: [],
                headersSize: -1,
                bodySize: -1,
                cookies: [],
                headers: [],
            },
            response: {
                httpVersion: "",
                redirectURL: "",
                status: row.status,
                statusText: "",
                content: { size: row.resourceSize, mimeType: row.mimeType },
                headersSize: -1,
                bodySize: row.transferSize,
                cookies: [],
                headers: [],
                fromDiskCache: row.fromCache,
                fromEarlyHints: false,
                fromServiceWorker: false,
                fromPrefetchCache: false,
            },
            _requestId: key,
            _resourceType: row.resourceType,
            __key: key,
        };
    });

    return {
        log: {
            version: "1.2",
            creator: {
                name: "GenesisTools chrome-devtools net-panel",
                version: "1",
                comment: "DevTools panel NetworkLog; headers, cookies and bodies are never collected",
            },
            pages: [],
            entries,
        },
    };
}
