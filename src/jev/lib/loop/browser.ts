import type { DomAction, DomSnapshot } from "@app/chrome-devtools/lib/dom/in-page";
import type { DomActResult } from "@app/chrome-devtools/lib/dom/page";
import { emitClickOverlay } from "@app/control/lib/overlay";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import { leavesOrigin, passwordWall, sameOrigin } from "../browser/auth";
import { inputValueFor } from "../browser/fields";
import { openGoalPage, type PageSelector } from "../browser/pages";
import { type BrowserVerb, VERB_DESCRIPTIONS } from "../browser/verbs";
import { looksLikeCredential, type WriteText } from "../browser/writer";
import { stripCandidatePrefix } from "./prefix";
import type { GoalSurface, SurfaceCandidate, SurfaceSnapshot } from "./surface";

const prof = profiler.scope("jev-browser");
const { log } = logger.scoped("jev-browser");

const CHROME_PREFIX = "chrome:";
/** Recent page tables an act may still name: a listen prefetch can act on the snapshot before the newest. */
const KEPT_TABLES = 3;

export interface ScreenPoint {
    x: number;
    y: number;
}

export interface BrowserSurfaceOptions {
    port: number;
    /** Select the page whose URL contains this text. */
    pageUrl?: string;
    /** Select the page whose title contains this text; how the focused browser tab is found. */
    pageTitle?: string;
    /** Select the page with this index in the browser's page list. */
    pageIndex?: number;
    /** Open this URL as a NEW tab before the first read; an existing page is never navigated. */
    url?: string;
    /** The only values the loop may type. A field with no matching key is not fillable. */
    inputs?: Record<string, string>;
    /** Injected in tests so the overlay is not drawn on a developer's screen. */
    overlay?: (point: ScreenPoint) => boolean;
    /** Injected in tests; otherwise the page is attached over CDP (`DomPage`). */
    openPage?: (selector: PageSelector) => Promise<DomPageDriver>;
    /**
     * Opt-in writer for fields `--inputs` does not cover (`jev loop --writer`). Jev still chooses the
     * row; the writer only supplies its text, and never for a secret or credential-like field.
     */
    writer?: WriteText;
    /** The goal the writer writes for. */
    goal?: string;
}

export interface BrowserSurface extends GoalSurface {
    /** Closes the CDP connection this surface opened. */
    close(): Promise<void>;
}

/** What the surface needs from a page: `DomPage` in production, a fixture in tests. */
export interface DomPageDriver {
    snapshot(): Promise<DomSnapshot>;
    click(action: DomAction): Promise<DomActResult>;
    fill(action: DomAction, value: string): Promise<DomActResult>;
    select(action: DomAction): Promise<DomActResult>;
    scroll(direction: 1 | -1): Promise<DomActResult>;
    wait(): Promise<DomActResult>;
    back(): Promise<DomActResult>;
    reload(): Promise<DomActResult>;
    navigate(url: string): Promise<DomActResult>;
    close(): void;
}

type Plan =
    | { kind: "dom"; action: DomAction; value?: string; compose?: boolean }
    | { kind: "chrome"; verb: BrowserVerb };

function chromeRow(verb: BrowserVerb): SurfaceCandidate {
    return {
        id: `${CHROME_PREFIX}${verb}`,
        label: `${verb}: ${VERB_DESCRIPTIONS[verb]}`,
        element: -1,
        action: "chrome",
        chrome: verb,
        role: "chrome_verb",
    };
}

/** Evidence rows carry no `undefined` values: the evaluator's state schema rejects them. */
function evidenceRow(action: DomAction): Record<string, string | boolean> {
    const row: Record<string, string | boolean> = { id: action.id, role: action.role, label: action.label };
    if (action.value !== undefined) {
        row.value = action.value;
    }

    if (action.checked !== undefined) {
        row.checked = action.checked;
    }

    if (action.href !== undefined) {
        row.href = action.href;
    }

    if (action.option) {
        row.option = action.option.label;
    }

    return row;
}

