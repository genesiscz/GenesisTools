import type { CodeViewItemScrollTarget, CodeViewLineScrollTarget } from "@pierre/diffs";

/**
 * The page's half of a review window's saved state (Sources/Review/ReviewSessionState.swift): where the
 * reader is (the first visible line, as a file id and a line, never a pixel offset) and the text typed
 * into reply, edit and comment boxes that was not sent yet.
 *
 * Page -> Swift: webkit.messageHandlers.genesisReviewState.postMessage({ type: "ready" | "state", ... }),
 * a state report at most once per {@link REPORT_DELAY_MS} after a scroll, a keystroke or a click.
 * Swift -> page: window.genesisReviewState.restore(state), once the page is ready. A part that cannot
 * land yet (its file or thread is not on the page) waits, and the reports carry it meanwhile, so a save
 * before it lands never loses it.
 */

type Side = "additions" | "deletions";

export interface SavedAnchor {
    fileId: string;
    line: number | null;
    side: Side | null;
}

export interface SavedBox {
    threadId: string;
    kind: "reply" | "edit";
    noteId: string | null;
    body: string;
}

export interface SavedComposer {
    fileId: string;
    side: Side;
    startLine: number;
    endLine: number;
    editingId: string | null;
    body: string;
}

export interface SavedPageState {
    anchor: SavedAnchor | null;
    boxes: SavedBox[];
    composer: SavedComposer | null;
}

interface BoxLike {
    kind: "reply" | "edit";
    noteId?: string;
    body: string;
    sending: boolean;
}

interface ComposerLike {
    fileId: string;
    side: Side;
    startLine: number;
    endLine: number;
    editingId: string | null;
    body: string;
}

interface ViewerLike {
    getScrollTop(): number;
    getTopForItem(id: string): number | undefined;
    getItem(id: string): unknown;
    getRenderedItems(): { id: string; element: HTMLElement }[];
    scrollTo(target: CodeViewLineScrollTarget | CodeViewItemScrollTarget): void;
    render(immediate?: boolean): void;
}

export interface ReviewStateDeps {
    host: HTMLElement;
    viewer: ViewerLike;
    files: () => readonly { id: string }[];
    comments: () => readonly { id: string; fileId: string }[];
    threadBoxes: Map<string, BoxLike>;
    composer: () => ComposerLike | null;
    setComposer: (next: ComposerLike) => void;
    refresh: (fileIds: string[]) => void;
    /** A line for app-perf.log. */
    log?: (message: string) => void;
}

/** What main.ts calls from its bridge, so a restore lands once the files and threads it needs arrive. */
export interface ReviewStateHooks {
    /** Before a refresh of the same diff replaces its files: note the line on screen to keep it there. */
    beforeRefresh(): void;
    afterFiles(last: boolean): void;
    afterComments(): void;
    changed(): void;
}

interface StateHandler {
    postMessage(message: unknown): void;
}

declare global {
    interface Window {
        genesisReviewState?: { restore(state: SavedPageState): void };
    }
}

const REPORT_DELAY_MS = 700;
/** A restored box whose thread never shows up (resolved and gone meanwhile) stops riding along after this. */
const PENDING_BOX_TTL_MS = 60_000;

function stateHandler(): StateHandler | null {
    const handlers: unknown = window.webkit?.messageHandlers;

    if (typeof handlers !== "object" || handlers === null || !("genesisReviewState" in handlers)) {
        return null;
    }

    const handler: unknown = handlers.genesisReviewState;

    if (
        typeof handler === "object" &&
        handler !== null &&
        "postMessage" in handler &&
        typeof handler.postMessage === "function"
    ) {
        const postMessage = handler.postMessage;
        return { postMessage: (message) => postMessage.call(handler, message) };
    }

    return null;
}

/** The index of the last file whose top is at or above `top`, files being in page order. */
export function fileAtTop(tops: readonly number[], top: number): number {
    let low = 0;
    let high = tops.length - 1;
    let found = 0;

    while (low <= high) {
        const middle = (low + high) >> 1;

        if (tops[middle] <= top + 1) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }

    return found;
}

