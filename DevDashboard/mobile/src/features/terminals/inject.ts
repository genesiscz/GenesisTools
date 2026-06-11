import type { TerminalKey } from "@/features/terminals/TerminalRenderer";

/**
 * `injectJavaScript` builders for Driver A (the ttyd page loaded directly in a `<WebView>`). Ported
 * from the web dashboard's `src/dev-dashboard/ui/src/lib/iframe-keys.ts` — but Driver A loads ttyd
 * *as the page* (not a cross-origin iframe), so the JS runs in the page's OWN context: it resolves
 * `.xterm-helper-textarea` directly and dispatches a synthetic `KeyboardEvent` (xterm.js doesn't
 * check `event.isTrusted`, so its handler writes the right ESC sequence to the ttyd WS). Scroll
 * reuses the server-injected `window.__ddTtydScroll` / `__ddTtydScrollPage` that `injectTtydMobileShell`
 * already defines in the ttyd HTML, so Driver A inherits the same wheel-event scrollback path.
 */

interface KeySpec {
    key: string;
    code: string;
    keyCode: number;
}

const KEY_TABLE: Record<TerminalKey, KeySpec> = {
    Escape: { key: "Escape", code: "Escape", keyCode: 27 },
    Tab: { key: "Tab", code: "Tab", keyCode: 9 },
    ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
    ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
    ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
    ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
    PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
    PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

/** Dispatch a synthetic keydown for a NAMED key against the ttyd page's xterm helper textarea. */
export function injectKey(key: TerminalKey, mods: { shift?: boolean; ctrl?: boolean; alt?: boolean } = {}): string {
    const spec = KEY_TABLE[key];

    return `(function(){
        var ta=document.querySelector(".xterm-helper-textarea");
        if(!ta){return;}
        ta.focus();
        ta.dispatchEvent(new KeyboardEvent("keydown",{
            key:${str(spec.key)},code:${str(spec.code)},keyCode:${spec.keyCode},which:${spec.keyCode},
            shiftKey:${!!mods.shift},ctrlKey:${!!mods.ctrl},altKey:${!!mods.alt},
            bubbles:true,cancelable:true
        }));
    })();true;`;
}

/** Type a raw string into the ttyd terminal (Paste / printable key-bar keys). */
export function injectText(text: string): string {
    return `(function(){
        var ta=document.querySelector(".xterm-helper-textarea");
        if(!ta){return;}
        ta.focus();
        ta.dispatchEvent(new InputEvent("input",{data:${str(text)},inputType:"insertText",bubbles:true}));
    })();true;`;
}

/** Scroll the ttyd scrollback via the server-injected helper (positive = newer/down). */
export function injectTtydScroll(lines: number): string {
    return `window.__ddTtydScroll&&window.__ddTtydScroll(${Math.trunc(lines)});true;`;
}

/** Scroll roughly one screen up (-1) or down (1) via the server-injected helper. */
export function injectTtydScrollPage(direction: -1 | 1): string {
    return `window.__ddTtydScrollPage&&window.__ddTtydScrollPage(${direction});true;`;
}

/** Focus the ttyd terminal so the iOS keyboard rises. */
export function injectTtydFocus(): string {
    return `(function(){var ta=document.querySelector(".xterm-helper-textarea");ta&&ta.focus();})();true;`;
}

/** JSON-encode a string for safe inlining inside an injected JS source literal. */
function str(value: string): string {
    return JSON.stringify(value);
}
