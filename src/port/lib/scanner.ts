import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { startWakefulInterval, type WakefulInterval } from "@genesiscz/utils/async";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { listOpenFiles, type NetworkSnapshot, readNetworkSnapshot } from "@genesiscz/utils/process/process-files";
import {
    listProcessesWithUsage,
    type ProcessWithUsage,
    readProcessesWithUsage,
    userName,
} from "@genesiscz/utils/process/processes";
import { batchCwd, captureSync, type PsRow } from "@genesiscz/utils/process/ps";
import { listSockets, type SocketEntry } from "@genesiscz/utils/process/sockets";
import { isProcessAlive } from "@genesiscz/utils/process-alive";
import { readProcessCommand } from "@genesiscz/utils/process-identity";
import type { KillResult, PortProcess, PortSnapshot, ProcessSnapshot, ProcessStatus } from "./types";

const IS_WINDOWS = process.platform === "win32";

export const STATE_PRIORITY: Record<string, number> = {
    LISTEN: 1,
    ESTABLISHED: 2,
    CLOSE_WAIT: 3,
    TIME_WAIT: 4,
    FIN_WAIT_1: 5,
    FIN_WAIT_2: 6,
    SYN_SENT: 7,
    SYN_RECEIVED: 8,
};

const FRAMEWORK_PACKAGE_MAP: Array<[string, string]> = [
    ["next", "Next.js"],
    ["nuxt", "Nuxt"],
    ["nuxt3", "Nuxt"],
    ["@sveltejs/kit", "SvelteKit"],
    ["svelte", "Svelte"],
    ["@remix-run/react", "Remix"],
    ["remix", "Remix"],
    ["astro", "Astro"],
    ["vite", "Vite"],
    ["@angular/core", "Angular"],
    ["vue", "Vue"],
    ["react", "React"],
    ["express", "Express"],
    ["fastify", "Fastify"],
    ["@nestjs/core", "NestJS"],
    ["nestjs", "NestJS"],
    ["hono", "Hono"],
    ["koa", "Koa"],
    ["gatsby", "Gatsby"],
    ["webpack-dev-server", "Webpack"],
    ["esbuild", "esbuild"],
    ["parcel", "Parcel"],
];

const SYSTEM_PROCESS_PREFIXES = [
    "spotify",
    "raycast",
    "tableplus",
    "postman",
    "linear",
    "cursor",
    "slack",
    "discord",
    "firefox",
    "chrome",
    "google",
    "safari",
    "figma",
    "notion",
    "zoom",
    "teams",
    "loginwindow",
    "windowserver",
    "kernel_task",
    "launchd",
    "mdworker",
    "cfprefsd",
    "rapportd",
    "systemuiserver",
];

const DEV_PROCESS_NAMES = new Set([
    "node",
    "bun",
    "npm",
    "npx",
    "pnpm",
    "yarn",
    "python",
    "python3",
    "ruby",
    "java",
    "go",
    "deno",
    "php",
    "uvicorn",
    "gunicorn",
    "flask",
    "rails",
    "tsc",
    "tsx",
    "vite",
    "webpack",
    "cargo",
    "rustc",
    "docker",
    "docker-proxy",
    "com.docker.backend",
]);

const MAX_PROJECT_ROOT_DEPTH = 12;
const KB_PER_MB = 1024;
const KB_PER_GB = 1024 * 1024;
const GRACEFUL_SHUTDOWN_WAIT_MS = 1000;
const DEFAULT_WATCH_INTERVAL_MS = 2000;
function formatUptime(startTime: Date | null): string | null {
    if (!startTime) {
        return null;
    }

    const diffMs = Date.now() - startTime.getTime();
    const seconds = Math.max(0, Math.floor(diffMs / 1000));
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) {
        return `${days}d ${hours % 24}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes % 60}m`;
    }

    if (minutes > 0) {
        return `${minutes}m ${seconds % 60}s`;
    }

    return `${seconds}s`;
}

function formatMemory(rssKb: number): string | null {
    if (!Number.isFinite(rssKb) || rssKb <= 0) {
        return null;
    }

    if (rssKb >= KB_PER_GB) {
        return `${(rssKb / KB_PER_GB).toFixed(1)} GB`;
    }

    if (rssKb >= KB_PER_MB) {
        return `${(rssKb / KB_PER_MB).toFixed(1)} MB`;
    }

    return `${rssKb} KB`;
}

