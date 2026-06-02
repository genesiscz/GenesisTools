import { out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { Command } from "commander";
import { mergeServers, readConfigSources } from "./lib/discovery";
import { probeServer } from "./lib/probe";
import { buildReport, formatConfigTable, formatHealthTable } from "./lib/report";
import type { NormalizedServer, ProbeResult } from "./lib/types";

interface SharedOpts {
    json?: boolean;
    timeout: string;
    slow: string;
    only?: string;
    project?: string;
}

function withSharedOptions(cmd: Command): Command {
    return cmd
        .option("--json", "Emit machine-readable JSON to stdout")
        .option("--timeout <ms>", "Per-server probe timeout in ms", "15000")
        .option("--slow <ms>", "Latency above which a server is flagged slow", "3000")
        .option("--only <names>", "Restrict to comma-separated server names")
        .option("--project <dir>", "Project root to scan for .mcp.json / .cursor/mcp.json");
}

function filterByOnly(servers: NormalizedServer[], only?: string): NormalizedServer[] {
    if (!only) {
        return servers;
    }

    const wanted = new Set(
        only
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
    );
    return servers.filter((s) => wanted.has(s.name));
}

async function discover(opts: SharedOpts): Promise<NormalizedServer[]> {
    const projectDir = opts.project ?? process.cwd();
    const blobs = await readConfigSources({ projectDir });
    return filterByOnly(mergeServers(blobs), opts.only);
}

async function probeAll(servers: NormalizedServer[], opts: SharedOpts): Promise<ProbeResult[]> {
    const timeoutMs = Number(opts.timeout);
    const slowThresholdMs = Number(opts.slow);
    return Promise.all(servers.map((server) => probeServer(server, { timeoutMs, slowThresholdMs })));
}

const program = new Command();

program.name("mcp-doctor").description("Health-check & benchmark your configured MCP servers");

withSharedOptions(program.command("list"))
    .description("Discover & normalize config only — no spawn")
    .action(async (_args, cmd: Command) => {
        const opts = cmd.optsWithGlobals<SharedOpts>();
        const servers = await discover(opts);
        if (opts.json) {
            out.result({ servers });
            return;
        }

        if (servers.length === 0) {
            out.log.warn("No MCP servers configured.");
            return;
        }

        out.println(formatConfigTable(servers));
    });

withSharedOptions(program.command("check", { isDefault: true }))
    .description("Spawn/connect & probe every configured server (default)")
    .action(async (_args, cmd: Command) => {
        const opts = cmd.optsWithGlobals<SharedOpts>();
        const servers = await discover(opts);
        if (servers.length === 0) {
            out.log.warn("No MCP servers configured — nothing to check.");
            return;
        }

        const spinner = out.spinner();
        spinner.start(`Probing ${servers.length} servers…`);
        const results = await probeAll(servers, opts);
        spinner.stop("Probe complete");

        const report = buildReport(results);
        if (opts.json) {
            out.result(report);
            return;
        }

        out.println(formatHealthTable(report, Number(opts.slow)));
    });

withSharedOptions(program.command("tools <server>"))
    .description("Probe one server and print its tools / resources / prompts")
    .action(async (serverName: string, cmd: Command) => {
        const opts = cmd.optsWithGlobals<SharedOpts>();
        const servers = await discover({ ...opts, only: serverName });
        const target = servers.find((s) => s.name === serverName);
        if (!target) {
            out.log.error(`No configured server named "${serverName}".`);
            process.exitCode = 1;
            return;
        }

        const [result] = await probeAll([target], opts);
        if (opts.json) {
            out.result(result);
            return;
        }

        out.println(SafeJSON.stringify(result, null, 2));
    });

await runTool(program, { tool: "mcp-doctor" });
