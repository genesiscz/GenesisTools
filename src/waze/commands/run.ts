import { untilAborted } from "@genesiscz/utils/async";
import { suggestEnumFlag } from "@genesiscz/utils/cli/executor";
import { withInterrupt } from "@genesiscz/utils/cli/interrupt";
import { isInteractive } from "@genesiscz/utils/cli/is-interactive";
import { logger, out } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { type Command, InvalidArgumentError } from "commander";
import { z } from "zod";
import { WazeContext } from "../lib/context";
import { findOperation, type OperationResult } from "../lib/operations";
import { ALERT_CATEGORIES, type AlertCategory, isAlertCategory } from "../lib/types";

export const TOOL = "tools waze";

export interface GlobalOptions {
    json?: boolean;
    port?: number;
    keepTab?: boolean;
}

export function globalOptions(command: Command): GlobalOptions {
    return command.optsWithGlobals<GlobalOptions>();
}

export function openContext(command: Command): WazeContext {
    const opts = globalOptions(command);
    return new WazeContext({ port: opts.port, keepTab: opts.keepTab });
}

export function errorMessage(error: unknown): string {
    if (error instanceof z.ZodError) {
        return z.prettifyError(error);
    }

    return error instanceof Error ? error.message : String(error);
}

/** Prints an operation result: `--json` data, tables on a TTY when the operation has them, else markdown. */
export function printResult(command: Command, result: OperationResult): void {
    if (globalOptions(command).json) {
        out.result(result.data);
        return;
    }

    out.println(process.stdout.isTTY && result.tables ? result.tables : result.markdown);
}

/** Runs one operation of the shared table with a context that closes its tab on success, failure and Ctrl-C. */
export async function runOperation(command: Command, name: string, input: Record<string, unknown>): Promise<void> {
    const ctx = openContext(command);
    try {
        const result = await withInterrupt((signal) => untilAborted(findOperation(name).run(ctx, input), signal));
        printResult(command, result);
    } catch (error) {
        logger.debug({ error, operation: name, input }, "waze command failed");
        out.log.error(errorMessage(error));
        process.exitCode = 1;
    } finally {
        await ctx.close();
    }
}

export function parseNumberArg(value: string): number {
    const parsed = Number(value.replace(",", "."));
    if (!Number.isFinite(parsed)) {
        throw new InvalidArgumentError(`expected a number, got "${value}"`);
    }

    return parsed;
}

export function parseIntArg(value: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) {
        throw new InvalidArgumentError(`expected a whole number, got "${value}"`);
    }

    return parsed;
}

/**
 * `--type [list]` (comma separated categories): absent → undefined (all), bare in a TTY → a picker, an unknown value or
 * bare elsewhere → the possible values and exit 1 (null).
 */
export async function pickCategories(opts: {
    given: string | boolean | undefined;
    subcommand: string;
}): Promise<AlertCategory[] | undefined | null> {
    const { given } = opts;
    if (given === undefined || given === false) {
        return undefined;
    }

    if (typeof given === "string") {
        const parts = given
            .split(",")
            .map((part) => part.trim().toLowerCase())
            .filter(Boolean);
        const valid = parts.filter(isAlertCategory);
        if (parts.length > 0 && valid.length === parts.length) {
            return valid;
        }
    }

    if (given === true && isInteractive()) {
        const picked = await p.multiselect({
            message: "Report types",
            options: ALERT_CATEGORIES.map((value) => ({ value, label: value })),
        });
        return picked.map(String).filter(isAlertCategory);
    }

    out.printlnErr(
        suggestEnumFlag(`${TOOL} ${opts.subcommand}`, "--type", ALERT_CATEGORIES, {
            subcommand: [opts.subcommand],
            given: typeof given === "string" ? given : undefined,
        })
    );
    process.exitCode = 1;
    return null;
}