export function installReviewState(deps: ReviewStateDeps): ReviewStateHooks {
    const { host, viewer } = deps;
    const handler = stateHandler();
    let pendingAnchor: SavedAnchor | null = null;
    let pendingBoxes: SavedBox[] = [];
    let pendingBoxesUntil = 0;
    let pendingComposer: SavedComposer | null = null;
    let reportTimer = 0;

    /** The line on screen when a refresh began, with how far its top sat above the viewport's top. */
    let refreshAnchor: { anchor: SavedAnchor; offset: number } | null = null;

    function firstVisibleLine(fileId: string): { line: number; side: Side; offset: number } | null {
        const rendered = viewer.getRenderedItems().find((item) => item.id === fileId);

        if (!rendered) {
            return null;
        }

        const root: ParentNode = rendered.element.shadowRoot ?? rendered.element;
        const hostTop = host.getBoundingClientRect().top;
        let best: { top: number; line: number; side: Side } | null = null;

        for (const el of root.querySelectorAll<HTMLElement>("[data-line]")) {
            const rect = el.getBoundingClientRect();
            const line = Number(el.dataset.line);

            if (rect.height === 0 || rect.bottom <= hostTop + 1 || !Number.isFinite(line)) {
                continue;
            }

            const side: Side = (el.dataset.lineType ?? "").includes("deletion") ? "deletions" : "additions";
            const higher = !best || rect.top < best.top - 0.5;
            const sameRowNewSide =
                best !== null &&
                Math.abs(rect.top - best.top) < 0.5 &&
                best.side === "deletions" &&
                side === "additions";

            if (higher || sameRowNewSide) {
                best = { top: rect.top, line, side };
            }
        }

        return best ? { line: best.line, side: best.side, offset: best.top - hostTop } : null;
    }

    /** Where one line of a drawn file sits, relative to the viewport's top; null when it is not drawn. */
    function lineOffset(fileId: string, line: number, side: Side): number | null {
        const rendered = viewer.getRenderedItems().find((item) => item.id === fileId);

        if (!rendered) {
            return null;
        }

        const root: ParentNode = rendered.element.shadowRoot ?? rendered.element;
        const hostTop = host.getBoundingClientRect().top;
        let fallback: number | null = null;

        for (const el of root.querySelectorAll<HTMLElement>(`[data-line="${line}"]`)) {
            const rect = el.getBoundingClientRect();

            if (rect.height === 0) {
                continue;
            }

            const elSide: Side = (el.dataset.lineType ?? "").includes("deletion") ? "deletions" : "additions";

            if (elSide === side) {
                return rect.top - hostTop;
            }

            fallback ??= rect.top - hostTop;
        }

        return fallback;
    }

    function captureAnchor(): SavedAnchor | null {
        const files = deps.files();

        if (files.length === 0) {
            return null;
        }

        const tops = files.map((file) => viewer.getTopForItem(file.id) ?? 0);
        const fileId = files[fileAtTop(tops, viewer.getScrollTop())].id;
        const line = firstVisibleLine(fileId);
        return { fileId, line: line?.line ?? null, side: line?.side ?? null };
    }

    function capture(): SavedPageState {
        const boxes: SavedBox[] = [];

        for (const [threadId, box] of deps.threadBoxes) {
            if (!box.sending && box.body.trim() !== "") {
                boxes.push({ threadId, kind: box.kind, noteId: box.noteId ?? null, body: box.body });
            }
        }

        if (pendingBoxes.length > 0 && Date.now() > pendingBoxesUntil) {
            pendingBoxes = [];
        }

        const live = new Set(boxes.map((box) => box.threadId));
        boxes.push(...pendingBoxes.filter((box) => !live.has(box.threadId)));
        const current = deps.composer();
        const composer =
            current && current.body.trim() !== ""
                ? {
                      fileId: current.fileId,
                      side: current.side,
                      startLine: current.startLine,
                      endLine: current.endLine,
                      editingId: current.editingId,
                      body: current.body,
                  }
                : pendingComposer;

        return { anchor: pendingAnchor ?? captureAnchor(), boxes, composer };
    }

    function report(): void {
        reportTimer = 0;
        handler?.postMessage({ type: "state", ...capture() });
    }

    function scheduleReport(): void {
        if (!handler) {
            return;
        }

        window.clearTimeout(reportTimer);
        reportTimer = window.setTimeout(report, REPORT_DELAY_MS);
    }

    /**
     * A refresh swaps every file for a fresh copy with fresh height estimates, so the old scroll offset
     * lands on other code: a live agent's write moved the reader several files up in the middle of a
     * fast scroll (recording 2026-10-08 02:01). The same line goes back to the same pixel instead.
     */
    function applyRefreshAnchor(): void {
        const saved = refreshAnchor;
        refreshAnchor = null;

        if (!saved || !viewer.getItem(saved.anchor.fileId)) {
            return;
        }

        const { anchor, offset } = saved;

        if (anchor.line === null) {
            viewer.scrollTo({ type: "item", id: anchor.fileId, align: "start", behavior: "instant" });
            viewer.render(true);
            return;
        }

        viewer.scrollTo({
            type: "line",
            id: anchor.fileId,
            lineNumber: anchor.line,
            side: anchor.side ?? "additions",
            align: "start",
            behavior: "instant",
        });
        viewer.render(true);
        const side = anchor.side ?? "additions";
        const now = lineOffset(anchor.fileId, anchor.line, side);

        if (now !== null) {
            host.scrollTop += now - offset;
        }

        const landed = lineOffset(anchor.fileId, anchor.line, side);
        deps.log?.(
            `diff.refresh kept ${anchor.fileId.split("/").pop()}:${anchor.line} at ${Math.round(offset)}px; after the swap ${now === null ? "not drawn" : `${Math.round(now)}px`}, landed ${landed === null ? "not drawn" : `${Math.round(landed)}px`}`
        );
    }

    function applyAnchor(last: boolean): void {
        if (last && refreshAnchor) {
            applyRefreshAnchor();
        }

        if (!pendingAnchor) {
            return;
        }

        const anchor = pendingAnchor;

        if (!viewer.getItem(anchor.fileId)) {
            // The file left the diff: once the whole set is here, the place it named is gone.
            if (last) {
                pendingAnchor = null;
            }

            return;
        }

        pendingAnchor = null;

        if (anchor.line !== null) {
            viewer.scrollTo({
                type: "line",
                id: anchor.fileId,
                lineNumber: anchor.line,
                side: anchor.side ?? "additions",
                align: "start",
                behavior: "instant",
            });
        } else {
            viewer.scrollTo({ type: "item", id: anchor.fileId, align: "start", behavior: "instant" });
        }

        viewer.render(true);
    }

    function applyComposer(): void {
        if (!pendingComposer || deps.composer() || !viewer.getItem(pendingComposer.fileId)) {
            return;
        }

        const saved = pendingComposer;
        pendingComposer = null;
        deps.setComposer({ ...saved });
        deps.refresh([saved.fileId]);
    }

    function applyBoxes(): void {
        if (pendingBoxes.length === 0) {
            return;
        }

        const cards = new Map(deps.comments().map((comment) => [comment.id, comment.fileId]));
        const touched: string[] = [];
        pendingBoxes = pendingBoxes.filter((box) => {
            const fileId = cards.get(box.threadId);

            if (fileId === undefined) {
                return true;
            }

            if (!deps.threadBoxes.has(box.threadId)) {
                deps.threadBoxes.set(box.threadId, {
                    kind: box.kind,
                    noteId: box.noteId ?? undefined,
                    body: box.body,
                    sending: false,
                });
                touched.push(fileId);
            }

            return false;
        });

        if (touched.length > 0) {
            deps.refresh(touched);
            viewer.render(true);
        }
    }

    window.genesisReviewState = {
        restore(state) {
            pendingAnchor = state.anchor;
            pendingBoxes = state.boxes;
            pendingBoxesUntil = Date.now() + PENDING_BOX_TTL_MS;
            pendingComposer = state.composer;
            applyAnchor(false);
            applyComposer();
            applyBoxes();
        },
    };

    host.addEventListener("scroll", scheduleReport, { passive: true });

    // Typing, Esc and ⌘↩ in a box, and the buttons that send or drop one. `input` is composed, so it
    // reaches here from inside the diff's shadow roots too.
    for (const type of ["input", "keydown", "click"]) {
        document.addEventListener(type, scheduleReport, { capture: true, passive: true });
    }

    handler?.postMessage({ type: "ready" });

    return {
        beforeRefresh() {
            if (pendingAnchor || deps.files().length === 0) {
                deps.log?.(`diff.refresh no anchor kept (${pendingAnchor ? "a restore is pending" : "no files yet"})`);
                return;
            }

            const anchor = captureAnchor();
            const line = anchor ? firstVisibleLine(anchor.fileId) : null;
            refreshAnchor = anchor ? { anchor, offset: line?.offset ?? 0 } : null;
            const hostTop = host.getBoundingClientRect().top;
            deps.log?.(
                `diff.refresh scrollTop ${Math.round(viewer.getScrollTop())}, drawn ${viewer
                    .getRenderedItems()
                    .map((item) => {
                        const rect = item.element.getBoundingClientRect();
                        return `${item.id.split("/").pop()} ${Math.round(rect.top - hostTop)}..${Math.round(rect.bottom - hostTop)} (top ${Math.round(viewer.getTopForItem(item.id) ?? -1)})`;
                    })
                    .join(", ")}`
            );
        },
        afterFiles(last) {
            applyAnchor(last);
            applyComposer();
        },
        afterComments() {
            applyBoxes();
        },
        changed() {
            scheduleReport();
        },
    };
}
