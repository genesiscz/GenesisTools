import {
    CodeView,
    type CodeViewItem,
    type CodeViewItemScrollTarget,
    type CodeViewLineScrollTarget,
    type CodeViewOptions,
    type DiffLineAnnotation,
    type FileDiffMetadata,
    type LineAnnotation,
    type OnDiffLineClickProps,
    type OnDiffLineEnterLeaveProps,
    type OnLineClickProps,
    type OnLineEnterLeaveProps,
    type SelectedLineRange,
} from "@pierre/diffs";
import { WorkerPoolManager } from "@pierre/diffs/worker";
import { parseFileDiff } from "./file-diff";

/**
 * The web half of GenesisTools.app's diff renderer (PierreWebDiffRenderer.swift). Swift owns the
 * data, the comment store and the chrome; this page draws file diffs with @pierre/diffs, hosts the
 * comment composer and the comment cards, and reports every user action back.
 * Swift -> page: window.genesisDiff.addFiles / setComments / setOptions / reveal / find.
 * Page -> Swift: webkit.messageHandlers.genesisDiff.postMessage({ type, ... }).
 *
 * Every file of the diff is on the page, however large the diff: CodeView lays out only the files
 * and lines near the viewport and keeps the scroll height from each file's line counts.
 */

type Side = "additions" | "deletions";

interface BridgeFile {
    id: string;
    path: string;
    oldPath: string | null;
    oldContents: string | null;
    newContents: string | null;
    /** Changes when either side's text changes: an unchanged file keeps its parsed diff and its item. */
    key: string;
}

/** What the page keeps of a file once its diff is parsed: the text lives in the parsed diff only. */
interface ShownFile {
    id: string;
    path: string;
}

/**
 * Swift sends a file set in batches, each after the page ran the one before. An empty page (the
 * first set, a reloaded page) shows each batch as it lands; a set that replaces a shown one swaps in
 * whole at the last batch and never shows half a list. `fresh` (a new scope) then starts at the top;
 * a refresh of the same diff keeps its scroll position.
 */
interface FilesBatch {
    generation: number;
    fresh: boolean;
    first: boolean;
    last: boolean;
    total: number;
    files: BridgeFile[];
}

interface BridgeComment {
    id: string;
    fileId: string;
    side: Side;
    startLine: number;
    endLine: number;
    body: string;
    author: string;
    when: string;
    /** local/sent/draft/posted for your comments; proposed/accepted/edited/rejected/drafted/posted for agent drafts. */
    state: string;
    remote: boolean;
    /**
     * "draft" = an agent's proposed review comment with its analysis in `meta`.
     * "thread" = a thread already on the PR, with the agent's read of it in `meta`; with `live` it
     * shows every note and gets Reply, Resolve, and Edit / Delete on my drafts.
     */
    kind?: "local" | "draft" | "thread";
    severity?: string;
    meta?: { verdict: string; proof?: string; confidence?: number; reasoning?: string; fix?: string };
    /** A PR thread's suggested reply (the agent's, or Martin's rewording) and where it went. */
    reply?: string;
    replyStatus?: string;
    /** The live thread on the PR (`tools hub pr threads`): its notes, and which buttons the card gets. */
    live?: LiveThread;
}

interface LiveNote {
    id: string;
    author: string;
    username: string;
    /** "2 hr. ago"; `at` is the ISO time for the tooltip. */
    when: string;
    at: string;
    body: string;
    /** My pending review comment: Edit and Delete. */
    isDraft: boolean;
    edited: boolean;
    /** The author's profile on the host; the name links there when set. */
    authorUrl?: string;
}

interface LiveThread {
    notes: LiveNote[];
    resolved: boolean;
    resolvable: boolean;
    canReply: boolean;
}

/** A thread card's open reply box or note edit. It survives re-renders, and `sending` holds it until Swift's `threadDone`. */
interface ThreadBox {
    kind: "reply" | "edit";
    noteId?: string;
    body: string;
    sending: boolean;
}

interface BridgeOptions {
    diffStyle: "split" | "unified";
    themeType: "dark" | "light" | "system";
    wrap: boolean;
    fontSize: number;
}

interface Composer {
    fileId: string;
    side: Side;
    startLine: number;
    endLine: number;
    editingId: string | null;
    body: string;
}

type AnnotationMeta = { kind: "comments"; comments: BridgeComment[] } | { kind: "composer"; composer: Composer };

/** The part of pierre's per-item callback context this page reads; both item kinds carry an id. */
interface ItemContext {
    item: { id: string };
}

function openOnCommandClick(click: OnLineClickProps | OnDiffLineClickProps, context: ItemContext): void {
    // ⌘-click opens the line in the editor; a plain click stays a selection.
    if (click.event.metaKey) {
        post({
            type: "open",
            fileId: context.item.id,
            line: click.lineNumber,
            side: click.type === "diff-line" ? click.annotationSide : "additions",
        });
    }
}

interface BridgeApi {
    addFiles(batch: FilesBatch): void;
    setComments(comments: BridgeComment[]): void;
    /** Swift ran (or refused) a thread action: `ok` closes the card's box, else it stays for another try. */
    threadDone(result: { id: string; ok: boolean }): void;
    setOptions(next: Partial<BridgeOptions>): void;
    reveal(id: string): void;
    /** ⌘F from Swift (the header button, or ⌘F while the diff has the keyboard): open the find bar. */
    find(): void;
    /** The PR threads picked for "Fix threads" (the cards' checkboxes). */
    setSelection(ids: string[]): void;
    /** j / k: scroll to this card and mark it; `reply` also opens its reply box (r). Null clears the mark. */
    focusThread(target: { id: string | null; reply?: boolean }): void;
    /** The key list (? on the page, or a snapshot's `--keys`). */
    showKeys(show: boolean): void;
    /** Which agent session and turn wrote each new line (`tools agents blame`): a hover shows it. */
    setBlame(next: BlameData): void;
    /** A snapshot's `--blame <path>:<line>`: the tip of that line without a pointer. */
    showBlameAt(target: { fileId: string; line: number }): void;
}

interface WebkitBridge {
    messageHandlers?: { genesisDiff?: { postMessage(message: unknown): void } };
}

declare global {
    interface Window {
        webkit?: WebkitBridge;
        genesisDiff: BridgeApi;
    }
}

function post(message: Record<string, unknown>): void {
    window.webkit?.messageHandlers?.genesisDiff?.postMessage(message);
}

/** A function, not an `if` at the top: TypeScript keeps no narrowing inside hoisted function declarations. */
function requireHost(): HTMLElement {
    const root = document.getElementById("review");

    if (!root) {
        throw new Error("diff viewer: #review host is missing");
    }

    return root;
}

const host = requireHost();

let options: BridgeOptions = { diffStyle: "split", themeType: "system", wrap: false, fontSize: 13 };

// @pierre/diffs draws its "N unmodified lines" expanders as role=button with no name, so VoiceOver and
// `tools control` saw bare AXButtons. Name them, in the host and in every shadow root the viewer opens,
// at most once per animation frame however many rows virtualization adds.
// A root whose host left the viewer (a file switch, a virtualized row) is dropped at the next pass:
// its observer is disconnected and its entry deleted, so the map never pins a detached shadow root.
// If the host comes back, the scan of a connected root finds it and watches it again.
const labelRoots = new Map<ParentNode & Node, MutationObserver>();
let labelFrame = 0;

function expanderLabel(el: Element): string {
    if (el.hasAttribute("data-expand-all-button")) {
        return "Expand all unmodified lines";
    }

    if (el.hasAttribute("data-expand-up")) {
        return "Show unmodified lines above";
    }

    if (el.hasAttribute("data-expand-down")) {
        return "Show unmodified lines below";
    }

    return "Show unmodified lines";
}

function labelExpanders(root: ParentNode): void {
    for (const el of root.querySelectorAll("[data-expand-button]:not([aria-label])")) {
        el.setAttribute("aria-label", expanderLabel(el));
    }

    for (const el of root.querySelectorAll("*")) {
        const shadow = el.shadowRoot;

        if (shadow && !labelRoots.has(shadow)) {
            watchRoot(shadow);
        }
    }
}

function scheduleLabels(): void {
    if (labelFrame !== 0) {
        return;
    }

    labelFrame = requestAnimationFrame(() => {
        labelFrame = 0;
        for (const [root, observer] of labelRoots) {
            if (!root.isConnected) {
                observer.disconnect();
                labelRoots.delete(root);
                continue;
            }

            labelExpanders(root);
        }
    });
}

function watchRoot(root: ParentNode & Node): void {
    const observer = new MutationObserver(scheduleLabels);
    labelRoots.set(root, observer);
    observer.observe(root, { childList: true, subtree: true });
    labelExpanders(root);
}

watchRoot(host);
let files: ShownFile[] = [];
let comments: BridgeComment[] = [];
let composer: Composer | null = null;
/** Per thread card id: the reply box or note edit in progress. */
const threadBoxes = new Map<string, ThreadBox>();
/** Thread cards waiting for Swift (a resolve, a delete): their buttons are off until `threadDone`. */
const busyThreads = new Set<string>();
/** Resolved threads fold to one line, like GitLab's; these were opened by a click. */
const expandedThreads = new Set<string>();
/** Long note bodies fold at a fixed height; these were opened with "Show all". */
const expandedNotes = new Set<string>();
/** PR thread ids picked for "Fix threads" (Swift owns the set; `setSelection` replaces it). */
const selectedThreads = new Set<string>();
/** The card j / k moved to (`focusThread`): it gets a mark, and r / e act on it. */
let focusedCard: string | null = null;
const versions = new Map<string, number>();

function nextVersion(id: string): number {
    const version = (versions.get(id) ?? -1) + 1;
    versions.set(id, version);
    return version;
}

function sideOf(side: string | undefined): Side {
    return side === "deletions" ? "deletions" : "additions";
}

// A click on a file's header row folds the file; ⌘-click opens it in the editor instead. Folded
// files are remembered by path, so a new file list from Swift (a scope switch, a refresh) keeps them.
const folded = new Set<string>();

/** The header's fold chevron: shows the state, names the header for VoiceOver and `tools control`. */
function foldChevron(path: string): HTMLElement {
    const isFolded = folded.has(path);
    const chevron = document.createElement("span");
    chevron.setAttribute("data-gt-fold", path);
    chevron.setAttribute("role", "button");
    chevron.setAttribute("aria-label", `${isFolded ? "Unfold" : "Fold"} ${path}`);
    chevron.setAttribute("aria-expanded", String(!isFolded));
    chevron.title = isFolded ? "Click the file row to unfold it" : "Click the file row to fold it; ⌘-click opens it";
    chevron.textContent = isFolded ? "▸" : "▾";
    chevron.style.cssText =
        "display:inline-block;width:14px;margin-right:4px;opacity:.7;cursor:pointer;user-select:none";
    return chevron;
}

