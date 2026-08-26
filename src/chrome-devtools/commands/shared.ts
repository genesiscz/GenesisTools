/** Shared plumbing for the thin command layer: inventory scan, ambiguity refusal, guidance, recorder spawn. */
import { fileURLToPath } from "node:url";
import { suggestCommand } from "@genesiscz/utils/cli";
import { logger, out } from "@genesiscz/utils/logger";
import { inspectPidFile, writePidFile } from "@genesiscz/utils/process/pidfile";
import type { Command } from "commander";
import { attach, type Page, targets } from "../lib/cdp.ts";
import { DEFAULT_CAPTURE_CHANNELS } from "../lib/channels.ts";
import { captureDir, ensureCaptureDir, recorderPidPath } from "../lib/paths.ts";
import { artifactPath } from "../lib/platform.ts";
import { readRecorderMeta } from "../lib/recorder.ts";
import {
    browsersWithEmptyDebugFlag,
    CDP_PORTS,
    discoverListeningCdpPorts,
    type Inventory,
    isPortSpecified,
    listRunningBrowsers,
    mergeProbePorts,
    ownerOfPort,
    planAttach,
    readDevToolsActivePortsFromDisk,
    renderAttachPlan,
} from "../lib/resolve-attach.ts";

const { log } = logger.scoped("chrome-devtools:cli");

export const TOOL_CMD = "tools chrome-devtools";

export function portOf(opts: { port?: string }): number {
    const raw = opts.port ?? "9222";
    const port = Number(raw);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        out.log.error(`--port must be a TCP port number (1-65535), got '${raw}'.`);
        out.log.info(`  see live ports: ${suggest(["attach"])}`);
        process.exit(1);
    }

    return port;
}

/** Parse a numeric CLI value that must be a finite positive number; exits with guidance otherwise. */
export function positiveNumber(raw: string | number | undefined, fallback: number, flag: string): number {
    if (raw === undefined || raw === "") {
        return fallback;
    }

    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        out.log.error(`${flag} must be a positive number, got '${raw}'.`);
        process.exit(1);
    }

    return n;
}

export function withPort(cmd: Command): Command {
    return cmd.option("--port <n>", "CDP port (attach lists what exists when you are unsure)", "9222");
}

export function withPage(cmd: Command): Command {
    return withPort(cmd).option(
        "--match <substr>",
        "pick the tab whose URL contains this substring, or /regex/ (errors when nothing matches — never grabs a random tab)"
    );
}

export function suggest(command: string[]): string {
    // replaceCommand, not add: `add` appends to the CURRENT argv, which doubles
    // the verb when the suggestion names a different one (attach attach --port …).
    return suggestCommand(TOOL_CMD, { replaceCommand: command });
}

export { ignoreSigpipe } from "../lib/platform.ts";

export async function probe(
    port: number
): Promise<{ port: number; browser: string; pages: { title?: string; url: string }[] } | null> {
    try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1200) });
        const v = (await r.json()) as { Browser?: string };
        // The list fetch needs its own timeout: /json/version answering while
        // /json/list stalls would otherwise hang every inventory-based command.
        const list = (await targets(port, { signal: AbortSignal.timeout(1200) })).filter((t) => t.type === "page");

        return { port, browser: v.Browser ?? "unknown", pages: list };
    } catch {
        return null;
    }
}

export async function scanInventory(): Promise<Inventory> {
    const running = listRunningBrowsers();
    const ports = mergeProbePorts(CDP_PORTS, discoverListeningCdpPorts(), readDevToolsActivePortsFromDisk());
    const found = (await Promise.all(ports.map(probe))).filter((x): x is NonNullable<typeof x> => x != null);

    return {
        running,
        emptyDebugFlag: browsersWithEmptyDebugFlag(),
        endpoints: found.map((f) => ({
            port: f.port,
            browser: f.browser,
            owner: ownerOfPort(f.port),
            pages: f.pages.map((p) => ({ title: p.title ?? "", url: p.url })),
        })),
    };
}

/** Refuse to guess between two open Chromium browsers unless --port picks one. */
export async function refuseIfAmbiguous(): Promise<void> {
    if (isPortSpecified()) {
        return;
    }

    const plan = planAttach(await scanInventory());
    if (plan.status !== "ambiguous") {
        return;
    }

    const { text } = renderAttachPlan(plan, { cmd: TOOL_CMD, suggestCommand: suggest });
    out.log.error(text);
    process.exit(1);
}

