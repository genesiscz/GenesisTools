import { concurrentMap } from "@genesiscz/utils/async";
import { Executor } from "@genesiscz/utils/cli";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { mergeServers, readConfigSources } from "../lib/doctor/discovery.ts";
import { buildEnvReport, type CommandResult, collectCommands, runCommandString } from "../lib/doctor/env-report.ts";
import { probeServer } from "../lib/doctor/probe.ts";
import {
    buildReport,
    formatConfigTable,
    formatEmptyServersMessage,
    formatHealthTable,
    redactServerForOutput,
} from "../lib/doctor/report.ts";
import type { NormalizedServer, ProbeResult } from "../lib/doctor/types.ts";

export interface DoctorOptions {
    json?: boolean;
    timeout: string;
    slow: string;
    only?: string;
    project?: string;
}

export interface DoctorEnvOptions {
    /** Per-command timeout in ms, as the flag was typed. */
    timeout: string;
}

function parsePositiveMs(flag: string, value: string): number {
    const ms = Number(value);

    if (!Number.isFinite(ms) || ms <= 0) {
        throw new Error(`Invalid ${flag} value: "${value}". Must be a positive number.`);
    }

    return ms;
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

async function discover(opts: DoctorOptions): Promise<NormalizedServer[]> {
    const projectDir = opts.project ?? process.cwd();
    const blobs = await readConfigSources({ projectDir });

    return filterByOnly(mergeServers(blobs), opts.only);
}

export async function probeAll(
    servers: NormalizedServer[],
    opts: DoctorOptions,
    dependencies: { probe?: typeof probeServer; concurrency?: number } = {}
): Promise<ProbeResult[]> {
    const timeoutMs = parsePositiveMs("--timeout", opts.timeout);
    const slowThresholdMs = parsePositiveMs("--slow", opts.slow);
    const results = await concurrentMap({
        items: servers,
        concurrency: dependencies.concurrency ?? 4,
        fn: (server) => (dependencies.probe ?? probeServer)(server, { timeoutMs, slowThresholdMs }),
    });

    return servers.flatMap((server) => {
        const result = results.get(server);
        return result ? [result] : [];
    });
}

export async function doctorList(opts: DoctorOptions): Promise<void> {
    const servers = await discover(opts);

    if (opts.json) {
        out.result({ servers: servers.map(redactServerForOutput) });
        return;
    }

    if (servers.length === 0) {
        out.log.warn(formatEmptyServersMessage());
        return;
    }

    out.println(formatConfigTable(servers));
}

export async function doctorCheck(opts: DoctorOptions): Promise<void> {
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
}

export async function doctorTools(serverName: string, opts: DoctorOptions): Promise<void> {
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
}

// The scoped `out` does not mirror into the day log, which matters here: the dump below holds the whole environment.
// `log` is the file side, so it carries counts only: a command's arguments can hold a token.
const { log, out: stderrOnly } = logger.scoped("mcp-manager-doctor-env");

function debugLog(message: string): void {
    stderrOnly.printlnErr(`[doctor env] ${message}`);
}

/**
 * Prints what an MCP client starts a server with, as JSON on stdout, with the diagnostics on stderr. Nothing
 * else may reach stdout, because a client parses it. The environment is printed whole: it can hold secrets.
 * A command that outlives `--timeout` is killed and reported as failed, so one hung command cannot stop the report.
 */
export async function doctorEnv(commandArgs: string[], opts: DoctorEnvOptions): Promise<void> {
    const timeoutMs = parsePositiveMs("--timeout", opts.timeout);
    const commands = collectCommands(commandArgs, env.tools.getCommands());
    const processEnv = env.getProcessEnv();
    const exec = new Executor();

    debugLog(`Working directory: ${process.cwd()}`);
    debugLog(`Environment variables: ${SafeJSON.stringify(processEnv, null, 2)}`);
    debugLog(`Will execute ${commands.length} command(s)`);
    log.debug({ commandCount: commands.length }, "doctor env runs commands");

    const results: CommandResult[] = [];

    for (const command of commands) {
        debugLog(`Executing command: ${command}`);
        const result = await runCommandString(command, (parts) => exec.exec(parts, { timeout: timeoutMs }));
        debugLog(`Exit code: ${result.exitCode}`);
        debugLog(`stdout: ${result.stdout}`);

        if (result.stderr) {
            debugLog(`stderr: ${result.stderr}`);
        }

        if (result.error) {
            debugLog(`Error executing command "${command}": ${result.error}`);
        }

        results.push(result);
    }

    const report = buildEnvReport({ cwd: process.cwd(), env: processEnv, results });

    out.println(SafeJSON.stringify(report, null, 2));
    await out.flush();
    log.debug({ exitCode: report.exitCode }, "doctor env done");
    process.exitCode = report.exitCode;
}
