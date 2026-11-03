import { suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";

/**
 * `--harness` picks transcript data by the agent that wrote it (AI usage design 2026-11-01, section 5). The older
 * spellings stay, with the same values and the same meaning: `--sources` on the reports and `series`, `--backend`
 * on `workers`.
 */
export function addHarnessOption(command: Command, legacy: string): Command {
    // An optional value: a bare `--harness` reaches the same list-of-agents diagnostic as an unknown one, where a
    // required value stopped in commander's generic "argument missing".
    return command.option("--harness [ids]", `Only the transcripts these agents wrote; same values as ${legacy}`);
}

export interface HarnessFlag {
    /** The flag the value came from, for a diagnostic that names what the user typed. */
    flag: string;
    raw: string | undefined;
}

/** A comma list as the parser reads it: entries trimmed, empty ones dropped, order and repeats ignored. */
function listKey(raw: string): string {
    const entries = raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);

    return [...new Set(entries)].sort().join(",");
}

/**
 * The one list `--harness` and its older spelling give. `null` means both were given with different lists: the
 * diagnostic is printed and `process.exitCode` set, so the action returns.
 */
export function resolveHarnessFlag({
    harness,
    legacy,
    legacyFlag,
}: {
    harness: string | true | undefined;
    legacy: string | undefined;
    legacyFlag: string;
}): HarnessFlag | null {
    // A bare `--harness` is a given flag with an empty list, which every reader refuses with the list of agents.
    const given = harness === true ? "" : harness;

    if (given !== undefined && legacy !== undefined && listKey(given) !== listKey(legacy)) {
        out.error(`--harness ${given} and ${legacyFlag} ${legacy} name different lists; pass one of them.`);
        process.exitCode = 1;

        return null;
    }

    if (given !== undefined) {
        return { flag: "--harness", raw: given };
    }

    return { flag: legacyFlag, raw: legacy };
}

/**
 * `null` means "rejected, diagnostic already printed" and the action returns.
 *
 * Throwing instead would reach `runTool`'s uncaught `program.parseAsync()`, so a
 * mistyped `--sources` printed a Bun stack trace with a source excerpt where a
 * one-line flag diagnostic belongs. `flag` is the spelling the user typed
 * (`--harness` or `--sources`), so the diagnostic names it.
 */
export function parseSources<T extends string>(
    raw: string | undefined,
    { command, ids, flag }: { command: string; ids: readonly T[]; flag: string }
): T[] | undefined | null {
    if (raw === undefined) {
        return undefined;
    }

    const wanted = raw
        .split(",")
        .map((value) => value.trim())
        .filter((value) => value.length > 0);
    const known = (value: string): value is T => (ids as readonly string[]).includes(value);
    const unknown = wanted.filter((value) => !known(value));

    // An empty list (a bare `--harness`) is refused like an unknown one: it names no agent.
    if (unknown.length > 0 || wanted.length === 0) {
        out.error(
            suggestEnumFlag(`tools ai-spend ${command}`, flag, ids, {
                subcommand: [command],
                given: unknown.length > 0 ? unknown.join(", ") : undefined,
            })
        );
        process.exitCode = 1;

        return null;
    }

    return wanted.filter(known);
}

/**
 * The inherited `--harness` (or `--sources`) of a command that reads one source namespace or all of them: the
 * namespace (`ai-spend codex daily`) when one is given, else the listed sources, else undefined (every source). A list
 * that leaves the namespace out is refused, so a report is never printed unfiltered under a filter. `null`: refused,
 * diagnostic printed, `process.exitCode` set.
 */
export function harnessSources<T extends string>({
    cmd,
    command,
    ids,
    namespace,
}: {
    cmd: Command;
    command: string;
    ids: readonly T[];
    namespace?: T;
}): T[] | undefined | null {
    const flags = cmd.optsWithGlobals<{ harness?: string | true; sources?: string }>();
    const harness = resolveHarnessFlag({ harness: flags.harness, legacy: flags.sources, legacyFlag: "--sources" });

    if (!harness) {
        return null;
    }

    const listed = parseSources(harness.raw, { command, ids, flag: harness.flag });

    if (listed === null || namespace === undefined) {
        return listed;
    }

    if (listed !== undefined && !listed.includes(namespace)) {
        out.error(
            `${harness.flag} ${harness.raw} leaves out ${namespace}, the one source \`${namespace} ${command}\` reads.`
        );
        process.exitCode = 1;

        return null;
    }

    return [namespace];
}
