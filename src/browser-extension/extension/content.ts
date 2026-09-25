import type { HostResponse } from "../lib/host/messages";
import { type ForgePage, parseForgeUrl } from "../lib/page-url";
import { ext } from "./chrome";
import { contextAt, type DomContext, headBranch } from "./content-dom";
import { callHost, isMenuMessage, isRecord, type MenuItem } from "./shared/bridge";
import { el, shadowMount } from "./shared/theme";

const MARK = "genesisToolsContent";
const URL_POLL_MS = 1000;
/** A keyboard selection (Shift+arrows, select all) shows its actions once it rests this long. */
const SELECTION_SETTLE_MS = 300;

/**
 * Result card: one at a time, top right. It is a named, non-modal dialog: focus moves to its
 * Close button when it opens and goes back to where it was when it closes, and its status line
 * is a live region, so the pending state and the async result are announced.
 */
class Card {
    private readonly root = shadowMount("genesis-tools-card");
    private box: HTMLElement | null = null;
    private returnFocus: HTMLElement | null = null;

    show(title: string, status: string): { body: HTMLElement; statusLine: HTMLElement } {
        // A card replacing another keeps the focus target the first one saved.
        const previous = this.box ? this.returnFocus : document.activeElement;
        this.close(false);
        this.returnFocus = previous instanceof HTMLElement ? previous : null;
        const statusLine = el("div", { className: "gt-muted", text: status });
        statusLine.setAttribute("role", "status");
        statusLine.setAttribute("aria-live", "polite");
        const close = el("button", { className: "gt-btn", text: "Close" });
        close.type = "button";
        close.addEventListener("click", () => this.close());
        const body = el("div", {});
        this.box = el("div", { className: "gt-surface" }, [
            el("div", { className: "gt-row" }, [
                el("span", { className: "gt-title" }, [
                    el("span", { className: "mark", text: "GT " }),
                    document.createTextNode(title),
                ]),
                el("span", { text: " " }),
                close,
            ]),
            statusLine,
            body,
        ]);
        Object.assign(this.box.style, {
            position: "fixed",
            top: "72px",
            right: "18px",
            width: "min(520px, 42vw)",
            maxHeight: "70vh",
            overflow: "auto",
            padding: "12px 14px",
            display: "grid",
            gap: "8px",
            zIndex: "2147483646",
        });
        this.box.setAttribute("role", "dialog");
        this.box.setAttribute("aria-modal", "false");
        this.box.setAttribute("aria-label", `GenesisTools: ${title}`);
        this.box.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                this.close();
            }
        });
        this.root.append(this.box);
        close.focus();
        return { body, statusLine };
    }

    async run(title: string, pending: string, call: () => Promise<HostResponse>, render: (data: unknown) => string) {
        const { body, statusLine: status } = this.show(title, pending);
        const reply = await call();

        if (!body.isConnected) {
            return;
        }

        if (reply.ok) {
            status.className = "gt-ok";
            status.textContent = "Done";
            body.append(el("pre", { className: "gt-pre", text: render(reply.data) }));
            return;
        }

        status.className = reply.code === "unavailable" ? "gt-muted" : "gt-error";
        status.textContent = reply.code === "unavailable" ? "Not available yet" : `Failed (${reply.code})`;
        body.append(el("pre", { className: "gt-pre", text: reply.error }));
    }

    close(restoreFocus = true): void {
        const wasOpen = this.box !== null;
        this.box?.remove();
        this.box = null;

        if (restoreFocus && wasOpen) {
            this.returnFocus?.focus();
            this.returnFocus = null;
        }
    }
}

function text(data: unknown, key: string): string {
    return isRecord(data) && typeof data[key] === "string" ? data[key] : "";
}

