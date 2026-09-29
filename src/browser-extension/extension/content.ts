import type { HostResponse } from "../lib/host/messages";
import { type ForgePage, parseForgeUrl } from "../lib/page-url";
import { ext } from "./chrome";
import {
    checkoutCache,
    contextAt,
    type DomContext,
    headBranch,
    menuTargetContext,
    quickCardMayClose,
    surfaceHoldsFocus,
} from "./content-dom";
import { callHost, isMenuMessage, isRecord, type MenuItem } from "./shared/bridge";
import { chip, el, shadowMount } from "./shared/theme";

const MARK = "genesisToolsContent";
const URL_POLL_MS = 1000;
/** A keyboard selection (Shift+arrows, select all) shows its actions once it rests this long. */
const SELECTION_SETTLE_MS = 300;
/** A quick action's card (the hub came forward, a terminal opened) closes itself after this long. */
const QUICK_CARD_MS = 2600;
const COMPACT_KEY = "dockCompact";

/**
 * Result card: one at a time, top right. It is a named, non-modal dialog: focus moves to its
 * Close button when it opens and goes back to where it was when it closes, and its status line
 * is a live region, so the pending state and the async result are announced.
 */
class Card {
    private readonly root = shadowMount("genesis-tools-card");
    private box: HTMLElement | null = null;
    private returnFocus: HTMLElement | null = null;
    private closeTimer: ReturnType<typeof setTimeout> | undefined;

    /** A quick result is a status toast: it is announced (role=status) but does not take the focus. */
    show(title: string, status: string, { takeFocus = true }: { takeFocus?: boolean } = {}) {
        // A card replacing another keeps the focus target the first one saved.
        const previous = this.box ? this.returnFocus : document.activeElement;
        this.close(false);
        this.returnFocus = previous instanceof HTMLElement ? previous : null;
        const statusLine = el("div", { className: "gt-muted", text: status });
        statusLine.setAttribute("role", "status");
        statusLine.setAttribute("aria-live", "polite");
        let state = chip("working", "busy");
        const copy = el("button", { className: "gt-btn ghost", text: "Copy", title: "Copy the result" });
        copy.type = "button";
        copy.hidden = true;
        const close = el("button", { className: "gt-btn ghost", text: "Close", title: "Close (Esc)" });
        close.type = "button";
        close.addEventListener("click", () => this.close());
        const header = el("div", { className: "gt-row" }, [
            el("span", { className: "gt-mark", text: "GT" }),
            el("span", { className: "gt-title", text: title }),
            el("span", { className: "gt-spacer" }),
            state,
            copy,
            close,
        ]);
        const body = el("div", {});
        this.box = el("div", { className: "gt-surface gt-enter" }, [header, statusLine, body]);
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
        // Hovering or focusing the card keeps a quick result on screen.
        this.box.addEventListener("pointerenter", () => clearTimeout(this.closeTimer));
        this.box.addEventListener("focusin", () => clearTimeout(this.closeTimer));
        this.root.append(this.box);

        if (takeFocus) {
            close.focus();
        }

        const settle = (label: string, tone: "ok" | "err" | "idle") => {
            const next = chip(label, tone);
            state.replaceWith(next);
            state = next;
        };
        const offerCopy = (value: string) => {
            copy.hidden = false;
            copy.onclick = async () => {
                await navigator.clipboard.writeText(value);
                copy.textContent = "Copied";
                setTimeout(() => {
                    copy.textContent = "Copy";
                }, 1200);
            };
        };
        return { body, statusLine, settle, offerCopy };
    }

