/**
 * Jenkins capacity, computed from the raw `computer` and `queue` API answers: agents grouped by
 * template, queue reasons, the starved label, what holds the heavyweight executors and the zombies.
 * Pure functions over the API data; the `pods` and `executors` commands fetch and render.
 *
 * Jenkins has two kinds of executors and conflating them is the usual wrong turn: flyweight
 * executors run a pipeline's Groovy and are effectively unlimited, so hundreds of builds can read
 * as "running" while parked at a node() step. Only heavyweight executors (the machines the
 * busy/total counts describe) are scarce, and the parked requests ARE the queue.
 */

export const TREE_QUEUE = "items[id,why,stuck,inQueueSince,task[name,url]]";

export const TREE_COMPUTER =
    "busyExecutors,totalExecutors,computer[displayName,offline,assignedLabels[name]," +
    "executors[idle,currentExecutable[url,fullDisplayName,number,timestamp,estimatedDuration]]," +
    "oneOffExecutors[currentExecutable[url,fullDisplayName,timestamp]]]";

/** The queue fields TREE_QUEUE asks for; Jenkins returns nothing else here. */
export interface QueueItem {
    id?: number;
    why?: string;
    stuck?: boolean;
    inQueueSince?: number;
    task?: { name?: string; url?: string };
}

export interface Executable {
    url?: string;
    fullDisplayName?: string;
    number?: number;
    timestamp?: number;
    estimatedDuration?: number;
}

export interface ComputerSet {
    busyExecutors?: number;
    totalExecutors?: number;
    computer?: Array<{
        displayName?: string;
        offline?: boolean;
        assignedLabels?: Array<{ name?: string }>;
        executors?: Array<{ idle?: boolean; currentExecutable?: Executable | null }>;
    }>;
}

export interface AgentGroup {
    template: string;
    online: number;
    busy: number;
    offline: number;
}

export interface QueueReason {
    why: string;
    count: number;
    /** `inQueueSince` of the oldest item with this reason, or null when none carries it. */
    oldestSince: number | null;
    tasks: string[];
}

export interface QueueDiagnosis {
    total: number;
    reasons: Array<{ why: string; count: number }>;
    tasks: Array<{ name: string; count: number }>;
    stuck: number;
    oldestSince: number | null;
    /** The label named by the dominant "waiting for … executor on '<label>'" reason. */
    starvedLabel: string | null;
}

export interface Holder {
    elapsedMin: number;
    estMin: number | null;
    matchesLabel: boolean;
    name: string;
    url: string | null;
}

export interface ExecutorDiagnosis {
    total: number | null;
    busy: number | null;
    idleByLabel: Array<{ label: string; count: number }>;
    /** Busy and idle executors of `wantLabel`, when one was given. */
    wanted: { label: string; busy: number; idle: number } | null;
    /** The builds holding an executor (of `wantLabel`, when given), longest-running first. */
    holders: Holder[];
    /** Every build running longer than `zombieMins`, longest first. */
    zombies: Holder[];
}

function quotesStraight(why: string): string {
    return why.replace(/[‘’]/g, "'");
}

