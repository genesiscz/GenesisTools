import {
    isClickableRole,
    isFillableRole,
    type PageNode,
    parsePageSnapshot,
    snapshotPage,
} from "@app/chrome-devtools/lib/page-snapshot";
import { emitClickOverlay } from "@app/control/lib/overlay";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { passwordWall } from "../browser/auth";
import { describeFields, type FieldDescriptor, inputValueFor, isPasswordField } from "../browser/fields";
import { elementScreenCenter, type ScreenPoint } from "../browser/geometry";
import { type BrowserMcp, createMcpSession } from "../browser/session";
import { CHROME_VERBS, performVerb, VERB_DESCRIPTIONS } from "../browser/verbs";
import { type ChromePage, parsePageList } from "../listen/chrome";
import { stripCandidatePrefix } from "./prefix";
import type { GoalSurface, SurfaceCandidate, SurfaceSnapshot } from "./surface";

const prof = profiler.scope("jev-browser");
const { log } = logger.scoped("jev-browser");

const CHROME_PREFIX = "chrome:";
const UID_RE = /^[A-Za-z0-9_-]+$/;
const MAX_LISTED_PAGES = 30;

export interface BrowserSurfaceOptions {
    port: number;
    /** Select the page whose URL contains this text before the first snapshot. */
    pageUrl?: string;
    /** Select the page whose title contains this text; how the focused browser tab is found. */
    pageTitle?: string;
    /** Select the page with this `list_pages` index before the first snapshot. */
    pageIndex?: number;
    /** Open this URL as a NEW page before the first snapshot; an existing page is never navigated. */
    url?: string;
    /** The only values the loop may type. A field with no matching key is not fillable. */
    inputs?: Record<string, string>;
    /** Injected in tests; otherwise one chrome-devtools-mcp session for the whole run. */
    mcp?: BrowserMcp;
    /** Injected in tests so the overlay is not drawn on a developer's screen. */
    overlay?: (point: ScreenPoint) => boolean;
}

export interface BrowserSurface extends GoalSurface {
    /** Closes the chrome-devtools-mcp session this surface opened. */
    close(): Promise<void>;
}

/**
 * Picks the CDP page the loop is allowed to act on. With neither selector and more than one page
 * open, the surface refuses: acting on "whatever page the MCP server had selected" is how a
 * browser loop once clicked into a random one of thirty tabs.
 */
export async function selectTargetPage(options: BrowserSurfaceOptions, mcp: BrowserMcp): Promise<ChromePage> {
    if (options.url) {
        log.info({ url: options.url }, "opening a new CDP page for the goal");
        await prof.measureAsync("new-page", () => mcp.callTool("new_page", { url: options.url }));
    }

    const listed = await prof.measureAsync("list-pages", () => mcp.callTool("list_pages", {}));
    const pages = parsePageList(mcp.toolText(listed));
    log.debug({ port: options.port, pages: pages.length }, "chrome-devtools listed pages");
    if (pages.length === 0) {
        throw new Error(`chrome-devtools on port ${options.port} lists no pages.`);
    }

    const target = matchPage(pages, options);
    if (!target) {
        throw new Error(refusal(pages, options));
    }

    await prof.measureAsync("select-page", () => mcp.callTool("select_page", { pageId: target.index }));
    log.info(
        { port: options.port, index: target.index, url: target.url, title: target.title },
        "browser surface page selected"
    );
    return target;
}

function matchPage(pages: ChromePage[], options: BrowserSurfaceOptions): ChromePage | undefined {
    if (options.pageIndex !== undefined) {
        return pages.find((page) => page.index === options.pageIndex);
    }

    if (options.url) {
        const opened = pages.filter((page) => page.url === options.url);
        return opened.length > 0 ? opened[opened.length - 1] : undefined;
    }

    if (options.pageUrl) {
        const needle = options.pageUrl.toLowerCase();
        return pages.find((page) => page.url.toLowerCase().includes(needle));
    }

    if (options.pageTitle) {
        const needle = options.pageTitle.toLowerCase();
        return pages.find((page) => (page.title ?? "").toLowerCase().includes(needle));
    }

    return pages.length === 1 ? pages[0] : undefined;
}

