import { homedir } from "node:os";
import { loadPins } from "@app/claude/lib/cmux/pins";
import { loadAllSessionCmuxRefs } from "@app/claude/lib/cmux/session-refs";
import { parseEtime } from "@app/macos/lib/swap/scanner";
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

// Interpolating homedir() into a fresh RegExp on every call recompiled it 10-60
// times per capture. The home directory does not change while the process runs.
const GROK_LOCAL_BIN_RE = new RegExp(`^${homedir()}/\\.local/bin/grok\\b`);

/** Normalize an absolute launcher path back to what the user actually types. */
export function cleanLaunchCommand(command: string): string {
    return command
        .replace(/^\S*\bbun (?:run )?\S*\/tools\s+/, "tools ")
        .replace(GROK_LOCAL_BIN_RE, "grok")
        .replace(/^\S*\/grok\b/, "grok")
        .trim();
}

/** `[[dd-]hh:]mm:ss` → seconds. Returns 0 for unparseable values. */
export function etimeToSeconds(etime: string): number {
    // parseEtime owns this format (same `ps -o etime=` output, same regex); it
    // answers in milliseconds, and the tty scan compares ages in seconds.
    return parseEtime(etime) / 1000;
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
// `tools claude start` is here because agent-replay emits exactly that form for
// an account-pinned Claude resume. While it was missing, isAgentLauncher said
// false for a command this code had itself written, so the saved command was
// returned verbatim forever: never re-pinned to the session that ran there
// later, and never discarded when the tab turned into a grok tab.
// `(?![\w-])` rather than `\b`: a word boundary sits between "x" and "-", so
// `/^codex\b/` also matched `codex-gateway serve`, and that pane was then
// rewritten into `codex resume <uuid>` on restore.
const CLAUDE_LAUNCHER = /^(tools cc run|tools claude run|tools (?:cc|claude) start|claude)(?![\w-])/;
const CC_RUN_LAUNCHER = /^tools (?:cc|claude) run(?![\w-])/;
const GROK_LAUNCHER = /^grok(?![\w-])/;
const CODEX_LAUNCHER = /^codex(?![\w-])/;

export function isAgentLauncher(command: string): boolean {
    const trimmed = command.trim();

    return CLAUDE_LAUNCHER.test(trimmed) || GROK_LAUNCHER.test(trimmed) || CODEX_LAUNCHER.test(trimmed);
}

export function agentKindFromLauncher(command: string): "claude" | "grok" | "codex" | undefined {
    const trimmed = command.trim();
    if (GROK_LAUNCHER.test(trimmed)) {
        return "grok";
    }
    if (CODEX_LAUNCHER.test(trimmed)) {
        return "codex";
    }
    if (CLAUDE_LAUNCHER.test(trimmed)) {
        return "claude";
    }

    return undefined;
}

interface CommandToken {
    value: string;
    start: number;
    end: number;
}

/**
 * Split a command line on top-level whitespace, treating a quoted span as one
 * opaque unit. Quotes are kept in the token so a rewrite can splice the exact
 * original bytes back.
 */
export function tokenizeCommand(command: string): CommandToken[] {
    const tokens: CommandToken[] = [];
    let index = 0;

    while (index < command.length) {
        while (index < command.length && /\s/.test(command[index])) {
            index++;
        }

        if (index >= command.length) {
            break;
        }

        const start = index;
        let quote: string | undefined;

        while (index < command.length) {
            const char = command[index];

            if (quote) {
                if (char === quote) {
                    quote = undefined;
                }

                index++;
                continue;
            }

            if (char === '"' || char === "'") {
                quote = char;
                index++;
                continue;
            }

            if (/\s/.test(char)) {
                break;
            }

            index++;
        }

        tokens.push({ value: command.slice(start, index), start, end: index });
    }

    return tokens;
}

interface ResumeFlagMatch {
    flag: string;
    /** The value exactly as written, quotes included. Undefined for a bare flag. */
    value?: string;
    start: number;
    end: number;
}

/**
 * Find a resume flag at the TOP LEVEL of the command, never inside a quoted
 * argument. A regex over the raw string rewrote `grok -p "explain the -r flag"`
 * into `grok -p "explain the -r <id>` — a mangled command with an unterminated
 * quote, typed straight into the restored pane.
 */
function findResumeFlag(command: string, flags: readonly string[]): ResumeFlagMatch | undefined {
    const tokens = tokenizeCommand(command);

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const flag = flags.find((candidate) => token.value === candidate || token.value.startsWith(`${candidate}=`));

        if (!flag) {
            continue;
        }

        if (token.value.length > flag.length) {
            return { flag, value: token.value.slice(flag.length + 1), start: token.start, end: token.end };
        }

        const next = tokens[i + 1];
        if (next && !next.value.startsWith("-")) {
            return { flag, value: next.value, start: token.start, end: next.end };
        }

        return { flag, start: token.start, end: token.end };
    }

    return undefined;
}