function rowsFor(options: {
    snapshot: DomSnapshot;
    inputs: Record<string, string>;
    goalUrl?: string;
    plans: Map<string, Plan>;
    writer: boolean;
}): SurfaceCandidate[] {
    const { snapshot, inputs, plans } = options;
    const rows: SurfaceCandidate[] = [];
    for (const action of snapshot.actions) {
        if (action.kind === "fill") {
            const field = action.field;
            const value = inputValueFor({
                node: { name: action.label },
                field: field
                    ? { uid: action.id, type: field.type, name: field.name, id: field.id, ariaLabel: field.ariaLabel }
                    : undefined,
                inputs,
            });
            const writable =
                value === undefined &&
                options.writer &&
                field !== undefined &&
                !field.secret &&
                !looksLikeCredential({ label: action.label, role: action.role, name: field.name, type: field.type });
            if (writable) {
                plans.set(action.id, { kind: "dom", action, compose: true });
                rows.push({
                    id: action.id,
                    label: `Write into ${action.label || action.id}`,
                    element: -1,
                    action: "set",
                    role: action.role,
                });
                continue;
            }

            // Only the caller's values are ever typed, and a field that already holds its value has
            // nothing left to type: offering it again made Jev abstain between the two.
            if (value === undefined || (!field?.secret && action.value === value)) {
                continue;
            }

            plans.set(action.id, { kind: "dom", action, value });
            rows.push({
                id: action.id,
                label: action.label || action.id,
                element: -1,
                action: "set",
                role: action.role,
            });
            continue;
        }

        // A link off the page's origin is never offered, the same rule the navigate verb follows.
        if (action.href !== undefined && leavesOrigin(snapshot.url, action.href)) {
            continue;
        }

        plans.set(action.id, { kind: "dom", action });
        // The option the list already shows changes nothing; offering it split Jev between it and
        // the next real step (measured 2026-09-28: 0.39 against 0.45, and nothing was admitted).
        if (action.kind === "select" && action.option && action.value === action.option.label) {
            continue;
        }

        if (action.kind === "select" && action.option) {
            rows.push({
                id: action.id,
                label: `${action.option.label} (option in ${action.label || "a list"})`,
                element: -1,
                action: "click",
                role: "option",
            });
            continue;
        }

        rows.push({
            id: action.id,
            label: action.label || action.id,
            element: -1,
            action: "click",
            role: action.role,
            ...(action.href === undefined ? {} : { href: action.href }),
        });
    }

    // Offer only what the page can take now: an option the executor cannot run reads as model doubt.
    const verbs: BrowserVerb[] = [
        ...(snapshot.historyLength > 1 ? (["back"] as const) : []),
        "reload",
        ...(snapshot.canScrollDown ? (["scroll_down"] as const) : []),
        ...(snapshot.canScrollUp ? (["scroll_up"] as const) : []),
        "wait",
        ...(options.goalUrl && snapshot.url !== options.goalUrl ? (["navigate"] as const) : []),
    ];
    for (const verb of verbs) {
        const row = chromeRow(verb);
        plans.set(row.id, { kind: "chrome", verb });
        rows.push(row);
    }

    return rows;
}

/**
 * The browser goal surface: one CDP page, read with ONE in-page script per step (`DomPage` in
 * `@app/chrome-devtools/lib/dom`). The page is chosen explicitly, `--inputs` is the only text ever
 * typed, a page asking for an unsupplied secret offers nothing, navigation stays on the page's
 * origin, and every row id is a code-owned node reference, never a selector from the model.
 */
