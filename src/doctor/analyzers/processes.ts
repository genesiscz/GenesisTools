import { Analyzer } from "@app/doctor/lib/analyzer";
import { labelForProcess } from "@app/doctor/lib/process-labels";
import { run } from "@app/doctor/lib/run";
import { classifyProcess, PROCESS_NEVER_KILL } from "@app/doctor/lib/safety";
import type {
    Action,
    ActionResult,
    AnalyzerCategory,
    AnalyzerContext,
    ExecutorContext,
    Finding,
} from "@app/doctor/lib/types";

const STRICT_PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+(?:\s\S+)*?)\s\s+(.*)$/;
const LOOSE_PS_LINE = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+(?:\s\S+)*?)\s+(\S.*)$/;

export interface ProcessRecord {
    pid: number;
    ppid: number;
    cpu: number;
    rssBytes: number;
    stat: string;
    comm: string;
    command: string;
    label: string | null;
    isZombie: boolean;
}

export function parsePsOutput(raw: string): ProcessRecord[] {
    const lines = raw.split("\n").filter((line) => line.trim().length > 0);
    const records: ProcessRecord[] = [];

    for (const line of lines) {
        if (/^\s*PID\s+PPID/.test(line)) {
            continue;
        }

        const match = line.match(STRICT_PS_LINE);

        if (match) {
            records.push(buildRecord(match));
            continue;
        }

        const loose = line.match(LOOSE_PS_LINE);

        if (!loose) {
            continue;
        }

        records.push(buildRecord(loose));
    }

    return records;
}

function buildRecord(match: RegExpMatchArray): ProcessRecord {
    const pid = Number.parseInt(match[1], 10);
    const ppid = Number.parseInt(match[2], 10);
    const cpu = Number.parseFloat(match[3]);
    const rssKb = Number.parseInt(match[4], 10);
    const stat = match[5];
    const comm = match[6].trim();
    const command = match[7];

    return {
        pid,
        ppid,
        cpu,
        rssBytes: rssKb * 1024,
        stat,
        comm,
        command,
        label: labelForProcess({ comm, command }),
        isZombie: stat.includes("Z"),
    };
}

export function buildTree(records: ProcessRecord[]): Map<number, ProcessRecord[]> {
    const tree = new Map<number, ProcessRecord[]>();

    for (const record of records) {
        const children = tree.get(record.ppid) ?? [];
        children.push(record);
        tree.set(record.ppid, children);
    }

    return tree;
}

export function descendants(pid: number, tree: Map<number, ProcessRecord[]>): ProcessRecord[] {
    const out: ProcessRecord[] = [];
    const stack = [...(tree.get(pid) ?? [])];

    while (stack.length > 0) {
        const node = stack.pop();

        if (!node) {
            continue;
        }

        out.push(node);
        stack.push(...(tree.get(node.pid) ?? []));
    }

    return out;
}

function killPidAction(pid: number, label: string): Action {
    return {
        id: "kill",
        label: `Kill PID ${pid} - ${label}`,
        confirm: "yesno",
        execute: async (_ctx: ExecutorContext, finding): Promise<ActionResult> => {
            const res = await run("kill", [String(pid)]);

            return {
                findingId: finding.id,
                actionId: "kill",
                status: res.status === 0 ? "ok" : "failed",
                error: res.status !== 0 ? `kill ${pid} failed` : undefined,
                metadata: { pid },
            };
        },
    };
}

/**
 * Best-effort human name when labelForProcess didn't match a rule.
 * macOS `ps` truncates the `comm` column (often to the binary path), so pull
 * the basename when it looks like a path, and fall back to `command` otherwise.
 */
