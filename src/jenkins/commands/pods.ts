import { out } from "@genesiscz/utils/logger";
import { createBoxTable } from "@genesiscz/utils/table";
import type { Command } from "commander";
import { type ComputerSet, groupAgents, type QueueItem, queueReasons } from "../lib/rest/capacity";
import { getJenkinsBackend } from "../lib/rest/client";
import { fmtDuration } from "../lib/rest/wfapi";

export async function cmdPods(): Promise<void> {
    const backend = await getJenkinsBackend();
    const computers = await backend.api<ComputerSet>(
        "computer/api/json?tree=computer[displayName,offline,temporarilyOffline,executors[idle]]"
    );
    const table = createBoxTable(["template", "online", "busy", "offline"]);

    for (const group of groupAgents(computers)) {
        table.push([group.template, group.online, group.busy, group.offline]);
    }

    out.println(table.toString());

    const queue = await backend.api<{ items?: QueueItem[] }>("queue/api/json?tree=items[why,inQueueSince,task[name]]");
    const items = queue.items ?? [];
    out.println(`\nQUEUE: ${items.length} item(s)`);

    for (const reason of queueReasons(items)) {
        const waited = reason.oldestSince === null ? "?" : fmtDuration(Date.now() - reason.oldestSince);
        out.println(`  ${String(reason.count).padStart(3)}x  ${reason.why}  (oldest waiting ${waited})`);
        out.println(`        ${reason.tasks.join(", ")}`);
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
