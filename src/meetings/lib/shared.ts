import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { formatMissingEnumHelp, isInteractive, suggestCommand } from "@genesiscz/utils/cli";
import { redactCurrentRunText } from "@genesiscz/utils/cli/failures/watch";
import { ui } from "@genesiscz/utils/cli/ui";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { MEETING_FILE, type MeetingRecord } from "@genesiscz/utils/meetings/record";
import * as p from "@genesiscz/utils/prompts/p";
import { sharedTempRoot } from "@genesiscz/utils/rm/paths";
import { scratchRootNames } from "@genesiscz/utils/rm/scratch-dirs";
import { rpcErrorBody } from "@genesiscz/utils/rpc/errors";
import { genesisToolsDirIn, toolDataDir } from "@genesiscz/utils/storage/root";
import { globIterateSync } from "glob";

const { log } = logger.scoped("meetings-shared");

export const TOOL = "tools meetings";

export function hintIfSeatsUnset(record: Pick<MeetingRecord, "id" | "seats">): void {
    if (!record.seats) {
        ui.warn(`Seats are not set, so voice naming is off. Run: ${TOOL} seats ${record.id} --apply`);
    }
}

const skipScratchChildren = new Set([
    ".genesis-tools",
    ".git",
    ".build",
    "node_modules",
    "worktrees",
    "Pods",
    "removals",
    "dist",
    "build",
    "target",
    "vendor",
]);

/**
 * The scratch scan runs on a miss, also inside the service's request, so it is bounded: a session home sits a few
 * folders deep, and the walk stops after this many folders or milliseconds and reports no store.
 */
const SCRATCH_SCAN = { maxDepth: 8, maxFolders: 5000, maxMs: 100 } as const;

function scratchStoreWith(ref: string, roots: string[]): string | undefined {
    const deadline = performance.now() + SCRATCH_SCAN.maxMs;
    let folders = 0;
    const spent = () => ++folders > SCRATCH_SCAN.maxFolders || performance.now() > deadline;

    for (const cwd of roots) {
        if (!existsSync(cwd)) {
            continue;
        }
        // A session home may be nested, e.g. project/session/round/home. Skip checkouts, generated
        // trees and the contents of each store. Read only the requested record's path.
        for (const folder of globIterateSync("*/*/**/.genesis-tools", {
            cwd,
            absolute: true,
            follow: false,
            maxDepth: SCRATCH_SCAN.maxDepth,
            ignore: { childrenIgnored: (entry) => skipScratchChildren.has(entry.name) || spent() },
        })) {
            const meetings = join(folder, "meetings");
            if (existsSync(join(meetings, ref, MEETING_FILE))) {
                return meetings;
            }
        }
    }

    if (folders > SCRATCH_SCAN.maxFolders || performance.now() > deadline) {
        log.debug({ ref, folders }, "the scratch store scan stopped at its bound");
    }
}

/** Only a missing exact id looks outside the active store. Never hydrate someone else's meeting to print a hint. */
export function missingMeetingMessage(options: {
    ref: string;
    root: string;
    ordinary?: string;
    scratchRoots?: string[];
}): string {
    const { ref, root } = options;
    const ordinary = options.ordinary ?? genesisToolsDirIn(homedir(), "meetings");
    let found: string | undefined;
    if (ref !== "last" && /^[A-Za-z0-9][\w.-]*$/.test(ref) && basename(root) === "meetings") {
        if (resolve(root) !== resolve(ordinary)) {
            found = existsSync(join(ordinary, ref, MEETING_FILE)) ? ordinary : undefined;
        } else {
            const configured = env.doctor.getAgentScratchRoot();
            const roots =
                options.scratchRoots ??
                (configured ? [configured] : [...scratchRootNames()].map((dir) => join(sharedTempRoot(), dir)));
            found = scratchStoreWith(ref, roots);
        }
    }
    const setting =
        found === ordinary ? "GENESIS_TOOLS_HOME unset" : found && `GENESIS_TOOLS_HOME=${dirname(dirname(found))}`;
    return `No meeting "${ref}" in ${root}.${found ? ` Found in ${found} with ${setting}.` : ""} List them: ${TOOL} list`;
}

/**
 * `--json` is the short form of `--format json`, as on every other meetings command (MC19). The `--format` value for
 * `resolveEnum`, or undefined (exit 1) when `--json` comes with another format.
 */