function countInto(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedEntries(map: Map<string, number>): [string, number][] {
    return [...map].sort((a, b) => b[1] - a[1]);
}

function minutesSince(ms: number | undefined, now: number): number | null {
    return ms ? Math.round(((now - ms) / 60000) * 10) / 10 : null;
}

/** A Kubernetes agent is named `<template>-<5 chars>`; the template groups them. */
export function agentTemplate(displayName: string): string {
    return displayName.replace(/-[a-z0-9]{5}$/, "");
}

/** Agents per template: online, busy (an online agent with a working executor) and offline, by name. */
export function groupAgents(data: ComputerSet): AgentGroup[] {
    const groups = new Map<string, AgentGroup>();

    for (const computer of data.computer ?? []) {
        const template = agentTemplate(computer.displayName ?? "?");
        const group = groups.get(template) ?? { template, online: 0, busy: 0, offline: 0 };

        if (computer.offline) {
            group.offline++;
        } else {
            group.online++;

            if ((computer.executors ?? []).some((executor) => !executor.idle)) {
                group.busy++;
            }
        }

        groups.set(template, group);
    }

    return [...groups.values()].sort((a, b) => a.template.localeCompare(b.template));
}

/** Queue items grouped by why they wait, most common first. */
export function queueReasons(items: QueueItem[]): QueueReason[] {
    const byWhy = new Map<string, QueueReason>();

    for (const item of items) {
        const why = quotesStraight(item.why ?? "?");
        const entry = byWhy.get(why) ?? { why, count: 0, oldestSince: null, tasks: [] };
        entry.count++;

        if (item.inQueueSince && (entry.oldestSince === null || item.inQueueSince < entry.oldestSince)) {
            entry.oldestSince = item.inQueueSince;
        }

        if (item.task?.name && !entry.tasks.includes(item.task.name)) {
            entry.tasks.push(item.task.name);
        }

        byWhy.set(why, entry);
    }

    return [...byWhy.values()].sort((a, b) => b.count - a.count);
}

export function diagnoseQueue(items: QueueItem[]): QueueDiagnosis {
    const reasons = new Map<string, number>();
    const tasks = new Map<string, number>();
    let oldest = Number.POSITIVE_INFINITY;
    let stuck = 0;

    for (const item of items) {
        countInto(reasons, quotesStraight(item.why ?? "<none>"));
        countInto(tasks, item.task?.name ?? "<unknown>");

        if (item.stuck) {
            stuck++;
        }

        if (item.inQueueSince) {
            oldest = Math.min(oldest, item.inQueueSince);
        }
    }

    const sortedReasons = sortedEntries(reasons);
    const starvedLabel =
        sortedReasons
            .map(([why]) => (why.includes("executor on") ? why.split("'")[1] : undefined))
            .find((label): label is string => Boolean(label)) ?? null;

    return {
        total: items.length,
        reasons: sortedReasons.map(([why, count]) => ({ why, count })),
        tasks: sortedEntries(tasks).map(([name, count]) => ({ name, count })),
        stuck,
        oldestSince: Number.isFinite(oldest) ? oldest : null,
        starvedLabel,
    };
}

export function diagnoseExecutors(
    data: ComputerSet,
    { now, wantLabel, zombieMins }: { now: number; wantLabel: string | null; zombieMins: number }
): ExecutorDiagnosis {
    const holders: Holder[] = [];
    const idleByLabel = new Map<string, number>();
    const busyByLabel = new Map<string, number>();

    for (const computer of data.computer ?? []) {
        const labels = (computer.assignedLabels ?? [])
            .map((label) => label.name)
            .filter((name): name is string => Boolean(name));
        const keys = labels.length > 0 ? labels : [computer.displayName ?? "?"];
        const matchesLabel = wantLabel ? labels.includes(wantLabel) : true;

        for (const executor of computer.executors ?? []) {
            const current = executor.currentExecutable;

            if (executor.idle || !current) {
                // An offline agent keeps its idle executors on paper but cannot take a queued build.
                if (!computer.offline) {
                    for (const key of keys) {
                        countInto(idleByLabel, key);
                    }
                }

                continue;
            }

            for (const key of keys) {
                countInto(busyByLabel, key);
            }

            const est = current.estimatedDuration;
            holders.push({
                elapsedMin: minutesSince(current.timestamp, now) ?? 0,
                estMin: est && est > 0 ? Math.round((est / 60000) * 10) / 10 : null,
                matchesLabel,
                name: current.fullDisplayName ?? "?",
                url: current.url ?? null,
            });
        }
    }

    const longestFirst = (a: Holder, b: Holder): number => b.elapsedMin - a.elapsedMin;

    return {
        total: data.totalExecutors ?? null,
        busy: data.busyExecutors ?? null,
        idleByLabel: sortedEntries(idleByLabel).map(([label, count]) => ({ label, count })),
        wanted: wantLabel
            ? { label: wantLabel, busy: busyByLabel.get(wantLabel) ?? 0, idle: idleByLabel.get(wantLabel) ?? 0 }
            : null,
        holders: (wantLabel ? holders.filter((h) => h.matchesLabel) : [...holders]).sort(longestFirst),
        zombies: holders.filter((h) => h.elapsedMin > zombieMins).sort(longestFirst),
    };
}