function toggleFold(path: string): void {
    if (folded.has(path)) {
        folded.delete(path);
    } else {
        folded.add(path);
    }

    const file = files.find((candidate) => candidate.path === path);
    const item = file ? viewer.getItem(file.id) : undefined;

    if (file && item && item.type === "diff") {
        viewer.updateItem({ ...item, collapsed: folded.has(path), version: nextVersion(file.id) });
    }
}

/** The file path of the header row a click landed on, or null when it was not on a header. */
function headerPathOf(event: MouseEvent): string | null {
    for (const node of event.composedPath()) {
        if (!(node instanceof Element)) {
            continue;
        }

        // A control inside the header (a link, a button of its own) keeps its own click.
        if (node.matches("a, button, input, textarea, select")) {
            return null;
        }

        if (node.hasAttribute("data-diffs-header")) {
            const root = node.getRootNode();
            const itemHost = root instanceof ShadowRoot ? root.host : node;
            return itemHost.querySelector("[data-gt-fold]")?.getAttribute("data-gt-fold") ?? null;
        }
    }

    return null;
}

function openComposer(fileId: string, range: SelectedLineRange): void {
    const previous = composer?.fileId;
    composer = {
        fileId,
        side: sideOf(range.endSide ?? range.side),
        startLine: Math.min(range.start, range.end),
        endLine: Math.max(range.start, range.end),
        editingId: null,
        body: "",
    };
    refreshAnnotations(previous ? [previous, fileId] : [fileId]);
}

const themes = { light: "pierre-light", dark: "pierre-dark" } as const;

function viewOptions(): CodeViewOptions<AnnotationMeta, undefined> {
    return {
        theme: themes,
        themeType: options.themeType,
        diffStyle: options.diffStyle,
        overflow: options.wrap ? "wrap" : "scroll",
        stickyHeaders: true,
        lineDiffType: "word-alt",
        hunkSeparators: "line-info",
        lineHoverHighlight: "both",
        enableGutterUtility: true,
        enableLineSelection: true,
        // No top inset: the files run edge to edge with the pane, like the file list beside them.
        layout: { paddingTop: 0, paddingBottom: 32, gap: 12 },
        // About 280 ms to settle (pierre's default is 440): a click in the file list glides, but briefly.
        smoothScrollSettings: { omega: 0.024, positionEpsilon: 0.5, velocityEpsilon: 0.05 },
        onLineClick: openOnCommandClick,
        onLineNumberClick: openOnCommandClick,
        onLineEnter(enter: OnLineEnterLeaveProps | OnDiffLineEnterLeaveProps, context: ItemContext) {
            blameEnter(enter, context.item.id);
        },
        onLineLeave() {
            blameLeave();
        },
        onGutterUtilityClick(range: SelectedLineRange, context: ItemContext) {
            openComposer(context.item.id, range);
        },
        onLineSelectionEnd(range: SelectedLineRange | null, context: ItemContext) {
            if (range && range.start !== range.end) {
                openComposer(context.item.id, range);
            }
        },
        renderAnnotation(annotation: LineAnnotation<AnnotationMeta> | DiffLineAnnotation<AnnotationMeta>) {
            return renderAnnotation(annotation.metadata);
        },
        renderHeaderPrefix(fileDiff) {
            return foldChevron(fileDiff.name);
        },
    };
}

/**
 * Syntax highlighting runs in workers, off the page's main thread. On the page it froze a fast
 * scroll whenever a new language or a long file came into view: 1337 ms for a 870-line HTML file
 * (HTML carries the CSS and JS grammars), 220 ms for a lockfile (Playwright WebKit, 2057 files).
 * With workers the lines show plain at once and take their colours when the worker answers.
 * The worker is pierre's self-contained build, copied next to this page by the app build
 * (`buildDiffViewer`); it runs from a Blob URL so no worker is ever loaded through the custom scheme.
 * Without it the page highlights on its own thread, as before.
 */
async function createHighlightWorkers(): Promise<WorkerPoolManager | undefined> {
    try {
        const response = await fetch(new URL("./pierre-worker.js", import.meta.url));

        if (!response.ok) {
            throw new Error(`pierre-worker.js: HTTP ${response.status}`);
        }

        const url = URL.createObjectURL(new Blob([await response.text()], { type: "text/javascript" }));
        return new WorkerPoolManager(
            { workerFactory: () => new Worker(url), poolSize: 3 },
            { theme: themes, lineDiffType: "word-alt" }
        );
    } catch (error) {
        post({
            type: "log",
            message: `diff.workers off, highlighting on the page: ${error instanceof Error ? error.message : String(error)}`,
        });
        return undefined;
    }
}

const highlightWorkers = await createHighlightWorkers();
const viewer = new CodeView<AnnotationMeta, undefined>(viewOptions(), highlightWorkers);
viewer.setup(host);

// CodeView draws nothing until the pool says it is ready, and the pool says so on an animation
// frame. A hidden page (a covered or minimized window, a `--snapshot` run) gets no frames, so the
// first files never drew there (the hub's Worktrees snapshot stayed blank). Draw when the pool is
// up instead; after a failure CodeView falls back to highlighting on the page.
highlightWorkers
    ?.initialize()
    .catch((error: unknown) => {
        post({
            type: "log",
            message: `diff.workers failed to start: ${error instanceof Error ? error.message : String(error)}`,
        });
    })
    .finally(() => viewer.render(true));

host.addEventListener("click", (event) => {
    const path = headerPathOf(event);

    if (path === null) {
        return;
    }

    const file = files.find((candidate) => candidate.path === path);

    if (event.metaKey) {
        if (file) {
            post({ type: "open", fileId: file.id, line: 1, side: "additions" });
        }

        return;
    }

    event.preventDefault();
    toggleFold(path);
    post({ type: "log", message: `diff.fold ${folded.has(path) ? "folded" : "unfolded"} ${path}` });
});

function annotationsFor(fileId: string): DiffLineAnnotation<AnnotationMeta>[] {
    const grouped = new Map<string, BridgeComment[]>();

    for (const comment of comments) {
        if (comment.fileId !== fileId || composer?.editingId === comment.id) {
            continue;
        }

        const key = `${comment.side}:${comment.endLine}`;
        grouped.set(key, [...(grouped.get(key) ?? []), comment]);
    }

    const annotations: DiffLineAnnotation<AnnotationMeta>[] = [...grouped.values()].map((group) => ({
        side: group[0].side,
        lineNumber: group[0].endLine,
        metadata: { kind: "comments", comments: group },
    }));

    if (composer && composer.fileId === fileId) {
        annotations.push({
            side: composer.side,
            lineNumber: composer.endLine,
            metadata: { kind: "composer", composer },
        });
    }

    return annotations;
}

/** Parsed diffs by file id, with the key of the text they came from. A refresh re-parses only what changed. */
const parsed = new Map<string, { key: string; fileDiff: FileDiffMetadata }>();

function toItem(file: BridgeFile): CodeViewItem<AnnotationMeta> {
    const cached = parsed.get(file.id);
    const existing = viewer.getItem(file.id);

    // Same text, same item: CodeView keeps its layout and its rendered rows (annotations follow setComments).
    if (cached?.key === file.key && existing?.type === "diff") {
        return existing;
    }

    let fileDiff = cached?.key === file.key ? cached.fileDiff : undefined;

    if (!fileDiff) {
        fileDiff = parseFileDiff(file);
        parsed.set(file.id, { key: file.key, fileDiff });
    }

    return {
        id: file.id,
        type: "diff",
        fileDiff,
        annotations: annotationsFor(file.id),
        collapsed: folded.has(file.path),
        version: nextVersion(file.id),
    };
}

function refreshAnnotations(fileIds: string[]): void {
    for (const id of new Set(fileIds)) {
        const item = viewer.getItem(id);

        if (item && item.type === "diff") {
            viewer.updateItem({ ...item, annotations: annotationsFor(id), version: nextVersion(id) });
        }
    }
}

// MARK: comment cards

const css = {
    card: "margin:6px 12px 10px 12px;border:1px solid rgba(255,255,255,.10);border-radius:10px;background:#16171a;font:13px/1.45 -apple-system,BlinkMacSystemFont,sans-serif;color:#e6e6e6;overflow:hidden;white-space:normal",
    row: "display:flex;gap:10px;padding:10px 12px",
    avatar: "flex:none;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12px;color:#111",
    head: "display:flex;align-items:center;gap:6px;flex-wrap:wrap",
    name: "font-weight:600",
    dim: "color:rgba(255,255,255,.45);font-size:12px",
    badge: "font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid rgba(255,255,255,.15);color:rgba(255,255,255,.7)",
    body: "margin-top:3px;word-wrap:break-word",
    code: "font:12px ui-monospace,SFMono-Regular,Menlo,monospace;background:rgba(255,255,255,.08);padding:1px 5px;border-radius:5px",
    actions: "display:flex;gap:4px;margin-left:auto",
    button: "font:12px -apple-system,sans-serif;color:rgba(255,255,255,.75);background:transparent;border:1px solid rgba(255,255,255,.12);border-radius:7px;padding:3px 9px;cursor:pointer",
    primary:
        "font:12px -apple-system,sans-serif;font-weight:600;color:#111;background:#ffa11f;border:0;border-radius:7px;padding:4px 11px;cursor:pointer",
    textarea:
        "width:100%;box-sizing:border-box;min-height:70px;resize:vertical;background:#0e0f11;color:#eee;border:1px solid rgba(255,255,255,.15);border-radius:8px;padding:8px;font:13px/1.45 -apple-system,sans-serif;outline:none",
};

const stateLabel: Record<string, string> = {
    local: "Local",
    sent: "Sent to agent",
    draft: "Review draft",
    posted: "Posted",
    proposed: "Proposed",
    accepted: "Accepted",
    edited: "Edited",
    rejected: "Rejected",
    drafted: "Review draft on PR",
    open: "Open",
    resolved: "Resolved",
};

const severityStyle: Record<string, { label: string; color: string }> = {
    blocker: { label: "🛑 blocker", color: "#f5616a" },
    major: { label: "⚠️ should fix", color: "#ffa11f" },
    minor: { label: "minor", color: "#c9b458" },
    nit: { label: "nit", color: "#8a8f98" },
    question: { label: "❓ question", color: "#8ab4ff" },
    praise: { label: "praise", color: "#5ccb78" },
};