function findProjectRoot(cwd: string): string {
    const markers = ["package.json", "Cargo.toml", "go.mod", "pyproject.toml", "Gemfile", "pom.xml", "build.gradle"];
    let current = cwd;
    let depth = 0;

    while (dirname(current) !== current && depth < MAX_PROJECT_ROOT_DEPTH) {
        for (const marker of markers) {
            if (existsSync(join(current, marker))) {
                return current;
            }
        }

        current = dirname(current);
        depth += 1;
    }

    return cwd;
}

function detectFrameworkFromCommand(command: string, processName: string): string | null {
    const value = command.toLowerCase();
    const name = processName.toLowerCase();

    if (value.includes("next")) {
        return "Next.js";
    }

    if (value.includes("vite")) {
        return "Vite";
    }

    if (value.includes("nuxt")) {
        return "Nuxt";
    }

    if (value.includes("angular") || value.includes("ng serve")) {
        return "Angular";
    }

    if (value.includes("webpack")) {
        return "Webpack";
    }

    if (value.includes("remix")) {
        return "Remix";
    }

    if (value.includes("astro")) {
        return "Astro";
    }

    if (value.includes("gatsby")) {
        return "Gatsby";
    }

    if (value.includes("flask")) {
        return "Flask";
    }

    if (value.includes("django") || value.includes("manage.py")) {
        return "Django";
    }

    if (value.includes("uvicorn") || value.includes("fastapi")) {
        return "FastAPI";
    }

    if (value.includes("rails")) {
        return "Rails";
    }

    if (value.includes("cargo") || value.includes("rustc")) {
        return "Rust";
    }

    if (value.includes("docker")) {
        return "Docker";
    }

    if (name === "node") {
        return "Node.js";
    }

    if (name === "bun") {
        return "Bun";
    }

    if (name === "python" || name === "python3") {
        return "Python";
    }

    if (name === "ruby") {
        return "Ruby";
    }

    if (name === "java") {
        return "Java";
    }

    if (name === "go") {
        return "Go";
    }

    return null;
}

function detectFrameworkFromProject(projectRoot: string): string | null {
    const packageJsonPath = join(projectRoot, "package.json");

    if (existsSync(packageJsonPath)) {
        try {
            const pkg = SafeJSON.parse(readFileSync(packageJsonPath, "utf8")) as {
                dependencies?: Record<string, string>;
                devDependencies?: Record<string, string>;
            };
            const deps = { ...pkg.dependencies, ...pkg.devDependencies };

            for (const [dependency, framework] of FRAMEWORK_PACKAGE_MAP) {
                if (dependency in deps) {
                    return framework;
                }
            }
        } catch {
            return null;
        }
    }

    if (existsSync(join(projectRoot, "vite.config.ts")) || existsSync(join(projectRoot, "vite.config.js"))) {
        return "Vite";
    }

    if (existsSync(join(projectRoot, "next.config.js")) || existsSync(join(projectRoot, "next.config.mjs"))) {
        return "Next.js";
    }

    if (existsSync(join(projectRoot, "angular.json"))) {
        return "Angular";
    }

    if (existsSync(join(projectRoot, "Cargo.toml"))) {
        return "Rust";
    }

    if (existsSync(join(projectRoot, "go.mod"))) {
        return "Go";
    }

    if (existsSync(join(projectRoot, "manage.py"))) {
        return "Django";
    }

    if (existsSync(join(projectRoot, "Gemfile"))) {
        return "Ruby";
    }

    return null;
}

function deriveStatus(psRow: PsRow | undefined, processName: string, command: string): ProcessStatus {
    if (!psRow) {
        return "unknown";
    }

    if (psRow.stat.includes("Z")) {
        return "zombie";
    }

    if (psRow.ppid === 1 && isLikelyDevProcess(processName, command)) {
        return "orphaned";
    }

    return "healthy";
}

function extractPort(name: string): number | null {
    const match = name.match(/:(\d+)(?:\s|$|->)/);

    if (!match) {
        return null;
    }

    return Number.parseInt(match[1], 10);
}

