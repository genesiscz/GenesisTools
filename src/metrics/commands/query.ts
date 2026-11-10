import { isInteractive, suggestEnumFlag } from "@genesiscz/utils/cli";
import { out } from "@genesiscz/utils/logger";
import { METRIC_AGGREGATES } from "@genesiscz/utils/metrics/types";
import * as p from "@genesiscz/utils/prompts/p";
import type { Command } from "commander";
import { printEvents, printQuery } from "../lib/display";
import { collect, eventsLimitOf, type FilterFlags, filterOf, type QueryFlags, queryOf } from "../lib/filters";
import { withFlags, withService } from "../lib/service";

/** `--agg` with no value: a TTY picks the aggregates, anything else gets the values listed and exit code 1. */
async function pickAggregates(flags: QueryFlags): Promise<QueryFlags | undefined> {
    if (flags.agg !== true && flags.agg !== "") {
        return flags;
    }

    if (!isInteractive()) {
        out.printlnErr(suggestEnumFlag("tools metrics", "--agg", METRIC_AGGREGATES, { subcommand: ["query"] }));
        process.exitCode = 1;
        return undefined;
    }

    const picked = await p.multiselect({
        message: "Aggregates",
        options: METRIC_AGGREGATES.map((value) => ({ value, label: value })),
        required: true,
        cancel: "back",
    });

    return p.isCancel(picked) ? undefined : { ...flags, agg: picked.join(",") };
}

async function query(project: string, metric: string, given: QueryFlags): Promise<void> {
    const flags = await pickAggregates(given);

    if (!flags) {
        return;
    }

    const request = queryOf(project, metric, flags);
    await withService(async (client) => {
        const result = await client.call("query", request);

        if (flags.json) {
            out.result(result);
            return;
        }

        printQuery(result);
    });
}

async function events(project: string, metric: string, flags: FilterFlags): Promise<void> {
    const limit = eventsLimitOf(flags);
    const request = { ...filterOf(project, metric, flags, "events"), ...(limit ? { limit } : {}) };
    await withService(async (client) => {
        const result = await client.call("events", request);

        if (flags.json) {
            out.result(result);
            return;
        }

        printEvents(result);
    });
}

function filterOptions(command: Command): Command {
    return command
        .option("--since <when>", "from this long ago (10d, 2h, 30m) or this date or time")
        .option("--until <when>", "before this long ago, date or time")
        .option("--where <filter>", "dim=value, dim=a,b (one of), dim!=value or dim~glob (repeat it)", collect, [])
        .option("--json", "print the answer as JSON");
}

export function registerQueryCommands(program: Command): void {
    filterOptions(
        program
            .command("query <project> <metric>")
            .description("Group, aggregate and sort a metric's events: by dims and by time:hour or time:day")
    )
        .option("--group-by <names>", "dims to group by, comma-separated, and time:hour or time:day")
        .option("--agg [list]", `aggregates, comma-separated: ${METRIC_AGGREGATES.join(", ")} (default count,sum)`)
        .option("--sort <key>", "an aggregate or a group key; a leading - sorts descending (default -sum)")
        .option("--limit <n>", "the most rows (default 50)")
        .action((project: string, metric: string, flags: QueryFlags) => withFlags(() => query(project, metric, flags)));

    filterOptions(
        program
            .command("events <project> <metric>")
            .description("The single events of a metric with their dims and context, newest first")
    )
        .option("--limit <n>", "the most events (default 20)")
        .action((project: string, metric: string, flags: FilterFlags) =>
            withFlags(() => events(project, metric, flags))
        );
}