function refusal(pages: ChromePage[], options: BrowserSurfaceOptions): string {
    const listing = pages
        .slice(0, MAX_LISTED_PAGES)
        .map((page) => `  ${page.index}: ${page.url}${page.selected ? "  [selected]" : ""}`)
        .join("\n");
    const more = pages.length > MAX_LISTED_PAGES ? `\n  … ${pages.length - MAX_LISTED_PAGES} more` : "";
    if (options.url) {
        return `The page for --url ${options.url} is not in the page list. Pages:\n${listing}${more}`;
    }

    if (options.pageUrl || options.pageIndex !== undefined) {
        const flag = options.pageUrl ? `--page-url ${options.pageUrl}` : `--page-index ${options.pageIndex}`;
        return `No CDP page matches ${flag}. Pages:\n${listing}${more}`;
    }

    return `${pages.length} CDP pages are open; pass --page-url <substring> or --page-index <n>. Pages:\n${listing}${more}`;
}

function digestOf(nodes: PageNode[]): string {
    const text = nodes.map((node) => `${node.uid}|${node.role}|${node.name}|${node.value ?? ""}`).join("\n");
    return Bun.hash(text).toString(16);
}

function chromeRow(verb: string): SurfaceCandidate {
    return {
        id: `${CHROME_PREFIX}${verb}`,
        label: `${verb}: ${VERB_DESCRIPTIONS[verb as keyof typeof VERB_DESCRIPTIONS] ?? verb}`,
        element: -1,
        action: "chrome",
        chrome: verb,
        role: "chrome_verb",
    };
}

/** Evidence rows carry no `undefined` values: the evaluator's state schema rejects them. */
function evidenceRow(node: PageNode): Record<string, string> {
    const row: Record<string, string> = { id: node.uid, role: node.role, label: node.name };
    if (node.value !== undefined) {
        row.value = node.value;
    }

    if (node.href !== undefined) {
        row.href = node.href;
    }

    return row;
}

function pageRows(options: {
    nodes: PageNode[];
    fields: Map<string, FieldDescriptor>;
    inputs: Record<string, string>;
    fillValues: Map<string, string>;
}): SurfaceCandidate[] {
    const rows: SurfaceCandidate[] = [];
    for (const node of options.nodes) {
        if (node.disabled === true) {
            continue;
        }

        const field = options.fields.get(node.uid);
        if (isFillableRole(node.role)) {
            const value = inputValueFor({ node, field, inputs: options.inputs });
            if (value === undefined) {
                continue;
            }

            // A field that already holds exactly the supplied value has nothing left to type.
            // Offering it again left Jev choosing between re-typing and moving on, and it took
            // the third option and abstained.
            if (node.value === value) {
                log.debug({ uid: node.uid, label: node.name }, "field already holds the supplied value");
                continue;
            }

            options.fillValues.set(node.uid, value);
            rows.push({
                id: node.uid,
                label: node.name || field?.name || node.uid,
                element: -1,
                action: "set",
                role: node.role,
            });
            continue;
        }

        if (isClickableRole(node.role)) {
            rows.push({
                id: node.uid,
                label: node.name || node.uid,
                element: -1,
                action: "click",
                role: node.role,
                ...(node.href === undefined ? {} : { href: node.href }),
            });
        }
    }

    return rows;
}

