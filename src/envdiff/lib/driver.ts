import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { diffEnv, hasDrift } from "./diff";
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

    const actualExists = existsSync(actual);
    const actualContent = actualExists ? readFileSync(actual, "utf-8") : "";
    if (!actualExists) {
        status.push(`Actual file not found (${actual}); treating as empty.`);
    }

    const exampleContent = readFileSync(example, "utf-8");
    const parsedActual = parseEnv(actualContent);
    const parsedExample = parseEnv(exampleContent);
    const diff = diffEnv(parsedActual, parsedExample);

    logger.debug(
        { actual, example, missing: diff.missing.length, extra: diff.extra.length, changed: diff.changed.length },
        "envdiff computed diff"
    );

    if (args.sync) {
        const synced = buildSyncedContent({ actualContent, diff, now: args.now });
        writeFileSync(actual, synced);
        const added = diff.missing.map((m) => `    + ${m.key}`).join("\n");
        const summary =
            diff.missing.length > 0
                ? `Synced ${diff.missing.length} keys into ${actual}:\n${added}`
                : `Nothing to sync — ${actual} already has every example key.`;
        return { exitCode: 0, stdout: summary, status };
    }

    if (args.json) {
        return {
            exitCode: hasDrift(diff) ? 1 : 0,
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
    return { exitCode: hasDrift(diff) ? 1 : 0, stdout: text, status };
}