function spliceFlag(original: string, match: ResumeFlagMatch, replacement: string): string {
    return original.slice(0, match.start) + replacement + original.slice(match.end);
}

/**
 * Pin the resume target inside the original command without touching anything
 * else — the launcher and every other flag (e.g. `--model`) stay as typed.
 */
function replaceResumeInPlace(original: string, sessionId: string): ReplayDerivation {
    const drift: string[] = [];
    const match = findResumeFlag(original, ["--resume"]);

    if (!match) {
        drift.push(`--resume ${sessionId} added (session that was active in this pane)`);
        return { command: `${original} --resume ${sessionId}`, drift };
    }

    if (match.value !== undefined) {
        if (match.value.replace(/"/g, "") === sessionId) {
            return { command: original, drift };
        }

        drift.push(`resume target "${match.value}" replaced with the session that was active here`);
    } else {
        drift.push(`bare --resume (interactive picker) replaced with the concrete session id`);
    }

    return { command: spliceFlag(original, match, `--resume ${sessionId}`), drift };
}

/**
 * Pin a grok resume target. Grok accepts `-r` and `--resume`; keep whichever
 * spelling the original used, and default to `-r` (what cmux-agent-resume types).
 */
function replaceGrokResume(original: string, sessionId: string): ReplayDerivation {
    const drift: string[] = [];
    const match = findResumeFlag(original, ["-r", "--resume"]);

    if (!match) {
        drift.push(`-r ${sessionId} added (session that was active in this pane)`);

        return { command: `${original} -r ${sessionId}`, drift };
    }

    const current = match.value?.replace(/"/g, "");

    if (current === sessionId) {
        return { command: original, drift };
    }

    if (current !== undefined) {
        drift.push(`resume target "${current}" replaced with the session that was active here`);
    } else {
        drift.push(`bare ${match.flag} (interactive picker) replaced with the concrete session id`);
    }

    return { command: spliceFlag(original, match, `${match.flag} ${sessionId}`), drift };
}

/**
 * Pin a codex resume target. Codex resumes through a `resume <id>` SUBCOMMAND
 * rather than a flag, so splice that subcommand in right after the launcher and
 * leave every other flag as typed. Returning a bare `codex resume <id>` dropped
 * `--model`, `--cd` and `--full-auto` from every restored pane.
 */
function replaceCodexResume(original: string, sessionId: string): ReplayDerivation {
    const tokens = tokenizeCommand(original);
    const launcher = tokens[0];
    const next = tokens[1];

    if (!launcher) {
        return { command: original, drift: [] };
    }

    if (next?.value === "resume") {
        const idToken = tokens[2];

        if (!idToken || idToken.value.startsWith("-")) {
            return {
                command: `${original.slice(0, next.end)} ${sessionId}${original.slice(next.end)}`,
                drift: ["bare resume (interactive picker) replaced with the concrete session id"],
            };
        }

        if (idToken.value.replace(/"/g, "") === sessionId) {
            return { command: original, drift: [] };
        }

        return {
            command: original.slice(0, idToken.start) + sessionId + original.slice(idToken.end),
            drift: [`resume target "${idToken.value}" replaced with the session that was active here`],
        };
    }

    if (next && !next.value.startsWith("-")) {
        // Another subcommand (`codex exec`, `codex mcp`): a resume target has no
        // place inside it, so replay the resume on its own.
        return {
            command: `codex resume ${sessionId}`,
            drift: [`codex resume ${sessionId} (session that was active in this pane)`],
        };
    }

    return {
        command: `${original.slice(0, launcher.end)} resume ${sessionId}${original.slice(launcher.end)}`,
        drift: [`resume ${sessionId} added (session that was active in this pane)`],
    };
}

/**
 * Derive the replay command from the captured original plus what we know about
 * the session that ran in the pane. Non-agent commands pass through untouched.
 */
export function deriveReplayCommand(input: {
    original: string;
    sessionId?: string;
    account?: string;
}): ReplayDerivation {
    const original = input.original.trim();
    if (!input.sessionId) {
        return { command: original, drift: [] };
    }

    if (GROK_LAUNCHER.test(original)) {
        return replaceGrokResume(original, input.sessionId);
    }

    if (CODEX_LAUNCHER.test(original)) {
        return replaceCodexResume(original, input.sessionId);
    }

    if (!CLAUDE_LAUNCHER.test(original)) {
        return { command: original, drift: [] };
    }

    if (!CC_RUN_LAUNCHER.test(original)) {
        // Bare `claude …` launchers keep their command verbatim (rebuilding as
        // `tools cc run` would drop options and change the launcher the user ran).
        return replaceResumeInPlace(original, input.sessionId);
    }

    return replaceCcRunResume(original, input.sessionId, input.account);
}

/**
 * The concrete session id an agent command already resumes, or undefined when
 * the launcher carries no pinned target.
 *
 * This is how a save-time journal lookup survives into the profile file. The
 * journal is keyed by cmux surface uuid, which a saved profile does not store,
 * so on restore the id inside the command IS the journal record for that pane.
 */
export function resumeTargetFromCommand(command: string): string | undefined {
    const original = command.trim();
    const kind = agentKindFromLauncher(original);

    if (!kind) {
        return undefined;
    }

    if (kind === "codex") {
        const tokens = tokenizeCommand(original);

        if (tokens[1]?.value !== "resume") {
            return undefined;
        }

        const target = tokens[2]?.value.replace(/"/g, "");

        return target && !target.startsWith("-") ? target : undefined;
    }

    const match = findResumeFlag(original, kind === "grok" ? ["-r", "--resume"] : ["--resume"]);

    if (!match?.value) {
        return undefined;
    }

    // cc run's OWN `--resume` takes a search query that can prompt, so only the
    // pass-through flag after `--` names a session id.
    if (CC_RUN_LAUNCHER.test(original)) {
        const separator = passthroughStart(original);

        if (separator === undefined || match.start < separator) {
            return undefined;
        }
    }

    return match.value.replace(/"/g, "");
}

/** Offset just past a top-level `--` separator, or undefined when there is none. */
function passthroughStart(command: string): number | undefined {
    const separator = tokenizeCommand(command).find((token) => token.value === "--");

    return separator?.end;
}

/**
 * Pin a `tools cc run` resume target IN PLACE, keeping every other flag the
 * user typed. Rebuilding the command as `tools cc run <account> -- --resume
 * <id>` dropped `--model opus`, `--verbose` and the launcher spelling from
 * every restored pane — the same defect `replaceCodexResume` was fixed for.
 *
 * The resume target still lands AFTER `--`, where claude itself reads it: cc
 * run's own `--resume <query>` runs a local search that can prompt, so it is
 * not a deterministic replay target. A cc-run-level `--resume` in the original
 * is therefore removed rather than spliced, and only that flag.
 */
function replaceCcRunResume(original: string, sessionId: string, pinnedAccount?: string): ReplayDerivation {
    const drift: string[] = [];
    // Both launcher spellings, or `tools claude run personal` would lose the
    // explicit account and replay under the journal's one (or none) while the
    // drift line claimed the original had no account.
    const accountMatch = original.match(/^tools (?:cc|claude) run\s+(?!-)(\S+)/);
    const account = accountMatch?.[1] ?? pinnedAccount;
    let command = original;

    if (!accountMatch && pinnedAccount) {
        const runToken = tokenizeCommand(command)[2];
        drift.push(
            `account "${pinnedAccount}" added from the session pin journal — the original had none (it may have been picked interactively)`
        );
        command = runToken
            ? `${command.slice(0, runToken.end)} ${pinnedAccount}${command.slice(runToken.end)}`
            : `${command} ${pinnedAccount}`;
    }

    if (!account) {
        drift.push("no account recorded for this session — cc run will ask for one");
    }

    const match = findResumeFlag(command, ["--resume"]);
    const separator = passthroughStart(command);

    if (match && separator !== undefined && match.start >= separator) {
        const current = match.value?.replace(/"/g, "");

        if (current === sessionId) {
            return { command, drift };
        }

        drift.push(
            current === undefined
                ? "bare --resume (interactive picker) replaced with the concrete session id"
                : `resume target "${current}" replaced with the session that was active here`
        );

        return { command: spliceFlag(command, match, `--resume ${sessionId}`), drift };
    }

    if (match) {
        // cc run's own --resume: drop just that flag, keep everything else.
        drift.push(
            match.value === undefined
                ? "bare --resume (interactive picker) replaced with the concrete session id"
                : `resume target "${match.value}" replaced with the session that was active here`
        );
        command = `${command.slice(0, match.start).trimEnd()}${command.slice(match.end)}`;
    } else {
        drift.push(`-- --resume ${sessionId} added (session that was active in this pane)`);
    }

    const tail = passthroughStart(command) === undefined ? "-- " : "";

    return { command: `${command.trimEnd()} ${tail}--resume ${sessionId}`, drift };
}
