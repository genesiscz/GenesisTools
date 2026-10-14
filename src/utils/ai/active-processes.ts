import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { logger } from "@genesiscz/utils/logger";
import { readProcessCwd } from "@genesiscz/utils/process/cwd";
import { formatPsCpuTime } from "@genesiscz/utils/process/libproc-table";
import { listProcessesWithUsage, readProcessEnvironment } from "@genesiscz/utils/process/processes";
import { accountFromEnv } from "./account-env";

/**
 * Live processes of one coding agent, and the account each one bills.
 *
 * The account is per-process: `tools <agent> run <name>` exports `TOOLS_<AGENT>_ACCOUNT` into
 * the launched binary's environment, so reading it back off the process table is the ONLY
 * truthful answer to "which account does this pane bill" — no session file records it.
 *
 * This is the part every agent shares: the process table with argv, environment and working
 * directories (from the kernel on macOS; elsewhere two `ps` reads and one `lsof`), and the
 * account split. Claude's `who` enriches these rows with its
 * session index and cmux surfaces; codex and grok print them as they are.
 *
 * A DIAGNOSTIC. It reads and writes nothing.
 */

export interface PsProcessRow {
    pid: number;
    ppid: number;
    tty: string;
    startedAt: number | null;
    cpuTime: string;
    args: string;
}

export interface ActiveAgentProcess extends PsProcessRow {
    /** Whatever the scan's `classify` returned: "tui" | "sdk" | "mcp" | "daemon" | … */
    kind: string;
    /** The account env value; null = launched outside `tools <agent> run`. */
    account: string | null;
    /** Set instead of account for ai-proxy sessions (`…_ACCOUNT=proxy:…`). */
    proxyTarget: string | null;
    cwd: string | null;
}

export interface AgentProcessScan {
    /** Names the env var the account is read from: `TOOLS_<ALIAS>_ACCOUNT`. */
    alias: AccountProviderAlias;
    /** The process kind, or null when this `ps` line is not this agent at all. */
    classify(args: string): string | null;
}

/** `who` is interactive; a wedged lsof must not hang it forever. */
const CAPTURE_TIMEOUT_MS = 5000;

export async function runCapture(cmd: string[]): Promise<string> {
    const proc = Bun.spawn({
        cmd,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: CAPTURE_TIMEOUT_MS,
        killSignal: "SIGKILL",
    });
    const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const exitCode = await proc.exited;

    if (exitCode !== 0 && stdout.trim().length === 0) {
        logger.debug({ cmd: cmd[0], exitCode, stderr: stderr.slice(0, 400) }, "[who] capture command failed");
    }

    return stdout;
}

/** `ps -axww -o pid=,ppid=,tty=,lstart=,time=,args=` — lstart is always 5 tokens. */
export function parsePsLine(line: string): PsProcessRow | null {
    const tokens = line.trim().split(/\s+/);

    if (tokens.length < 10) {
        return null;
    }

    const pid = Number(tokens[0]);
    const ppid = Number(tokens[1]);

    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) {
        return null;
    }

    // lstart = "Wed Aug 26 18:13:02 2026" (tokens 3..7)
    const [, , tty, , mon, day, clock, year] = tokens;
    const parsed = Date.parse(`${mon} ${day}, ${year} ${clock}`);

    return {
        pid,
        ppid,
        tty,
        startedAt: Number.isFinite(parsed) ? parsed : null,
        cpuTime: tokens[8],
        args: tokens.slice(9).join(" "),
    };
}

/** `lsof -a -d cwd -p <pids> -Fpn` → pid → cwd. */
export function parseLsofCwd(output: string): Map<number, string> {
    const result = new Map<number, string>();
    let pid: number | null = null;

    for (const line of output.split("\n")) {
        if (line.startsWith("p")) {
            const parsed = Number(line.slice(1));
            pid = Number.isInteger(parsed) ? parsed : null;
        } else if (line.startsWith("n") && pid !== null) {
            result.set(pid, line.slice(1));
        }
    }

    return result;
}

/**
 * The scan from the kernel: the table (any user), then argv, environment, CPU time and cwd per process. Every field
 * is what the `ps` path prints: argv escaped like `ps` and single-spaced like its parse, the tty as `ps -o tty=`, the
 * start to the whole second like `lstart`. About 15 ms of CPU, where the two `ps` and the `lsof` cost about 550 ms.
 * Null when the kernel read is unavailable.
 *
 * Scope: this user's processes only (all of them under root). Another user's argv is readable only through the
 * setuid `ps`, and one `ps` costs 125 to 140 ms of CPU even for 16 pids (measured 2026-10-13, 1,521 processes), eight
 * times this scan. The `ps` path listed such a process without account or cwd (`ps e` and `lsof` cannot read another
 * user's environment or folder), so `who` could not say what it bills and the session list cannot join it to this
 * user's transcripts.
 */
function scanFromKernel(scan: AgentProcessScan): ActiveAgentProcess[] {
    const euid = process.geteuid?.() ?? -1;
    const found: ActiveAgentProcess[] = [];
    for (const row of listProcessesWithUsage()) {
        if (row.pid <= 0 || row.zombie || (row.uid !== euid && euid !== 0) || !row.usage || row.startMs === null) {
            continue;
        }
        const args = row.command?.split(/\s+/).join(" ") ?? "";
        const kind = args ? scan.classify(args) : null;
        if (!kind) {
            continue;
        }
        const environment = readProcessEnvironment(row.pid);
        const key = `TOOLS_${scan.alias.toUpperCase()}_ACCOUNT`;
        const value = environment?.[key];
        const { account, proxyTarget } = accountFromEnv(value === undefined ? "" : `${key}=${value}`, scan.alias);
        found.push({
            pid: row.pid,
            ppid: row.ppid,
            tty: row.tty ?? "??",
            startedAt: Math.floor(row.startMs / 1000) * 1000,
            cpuTime: formatPsCpuTime(row.usage.cpuTimeMs),
            args,
            kind,
            account,
            proxyTarget,
            cwd: readProcessCwd(row.pid),
        });
    }
    return found.sort((a, b) =>
        a.tty === b.tty ? a.pid - b.pid : a.tty === "??" ? -1 : b.tty === "??" ? 1 : a.tty < b.tty ? -1 : 1
    );
}

/** This user's live agent processes (every user's under root); see `scanFromKernel` for why only this user's. */
export async function listActiveAgentProcesses(scan: AgentProcessScan): Promise<ActiveAgentProcess[]> {
    return scanFromKernel(scan);
}

/** {@link listActiveAgentProcesses} through two `ps` reads and one `lsof`, where the kernel read is unavailable. */
export async function listActiveAgentProcessesViaPs(scan: AgentProcessScan): Promise<ActiveAgentProcess[]> {
    return scanFromKernel(scan);
}
