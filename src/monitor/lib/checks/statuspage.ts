import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import type { CheckResult, Watcher, WatcherStatus } from "../types";
import { describeFetchError, timedFetch } from "./http";

/**
 * Atlassian Statuspage v2 summary (`/api/v2/summary.json`). incident.io pages
 * (status.openai.com) expose the same shape, so one reader covers both.
 * status.x.ai is a custom Next.js page with no JSON API: its server-rendered
 * "Services" list is read instead (see `parseXaiStatusHtml`).
 */
interface StatuspageSummary {
    page?: { name?: string };
    status?: { indicator?: string; description?: string };
    components?: StatuspageComponent[];
}

export interface StatuspageComponent {
    name: string;
    status: string;
    group?: boolean;
}

const BROWSER_UA =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36 genesis-tools-monitor/1.0";

const INDICATOR_STATUS: Record<string, WatcherStatus> = {
    none: "up",
    minor: "degraded",
    maintenance: "degraded",
    major: "down",
    critical: "down",
};

const COMPONENT_STATUS: Record<string, WatcherStatus> = {
    operational: "up",
    degraded_performance: "degraded",
    partial_outage: "degraded",
    under_maintenance: "degraded",
    major_outage: "down",
};

// `unknown` outranks `up` on purpose: a component whose state string is not in
// the table above is NOT known to be healthy, and treating it as `up` renders a
// real outage green (a self-hosted page with its own vocabulary, or a new
// Atlassian/incident.io state). It stays below `degraded` so a page that also
// reports a real problem still reports that problem.
const SEVERITY: Record<WatcherStatus, number> = { up: 0, unknown: 1, degraded: 2, down: 3 };

/** The watcher status a component's state string means; `unknown` for a state we do not know. */
function componentStatus(component: StatuspageComponent): WatcherStatus {
    return COMPONENT_STATUS[component.status] ?? "unknown";
}

export function worstStatus(statuses: WatcherStatus[]): WatcherStatus {
    let worst: WatcherStatus = "up";

    for (const status of statuses) {
        if (SEVERITY[status] > SEVERITY[worst]) {
            worst = status;
        }
    }

    return worst;
}

export function summaryUrl(target: string): string {
    return `${target.replace(/\/$/, "")}/api/v2/summary.json`;
}

function pickComponents(all: StatuspageComponent[], filters: string[] | undefined): StatuspageComponent[] {
    const leaves = all.filter((component) => !component.group);

    if (!filters || filters.length === 0) {
        return leaves;
    }

    const needles = filters.map((filter) => filter.toLowerCase());

    return leaves.filter((component) => needles.some((needle) => component.name.toLowerCase().includes(needle)));
}

export function evaluateSummary(
    summary: StatuspageSummary,
    filters: string[] | undefined
): { status: WatcherStatus; detail: string; affected: StatuspageComponent[]; matched: number } {
    const components = pickComponents(summary.components ?? [], filters);
    const affected = components.filter((component) => componentStatus(component) !== "up");
    const indicator = summary.status?.indicator ?? "none";
    const filtered = filters !== undefined && filters.length > 0;
    const worstComponent = worstStatus(affected.map(componentStatus));
    // With a component filter the page-wide indicator is noise: an outage on an
    // unrelated product must not flip a watcher that only cares about the API.
    const status = filtered ? worstComponent : worstStatus([INDICATOR_STATUS[indicator] ?? "degraded", worstComponent]);
    const description = summary.status?.description ?? indicator;
    const detail =
        affected.length > 0
            ? `${description} · ${affected.map((component) => `${component.name}: ${component.status.replace(/_/g, " ")}`).join(", ")}`
            : filtered
              ? `${components.length} matching component${components.length === 1 ? "" : "s"} operational`
              : description;

    return { status, detail, affected, matched: components.length };
}

// ------------------------------------------------------------------ status.x.ai

const XAI_WORD_STATUS: Record<string, string> = {
    available: "operational",
    operational: "operational",
    degraded: "degraded_performance",
    partial: "partial_outage",
    outage: "major_outage",
    maintenance: "under_maintenance",
};

/**
 * status.x.ai renders `Services` as name/state pairs ("Grok (iOS)", "outage",
 * "Single Sign-On", "available", …). Read that block into Statuspage-shaped
 * components so the rest of the pipeline stays unchanged.
 */
export function parseXaiStatusHtml(html: string): StatuspageSummary {
    const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, "|")
        .replace(/\s+/g, " ")
        .replace(/\|\s*\|+/g, "|");
    const parts = text
        .split("|")
        .map((part) => part.trim())
        .filter(Boolean);
    const start = parts.lastIndexOf("Services");
    const components: StatuspageComponent[] = [];
    let terminated = false;

    if (start >= 0) {
        let i = start + 1;

        for (; i + 1 < parts.length; i += 2) {
            const name = parts[i];
            const word = parts[i + 1].toLowerCase();
            const status = XAI_WORD_STATUS[word];

            if (!status) {
                // The list ends at the page footer. Anything else here means the
                // layout changed mid-list: report nothing rather than a partial "up".
                terminated = XAI_LIST_TERMINATORS.has(name);
                break;
            }

            components.push({ name, status });
        }

        // Running out of text after whole pairs is a complete read too.
        if (i + 1 >= parts.length) {
            terminated = true;
        }
    }

    if (!terminated) {
        components.length = 0;
    }

    const worst = worstStatus(components.map(componentStatus));
    const indicator = worst === "down" ? "major" : worst === "degraded" ? "minor" : "none";
    const affected = components.filter((component) => component.status !== "operational").length;
    const description =
        worst === "up"
            ? "All Systems Operational"
            : `${affected} service${affected === 1 ? "" : "s"} ${worst === "down" ? "down" : "degraded"}`;

    return { page: { name: "xAI" }, status: { indicator, description }, components };
}

