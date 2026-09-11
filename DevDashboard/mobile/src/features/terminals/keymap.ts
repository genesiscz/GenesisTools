import type { TerminalKey, TerminalKeyMods } from "@/features/terminals/TerminalRenderer";

/**
 * Pure terminal key → byte-sequence mapping. The mobile key bar can't dispatch real DOM keyboard
 * events to a self-opened WS (Driver B), so it sends the raw escape sequences directly. Driver A
 * (ttyd page) dispatches synthetic key events instead (see `inject.ts`); this table is the single
 * source of truth for what each named key/modifier MEANS, kept pure so it's unit-testable with no
 * RN/WebView in scope.
 *
 * References: VT100/xterm CSI sequences. Arrows → `ESC [ A/B/C/D`, PageUp/Down → `ESC [ 5~/6~`,
 * Esc → `ESC` (0x1b), Tab → `\t`. Ctrl+<letter> → the control code `c & 0x1f` (Ctrl-C → 0x03 ETX).
 */

const ESC = "\x1b";

const NAMED_KEY_BYTES: Record<TerminalKey, string> = {
    Escape: ESC,
    Tab: "\t",
    ArrowUp: `${ESC}[A`,
    ArrowDown: `${ESC}[B`,
    ArrowRight: `${ESC}[C`,
    ArrowLeft: `${ESC}[D`,
    PageUp: `${ESC}[5~`,
    PageDown: `${ESC}[6~`,
};

/** A printable character with Ctrl held → its ASCII control code (Ctrl-C → 0x03). */
function ctrlByte(char: string): string {
    const code = char.toUpperCase().charCodeAt(0);

    return String.fromCharCode(code & 0x1f);
}

/**
 * Resolve a key press to the bytes ttyd expects. `key` is either a named TerminalKey or a single
 * printable character (e.g. `"c"` for the Ctrl modifier row). `mods.ctrl` on a single character
 * yields the control code; `mods.alt` prefixes ESC (xterm meta convention).
 */
export function keyToBytes(key: TerminalKey | string, mods: TerminalKeyMods = {}): string {
    if (mods.ctrl && key.length === 1) {
        return ctrlByte(key);
    }

    const named = (NAMED_KEY_BYTES as Record<string, string | undefined>)[key];
    const bytes = named ?? key;

    if (mods.alt) {
        return `${ESC}${bytes}`;
    }

    return bytes;
}

/** True when `key` is one of the named TerminalKeys (vs. a printable character). */
export function isNamedKey(key: string): key is TerminalKey {
    return key in NAMED_KEY_BYTES;
}
