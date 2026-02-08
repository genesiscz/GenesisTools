import { Command } from "commander";
import { z } from "zod";
import { Storage } from "@app/utils/storage";
import { formatMinutes, convertToMinutes } from "@app/azure-devops/timelog-api";
import { requireTimeLogConfig } from "@app/azure-devops/utils";
import { precheckWorkItem } from "@app/azure-devops/workitem-precheck";
import type { AllowedTypeConfig } from "@app/azure-devops/types";

// ============= Schema & Types =============

const TimelogEntrySchema = z.object({
    workItemId: z.number().int().positive(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hours: z.number().min(0).optional(),
    minutes: z.number().int().min(0).optional(),
    timeType: z.string().min(1),
    comment: z.string().optional().default(""),
}).refine(
    (d) => d.hours !== undefined || d.minutes !== undefined,
    { message: "Either hours or minutes must be provided" }
);

type TimelogEntryInput = z.infer<typeof TimelogEntrySchema>;

interface StoredEntry {
    _id: string;
    _status: "pending";
    workItemId: number;
    date: string;
    hours?: number;
    minutes?: number;
    timeType: string;
    comment: string;
}

interface PrepareImportFile {
    name: string;
    createdAt: string;
    entries: StoredEntry[];
}

// ============= Helpers =============

const storage = new Storage("azure-devops");

function resolveFileName(options: { from?: string; to?: string; name?: string }): string {
    if (options.name) {
        return options.name;
    }

    if (options.from && options.to) {
        return `${options.from}.${options.to}`;
    }

    throw new Error("Either --name or both --from and --to must be provided");
}

function cacheKey(name: string): string {
    return `prepare-import/${name}.json`;
}

function computeTotalMinutes(entry: StoredEntry): number {
    const h = entry.hours ?? 0;
    const m = entry.minutes ?? 0;
    return h * 60 + m;
}

function printEntry(entry: StoredEntry): void {
    const totalMin = computeTotalMinutes(entry);
    const parts = [
        `#${entry.workItemId}`,
        formatMinutes(totalMin),
        entry.timeType,
        entry.date,
    ];

    if (entry.comment) {
        parts.push(entry.comment);
    }

    parts.push(`[${entry._id.substring(0, 8)}]`);
    console.log(`  ${parts.join(" | ")}`);
}

// ============= Subcommand Actions =============

async function handleAdd(options: {
    from?: string;
    to?: string;
    name?: string;
    entry: string;
}): Promise<void> {
    const fileName = resolveFileName(options);

    // Parse and validate entry JSON
    let rawEntry: unknown;

    try {
        rawEntry = JSON.parse(options.entry);
    } catch {
        console.error("Invalid JSON in --entry");
        process.exit(1);
    }

    const parseResult = TimelogEntrySchema.safeParse(rawEntry);

    if (!parseResult.success) {
        console.error("Validation errors:");

        for (const issue of parseResult.error.issues) {
            console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
        }

        process.exit(1);
    }

    const validated: TimelogEntryInput = parseResult.data;

    // Validate time converts properly
    try {
        convertToMinutes(validated.hours, validated.minutes);
    } catch (e) {
        console.error((e as Error).message);
        process.exit(1);
    }

    // Precheck work item
    const config = requireTimeLogConfig();
    const allowedTypeConfig: AllowedTypeConfig | undefined =
        config.timelog?.allowedWorkItemTypes?.length
            ? {
                  allowedWorkItemTypes: config.timelog.allowedWorkItemTypes,
                  allowedStatesPerType: config.timelog.allowedStatesPerType,
              }
            : undefined;

    const precheck = await precheckWorkItem(validated.workItemId, config.org, allowedTypeConfig);

    let effectiveWorkItemId = validated.workItemId;

    if (precheck.status === "error") {
        console.error(`Precheck failed for #${validated.workItemId}: ${precheck.message}`);

        if (precheck.suggestCommands?.length) {
            console.error("\nSuggested commands:");

            for (const cmd of precheck.suggestCommands) {
                console.error(`  ${cmd}`);
            }
        }

        process.exit(1);
    }

    if (precheck.status === "redirect") {
        console.log(`Warning: ${precheck.message}`);
        effectiveWorkItemId = precheck.redirectId!;
    }

    // Build stored entry
    const storedEntry: StoredEntry = {
        _id: crypto.randomUUID(),
        _status: "pending",
        workItemId: effectiveWorkItemId,
        date: validated.date,
        hours: validated.hours,
        minutes: validated.minutes,
        timeType: validated.timeType,
        comment: validated.comment ?? "",
    };

    // Atomic append
    await storage.atomicUpdate<PrepareImportFile>(cacheKey(fileName), (current) => {
        if (current) {
            return { ...current, entries: [...current.entries, storedEntry] };
        }

        return {
            name: fileName,
            createdAt: new Date().toISOString(),
            entries: [storedEntry],
        };
    });

    console.log("Entry added:");
    printEntry(storedEntry);
}

async function handleRemove(options: {
    name: string;
    id: string;
}): Promise<void> {
    const key = cacheKey(options.name);

    const updated = await storage.atomicUpdate<PrepareImportFile>(key, (current) => {
        if (!current) {
            throw new Error(`No prepare-import file found with name "${options.name}"`);
        }

        const filtered = current.entries.filter((e) => e._id !== options.id);

        if (filtered.length === current.entries.length) {
            throw new Error(`Entry with ID "${options.id}" not found in "${options.name}"`);
        }

        return { ...current, entries: filtered };
    });

    console.log(`Entry ${options.id} removed. ${updated.entries.length} entries remaining.`);
}

async function handleList(options: {
    name: string;
    format?: string;
}): Promise<void> {
    const key = cacheKey(options.name);
    const data = await storage.getCacheFile<PrepareImportFile>(key, "30 days");

    if (!data) {
        console.error(`No prepare-import file found with name "${options.name}"`);
        process.exit(1);
    }

    if (options.format === "json") {
        console.log(JSON.stringify(data, null, 2));
        return;
    }

    // Table format (default)
    console.log(`Prepare-import: ${data.name}`);
    console.log(`Created: ${data.createdAt}`);
    console.log(`Entries: ${data.entries.length}\n`);

    if (data.entries.length === 0) {
        console.log("  (no entries)");
        return;
    }

    // Print entries
    for (const entry of data.entries) {
        printEntry(entry);
    }

    // Totals per day
    const dailyTotals = new Map<string, number>();
    const workitemTotals = new Map<number, number>();

    for (const entry of data.entries) {
        const mins = computeTotalMinutes(entry);
        dailyTotals.set(entry.date, (dailyTotals.get(entry.date) ?? 0) + mins);
        workitemTotals.set(entry.workItemId, (workitemTotals.get(entry.workItemId) ?? 0) + mins);
    }

    console.log("\nTotals per day:");

    const sortedDays = [...dailyTotals.entries()].sort(([a], [b]) => a.localeCompare(b));

    for (const [day, mins] of sortedDays) {
        console.log(`  ${day}: ${formatMinutes(mins)}`);
    }

    console.log("\nTotals per work item:");

    const sortedItems = [...workitemTotals.entries()].sort(([a], [b]) => a - b);

    for (const [id, mins] of sortedItems) {
        console.log(`  #${id}: ${formatMinutes(mins)}`);
    }

    const grandTotal = [...dailyTotals.values()].reduce((sum, m) => sum + m, 0);
    console.log(`\nGrand total: ${formatMinutes(grandTotal)}`);
}

async function handleClear(options: { name: string }): Promise<void> {
    const key = cacheKey(options.name);
    await storage.deleteCacheFile(key);
    console.log(`Prepare-import file "${options.name}" cleared.`);
}

// ============= Registration =============

export function registerPrepareImportSubcommand(parent: Command): void {
    const prepareImport = parent
        .command("prepare-import")
        .description("Build import files incrementally with validation");

    prepareImport
        .command("add")
        .description("Add a validated entry to a prepare-import file")
        .option("--from <date>", "Start date (YYYY-MM-DD), used to derive file name")
        .option("--to <date>", "End date (YYYY-MM-DD), used to derive file name")
        .option("--name <name>", "Explicit file name (overrides --from/--to)")
        .requiredOption("--entry <json>", "Entry JSON (see schema)")
        .action(async (opts: { from?: string; to?: string; name?: string; entry: string }) => {
            try {
                await handleAdd(opts);
            } catch (e) {
                console.error((e as Error).message);
                process.exit(1);
            }
        });

    prepareImport
        .command("remove")
        .description("Remove an entry by UUID from a prepare-import file")
        .requiredOption("--name <name>", "File name")
        .requiredOption("--id <uuid>", "Entry UUID to remove")
        .action(async (opts: { name: string; id: string }) => {
            try {
                await handleRemove(opts);
            } catch (e) {
                console.error((e as Error).message);
                process.exit(1);
            }
        });

    prepareImport
        .command("list")
        .description("List entries in a prepare-import file")
        .requiredOption("--name <name>", "File name")
        .option("--format <format>", "Output format: json | table", "table")
        .action(async (opts: { name: string; format?: string }) => {
            try {
                await handleList(opts);
            } catch (e) {
                console.error((e as Error).message);
                process.exit(1);
            }
        });

    prepareImport
        .command("clear")
        .description("Delete a prepare-import file entirely")
        .requiredOption("--name <name>", "File name to clear")
        .action(async (opts: { name: string }) => {
            try {
                await handleClear(opts);
            } catch (e) {
                console.error((e as Error).message);
                process.exit(1);
            }
        });
}