/** Footer words that legitimately end the Services list on status.x.ai. */
const XAI_LIST_TERMINATORS = new Set(["Models", "Try Grok on", "Products", "API", "Company", "Resources", "Legal"]);

/**
 * `SafeJSON.parse` accepts `null`, a number and an array, and every one of
 * those reaches `evaluateSummary` as a `StatuspageSummary` the cast promised.
 * `summary.components ?? []` then throws on `null` and `.filter` is missing on
 * a string, which escapes `listStatuspageComponents` as a 500 carrying the
 * internal message. A page that answers something else is a check result.
 */
function isStatuspageSummary(value: unknown): value is StatuspageSummary {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const components = (value as { components?: unknown }).components;

    return components === undefined || components === null || Array.isArray(components);
}

/** A failed poll must not keep its socket until the timeout fires. */
async function discardBody(response: Response): Promise<void> {
    await response.body?.cancel().catch((cancelError) => {
        logger.debug({ cancelError }, "monitor: status page body cancel failed");
    });
}

function isXai(target: string): boolean {
    return /^https?:\/\/status\.x\.ai/i.test(target);
}

async function fetchXaiSummary(
    target: string,
    timeoutMs: number
): Promise<{ summary: StatuspageSummary; latencyMs: number; httpStatus: number }> {
    const { response, latencyMs } = await timedFetch(
        target,
        { method: "GET", headers: { "User-Agent": BROWSER_UA, Accept: "text/html" } },
        timeoutMs
    );

    if (!response.ok) {
        await discardBody(response);
        throw new Error(`status.x.ai answered ${response.status}`);
    }

    const summary = parseXaiStatusHtml(await response.text());

    if ((summary.components?.length ?? 0) === 0) {
        throw new Error("status.x.ai page layout changed: no Services list found");
    }

    return { summary, latencyMs, httpStatus: response.status };
}

async function fetchSummary(
    target: string,
    timeoutMs: number
): Promise<{ summary: StatuspageSummary; latencyMs: number; httpStatus: number }> {
    if (isXai(target)) {
        return fetchXaiSummary(target, timeoutMs);
    }

    const { response, latencyMs } = await timedFetch(
        summaryUrl(target),
        { method: "GET", headers: { Accept: "application/json", "User-Agent": BROWSER_UA } },
        timeoutMs
    );

    if (!response.ok) {
        await discardBody(response);
        throw new Error(`status page answered ${response.status} for /api/v2/summary.json`);
    }

    const summary: unknown = SafeJSON.parse(await response.text(), { strict: true });

    if (!isStatuspageSummary(summary)) {
        throw new Error("status page did not answer a /api/v2/summary.json document");
    }

    return { summary, latencyMs, httpStatus: response.status };
}

/** Components a status page currently lists, for the dashboard's component picker. */
export async function listStatuspageComponents(
    target: string,
    timeoutMs = 10_000
): Promise<{ page: string | null; components: StatuspageComponent[] }> {
    const { summary } = await fetchSummary(target, timeoutMs);

    return {
        page: summary.page?.name ?? null,
        components: (summary.components ?? []).filter((component) => !component.group),
    };
}

export async function checkStatuspage(watcher: Pick<Watcher, "target" | "config" | "timeoutMs">): Promise<CheckResult> {
    let summary: StatuspageSummary;
    let latencyMs: number;
    let httpStatus: number;

    try {
        ({ summary, latencyMs, httpStatus } = await fetchSummary(watcher.target, watcher.timeoutMs));
    } catch (error) {
        logger.debug({ error, target: watcher.target }, "monitor: statuspage fetch failed");
        const detail =
            error instanceof Error && !error.name.includes("Timeout") && !error.message.includes("fetch")
                ? error.message
                : `status page unreachable: ${describeFetchError(error, watcher.timeoutMs)}`;

        return { status: "unknown", latencyMs: null, httpStatus: null, detail };
    }

    const filters = watcher.config.components;
    const evaluated = evaluateSummary(summary, filters);

    if (filters && filters.length > 0 && evaluated.matched === 0) {
        return {
            status: "unknown",
            latencyMs,
            httpStatus,
            detail: `no component matches "${filters.join(", ")}"`,
            meta: { indicator: summary.status?.indicator ?? null, components: summary.components?.map((c) => c.name) },
        };
    }

    return {
        status: evaluated.status,
        latencyMs,
        httpStatus,
        detail: evaluated.detail,
        meta: {
            page: summary.page?.name ?? null,
            indicator: summary.status?.indicator ?? null,
            description: summary.status?.description ?? null,
            affected: evaluated.affected.map((component) => ({ name: component.name, status: component.status })),
        },
    };
}
