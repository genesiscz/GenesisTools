import {
    CodeView,
    type CodeViewItem,
    type CodeViewOptions,
    type DiffLineAnnotation,
    type LineAnnotation,
    type OnDiffLineClickProps,
    type OnLineClickProps,
    parseDiffFromFile,
    type SelectedLineRange,
} from "@pierre/diffs";

/**
 * The web half of GenesisTools.app's diff renderer (PierreWebDiffRenderer.swift). Swift owns the
 * data, the comment store and the chrome; this page draws file diffs with @pierre/diffs, hosts the
 * comment composer and the comment cards, and reports every user action back.
 * Swift -> page: window.genesisDiff.setFiles / setComments / setOptions / reveal.
 * Page -> Swift: webkit.messageHandlers.genesisDiff.postMessage({ type, ... }).
 */

type Side = "additions" | "deletions";

interface BridgeFile {
    id: string;
    path: string;
    oldPath: string | null;
    oldContents: string | null;
    newContents: string | null;
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
    /** "draft" = an agent's proposed review comment with its analysis in `meta`. */
    kind?: "local" | "draft";
    severity?: string;
    meta?: { verdict: string; proof?: string; confidence?: number; reasoning?: string };
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
    setFiles(files: BridgeFile[]): void;
    setComments(comments: BridgeComment[]): void;
    setOptions(next: Partial<BridgeOptions>): void;
    reveal(id: string): void;
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

const host = document.getElementById("review");

if (!host) {
    throw new Error("diff viewer: #review host is missing");
}

let options: BridgeOptions = { diffStyle: "split", themeType: "system", wrap: false, fontSize: 13 };
let files: BridgeFile[] = [];
let comments: BridgeComment[] = [];
let composer: Composer | null = null;
const versions = new Map<string, number>();

function nextVersion(id: string): number {
    const version = (versions.get(id) ?? -1) + 1;
    versions.set(id, version);
    return version;
}

function sideOf(side: string | undefined): Side {
    return side === "deletions" ? "deletions" : "additions";
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

function viewOptions(): CodeViewOptions<AnnotationMeta, undefined> {
    return {
        theme: { light: "pierre-light", dark: "pierre-dark" },
        themeType: options.themeType,
        diffStyle: options.diffStyle,
        overflow: options.wrap ? "wrap" : "scroll",
        stickyHeaders: true,
        lineDiffType: "word-alt",
        hunkSeparators: "line-info",
        lineHoverHighlight: "both",
        enableGutterUtility: true,
        enableLineSelection: true,
        layout: { paddingTop: 12, paddingBottom: 32, gap: 12 },
        onLineClick: openOnCommandClick,
        onLineNumberClick: openOnCommandClick,
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
    };
}

const viewer = new CodeView<AnnotationMeta, undefined>(viewOptions());
viewer.setup(host);

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

function toItem(file: BridgeFile): CodeViewItem<AnnotationMeta> {
    // A missing side (new or deleted file) is empty text: parseDiffFromFile's null path throws on
    // `.split` in 1.4.3 even though its types accept null.
    const oldFile = { name: file.oldPath ?? file.path, contents: file.oldContents ?? "" };
    const newFile = { name: file.path, contents: file.newContents ?? "" };

    return {
        id: file.id,
        type: "diff",
        fileDiff: parseDiffFromFile(oldFile, newFile),
        annotations: annotationsFor(file.id),
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
    drafted: "Review draft",
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

    if (meta.reasoning) {
        const details = document.createElement("details");
        details.setAttribute("style", "margin-top:4px;color:rgba(255,255,255,.65)");
        details.appendChild(element("summary", `${css.dim};cursor:pointer`, "Reasoning"));
        details.appendChild(richText(meta.reasoning));
        box.appendChild(details);
    }

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

    if (comment.state === "rejected") {
        actions.appendChild(button("Restore", act("restore")));
    } else {
        if (comment.state === "proposed") {
            actions.appendChild(button("Accept", act("accept"), true));
        }

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
        actions.appendChild(button("Reject", act("reject")));

        // A drafted draft already has a provider review draft, and a posted one is on the PR.
        if (comment.state !== "drafted" && comment.state !== "posted") {
            actions.appendChild(
                button("Promote to draft", act("promote"), false, "Create a GitHub / GitLab review draft")
            );
        }

        if (comment.state !== "posted") {
            actions.appendChild(button("Post", act("post"), false, "Publish to the PR"));
        }
    }

    head.appendChild(actions);
    main.appendChild(head);
    main.appendChild(richText(comment.body));
    row.appendChild(main);
    wrap.appendChild(row);

    if (comment.meta) {
        wrap.appendChild(renderMeta(comment.meta));
    }

    return wrap;
}

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

function renderComment(comment: BridgeComment): HTMLElement {
    if (comment.kind === "draft") {
        return renderDraft(comment);
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

        if (!body) {
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

// MARK: bridge

window.genesisDiff = {
    setFiles(next) {
        try {
            files = next;
            viewer.setItems(files.map(toItem));
            post({ type: "rendered", count: files.length });
        } catch (error) {
            post({ type: "error", message: error instanceof Error ? error.message : String(error) });
        }
    },
    setComments(next) {
        const touched = [...comments, ...next].map((comment) => comment.fileId);
        comments = next;
        refreshAnnotations(touched.filter((id) => files.some((file) => file.id === id)));
    },
    setOptions(next) {
        options = { ...options, ...next };
        // pierre reads these CSS variables inside its shadow roots; they inherit from the host.
        host.style.setProperty("--diffs-font-size", `${options.fontSize}px`);
        host.style.setProperty("--diffs-line-height", `${Math.round(options.fontSize * 1.55)}px`);
        viewer.setOptions(viewOptions());
    },
    reveal(id) {
        viewer.scrollTo({ type: "item", id, align: "start" });
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
