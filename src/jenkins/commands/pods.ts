import { out } from "@genesiscz/utils/logger";
import type { Command } from "commander";
import { getJenkinsBackend } from "../lib/rest/client";
import { fmtDuration } from "../lib/rest/wfapi";

interface ComputerSet {
    computer?: Array<{ displayName: string; offline?: boolean; executors?: Array<{ idle?: boolean }> }>;
}

interface Queue {
    items?: Array<{ why?: string; inQueueSince?: number; task?: { name?: string } }>;
}

/** A Kubernetes agent is named `<template>-<5 chars>`; the template groups them. */
export function agentTemplate(displayName: string): string {
    return displayName.replace(/-[a-z0-9]{5}$/, "");
}

export async function cmdPods(): Promise<void> {
    const backend = await getJenkinsBackend();
    const computers = await backend.api<ComputerSet>(
        "computer/api/json?tree=computer[displayName,offline,temporarilyOffline,executors[idle]]"
    );
    const groups = new Map<string, { online: number; busy: number; offline: number }>();

    for (const c of computers.computer ?? []) {
        const template = agentTemplate(c.displayName);
        const g = groups.get(template) ?? { online: 0, busy: 0, offline: 0 };

        if (c.offline) {
            g.offline++;
        } else {
            g.online++;

            if ((c.executors ?? []).some((e) => !e.idle)) {
                g.busy++;
            }
        }

        groups.set(template, g);
    }

    out.println("template                          online  busy  offline");
    out.println("─".repeat(58));

    for (const [t, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
        out.println(
            `${t.padEnd(34)} ${String(g.online).padStart(5)} ${String(g.busy).padStart(5)} ${String(g.offline).padStart(7)}`
        );
    }

    const queue = await backend.api<Queue>("queue/api/json?tree=items[why,inQueueSince,task[name]]");
    const items = queue.items ?? [];
    out.println(`\nQUEUE: ${items.length} item(s)`);
    const byWhy = new Map<string, { n: number; oldest: number; tasks: Set<string> }>();

    for (const item of items) {
        const why = (item.why ?? "?").replace(/[‘’]/g, "'");
        const entry = byWhy.get(why) ?? { n: 0, oldest: Number.POSITIVE_INFINITY, tasks: new Set<string>() };
        entry.n++;
        entry.oldest = Math.min(entry.oldest, item.inQueueSince ?? Number.POSITIVE_INFINITY);

        if (item.task?.name) {
            entry.tasks.add(item.task.name);
        }

        byWhy.set(why, entry);
    }

    for (const [why, e] of [...byWhy].sort((a, b) => b[1].n - a[1].n)) {
        const waited = Number.isFinite(e.oldest) ? fmtDuration(Date.now() - e.oldest) : "?";
        out.println(`  ${String(e.n).padStart(3)}x  ${why}  (oldest waiting ${waited})`);
        out.println(`        ${[...e.tasks].join(", ")}`);
    }
}

export function registerPods(jenkins: Command): void {
    jenkins
        .command("pods")
        .description("Agents by template (busy/idle) + queue wait reasons")
        .action(async () => {
            await cmdPods();
        });
}
