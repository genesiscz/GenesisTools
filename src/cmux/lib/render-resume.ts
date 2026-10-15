import {
    agentKindFromLauncher,
    CODEX_LAUNCHER,
    GROK_LAUNCHER,
    isAgentLauncher,
    launcherRes,
    tokenizeCommand,
    toolsRunLauncher,
} from "@app/cmux/lib/launchers";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";

/**
 * Every code that writes a resume line: a known launcher's line with the session pinned on
 * (`deriveReplayCommand`), the `tools <agent> run` wrappers, Grok's `-r` and Codex's `resume`, and the model
 * flag removal. The recipe for an unknown launcher is `resumeCommandLine` (utils/agent-sessions/resume-argv.ts)
 * plus the agent's own flags (resume-flags.ts).
 *
 * Replay commands follow Martin's 2026-08-27 policy: start from the original verbatim; the only allowed
 * enrichments are the account (from the session pin journal) and `-- --resume <sessionId>` (pass-through:
 * `--resume <query>` opens a fuzzy picker whose top match can be a different session). Model flags are removed
 * (2026-10-14: a session can switch models). Every change is recorded as a drift note that restore displays.
 */
export interface ReplayDerivation {
    command: string;
    drift: string[];
}

const MODEL_FLAGS = new Set(["-m", "--model"]);

/**
 * The agent command without its model flags (`-m X`, `--model X`, `--model=X`), on either side of `--`.
 *
 * A resume must not pin the model the tab was STARTED with: the user can switch models inside the session
 * (`/model`), so replaying `cr work -m sonnet` for ten sessions moved to opus would put all ten back on
 * sonnet. Without the flag the agent picks its own default.
 */
