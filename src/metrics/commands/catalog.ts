import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger, out } from "@genesiscz/utils/logger";
import type { MetricsStatus } from "@genesiscz/utils/metrics/protocol";
import { openMetricsService } from "@genesiscz/utils/metrics/service-client";
import { metricsDbPath, spoolDir } from "@genesiscz/utils/metrics/spool";
import { MetricsStore } from "@genesiscz/utils/metrics/store";
import type { MetricCatalogEntry, SpoolFileState } from "@genesiscz/utils/metrics/types";
import { isMissingFileError } from "@genesiscz/utils/storage/atomic-file";
import { renderCliHeader, renderCliKeyRow } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { printCatalog } from "../lib/display";
import { collect, parseTimeFlag } from "../lib/filters";
import { withService } from "../lib/service";

const { log } = logger.scoped("metrics-cli");

interface JsonFlag {
    json?: boolean;
}

interface DefineFlags {
    unit?: string;
    description?: string;
    dim?: string[];
}

/**
 * The spool files on disk and how many of their bytes the store has not taken in yet. The service may delete a drained
 * file of an earlier day between the listing and its stat, so a file that is gone by then is left out; any other stat
 * error names the file. `sizeOf` is a seam for a test.
 */
export function spoolBacklog(
    read: readonly SpoolFileState[],
    sizeOf: (path: string) => number = (path) => statSync(path).size
): Array<{ path: string; bytes: number; pending: number }> {
    const dir = spoolDir();
    let names: string[];

    try {
        names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    } catch (error) {
        log.debug({ error, dir }, "no metrics spool folder");
        return [];
    }

    return names.sort().flatMap((name) => {
        const path = join(dir, name);
        let bytes: number;

        try {
            bytes = sizeOf(path);
        } catch (error) {
            if (isMissingFileError(error)) {
                log.debug({ path }, "a spool file was drained and deleted while the backlog was read");
                return [];
            }

            throw new Error(`cannot read the size of the spool file ${path}`, { cause: error });
        }

        const offset = read.find((file) => file.path === path)?.offset ?? 0;
        return [{ path, bytes, pending: Math.max(0, bytes - offset) }];
    });
}

interface DiagnosticState {
    source: "service" | "file" | "none";
    catalog: MetricCatalogEntry[];
    files: SpoolFileState[];
    status?: MetricsStatus;
}

/**
 * The catalog and spool state for a diagnostic: from the running service when there is one, else from the store
 * file opened read-only. Neither starts the service or drains the spool.
 */
async function readState(): Promise<DiagnosticState> {
    const opened = await openMetricsService({ start: false });

    if (opened.status === "connected") {
        try {
            const catalog = await opened.client.call("catalog", {});
            const status = await opened.client.call("status", {});
            return { source: "service", catalog, files: status.spool.files, status };
        } finally {
            opened.client.close();
        }
    }

    const store = MetricsStore.openReadOnly(metricsDbPath());

    if (!store) {
        return { source: "none", catalog: [], files: [] };
    }

    try {
        return { source: "file", catalog: store.catalog(), files: store.spoolFiles() };
    } finally {
        store.close();
    }
}

async function list(flags: JsonFlag): Promise<void> {
    const state = await readState();
    const backlog = spoolBacklog(state.files).reduce((sum, file) => sum + file.pending, 0);

    if (flags.json) {
        out.result({ source: state.source, metrics: state.catalog, spoolPendingBytes: backlog });
        return;
    }

    if (state.source === "none") {
        out.printlnErr(`No metrics store yet (${metricsDbPath()}).`);
    }

    const where = state.source === "service" ? "from the running service" : "from the store file";
    printCatalog(state.catalog, `${where} · ${backlog} spool bytes not taken in yet`);
}

async function status(flags: JsonFlag): Promise<void> {
    const state = await readState();
    const files = spoolBacklog(state.files);
    const answer = {
        service: state.source === "service" ? state.status : null,
        db: metricsDbPath(),
        metrics: state.catalog.length,
        events: state.catalog.reduce((sum, entry) => sum + entry.count, 0),
        spool: files,
    };

    if (flags.json) {
        out.result(answer);
        return;
    }

    renderCliHeader("Metrics status", state.source === "service" ? "service running" : "no service runs");
    renderCliKeyRow("db", answer.db);
    renderCliKeyRow("metrics", String(answer.metrics));
    renderCliKeyRow("events", answer.events.toLocaleString("en-US"));

    for (const file of files) {
        renderCliKeyRow("spool", `${file.path} · ${file.bytes} bytes · ${file.pending} not taken in`);
    }
}

async function define(project: string, metric: string, flags: DefineFlags): Promise<void> {
    await withService(async (client) => {
        const entry = await client.call("define", {
            project,
            metric,
            ...(flags.unit ? { unit: flags.unit } : {}),
            ...(flags.description ? { description: flags.description } : {}),
            ...(flags.dim?.length ? { dims: flags.dim } : {}),
        });
        out.printlnErr(`Defined ${project} / ${metric}; indexed dims: ${entry.dims.join(", ") || "none"}`);
        out.result(entry);
    });
}

async function prune(flags: { before: string }): Promise<void> {
    const before = parseTimeFlag(flags.before, "--before");

    await withService(async (client) => {
        const { removed } = await client.call("prune", { before });
        out.printlnErr(
            `Removed ${removed.toLocaleString("en-US")} events older than ${new Date(before).toISOString()}`
        );
        out.result({ before, removed });
    });
}

export function registerCatalogCommands(program: Command): void {
    program
        .command("prune")
        .description(
            "Delete the events of every metric older than a time; the store keeps everything until you run this"
        )
        .requiredOption("--before <when>", "an age (90d, 12h) or an ISO time")
        .action((flags: { before: string }) => prune(flags));

    program
        .command("define <project> <metric>")
        .description("Declare a metric's unit and description, and the dims that get an index (any dim works without)")
        .option("--unit <unit>", "chars, ms, tokens, count, ...")
        .option("--description <text>", "what the number measures")
        .option("--dim <name>", "a dim to index (repeat it)", collect, [])
        .action((project: string, metric: string, flags: DefineFlags) => define(project, metric, flags));

    program
        .command("list")
        .description(
            "Every project and metric with its event count and first and last time; reads only (never starts the service or drains the spool)"
        )
        .option("--json", "print the catalog as JSON")
        .action((flags: JsonFlag) => list(flags));

    program
        .command("status")
        .description("The service, the store and the spool backlog; reads only (never starts the service or drains)")
        .option("--json", "print the status as JSON")
        .action((flags: JsonFlag) => status(flags));
}
