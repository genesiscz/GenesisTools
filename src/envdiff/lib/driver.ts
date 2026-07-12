import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { diffEnv, isFailing } from "./diff";
import { parseEnv } from "./parse";
import { renderDiff, toJsonShape } from "./render";
import { resolveEnvPaths } from "./resolve";
import { buildSyncedContent } from "./sync";

export interface RunEnvdiffArgs {
    positionals: string[];
    actual?: string;
    example?: string;
    showValues: boolean;
    sync: boolean;
    json: boolean;
    checkValues: boolean;
    color: boolean;
    cwd: string;
    now: Date;
}

export interface RunEnvdiffResult {
    exitCode: number;
    /** Machine result destined for stdout. */
    stdout: string;
    /** Human status destined for stderr / out.log. */
    status: string[];
}

export function runEnvdiff(args: RunEnvdiffArgs): RunEnvdiffResult {
    if (args.positionals.length > 2) {
        logger.error({ positionals: args.positionals }, "envdiff: too many positional arguments");
        return {
            exitCode: 2,
            stdout: "",
            status: [`Expected at most 2 positional arguments (actual, example), got ${args.positionals.length}.`],
        };
    }

    const { actual, example } = resolveEnvPaths({
        positionals: args.positionals,
        cwd: args.cwd,
        actual: args.actual,
        example: args.example,
    });

    const status: string[] = [];

    if (!existsSync(example)) {
        logger.error({ example }, "envdiff: example file not found");
        return { exitCode: 2, stdout: "", status: [`Example file not found: ${example}`] };
    }

    let exampleContent: string;
    try {
        exampleContent = readFileSync(example, "utf-8");
    } catch (err) {
        logger.error({ error: err, example }, "envdiff: failed to read example file");
        return { exitCode: 2, stdout: "", status: [`Failed to read example file: ${example}`] };
    }

    const actualExists = existsSync(actual);
    let actualContent = "";
    if (actualExists) {
        try {
            actualContent = readFileSync(actual, "utf-8");
        } catch (err) {
            logger.error({ error: err, actual }, "envdiff: failed to read actual file");
            return { exitCode: 2, stdout: "", status: [`Failed to read actual file: ${actual}`] };
        }
    } else {
        status.push(`Actual file not found (${actual}); treating as empty.`);
    }

    const parsedActual = parseEnv(actualContent);
    const parsedExample = parseEnv(exampleContent);
    const diff = diffEnv(parsedActual, parsedExample);

    logger.debug(
        { actual, example, missing: diff.missing.length, extra: diff.extra.length, changed: diff.changed.length },
        "envdiff computed diff"
    );

    if (args.sync) {
        const synced = buildSyncedContent({ actualContent, diff, now: args.now });
        if (synced !== actualContent) {
            try {
                writeFileSync(actual, synced);
            } catch (err) {
                logger.error({ error: err, actual }, "envdiff: failed to write synced file");
                return { exitCode: 2, stdout: "", status: [`Failed to write ${actual}`] };
            }
        }

        const added = diff.missing.map((m) => `    + ${m.key}`).join("\n");
        const summary =
            diff.missing.length > 0
                ? `Synced ${diff.missing.length} keys into ${actual}:\n${added}`
                : `Nothing to sync — ${actual} already has every example key.`;
        return { exitCode: 0, stdout: summary, status };
    }

    const failing = isFailing(diff, { checkValues: args.checkValues });

    if (args.json) {
        return {
            exitCode: failing ? 1 : 0,
            stdout: SafeJSON.stringify(toJsonShape(diff, { actual, example })),
            status,
        };
    }

    const text = renderDiff({
        diff,
        actualLabel: actual,
        exampleLabel: example,
        showValues: args.showValues,
        color: args.color,
    });
    return { exitCode: failing ? 1 : 0, stdout: text, status };
}
