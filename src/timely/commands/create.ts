import { readFileSync, writeFileSync } from "node:fs";
import logger from "@app/logger";
import type { TimelyService } from "@app/timely/api/service";
import type { OAuth2Tokens, TimelyEntry } from "@app/timely/types";
import type { CreatePlanV1, PlanIssue } from "@app/timely/types/plan";
import { type CategorySuggestion, suggestProjects } from "@app/timely/utils/categorizer";
import { loadEventCorpus } from "@app/timely/utils/event-corpus";
import { type BuiltPayload, buildPayloadFromFlat, flattenMemories } from "@app/timely/utils/flatten-memories";
import { fetchMemoriesForDates } from "@app/timely/utils/memories";
import { applyPlan, validatePlan } from "@app/timely/utils/plan-apply";
import { buildPlan } from "@app/timely/utils/plan-build";
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
    plan?: boolean;
    out?: string;
    apply?: string;
    yes?: boolean;
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
}

async function runPlan(storage: Storage, service: TimelyService, options: CreateOptions): Promise<void> {
    const accountId = await storage.getConfigValue<number>("selectedAccountId");
    const tokens = await storage.getConfigValue<OAuth2Tokens>("tokens");
    if (!accountId || !tokens?.access_token) {
        logger.error("Not authenticated. Run 'tools timely login' first.");
        process.exit(1);
    }

    const dates = expandDates(options);
    if (dates.length === 0) {
        logger.error("Provide --from/--to or --day with --plan");
        process.exit(1);
    }

    const [memoriesResult, corpus] = await Promise.all([
        fetchMemoriesForDates({ accountId, accessToken: tokens.access_token, dates, storage }),
        loadEventCorpus(storage, service, accountId),
    ]);

    const plan = buildPlan({ memoriesByDate: memoriesResult.byDate, corpus, dates });
    const json = SafeJSON.stringify(plan, null, 2);

    const out = options.out ?? "-";
    if (out === "-") {
        process.stdout.write(`${json}\n`);
    } else {
        writeFileSync(out, `${json}\n`, "utf8");
        logger.info(chalk.green(`✓ Plan written to ${out}`));
        logger.info(
            `  ${plan.days.length} day(s), ${plan.days.reduce((s, d) => s + d.available_memories.length, 0)} memories`
        );
        logger.info("  Edit events[] per day, then: tools timely create --apply " + out + " --dry-run");
    }
}

function readPlanFile(path: string): CreatePlanV1 {
    const text = path === "-" ? readFromStdin() : readFileSync(path, "utf8");
    const parsed = SafeJSON.parse(text);
    return parsed as CreatePlanV1;
}

function readFromStdin(): string {
    const chunks: Buffer[] = [];
    const fd = 0;
    const buf = Buffer.alloc(65_536);
    let n: number;
    do {
        try {
            n = require("node:fs").readSync(fd, buf, 0, buf.length, null);
        } catch {
            break;
        }
        if (n > 0) {
            chunks.push(Buffer.from(buf.subarray(0, n)));
        }
    } while (n > 0);

    return Buffer.concat(chunks).toString("utf8");
}

function printIssues(issues: PlanIssue[]): { errors: number; warnings: number } {
    let errors = 0;
    let warnings = 0;
    for (const issue of issues) {
        const tag = issue.severity === "error" ? chalk.red("✗") : chalk.yellow("!");
        const where = issue.eventIdx !== undefined ? `${issue.day}#${issue.eventIdx}` : issue.day;
        console.log(`${tag} ${where}: ${issue.message}`);
        if (issue.severity === "error") {
            errors++;
        } else {
            warnings++;
        }
    }

    return { errors, warnings };
}

async function runApply(storage: Storage, service: TimelyService, options: CreateOptions): Promise<void> {
    const accountId = await storage.getConfigValue<number>("selectedAccountId");
    const tokens = await storage.getConfigValue<OAuth2Tokens>("tokens");
    if (!accountId || !tokens?.access_token) {
        logger.error("Not authenticated. Run 'tools timely login' first.");
        process.exit(1);
    }

    const path = options.apply!;
    const plan = readPlanFile(path);

    const issues = validatePlan(plan);
    const { errors, warnings } = printIssues(issues);
    if (errors > 0) {
        logger.error(`Plan has ${errors} error(s). Fix and retry.`);
        process.exit(1);
    }

    const interactive = isInteractive();
    if (warnings > 0 && interactive && !options.yes) {
        const ok = await p.confirm({ message: `${warnings} warning(s). Proceed?`, initialValue: false });
        if (p.isCancel(ok) || !ok) {
            logger.info("Cancelled.");
            return;
        }
    }

    const results = await applyPlan({
        plan,
        service,
        storage,
        accountId,
        accessToken: tokens.access_token,
        dryRun: options.dryRun ?? false,
        onPayload: (day, idx, payload) => {
            console.log(chalk.dim(`\n--- ${day} event #${idx} ---`));
            console.log(SafeJSON.stringify(payload, null, 2));
        },
    });

    let created = 0;
    let failed = 0;
    for (const r of results) {
        if (r.error) {
            console.log(chalk.red(`✗ ${r.day}#${r.eventIdx} [proj ${r.project_id}]: ${r.error}`));
            failed++;
        } else if (options.dryRun) {
            console.log(
                chalk.cyan(
                    `◯ ${r.day}#${r.eventIdx} [proj ${r.project_id}] DRY ${r.duration} (${r.memoryCount} memories)`
                )
            );
        } else {
            console.log(
                chalk.green(
                    `✓ ${r.day}#${r.eventIdx} [proj ${r.project_id}] event ${r.eventId} (${r.duration}, ${r.memoryCount} memories)`
                )
            );
            created++;
        }
    }

    if (options.dryRun) {
        logger.info(`Dry-run complete: ${results.length} event(s) would be created.`);
    } else {
        logger.info(`Created ${created} event(s)${failed > 0 ? `, ${failed} failed` : ""}.`);
        if (failed > 0) {
            process.exit(1);
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
        .option("--dry-run", "Show payload without posting (works with create + apply)")
        .option("--plan", "Generate a JSON plan instead of posting (LLM-friendly)")
        .option("--out <path>", "Output path for --plan (default: stdout)", "-")
        .option("--apply <path>", "Apply a plan JSON file (use - for stdin)")
        .option("--yes", "Skip warning confirmation when applying")
        .action(async (options: CreateOptions) => {
            const modes = [options.plan, !!options.apply].filter(Boolean).length;
            if (modes > 1) {
                logger.error("--plan and --apply are mutually exclusive");
                process.exit(1);
            }

            if (options.plan) {
                await runPlan(storage, service, options);
                return;
            }

            if (options.apply) {
                await runApply(storage, service, options);
                return;
            }

            await runCreate(storage, service, options);
        });
}