/** The agent's analysis stuck to the same lines as its draft: verdict, proof, confidence, reasoning. */
function renderMeta(meta: NonNullable<BridgeComment["meta"]>): HTMLElement {
    const box = element(
        "div",
        "margin:0 12px 10px 48px;border:1px dashed rgba(138,180,255,.35);border-radius:8px;padding:8px 10px;background:rgba(138,180,255,.05);font-size:12.5px"
    );
    const head = element("div", "display:flex;gap:8px;align-items:baseline;flex-wrap:wrap");
    head.appendChild(
        element("span", "font-size:10.5px;font-weight:700;letter-spacing:.6px;color:#8ab4ff", "AGENT ANALYSIS")
    );
    head.appendChild(element("span", "font-weight:600", meta.verdict));

    if (meta.confidence !== undefined) {
        head.appendChild(
            element("span", `${css.dim};font-family:ui-monospace,Menlo,monospace`, `[${meta.confidence}%]`)
        );
    }

    box.appendChild(head);

    if (meta.proof) {
        const proof = element("div", "margin-top:4px;color:rgba(255,255,255,.7)");
        proof.appendChild(element("span", css.dim, "Proof: "));
        proof.appendChild(richText(meta.proof));
        box.appendChild(proof);
    }

    if (meta.fix) {
        const fix = element("div", "margin-top:6px");
        fix.appendChild(element("div", `${css.dim};margin-bottom:3px`, "Proposed fix:"));
        fix.appendChild(fencedText(meta.fix));
        box.appendChild(fix);
    }

    if (meta.reasoning) {
        const details = document.createElement("details");
        details.setAttribute("style", "margin-top:4px;color:rgba(255,255,255,.65)");
        details.appendChild(element("summary", `${css.dim};cursor:pointer`, "Reasoning"));
        details.appendChild(richText(meta.reasoning));
        box.appendChild(details);
    }

    return box;
}

/** Markdown with ``` fences: fenced parts become code blocks, the rest stays rich text. */
function fencedText(text: string): HTMLElement {
    const box = element("div", "");
    text.split(/```[a-zA-Z]*\n?/).forEach((part, index) => {
        if (!part.trim()) {
            return;
        }

        if (index % 2 === 1) {
            box.appendChild(
                element(
                    "pre",
                    "margin:4px 0;padding:8px 10px;border-radius:7px;background:#0e0f11;border:1px solid rgba(255,255,255,.08);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#d6e2ff",
                    part.replace(/\n$/, "")
                )
            );
        } else {
            box.appendChild(richText(part.trim()));
        }
    });
    return box;
}

function renderDraft(comment: BridgeComment): HTMLElement {
    const wrap = element("div", comment.state === "rejected" ? "opacity:.45" : "");
    const row = element("div", css.row);
    row.appendChild(element("div", `${css.avatar};background:#8ab4ff`, "✦"));
    const main = element("div", "flex:1;min-width:0");
    const head = element("div", css.head);
    head.appendChild(element("span", css.name, comment.author));
    const severity = severityStyle[comment.severity ?? "minor"] ?? severityStyle.minor;
    head.appendChild(
        element("span", `${css.badge};border-color:${severity.color};color:${severity.color}`, severity.label)
    );
    const range =
        comment.startLine === comment.endLine ? `L${comment.endLine}` : `L${comment.startLine}–${comment.endLine}`;
    head.appendChild(element("span", css.dim, range));
    head.appendChild(element("span", css.badge, stateLabel[comment.state] ?? comment.state));
    const actions = element("div", css.actions);
    const act = (action: string) => () => post({ type: "comment.action", id: comment.id, action });

    const sent = comment.state === "sent" || comment.state === "drafted" || comment.state === "posted";

    if (comment.state === "rejected") {
        actions.appendChild(button("Restore", act("restore")));
    } else if (!sent) {
        actions.appendChild(
            button(
                "Edit",
                () => openComposerFor(comment, comment.id, comment.body),
                false,
                "Reword it before it goes anywhere"
            )
        );
        actions.appendChild(button("Reject", act("reject")));
    }

    head.appendChild(actions);
    main.appendChild(head);
    main.appendChild(richText(comment.body));

    if (comment.state !== "rejected" && !sent) {
        main.appendChild(sendRow(act, false));
    }

    row.appendChild(main);
    wrap.appendChild(row);

    if (comment.meta) {
        wrap.appendChild(renderMeta(comment.meta));
    }

    return wrap;
}

/** Rewords an existing draft or thread reply in place (`openComposer` starts a new comment on a range). */
function openComposerFor(comment: BridgeComment, editingId: string, body: string): void {
    const previous = composer?.fileId;
    composer = {
        fileId: comment.fileId,
        side: comment.side,
        startLine: comment.startLine,
        endLine: comment.endLine,
        editingId,
        body,
    };
    refreshAnnotations(previous ? [previous, comment.fileId] : [comment.fileId]);
}

/** The three ways out for a suggestion: the agent, a review draft on the PR, or a published comment. */
function sendRow(act: (action: string) => () => void, reply: boolean): HTMLElement {
    const row = element("div", "display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap");
    row.appendChild(element("span", css.dim, reply ? "Send the reply:" : "Send:"));
    row.appendChild(button("For agent", act("agent"), true, "Copy it into the agent's outbox and tell its cmux pane"));
    row.appendChild(
        button(
            reply ? "Draft reply on PR" : "Draft on PR",
            act("draft"),
            false,
            "A pending review draft: only you see it until you publish the review"
        )
    );
    row.appendChild(
        button(
            reply ? "Post reply on PR" : "Post on PR",
            act("post"),
            false,
            "Published at once, visible to everyone (asks first)"
        )
    );
    return row;
}

const sentLabel: Record<string, string> = {
    sent: "Sent to agent",
    drafted: "Review draft on PR",
    posted: "Posted on PR",
};

function element<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    style: string,
    text?: string
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.setAttribute("style", style);

    if (text !== undefined) {
        node.textContent = text;
    }

    return node;
}

function button(label: string, onClick: () => void, primary = false, title?: string): HTMLButtonElement {
    const node = element("button", primary ? css.primary : css.button, label);
    node.type = "button";

    if (title) {
        node.title = title;
    }

    node.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
    });
    return node;
}