export function stripModelFlags(command: string): { command: string; removed: string[] } {
    const tokens = tokenizeCommand(command);
    const cut: Array<{ start: number; end: number }> = [];
    const removed: string[] = [];

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (MODEL_FLAGS.has(token.value) && tokens[index + 1]) {
            const value = tokens[index + 1];
            cut.push({ start: token.start, end: value.end });
            removed.push(`${token.value} ${value.value}`);
            index++;
        } else if (token.value.startsWith("--model=")) {
            cut.push({ start: token.start, end: token.end });
            removed.push(token.value);
        }
    }

    let out = command;

    for (const { start, end } of cut.reverse()) {
        out = `${out.slice(0, start).trimEnd()} ${out.slice(end).trimStart()}`.trim();
    }

    return { command: out, removed };
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
    if (!input.sessionId || !isAgentLauncher(input.original)) {
        return { command: input.original, drift: [] };
    }

    const wrapper = toolsRunLauncher(original);

    if (wrapper) {
        return replaceToolsRunResume({
            original,
            kind: wrapper.kind,
            launcherEnd: wrapper.end,
            sessionId: input.sessionId,
            pinnedAccount: input.account,
        });
    }

    if (GROK_LAUNCHER.test(original)) {
        return replaceGrokResume(original, input.sessionId);
    }

    if (CODEX_LAUNCHER.test(original)) {
        return replaceCodexResume(original, input.sessionId);
    }

    if (!launcherRes().claude.test(original)) {
        return { command: original, drift: [] };
    }

    // Bare `claude …` launchers keep their command verbatim (rebuilding as
    // `tools cc run` would drop options and change the launcher the user ran).
    return replaceResumeInPlace(original, input.sessionId);
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

    // A wrapper's own `--resume` takes a search query that can prompt, so only the native target after `--` names
    // a session id.
    if (toolsRunLauncher(original)) {
        const separator = passthroughStart(original);
        const native = separator === undefined ? undefined : nativeResumeAfter(original, kind, separator);

        return native?.value?.replace(/"/g, "");
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

    return match?.value?.replace(/"/g, "");
}

/**
 * The resume target a launcher will SEARCH for rather than replay verbatim.
 *
 * `tools cc run --resume <query>` runs a local search whose top match can be
 * another session, so `resumeTargetFromCommand` refuses to call it a pinned id.
 * It is still not a cold start, and a drift line that says the pane opens a NEW
 * session is wrong about it.
 */
export function resumeQueryFromCommand(command: string): string | undefined {
    const original = command.trim();
    const kind = agentKindFromLauncher(original);

    if (!kind || kind === "codex" || resumeTargetFromCommand(original)) {
        return undefined;
    }

    const match = findResumeFlag(original, kind === "grok" ? ["-r", "--resume"] : ["--resume"]);

    return match?.value?.replace(/"/g, "");
}

/**
 * The resume flag a launcher carries with NO value, which opens its own session picker.
 *
 * Neither a cold start nor a query: the pane reopens whatever the user picks. Without this
 * the restore drift told the user a bare `--resume` starts a NEW session, which is the one
 * thing that line exists to say and the one thing it got wrong.
 *
 * Returns the spelling the command used (`-r`, `--resume`, or codex's `resume` subcommand),
 * so the drift can quote what is actually on the tty.
 */
export function bareResumeFlag(command: string): string | undefined {
    const original = command.trim();
    const kind = agentKindFromLauncher(original);

    if (!kind || resumeTargetFromCommand(original) || resumeQueryFromCommand(original)) {
        return undefined;
    }

    if (kind === "codex") {
        return tokenizeCommand(original)[1]?.value === "resume" ? "resume" : undefined;
    }

    const match = findResumeFlag(original, kind === "grok" ? ["-r", "--resume"] : ["--resume"]);

    return match && match.value === undefined ? match.flag : undefined;
}

/** Offset just past a top-level `--` separator, or undefined when there is none. */
function passthroughStart(command: string): number | undefined {
    const separator = tokenizeCommand(command).find((token) => token.value === "--");

    return separator?.end;
}

/** How each agent's own binary reads a resume target, after a wrapper's `--`. */
const NATIVE_RESUME: Record<AccountProviderAlias, { flags: readonly string[]; render: (sessionId: string) => string }> =
    {
        claude: { flags: ["--resume"], render: (sessionId) => `--resume ${sessionId}` },
        grok: { flags: ["-r", "--resume"], render: (sessionId) => `-r ${sessionId}` },
        codex: { flags: [], render: (sessionId) => `resume ${sessionId}` },
    };

/** A wrapper's own resume flag, before `--`: it runs a search that can prompt, so it is never a replay target. */
const WRAPPER_RESUME_FLAGS = ["-r", "--resume"] as const;

/** The native resume target after `--`: its span and value, or the bare flag or `resume` word. */
function nativeResumeAfter(
    command: string,
    kind: AccountProviderAlias,
    separator: number
): ResumeFlagMatch | undefined {
    const tokens = tokenizeCommand(command).filter((token) => token.start >= separator);

    if (kind === "codex") {
        const at = tokens.findIndex((token) => token.value === "resume");

        if (at < 0) {
            return undefined;
        }

        const id = tokens[at + 1];
        return id && !id.value.startsWith("-")
            ? { flag: "resume", value: id.value, start: tokens[at].start, end: id.end }
            : { flag: "resume", start: tokens[at].start, end: tokens[at].end };
    }

    const match = findResumeFlag(command.slice(separator), NATIVE_RESUME[kind].flags);
    return match ? { ...match, start: match.start + separator, end: match.end + separator } : undefined;
}

/**
 * Pin the resume target of a `tools <agent> run|start` wrapper (or a cc-run alias such as `cr`) IN PLACE, keeping
 * every other flag the user typed. Rebuilding the command as `tools cc run <account> -- --resume <id>` dropped
 * `--model opus`, `--verbose` and the launcher spelling from every restored pane.
 *
 * The resume target lands AFTER `--`, where the agent itself reads it: `--resume <id>` for Claude, `-r <id>` for
 * Grok, the `resume <id>` subcommand for Codex. The wrapper's own `--resume <query>` runs a local search that can
 * prompt, so it is removed rather than spliced. The account is the session's pin when there is one: a session lives
 * in its account's home (Sonnet F13).
 */
function replaceToolsRunResume(input: {
    original: string;
    kind: AccountProviderAlias;
    launcherEnd: number;
    sessionId: string;
    pinnedAccount?: string;
}): ReplayDerivation {
    const { original, kind, launcherEnd, sessionId, pinnedAccount } = input;
    const drift: string[] = [];
    const accountMatch = original.slice(launcherEnd).match(/^\s+(?!-)(\S+)/);
    const account = pinnedAccount ?? accountMatch?.[1];
    let command = original;

    if (accountMatch && pinnedAccount && accountMatch[1].replace(/^(['"])(.*)\1$/, "$2") !== pinnedAccount) {
        const at = launcherEnd + (accountMatch.index ?? 0) + accountMatch[0].length - accountMatch[1].length;
        drift.push(
            `account "${accountMatch[1]}" replaced with "${pinnedAccount}", the account session ${sessionId} was started with`
        );
        command = `${command.slice(0, at)}${pinnedAccount}${command.slice(at + accountMatch[1].length)}`;
    }

    if (!accountMatch && pinnedAccount) {
        drift.push(
            `account "${pinnedAccount}" added from the session pin journal — the original had none (it may have been picked interactively)`
        );
        command = `${command.slice(0, launcherEnd)} ${pinnedAccount}${command.slice(launcherEnd)}`;
    }

    if (!account) {
        drift.push(
            `no account recorded for this session — ${kind === "claude" ? "cc" : `tools ${kind}`} run will ask for one`
        );
    }

    // The wrapper's own resume flag, before `--`.
    const wrapper = findResumeFlag(command.slice(0, passthroughStart(command) ?? command.length), WRAPPER_RESUME_FLAGS);

    if (wrapper) {
        drift.push(
            wrapper.value === undefined
                ? "bare --resume (interactive picker) replaced with the concrete session id"
                : `resume target "${wrapper.value}" replaced with the session that was active here`
        );
        command = `${command.slice(0, wrapper.start).trimEnd()}${command.slice(wrapper.end)}`;
    }

    const separator = passthroughStart(command);
    const native = separator === undefined ? undefined : nativeResumeAfter(command, kind, separator);

    if (native) {
        const current = native.value?.replace(/"/g, "");

        if (current === sessionId) {
            return { command, drift };
        }

        if (!wrapper) {
            drift.push(
                current === undefined
                    ? "bare resume (interactive picker) replaced with the concrete session id"
                    : `resume target "${current}" replaced with the session that was active here`
            );
        }

        return { command: spliceFlag(command, native, NATIVE_RESUME[kind].render(sessionId)), drift };
    }

    if (!wrapper) {
        drift.push(`-- ${NATIVE_RESUME[kind].render(sessionId)} added (session that was active in this pane)`);
    }

    const tail = separator === undefined ? "-- " : "";

    return { command: `${command.trimEnd()} ${tail}${NATIVE_RESUME[kind].render(sessionId)}`, drift };
}
