/**
 * The registry of every ps / lsof / pgrep call site outside `src/utils/process/` (the lint rule
 * `no-process-tool-spawn` finds them; `scripts/ci/process-tool-spawn-baseline.ts` counts them). Each entry runs
 * the site through the function that reaches it, with read-only arguments, so the benchmark
 * (`call-sites-bench.ts`) and the test (`call-sites.test.ts`) exercise the real call path before and after the
 * migration to `@genesiscz/utils/process`.
 *
 * A site whose reachable function has side effects (it kills, stops a server, or prompts) runs a `standIn`
 * instead: the bare spawn as the site issues it. The migration extracts a read-only reader from such a site and
 * points the entry's `run` at it in the same commit.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

export type CallSiteFrequency = "per-tool-call" | "per-poll" | "per-command" | "one-off";

export interface CallSite {
    /** Stable kebab id; also the metric prefix in the baseline. */
    id: string;
    /** The file that spawns, as the lint rule names it. */
    file: string;
    /** The spawn as the site issues it today, for the report. */
    spawn: string;
    frequency: CallSiteFrequency;
    /** The platforms the site can run on; the benchmark and the test skip it elsewhere. Default: every platform. */
    platforms?: NodeJS.Platform[];
    /** Reaches the site with read-only arguments. The result feeds `checkValue`, so return what the caller uses. */
    run: () => unknown;
    /** Set when `run` is the bare spawn (the site's own function is not safe to call); names the reason. */
    standIn?: string;
    /** How many of the lint rule's findings in `file` this entry covers (one function can spawn more than once). */
    findings?: number;
    /**
     * ps, lsof or pgrep spawns the site may still make once migrated, and only from inside `src/utils/process/`: on
     * macOS the setuid `ps` is the only reader of another user's memory, CPU time and command line. Default 0.
     */
    budget?: { spawns: number; reason: string };
}

/** The prefix of the one JSON line a benchmark child prints, so a site that writes to stdout cannot break it. */
export const SAMPLE_MARKER = "@@sample ";

const PROCESS_TOOLS = new Set(["ps", "lsof", "pgrep"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);

/** True for a spawn of ps, lsof or pgrep: directly, behind `env VAR=value`, or as the first word of `sh -c`. */
export function isProcessToolSpawn(cmd: string[]): boolean {
    let index = 0;

    if (basename(cmd[0] ?? "") === "env") {
        index = 1;

        while (cmd[index]?.includes("=")) {
            index++;
        }
    }

    const program = basename(cmd[index] ?? "");

    if (SHELLS.has(program) && cmd[index + 1] === "-c") {
        return PROCESS_TOOLS.has(basename((cmd[index + 2] ?? "").trim().split(/\s+/)[0] ?? ""));
    }

    return PROCESS_TOOLS.has(program);
}

export function runsHere(site: CallSite): boolean {
    return site.platforms === undefined || site.platforms.includes(process.platform);
}

/** A number that should agree before and after the migration: rows found, a map's size, 1 for one value, 0 for none. */
export function checkValue(result: unknown): number {
    if (result === null || result === undefined || result === false) {
        return 0;
    }

    if (typeof result === "number") {
        return Number.isFinite(result) ? 1 : 0;
    }

    if (Array.isArray(result)) {
        return result.length;
    }

    if (result instanceof Map || result instanceof Set) {
        return result.size;
    }

    if (typeof result === "string") {
        return result.length > 0 ? 1 : 0;
    }

    return 1;
}

/** A bare spawn, for a stand-in. The benchmark folder is exempt from `no-process-tool-spawn`. */
function bare(argv: string[]): string {
    return Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" }).stdout.toString();
}

/** Runs `fn` while this process listens on a loopback TCP port, so a port reader has an owner to find. */
async function withListener<T>(fn: (port: number) => T | Promise<T>): Promise<T> {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });

    try {
        return await fn(server.port as number);
    } finally {
        server.stop(true);
    }
}

