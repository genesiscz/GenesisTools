import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HookFacts } from "@genesiscz/utils/harness/parts";
import { isJsonObject, SafeJSON } from "@genesiscz/utils/json";
import { scriptCallStampPath } from "../paths";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

/**
 * Whether the call's id is a tool call the model made itself, not a code-mode script's call. A script's call draws as a
 * row of its own too (Claude Code adds it to the transcript as a virtual tool call), but the hook leaves its diff to the
 * mod only once the mod marked that such rows draw in this session (`MODS_SCRIPT_ROWS_VAR` in run.ts).
 */
export function callHasOwnRow(facts: HookFacts, toolUseId: string | undefined): boolean {
    const ids = facts.scriptCalls;

    return ids === null || toolUseId === undefined || !toolUseId.startsWith(ids.prefix);
}

interface ScriptCallStamp {
    /** When a call with the script prefix last ran, in ms; written at most once an hour. */
    seenAt?: number;
    /** When the self-check last spoke, in ms. */
    warnedAt?: number;
}

function readStamp(path: string): ScriptCallStamp {
    try {
        const parsed: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

        if (!isJsonObject(parsed)) {
            return {};
        }

        const { seenAt, warnedAt } = parsed;

        return {
            ...(typeof seenAt === "number" ? { seenAt } : {}),
            ...(typeof warnedAt === "number" ? { warnedAt } : {}),
        };
    } catch {
        return {};
    }
}

/** Written whole through a rename, so two hooks at once never leave half a file. A failed write is skipped. */
function writeStamp(path: string, stamp: ScriptCallStamp): void {
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, SafeJSON.stringify(stamp), { mode: 0o600 });
        renameSync(temporary, path);
    } catch {
        // The check is advisory: a read-only temporary folder only means it runs again next time.
    }
}

/**
 * A self-check of the one undocumented fact `callHasOwnRow` rests on: the id prefix of a code-mode script's shell call.
 * If the harness renames those ids, a script's diffs go to the full-diff mod, which has no row to draw them under, and
 * nothing says why. So this returns one line, at most once a day, when a shell call's id has neither known prefix, or
 * when code mode is on and no call with the script prefix ran for a day (in code mode the model runs its shell commands
 * through scripts). Null otherwise, and for a harness without code mode. The stamp lives in the per-user temporary
 * folder: a reboot starts the day again, and the first call after it only starts the clock.
 */
export function scriptCallIdNotice({
    harness,
    facts,
    toolUseId,
    vars,
    now = Date.now(),
    stampPath = scriptCallStampPath(),
}: {
    harness: string;
    facts: HookFacts;
    toolUseId: string | undefined;
    vars: Readonly<Record<string, string | undefined>>;
    now?: number;
    stampPath?: string;
}): string | null {
    const ids = facts.scriptCalls;

    if (ids === null || !toolUseId) {
        return null;
    }

    const stamp = readStamp(stampPath);

    if (toolUseId.startsWith(ids.prefix)) {
        if (stamp.seenAt === undefined || now - stamp.seenAt >= HOUR) {
            writeStamp(stampPath, { ...stamp, seenAt: now });
        }

        return null;
    }

    if (stamp.warnedAt !== undefined && now - stamp.warnedAt < DAY) {
        return null;
    }

    let finding: string | null = null;

    if (!toolUseId.startsWith(ids.rowPrefix)) {
        finding = `a shell call's id (\`${toolUseId.slice(0, 12)}…\`) has neither the \`${ids.rowPrefix}\` prefix of a tool call nor the \`${ids.prefix}\` prefix of a code-mode script's call`;
    } else if (ids.codeModeOn(vars)) {
        if (stamp.seenAt === undefined) {
            writeStamp(stampPath, { ...stamp, seenAt: now });

            return null;
        }

        if (now - stamp.seenAt >= DAY) {
            const hours = Math.floor((now - stamp.seenAt) / HOUR);
            finding = `code mode is on, and no shell call with the \`${ids.prefix}\` prefix of a script's call ran for ${hours} hours`;
        }
    }

    if (finding === null) {
        return null;
    }

    writeStamp(stampPath, { ...stamp, warnedAt: now });

    return `⚠️ Diff hook self-check (${harness}): ${finding}. The ids of a script's calls may have changed shape, and then a code-mode diff is left to the full-diff mod, which draws it nowhere. Check \`scriptCalls\` in the ${harness} hook facts (\`harness-hooks.ts\`). This note shows at most once a day.`;
}