/** Text with `code` spans and line breaks; everything else stays literal (no HTML injection). */
function richText(text: string): HTMLElement {
    const body = element("div", css.body);
    const lines = text.split("\n");

    lines.forEach((line, index) => {
        for (const part of line.split(/(`[^`]+`)/)) {
            if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
                body.appendChild(element("code", css.code, part.slice(1, -1)));
            } else if (part) {
                body.appendChild(document.createTextNode(part));
            }
        }

        if (index < lines.length - 1) {
            body.appendChild(document.createElement("br"));
        }
    });

    return body;
}

function avatar(author: string, remote: boolean): HTMLElement {
    return element(
        "div",
        `${css.avatar};background:${remote ? "#8ab4ff" : "#ffa11f"}`,
        author.slice(0, 1).toUpperCase()
    );
}

/** A thread already on the PR: who opened it, open or resolved, its first note; resolved ones recede. */
function renderThread(comment: BridgeComment): HTMLElement {
    if (comment.live) {
        return renderLiveThread(comment, comment.live);
    }

    const resolved = comment.state === "resolved";
    const wrap = element("div", resolved ? "opacity:.62" : "");
    const row = element("div", css.row);
    row.appendChild(avatar(comment.author.replace(/^@/, ""), true));
    const main = element("div", "flex:1;min-width:0");
    const head = element("div", css.head);
    head.appendChild(element("span", css.name, comment.author));
    head.appendChild(element("span", `${css.badge};border-color:#8ab4ff;color:#8ab4ff`, "PR thread"));
    const stateColor = resolved ? "#5ccb78" : "#ffa11f";
    head.appendChild(
        element(
            "span",
            `${css.badge};border-color:${stateColor};color:${stateColor}`,
            stateLabel[comment.state] ?? comment.state
        )
    );
    head.appendChild(element("span", css.dim, `L${comment.endLine}${comment.when}`));
    main.appendChild(head);
    main.appendChild(richText(comment.body));
    row.appendChild(main);
    wrap.appendChild(row);

    if (comment.meta) {
        wrap.appendChild(renderMeta(comment.meta));
    }

    if (comment.reply) {
        wrap.appendChild(renderReply(comment, comment.reply));
    }

    return wrap;
}

/** The agent's suggested answer to the thread; Martin rewords it, then sends it one of three ways. */
function renderReply(comment: BridgeComment, reply: string): HTMLElement {
    const box = element(
        "div",
        "margin:0 12px 10px 48px;border:1px solid rgba(255,161,31,.35);border-radius:8px;padding:8px 10px;background:rgba(255,161,31,.05);font-size:12.5px;opacity:1"
    );
    const head = element("div", "display:flex;gap:8px;align-items:center;flex-wrap:wrap");
    head.appendChild(
        element("span", "font-size:10.5px;font-weight:700;letter-spacing:.6px;color:#ffa11f", "SUGGESTED REPLY")
    );
    const act = (action: string) => () => post({ type: "comment.action", id: comment.id, action });

    if (comment.replyStatus) {
        head.appendChild(element("span", css.badge, sentLabel[comment.replyStatus] ?? comment.replyStatus));
    } else {
        const actions = element("div", css.actions);
        actions.appendChild(
            button("Edit", () => openComposerFor(comment, comment.id, reply), false, "Reword the reply")
        );
        head.appendChild(actions);
    }

    box.appendChild(head);
    box.appendChild(richText(reply));

    if (!comment.replyStatus) {
        box.appendChild(sendRow(act, true));
    }

    return box;
}

// MARK: live PR threads (GitLab-style: every note, then Reply and Resolve)

/** Re-renders the card with this id (its file's annotations). */
function refreshCard(id: string): void {
    const comment = comments.find((candidate) => candidate.id === id);

    if (comment) {
        refreshAnnotations([comment.fileId]);
    }
}

function threadAction(id: string, action: string, extra: Record<string, unknown> = {}): void {
    post({ type: "thread.action", id, action, ...extra });
}

/** `live:<id>` and a proposal's `thread:<id>` name the same PR thread. */
function threadIdOf(cardId: string): string {
    return cardId.replace(/^(live|thread):/, "");
}

/**
 * The "Fix" toggle: a drawn box rather than a native checkbox, which WebKit's snapshot drew unchecked
 * while it was checked. Swift keeps the selection (the list and x share it) and sends it back with `setSelection`.
 */
function fixToggle(cardId: string): HTMLElement {
    const threadId = threadIdOf(cardId);
    const checked = selectedThreads.has(threadId);
    const toggle = element(
        "button",
        "display:inline-flex;align-items:center;gap:5px;font:11.5px -apple-system,sans-serif;background:transparent;border:0;padding:0 2px;cursor:pointer;color:" +
            (checked ? "#8ab4ff" : "rgba(255,255,255,.6)")
    );
    toggle.type = "button";
    toggle.setAttribute("role", "checkbox");
    toggle.setAttribute("aria-checked", String(checked));
    toggle.setAttribute("aria-label", "Select this thread for Fix threads");
    toggle.title =
        "Select this thread for Fix threads: the selected threads go as one task to the agent that owns the branch (x)";
    const box = element(
        "span",
        `display:inline-flex;align-items:center;justify-content:center;width:12px;height:12px;border-radius:3px;font-size:10px;line-height:1;${
            checked
                ? "background:#8ab4ff;color:#111;border:1px solid #8ab4ff"
                : "border:1px solid rgba(255,255,255,.35)"
        }`,
        checked ? "✓" : ""
    );
    toggle.appendChild(box);
    toggle.appendChild(document.createTextNode("Fix"));
    toggle.addEventListener("click", (event) => {
        event.stopPropagation();
        const next = !selectedThreads.has(threadId);

        if (next) {
            selectedThreads.add(threadId);
        } else {
            selectedThreads.delete(threadId);
        }

        post({ type: "thread.select", id: threadId, selected: next });
        refreshCard(cardId);
    });
    return toggle;
}

/** The cards of these thread ids, by file, for a re-render. */
function filesOfThreads(ids: Iterable<string>): string[] {
    const wanted = new Set(ids);
    return comments.filter((comment) => wanted.has(threadIdOf(comment.id))).map((comment) => comment.fileId);
}

// MARK: agent blame (hover a new line: the session and turn that wrote it)

interface BlameSource {
    provider: string;
    session: string;
    turn: string;
    ts: string;
    prompt: string | null;
}

/** `tools agents blame`, keyed by file id: `[startLine, endLine, sourceIndex]` on the new side. */
interface BlameData {
    sources: BlameSource[];
    files: Record<string, Array<[number, number, number]>>;
    /** Files Swift already asked about, with agent lines or without. */
    loaded: string[];
}

let blame: BlameData = { sources: [], files: {}, loaded: [] };
/** Files asked for on a hover: blame is computed per file, the first time the pointer is on it. */
let blameAsked = new Set<string>();
let blameHideTimer = 0;
let blameShown: number | null = null;

const blameTip = element(
    "div",
    "position:fixed;display:none;max-width:420px;z-index:25;background:#1b1c20;border:1px solid rgba(255,255,255,.14);border-radius:9px;padding:8px 10px;font:12px/1.45 -apple-system,sans-serif;color:#e6e6e6;box-shadow:0 8px 28px rgba(0,0,0,.45)"
);
blameTip.addEventListener("mouseenter", () => clearTimeout(blameHideTimer));
blameTip.addEventListener("mouseleave", () => blameLeave());
document.body.appendChild(blameTip);

function blameSourceAt(fileId: string, line: number): number | null {
    const range = blame.files[fileId]?.find(([start, end]) => line >= start && line <= end);
    return range ? range[2] : null;
}

function ago(iso: string): string {
    const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);

    if (!Number.isFinite(minutes)) {
        return iso;
    }

    if (minutes < 60) {
        return `${Math.max(minutes, 0)} min ago`;
    }

    return minutes < 48 * 60 ? `${Math.round(minutes / 60)} h ago` : `${Math.round(minutes / 1440)} d ago`;
}

function blameEnter(enter: OnLineEnterLeaveProps | OnDiffLineEnterLeaveProps, fileId: string): void {
    // The old side's lines are what the diff removes: nobody in the change logs wrote them there.
    if (enter.type === "diff-line" && enter.annotationSide !== "additions") {
        return;
    }

    if (!blameAsked.has(fileId)) {
        blameAsked.add(fileId);
        post({ type: "blame.need", fileId });
        return;
    }

    const index = blameSourceAt(fileId, enter.lineNumber);

    if (index !== null) {
        showBlameTip(index, enter.lineElement.getBoundingClientRect());
    }
}

/** The tip for one blame source under (or above) the line's rectangle. */
function showBlameTip(index: number, rect: DOMRect): void {
    const source = blame.sources[index];

    if (!source) {
        return;
    }

    clearTimeout(blameHideTimer);
    blameTip.style.left = `${Math.max(8, Math.min(rect.left + 40, window.innerWidth - 440))}px`;
    blameTip.style.top = `${rect.bottom + 4 + 110 > window.innerHeight ? rect.top - 110 : rect.bottom + 4}px`;

    if (blameShown !== index) {
        blameShown = index;
        blameTip.replaceChildren();
        const head = element("div", "display:flex;gap:6px;align-items:center;margin-bottom:3px");
        head.appendChild(element("span", `${css.badge};border-color:#8ab4ff;color:#8ab4ff`, source.provider));
        head.appendChild(element("span", css.code, source.session.slice(0, 8)));
        head.appendChild(element("span", css.dim, ago(source.ts)));
        blameTip.appendChild(head);
        blameTip.appendChild(
            element(
                "div",
                "color:rgba(255,255,255,.8)",
                source.prompt ? `Turn: “${source.prompt}”` : "The agent wrote this line in that session."
            )
        );
        const open = button(
            "Open the turn",
            () => {
                post({ type: "blame.open", index });
                blameLeave();
            },
            false,
            "Show this session in the hub, with its transcript searched for this turn's prompt"
        );
        open.style.marginTop = "6px";
        blameTip.appendChild(open);
    }

    blameTip.style.display = "block";
}

/** A short delay, so the pointer can travel from the line into the tip and click its button. */
function blameLeave(): void {
    clearTimeout(blameHideTimer);
    blameHideTimer = window.setTimeout(() => {
        blameTip.style.display = "none";
        blameShown = null;
    }, 280);
}

// MARK: keys (j / k threads, r reply, e resolve, x select, f fix, n / p files, s submit, ? this list)

const reviewKeys = new Set(["j", "k", "r", "e", "x", "f", "n", "p", "s"]);

/** A place where a key is text: the reply and edit boxes, the composer, the find field. */
function isTyping(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) {
        return false;
    }

    if (target instanceof HTMLTextAreaElement || target.isContentEditable) {
        return true;
    }

    return target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type);
}

const keysOverlay = element(
    "div",
    "position:fixed;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.45);z-index:30"
);
const keysPanel = element(
    "div",
    "min-width:320px;background:#1b1c20;border:1px solid rgba(255,255,255,.14);border-radius:12px;padding:14px 18px;font:13px/1.5 -apple-system,sans-serif;color:#e6e6e6;box-shadow:0 12px 40px rgba(0,0,0,.5)"
);
keysPanel.appendChild(element("div", "font-weight:600;margin-bottom:8px", "Review keys"));

for (const [keys, what] of [
    ["j  k", "Next / previous PR thread"],
    ["r", "Reply to the thread"],
    ["e", "Resolve the thread, or reopen it"],
    ["x", "Select the thread for Fix threads"],
    ["f", "Fix the selected threads (send them to the agent)"],
    ["n  p", "Next / previous file"],
    ["s", "Submit review (asks first)"],
    ["?", "Show or hide this list"],
]) {
    const row = element("div", "display:flex;gap:14px;align-items:baseline");
    row.appendChild(
        element(
            "span",
            "min-width:48px;font:12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#8ab4ff;white-space:pre",
            keys
        )
    );
    row.appendChild(element("span", "", what));
    keysPanel.appendChild(row);
}

keysPanel.appendChild(
    element(
        "div",
        `${css.dim};margin-top:8px`,
        "The keys work while the diff has the keyboard, never while you type in a box. Esc closes."
    )
);
keysOverlay.appendChild(keysPanel);
keysOverlay.addEventListener("click", () => showKeys(false));
document.body.appendChild(keysOverlay);

function showKeys(show: boolean): void {
    keysOverlay.style.display = show ? "flex" : "none";
}

document.addEventListener("keydown", (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) {
        return;
    }

    if (isTyping(event.target) || isTyping(document.activeElement)) {
        return;
    }

    if (event.key === "?") {
        event.preventDefault();
        showKeys(keysOverlay.style.display !== "flex");
        return;
    }

    if (event.key === "Escape" && keysOverlay.style.display === "flex") {
        event.preventDefault();
        showKeys(false);
        return;
    }

    if (reviewKeys.has(event.key)) {
        event.preventDefault();
        post({ type: "key", key: event.key });
    }
});

/**
 * A thread on the PR as GitLab draws it: the notes in order, then a Reply box and Resolve. A resolved
 * thread folds to one line until clicked. Every button only posts a message; Swift asks before
 * anything others see, runs `tools hub pr`, and answers with `threadDone`.
 */
function renderLiveThread(comment: BridgeComment, live: LiveThread): HTMLElement {
    const id = comment.id;
    const busy = busyThreads.has(id);
    const folded = live.resolved && !expandedThreads.has(id) && !threadBoxes.has(id);
    const wrap = element("div", folded ? "opacity:.7" : "");
    const top = element(
        "div",
        `display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:7px 12px;${folded ? "" : "border-bottom:1px solid rgba(255,255,255,.06)"}`
    );
    const toggle = button(
        folded ? "▸" : "▾",
        () => {
            if (folded) {
                expandedThreads.add(id);
            } else {
                expandedThreads.delete(id);
            }
            refreshCard(id);
        },
        false,
        folded ? "Show the whole thread" : "Fold the thread"
    );
    toggle.setAttribute("style", `${css.button};padding:0 6px;border:0`);
    toggle.setAttribute("aria-label", folded ? "Show the whole thread" : "Fold the thread");
    top.appendChild(toggle);
    top.appendChild(element("span", `${css.badge};border-color:#8ab4ff;color:#8ab4ff`, "PR thread"));
    const draftThread = comment.state === "draft";
    const stateColor = draftThread ? "#ffa11f" : live.resolved ? "#5ccb78" : "#ffa11f";
    top.appendChild(
        element(
            "span",
            `${css.badge};border-color:${stateColor};color:${stateColor}`,
            draftThread ? "Your draft" : live.resolved ? "Resolved" : "Open"
        )
    );
    const range =
        comment.startLine === comment.endLine ? `L${comment.endLine}` : `L${comment.startLine}–${comment.endLine}`;
    const first = live.notes[0];
    const count = live.notes.length === 1 ? "1 comment" : `${live.notes.length} comments`;
    top.appendChild(element("span", css.dim, folded && first ? `${range} · ${count} · @${first.username}` : range));

    // A thread that is still my draft does not exist for anyone yet: there is nothing to fix.
    if (!draftThread) {
        top.appendChild(fixToggle(id));
    }

    if (focusedCard === id) {
        // The thread j / k moved to: a bar on its left edge, as a selected row has.
        wrap.style.boxShadow = "inset 3px 0 0 #8ab4ff";
        wrap.style.background = "rgba(138,180,255,.07)";
        wrap.style.opacity = "1";
    }

    const actions = element("div", css.actions);

    if (live.resolvable) {
        const resolve = button(
            busy ? "…" : live.resolved ? "Unresolve" : "Resolve",
            () => {
                // A double click lands both clicks before the redraw disables the button.
                if (busyThreads.has(id)) {
                    return;
                }

                busyThreads.add(id);
                threadAction(id, live.resolved ? "unresolve" : "resolve");
                refreshCard(id);
            },
            false,
            live.resolved ? "Reopen the thread on the PR" : "Mark the thread resolved on the PR"
        );
        resolve.disabled = busy;
        actions.appendChild(resolve);
    }

    top.appendChild(actions);
    wrap.appendChild(top);

    if (folded) {
        return wrap;
    }

    for (const note of live.notes) {
        wrap.appendChild(renderNote(id, note, busy));
    }

    if (comment.meta) {
        wrap.appendChild(renderMeta(comment.meta));
    }

    if (comment.reply) {
        wrap.appendChild(renderReply(comment, comment.reply));
    }

    if (live.canReply) {
        wrap.appendChild(renderReplyBox(id));
    }

    return wrap;
}