function displayCommName(record: ProcessRecord): string {
    const comm = record.comm;

    if (comm.includes("/")) {
        const tail = comm.split("/").pop();

        if (tail && tail.length > 0) {
            return tail;
        }
    }

    if (comm.length >= 15 && record.command) {
        // comm was likely truncated — try to extract an app name from the full command.
        const app = record.command.match(/\/([^/]+)\.app\//);

        if (app) {
            return app[1];
        }

        const bin = record.command.split(/\s+/)[0]?.split("/").pop();

        if (bin) {
            return bin;
        }
    }

    return comm;
}

function getCommForPid(pid: number, kids: ProcessRecord[], root: ProcessRecord): string {
    if (pid === root.pid) {
        return root.comm;
    }

    return kids.find((kid) => kid.pid === pid)?.comm ?? "";
}

function killTreeAction(root: ProcessRecord, kids: ProcessRecord[]): Action {
    return {
        id: "kill-tree",
        label: `Kill ${root.label ?? root.comm} + ${kids.length} descendants`,
        confirm: "yesno",
        execute: async (_ctx, finding): Promise<ActionResult> => {
            const pids = [root.pid, ...kids.map((kid) => kid.pid)];
            const killable = pids.filter((pid) => !PROCESS_NEVER_KILL.has(getCommForPid(pid, kids, root)));
            const res = await run("kill", killable.map(String));

            return {
                findingId: finding.id,
                actionId: "kill-tree",
                status: res.status === 0 ? "ok" : "failed",
                metadata: { killed: killable, skipped: pids.length - killable.length },
            };
        },
    };
}

function createKillGroupAction(comm: string, label: string, group: ProcessRecord[]): Action {
    return {
        id: "kill-group",
        label: `Kill all ${group.length} ${label} processes`,
        confirm: "typed",
        confirmPhrase: comm,
        execute: async (_ctx, finding): Promise<ActionResult> => {
            const pids = group.map((record) => String(record.pid));
            const res = await run("kill", pids);

            return {
                findingId: finding.id,
                actionId: "kill-group",
                status: res.status === 0 ? "ok" : "failed",
                metadata: { pidsKilled: pids.length },
            };
        },
    };
}

export class ProcessesAnalyzer extends Analyzer {
    readonly id = "processes";
    readonly name = "Processes";
    readonly icon = "P";
    readonly category: AnalyzerCategory = "processes";
    readonly cacheTtlMs = 0;

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        const res = await run("ps", ["-axo", "pid,ppid,pcpu,rss,stat,comm,command"]);

        if (res.status !== 0) {
            return;
        }

        const records = parsePsOutput(res.stdout);
        const tree = buildTree(records);

        for (const zombie of records.filter((record) => record.isZombie)) {
            yield {
                id: `proc-zombie-${zombie.pid}`,
                analyzerId: this.id,
                title: `Zombie PID ${zombie.pid} - ${zombie.label ?? zombie.comm}`,
                detail: "Defunct process stuck in kernel - usually harmless, but indicates a parent not reaping.",
                severity: "safe",
                actions: [],
                metadata: { pid: zombie.pid, ppid: zombie.ppid, label: zombie.label },
            };
        }

        const sortedByCpu = [...records].sort((a, b) => b.cpu - a.cpu);

        for (const hog of sortedByCpu.filter((record) => record.cpu >= 50).slice(0, 5)) {
            const safety = classifyProcess(hog.comm);
            const kids = descendants(hog.pid, tree);
            const actions: Action[] = [];

            if (safety.severity !== "blocked") {
                actions.push(killPidAction(hog.pid, hog.label ?? hog.comm));

                if (kids.length > 0) {
                    actions.push(killTreeAction(hog, kids));
                }
            }

            const suffix = safety.autoRespawn ? " (will restart)" : "";

            const displayName = hog.label ?? displayCommName(hog);

            yield {
                id: `proc-cpu-${hog.pid}`,
                analyzerId: this.id,
                title: `${displayName}${suffix} - ${hog.cpu.toFixed(1)}% CPU (PID ${hog.pid})`,
                detail: hog.command.length > 120 ? `${hog.command.slice(0, 120)}...` : hog.command,
                severity: safety.severity === "blocked" ? "blocked" : "cautious",
                blacklistReason: safety.reason,
                actions,
                metadata: {
                    pid: hog.pid,
                    cpu: hog.cpu,
                    comm: hog.comm,
                    label: hog.label,
                    childCount: kids.length,
                },
            };
        }

        const byName = new Map<string, ProcessRecord[]>();

        for (const record of records) {
            const bucket = byName.get(record.comm) ?? [];
            bucket.push(record);
            byName.set(record.comm, bucket);
        }

        for (const [comm, group] of byName) {
            if (group.length < 5) {
                continue;
            }

            const safety = classifyProcess(comm);

            if (safety.severity === "blocked") {
                continue;
            }

            const totalRss = group.reduce((acc, record) => acc + record.rssBytes, 0);
            const label = group[0].label ?? displayCommName(group[0]);
            const visiblePids = group
                .slice(0, 10)
                .map((record) => record.pid)
                .join(", ");
            const detail = `PIDs: ${visiblePids}${group.length > 10 ? "..." : ""}`;

            yield {
                id: `proc-group-${comm}`,
                analyzerId: this.id,
                title: `${label} x ${group.length} processes`,
                detail,
                severity: "cautious",
                reclaimableBytes: totalRss,
                actions: [createKillGroupAction(comm, label, group)],
                metadata: { comm, count: group.length, totalRss, label },
            };
        }
    }
}
