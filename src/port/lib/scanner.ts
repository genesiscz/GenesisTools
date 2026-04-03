import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import type { KillResult, PortProcess, PortSnapshot, ProcessSnapshot, ProcessStatus } from "./types";

const STATE_PRIORITY: Record<string, number> = {
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

const PS_BATCH_SIZE = 60;
const MAX_PROJECT_ROOT_DEPTH = 12;
const KB_PER_MB = 1024;
const KB_PER_GB = 1024 * 1024;
const GRACEFUL_SHUTDOWN_WAIT_MS = 1000;
const DEFAULT_WATCH_INTERVAL_MS = 2000;
// ps columns: PID PPID USER STAT %CPU RSS TTY LSTART COMMAND
const PS_ROW_PATTERN = /^(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(\d+)\s+\w+\s+(\w+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/;

interface PsRow {
    pid: number;
    ppid: number;
    user: string;
    stat: string;
    cpu: number;
    rss: number;
    startTime: Date | null;
    command: string;
}

function run(command: string, args: string[]): { stdout: string; stderr: string; status: number | null } {
    const result = spawnSync(command, args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    });

    return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        status: result.status,
    };
}

function chunk<T>(items: T[], size: number): T[][] {
    const chunks: T[][] = [];

    for (let i = 0; i < items.length; i += size) {
        chunks.push(items.slice(i, i + size));
    }

    return chunks;
}

function parsePsLine(line: string): PsRow | null {
    const match = line.trim().match(PS_ROW_PATTERN);

    if (!match) {
        return null;
    }

    const startTime = new Date(match[7]);

    return {
        pid: Number.parseInt(match[1], 10),
        ppid: Number.parseInt(match[2], 10),
        user: match[3],
        stat: match[4],
        cpu: Number.parseFloat(match[5]),
        rss: Number.parseInt(match[6], 10),
        startTime: Number.isNaN(startTime.getTime()) ? null : startTime,
        command: match[8],
    };
}

function batchPsInfo(pids: number[]): Map<number, PsRow> {
    const rows = new Map<number, PsRow>();

    for (const batch of chunk(pids, PS_BATCH_SIZE)) {
        const result = run("ps", ["-p", batch.join(","), "-o", "pid=,ppid=,user=,state=,pcpu=,rss=,lstart=,command="]);

        for (const line of result.stdout.split("\n")) {
            if (line.trim() === "") {
                continue;
            }

            const parsed = parsePsLine(line);

            if (!parsed) {
                continue;
            }

            rows.set(parsed.pid, parsed);
        }
    }

    return rows;
}

function batchCwd(pids: number[]): Map<number, string> {
    const values = new Map<number, string>();

    for (const batch of chunk(pids, PS_BATCH_SIZE)) {
        const result = run("lsof", ["-a", "-d", "cwd", "-p", batch.join(",")]);
        const lines = result.stdout.split("\n").slice(1);

        for (const line of lines) {
            if (line.trim() === "") {
                continue;
            }

            const parts = line.trim().split(/\s+/);

            if (parts.length < 9) {
                continue;
            }

            const pid = Number.parseInt(parts[1], 10);
            const cwd = parts.slice(8).join(" ");

            if (Number.isNaN(pid) || !cwd.startsWith("/")) {
                continue;
            }

            values.set(pid, cwd);
        }
    }

    return values;
}

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

    while (current !== "/" && depth < MAX_PROJECT_ROOT_DEPTH) {
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

    if (name === "node" || name === "bun") {
        return "Node.js";
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

export function parseLsofOutput(output: string, ownPid = process.pid): PortProcess[] {
    const lines = output.trim().split("\n");

    if (lines.length <= 1) {
        return [];
    }

    const byPid = new Map<number, PortProcess>();

    for (let i = 1; i < lines.length; i += 1) {
        const parts = lines[i].trim().split(/\s+/);

        if (parts.length < 9) {
            continue;
        }

        const pid = Number.parseInt(parts[1], 10);

        if (Number.isNaN(pid) || pid === ownPid) {
            continue;
        }

        const name = parts.slice(8).join(" ");
        const stateMatch = name.match(/\((\w+)\)$/);
        const state = stateMatch?.[1] ?? "UNKNOWN";
        const entry: PortProcess = {
            pid,
            command: parts[0],
            user: parts[2],
            state,
            name,
            fd: parts[3],
        };
        const existing = byPid.get(pid);

        if (!existing) {
            byPid.set(pid, entry);
            continue;
        }

        const currentPriority = STATE_PRIORITY[existing.state] ?? 99;
        const newPriority = STATE_PRIORITY[entry.state] ?? 99;

        if (newPriority < currentPriority) {
            byPid.set(pid, entry);
        }
    }

    return Array.from(byPid.values());
}

function enrichPortProcesses(processes: PortProcess[]): PortSnapshot[] {
    if (processes.length === 0) {
        return [];
    }

    const pids = [...new Set(processes.map((processInfo) => processInfo.pid))];
    const psMap = batchPsInfo(pids);
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

export function getPortDetails(port: number): PortSnapshot[] {
    const result = run("lsof", ["-i", `:${port}`, "-n", "-P"]);

    if (result.status !== 0 && result.stdout.trim() === "") {
        return [];
    }

    return enrichPortProcesses(parseLsofOutput(result.stdout));
}

export function getListeningPorts(): PortSnapshot[] {
    const result = run("lsof", ["-iTCP", "-sTCP:LISTEN", "-P", "-n"]);

    if (result.status !== 0 || result.stdout.trim() === "") {
        return [];
    }

    const seenPorts = new Set<number>();
    const uniquePorts: PortProcess[] = [];

    for (const processInfo of parseLsofOutput(result.stdout, -1)) {
        const port = extractPort(processInfo.name);

        if (!port || seenPorts.has(port)) {
            continue;
        }

        seenPorts.add(port);
        uniquePorts.push(processInfo);
    }

    return enrichPortProcesses(uniquePorts);
}

function getListeningPortMap(): Map<number, number[]> {
    const values = new Map<number, number[]>();

    for (const portInfo of getListeningPorts()) {
        const existing = values.get(portInfo.pid) ?? [];
        existing.push(portInfo.port);
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

        meaningful.push(part.includes("/") ? basename(part) : part);

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
    const name = processName.toLowerCase();
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
    const result = run("ps", ["-axo", "pid=,ppid=,user=,state=,pcpu=,rss=,lstart=,command="]);

    if (result.status !== 0 || result.stdout.trim() === "") {
        return [];
    }

    const cwdCandidates: number[] = [];
    const parsedRows: PsRow[] = [];
    const listeningPortMap = getListeningPortMap();

    for (const line of result.stdout.split("\n")) {
        if (line.trim() === "") {
            continue;
        }

        const parsed = parsePsLine(line);

        if (!parsed) {
            continue;
        }

        if (parsed.pid <= 1 || parsed.pid === process.pid) {
            continue;
        }

        parsedRows.push(parsed);

        if (!parsed.command.toLowerCase().includes("docker")) {
            cwdCandidates.push(parsed.pid);
        }
    }

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

    const result = run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = result.stdout.trim();

    if (result.status !== 0 || branch === "") {
        return null;
    }

    return branch;
}

export function findOrphanedPorts(): PortSnapshot[] {
    return getListeningPorts().filter((portInfo) => portInfo.status === "orphaned" || portInfo.status === "zombie");
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export async function killProcesses(pids: number[]): Promise<KillResult[]> {
    const results: KillResult[] = [];

    for (const pid of pids) {
        try {
            process.kill(pid, "SIGTERM");
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            if (message.includes("EPERM")) {
                results.push({ pid, status: "failed", error: "Permission denied — try running with sudo" });
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
        if (!isProcessAlive(pid)) {
            results.push({ pid, status: "killed" });
            continue;
        }

        try {
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

export function watchPorts(
    callback: (event: "new" | "removed", snapshot: PortSnapshot) => void,
    options?: { includeSystem?: boolean; intervalMs?: number }
): ReturnType<typeof setInterval> {
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

    collect();
    return setInterval(collect, intervalMs);
}
