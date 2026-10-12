import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { logger } from "@genesiscz/utils/logger";
import { readProcessCwd } from "@genesiscz/utils/process/cwd";
import {
    formatPsCpuTime,
    listProcessTable,
    readProcessUsage,
    readPsCommand,
} from "@genesiscz/utils/process/libproc-table";
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
function scanFromKernel(scan: AgentProcessScan): ActiveAgentProcess[] | null {
    const table = listProcessTable();

    if (table === null) {
        return null;
    }

    const euid = process.geteuid?.() ?? -1;
    const found: ActiveAgentProcess[] = [];

    for (const row of table) {
        if (row.pid <= 0 || row.zombie || (row.uid !== euid && euid !== 0)) {
            continue;
        }

        const command = readPsCommand(row.pid);
        const args = command === null ? "" : command.split(/\s+/).join(" ");
        const kind = args === "" ? null : scan.classify(args);

        if (!kind) {
            continue;
        }

        const usage = readProcessUsage(row.pid);

        // Gone since the table was read.
        if (!usage) {
            continue;
        }

        const { account, proxyTarget } = accountFromEnv(readPsCommand(row.pid, { env: true }) ?? "", scan.alias);

        found.push({
            pid: row.pid,
            ppid: row.ppid,
            tty: row.tty ?? "??",
            startedAt: Math.floor(row.startMs / 1000) * 1000,
            cpuTime: formatPsCpuTime(usage.cpuTimeMs),
            args,
            kind,
            account,
            proxyTarget,
            cwd: readProcessCwd(row.pid),
        });
    }

    // `ps -ax` prints processes without a terminal first, then by terminal, each by pid.
    return found.sort((a, b) => {
        if (a.tty === b.tty) {
            return a.pid - b.pid;
        }

        if (a.tty === "??" || b.tty === "??") {
            return a.tty === "??" ? -1 : 1;
        }

        return a.tty < b.tty ? -1 : 1;
    });
}

/** This user's live agent processes (every user's under root); see `scanFromKernel` for why only this user's. */
export async function listActiveAgentProcesses(scan: AgentProcessScan): Promise<ActiveAgentProcess[]> {
    return scanFromKernel(scan) ?? listActiveAgentProcessesViaPs(scan);
}

/** {@link listActiveAgentProcesses} through two `ps` reads and one `lsof`, where the kernel read is unavailable. */
export async function listActiveAgentProcessesViaPs(scan: AgentProcessScan): Promise<ActiveAgentProcess[]> {
    // BSD flag syntax on purpose: the dashless `e` appends the environment, while `-e` merely
    // means "every process" and shows no env at all.
    const [argvOut, envOut] = await Promise.all([
        runCapture(["ps", "axww", "-o", "pid=,ppid=,tty=,lstart=,time=,args="]),
        runCapture(["ps", "axeww", "-o", "pid=,args="]),
    ]);
    const rows: Array<PsProcessRow & { kind: string }> = [];

    for (const line of argvOut.split("\n")) {
        const row = parsePsLine(line);
        const kind = row ? scan.classify(row.args) : null;

        if (row && kind) {
            rows.push({ ...row, kind });
        }
    }

    if (rows.length === 0) {
        return [];
    }

    const envByPid = new Map<number, string>();

    for (const line of envOut.split("\n")) {
        const match = line.match(/^\s*(\d+)\s+(.*)$/);

        if (match) {
            envByPid.set(Number(match[1]), match[2]);
        }
    }

    const lsofOut = await runCapture(["lsof", "-a", "-d", "cwd", "-p", rows.map((row) => row.pid).join(","), "-Fpn"]);
    const cwdByPid = parseLsofCwd(lsofOut);

    return rows.map((row) => {
        const { account, proxyTarget } = accountFromEnv(envByPid.get(row.pid) ?? "", scan.alias);

        return { ...row, account, proxyTarget, cwd: cwdByPid.get(row.pid) ?? null };
    });
}