/** attach() with the no-random-tab contract; exits with guidance when the match misses. */
export async function attachTab(opts: { port?: string; match?: string }): Promise<Page> {
    await refuseIfAmbiguous();
    try {
        return await attach({ port: portOf(opts), url: opts.match });
    } catch (err) {
        out.log.error(err instanceof Error ? err.message : String(err));
        out.log.info(`See open tabs first: ${suggest(["targets", "--port", String(portOf(opts))])}`);
        process.exit(1);
    }
}

/**
 * The unconditional attach guidance block — what is running, how to record,
 * follow, dump, and inspect. Printed on EVERY attach, per Martin's contract.
 */
export function guidanceBlock(port: number, recording: boolean): string {
    const lines: string[] = [];

    if (recording) {
        // The REAL channel list from the recorder's meta, not the default —
        // and an explicit bodies-off warning: a field session burned an hour
        // fingerprinting OAuth grants by Content-Length because nothing said
        // the retroactive HARs would have no request bodies.
        const channels = readRecorderMeta(port)?.channels ?? [...DEFAULT_CAPTURE_CHANNELS];
        lines.push(`  recording: all http(s) tabs on ${port} -> ${captureDir(port)} (channels ${channels.join(",")})`);

        if (!channels.includes("body")) {
            lines.push(
                `    NOTE: bodies are OFF — retroactive 'har' dumps carry headers but no request/response bodies.`
            );
            lines.push(
                `    bodies on:   ${suggest(["record", "--port", String(port), "--stop"])} && ${suggest(["record", "--port", String(port), "--all-tabs", "--channels", "+body"])}`
            );
        }

        lines.push(`    stop:        ${suggest(["record", "--port", String(port), "--stop"])}`);
        lines.push(
            `    scope down:  ${suggest(["record", "--port", String(port), "--match", "<url-substr>"])}   # stop first`
        );
    } else {
        lines.push(`  NOT recording on ${port}. Start one (retroactive 'har' only works while a recorder runs):`);
        lines.push(`    one site:    ${suggest(["record", "--port", String(port), "--match", "<url-substr>"])}`);
        lines.push(`    everything:  ${suggest(["record", "--port", String(port), "--all-tabs"])}`);
    }

    lines.push(`  live view:     ${suggest(["follow", "--port", String(port), "--channels", "nav,redirect,error"])}`);
    lines.push(
        `  HAR (buffer):  ${suggest(["har", "--port", String(port), "-o", artifactPath(`cdp-${port}.har`), "--last", "30m"])}`
    );
    lines.push(
        `  HAR (live):    ${suggest(["har", "--port", String(port), "--now", "--reload", "-o", artifactPath(`cdp-${port}.har`)])}`
    );
    lines.push(`  cookies:       ${suggest(["cookies", "--port", String(port), "--domain", "<substr>"])}`);
    lines.push(`  console:       ${suggest(["console", "--port", String(port), "--match", "<substr>", "--reload"])}`);
    lines.push(`  health:        ${suggest(["status"])}`);

    return lines.join("\n");
}

/**
 * Start the background recorder for a port: spawn, then claim via pidfile.
 * Claim-races resolve by killing the child that lost (the child ALSO
 * self-checks at boot — see runRecorder — so a raced duplicate exits either way).
 */
export function startRecorderBackground(port: number): { started: boolean; pid: number } {
    ensureCaptureDir(port);
    const pidPath = recorderPidPath(port);
    const state = inspectPidFile(pidPath);

    if (state.status === "live") {
        out.log.info(`recorder already up on ${port} (pid ${state.pid}) -> ${captureDir(port)}`);

        return { started: false, pid: state.pid };
    }

    const script = fileURLToPath(new URL("../index.ts", import.meta.url));
    const child = Bun.spawn(
        [
            "bun",
            script,
            "record",
            "--port",
            String(port),
            "--all-tabs",
            "--seconds",
            "0",
            "--channels",
            DEFAULT_CAPTURE_CHANNELS.join(","),
        ],
        { stdin: "ignore", stdout: "ignore", stderr: "ignore" }
    );

    const after = inspectPidFile(pidPath);
    if (after.status === "live" && after.pid !== child.pid) {
        child.kill();
        out.log.info(`recorder already up on ${port} (pid ${after.pid}); killed the raced duplicate`);

        return { started: false, pid: after.pid };
    }

    writePidFile(pidPath, { pid: child.pid });
    child.unref();
    log.debug({ port, pid: child.pid }, "recorder spawned");

    return { started: true, pid: child.pid };
}
