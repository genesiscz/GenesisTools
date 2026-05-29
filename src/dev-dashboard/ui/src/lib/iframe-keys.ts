/**
 * Inject keystrokes / scroll commands into an embedded ttyd iframe.
 *
 * ttyd uses xterm.js under the hood with a hidden `.xterm-helper-textarea`
 * that captures real keyboard input. To simulate Esc/Tab/Arrow/PageUp from
 * a virtual mobile keybar in the parent page we:
 *   1. resolve the iframe's helper textarea (same-origin via the front-proxy),
 *   2. focus it so the resulting keydown lands on the active terminal,
 *   3. dispatch a synthetic KeyboardEvent — xterm.js doesn't check
 *      `event.isTrusted`, so the standard handler picks it up and writes
 *      the right ESC sequence to the websocket.
 *
 * Scrollback in tmux attach sessions uses xterm's alternate buffer — scrollLines
 * is a no-op there. Real mouse wheel works via coreMouseService.triggerMouseEvent
 * (SGR wheel buttons). The front-proxy injects __ddTtydScroll into ttyd HTML to
 * mirror that path; the parent calls it directly or via postMessage.
 */

export type IframeKey = "Escape" | "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "PageUp" | "PageDown";

const KEY_TABLE: Record<IframeKey, { key: string; code: string; keyCode: number }> = {
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

interface TtydIframeWindow extends Window {
    __ddTtydScroll?: (lines: number) => boolean;
    __ddTtydScrollPage?: (direction: -1 | 1) => boolean;
    __ddTtydPaste?: (text: string) => boolean;
}

function getHelperTextarea(iframe: HTMLIFrameElement): HTMLTextAreaElement | null {
    try {
        return iframe.contentDocument?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ?? null;
    } catch {
        return null;
    }
}

function dispatchKey(target: HTMLElement, key: IframeKey, shiftKey = false): boolean {
    const spec = KEY_TABLE[key];
    target.focus();
    const event = new KeyboardEvent("keydown", {
        key: spec.key,
        code: spec.code,
        keyCode: spec.keyCode,
        which: spec.keyCode,
        shiftKey,
        bubbles: true,
        cancelable: true,
    });
    return target.dispatchEvent(event);
}

export function sendKeyToIframe(iframe: HTMLIFrameElement | null, key: IframeKey): boolean {
    if (!iframe) {
        return false;
    }

    const textarea = getHelperTextarea(iframe);
    if (!textarea) {
        return false;
    }

    return dispatchKey(textarea, key);
}

function scrollViaPostMessage(contentWindow: TtydIframeWindow, amount: number): void {
    contentWindow.postMessage({ type: "dd-ttyd-scroll", lines: amount }, "*");
}

/**
 * Scrolls the terminal scrollback. Positive = down (newer), negative = up (older).
 */
export function scrollIframeTerminal(iframe: HTMLIFrameElement | null, amount: number): boolean {
    if (!iframe || amount === 0) {
        return false;
    }

    try {
        const contentWindow = iframe.contentWindow as TtydIframeWindow | null;

        if (!contentWindow) {
            return false;
        }

        if (typeof contentWindow.__ddTtydScroll === "function") {
            return contentWindow.__ddTtydScroll(amount);
        }

        scrollViaPostMessage(contentWindow, amount);
        return true;
    } catch {
        return false;
    }
}

/**
 * Outcome of a paste attempt. The clipboard read happens in the *parent*
 * document (top-level secure context + user gesture), so the failure modes are
 * all about clipboard availability — never about the terminal itself.
 *  - `no-clipboard-api`: insecure context (plain http://LAN) — `navigator.clipboard` is undefined.
 *  - `denied`: permission refused, or a browser that gates `readText` (Firefox).
 *  - `empty`: clipboard had no text to paste.
 */
export type PasteResult = { ok: true } | { ok: false; reason: "no-iframe" | "no-clipboard-api" | "denied" | "empty" };

/**
 * Inject an already-known string into the terminal — no clipboard read.
 * This is the path the manual paste dialog uses: the text comes from a real
 * OS paste into a parent-page textarea, which needs no clipboard permission
 * (the reliable route on iOS/Safari where `readText()` is denied).
 */
export function pasteTextToIframe(iframe: HTMLIFrameElement | null, text: string): boolean {
    if (!iframe || !text) {
        return false;
    }

    try {
        const contentWindow = iframe.contentWindow as TtydIframeWindow | null;

        if (!contentWindow) {
            return false;
        }

        if (typeof contentWindow.__ddTtydPaste === "function") {
            return contentWindow.__ddTtydPaste(text);
        }

        contentWindow.postMessage({ type: "dd-ttyd-paste", text }, "*");
        return true;
    } catch {
        return false;
    }
}

/**
 * Read the parent-page clipboard and inject it into the embedded terminal.
 * Resolves with a structured result so the caller can surface a one-line hint
 * (e.g. "clipboard needs HTTPS/localhost") instead of a silent no-op.
 */
export async function pasteToIframe(iframe: HTMLIFrameElement | null): Promise<PasteResult> {
    if (!iframe) {
        return { ok: false, reason: "no-iframe" };
    }

    const clipboard = navigator.clipboard;
    if (!clipboard || typeof clipboard.readText !== "function") {
        return { ok: false, reason: "no-clipboard-api" };
    }

    let text: string;
    try {
        text = await clipboard.readText();
    } catch {
        return { ok: false, reason: "denied" };
    }

    if (!text) {
        return { ok: false, reason: "empty" };
    }

    pasteTextToIframe(iframe, text);
    return { ok: true };
}

function scrollPageViaPostMessage(contentWindow: TtydIframeWindow, direction: -1 | 1): void {
    contentWindow.postMessage({ type: "dd-ttyd-scroll-page", direction }, "*");
}

/** Scroll roughly one visible screen of scrollback up or down. */
export function scrollIframeTerminalByPage(iframe: HTMLIFrameElement | null, direction: -1 | 1): boolean {
    if (!iframe) {
        return false;
    }

    try {
        const contentWindow = iframe.contentWindow as TtydIframeWindow | null;

        if (!contentWindow) {
            return false;
        }

        if (typeof contentWindow.__ddTtydScrollPage === "function") {
            return contentWindow.__ddTtydScrollPage(direction);
        }

        scrollPageViaPostMessage(contentWindow, direction);
        return true;
    } catch {
        return false;
    }
}
