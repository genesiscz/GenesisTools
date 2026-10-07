/**
 * Why is the queue backed up? Jenkins has two kinds of executors and conflating
 * them is the usual wrong turn: flyweight executors run a pipeline's Groovy and
 * are effectively unlimited, so hundreds of builds can read as "running" while
 * parked at a node() step. Only heavyweight executors (the machines the
 * busy/total counts describe) are scarce, and the parked requests ARE the queue.
 *
 * So this separates the two, names the starved label, lists what is holding a
 * matching executor longest-first, and flags zombies: builds far past their
 * estimate that pin an executor until someone aborts them. The diagnosis itself
 * lives in lib/rest/capacity.ts; this command fetches and renders it.
 */

import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import {
    type ComputerSet,
    diagnoseExecutors,
    diagnoseQueue,
    type QueueItem,
    TREE_COMPUTER,
    TREE_QUEUE,
} from "../lib/rest/capacity";
import { getJenkinsBackend } from "../lib/rest/client";
import { fmtDuration } from "../lib/rest/wfapi";

async function renderQueue(now: number): Promise<string | null> {
    const backend = await getJenkinsBackend();
    const data = await backend.api<{ items?: QueueItem[] }>(`queue/api/json?tree=${TREE_QUEUE}`);
    const queue = diagnoseQueue(data.items ?? []);
    out.println(`QUEUE: ${queue.total} item(s) waiting\n`);

    if (queue.total === 0) {
        out.println("  (queue is empty, no backlog right now)\n");

        return null;
    }

    out.println("  reasons:");

    for (const { why, count } of queue.reasons) {
        out.println(`    ${String(count).padStart(4)}x  ${why}`);
    }

    if (queue.stuck > 0) {
        out.println(`\n  ${queue.stuck} flagged stuck (Jenkins thinks they may never schedule)`);
    }

    if (queue.oldestSince !== null) {
        out.println(`\n  oldest item waiting: ${fmtDuration(now - queue.oldestSince)}`);
    }

    if (queue.starvedLabel) {
        out.println(`  => starved label appears to be: ${queue.starvedLabel}`);
    }

    out.println("\n  queued task types (top):");

    for (const { name, count } of queue.tasks.slice(0, 8)) {
        out.println(`    ${String(count).padStart(4)}x  ${name}`);
    }

    out.println("");

    return queue.starvedLabel;
}

async function renderExecutors({
    now,
    wantLabel,
    zombieMins,
    showUrls,
}: {
    now: number;
    wantLabel: string | null;
    zombieMins: number;
    showUrls: boolean;
}): Promise<void> {
    const backend = await getJenkinsBackend();
    const data = await backend.api<ComputerSet>(`computer/api/json?tree=${TREE_COMPUTER}`);
    const diagnosis = diagnoseExecutors(data, { now, wantLabel, zombieMins });
    out.println(
        `EXECUTORS: total=${diagnosis.total}  busy=${diagnosis.busy}  ` +
            "(heavyweight pool; flyweight pipeline tasks are NOT counted here)\n"
    );

    if (diagnosis.wanted) {
        out.println(
            `  label '${diagnosis.wanted.label}': busy=${diagnosis.wanted.busy}  idle=${diagnosis.wanted.idle}`
        );
    }

    out.println("  idle heavyweight executors by label (idle on the WRONG label cannot drain a label-specific queue):");

    for (const { label, count } of diagnosis.idleByLabel) {
        out.println(`    ${String(count).padStart(3)} idle  ${label}`);
    }

    out.println(
        `\n  ${wantLabel ? `HOLDING a '${wantLabel}' executor` : "HOLDING an executor"} (longest-running first):`
    );

    for (const h of diagnosis.holders) {
        const over = h.estMin && h.elapsedMin > h.estMin ? "  <-- OVER EST" : "";
        out.println(`    ${String(h.elapsedMin).padStart(9)} min  est=${h.estMin ?? "?"}${over}  ${h.name}`);

        if (showUrls && h.url) {
            out.println(`               ${h.url}`);
        }
    }

    if (diagnosis.zombies.length === 0) {
        out.println(`\n  no builds running longer than ${zombieMins} min.`);

        return;
    }

    out.println(`\n  ZOMBIES (running > ${zombieMins} min, likely hung, pinning an executor until aborted):`);

    for (const z of diagnosis.zombies) {
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
            const detected = opts.queue === false ? null : await renderQueue(now);
            await renderExecutors({
                now,
                wantLabel: opts.label ?? detected,
                zombieMins: Number.parseInt(opts.zombieMins, 10),
                showUrls: opts.urls === true,
            });
        });
}