function renderNote(threadId: string, note: LiveNote, busy: boolean): HTMLElement {
    const row = element("div", `${css.row};padding:9px 12px`);
    row.appendChild(avatar(note.author || note.username, !note.isDraft));
    const main = element("div", "flex:1;min-width:0");
    const head = element("div", css.head);
    const name = note.author || note.username;
    const nameNode = note.authorUrl ? link(name, note.authorUrl) : element("span", "", name);
    nameNode.style.fontWeight = "600";

    if (note.authorUrl) {
        // Like the hub's dense links the name keeps its color; a faint underline marks it as a link,
        // and hover or keyboard focus makes it full.
        const faint = "color-mix(in srgb, currentColor 35%, transparent)";
        const underline = (full: boolean) => () => {
            nameNode.style.textDecorationColor = full ? "currentColor" : faint;
        };
        nameNode.style.color = "inherit";
        nameNode.style.textDecoration = "underline";
        nameNode.style.textDecorationColor = faint;
        nameNode.addEventListener("mouseenter", underline(true));
        nameNode.addEventListener("mouseleave", underline(false));
        nameNode.addEventListener("focus", underline(true));
        nameNode.addEventListener("blur", underline(false));
    }

    head.appendChild(nameNode);

    if (note.author && note.author !== note.username) {
        head.appendChild(element("span", css.dim, `@${note.username}`));
    }

    const when = element("span", css.dim, note.when + (note.edited ? " · edited" : ""));
    when.title = note.at;
    head.appendChild(when);

    if (note.isDraft) {
        const badge = element("span", `${css.badge};border-color:#ffa11f;color:#ffa11f`, "Draft");
        badge.title = "Only you see it until you submit the review";
        head.appendChild(badge);
    }

    const box = threadBoxes.get(threadId);
    const editing = box?.kind === "edit" && box.noteId === note.id;

    if (note.isDraft && !editing) {
        const actions = element("div", css.actions);
        const edit = button(
            "Edit",
            () => {
                threadBoxes.set(threadId, { kind: "edit", noteId: note.id, body: note.body, sending: false });
                refreshCard(threadId);
            },
            false,
            "Change the text of this draft"
        );
        const remove = button(
            "Delete",
            () => {
                if (busyThreads.has(threadId)) {
                    return;
                }

                busyThreads.add(threadId);
                threadAction(threadId, "note.delete", { noteId: note.id });
                refreshCard(threadId);
            },
            false,
            "Delete this draft from your pending review (asks first)"
        );
        edit.disabled = busy;
        remove.disabled = busy;
        actions.appendChild(edit);
        actions.appendChild(remove);
        head.appendChild(actions);
    }

    main.appendChild(head);

    if (editing && box) {
        main.appendChild(
            renderBox(threadId, box, [
                {
                    label: "Save draft",
                    title: "Replace the draft's text; it stays a draft",
                    primary: true,
                    send: (body) => threadAction(threadId, "note.update", { noteId: note.id, body }),
                },
            ])
        );
    } else {
        main.appendChild(foldedBody(note.id, note.body));
    }

    row.appendChild(main);
    return row;
}

/** GitLab's "Reply…" field: a click opens the box with Save as draft and Post (Swift asks first). */
function renderReplyBox(threadId: string): HTMLElement {
    const footer = element("div", "padding:8px 12px 10px 48px;border-top:1px solid rgba(255,255,255,.06)");
    const box = threadBoxes.get(threadId);

    if (box?.kind !== "reply") {
        const field = element(
            "button",
            "width:100%;text-align:left;font:12.5px -apple-system,sans-serif;color:rgba(255,255,255,.45);background:#0e0f11;border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:7px 10px;cursor:text",
            "Reply…"
        );
        field.type = "button";
        field.title = "Write a reply: add it to your pending review, or post it now";
        field.disabled = box !== undefined;
        field.addEventListener("click", (event) => {
            event.stopPropagation();
            threadBoxes.set(threadId, { kind: "reply", body: "", sending: false });
            refreshCard(threadId);
        });
        footer.appendChild(field);
        return footer;
    }

    footer.appendChild(
        renderBox(threadId, box, [
            {
                label: "Post…",
                title: "Publish the reply at once, visible to everyone (asks first)",
                primary: false,
                send: (body) => threadAction(threadId, "reply", { draft: false, body }),
            },
            {
                label: "Save as draft",
                title: "A draft in your pending review; Submit review publishes it (⌘↩)",
                primary: true,
                send: (body) => threadAction(threadId, "reply", { draft: true, body }),
            },
        ])
    );
    return footer;
}

interface BoxButton {
    label: string;
    title: string;
    primary: boolean;
    send: (body: string) => void;
}

/** A textarea with Cancel and the given sends. ⌘↩ runs the primary send, Esc cancels. */
function renderBox(threadId: string, box: ThreadBox, sends: BoxButton[]): HTMLElement {
    const wrap = element("div", "display:flex;flex-direction:column;gap:6px;margin-top:4px");
    const input = element("textarea", css.textarea);
    input.value = box.body;
    input.disabled = box.sending;
    input.placeholder = box.kind === "reply" ? "Reply… (markdown; ⌘↩ saves it as a draft, Esc cancels)" : "";
    input.addEventListener("input", () => {
        box.body = input.value;
    });

    const cancel = () => {
        threadBoxes.delete(threadId);
        refreshCard(threadId);
    };
    const run = (send: BoxButton) => {
        const body = input.value.trim();

        if (!body || box.sending) {
            return;
        }

        box.body = input.value;
        box.sending = true;
        send.send(body);
        refreshCard(threadId);
    };

    input.addEventListener("keydown", (event) => {
        // Keys typed here belong to the box, never to the diff's own shortcuts.
        event.stopPropagation();

        if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            const primary = sends.find((candidate) => candidate.primary);

            if (primary) {
                run(primary);
            }
        } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
        }
    });
    wrap.appendChild(input);
    const actions = element("div", "display:flex;gap:6px;justify-content:flex-end;align-items:center");

    if (box.sending) {
        actions.appendChild(element("span", css.dim, "Sending…"));
    }

    const cancelButton = button("Cancel", cancel);
    cancelButton.disabled = box.sending;
    actions.appendChild(cancelButton);

    for (const send of sends) {
        const node = button(send.label, () => run(send), send.primary, send.title);
        node.disabled = box.sending;
        actions.appendChild(node);
    }

    wrap.appendChild(actions);

    if (!box.sending) {
        requestAnimationFrame(() => {
            input.focus();
            input.setSelectionRange(input.value.length, input.value.length);
        });
    }

    return wrap;
}

/** A long note folds at about 18 lines, with "Show all" under it. */
function foldedBody(noteId: string, text: string): HTMLElement {
    const body = markdown(text);
    const long = text.length > 1200 || text.split("\n").length > 24;

    if (!long) {
        return body;
    }

    const open = expandedNotes.has(noteId);
    const wrap = element("div", "");

    if (!open) {
        body.style.maxHeight = "22em";
        body.style.overflow = "hidden";
        body.style.maskImage = "linear-gradient(to bottom, black 75%, transparent)";
    }

    wrap.appendChild(body);
    const more = element(
        "button",
        "margin-top:4px;font:12px -apple-system,sans-serif;color:#8ab4ff;background:transparent;border:0;padding:0;cursor:pointer",
        open ? "Show less" : "Show all"
    );
    more.type = "button";
    more.addEventListener("click", (event) => {
        event.stopPropagation();

        if (open) {
            expandedNotes.delete(noteId);
        } else {
            expandedNotes.add(noteId);
        }

        more.textContent = open ? "Show all" : "Show less";
        body.style.maxHeight = open ? "22em" : "";
        body.style.overflow = open ? "hidden" : "";
        body.style.maskImage = open ? "linear-gradient(to bottom, black 75%, transparent)" : "";
    });
    wrap.appendChild(more);
    return wrap;
}

// MARK: markdown (built from DOM nodes, never innerHTML: a PR comment is untrusted text)

/** The HTML that review bots wrap their markdown in. Outside code it is dropped; `<summary>` stays as a bold line. */
const htmlTag =
    /<\/?(details|summary|br|sub|sup|b|i|strong|em|p|div|span|img|a|blockquote|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|kbd|hr|picture|source)\b[^>]*>/gi;

function markdown(text: string): HTMLElement {
    const root = element("div", css.body);
    const lines = text
        .replace(/\r\n/g, "\n")
        .replace(/<!--[\s\S]*?-->/g, "")
        .split("\n");
    let paragraph: string[] = [];
    let list: HTMLElement | null = null;

    const flush = () => {
        if (paragraph.length > 0) {
            const p = element("div", "margin:3px 0");
            inline(p, paragraph.join("\n"));
            root.appendChild(p);
            paragraph = [];
        }
    };

    for (let index = 0; index < lines.length; index++) {
        const raw = lines[index];

        if (/^\s*```/.test(raw)) {
            flush();
            list = null;
            const code: string[] = [];
            index++;

            while (index < lines.length && !/^\s*```/.test(lines[index])) {
                code.push(lines[index]);
                index++;
            }

            root.appendChild(
                element(
                    "pre",
                    "margin:4px 0;padding:8px 10px;border-radius:7px;background:#0e0f11;border:1px solid rgba(255,255,255,.08);font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:#d6e2ff",
                    code.join("\n")
                )
            );
            continue;
        }

        const line = raw
            .replace(/<summary\b[^>]*>(.*?)<\/summary>/gi, "**$1**")
            .replace(/<br\s*\/?>/gi, "")
            .replace(htmlTag, "");

        if (!line.trim()) {
            // A line that held only a tag is not a paragraph break; a truly empty one is.
            if (!raw.trim()) {
                flush();
                list = null;
            }
            continue;
        }

        const heading = line.match(/^\s*(#{1,6})\s+(.*)$/);
        const item = line.match(/^\s*([-*+]|\d+[.)])\s+(.*)$/);
        const quote = line.match(/^\s*>\s?(.*)$/);

        if (heading) {
            flush();
            list = null;
            const node = element(
                "div",
                `margin:6px 0 2px;font-weight:600;font-size:${heading[1].length <= 2 ? 14 : 13}px`
            );
            inline(node, heading[2]);
            root.appendChild(node);
        } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
            flush();
            list = null;
            root.appendChild(element("div", "height:1px;background:rgba(255,255,255,.1);margin:8px 0"));
        } else if (item) {
            flush();
            const ordered = /\d/.test(item[1]);

            if (!list || (list.tagName === "OL") !== ordered) {
                list = element(ordered ? "ol" : "ul", "margin:3px 0;padding-left:20px");
                root.appendChild(list);
            }

            const li = element("li", "margin:1px 0");
            inline(li, item[2]);
            list.appendChild(li);
        } else if (quote) {
            flush();
            list = null;
            const node = element(
                "div",
                "margin:3px 0;padding-left:9px;border-left:3px solid rgba(255,255,255,.18);color:rgba(255,255,255,.7)"
            );
            inline(node, quote[1]);
            root.appendChild(node);
        } else {
            list = null;
            paragraph.push(line);
        }
    }

    flush();
    return root;
}

