import { readdirSync, readFileSync } from "node:fs";

export interface StallThread {
    tid: number;
    name: string;
    /** The kernel's one-letter state: R running, S sleeping, D waiting on disk, Z zombie, ... */
    state: string;
    /** The kernel function the thread sleeps in ("0" while it runs). */
    wchan: string;
}

export interface StallChild {
    pid: number;
    state: string;
    command: string;
}

export interface StallSnapshot {
    threads: StallThread[];
    children: StallChild[];
}

function read(path: string): string | null {
    try {
        return readFileSync(path, "utf8");
    } catch {
        return null;
    }
}

/** `(name) S ...` from a stat file; the name may hold spaces and parentheses, so cut at the LAST `)`. */
function nameAndState(stat: string | null): { name: string; state: string } {
    if (!stat) {
        return { name: "?", state: "?" };
    }

    const close = stat.lastIndexOf(")");
    return { name: stat.slice(stat.indexOf("(") + 1, close), state: stat.slice(close + 2, close + 3) || "?" };
}

/**
 * What a process's threads wait on and which children it has, read from `/proc` without starting a process.
 * For a test worker that stalls: a thread in `D` names a disk wait, and a child in `Z` is one whose exit
 * nobody collected. Off Linux (no `/proc/<pid>/task`) both lists are empty.
 */
export function readStallSnapshot(pid: number, procRoot = "/proc"): StallSnapshot {
    let tids: string[];

    try {
        tids = readdirSync(`${procRoot}/${pid}/task`);
    } catch {
        return { threads: [], children: [] };
    }

    const threads: StallThread[] = [];
    const childPids = new Set<number>();

    for (const tid of tids) {
        const base = `${procRoot}/${pid}/task/${tid}`;
        threads.push({
            tid: Number(tid),
            ...nameAndState(read(`${base}/stat`)),
            wchan: read(`${base}/wchan`)?.trim() || "?",
        });

        for (const child of (read(`${base}/children`) ?? "").split(/\s+/).filter(Boolean)) {
            childPids.add(Number(child));
        }
    }

    const children = [...childPids].map((child) => ({
        pid: child,
        state: nameAndState(read(`${procRoot}/${child}/stat`)).state,
        command: (read(`${procRoot}/${child}/cmdline`) ?? "").replaceAll("\0", " ").trim().slice(0, 200),
    }));

    return { threads, children };
}