function enrichPortProcesses(processes: PortProcess[], table: Map<number, ProcessWithUsage>): PortSnapshot[] {
    if (processes.length === 0) {
        return [];
    }

    const pids = [...new Set(processes.map((processInfo) => processInfo.pid))];
    const psMap = new Map(
        pids.flatMap((pid) => {
            const entry = table.get(pid);
            return entry ? [[pid, processRow(entry)] as const] : [];
        })
    );
    const cwdMap = batchCwd(pids);

    return processes
        .map((processInfo) => {
            const psRow = psMap.get(processInfo.pid);
            const cwd = cwdMap.get(processInfo.pid);
            const projectRoot = cwd ? findProjectRoot(cwd) : null;
            const processName = basename(psRow?.command.split(/\s+/)[0] ?? processInfo.command);
            const port = extractPort(processInfo.name);

            if (!port) {
                return null;
            }

            return {
                port,
                pid: processInfo.pid,
                processName,
                command: psRow?.command ?? processInfo.command,
                user: psRow?.user ?? processInfo.user,
                state: processInfo.state,
                name: processInfo.name,
                fd: processInfo.fd,
                cwd: projectRoot,
                projectName: projectRoot ? basename(projectRoot) : null,
                framework:
                    detectFrameworkFromCommand(psRow?.command ?? processInfo.command, processName) ??
                    (projectRoot ? detectFrameworkFromProject(projectRoot) : null),
                uptime: formatUptime(psRow?.startTime ?? null),
                startTime: psRow?.startTime ?? null,
                memory: formatMemory(psRow?.rss ?? 0),
                status: deriveStatus(psRow, processName, psRow?.command ?? processInfo.command),
            } satisfies PortSnapshot;
        })
        .filter((entry): entry is PortSnapshot => entry !== null)
        .sort((left, right) => left.port - right.port || left.pid - right.pid);
}

function processRow(entry: ProcessWithUsage): PsRow {
    const elapsedMs = entry.startMs === null ? 0 : Date.now() - entry.startMs;
    return {
        pid: entry.pid,
        ppid: entry.ppid,
        user: entry.uid === null ? "" : (userName(entry.uid) ?? String(entry.uid)),
        stat: entry.usage?.running ? "R" : entry.state,
        // `ps`'s %cpu (recent usage on macOS); the average since the start only where nothing measured it.
        cpu: entry.cpuPercent ?? (elapsedMs > 0 ? (100 * (entry.usage?.cpuTimeMs ?? 0)) / elapsedMs : 0),
        rss: (entry.usage?.rssBytes ?? 0) / 1024,
        startTime: entry.startMs === null ? null : new Date(entry.startMs),
        command: entry.command ?? entry.name,
    };
}

/** One row per owner, or with `perPort` one row per owner and port, so a process that listens twice shows both. */
function socketProcesses(
    sockets: SocketEntry[],
    options: { ownPid: number; table: Map<number, ProcessWithUsage>; perPort?: boolean }
): PortProcess[] {
    const rows = new Map<string, PortProcess>();
    const files = new Map<number, ReturnType<typeof listOpenFiles>>();
    // The descriptors of every owner are named from the same network tables, read once for the scan.
    let network: NetworkSnapshot | null | undefined;
    for (const socket of sockets) {
        if (socket.pid === options.ownPid) {
            continue;
        }
        const entry = options.table.get(socket.pid);
        const local = `${socket.address}:${socket.port}`;
        const remote = socket.remotePort ? `->${socket.remoteAddress}:${socket.remotePort}` : "";
        const name = local + remote + (socket.state ? ` (${socket.state})` : "");
        if (!files.has(socket.pid)) {
            network = network === undefined ? readNetworkSnapshot() : network;
            files.set(socket.pid, listOpenFiles(socket.pid, { network }));
        }
        const fd =
            files
                .get(socket.pid)
                ?.find(
                    (file) =>
                        file.type === socket.family &&
                        (file.name === name || file.name === `${socket.protocol} ${name}`)
                )?.fd ?? "";
        const item: PortProcess = {
            pid: socket.pid,
            command: entry?.name ?? "",
            user: entry?.uid == null ? "" : (userName(entry.uid) ?? String(entry.uid)),
            state: socket.state ?? "UNKNOWN",
            name,
            fd,
        };
        const key = options.perPort ? `${socket.pid}:${socket.port}` : String(socket.pid);
        const previous = rows.get(key);
        if (!previous || (STATE_PRIORITY[item.state] ?? 99) < (STATE_PRIORITY[previous.state] ?? 99)) {
            rows.set(key, item);
        }
    }
    return [...rows.values()];
}

/** The socket owners with `ps`'s %cpu where the kernel gives it (this user's processes), with no `ps` spawned. */
function ownerTable(pids: number[]): Map<number, ProcessWithUsage> {
    return new Map(readProcessesWithUsage(pids, { cpuPercent: true }).map((entry) => [entry.pid, entry]));
}

export function getPortDetails(port: number): PortSnapshot[] {
    const sockets = listSockets({ port }).filter((socket) => socket.pid !== process.pid);
    const table = ownerTable(sockets.map((socket) => socket.pid));
    return enrichPortProcesses(socketProcesses(sockets, { ownPid: process.pid, table }), table);
}