export function createBrowserSurface(options: BrowserSurfaceOptions): BrowserSurface {
    const inputs = options.inputs ?? {};
    const mcp = options.mcp ?? createMcpSession({ port: options.port });
    const owned = options.mcp === undefined;
    const overlay = options.overlay ?? emitClickOverlay;
    const fillValues = new Map<string, string>();
    let page: ChromePage | undefined;
    let selectedOnConnection = -1;
    let pageUrl = "";
    let lastAct: { id: string; snapshot: string } | undefined;

    /** Re-selects the target page whenever the session reconnected and forgot it. */
    const ensurePage = async (): Promise<ChromePage> => {
        if (!page) {
            page = await selectTargetPage(options, mcp);
            selectedOnConnection = mcp.connectionId();
            return page;
        }

        if (mcp.connectionId() !== selectedOnConnection) {
            log.info({ index: page.index, url: page.url }, "re-selecting the target page on a new MCP session");
            await prof.measureAsync("select-page", () => mcp.callTool("select_page", { pageId: page?.index }));
            selectedOnConnection = mcp.connectionId();
        }

        return page;
    };

    return {
        kind: "browser",
        async see() {
            const target = await ensurePage();
            const result = await prof.measureAsync("snapshot", () => mcp.callTool("take_snapshot", {}));
            const nodes = parsePageSnapshot(mcp.toolText(result));
            const identity = snapshotPage(nodes);
            pageUrl = identity.url ?? target.url;
            const fields = await describeFields({
                mcp,
                uids: nodes.filter((node) => isFillableRole(node.role)).map((node) => node.uid),
            });
            for (const node of nodes) {
                node.password = isPasswordField({ node, field: fields.get(node.uid) });
            }

            const wall = passwordWall(nodes, inputs);
            const id = `cdp:${options.port}:${target.index}:${digestOf(nodes)}`;
            const label = identity.title ? `${identity.title} — ${pageUrl}` : pageUrl;
            if (wall.hit) {
                log.warn(
                    { page: target.index, url: pageUrl, fields: wall.fields },
                    "password wall: the page asks for a secret that --inputs does not carry; offering no candidates"
                );
                return {
                    id,
                    label,
                    candidates: [],
                    evidence: { passwordWall: true, fields: wall.fields, url: pageUrl },
                };
            }

            fillValues.clear();
            const candidates = [
                ...pageRows({ nodes, fields, inputs, fillValues }),
                ...CHROME_VERBS.map((verb) => chromeRow(verb)),
                ...(options.url && pageUrl !== options.url ? [chromeRow("navigate")] : []),
            ];
            log.info(
                { page: target.index, url: pageUrl, nodes: nodes.length, candidates: candidates.length },
                "browser surface snapshot"
            );
            return {
                id,
                label,
                candidates,
                evidence: { url: pageUrl, title: identity.title ?? "", nodes: nodes.map(evidenceRow) },
            };
        },
        async act(snapshot: SurfaceSnapshot, candidate: SurfaceCandidate) {
            const known = snapshot.candidates.some(
                (item) => item.id === candidate.id || stripCandidatePrefix(item.id).id === candidate.id
            );
            if (!known) {
                return { ok: false, error: "Candidate is outside the current page snapshot." };
            }

            if (lastAct && lastAct.id === candidate.id && lastAct.snapshot === snapshot.id) {
                log.warn({ id: candidate.id, snapshot: snapshot.id }, "repeated action on an unchanged page");
                return { ok: false, error: "repeated_action" };
            }

            lastAct = { id: candidate.id, snapshot: snapshot.id };
            const request = requestFor({ candidate, fillValues, pageUrl, url: options.url });
            if (!request) {
                return { ok: false, error: `No browser verb for candidate ${candidate.id}.` };
            }

            await ensurePage();
            log.info(
                { verb: request.verb, uid: request.uid, label: candidate.label, url: pageUrl },
                "browser surface act"
            );
            const result = await performVerb({ mcp, request });
            if (result.ok && request.verb === "click" && request.uid) {
                await drawOverlay({ mcp, uid: request.uid, overlay });
            }

            return { ok: result.ok, error: result.error };
        },
        async close() {
            if (owned) {
                await mcp.close();
            }
        },
    };
}

function requestFor(options: {
    candidate: SurfaceCandidate;
    fillValues: Map<string, string>;
    pageUrl: string;
    url?: string;
}) {
    const { candidate } = options;
    if (candidate.id.startsWith(CHROME_PREFIX)) {
        const verb = candidate.chrome ?? candidate.id.slice(CHROME_PREFIX.length);
        return { verb, url: verb === "navigate" ? options.url : undefined, pageUrl: options.pageUrl };
    }

    if (!UID_RE.test(candidate.id)) {
        return undefined;
    }

    if (candidate.action === "set") {
        return {
            verb: "fill",
            uid: candidate.id,
            value: options.fillValues.get(candidate.id),
            pageUrl: options.pageUrl,
        };
    }

    return { verb: "click", uid: candidate.id, pageUrl: options.pageUrl };
}

async function drawOverlay(options: { mcp: BrowserMcp; uid: string; overlay: (point: ScreenPoint) => boolean }) {
    const point = await elementScreenCenter({ mcp: options.mcp, uid: options.uid });
    if (!point) {
        log.info({ uid: options.uid }, "overlay skipped: the element box is unknown");
        return;
    }

    options.overlay(point);
}