const inlinePattern =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])|(\*[^*\s][^*\n]*\*|(?<![\w])_[^_\s][^_\n]*_(?![\w]))/g;

/** `code`, **bold**, *italic*, [links](url) and bare URLs; line breaks stay. Links open in the browser through Swift. */
function inline(parent: HTMLElement, text: string): void {
    let last = 0;

    const plain = (value: string) => {
        value.split("\n").forEach((part, index) => {
            if (index > 0) {
                parent.appendChild(document.createElement("br"));
            }

            if (part) {
                parent.appendChild(document.createTextNode(part));
            }
        });
    };

    for (const match of text.matchAll(inlinePattern)) {
        const at = match.index ?? 0;
        plain(text.slice(last, at));
        last = at + match[0].length;
        const token = match[0];

        if (match[1]) {
            parent.appendChild(element("code", css.code, token.slice(1, -1)));
        } else if (match[2]) {
            parent.appendChild(element("strong", "font-weight:600", token.slice(2, -2)));
        } else if (match[3]) {
            const split = token.indexOf("](");
            parent.appendChild(link(token.slice(1, split), token.slice(split + 2, -1)));
        } else if (match[4]) {
            parent.appendChild(link(token, token));
        } else {
            parent.appendChild(element("em", "", token.slice(1, -1)));
        }
    }

    plain(text.slice(last));
}

function link(label: string, url: string): HTMLElement {
    const node = element("a", "color:#8ab4ff;text-decoration:none;cursor:pointer", label);
    node.title = url;

    // The href makes it a link for Tab, Return and VoiceOver; the click below still sends it to Swift.
    if (/^https?:\/\//.test(url)) {
        node.setAttribute("href", url);
    }

    node.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();

        if (/^https?:\/\//.test(url)) {
            post({ type: "link", url });
        }
    });
    return node;
}

function renderComment(comment: BridgeComment): HTMLElement {
    if (comment.kind === "draft") {
        return renderDraft(comment);
    }

    if (comment.kind === "thread") {
        return renderThread(comment);
    }

    const row = element("div", css.row);
    row.appendChild(avatar(comment.author, comment.remote));
    const main = element("div", "flex:1;min-width:0");
    const head = element("div", css.head);
    head.appendChild(element("span", css.name, comment.author));
    head.appendChild(element("span", css.dim, comment.when));
    const range =
        comment.startLine === comment.endLine ? `L${comment.endLine}` : `L${comment.startLine}–${comment.endLine}`;
    head.appendChild(element("span", css.dim, range));
    head.appendChild(element("span", css.badge, stateLabel[comment.state] ?? comment.state));
    const actions = element("div", css.actions);

    if (!comment.remote) {
        actions.appendChild(
            button("Edit", () => {
                const previous = composer?.fileId;
                composer = {
                    fileId: comment.fileId,
                    side: comment.side,
                    startLine: comment.startLine,
                    endLine: comment.endLine,
                    editingId: comment.id,
                    body: comment.body,
                };
                refreshAnnotations(previous ? [previous, comment.fileId] : [comment.fileId]);
            })
        );
        actions.appendChild(button("Delete", () => post({ type: "comment.delete", id: comment.id })));
    }

    // A remote or posted comment is already on the PR: promoting it would make a second draft.
    if (!comment.remote && comment.state !== "posted") {
        const action = comment.state === "draft" ? "post" : "promote";
        actions.appendChild(
            button(
                action === "post" ? "Post" : "Promote to draft",
                () => post({ type: "comment.action", id: comment.id, action }),
                false,
                "GitHub / GitLab review sync"
            )
        );
    }

    head.appendChild(actions);
    main.appendChild(head);
    main.appendChild(richText(comment.body));
    row.appendChild(main);
    return row;
}

function renderComposer(current: Composer): HTMLElement {
    const card = element("div", css.card);
    const row = element("div", `${css.row};flex-direction:column`);
    const range =
        current.startLine === current.endLine
            ? `line ${current.endLine}`
            : `lines ${current.startLine}–${current.endLine}`;
    row.appendChild(
        element("div", css.dim, `${current.editingId ? "Edit comment" : "Comment for the agent"} · ${range}`)
    );
    const input = element("textarea", css.textarea);
    input.value = current.body;
    input.placeholder = "What should change here? (⌘↩ saves, Esc cancels)";
    input.addEventListener("input", () => {
        current.body = input.value;
    });

    const save = () => {
        const body = input.value.trim();

        // A double click on Add comment (or ⌘↩ twice) runs before the redraw removes the composer:
        // only the first save of this composer posts.
        if (!body || composer !== current) {
            return;
        }

        post({
            type: current.editingId ? "comment.edit" : "comment.add",
            id: current.editingId,
            fileId: current.fileId,
            side: current.side,
            startLine: current.startLine,
            endLine: current.endLine,
            body,
        });
        composer = null;
        refreshAnnotations([current.fileId]);
    };

    const cancel = () => {
        composer = null;
        refreshAnnotations([current.fileId]);
    };

    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && event.metaKey) {
            event.preventDefault();
            save();
        } else if (event.key === "Escape") {
            event.preventDefault();
            cancel();
        }
    });
    row.appendChild(input);
    const actions = element("div", "display:flex;gap:6px;justify-content:flex-end");
    actions.appendChild(button("Cancel", cancel));
    actions.appendChild(button(current.editingId ? "Save" : "Add comment", save, true));
    row.appendChild(actions);
    card.appendChild(row);
    requestAnimationFrame(() => input.focus());
    return card;
}

function renderAnnotation(meta: AnnotationMeta | undefined): HTMLElement | undefined {
    if (!meta) {
        return undefined;
    }

    if (meta.kind === "composer") {
        return renderComposer(meta.composer);
    }

    const card = element("div", css.card);
    meta.comments.forEach((comment, index) => {
        if (index > 0) {
            card.appendChild(element("div", "height:1px;background:rgba(255,255,255,.07)"));
        }

        card.appendChild(renderComment(comment));
    });
    return card;
}

// MARK: find (⌘F)

/**
 * Find searches the parsed diffs, never the DOM: CodeView has only the files near the viewport on
 * the page, so a DOM search would miss every other file. It covers the lines the diff shows (the
 * hunks: changed lines and their context), which are also the lines a click can scroll to.
 */
interface FindMatch {
    fileId: string;
    path: string;
    side: Side;
    lineNumber: number;
    text: string;
    column: number;
}

const findLimit = 2000;

/** Case-insensitive unless the query has a capital letter, like most editors' smart case. */
function searchDiffs(query: string): { matches: FindMatch[]; truncated: boolean } {
    const caseSensitive = query !== query.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: FindMatch[] = [];

    for (const file of files) {
        const fileDiff = parsed.get(file.id)?.fileDiff;

        if (!fileDiff) {
            continue;
        }

        const test = (side: Side, lines: string[], index: number): boolean => {
            const text = (lines[index] ?? "").replace(/\r?\n$/, "");
            const column = (caseSensitive ? text : text.toLowerCase()).indexOf(needle);

            if (column >= 0) {
                matches.push({ fileId: file.id, path: file.path, side, lineNumber: index + 1, text, column });
            }

            return matches.length >= findLimit;
        };

        for (const hunk of fileDiff.hunks) {
            for (const content of hunk.hunkContent) {
                if (content.type === "context") {
                    for (let offset = 0; offset < content.lines; offset++) {
                        if (test("additions", fileDiff.additionLines, content.additionLineIndex + offset)) {
                            return { matches, truncated: true };
                        }
                    }

                    continue;
                }

                for (let offset = 0; offset < content.deletions; offset++) {
                    if (test("deletions", fileDiff.deletionLines, content.deletionLineIndex + offset)) {
                        return { matches, truncated: true };
                    }
                }

                for (let offset = 0; offset < content.additions; offset++) {
                    if (test("additions", fileDiff.additionLines, content.additionLineIndex + offset)) {
                        return { matches, truncated: true };
                    }
                }
            }
        }
    }

    return { matches, truncated: false };
}

const findCss = {
    bar: "position:fixed;top:8px;right:14px;z-index:20;display:none;flex-direction:column;width:min(460px,calc(100vw - 28px));background:#1b1c20;border:1px solid rgba(255,255,255,.14);border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.5);font:12.5px -apple-system,BlinkMacSystemFont,sans-serif;color:#e6e6e6;overflow:hidden",
    row: "display:flex;align-items:center;gap:6px;padding:6px 8px",
    input: "flex:1;min-width:0;background:#0e0f11;color:#eee;border:1px solid rgba(255,255,255,.15);border-radius:7px;padding:5px 8px;font:12.5px -apple-system,sans-serif;outline:none",
    count: "color:rgba(255,255,255,.5);font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace;white-space:nowrap",
    icon: "font:13px -apple-system,sans-serif;color:rgba(255,255,255,.75);background:transparent;border:0;border-radius:6px;padding:2px 7px;cursor:pointer",
    list: "max-height:min(46vh,420px);overflow:auto;border-top:1px solid rgba(255,255,255,.08)",
    file: "position:sticky;top:0;padding:5px 10px 3px;background:#1b1c20;color:rgba(255,255,255,.55);font:600 11.5px -apple-system,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;direction:rtl;text-align:left",
    match: "display:flex;gap:8px;padding:3px 10px;cursor:pointer;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre;overflow:hidden",
    line: "flex:none;min-width:48px;color:rgba(255,255,255,.4);text-align:right",
    mark: "background:rgba(255,161,31,.35);color:#fff;border-radius:3px",
};

const findState = {
    open: false,
    query: "",
    matches: [] as FindMatch[],
    truncated: false,
    index: -1,
    listOpen: true,
};

const findBar = element("div", findCss.bar);
findBar.setAttribute("role", "search");
const findRow = element("div", findCss.row);
const findInput = element("input", findCss.input);
findInput.type = "search";
findInput.placeholder = "Find in every file of the diff";
findInput.setAttribute("aria-label", "Find in every file of the diff");
const findCount = element("span", findCss.count);
const findList = element("div", findCss.list);
findList.setAttribute("role", "listbox");
findList.setAttribute("aria-label", "Matches");

