import type { TerminalDriverId } from "@/lib/storage/kv";

/**
 * Renderer-agnostic seam for the Terminals feature (D12). Both WebView drivers (A = ttyd URL,
 * B = local xterm.js HTML + WS) implement THIS one interface, so the screen drives a terminal
 * without knowing which engine paints it; the in-app switcher just swaps the active impl.
 *
 * Mirrors `DevDashboard/research/06-terminal-recommendation.md` §"swappable terminal interface"
 * (the plan-06 verified shape). The only deviation: `TerminalDriverId` is RE-USED from the
 * foundation's `src/lib/storage/kv.ts` (which already types the persisted `dd.terminalDriver`
 * pref) instead of redeclared here — that union owns `"webview-ttyd" | "webview-html" | "native"`,
 * where `"native"` is the reserved SwiftTerm escape hatch (not registered in v1).
 */

export type { TerminalDriverId };

export type TerminalKey =
    | "Escape"
    | "Tab"
    | "ArrowUp"
    | "ArrowDown"
    | "ArrowLeft"
    | "ArrowRight"
    | "PageUp"
    | "PageDown";

export interface TerminalKeyMods {
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
}

export type TerminalStatus = "idle" | "connecting" | "connected" | "disconnected" | "ended" | "error";

export type TerminalExitReason = "crash" | "remote-close" | "auth-failed" | "unknown";

export interface TerminalCallbacks {
    onData?: (chunk: Uint8Array) => void;
    onStatus?: (status: TerminalStatus, detail?: string) => void;
    onExit?: (reason: TerminalExitReason) => void;
    onSelection?: (text: string) => void;
}

export interface TerminalSession {
    /** ttyd session id (tmux/cmux sessions are surfaced through ttyd). */
    readonly id: string;
    readonly title?: string;
}

/**
 * Imperative handle the screen + key bar drive. Each WebView driver builds one of these and hands
 * it back through a React ref (`renderRef`); the screen renders `renderer.view` and calls the rest.
 */
export interface TerminalRenderer {
    attach(session: TerminalSession, cb: TerminalCallbacks): Promise<void>;
    detach(): Promise<void>;
    sendInput(text: string): void;
    sendKey(key: TerminalKey, mods?: TerminalKeyMods): void;
    paste(text: string): void;
    scroll(lines: number): void;
    scrollPage(direction: -1 | 1): void;
    fit(): void;
    resize(cols: number, rows: number): void;
    focus(): void;
    readonly status: TerminalStatus;
}
