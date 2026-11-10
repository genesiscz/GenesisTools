import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { checkEvent } from "@genesiscz/utils/metrics/dims";
import { appendSpoolLines, localDay, spoolDir, spoolFileName, spoolLine } from "@genesiscz/utils/metrics/spool";
import type { Dims } from "@genesiscz/utils/metrics/types";
import type { Command } from "commander";
import { collect, dimValueOf, FlagError } from "../lib/filters";
import { withFlags } from "../lib/service";

const WRITER = "cli";

interface RecordFlags {
    dim?: string[];
    context?: string;
}

function dimsOf(pairs: readonly string[]): Dims {
    const dims: Dims = {};

    for (const pair of pairs) {
        const at = pair.indexOf("=");

        if (at <= 0) {
            throw new FlagError(`--dim ${pair}: write name=value`);
        }

        dims[pair.slice(0, at)] = dimValueOf(pair.slice(at + 1));
    }

    return dims;
}

function contextOf(text: string | undefined): unknown {
    if (text === undefined) {
        return undefined;
    }

    try {
        return SafeJSON.parse(text, { strict: true });
    } catch (error) {
        throw new FlagError(`--context: not JSON (${error instanceof Error ? error.message : String(error)})`);
    }
}

async function record(project: string, metric: string, valueText: string, flags: RecordFlags): Promise<void> {
    const value = Number(valueText);

    if (valueText.trim() === "" || !Number.isFinite(value)) {
        throw new FlagError(`value ${valueText}: not a number`);
    }

    const now = Date.now();
    const context = contextOf(flags.context);
    const event = {
        project,
        metric,
        at: now,
        value,
        dims: dimsOf(flags.dim ?? []),
        ...(context === undefined ? {} : { context }),
    };
    const check = checkEvent(event, now);

    if (!check.ok) {
        throw new FlagError(check.reason);
    }

    appendSpoolLines({ writer: WRITER, lines: [spoolLine(event)], now });
    out.printlnErr(`Spooled ${project} / ${metric} = ${value}; the metrics service takes it in at its next drain.`);
    out.result({ spooled: `${spoolDir()}/${spoolFileName(WRITER, localDay(now))}`, event });
}

export function registerRecordCommand(program: Command): void {
    program
        .command("record <project> <metric> <value>")
        .description("Append one event to the spool (no service needed); the service takes it in at its next drain")
        .option("--dim <name=value>", "a dim to group and filter by (repeat it)", collect, [])
        .option("--context <json>", "free JSON kept with the event")
        .action((project: string, metric: string, value: string, flags: RecordFlags) =>
            withFlags(() => record(project, metric, value, flags))
        );
}