function findButton(label: string, title: string, onClick: () => void): HTMLButtonElement {
    const node = element("button", findCss.icon, label);
    node.type = "button";
    node.title = title;
    node.setAttribute("aria-label", title);
    node.addEventListener("mouseenter", () => {
        node.style.background = "rgba(255,255,255,.08)";
    });
    node.addEventListener("mouseleave", () => {
        node.style.background = "transparent";
    });
    node.addEventListener("click", (event) => {
        event.stopPropagation();
        onClick();
    });
    return node;
}

const findListToggle = findButton("☰", "Hide the list of matches", () => {
    findState.listOpen = !findState.listOpen;
    renderFindList();
});
findRow.append(
    findInput,
    findCount,
    findButton("↑", "Previous match (⇧↩ or ⇧⌘G)", () => stepFind(-1)),
    findButton("↓", "Next match (↩ or ⌘G)", () => stepFind(1)),
    findListToggle,
    findButton("✕", "Close (Esc)", closeFind)
);
findBar.append(findRow, findList);
document.body.appendChild(findBar);

let findTimer = 0;
findInput.addEventListener("input", () => {
    clearTimeout(findTimer);
    findTimer = window.setTimeout(() => runFind(findInput.value), 90);
});

findInput.addEventListener("keydown", (event) => {
    // Keys typed here belong to the find bar, never to the diff's own shortcuts.
    event.stopPropagation();

    if (event.key === "Enter") {
        event.preventDefault();
        clearTimeout(findTimer);

        if (findInput.value !== findState.query) {
            runFind(findInput.value);
        } else {
            stepFind(event.shiftKey ? -1 : 1);
        }
    } else if (event.key === "Escape") {
        event.preventDefault();
        closeFind();
    } else if (event.key === "g" && event.metaKey) {
        event.preventDefault();
        stepFind(event.shiftKey ? -1 : 1);
    }
});

function openFind(): void {
    findState.open = true;
    findBar.style.display = "flex";
    findInput.focus();
    findInput.select();
}

function closeFind(): void {
    findState.open = false;
    findBar.style.display = "none";
    viewer.clearSelectedLines({ notify: false });
    host.focus();
}

function runFind(query: string): void {
    const started = performance.now();
    findState.query = query;
    const result = query.trim() === "" ? { matches: [], truncated: false } : searchDiffs(query);
    findState.matches = result.matches;
    findState.truncated = result.truncated;
    findState.index = -1;
    renderFindList();

    if (result.matches.length > 0) {
        goToMatch(0);
    }

    post({
        type: "log",
        message: `diff.find ${result.matches.length}${result.truncated ? "+" : ""} matches in ${files.length} files, ${Math.round(performance.now() - started)}ms`,
    });
}

/** A new file set (a refresh, the rest of a large diff) may add or move matches: search again, keep the place. */
function refreshFind(): void {
    if (!findState.open || findState.query.trim() === "") {
        return;
    }

    const current = findState.matches[findState.index];
    const result = searchDiffs(findState.query);
    findState.matches = result.matches;
    findState.truncated = result.truncated;
    findState.index = current
        ? result.matches.findIndex(
              (match) =>
                  match.fileId === current.fileId &&
                  match.side === current.side &&
                  match.lineNumber === current.lineNumber
          )
        : -1;
    renderFindList();
}

function stepFind(delta: number): void {
    const count = findState.matches.length;

    if (count === 0) {
        return;
    }

    // Before the first step, ↓ lands on the first match and ↑ on the last.
    const from = findState.index < 0 ? (delta > 0 ? -1 : 0) : findState.index;
    goToMatch((from + delta + count) % count);
}

function goToMatch(index: number): void {
    const match = findState.matches[index];

    if (!match) {
        return;
    }

    findState.index = index;

    if (folded.has(match.path)) {
        toggleFold(match.path);
    }

    glideTo({ type: "line", id: match.fileId, lineNumber: match.lineNumber, side: match.side, align: "center" });
    viewer.setSelectedLines(
        { id: match.fileId, range: { start: match.lineNumber, end: match.lineNumber, side: match.side } },
        { notify: false }
    );
    post({ type: "focusFile", fileId: match.fileId });
    renderFindList();
}

function renderFindCount(): void {
    const total = findState.matches.length;

    if (findState.query.trim() === "") {
        findCount.textContent = "";
    } else if (total === 0) {
        findCount.textContent = "no matches";
    } else {
        const position = findState.index >= 0 ? `${findState.index + 1} of ` : "";
        findCount.textContent = `${position}${total}${findState.truncated ? "+" : ""}`;
    }
}

function renderFindList(): void {
    renderFindCount();
    findListToggle.title = findState.listOpen ? "Hide the list of matches" : "Show the list of matches";
    findListToggle.setAttribute("aria-label", findListToggle.title);
    findList.replaceChildren();
    findList.style.display = findState.listOpen && findState.matches.length > 0 ? "block" : "none";

    if (!findState.listOpen) {
        return;
    }

    let currentRow: HTMLElement | null = null;
    let lastFile = "";

    for (const [index, match] of findState.matches.entries()) {
        if (match.fileId !== lastFile) {
            lastFile = match.fileId;
            const header = element("div", findCss.file);
            // rtl keeps the file name visible when a long path is cut; the bidi mark keeps the text in order.
            header.textContent = `\u200E${match.path}`;
            header.title = match.path;
            findList.appendChild(header);
        }

        const row = element("div", findCss.match);
        row.setAttribute("role", "option");
        row.setAttribute("aria-selected", String(index === findState.index));
        row.style.background = index === findState.index ? "rgba(138,180,255,.16)" : "transparent";
        row.appendChild(element("span", findCss.line, `${match.side === "deletions" ? "−" : ""}${match.lineNumber}`));
        row.appendChild(matchSnippet(match));
        row.title = `${match.path}:${match.lineNumber}${match.side === "deletions" ? " (removed line)" : ""}`;
        row.addEventListener("mouseenter", () => {
            if (index !== findState.index) {
                row.style.background = "rgba(255,255,255,.05)";
            }
        });
        row.addEventListener("mouseleave", () => {
            row.style.background = index === findState.index ? "rgba(138,180,255,.16)" : "transparent";
        });
        row.addEventListener("click", (event) => {
            event.stopPropagation();
            goToMatch(index);
        });
        findList.appendChild(row);

        if (index === findState.index) {
            currentRow = row;
        }
    }

    if (findState.truncated) {
        findList.appendChild(
            element(
                "div",
                `${findCss.match};color:rgba(255,255,255,.45);cursor:default`,
                `Showing the first ${findLimit}. Type more to narrow it.`
            )
        );
    }

    currentRow?.scrollIntoView({ block: "nearest" });
}

/** The line around its match, the match marked; built from text nodes (the diff is untrusted text). */
function matchSnippet(match: FindMatch): HTMLElement {
    const snippet = element("span", "min-width:0;overflow:hidden;text-overflow:ellipsis;color:rgba(255,255,255,.85)");
    const length = findState.query.length;
    const from = Math.max(0, match.column - 40);
    const before = match.text.slice(from, match.column).replace(/^\s+/, "");
    snippet.appendChild(document.createTextNode(`${from > 0 ? "…" : ""}${before}`));
    snippet.appendChild(element("mark", findCss.mark, match.text.slice(match.column, match.column + length)));
    snippet.appendChild(document.createTextNode(match.text.slice(match.column + length, match.column + length + 160)));
    return snippet;
}

document.addEventListener(
    "keydown",
    (event) => {
        if (!event.metaKey || event.altKey || event.ctrlKey) {
            return;
        }

        if (event.key === "f" && !event.shiftKey) {
            event.preventDefault();
            openFind();
        } else if (event.key === "g" && findState.open) {
            event.preventDefault();
            stepFind(event.shiftKey ? -1 : 1);
        }
    },
    true
);

// MARK: scroll probe (one app-perf.log line per scroll gesture)

/**
 * Tells a slow page from a stopped scroll: how far the wheel asked to go against how far the view
 * went, the frame gaps, the frames where the wheel moved and the view did not ("stuck"), the speed
 * in the last 80 ms (a stop at speed is a cut, a natural end slows to near zero), and how often
 * CodeView wrote the scroll position itself (its anchor correction, `root.scrollTo`).
 */
const probe = {
    active: false,
    start: 0,
    lastEvent: 0,
    startTop: 0,
    lastTop: 0,
    travelled: 0,
    wheel: 0,
    wheelEvents: 0,
    wheelSinceFrame: 0,
    scrollEvents: 0,
    frames: 0,
    slowFrames: 0,
    maxGap: 0,
    lastFrame: 0,
    frameTop: 0,
    stuckFrames: 0,
    corrections: 0,
    renderedMax: 0,
    samples: [] as { time: number; top: number }[],
};

// CodeView's only scroll write (applyScrollFix). Counted, then passed through unchanged.
Object.defineProperty(host, "scrollTo", {
    configurable: true,
    value: (...args: unknown[]) => {
        if (probe.active) {
            probe.corrections += 1;
        }

        Reflect.apply(HTMLElement.prototype.scrollTo, host, args);
    },
});

function probeBegin(now: number): void {
    probe.active = true;
    probe.start = now;
    probe.startTop = host.scrollTop;
    probe.lastTop = host.scrollTop;
    probe.frameTop = host.scrollTop;
    probe.travelled = 0;
    probe.wheel = 0;
    probe.wheelEvents = 0;
    probe.wheelSinceFrame = 0;
    probe.scrollEvents = 0;
    probe.frames = 0;
    probe.slowFrames = 0;
    probe.maxGap = 0;
    probe.lastFrame = now;
    probe.stuckFrames = 0;
    probe.corrections = 0;
    probe.renderedMax = 0;
    probe.samples = [];
    requestAnimationFrame(probeFrame);
}

function probeFrame(now: number): void {
    if (!probe.active) {
        return;
    }

    const gap = now - probe.lastFrame;
    probe.lastFrame = now;
    probe.frames += 1;
    probe.maxGap = Math.max(probe.maxGap, gap);

    if (gap > 34) {
        probe.slowFrames += 1;
    }

    const top = host.scrollTop;
    const atEdge = top <= 0 || top >= host.scrollHeight - host.clientHeight - 1;

    if (probe.wheelSinceFrame > 0 && top === probe.frameTop && !atEdge) {
        probe.stuckFrames += 1;
    }

    probe.wheelSinceFrame = 0;
    probe.frameTop = top;
    probe.renderedMax = Math.max(probe.renderedMax, viewer.getRenderedItems().length);

    if (now - probe.lastEvent > 250) {
        probeEnd(now);
        return;
    }

    requestAnimationFrame(probeFrame);
}

