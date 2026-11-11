import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { openMetricsService } from "@genesiscz/utils/metrics/service-client";
import { metricsDbPath } from "@genesiscz/utils/metrics/spool";
import { MetricsStore } from "@genesiscz/utils/metrics/store";
import type { MetricCheckpoint } from "@genesiscz/utils/metrics/types";
import type { Command } from "commander";
import { localTime, printCheckpoints } from "../lib/display";
import { FlagError, parseWhen } from "../lib/filters";
import { withFlags, withService } from "../lib/service";

interface AddFlags {
    commit?: string;
    repo?: string;
    note?: string;
    at?: string;
    data?: string;
}

function dataOf(text: string | undefined): unknown {
    if (text === undefined) {
        return undefined;
    }

    try {
        return SafeJSON.parse(text, { strict: true });
    } catch (error) {
        throw new FlagError(`--data: not JSON (${error instanceof Error ? error.message : String(error)})`);
    }
}

async function add(project: string, name: string, flags: AddFlags): Promise<void> {
    const data = dataOf(flags.data);
    const params = {
        project,
        name,
        ...(flags.at ? { at: parseWhen(flags.at, "--at") } : {}),
        ...(flags.commit ? { commit: flags.commit } : {}),
        ...(flags.repo ? { repo: flags.repo } : {}),
        ...(flags.note ? { note: flags.note } : {}),
        ...(data === undefined ? {} : { data }),
    };

    await withService(async (client) => {
        const checkpoint = await client.call("checkpoint.add", params);
        out.printlnErr(`Checkpoint ${checkpoint.project} / ${checkpoint.name} at ${localTime(checkpoint.at, true)}`);
        out.result(checkpoint);
    });
}

/**
 * The checkpoints from the running service when there is one, else from the store file opened read-only. Neither
 * starts the service or drains the spool, like `list` and `status`.
 */
async function readCheckpoints(
    project: string | undefined
): Promise<{ source: "service" | "file" | "none"; checkpoints: MetricCheckpoint[] }> {
    const opened = await openMetricsService({ start: false });

    if (opened.status === "connected") {
        try {
            const checkpoints = await opened.client.call("checkpoint.list", project ? { project } : {});
            return { source: "service", checkpoints };
        } finally {
            opened.client.close();
        }
    }

    const store = MetricsStore.openReadOnly(metricsDbPath());

    if (!store) {
        return { source: "none", checkpoints: [] };
    }

    try {
        return { source: "file", checkpoints: store.checkpoints(project) };
    } finally {
        store.close();
    }
}

async function list(project: string | undefined, flags: { json?: boolean }): Promise<void> {
    const state = await readCheckpoints(project);

    if (flags.json) {
        out.result({ source: state.source, checkpoints: state.checkpoints });
        return;
    }

    if (state.source === "none") {
        out.printlnErr(`No metrics store yet (${metricsDbPath()}).`);
    }

    const where = state.source === "service" ? "from the running service" : "from the store file";
    printCheckpoints(state.checkpoints, `${where} · a checkpoint still in the spool shows after the next drain`);
}

async function remove(project: string, name: string): Promise<void> {
    await withService(async (client) => {
        const { removed } = await client.call("checkpoint.remove", { project, name });

        if (!removed) {
            out.printlnErr(`No checkpoint ${project} / ${name}.`);
            process.exitCode = 1;
        } else {
            out.printlnErr(`Removed checkpoint ${project} / ${name}.`);
        }

        out.result({ project, name, removed });
    });
}

export function registerCheckpointCommand(program: Command): void {
    const checkpoint = program
        .command("checkpoint")
        .description(
            'Mark "at this time we changed Y in commit Z" in a project, then group and compare its metrics by it (query --group-by checkpoint)'
        );

    checkpoint
        .command("add <project> <name>")
        .description("Add a checkpoint, or update the one of that name (a field left out keeps its value)")
        .option("--commit <sha>", "the commit the change landed in")
        .option("--repo <text>", "the repository, a name or a path")
        .option("--note <text>", "what changed")
        .option("--at <when>", "when it took effect: a time, a date, or an age (2h); default now for a new name")
        .option("--data <json>", "any JSON to keep with it")
        .action((project: string, name: string, flags: AddFlags) => withFlags(() => add(project, name, flags)));

    checkpoint
        .command("list [project]")
        .description("The checkpoints, by project and time; reads only (never starts the service or drains the spool)")
        .option("--json", "print them as JSON")
        .action((project: string | undefined, flags: { json?: boolean }) => list(project, flags));

    checkpoint
        .command("rm <project> <name>")
        .description("Remove a checkpoint; its events stay and fall under the checkpoint before it")
        .action((project: string, name: string) => remove(project, name));
}