    async run(
        title: string,
        pending: string,
        call: () => Promise<HostResponse>,
        render: (data: unknown) => string,
        { quick = false }: { quick?: boolean } = {}
    ) {
        const view = this.show(title, pending, { takeFocus: !quick });
        const reply = await call();

        if (!view.body.isConnected) {
            return;
        }

        view.statusLine.textContent = "";

        if (reply.ok) {
            const shown = render(reply.data);
            view.settle("done", "ok");
            view.body.append(el("pre", { className: "gt-pre", text: shown }));

            if (quick) {
                if (this.box && quickCardMayClose(this.box, this.root.activeElement)) {
                    this.closeTimer = setTimeout(() => this.close(), QUICK_CARD_MS);
                }
            } else {
                view.offerCopy(shown);
            }

            return;
        }

        const label =
            reply.code === "no-checkout" ? "no checkout" : reply.code === "unavailable" ? "unavailable" : "failed";
        view.settle(label, reply.code === "unavailable" ? "idle" : "err");
        view.body.append(el("pre", { className: "gt-pre", text: reply.error }));
        view.offerCopy(reply.error);
    }

    close(restoreFocus = true): void {
        clearTimeout(this.closeTimer);
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

function button(label: string, { primary = false, title }: { primary?: boolean; title?: string } = {}) {
    const node = el("button", { className: primary ? "gt-btn primary" : "gt-btn", text: label, title });
    node.type = "button";
    return node;
}

/** A button that waits for its host call: a second click would start the same command again. */
function guarded(node: HTMLButtonElement, run: () => Promise<void>): HTMLButtonElement {
    node.addEventListener("click", async () => {
        node.disabled = true;
        node.setAttribute("aria-busy", "true");

        try {
            await run();
        } finally {
            node.disabled = false;
            node.removeAttribute("aria-busy");
        }
    });
    return node;
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
    let dockHidden = false;
    let compact = false;
    let renderToken = 0;
    const hasCheckout = checkoutCache((webBase) => callHost("checkout.resolve", { url: webBase }));

    const pageParams = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
        url: location.href,
        branch: page?.view === "pr" ? headBranch(document, page.number) : undefined,
        ...extra,
    });

