import { homedir } from "node:os";
import { loadPins } from "@app/claude/lib/cmux/pins";
import { loadAllSessionCmuxRefs } from "@app/claude/lib/cmux/session-refs";
import { logger } from "@genesiscz/utils/logger";

/**
 * Foreground-command capture and replay-command derivation for profile save.
 *
 * Scrollback parsing cannot see the launch command once a fullscreen TUI (claude,
 * grok, vim) owns the pane, so the reliable source is the process table: the
 * oldest non-shell process on the pane's tty IS the command the user typed.
 *
 * Replay commands follow Martin's 2026-08-27 policy: start from the original
 * verbatim; the only allowed enrichments are the account (from the session pin
 * journal) and `-- --resume <sessionId>` (pass-through — `--resume <query>`
 * opens a fuzzy picker whose top match can be a different session). Every
 * change is recorded as a drift note that restore must display.
 */

const SHELL_NAMES = new Set(["zsh", "-zsh", "bash", "-bash", "sh", "-sh", "fish", "-fish"]);

function isShellOrLogin(command: string): boolean {
    const first = command.split(/\s+/, 1)[0] ?? "";
    const base = first.split("/").pop() ?? first;
    if (SHELL_NAMES.has(base)) {
        return true;
    }

    return first === "/usr/bin/login" || base === "login";
}

/** Normalize an absolute launcher path back to what the user actually types. */
export function cleanLaunchCommand(command: string): string {
    return command
        .replace(/^\S*\bbun (?:run )?\S*\/tools\s+/, "tools ")
        .replace(new RegExp(`^${homedir()}/\\.local/bin/grok\\b`), "grok")
        .replace(/^\S*\/grok\b/, "grok")
        .trim();
}

/** `[[dd-]hh:]mm:ss` → seconds. Returns 0 for unparseable values. */
export function etimeToSeconds(etime: string): number {
    const match = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
    if (!match) {
        return 0;
    }
    const [, days, hours, minutes, seconds] = match;
    return Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds);
}

/**
 * tty name (e.g. `ttys012`) → the cleaned launch command running on it.
 * The launch command is the OLDEST non-shell process on the tty (largest etime):
 * the shell comes first, the typed command next, and everything after is its
 * children. Pid ordering is NOT usable here — pids wrap, so a transient
 * `sleep 1` background job can carry a lower pid than the hours-old wrapper.
 */
export async function collectTtyLaunchCommands(): Promise<Map<string, string>> {
    const map = new Map<string, { ageSeconds: number; command: string }>();
    try {
        const proc = Bun.spawn(["ps", "-axo", "tty=,etime=,command="], {
            stdin: "ignore",
            stdout: "pipe",
            stderr: "ignore",
        });
        const text = await new Response(proc.stdout).text();
        await proc.exited;

        for (const line of text.split("\n")) {
            const match = line.match(/^\s*(ttys\d+)\s+([\d:-]+)\s+(.+)$/);
            if (!match) {
                continue;
            }
            const [, tty, etime, command] = match;
            if (isShellOrLogin(command)) {
                continue;
            }
            const ageSeconds = etimeToSeconds(etime);
            const existing = map.get(tty);
            if (!existing || ageSeconds > existing.ageSeconds) {
                map.set(tty, { ageSeconds, command });
            }
        }
    } catch (error) {
        logger.warn({ error }, "[command-capture] ps tty scan failed");
    }

    const out = new Map<string, string>();
    for (const [tty, entry] of map) {
        out.set(tty, cleanLaunchCommand(entry.command));
    }

    return out;
}

export interface SurfaceSessionInfo {
    sessionId: string;
    account?: string;
}