/** `pid` and up to `depth` ancestors, one `ps` per step, as the account hooks walk them today. */
function walkAncestorsWithPs(columns: string[], depth = 8): string[] {
    const lines: string[] = [];
    let pid = process.pid;

    for (let step = 0; step < depth && pid > 1; step++) {
        const line = bare(["ps", "-o", "ppid=,command=", "-p", String(pid)]).trim();
        lines.push(...columns.map((column) => bare(["ps", column, String(pid)]).trim()));
        lines.push(line);
        pid = Number(line.split(/\s+/)[0]);
    }

    return lines;
}

const AGENT_SCAN = { alias: "claude" as const, classify: (args: string) => (args.includes("claude") ? "tui" : null) };

/*
 * Each entry imports its module when it runs (`await import(…)`), never at the top of this file. A benchmark sample is
 * a fresh process that runs ONE site. A static import loads all 24 site modules in every sample: measured 2026-10-14,
 * 45 ms of CPU against 25 ms for one module, so about 3 s over a 50-site, 3-run benchmark, plus every module's
 * load-time side effects. The lazy import also keeps the site's own module load inside its cold run, as a CLI call
 * pays it.
 */
export const CALL_SITES: CallSite[] = [
    // Plugin hooks expose their read-only probes without running their entry points on import.
    {
        id: "hook-cmux-agent-tty",
        file: "plugins/genesis-tools/hooks/record-session-cmux.ts",
        spawn: "ps -o tty= -p <agent pid>",
        frequency: "per-tool-call",
        run: async () =>
            (await import("../../../plugins/genesis-tools/hooks/record-session-cmux")).agentHasTty(
                String(process.ppid)
            ),
    },
    {
        id: "hook-inbox-hint-command",
        file: "plugins/genesis-tools/hooks/native-inbox-hint.ts",
        spawn: "ps -p <pid> -o command=",
        frequency: "per-command",
        run: async () =>
            (await import("../../../plugins/genesis-tools/hooks/native-inbox-hint")).commandOf(process.ppid),
    },
    {
        id: "hook-account-ancestors",
        file: "plugins/genesis-tools/hooks/record-session-account.ts",
        spawn: "ps -o ppid=,command= -p <pid>, once per ancestor",
        frequency: "per-command",
        run: async () =>
            (await import("../../../plugins/genesis-tools/hooks/record-session-account")).ancestorCommands(),
    },
    {
        id: "widget-drive-pid",
        file: "scripts/native/widget-drive.ts",
        spawn: "pgrep -f <widget face>",
        frequency: "one-off",
        standIn: "a script that drives the live widget",
        run: () => bare(["pgrep", "-f", "MacOS/GenesisTools --widget"]),
    },
    {
        id: "benchmark-sample-process",
        file: "src/benchmark/lib/process-sample.ts",
        spawn: "ps -o cputime=,rss= -p <pid> (twice per window)",
        frequency: "one-off",
        run: async () =>
            (await import("@app/benchmark/lib/process-sample")).sampleProcess(process.pid, { windowMs: 1 }),
    },
    {
        id: "chrome-list-processes",
        file: "src/chrome-devtools/lib/platform.ts",
        spawn: "ps -axo pid=,ppid=,command=",
        frequency: "per-command",
        run: async () => (await import("@app/chrome-devtools/lib/platform")).listProcesses(),
    },
    {
        id: "chrome-process-executable",
        file: "src/chrome-devtools/lib/platform.ts",
        spawn: "ps -o comm= -p <pid> (Linux)",
        frequency: "per-command",
        run: async () => (await import("@app/chrome-devtools/lib/platform")).processExecutable(process.pid),
    },
    {
        id: "chrome-listening-ports",
        file: "src/chrome-devtools/lib/platform.ts",
        spawn: "lsof -nP -iTCP -sTCP:LISTEN",
        frequency: "per-command",
        run: async () => (await import("@app/chrome-devtools/lib/platform")).listListeningTcpPorts(),
    },
    {
        id: "chrome-sample-process",
        file: "src/chrome-devtools/lib/platform.ts",
        spawn: "ps -p <pid> -o pcpu=,rss=,time=,etime=,stat=,command=",
        frequency: "per-command",
        run: async () => (await import("@app/chrome-devtools/lib/platform")).sampleProcess(process.pid),
    },
    {
        id: "test-reap-started-at",
        file: "scripts/test-reap.ts",
        spawn: "ps -p <pid> -o lstart=",
        frequency: "per-command",
        run: async () => (await import("../../test-reap")).startedAt(process.pid),
    },
    {
        id: "test-reap-descendants",
        file: "scripts/test-reap.ts",
        spawn: "ps -Ao pid=,ppid=,lstart=",
        frequency: "per-command",
        run: async () => (await import("../../test-reap")).descendantsOf(process.pid),
    },
    {
        id: "claude-doctor-pinned",
        file: "src/claude/commands/doctor-impl.ts",
        findings: 2,
        spawn: "pgrep -f claude, then ps eww -o pid=,tty=,command= -p <pids>",
        frequency: "one-off",
        standIn: "a private helper of the doctor command, which prints a full report",
        run: () => {
            const pids = bare(["pgrep", "-f", "claude"]).trim().split("\n").filter(Boolean);
            return pids.length > 0 ? bare(["ps", "eww", "-o", "pid=,tty=,command=", "-p", pids.join(",")]) : "";
        },
    },
    {
        id: "teams-live-processes",
        file: "src/claude/lib/teams/status.ts",
        spawn: "ps -ax -o pid=,ppid=,command=",
        frequency: "per-command",
        run: async () => (await import("@app/claude/lib/teams/status")).listLiveTeammateProcesses(),
    },
    {
        id: "teams-env-keys",
        file: "src/claude/lib/teams/status.ts",
        spawn: "ps eww -p <pid>",
        frequency: "per-command",
        run: async () => (await import("@app/claude/lib/teams/status")).readProcessEnvKeys(process.pid, ["HOME"]),
    },
    {
        id: "cmux-close-tty-agent",
        file: "src/cmux/lib/session-close-live.ts",
        spawn: "ps -t <tty> -o args=",
        frequency: "per-poll",
        platforms: ["darwin"],
        standIn: "a private check inside the close loop; it needs a live adopted surface",
        run: () => bare(["ps", "-t", "console", "-o", "args="]),
    },
    {
        id: "cmux-close-shell-children",
        file: "src/cmux/lib/session-close-live.ts",
        spawn: "pgrep -P <shell pid>",
        frequency: "per-poll",
        platforms: ["darwin"],
        standIn: "a method of the close IO, which needs a session store",
        run: () => bare(["pgrep", "-P", String(process.ppid)]),
    },
    {
        id: "peekaboo-kill-tree",
        file: "src/control/lib/peekaboo.ts",
        spawn: "pgrep -P <pid>, once per level",
        frequency: "one-off",
        platforms: ["darwin"],
        standIn: "killTree sends SIGTERM",
        run: () => bare(["pgrep", "-P", String(process.pid)]),
    },
    {
        id: "chrome-running-browsers",
        file: "src/chrome-devtools/lib/resolve-attach.ts",
        findings: 2,
        spawn: "pgrep -x <binary>, once per known browser",
        frequency: "per-command",
        run: async () => (await import("@app/chrome-devtools/lib/resolve-attach")).listRunningBrowsers(),
    },
    {
        id: "chrome-quit-browser",
        file: "src/chrome-devtools/lib/resolve-attach.ts",
        findings: 3,
        spawn: "pgrep -x <app>, polled until the browser exits",
        frequency: "one-off",
        standIn: "quitBrowser quits a running browser",
        run: () => bare(["pgrep", "-x", "Google Chrome"]),
    },
    {
        id: "cmux-tty-capture",
        file: "src/cmux/lib/command-capture.ts",
        spawn: "ps -axo tty=,etime=,command=",
        frequency: "per-poll",
        run: async () => (await import("@app/cmux/lib/command-capture")).collectTtyCapture(),
    },
    {
        id: "codex-writer-started",
        file: "src/codex/lib/active-writer.ts",
        spawn: "ps -o lstart= -p <pid>",
        frequency: "per-command",
        standIn: "a private helper; its caller needs a Codex thread lock",
        run: () => bare(["ps", "-o", "lstart=", "-p", String(process.pid)]),
    },
    {
        id: "codex-desktop-running",
        file: "src/codex/lib/desktop/app-bundle.ts",
        spawn: "ps -axww -o command=",
        frequency: "per-command",
        platforms: ["darwin"],
        run: async () =>
            (await import("@app/codex/lib/desktop/app-bundle")).codexDesktopIsRunning("/Applications/Codex.app"),
    },
    {
        id: "control-frontmost-parents",
        file: "src/control/lib/decision/frontmost.ts",
        spawn: "ps -axo pid=,ppid=",
        frequency: "per-tool-call",
        platforms: ["darwin"],
        run: async () => (await import("@app/control/lib/decision/frontmost")).ancestorPids(),
    },
    {
        id: "dev-dashboard-port-cwds",
        file: "src/dev-dashboard/lib/ports/resolve.ts",
        spawn: "lsof -a -p <pids> -d cwd -Fn",
        frequency: "per-poll",
        run: async () => (await import("@app/dev-dashboard/lib/ports/resolve")).batchCwds([process.pid]),
    },
    {
        id: "dev-dashboard-top-processes",
        budget: {
            spawns: 1,
            reason: "the top five by memory include root daemons (mds_stores), whose memory only the setuid ps reads on macOS",
        },
        file: "src/dev-dashboard/lib/system/collector.ts",
        spawn: "ps -ax -m -o pid=,rss=,etime=,%cpu=,comm=",
        frequency: "per-poll",
        run: async () => (await import("@app/dev-dashboard/lib/system/collector")).collectTopProcesses(5),
    },
    {
        id: "macos-resources-open-files",
        file: "src/macos-resources/lib/process-data.ts",
        spawn: "lsof -w -p <pid>",
        frequency: "per-command",
        platforms: ["darwin"],
        run: async () => (await import("@app/macos-resources/lib/process-data")).listOpenFiles(process.pid),
    },
    {
        id: "dev-dashboard-listening-ports",
        file: "src/dev-dashboard/lib/ports/scanner.ts",
        spawn: "lsof -nP -iTCP -sTCP:LISTEN",
        frequency: "per-poll",
        run: async () => (await import("@app/dev-dashboard/lib/ports/scanner")).listListeningPorts(),
    },
    {
        id: "doctor-cpu-spin",
        budget: {
            spawns: 1,
            reason: "root daemons spin too, and another user's CPU time only the setuid ps reads on macOS",
        },
        file: "src/doctor/analyzers/cpu-spin.ts",
        spawn: "ps -axo pid=,cputime=,command= (twice, 1.5 s apart)",
        frequency: "one-off",
        standIn: "a private method of the analyzer, which waits a 1.5 s window",
        run: () => bare(["ps", "-axo", "pid=,cputime=,command="]),
    },
    {
        id: "dev-dashboard-processes",
        budget: {
            spawns: 1,
            reason: "the process monitor lists every process, and another user's memory and CPU only the setuid ps reads on macOS",
        },
        file: "src/dev-dashboard/lib/system/processes.ts",
        spawn: "ps -axo pid=,rss=,etime=,%cpu=,comm=",
        frequency: "per-poll",
        run: async () => (await import("@app/dev-dashboard/lib/system/processes")).collectProcesses(),
    },
    {
        id: "ms-teams-pgrep",
        file: "src/ms-teams/lib/process.ts",
        spawn: "pgrep -lf -i teams",
        frequency: "per-command",
        run: async () => (await import("@app/ms-teams/lib/process")).pgrepTeams(),
    },
    {
        id: "swap-ps-rows",
        file: "src/macos/lib/swap/scanner.ts",
        spawn: "ps -A -o pid=,rss=,etime=,comm=",
        frequency: "per-command",
        platforms: ["darwin"],
        standIn: "a private helper of the swap scan, which also runs vmmap per process",
        run: () => bare(["ps", "-A", "-o", "pid=,rss=,etime=,comm="]),
    },
    {
        id: "local-network-old-builds",
        file: "src/macos/lib/permissions/local-network.ts",
        findings: 2,
        spawn: "ps -Ao pid=,lstart=,args=, then lsof -a -d txt -Fpi -n -p <pids>",
        frequency: "per-command",
        platforms: ["darwin"],
        run: async () => {
            const { oldBuildsInUse } = await import("@app/macos/lib/permissions/local-network");
            const { genesisAppLauncherPath } = await import("@genesiscz/utils/macos/genesis-app");
            return oldBuildsInUse(genesisAppLauncherPath(), null);
        },
    },
    {
        id: "cmux-health-app",
        file: "src/utils/cmux/lib/health.ts",
        spawn: "ps -axo pid=,%cpu=,comm=",
        frequency: "per-command",
        platforms: ["darwin"],
        run: async () => (await import("@genesiscz/utils/cmux/lib/health")).probeCmuxHealth(),
    },
    {
        id: "app-prune-retired",
        file: "src/macos/lib/permissions/app.ts",
        spawn: "lsof -d txt -Fi -n",
        frequency: "per-command",
        platforms: ["darwin"],
        standIn: "pruneRetiredBundles deletes app bundles",
        run: () => bare(["lsof", "-d", "txt", "-Fi", "-n"]),
    },
    {
        id: "app-reap-stale-faces",
        file: "src/macos/lib/permissions/app.ts",
        spawn: "ps -Ao pid=,args=",
        frequency: "per-command",
        platforms: ["darwin"],
        standIn: "reapStaleAppFaces kills processes",
        run: () => bare(["ps", "-Ao", "pid=,args="]),
    },
    {
        id: "app-kill-stale-faces",
        file: "src/macos/lib/permissions/app.ts",
        spawn: "ps -Ao pid=,args=",
        frequency: "per-command",
        platforms: ["darwin"],
        standIn: "killStaleFaces kills processes",
        run: () => bare(["ps", "-Ao", "pid=,args="]),
    },
    {
        id: "statusline-account-ancestors",
        file: "src/utils/ai/providers/plugins/anthropic-sub/statusline.ts",
        findings: 2,
        spawn: "ps eww <pid> and ps -o ppid= -p <pid>, once per ancestor",
        frequency: "per-poll",
        standIn: "a private helper of the statusline feature",
        run: () => walkAncestorsWithPs(["eww"]),
    },
    {
        id: "port-details",
        file: "src/port/lib/scanner.ts",
        spawn: "lsof -i :<port> -n -P",
        frequency: "per-command",
        run: async () => {
            const { getPortDetails } = await import("@app/port/lib/scanner");
            return withListener((port) => getPortDetails(port));
        },
    },
    {
        id: "port-listening",
        file: "src/port/lib/scanner.ts",
        spawn: "lsof -iTCP -sTCP:LISTEN -P -n",
        frequency: "per-command",
        run: async () => (await import("@app/port/lib/scanner")).getListeningPorts(),
    },
    {
        id: "port-all-processes",
        budget: {
            spawns: 1,
            reason: "the table lists every process, and another user's memory, CPU and command line only the setuid ps reads on macOS",
        },
        file: "src/port/lib/scanner.ts",
        spawn: "ps -axo <columns>",
        frequency: "per-command",
        run: async () => (await import("@app/port/lib/scanner")).getAllProcesses(),
    },
    {
        id: "say-caller-ancestry",
        file: "src/say/lib/caller.ts",
        spawn: "ps -o pid=,ppid= / -o pid=,command= over the ancestry",
        frequency: "per-command",
        run: async () => (await import("@app/say/lib/caller")).captureAncestry(process.pid),
    },
    {
        id: "ai-active-agents",
        file: "src/utils/ai/active-processes.ts",
        findings: 3,
        spawn: "ps axww, ps axeww and lsof -d cwd (only where the kernel read fails)",
        frequency: "per-poll",
        run: async () => (await import("@genesiscz/utils/ai/active-processes")).listActiveAgentProcesses(AGENT_SCAN),
    },
    {
        id: "network-port-owner",
        file: "src/utils/network.ts",
        findings: 2,
        spawn: "lsof -nP -iTCP:<port> -sTCP:LISTEN -t, then ps -p <pid> -o uid=,command= (where the kernel read fails)",
        frequency: "per-command",
        run: async () => {
            const { getPortOwner } = await import("@genesiscz/utils/network");
            return withListener((port) => getPortOwner(port));
        },
    },
    {
        id: "dashboard-stop-ui-pids",
        file: "src/utils/DashboardApp/stopUiServerOnPort.ts",
        spawn: "lsof -nP -iTCP:<port> -sTCP:LISTEN -t",
        frequency: "per-command",
        standIn: "stopUiServerOnPort kills the server",
        run: () => withListener((port) => bare(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])),
    },
    {
        id: "dashboard-stop-ui-children",
        file: "src/utils/DashboardApp/stopUiServerOnPort.ts",
        spawn: "pgrep -P <pid>",
        frequency: "per-command",
        standIn: "stopUiServerOnPort kills the server",
        run: () => bare(["pgrep", "-P", String(process.pid)]),
    },
    {
        id: "tmux-snapshot",
        file: "src/utils/tmux/snapshot.ts",
        spawn: "ps -o pid=,ppid=,args= -ax",
        frequency: "per-poll",
        run: async () => (await import("@genesiscz/utils/tmux/snapshot")).captureTmuxSnapshot(),
    },
    {
        id: "orphan-guard-started",
        file: "src/utils/bun/orphan-worker-guard.ts",
        spawn: "ps -p <pid> -o lstart= (twice)",
        frequency: "per-command",
        run: async () => {
            const { startedAt } = await import("@genesiscz/utils/bun/orphan-worker-guard");
            return [startedAt(process.pid), startedAt(process.ppid)];
        },
    },
    {
        id: "services-idle-clients",
        file: "src/utils/services/idle.ts",
        spawn: "lsof -nP -iTCP -sTCP:ESTABLISHED -Fn",
        frequency: "per-poll",
        run: async () => (await import("@genesiscz/utils/services/idle")).readClientPorts(),
    },
    {
        id: "identity-command",
        file: "src/utils/process-identity.ts",
        spawn: "ps -p <pid> -o command=",
        frequency: "per-command",
        run: async () => (await import("@genesiscz/utils/process-identity")).readProcessCommand(process.pid),
    },
    {
        id: "identity-start",
        file: "src/utils/process-identity.ts",
        spawn: "ps -p <pid> -o etime=",
        frequency: "per-command",
        run: async () => (await import("@genesiscz/utils/process-identity")).processStartMs(process.pid),
    },
    // Found once the rule also read absolute paths, the `{ cmd }` form, `env` and `Bun.which` (2026-10-14 02:20).
    {
        id: "retire-cache-open-files",
        budget: {
            spawns: 1,
            reason: "which processes hold a path open is the layer's open-files.ts, through lsof, for a one-off script",
        },
        file: "scripts/history/retire-native-cache.ts",
        spawn: "lsof -Fpc -- <paths>",
        frequency: "one-off",
        standIn: "a private helper of a one-off migration script",
        run: () => bare(["lsof", "-Fpc", "--", process.execPath]),
    },
    {
        id: "cmux-screen-collector-status",
        file: "src/cmux/lib/capture-collector-lifecycle.ts",
        spawn: "/bin/ps -p <pid> -o command=",
        frequency: "per-command",
        run: async () => {
            const { screenCollectorStatus } = await import("@app/cmux/lib/capture-collector-lifecycle");
            const root = mkdtempSync(join(tmpdir(), "collector-"));
            const owner = { pid: process.pid, ownerToken: "00000000-0000-4000-8000-000000000000" };
            writeFileSync(join(root, "screens.pid.json"), SafeJSON.stringify(owner, { strict: true }));
            return screenCollectorStatus(root);
        },
    },
    {
        id: "ai-proxy-tunnel-running",
        file: "src/ai-proxy/lib/tunnel/cloudflared.ts",
        spawn: "pgrep -fl cloudflared",
        frequency: "per-command",
        run: async () => (await import("@app/ai-proxy/lib/tunnel/cloudflared")).isTunnelProcessRunning(),
    },
    {
        id: "doctor-processes-analyzer",
        budget: {
            spawns: 1,
            reason: "the analyzer reports every process, and another user's memory and CPU only the setuid ps reads on macOS",
        },
        file: "src/doctor/analyzers/processes.ts",
        spawn: "ps -axo pid,ppid,pcpu,rss,stat,comm,command",
        frequency: "one-off",
        standIn: "a method of the analyzer, which needs a doctor context",
        run: () => bare(["ps", "-axo", "pid,ppid,pcpu,rss,stat,comm,command"]),
    },
    {
        id: "dev-dashboard-port-meta",
        file: "src/dev-dashboard/lib/ports/resolve.ts",
        spawn: "/bin/ps -p <pids> -o pid=,lstart=,command=",
        frequency: "per-poll",
        run: async () => (await import("@app/dev-dashboard/lib/ports/resolve")).batchProcessMeta([process.pid]),
    },
    {
        id: "ttyd-session-command",
        file: "src/dev-dashboard/lib/ttyd/manager.ts",
        findings: 2,
        spawn: "/bin/ps -p <pid> -o command=",
        frequency: "per-poll",
        standIn: "two private checks of a ttyd session record",
        run: () => bare(["/bin/ps", "-p", String(process.pid), "-o", "command="]),
    },
    {
        id: "dev-dashboard-port-kill-command",
        file: "src/dev-dashboard/lib/ports/scanner.ts",
        spawn: "/bin/ps -p <pid> -o command=",
        frequency: "one-off",
        standIn: "a private identity check before a port's owner is killed",
        run: () => bare(["/bin/ps", "-p", String(process.pid), "-o", "command="]),
    },
    {
        id: "dev-dashboard-restart-snapshot",
        file: "src/dev-dashboard/lib/restart-diag.ts",
        spawn: "/bin/ps -axo pid,ppid,pgid,command",
        frequency: "one-off",
        standIn: "logTtydTmuxSnapshot writes a diagnostic log",
        run: () => bare(["/bin/ps", "-axo", "pid,ppid,pgid,command"]),
    },
    {
        id: "git-fsmonitor-daemons",
        file: "src/git/lib/fsmonitor.ts",
        findings: 2,
        spawn: "ps -Ao pid=,rss=,time=,command=, then lsof per daemon",
        frequency: "per-command",
        run: async () => {
            const { defaultFsmonitorDeps, listMonitorDaemons } = await import("@app/git/lib/fsmonitor");
            return listMonitorDaemons(defaultFsmonitorDeps());
        },
    },
    {
        id: "doctor-memory-top",
        budget: {
            spawns: 1,
            reason: "the top processes by memory include root daemons, whose memory only the setuid ps reads on macOS",
        },
        file: "src/doctor/analyzers/memory.ts",
        spawn: "ps -axo pid=,rss=,comm=,command=",
        frequency: "one-off",
        standIn: "a private helper of the memory analyzer",
        run: () => bare(["ps", "-axo", "pid=,rss=,comm=,command="]),
    },
    {
        id: "services-inventory-probe",
        file: "src/utils/services/inventory.ts",
        findings: 2,
        spawn: "env LC_ALL=C ps -axo <columns>, and lsof -iTCP -sTCP:LISTEN where netstat fails",
        frequency: "per-poll",
        run: async () => {
            const probe = (await import("@genesiscz/utils/services/inventory")).liveProbe();
            return [...probe.processes(), ...probe.listeners().keys()];
        },
    },
    {
        id: "worker-running-turns",
        file: "src/utils/worker/ps.ts",
        spawn: "ps -axo pid=,command=",
        frequency: "per-command",
        run: async () =>
            (await import("@genesiscz/utils/worker/ps")).runningTurnPids("no-such-session-marker", /claude/),
    },
];
