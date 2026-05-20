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
 * For scrollback we prefer xterm.js's own `scrollLines()` when ttyd exposes
 * the terminal instance globally (faster + jank-free), and fall back to
 * Shift+PageUp/PageDown keydowns which xterm.js binds by default.
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

interface XtermTerminal {
    scrollLines?: (amount: number) => void;
    focus?: () => void;
}

interface XtermWindow extends Window {
    term?: XtermTerminal;
}

function getHelperTextarea(iframe: HTMLIFrameElement): HTMLTextAreaElement | null {
    try {
        return iframe.contentDocument?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ?? null;
    } catch {
        return null;
    }
}

function getXtermInstance(iframe: HTMLIFrameElement): XtermTerminal | null {
    try {
        const w = iframe.contentWindow as XtermWindow | null;
        return w?.term ?? null;
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

/**
 * Scrolls the terminal's scrollback buffer. Positive amount = down, negative = up.
 * Prefers xterm's native scrollLines API; falls back to Shift+PageUp/Down.
 */
export function scrollIframeTerminal(iframe: HTMLIFrameElement | null, amount: number): boolean {
    if (!iframe || amount === 0) {
        return false;
    }

    const term = getXtermInstance(iframe);
    if (term?.scrollLines) {
        term.scrollLines(amount);
        return true;
    }

    const textarea = getHelperTextarea(iframe);
    if (!textarea) {
        return false;
    }

    const key: IframeKey = amount < 0 ? "PageUp" : "PageDown";
    return dispatchKey(textarea, key, true);
}

export function findIframeByTitle(title: string): HTMLIFrameElement | null {
    return document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);
}