    const openHub = (ctx: DomContext = {}, linkUrl?: string) => {
        const linked = linkUrl ? parseForgeUrl(linkUrl, [location.host]) : null;
        const onThisPr = !linked && page?.view === "pr";
        return card.run(
            "Open in GenesisTools",
            "Bringing the hub forward...",
            () =>
                callHost(
                    "hub.open",
                    linked ? { url: linkUrl } : pageParams({ path: onThisPr && ctx.path ? ctx.path : undefined })
                ),
            (data) => text(data, "detail"),
            { quick: true }
        );
    };

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
            (data) => `${text(data, "detail")}\n${text(data, "file") || text(data, "root")}`,
            { quick: true }
        );

    const openTerminal = () =>
        card.run(
            "Terminal",
            "Opening a terminal at the checkout...",
            () => callHost("open.terminal", pageParams()),
            (data) => text(data, "detail"),
            { quick: true }
        );

    const explain = (hunk: string, ctx: DomContext) =>
        card.run(
            "Explain this hunk",
            "Asking the local agent (this can take a minute)...",
            () => callHost("hunk.explain", pageParams({ hunk, path: ctx.path, line: ctx.line })),
            (data) => text(data, "answer")
        );

    const renderDock = async () => {
        const token = ++renderToken;
        const forge = page;
        const show = forge !== null && !dockHidden && (await hasCheckout(forge.webBase));

        if (token !== renderToken) {
            return;
        }

        const old = dockRoot.querySelector(".gt-surface");
        const hadFocus = surfaceHoldsFocus(old, dockRoot.activeElement);
        old?.remove();

        if (!show || !forge) {
            return;
        }

        const toggle = el("button", {
            className: "gt-btn ghost gt-mark",
            text: compact ? "GT" : "GT ‹",
            title: compact ? "Show the GenesisTools buttons" : "Collapse to the GT badge",
        });
        toggle.type = "button";
        toggle.setAttribute("aria-expanded", String(!compact));
        toggle.addEventListener("click", () => {
            compact = !compact;
            void ext.storage.local.set({ [COMPACT_KEY]: compact });
            void renderDock();
        });
        const items: HTMLElement[] = [toggle];

        if (!compact) {
            // A file page's first job is the editor; every other page's is the hub.
            if (forge.view === "blob") {
                const local = button("Open locally", {
                    primary: true,
                    title: "Open this file at this line in the editor",
                });
                items.push(guarded(local, () => openFile({ line: forge.line })));
            }

            const hub = button("Open in GenesisTools", {
                primary: forge.view !== "blob",
                title:
                    forge.view === "pr"
                        ? "Show this PR in the GenesisTools hub (⌥⇧G)"
                        : "Show this checkout in the GenesisTools hub (⌥⇧G)",
            });
            items.push(guarded(hub, () => openHub()));

            if (forge.view === "pr") {
                const agent = button("Review with agent", {
                    title: "Start an agent review of this PR in the local checkout",
                });
                items.push(guarded(agent, review));
            }

            items.push(guarded(button("Terminal", { title: "Open the local checkout in a terminal" }), openTerminal));
            const hide = el("button", {
                className: "gt-btn ghost",
                text: "×",
                title: "Hide until this tab reloads (the context menu and ⌥⇧G still work)",
            });
            hide.type = "button";
            hide.setAttribute("aria-label", "Hide the GenesisTools buttons");
            hide.addEventListener("click", () => {
                dockHidden = true;
                void renderDock();
            });
            items.push(hide);
        }

        const dock = el("div", { className: "gt-surface gt-row gt-enter" }, items);
        dock.setAttribute("role", "toolbar");
        dock.setAttribute("aria-label", "GenesisTools");
        Object.assign(dock.style, {
            position: "fixed",
            right: "18px",
            bottom: "18px",
            padding: "5px 6px",
            flexWrap: "nowrap",
            zIndex: "2147483645",
        });
        dockRoot.append(dock);

        if (hadFocus) {
            toggle.focus();
        }
    };

    const refresh = () => {
        if (location.href === lastHref) {
            return;
        }

        lastHref = location.href;
        page = parseForgeUrl(location.href, [location.host]);
        void renderDock();
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
        const action = (label: string, run: () => void, primary = false) => {
            const node = button(label, { primary });
            // mousedown would collapse the selection before the click reads it.
            node.addEventListener("mousedown", (event) => event.preventDefault());
            node.addEventListener("click", () => {
                hideSelection();
                run();
            });
            return node;
        };
        const actions = [
            action("Explain", () => void explain(selected, ctx), true),
            action("Open locally", () => void openFile(ctx)),
        ];

        if (page.view === "pr" && ctx.path) {
            actions.push(action("Open in review", () => void openHub(ctx)));
        }

        const bar = el("div", { className: "gt-surface gt-row gt-enter" }, actions);
        Object.assign(bar.style, {
            position: "fixed",
            left: `${Math.max(8, rect.left)}px`,
            top: `${Math.max(8, rect.top - 44)}px`,
            padding: "4px",
            flexWrap: "nowrap",
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

        const ctx = menuTargetContext<DomContext>(message, () => contextAt(contextTarget), {});
        // One right-click, one menu entry: a later shortcut or entry must not reuse this element.
        contextTarget = null;
        const handlers: Record<MenuItem, () => Promise<void>> = {
            "open-hub": () => openHub(ctx, message.linkUrl),
            "open-file": () => openFile(ctx),
            "open-terminal": openTerminal,
            // The menu's selectionText collapses newlines; the live selection keeps the diff's shape.
            explain: () => explain(document.getSelection()?.toString() || message.selectionText || "", ctx),
            review,
        };
        void handlers[message.item]();
        return undefined;
    });

    // The first render waits for the saved collapsed state, so the dock never flashes open and shut.
    void ext.storage.local
        .get([COMPACT_KEY])
        .then((saved) => {
            compact = saved[COMPACT_KEY] === true;
        })
        .catch((error: unknown) => {
            console.warn("[genesis-tools] reading the dock state failed", error);
        })
        .finally(refresh);
    setInterval(refresh, URL_POLL_MS);
}

start();