export function getListeningPorts(): PortSnapshot[] {
    const sockets = listSockets({ protocol: "TCP", state: "LISTEN" });
    const table = ownerTable(sockets.map((socket) => socket.pid));
    const seen = new Set<number>();
    const unique = socketProcesses(sockets, { ownPid: -1, table, perPort: true }).filter((entry) => {
        const port = extractPort(entry.name);
        if (!port || seen.has(port)) {
            return false;
        }
        seen.add(port);
        return true;
    });
    return enrichPortProcesses(unique, table);
}

function getListeningPortMap(): Map<number, number[]> {
    const values = new Map<number, number[]>();

    for (const portInfo of listSockets({ protocol: "TCP", state: "LISTEN" })) {
        const existing = values.get(portInfo.pid) ?? [];
        if (!existing.includes(portInfo.port)) {
            existing.push(portInfo.port);
        }
        values.set(portInfo.pid, existing);
    }

    return values;
}

export function summarizeCommand(command: string, processName: string): string {
    const parts = command.split(/\s+/).filter(Boolean);

    if (parts.length <= 1) {
        return processName;
    }

    const meaningful: string[] = [];

    for (let i = 1; i < parts.length; i += 1) {
        const part = parts[i];

        if (part.startsWith("-")) {
            continue;
        }

        meaningful.push(part.includes("/") || part.includes("\\") ? basename(part) : part);

        if (meaningful.length >= 3) {
            break;
        }
    }

    if (meaningful.length === 0) {
        return processName;
    }

    return meaningful.join(" ");
}

export function isLikelyDevProcess(processName: string, command: string): boolean {
    const name = processName.toLowerCase().replace(/\.exe$/i, "");
    const normalizedCommand = command.toLowerCase();

    for (const prefix of SYSTEM_PROCESS_PREFIXES) {
        if (name.startsWith(prefix)) {
            return false;
        }
    }

    if (DEV_PROCESS_NAMES.has(name)) {
        return true;
    }

    const matchers = [
        /\bnext\b/,
        /\bvite\b/,
        /\bnuxt\b/,
        /\bwebpack\b/,
        /\bremix\b/,
        /\bastro\b/,
        /\bflask\b/,
        /\bdjango\b/,
        /\buvicorn\b/,
        /manage\.py/,
        /\brails\b/,
        /\bcargo\b/,
        /docker/,
    ];

    return matchers.some((matcher) => matcher.test(normalizedCommand));
}

export function getAllProcesses(): ProcessSnapshot[] {
    const parsedRows = listProcessesWithUsage({ otherUsers: true, cpuPercent: true })
        .map(processRow)
        .filter((entry) => entry.pid > 1 && entry.pid !== process.pid);
    const cwdCandidates = parsedRows
        .filter((entry) => !entry.command.toLowerCase().includes("docker"))
        .map((entry) => entry.pid);
    const listeningPortMap = getListeningPortMap();

    const cwdMap = batchCwd(cwdCandidates);

    return parsedRows.map((row) => {
        const executable = row.command.split(/\s+/)[0] ?? row.command;
        const processName = basename(executable);
        const cwd = cwdMap.get(row.pid);
        const projectRoot = cwd ? findProjectRoot(cwd) : null;

        return {
            pid: row.pid,
            ppid: row.ppid,
            processName,
            command: row.command,
            user: row.user,
            cpu: row.cpu,
            memory: formatMemory(row.rss),
            cwd: projectRoot,
            projectName: projectRoot ? basename(projectRoot) : null,
            framework:
                detectFrameworkFromCommand(row.command, processName) ??
                (projectRoot ? detectFrameworkFromProject(projectRoot) : null),
            uptime: formatUptime(row.startTime),
            startTime: row.startTime,
            description: summarizeCommand(row.command, processName),
            status: deriveStatus(row, processName, row.command),
            listeningPorts: listeningPortMap.get(row.pid) ?? [],
        } satisfies ProcessSnapshot;
    });
}