export function createBrowserSurface(options: BrowserSurfaceOptions): BrowserSurface {
    const inputs = options.inputs ?? {};
    const overlay = options.overlay ?? emitClickOverlay;
    const openPage = options.openPage ?? ((selector: PageSelector) => openGoalPage({ port: options.port, selector }));
    const tables = new Map<string, { url: string; plans: Map<string, Plan>; snapshot: DomSnapshot }>();
    let page: DomPageDriver | undefined;

    const ensurePage = async (): Promise<DomPageDriver> => {
        page ??= await openPage({
            pageUrl: options.pageUrl,
            pageTitle: options.pageTitle,
            pageIndex: options.pageIndex,
            url: options.url,
        });
        return page;
    };

    const compose = async (current: DomPageDriver, action: DomAction, seen: DomSnapshot): Promise<DomActResult> => {
        if (!options.writer) {
            return { ok: false, error: "no writer is enabled; pass --writer or supply --inputs", dispatched: false };
        }

        const written = await options.writer({
            goal: options.goal ?? "",
            field: {
                label: action.label,
                role: action.role,
                ...(action.field ? { name: action.field.name, type: action.field.type } : {}),
            },
            page: { url: seen.url, title: seen.title, text: seen.text },
        });
        if (!written.fill) {
            return { ok: false, error: `writer declined: ${written.reason}`, dispatched: false };
        }

        return current.fill(action, written.text);
    };

    const run = async (current: DomPageDriver, plan: Plan, url: string, seen: DomSnapshot): Promise<DomActResult> => {
        if (plan.kind === "chrome") {
            switch (plan.verb) {
                case "back":
                    return current.back();
                case "reload":
                    return current.reload();
                case "scroll_down":
                    return current.scroll(1);
                case "scroll_up":
                    return current.scroll(-1);
                case "wait":
                    return current.wait();
                case "navigate":
                    if (!options.url || !sameOrigin(url, options.url)) {
                        return {
                            ok: false,
                            error: `navigate refused: ${options.url} leaves the origin of ${url}`,
                            dispatched: false,
                        };
                    }

                    return current.navigate(options.url);
                default:
                    return { ok: false, error: `unsupported_verb: ${plan.verb}`, dispatched: false };
            }
        }

        if (plan.action.kind === "fill" && plan.compose) {
            return compose(current, plan.action, seen);
        }

        if (plan.action.kind === "fill") {
            return plan.value === undefined
                ? { ok: false, error: "fill needs a value from --inputs", dispatched: false }
                : current.fill(plan.action, plan.value);
        }

        if (plan.action.href !== undefined && leavesOrigin(url, plan.action.href)) {
            return {
                ok: false,
                error: `click refused: ${plan.action.href} leaves the origin of ${url}`,
                dispatched: false,
            };
        }

        return plan.action.kind === "select" ? current.select(plan.action) : current.click(plan.action);
    };

    return {
        kind: "browser",
        async see() {
            const current = await ensurePage();
            const snapshot = await prof.measureAsync("dom-see", () => current.snapshot());
            const id = `dom:${options.port}:${snapshot.marker}`;
            const label = snapshot.title ? `${snapshot.title} — ${snapshot.url}` : snapshot.url;
            // Every shown secret field on the page, not only the visible rows: a password field below
            // the fold or past the action cap still means the page wants a secret we do not carry.
            const wall = passwordWall(snapshot.secretFields, inputs);
            if (wall.hit) {
                log.warn(
                    { url: snapshot.url, fields: wall.fields },
                    "password wall: the page asks for a secret that --inputs does not carry; offering no candidates"
                );
                return {
                    id,
                    label,
                    candidates: [],
                    evidence: { passwordWall: true, fields: wall.fields, url: snapshot.url },
                };
            }

            const plans = new Map<string, Plan>();
            const candidates = rowsFor({
                snapshot,
                inputs,
                goalUrl: options.url,
                plans,
                writer: Boolean(options.writer),
            });
            tables.delete(id);
            tables.set(id, { url: snapshot.url, plans, snapshot });
            for (const stale of [...tables.keys()].slice(0, Math.max(0, tables.size - KEPT_TABLES))) {
                tables.delete(stale);
            }

            log.info(
                {
                    url: snapshot.url,
                    actions: snapshot.actions.length,
                    omitted: snapshot.omitted,
                    candidates: candidates.length,
                },
                "browser surface snapshot"
            );
            return {
                id,
                label,
                candidates,
                evidence: {
                    url: snapshot.url,
                    title: snapshot.title,
                    text: snapshot.text,
                    nodes: snapshot.actions.map(evidenceRow),
                    ...(snapshot.omitted > 0 ? { omittedActions: snapshot.omitted } : {}),
                    ...(snapshot.belowFold > 0
                        ? { belowFold: snapshot.belowFold, below_the_fold: snapshot.belowFoldLabels }
                        : {}),
                },
            };
        },
        async act(snapshot: SurfaceSnapshot, candidate: SurfaceCandidate) {
            // The auto surface hands over its merged snapshot: its rows carry a `cdp:` prefix and its
            // id ends with this page snapshot's id. Node ids restart on every document, so the plan
            // must come from the table of the snapshot the loop saw, never from a newer page.
            const offered = snapshot.candidates.some(
                (item) => item.id === candidate.id || stripCandidatePrefix(item.id).id === candidate.id
            );
            const seen = [...tables.entries()].find(([id]) => snapshot.id === id || snapshot.id.endsWith(`:${id}`));
            const plan = offered ? seen?.[1].plans.get(candidate.id) : undefined;
            if (!seen || !plan) {
                return { ok: false, error: "Candidate is outside the current page snapshot." };
            }

            const table = seen[1];

            const current = await ensurePage();
            log.info(
                {
                    id: candidate.id,
                    kind: plan.kind === "chrome" ? plan.verb : plan.action.kind,
                    label: candidate.label.slice(0, 120),
                    url: table.url,
                },
                "browser surface act"
            );
            const result = await prof.measureAsync("dom-act", () => run(current, plan, table.url, table.snapshot));
            if (!result.ok) {
                log.warn(
                    { id: candidate.id, error: result.error, dispatched: result.dispatched },
                    "browser act refused"
                );
                return { ok: false, error: result.error };
            }

            if (result.screen) {
                overlay(result.screen);
            }

            log.debug({ id: candidate.id, settled: result.settled }, "browser act settled");
            return { ok: true };
        },
        async close() {
            page?.close();
            page = undefined;
        },
    };
}
