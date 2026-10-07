/**
 * Why is the queue backed up? Jenkins has two kinds of executors and conflating
 * them is the usual wrong turn: flyweight executors run a pipeline's Groovy and
 * are effectively unlimited, so hundreds of builds can read as "running" while
 * parked at a node() step. Only heavyweight executors (the machines the
 * busy/total counts describe) are scarce, and the parked requests ARE the queue.
 *
 * So this separates the two, names the starved label, lists what is holding a
 * matching executor longest-first, and flags zombies: builds far past their
 * estimate that pin an executor until someone aborts them.
 */

import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { getJenkinsBackend } from "../lib/rest/client";
import { fmtDuration } from "../lib/rest/wfapi";

const TREE_QUEUE = "items[id,why,stuck,inQueueSince,task[name,url]]";

/** The queue fields TREE_QUEUE asks for; Jenkins returns nothing else here. */
interface QueueItem {
    id?: number;
    why?: string;
    stuck?: boolean;
    inQueueSince?: number;
    task?: { name?: string; url?: string };
}

const TREE_COMPUTER =
    "busyExecutors,totalExecutors,computer[displayName,offline,assignedLabels[name]," +
    "executors[idle,currentExecutable[url,fullDisplayName,number,timestamp,estimatedDuration]]," +
    "oneOffExecutors[currentExecutable[url,fullDisplayName,timestamp]]]";

interface Executable {
    url?: string;
    fullDisplayName?: string;
    number?: number;
    timestamp?: number;
    estimatedDuration?: number;
}

interface ComputerSet {
    busyExecutors?: number;
    totalExecutors?: number;
    computer?: Array<{
        displayName?: string;
        offline?: boolean;
        assignedLabels?: Array<{ name?: string }>;
        executors?: Array<{ idle?: boolean; currentExecutable?: Executable | null }>;
    }>;
}

interface Holder {
    elapsedMin: number;
    estMin: number | null;
    matchesLabel: boolean;
    name: string;
    url: string | null;
}

function minutesSince(ms: number | undefined, now: number): number | null {
    return ms ? Math.round(((now - ms) / 60000) * 10) / 10 : null;
}

