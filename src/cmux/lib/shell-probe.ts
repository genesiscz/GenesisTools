import { homedir } from "node:os";
import { join } from "node:path";
import { promptCommand } from "@app/cmux/lib/terminal-ready";
import type { CommandSource, ScreenSnapshot } from "@app/cmux/lib/types";
import { runCmux } from "@genesiscz/utils/cmux/lib/cli";
import { logger } from "@genesiscz/utils/logger";

/**
 * cmux exposes no PID/tty for surfaces, but it does set tab titles from OSC-7 cwd escapes.
 * Idle shells get titles like "…/projects/NorthwindBack" — the leading "…" stands
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
        // The one prompt list (terminal-ready.ts): a second copy here had missed macOS's `user@host dir %`.
        const command = promptCommand(line);
        if (command) {
            return { value: command, source: "scrollback" };
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
    workspaceId: string,
    surfaceId: string,
    options: { screen: boolean; history: boolean }
): Promise<SurfaceCaptureResult> {
    if (!options.screen && !options.history) {
        return { command: NO_COMMAND };
    }

    const visible = await runCaptureSafely(workspaceId, surfaceId);
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

async function runCaptureSafely(workspaceId: string, surfaceId: string): Promise<string | undefined> {
    try {
        const result = await runCmux(["capture-pane", "--workspace", workspaceId, "--surface", surfaceId]);
        if (result.code !== 0) {
            logger.debug(
                { workspaceId, surfaceId, stderr: result.stderr.trim() },
                "[shell-probe] capture-pane non-zero exit"
            );
            return undefined;
        }
        return result.stdout;
    } catch (error) {
        logger.warn({ error, workspaceId, surfaceId }, "[shell-probe] capture-pane failed");
        return undefined;
    }
}