function probeEnd(now: number): void {
    probe.active = false;

    if (probe.travelled < 600 && probe.stuckFrames === 0) {
        return;
    }

    const samples = probe.samples;
    const last = samples[samples.length - 1];
    const tail = samples.find((sample) => last && last.time - sample.time <= 80) ?? last;
    const endSpeed =
        last && tail && last.time > tail.time ? Math.abs(last.top - tail.top) / (last.time - tail.time) : 0;
    const seconds = Math.max(1, probe.lastEvent - probe.start) / 1000;
    post({
        type: "log",
        message:
            `diff.scroll ${Math.round(probe.travelled)}px in ${Math.round(seconds * 1000)}ms (${Math.round(probe.travelled / seconds)} px/s), ` +
            `wheel ${Math.round(probe.wheel)}px in ${probe.wheelEvents} events, ${probe.scrollEvents} scroll events, ` +
            `frames ${probe.frames} (max gap ${Math.round(probe.maxGap)}ms, ${probe.slowFrames} over 34ms), stuck ${probe.stuckFrames}, ` +
            `corrections ${probe.corrections}, end speed ${endSpeed.toFixed(2)} px/ms, items on page ${probe.renderedMax}, ${files.length} files` +
            `${now - probe.lastEvent > 1000 ? " (ended late)" : ""}`,
    });
}

host.addEventListener(
    "wheel",
    (event) => {
        const now = performance.now();

        if (!probe.active) {
            probeBegin(now);
        }

        probe.lastEvent = now;
        probe.wheel += Math.abs(event.deltaY);
        probe.wheelEvents += 1;
        probe.wheelSinceFrame += Math.abs(event.deltaY) > 0 ? 1 : 0;
    },
    { passive: true }
);

host.addEventListener(
    "scroll",
    () => {
        const now = performance.now();

        if (!probe.active) {
            probeBegin(now);
        }

        const top = host.scrollTop;
        probe.lastEvent = now;
        probe.scrollEvents += 1;
        probe.travelled += Math.abs(top - probe.lastTop);
        probe.lastTop = top;
        probe.samples.push({ time: now, top });

        if (probe.samples.length > 40) {
            probe.samples.shift();
        }
    },
    { passive: true }
);

// MARK: scrolling to a file or a line

/**
 * Scrolls to a file or a line with a short glide. A far target is first reached with an instant
 * scroll that measures where it is, then the view steps back a screen and a half and glides the
 * rest: the direction shows, and a jump across 300 files costs no more than a jump across one
 * (a glide over the whole distance would lay out every file on the way).
 */
function glideTo(target: CodeViewItemScrollTarget | CodeViewLineScrollTarget): void {
    const start = viewer.getScrollTop();
    const viewport = viewer.getHeight();
    viewer.scrollTo({ ...target, behavior: "instant" });
    viewer.render(true);
    const destination = viewer.getScrollTop();
    const distance = destination - start;

    if (Math.abs(distance) < 1) {
        return;
    }

    const lead = Math.min(Math.abs(distance), viewport * 1.5);
    viewer.scrollTo({ type: "position", position: destination - Math.sign(distance) * lead, behavior: "instant" });
    viewer.render(true);
    const leadTop = viewer.getScrollTop();
    viewer.scrollTo({ ...target, behavior: "smooth" });
    // A window WebKit does not paint (a snapshot's, one behind other windows) runs few or no
    // animation frames, so the glide stalls on its way and the view stayed short of the line (an
    // Activity "Open in the diff" snapshot: lines 122-171 for a thread on 218; a log: 0→2986 stopped
    // at 2022). Still on the glide's path after its time: land at once. A view the user scrolled
    // elsewhere meanwhile is left alone.
    const low = Math.min(leadTop, destination) - 1;
    const high = Math.max(leadTop, destination) + 1;
    window.setTimeout(() => {
        const now = viewer.getScrollTop();

        if (Math.abs(now - destination) >= 1 && now >= low && now <= high) {
            post({
                type: "log",
                message: `glide stalled at ${Math.round(now)} of ${Math.round(destination)}: landed at once`,
            });
            viewer.scrollTo({ ...target, behavior: "instant" });
            viewer.render(true);
        }
    }, 400);
}

/** A file asked for before its batch arrived; the batch that brings it scrolls there. */
let pendingReveal: string | null = null;

function applyPendingReveal(): void {
    if (pendingReveal !== null && viewer.getItem(pendingReveal)) {
        const id = pendingReveal;
        pendingReveal = null;
        viewer.scrollTo({ type: "item", id, align: "start", behavior: "instant" });
    }
}

// MARK: loading a file set

let loadGeneration = -1;
let loadProgressive = false;
let loadFresh = false;
let loadStarted = 0;
let loadParseMs = 0;
let loadBatches = 0;
let loadFirstPaint = 0;
let incomingFiles: ShownFile[] = [];
let incomingItems: CodeViewItem<AnnotationMeta>[] = [];

function addFiles(batch: FilesBatch): void {
    if (batch.first) {
        loadGeneration = batch.generation;
        // Only an empty page fills batch by batch. A new set over a shown one swaps in whole at the end:
        // the hub's PR scope changes twice on open, and refilling the same 291 files blanked the pane.
        loadProgressive = files.length === 0;
        loadFresh = batch.fresh;
        loadStarted = performance.now();
        loadParseMs = 0;
        loadBatches = 0;
        loadFirstPaint = 0;
        incomingFiles = [];
        incomingItems = [];
    } else if (batch.generation !== loadGeneration) {
        return;
    }

    const parseStart = performance.now();
    const items = batch.files.map(toItem);
    loadParseMs += performance.now() - parseStart;
    loadBatches += 1;
    const shown = batch.files.map((file) => ({ id: file.id, path: file.path }));

    if (loadProgressive) {
        files = batch.first ? shown : [...files, ...shown];

        if (batch.first) {
            viewer.setItems(items);
            viewer.render(true);
        } else {
            viewer.addItems(items);
        }
    } else {
        incomingFiles.push(...shown);
        incomingItems.push(...items);

        if (batch.last) {
            files = incomingFiles;
            viewer.setItems(incomingItems);
            // Now, not at the next frame: setItems takes the old rows off at once, so a frame that
            // comes late (a window nobody sees gets none at all) would show an empty pane.
            viewer.render(true);
            incomingFiles = [];
            incomingItems = [];

            // A new scope starts at its first file; a refresh of the same diff keeps its place.
            if (loadFresh) {
                viewer.scrollTo({ type: "position", position: 0, behavior: "instant" });
            }
        }
    }

    const onScreen = loadProgressive ? batch.first : batch.last;

    if (onScreen) {
        post({ type: "rendered", count: batch.total, generation: batch.generation });
        const shownAt = performance.now();
        requestAnimationFrame(() =>
            requestAnimationFrame(() => {
                loadFirstPaint = performance.now() - loadStarted;
                post({
                    type: "log",
                    message: `diff.firstPaint ${Math.round(loadFirstPaint)}ms after the first batch (${Math.round(performance.now() - shownAt)}ms of frames)`,
                });
            })
        );
    }

    applyPendingReveal();

    if (batch.last) {
        const ids = new Set(files.map((file) => file.id));

        for (const id of parsed.keys()) {
            if (!ids.has(id)) {
                parsed.delete(id);
            }
        }

        post({
            type: "log",
            message: `diff.files ${batch.total} files in ${loadBatches} batches, ${loadProgressive ? "shown as they came" : "swapped in at the end"}: parse ${Math.round(loadParseMs)}ms, all on the page ${Math.round(performance.now() - loadStarted)}ms`,
        });
        refreshFind();
    }
}

// MARK: bridge

window.genesisDiff = {
    addFiles(batch) {
        try {
            addFiles(batch);
        } catch (error) {
            post({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
    },
    setComments(next) {
        const touched = [...comments, ...next].map((comment) => comment.fileId);
        comments = next;
        refreshAnnotations(touched.filter((id) => files.some((file) => file.id === id)));
    },
    threadDone({ id, ok }) {
        busyThreads.delete(id);
        const box = threadBoxes.get(id);

        if (box) {
            if (ok) {
                threadBoxes.delete(id);
            } else {
                box.sending = false;
            }
        }

        refreshCard(id);
    },
    setOptions(next) {
        options = { ...options, ...next };
        // pierre reads these CSS variables inside its shadow roots; they inherit from the host.
        host.style.setProperty("--diffs-font-size", `${options.fontSize}px`);
        host.style.setProperty("--diffs-line-height", `${Math.round(options.fontSize * 1.55)}px`);
        viewer.setOptions(viewOptions());
    },
    reveal(id) {
        if (!viewer.getItem(id)) {
            pendingReveal = id;
            return;
        }

        pendingReveal = null;
        glideTo({ type: "item", id, align: "start" });
    },
    find() {
        openFind();
    },
    setSelection(ids) {
        const changed = [...selectedThreads, ...ids].filter((id) => selectedThreads.has(id) !== ids.includes(id));
        selectedThreads.clear();

        for (const id of ids) {
            selectedThreads.add(id);
        }

        const touched = filesOfThreads(changed);
        refreshAnnotations(touched);

        if (touched.length) {
            // The redraw would wait for an animation frame, and a window that is not on screen (the
            // hub's hidden tab, a snapshot) gets none: the card kept its old box.
            viewer.render(true);
        }

        post({
            type: "log",
            message: `diff.selection ${ids.length} selected, ${changed.length} changed, ${touched.length} cards redrawn`,
        });
    },
    focusThread({ id, reply }) {
        const previous = focusedCard;
        focusedCard = id;
        const card = comments.find((comment) => comment.id === id);
        const touched = [previous, id].flatMap((cardId) => comments.filter((comment) => comment.id === cardId));

        if (card) {
            const file = files.find((candidate) => candidate.id === card.fileId);

            if (file && folded.has(file.path)) {
                toggleFold(file.path);
            }

            // A resolved card is one folded line: open it, so the mark shows the thread.
            expandedThreads.add(card.id);

            if (reply && card.live?.canReply && !threadBoxes.has(card.id)) {
                threadBoxes.set(card.id, { kind: "reply", body: "", sending: false });
            }
        }

        refreshAnnotations(touched.map((comment) => comment.fileId));

        if (card) {
            glideTo({ type: "line", id: card.fileId, lineNumber: card.endLine, side: card.side, align: "center" });
            post({ type: "focusFile", fileId: card.fileId });
        }
    },
    showKeys(show) {
        showKeys(show);
    },
    setBlame(next) {
        blame = next;
        blameShown = null;
        // An empty set (the files changed) asks again on the next hover; a request still running is
        // asked again too, and Swift drops the duplicate.
        blameAsked = new Set(next.loaded);
    },
    showBlameAt({ fileId, line }) {
        // A `--snapshot --blame` run has no pointer: scroll to the line and show its tip there.
        const index = blameSourceAt(fileId, line);
        glideTo({ type: "line", id: fileId, lineNumber: line, side: "additions", align: "center" });

        if (index !== null) {
            showBlameTip(index, new DOMRect(40, window.innerHeight / 2, 600, 20));
        }
    },
};

window.addEventListener("error", (event) => {
    // A benign layout notice every browser emits during resize bursts, not a failure.
    if (event.message.includes("ResizeObserver loop")) {
        return;
    }

    post({ type: "error", message: event.message });
});

post({ type: "ready" });
