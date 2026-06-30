import { homedir } from "node:os";
import { out } from "@app/logger";
import { Storage } from "@app/utils/storage/storage";
import type { Command } from "commander";
import { aggregate } from "./aggregate";
import { loadPricing } from "./config";
import { findTranscriptFiles, readEvents } from "./discover";
import { renderSessions, renderSummary, renderToday } from "./render";
import { resolveSince } from "./since";
import type { Report } from "./types";

export interface SpendOpts {
    since?: string;
    model?: string;
    project?: string;
    top?: string;
    json?: boolean;
}

export type SpendView = "summary" | "sessions" | "today";

const DEFAULT_SINCE = "30d";

async function buildReport(opts: SpendOpts, view: SpendView): Promise<Report> {
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

    const parsedTop = opts.top ? Number.parseInt(opts.top, 10) : 10;
    const top = Number.isInteger(parsedTop) && parsedTop > 0 ? parsedTop : 10;
    return aggregate({ events, pricing, now, sinceDay, model: opts.model, project: opts.project, top });
}

function emit(report: Report, opts: SpendOpts, view: SpendView): void {
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

export function addSpendOptions(cmd: Command): Command {
    return cmd
        .option("--since <when>", 'Include events on/after "Nd" or YYYY-MM-DD', DEFAULT_SINCE)
        .option("--model <substr>", "Filter to models containing this substring")
        .option("--project <substr>", "Filter to projects (cwd) containing this substring")
        .option("--top <n>", "Leaderboard length", "10")
        .option("--json", "Emit the Report as JSON to stdout");
}

export async function runSpend(cmd: Command, view: SpendView): Promise<void> {
    // Shared options live on BOTH the root program and each subcommand, so
    // commander treats them as global. The action's plain opts arg therefore
    // omits flags resolved onto the parent — optsWithGlobals() merges them back.
    const opts = cmd.optsWithGlobals() as SpendOpts;
    emit(await buildReport(opts, view), opts, view);
}

export function registerSpendCommand(program: Command): Command {
    addSpendOptions(program).action(async (_opts: SpendOpts, cmd: Command) => {
        await runSpend(cmd, "summary");
    });

    addSpendOptions(program.command("summary").description("Spend summary for the window (default)")).action(
        async (_opts: SpendOpts, cmd: Command) => {
            await runSpend(cmd, "summary");
        }
    );

    addSpendOptions(program.command("sessions").description("Most expensive sessions leaderboard")).action(
        async (_opts: SpendOpts, cmd: Command) => {
            await runSpend(cmd, "sessions");
        }
    );

    addSpendOptions(program.command("today").description("Today's spend (UTC day)")).action(
        async (_opts: SpendOpts, cmd: Command) => {
            await runSpend(cmd, "today");
        }
    );

    return program;
}
