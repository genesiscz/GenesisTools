import { homedir } from "node:os";
import { join } from "node:path";
import { runCmux } from "@app/cmux/lib/cli";
import type { CommandSource, ScreenSnapshot } from "@app/cmux/lib/types";
import logger from "@app/logger";

/**
 * cmux exposes no PID/tty for surfaces, but it does set tab titles from OSC-7 cwd escapes.
 * Idle shells get titles like "…/Tresors/Projects/ReservineBack" — the leading "…" stands
 * for $HOME. TUIs (claude, vim) overwrite the title with their own text, so we only treat
 * a title as a cwd when it starts with "/" or "…/".
 */
export function cwdFromTitle(title: string | undefined | null): string | undefined {
    if (!title) {
        return undefined;
    }
    const trimmed = title.trim();
    // OSC-7 / OSC-1337 titles: "user@host:/abs/path" or "user@host:~/path". The path
    // can contain spaces (use `.+$` not `\S+`), but only treat the suffix as a cwd
    // when it actually looks like a path — otherwise titles like `user@host:build`
    // would round-trip as `cd build` on restore.
    const userHostMatch = trimmed.match(/^[^\s@:]+@[^\s:]+:(.+)$/);
    if (userHostMatch) {
        const suffix = userHostMatch[1];
        if (isPathLike(suffix)) {
            return expandHome(suffix);
        }
        return undefined;
    }
    if (isPathLike(trimmed)) {
        return expandHome(trimmed);
    }
    return undefined;
}

function isPathLike(value: string): boolean {
    if (value === "~" || value === "…") {
        return true;
    }
    return value.startsWith("/") || value.startsWith("~/") || value.startsWith("…/");
}

function expandHome(path: string): string {
    if (path.startsWith("…/") || path.startsWith("~/")) {
        return join(homedir(), path.slice(2));
    }
    if (path === "~" || path === "…") {
        return homedir();
    }
    return path;
}

/**
 * Patterns we recognise as shell prompts followed by a typed command. Each pattern's
 * capture group 1 is the command portion, or `undefined` if the prompt is empty.
 *
 * We deliberately only match prompts that include directory/git/host context. Bare-glyph
 * prompts (`❯ cmd`, `$ cmd`) are excluded because terminal TUIs (Claude Code, Codex
 * Forge, etc.) use the same glyphs for their chat input boxes — capturing the user's
 * typed chat text as a "shell command" and replaying it on restore would be wrong and
 * surprising. Users with bare-glyph shells lose command capture but can hand-edit the
 * profile JSON with `command_source: "manual"` if they want it back.
 */
const PROMPT_PATTERNS: RegExp[] = [
    // oh-my-zsh robbyrussell. Every part of the prompt prefix (git suffix, ✗ dirty-tree
    // mark, trailing command) is optional so "➜  app git:(main) ✗" with no command
    // yields capture-group 1 === undefined, which the parser skips as an empty prompt.
    /^➜\s+\S+(?:\s+git:\([^)]*\))?(?:\s+✗)?(?:\s+(.*?))?\s*$/u,
    // [user@host dir]$ <command>
    /^\[[^\]]+\]\s*[$#%]\s+(\S.*?)\s*$/u,
    // user@host:dir$ <command>  (typical bash)
    /^[\w.-]+@[\w.-]+:\S*[$#%]\s+(\S.*?)\s*$/u,
];

interface CommandHint {
    value: string | undefined;
    source: CommandSource;
}

const NO_COMMAND: CommandHint = { value: undefined, source: "none" };

export function lastCommandFromCapture(text: string | undefined | null): CommandHint {
    if (!text) {
        return NO_COMMAND;
    }
    const lines = text.split("\n").map((line) => line.replace(/\s+$/u, ""));
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line) {
            continue;
        }
        for (const pattern of PROMPT_PATTERNS) {
            const match = line.match(pattern);
            if (match?.[1]) {
                return { value: match[1], source: "scrollback" };
            }
        }
    }
    return NO_COMMAND;
}

export interface SurfaceCaptureResult {
    screen?: ScreenSnapshot;
    command: CommandHint;
}

/**
 * Capture rendered terminal text from a single surface via `cmux capture-pane` (V2 routing).
 * Raw socket `surface.read_text` is affected by the V1 routing bug — it returns the
 * focused surface's content regardless of the param — so we shell out to the CLI which
 * routes per-surface correctly.
 *
 * The CLI's `--scrollback` flag does NOT actually include scrollback in cmux 0.63.2
 * (see upstream issue) — it returns the same visible content as plain `capture-pane`.
 * That means the captured command can only come from the visible area: shell panes
 * with a recent prompt are captured fine; long-running Claude/vim sessions whose
 * launching `claude --resume <id>` has scrolled past the visible 40-ish rows will
 * yield no `command`. Users can hand-edit the profile JSON with `command_source: "manual"`
 * to add the right command for those panes.
 */
export async function captureSurfaceState(
    workspaceRef: string,
    surfaceRef: string,
    options: { screen: boolean; history: boolean }
): Promise<SurfaceCaptureResult> {
    if (!options.screen && !options.history) {
        return { command: NO_COMMAND };
    }

    const visible = await runCaptureSafely(workspaceRef, surfaceRef);
    if (!visible) {
        return { command: NO_COMMAND };
    }

    const text = visible.replace(/\s+$/u, "");
    if (!text) {
        return { command: NO_COMMAND };
    }

    const screen = options.screen ? { text, rows: text.split("\n").length } : undefined;
    const command = options.history ? lastCommandFromCapture(text) : NO_COMMAND;
    return { screen, command };
}

async function runCaptureSafely(workspaceRef: string, surfaceRef: string): Promise<string | undefined> {
    try {
        const result = await runCmux(["capture-pane", "--workspace", workspaceRef, "--surface", surfaceRef]);
        if (result.code !== 0) {
            logger.debug(
                { workspaceRef, surfaceRef, stderr: result.stderr.trim() },
                "[shell-probe] capture-pane non-zero exit"
            );
            return undefined;
        }
        return result.stdout;
    } catch (error) {
        logger.warn({ error, workspaceRef, surfaceRef }, "[shell-probe] capture-pane failed");
        return undefined;
    }
}
