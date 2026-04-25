import { spawn } from "node:child_process";
import logger from "@app/logger";
import type { TimelyService } from "@app/timely/api/service";
import type { OAuth2Tokens, TimelyEntry } from "@app/timely/types";
import { type CategorySuggestion, suggestProjects } from "@app/timely/utils/categorizer";
import { loadEventCorpus } from "@app/timely/utils/event-corpus";
import {
    type BuiltPayload,
    buildPayloadFromFlat,
    flattenMemories,
} from "@app/timely/utils/flatten-memories";
import { fetchMemoriesForDates } from "@app/timely/utils/memories";
import { isInteractive } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import type { Storage } from "@app/utils/storage";
import * as p from "@clack/prompts";
import chalk from "chalk";
import type { Command } from "commander";

interface CreateOptions {
    from?: string;
    to?: string;
    day?: string;
    project?: string;
    note?: string;
    interactive?: boolean;
    dryRun?: boolean;
    chainAdo?: boolean;
}

function buildPayload(memories: TimelyEntry[], day: string, projectId: number, note: string): BuiltPayload {
    return buildPayloadFromFlat(flattenMemories(memories), day, projectId, note);
}

function expandDates(options: CreateOptions): string[] {
    if (options.day) {
        return [options.day];
    }

    if (options.from && options.to) {
        const dates: string[] = [];
        const cur = new Date(options.from);
        const end = new Date(options.to);
        while (cur <= end) {
            dates.push(cur.toISOString().slice(0, 10));
            cur.setDate(cur.getDate() + 1);
        }

        return dates;
    }

    return [];
}

function defaultNote(memories: TimelyEntry[]): string {
    const titles = Array.from(new Set(memories.map((m) => m.title).filter((t): t is string => Boolean(t))));
    return titles.slice(0, 3).join(", ");
}

function fmtDuration(totalSec: number): string {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

async function pickProject(
    service: TimelyService,
    accountId: number,
    date: string,
    suggestions: CategorySuggestion[]
): Promise<number | null> {
    if (suggestions.length === 0) {
        const projects = await service.getProjects(accountId);
        const picked = await p.select({
            message: `${date} — pick project`,
            options: projects.slice(0, 50).map((pr) => ({ value: pr.id, label: pr.name })),
        });
        if (p.isCancel(picked)) {
            return null;
        }

        return picked as number;
    }

    const picked = await p.select({
        message: `${date} — suggested project`,
        options: [
            ...suggestions.map((s) => ({
                value: s.projectId,
                label: `${s.projectName} (score ${s.score.toFixed(2)})`,
                hint: s.reasons.join(" · "),
            })),
            { value: -1, label: "Pick another...", hint: "browse all projects" },
        ],
    });
    if (p.isCancel(picked)) {
        return null;
    }

    if (picked === -1) {
        const projects = await service.getProjects(accountId);
        const browsed = await p.select({
            message: "Pick project",
            options: projects.slice(0, 50).map((pr) => ({ value: pr.id, label: pr.name })),
        });
        if (p.isCancel(browsed)) {
            return null;
        }

        return browsed as number;
    }

    return picked as number;
}

async function runCreate(storage: Storage, service: TimelyService, options: CreateOptions): Promise<void> {
    const accountId = await storage.getConfigValue<number>("selectedAccountId");
    const tokens = await storage.getConfigValue<OAuth2Tokens>("tokens");
    if (!accountId || !tokens?.access_token) {
        logger.error("Not authenticated. Run 'tools timely login' first.");
        process.exit(1);
    }

    const dates = expandDates(options);
    if (dates.length === 0) {
        logger.error("Provide --from/--to or --day");
        process.exit(1);
    }

    const interactive = options.interactive ?? isInteractive();

    p.intro(chalk.cyan(`Timely create — ${dates.length} day(s)`));

    const spin = p.spinner();
    spin.start("Loading memories + 8-week corpus...");
    const [memoriesResult, corpus] = await Promise.all([
        fetchMemoriesForDates({ accountId, accessToken: tokens.access_token, dates, storage }),
        loadEventCorpus(storage, service, accountId),
    ]);
    spin.stop(`Loaded ${memoriesResult.entries.length} memories, ${corpus.length} past entries.`);

    const created: number[] = [];

    for (const date of dates) {
        const dayMemories = memoriesResult.byDate.get(date) ?? [];
        if (dayMemories.length === 0) {
            p.log.info(`${date}: no memories`);
            continue;
        }

        const suggestions = options.project ? [] : suggestProjects(dayMemories, corpus);

        let projectId: number;
        let note = options.note ?? defaultNote(dayMemories);

        if (options.project) {
            projectId = parseInt(options.project, 10);
        } else if (interactive) {
            const picked = await pickProject(service, accountId, date, suggestions);
            if (picked === null) {
                p.cancel("Cancelled.");
                return;
            }

            projectId = picked;

            const editedNote = await p.text({
                message: "Note",
                initialValue: note,
                defaultValue: note,
            });
            if (p.isCancel(editedNote)) {
                p.cancel("Cancelled.");
                return;
            }

            note = editedNote;
        } else {
            if (suggestions.length === 0) {
                logger.error(`${date}: no suggestion + no --project — skipping`);
                continue;
            }

            projectId = suggestions[0].projectId;
        }

        const { input, totalSeconds } = buildPayload(dayMemories, date, projectId, note);

        if (options.dryRun) {
            p.log.info(`${date} DRY-RUN payload:\n${SafeJSON.stringify(input, null, 2)}`);
            continue;
        }

        if (interactive) {
            const ok = await p.confirm({
                message: `Post ${fmtDuration(totalSeconds)} to project ${projectId}?`,
                initialValue: true,
            });
            if (p.isCancel(ok) || !ok) {
                p.log.warn(`${date} skipped`);
                continue;
            }
        }

        const ev = await service.createEvent(accountId, input);
        created.push(ev.id);
        p.log.success(`${date} → event ${ev.id} (${ev.duration.formatted})`);
    }

    p.outro(`Created ${created.length} event(s).`);

    if (options.chainAdo && created.length > 0) {
        for (const date of dates) {
            console.log(chalk.cyan(`\n→ Launching ADO TimeLog for ${date}...`));
            await new Promise<void>((resolve) => {
                const proc = spawn("tools", ["azure-devops", "timelog", "add", "-i", "-d", date], {
                    stdio: "inherit",
                });
                proc.on("exit", () => resolve());
            });
        }
    }
}

export function registerCreateCommand(program: Command, storage: Storage, service: TimelyService): void {
    program
        .command("create")
        .description("Create Timely events from auto-tracked memories (interactive by default)")
        .option("--from <date>", "Start date (YYYY-MM-DD)")
        .option("--to <date>", "End date (YYYY-MM-DD)")
        .option("--day <date>", "Single day")
        .option("-p, --project <id>", "Force project ID (skip categorizer)")
        .option("-n, --note <text>", "Override note (default: derived from memory titles)")
        .option("-i, --interactive", "Interactive mode (default if TTY)")
        .option("--dry-run", "Show payload without posting")
        .option("--chain-ado", "After create, run `tools azure-devops timelog add -i` per day")
        .action(async (options: CreateOptions) => {
            await runCreate(storage, service, options);
        });
}