function countInto(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function sortedEntries(map: Map<string, number>): [string, number][] {
    return [...map].sort((a, b) => b[1] - a[1]);
}

/** The dominant "waiting for … executor on '<label>'" reason names the starved label. */
async function diagnoseQueue(now: number): Promise<string | null> {
    const backend = await getJenkinsBackend();
    const data = await backend.api<{ items?: QueueItem[] }>(`queue/api/json?tree=${TREE_QUEUE}`);
    const items = data.items ?? [];
    out.println(`QUEUE: ${items.length} item(s) waiting\n`);

    if (items.length === 0) {
        out.println("  (queue is empty, no backlog right now)\n");

        return null;
    }

    const reasons = new Map<string, number>();
    const tasks = new Map<string, number>();
    let oldest = Number.POSITIVE_INFINITY;
    let stuck = 0;

    for (const item of items) {
        countInto(reasons, (item.why ?? "<none>").replace(/[‘’]/g, "'"));
        countInto(tasks, item.task?.name ?? "<unknown>");

        if (item.stuck) {
            stuck++;
        }

        if (item.inQueueSince) {
            oldest = Math.min(oldest, item.inQueueSince);
        }
    }

    out.println("  reasons:");

    for (const [why, n] of sortedEntries(reasons)) {
        out.println(`    ${String(n).padStart(4)}x  ${why}`);
    }

    if (stuck > 0) {
        out.println(`\n  ${stuck} flagged stuck (Jenkins thinks they may never schedule)`);
    }

    if (Number.isFinite(oldest)) {
        out.println(`\n  oldest item waiting: ${fmtDuration(now - oldest)}`);
    }

    const starved = sortedEntries(reasons)
        .map(([why]) => (why.includes("executor on") ? why.split("'")[1] : undefined))
        .find((label): label is string => Boolean(label));

    if (starved) {
        out.println(`  => starved label appears to be: ${starved}`);
    }

    out.println("\n  queued task types (top):");

    for (const [name, n] of sortedEntries(tasks).slice(0, 8)) {
        out.println(`    ${String(n).padStart(4)}x  ${name}`);
    }

    out.println("");

    return starved ?? null;
}

async function diagnoseExecutors(
    now: number,
    wantLabel: string | null,
    zombieMins: number,
    showUrls: boolean
): Promise<void> {
    const backend = await getJenkinsBackend();
    const data = await backend.api<ComputerSet>(`computer/api/json?tree=${TREE_COMPUTER}`);
    out.println(
        `EXECUTORS: total=${data.totalExecutors}  busy=${data.busyExecutors}  ` +
            "(heavyweight pool; flyweight pipeline tasks are NOT counted here)\n"
    );

    const holders: Holder[] = [];
    const idleByLabel = new Map<string, number>();
    const busyByLabel = new Map<string, number>();

    for (const computer of data.computer ?? []) {
        const labels = (computer.assignedLabels ?? [])
            .map((l) => l.name)
            .filter((name): name is string => Boolean(name));
        const keys = labels.length > 0 ? labels : [computer.displayName ?? "?"];
        const matchesLabel = wantLabel ? labels.includes(wantLabel) : true;

        for (const executor of computer.executors ?? []) {
            const current = executor.currentExecutable;

            if (executor.idle || !current) {
                keys.forEach((k) => {
                    countInto(idleByLabel, k);
                });
                continue;
            }

            keys.forEach((k) => {
                countInto(busyByLabel, k);
            });
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

    if (wantLabel) {
        out.println(
            `  label '${wantLabel}': busy=${busyByLabel.get(wantLabel) ?? 0}  idle=${idleByLabel.get(wantLabel) ?? 0}`
        );
    }

    out.println("  idle heavyweight executors by label (idle on the WRONG label cannot drain a label-specific queue):");

    for (const [label, n] of sortedEntries(idleByLabel)) {
        out.println(`    ${String(n).padStart(3)} idle  ${label}`);
    }

    const relevant = (wantLabel ? holders.filter((h) => h.matchesLabel) : holders).sort(
        (a, b) => b.elapsedMin - a.elapsedMin
    );
    out.println(
        `\n  ${wantLabel ? `HOLDING a '${wantLabel}' executor` : "HOLDING an executor"} (longest-running first):`
    );

    for (const h of relevant) {
        const over = h.estMin && h.elapsedMin > h.estMin ? "  <-- OVER EST" : "";
        out.println(`    ${String(h.elapsedMin).padStart(9)} min  est=${h.estMin ?? "?"}${over}  ${h.name}`);

        if (showUrls && h.url) {
            out.println(`               ${h.url}`);
        }
    }

    const zombies = holders.filter((h) => h.elapsedMin > zombieMins).sort((a, b) => b.elapsedMin - a.elapsedMin);

    if (zombies.length === 0) {
        out.println(`\n  no builds running longer than ${zombieMins} min.`);

        return;
    }

    out.println(`\n  ZOMBIES (running > ${zombieMins} min, likely hung, pinning an executor until aborted):`);

    for (const z of zombies) {
        const days = Math.round((z.elapsedMin / 1440) * 10) / 10;
        const tag = wantLabel && z.matchesLabel ? "  [matches target label]" : "";
        out.println(`    ${String(z.elapsedMin).padStart(9)} min (${days}d)  est=${z.estMin ?? "?"}${tag}  ${z.name}`);

        if (z.url) {
            out.println(`               ${z.url}`);
        }
    }
}

export function registerExecutors(jenkins: Command): void {
    jenkins
        .command("executors")
        .description("Diagnose a queue backlog: starved label, what holds the heavyweight executors, and zombie builds")
        .option("--label <label>", "Agent label of interest (default: auto-detected from the queue reasons)")
        .option("--zombie-mins <n>", "Flag builds running longer than this", "120")
        .option("--urls", "Print build URLs so they can be opened or aborted")
        .option("--no-queue", "Skip the queue read and go straight to the executors")
        .action(async (opts) => {
            const now = Date.now();
            const detected = opts.queue === false ? null : await diagnoseQueue(now);
            await diagnoseExecutors(
                now,
                opts.label ?? detected,
                Number.parseInt(opts.zombieMins, 10),
                opts.urls === true
            );
        });
}