/** surface uuid (CMUX_SURFACE_ID) → newest known claude session + account. */
export async function loadSurfaceSessions(): Promise<Map<string, SurfaceSessionInfo>> {
    const out = new Map<string, { sessionId: string; account?: string; at: number }>();
    try {
        const refs = loadAllSessionCmuxRefs();
        const pins = await loadPins({ readOnly: true });

        for (const entry of refs.values()) {
            if (!entry.surfaceId) {
                continue;
            }
            const existing = out.get(entry.surfaceId);
            if (existing && existing.at >= (entry.at ?? 0)) {
                continue;
            }
            out.set(entry.surfaceId, {
                sessionId: entry.sessionId,
                account: pins.get(entry.sessionId)?.account ?? undefined,
                at: entry.at ?? 0,
            });
        }
    } catch (error) {
        logger.warn({ error }, "[command-capture] session refs/pins unavailable");
    }

    return new Map([...out].map(([k, v]) => [k, { sessionId: v.sessionId, account: v.account }]));
}

export interface ReplayDerivation {
    command: string;
    drift: string[];
}

// Anchored at the START of the command on purpose. `(^|\s)` matched a launcher
// ANYWHERE, so `echo tools cc run` was rewritten wholesale to
// `tools cc run -- --resume <id>` and the original command was lost. The policy
// is that a non-Claude command replays verbatim, so an embedded mention is not
// a launcher.
const CLAUDE_LAUNCHER = /^(tools cc run|tools claude run|claude)\b/;
const CC_RUN_LAUNCHER = /^tools (?:cc|claude) run\b/;

/**
 * Pin the resume target inside the original command without touching anything
 * else — the launcher and every other flag (e.g. `--model`) stay as typed.
 */
function replaceResumeInPlace(original: string, sessionId: string): ReplayDerivation {
    const drift: string[] = [];
    const match = original.match(/--resume(?:[= ]("[^"]*"|\S+))?/);

    if (!match) {
        drift.push(`--resume ${sessionId} added (session that was active in this pane)`);
        return { command: `${original} --resume ${sessionId}`, drift };
    }

    if (match[1]) {
        if (match[1].replace(/"/g, "") === sessionId) {
            return { command: original, drift };
        }

        drift.push(`resume target "${match[1]}" replaced with the session that was active here`);
    } else {
        drift.push(`bare --resume (interactive picker) replaced with the concrete session id`);
    }

    return { command: original.replace(match[0], `--resume ${sessionId}`), drift };
}

/**
 * Derive the replay command from the captured original plus what we know about
 * the session that ran in the pane. Non-claude commands pass through untouched.
 */
export function deriveReplayCommand(input: {
    original: string;
    sessionId?: string;
    account?: string;
}): ReplayDerivation {
    const original = input.original.trim();
    if (!input.sessionId || !CLAUDE_LAUNCHER.test(original)) {
        return { command: original, drift: [] };
    }

    if (!CC_RUN_LAUNCHER.test(original)) {
        // Bare `claude …` launchers keep their command verbatim (rebuilding as
        // `tools cc run` would drop options and change the launcher the user ran).
        return replaceResumeInPlace(original, input.sessionId);
    }

    const drift: string[] = [];
    const accountInOriginal = original.match(/^tools cc run\s+(?!-)(\S+)/)?.[1];
    const account = accountInOriginal ?? input.account;

    if (!accountInOriginal && input.account) {
        drift.push(
            `account "${input.account}" added from the session pin journal — the original had none (it may have been picked interactively)`
        );
    }

    const originalResume = original.match(/--resume(?:[= ]("[^"]*"|\S+))?/);
    if (originalResume?.[1] && originalResume[1].replace(/"/g, "") !== input.sessionId) {
        drift.push(`resume target "${originalResume[1]}" replaced with the session that was active here`);
    } else if (!originalResume) {
        drift.push(`-- --resume ${input.sessionId} added (session that was active in this pane)`);
    } else if (originalResume && !originalResume[1]) {
        drift.push(`bare --resume (interactive picker) replaced with the concrete session id`);
    }

    const command = account
        ? `tools cc run ${account} -- --resume ${input.sessionId}`
        : `tools cc run -- --resume ${input.sessionId}`;

    if (!account) {
        drift.push("no account recorded for this session — cc run will ask for one");
    }

    if (command !== original && drift.length === 0) {
        drift.push("command rewritten to the deterministic pass-through resume form");
    }

    return { command, drift };
}
