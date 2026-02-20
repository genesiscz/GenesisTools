import { getDb } from "@app/automate/lib/db";
import { formatDuration } from "@app/utils/format";
import * as p from "@clack/prompts";
import type { Bot } from "grammy";

export function registerTasksCommand(bot: Bot): void {
    bot.command("tasks", async (ctx) => {
        p.log.step("/tasks → fetching run history");
        const db = getDb();
        const runs = db.listRuns(10);

        if (runs.length === 0) {
            p.log.success("/tasks → no runs");
            await ctx.reply("No runs recorded yet.");
            return;
        }

        const lines = ["Recent runs:", ""];
        for (const r of runs) {
            const status = r.status === "success" ? "OK" : r.status === "error" ? "FAIL" : r.status.toUpperCase();
            const duration = r.duration_ms != null ? formatDuration(r.duration_ms) : "running";
            lines.push(`#${r.id} ${r.preset_name} [${status}] ${duration} (${r.trigger_type})`);
        }

        await ctx.reply(lines.join("\n"));
        p.log.success(`/tasks → replied (${runs.length} runs)`);
    });
}