export function formatFlag(opts: { format?: string | boolean; json?: boolean }): { format: unknown } | undefined {
    if (!opts.json) {
        return { format: opts.format };
    }

    if (opts.format !== undefined && opts.format !== "json") {
        const other = opts.format === true ? "--format" : `--format ${opts.format}`;
        ui.err(`--json means --format json, so it cannot go with ${other}`);
        process.exitCode = 1;
        return undefined;
    }

    return { format: "json" };
}

/**
 * An enumerated flag declared `--flag [value]`: a value is checked, a bare flag prompts in a
 * terminal, and anything else prints the possible values with a ready command.
 */
export async function resolveEnum<T extends string>(options: {
    value: unknown;
    fallback?: T;
    values: readonly T[];
    flag: string;
    subcommand: string[];
}): Promise<T | undefined> {
    const { value, values, flag, subcommand } = options;

    if (value === undefined && options.fallback !== undefined) {
        return options.fallback;
    }

    if (typeof value === "string" && (values as readonly string[]).includes(value)) {
        return value as T;
    }

    if ((value === true || value === undefined) && isInteractive()) {
        const picked = await p.select({ message: flag, options: values.map((v) => ({ value: v, label: v })) });

        if (p.isCancel(picked)) {
            process.exitCode = 1;
            return undefined;
        }

        return picked as T;
    }

    ui.err(enumHint({ flag, values, subcommand, given: typeof value === "string" ? value : undefined }));
    process.exitCode = 1;
    return undefined;
}

/**
 * The refusal of an enumerated value, with a command that runs: the subcommand words stay in it (`suggestCommand`
 * strips them from argv, so they belong in the tool name), and a positional value (`<mode>`) is replaced in place.
 */
export function enumHint(options: {
    flag: string;
    values: readonly string[];
    subcommand: string[];
    given?: string;
}): string {
    const { flag, values, subcommand, given } = options;
    const example = values[0] ?? "<value>";
    const positional = flag.startsWith("<");
    const suggestion = suggestCommand([TOOL, ...subcommand].join(" "), {
        subcommand,
        remove: positional ? (given ? [given] : []) : [flag],
        add: positional ? [example] : [flag, example],
    });

    return formatMissingEnumHelp({ flag, values, given, suggestion });
}

/** `YYYY-MM-DD-HHMM` in local time, for the name of a backup a person finds by its time. */
export function localStamp(at: Date): string {
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`;
}

/** An additive stderr record for native callers; stdout remains the command's result. */
export function errorJSON(error: unknown, message = errorText(error)): string {
    const body = rpcErrorBody(error, "meetings");
    const cause =
        error instanceof Error && error.cause instanceof Error ? rpcErrorBody(error.cause, "meetings") : undefined;
    const stack = cause?.stack ?? body.stack;
    const title = body.issue.title ?? cause?.issue.title;
    return SafeJSON.stringify({
        error: {
            code: body.code,
            ...(errorCode(error) ? { data: { code: errorCode(error) } } : {}),
            message: redactCurrentRunText(message),
            ...(stack ? { stack: redactCurrentRunText(stack) } : {}),
            issue: {
                tool: body.issue.tool,
                ...(title ? { title: redactCurrentRunText(title) } : {}),
            },
        },
    });
}

export function fail(error: unknown): void {
    const message = errorText(error);
    const failure = error instanceof Error ? error : new Error(message);
    ui.raw(errorJSON(failure, message));
    ui.err(message);
    process.exitCode = 1;
}

/**
 * The error's sentence; a conflict or a meeting state leads with its code (`[export-edited] …`,
 * `[no-transcript-source] …`), which the window reads.
 */
export function errorText(err: unknown): string {
    const code = errorCode(err);
    const raw = err instanceof Error ? err.message : String(err);
    const missing = /^No meeting "([^"\r\n]+)"(?:\.|\. List them: tools meetings list| \(tools meetings list\))?$/.exec(
        raw
    );
    const message = missing ? missingMeetingMessage({ ref: missing[1]!, root: toolDataDir("meetings") }) : raw;
    return code ? `[${code}] ${message}` : message;
}

/** Service refusals and local state errors keep the same machine-readable code. */
function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
