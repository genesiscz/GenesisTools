import { homedir } from "node:os";
import { out } from "@app/logger";
import { runTool } from "@app/utils/cli";
import { Storage } from "@app/utils/storage/storage";
import { Command } from "commander";
import { aggregate } from "./lib/aggregate";
import { loadPricing } from "./lib/config";
import { findTranscriptFiles, readEvents } from "./lib/discover";
import { renderSessions, renderSummary, renderToday } from "./lib/render";
import { resolveSince } from "./lib/since";
import type { Report } from "./lib/types";

interface SharedOpts {
    since?: string;
    model?: string;
    project?: string;
    top?: string;
    json?: boolean;
}

type View = "summary" | "sessions" | "today";

const DEFAULT_SINCE = "30d";

async function buildReport(opts: SharedOpts, view: View): Promise<Report> {
    const now = new Date();
    const storage = new Storage("ai-spend");
    const pricing = await loadPricing(storage);
    const events = readEvents(findTranscriptFiles(homedir()));

    let sinceDay: string | undefined;
    if (view === "today") {
        sinceDay = now.toISOString().slice(0, 10);
    } else {
        sinceDay = resolveSince(opts.since ?? DEFAULT_SINCE, now) ?? resolveSince(DEFAULT_SINCE, now);
    }

    const top = opts.top ? Number.parseInt(opts.top, 10) : 10;
    return aggregate({ events, pricing, now, sinceDay, model: opts.model, project: opts.project, top });
}

function emit(report: Report, opts: SharedOpts, view: View): void {
    if (opts.json) {
        out.result(report);
        return;
    }

    if (view === "sessions") {
        out.println(renderSessions(report));
        return;
    }

    if (view === "today") {
        out.println(renderToday(report));
        return;
    }

    out.println(renderSummary(report));
}

function addSharedOptions(cmd: Command): Command {
    return cmd
        .option("--since <when>", 'Include events on/after "Nd" or YYYY-MM-DD', DEFAULT_SINCE)
        .option("--model <substr>", "Filter to models containing this substring")
        .option("--project <substr>", "Filter to projects (cwd) containing this substring")
        .option("--top <n>", "Leaderboard length", "10")
        .option("--json", "Emit the Report as JSON to stdout");
}

async function run(cmd: Command, view: View): Promise<void> {
    // Shared options live on BOTH the root program and each subcommand, so
    // commander treats them as global. The action's plain opts arg therefore
    // omits flags resolved onto the parent — optsWithGlobals() merges them back.
    const opts = cmd.optsWithGlobals() as SharedOpts;
    emit(await buildReport(opts, view), opts, view);
}

const program = new Command();

program.name("ai-spend").description("Claude Code token & cost analytics across all local sessions");

addSharedOptions(program).action(async (_opts: SharedOpts, cmd: Command) => {
    await run(cmd, "summary");
});

addSharedOptions(program.command("summary").description("Spend summary for the window (default)")).action(
    async (_opts: SharedOpts, cmd: Command) => {
        await run(cmd, "summary");
    }
);

addSharedOptions(program.command("sessions").description("Most expensive sessions leaderboard")).action(
    async (_opts: SharedOpts, cmd: Command) => {
        await run(cmd, "sessions");
    }
);

addSharedOptions(program.command("today").description("Today's spend (UTC day)")).action(
    async (_opts: SharedOpts, cmd: Command) => {
        await run(cmd, "today");
    }
);

await runTool(program, { tool: "ai-spend" });