export function getGitBranch(cwd: string | null): string | null {
    if (!cwd) {
        return null;
    }

    const result = captureSync("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = result.stdout.trim();

    if (result.status !== 0 || branch === "") {
        return null;
    }

    return branch;
}

export function findOrphanedPorts(): PortSnapshot[] {
    return getListeningPorts().filter((portInfo) => portInfo.status === "orphaned" || portInfo.status === "zombie");
}

function isProcessAliveLocal(pid: number): boolean {
    // Thin alias kept so this file's existing call sites read unchanged. The
    // old inline probe collapsed EPERM into "dead", which reported live
    // processes owned by another user as gone.
    return isProcessAlive(pid);
}

export interface KillTarget {
    pid: number;
    /**
     * The command this pid had WHEN IT WAS SCANNED, not when the kill was
     * requested. `tools port` puts a multiselect and a confirm prompt between
     * the two, so re-reading here would record whatever holds the number by
     * then and cheerfully signal it. The identity has to come from before that
     * window, which means the caller has to carry it in.
     */
    command: string;
}

export async function killProcesses(targets: KillTarget[]): Promise<KillResult[]> {
    const pids = targets.map((target) => target.pid);

    if (IS_WINDOWS) {
        return killProcessesWindows(pids);
    }

    const results: KillResult[] = [];
    const identities = new Map(targets.map((target) => [target.pid, target.command]));

    for (const pid of pids) {
        // Compare the CURRENT command against the one the scan recorded. A pid
        // that was reissued while the prompt sat open no longer matches, and
        // gets reported as already gone rather than signalled.
        const expected = identities.get(pid);
        const live = readProcessCommand(pid);

        if (live === null || (expected && live !== expected)) {
            if (live !== null) {
                logger.warn({ pid, expected, live }, "[port] pid was reused since the scan; not signalling it");
            }

            results.push({ pid, status: "killed" });
            continue;
        }

        try {
            // pid-verified: the live command was compared against the scan-time identity immediately above
            process.kill(pid, "SIGTERM");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (message.includes("EPERM")) {
                results.push({ pid, status: "failed", error: "Permission denied — try running as Administrator" });
            } else if (message.includes("ESRCH")) {
                results.push({ pid, status: "killed" });
            } else {
                results.push({ pid, status: "failed", error: message });
            }
        }
    }

    const pending = pids.filter((pid) => !results.some((result) => result.pid === pid));

    if (pending.length === 0) {
        return results;
    }

    await new Promise((resolve) => setTimeout(resolve, GRACEFUL_SHUTDOWN_WAIT_MS));

    for (const pid of pending) {
        if (!isProcessAliveLocal(pid)) {
            results.push({ pid, status: "killed" });
            continue;
        }

        // A process that dies during the grace period can have its number
        // reissued inside that same window, so re-check against the identity
        // captured before the first SIGTERM.
        const expected = identities.get(pid);

        if (expected && readProcessCommand(pid) !== expected) {
            logger.warn({ pid, expected }, "[port] pid was reused during the grace period; not sending SIGKILL");
            results.push({ pid, status: "killed" });
            continue;
        }

        try {
            // pid-verified: re-compared against the pre-SIGTERM snapshot immediately above
            process.kill(pid, "SIGKILL");
            results.push({ pid, status: "force-killed" });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (message.includes("ESRCH")) {
                results.push({ pid, status: "killed" });
            } else {
                results.push({ pid, status: "failed", error: message });
            }
        }
    }

    return results;
}

function killProcessesWindows(pids: number[]): Promise<KillResult[]> {
    const results: KillResult[] = [];

    for (const pid of pids) {
        const r = captureSync("taskkill", ["/PID", String(pid), "/F"]);

        if (r.status === 0) {
            results.push({ pid, status: "killed" });
        } else if (r.stderr.includes("not found") || r.stdout.includes("not found")) {
            results.push({ pid, status: "killed" });
        } else if (r.stderr.includes("Access is denied") || r.stdout.includes("Access is denied")) {
            results.push({ pid, status: "failed", error: "Permission denied — try running as Administrator" });
        } else {
            results.push({ pid, status: "failed", error: (r.stderr || r.stdout).trim() });
        }
    }

    return Promise.resolve(results);
}

export function watchPorts(
    callback: (event: "new" | "removed", snapshot: PortSnapshot) => void,
    options?: { includeSystem?: boolean; intervalMs?: number }
): WakefulInterval {
    const includeSystem = options?.includeSystem ?? false;
    const intervalMs = options?.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;
    let previous = new Map<number, PortSnapshot>();

    const collect = () => {
        const currentSnapshots = getListeningPorts().filter((snapshot) => {
            if (includeSystem) {
                return true;
            }

            return isLikelyDevProcess(snapshot.processName, snapshot.command);
        });
        const current = new Map(currentSnapshots.map((snapshot) => [snapshot.port, snapshot]));

        for (const [port, snapshot] of current.entries()) {
            const previousSnapshot = previous.get(port);

            if (!previousSnapshot || previousSnapshot.pid !== snapshot.pid) {
                callback("new", snapshot);
            }
        }

        for (const [port, snapshot] of previous.entries()) {
            if (!current.has(port)) {
                callback("removed", snapshot);
            }
        }

        previous = current;
    };

    return startWakefulInterval(intervalMs, collect);
}