function start(): void {
    if (document.documentElement.dataset[MARK]) {
        return;
    }

    document.documentElement.dataset[MARK] = "1";
    const card = new Card();
    const dockRoot = shadowMount("genesis-tools-dock");
    const selectionRoot = shadowMount("genesis-tools-selection");
    let page: ForgePage | null = null;
    let lastHref = "";
    let contextTarget: Element | null = null;

    const pageParams = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        url: location.href,
        branch: page?.view === "pr" ? headBranch(document) : undefined,
        ...extra,
    });

    const review = () =>
        card.run(
            "Review with agent",
            "Starting an agent session in the local checkout...",
            () => callHost("review.start", pageParams()),
            (data) =>
                `Session: ${text(data, "detail")}\nCheckout: ${text(data, "root")}\nThe proposal arrives in the GenesisTools.app review window. Nothing is posted from here.`
        );

    const openFile = (ctx: DomContext) =>
        card.run(
            "Open locally",
            "Opening...",
            () => callHost("open.file", pageParams({ path: ctx.path, line: ctx.line })),
            (data) => `${text(data, "detail")}\n${text(data, "file") || text(data, "root")}`
        );

    const openTerminal = () =>
        card.run(
            "Terminal",
            "Opening a terminal at the checkout...",
            () => callHost("open.terminal", pageParams()),
            (data) => text(data, "detail")
        );

    const explain = (hunk: string, ctx: DomContext) =>
        card.run(
            "Explain this hunk",
            "Asking the local agent (this can take a minute)...",
            () => callHost("hunk.explain", pageParams({ hunk, path: ctx.path, line: ctx.line })),
            (data) => text(data, "answer")
        );

    const renderDock = () => {
        dockRoot.querySelector(".gt-surface")?.remove();

        if (!page) {
            return;
        }

        const buttons: HTMLElement[] = [];
        // A dock button waits for its host call: a second click would start the same command again.
        const guarded = (button: HTMLButtonElement, run: () => Promise<void>) => {
            button.addEventListener("click", async () => {
                button.disabled = true;

                try {
                    await run();
                } finally {
                    button.disabled = false;
                }
            });
        };

        if (page.view === "pr") {
            const button = el("button", { className: "gt-btn primary", text: "Review with agent" });
            guarded(button, review);
            buttons.push(button);
        }

        if (page.view === "blob") {
            const button = el("button", { className: "gt-btn", text: "Open locally" });
            guarded(button, () => openFile({ line: page?.line }));
            buttons.push(button);
        }

        const terminal = el("button", {
            className: "gt-btn",
            text: "Terminal",
            title: "Open the local checkout in a terminal",
        });
        guarded(terminal, openTerminal);
        buttons.push(terminal);
        const dock = el("div", { className: "gt-surface gt-row" }, [
            el("span", { className: "gt-title" }, [el("span", { className: "mark", text: "GT" })]),
            ...buttons,
        ]);
        Object.assign(dock.style, {
            position: "fixed",
            right: "18px",
            bottom: "18px",
            padding: "6px 8px",
            zIndex: "2147483645",
        });
        dockRoot.append(dock);
    };

    const refresh = () => {
        if (location.href === lastHref) {
            return;
        }

        lastHref = location.href;
        page = parseForgeUrl(location.href, [location.host]);
        renderDock();
    };

    const hideSelection = () => selectionRoot.querySelector(".gt-surface")?.remove();

    const showSelection = () => {
        hideSelection();
        const selection = document.getSelection();
        const selected = selection?.toString() ?? "";

        if (!page || page.view === "project" || !selection || selection.isCollapsed || selected.trim().length < 3) {
            return;
        }

        const anchor =
            selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
        const ctx = contextAt(anchor ?? null);
        const rect = selection.getRangeAt(0).getBoundingClientRect();
        const explainButton = el("button", { className: "gt-btn primary", text: "Explain" });
        explainButton.addEventListener("mousedown", (event) => event.preventDefault());
        explainButton.addEventListener("click", () => {
            hideSelection();
            void explain(selected, ctx);
        });
        const openButton = el("button", { className: "gt-btn", text: "Open locally" });
        openButton.addEventListener("mousedown", (event) => event.preventDefault());
        openButton.addEventListener("click", () => {
            hideSelection();
            void openFile(ctx);
        });
        const bar = el("div", { className: "gt-surface gt-row" }, [explainButton, openButton]);
        Object.assign(bar.style, {
            position: "fixed",
            left: `${Math.max(8, rect.left)}px`,
            top: `${Math.max(8, rect.top - 44)}px`,
            padding: "4px",
            zIndex: "2147483647",
        });
        selectionRoot.append(bar);
    };

    let pointerDown = false;
    let selectionTimer: ReturnType<typeof setTimeout> | undefined;
    document.addEventListener("mousedown", () => {
        pointerDown = true;
    });
    document.addEventListener("mouseup", () => {
        pointerDown = false;
        clearTimeout(selectionTimer);
        setTimeout(showSelection, 0);
    });
    // Keyboard selections have no mouseup. A mouse drag also changes the selection on every step,
    // so those changes wait for its mouseup above.
    document.addEventListener("selectionchange", () => {
        clearTimeout(selectionTimer);

        if (!pointerDown) {
            selectionTimer = setTimeout(showSelection, SELECTION_SETTLE_MS);
        }
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            hideSelection();
            card.close();
        }
    });
    document.addEventListener("contextmenu", (event) => {
        contextTarget = event.target instanceof Element ? event.target : null;
    });

    ext.runtime.onMessage.addListener((message) => {
        if (!isMenuMessage(message)) {
            return undefined;
        }

        const ctx = contextAt(contextTarget);
        const handlers: Record<MenuItem, () => Promise<void>> = {
            "open-file": () => openFile(ctx),
            "open-terminal": openTerminal,
            // The menu's selectionText collapses newlines; the live selection keeps the diff's shape.
            explain: () => explain(document.getSelection()?.toString() || message.selectionText || "", ctx),
            review,
        };
        void handlers[message.item]();
        return undefined;
    });

    refresh();
    setInterval(refresh, URL_POLL_MS);
}

start();
