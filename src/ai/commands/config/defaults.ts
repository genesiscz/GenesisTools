import { AiConfigStore } from "@genesiscz/utils/ai/config/AiConfigStore";
import { accountRefIn, refToId } from "@genesiscz/utils/ai/config/refs";
import { type AiConfigData, accountRefSchema, isTaskName, TASK_NAMES } from "@genesiscz/utils/ai/config/schema";
import { out } from "@genesiscz/utils/logger";
import { createBoxTable, renderCliHeader, truncateDisplay } from "@genesiscz/utils/table";
import type { Command } from "commander";
import pc from "picocolors";

/**
 * `tools ai config default ...` — which model or account answers a task, either
 * globally or for one app.
 */

interface DefaultRow {
    scope: string;
    task: string;
    value: string;
}

function rowsFor(config: AiConfigData): DefaultRow[] {
    const rows: DefaultRow[] = [];

    for (const [task, ref] of Object.entries(config.defaults.account ?? {})) {
        rows.push({ scope: "global", task, value: ref });
    }

    for (const [task, entry] of Object.entries(config.defaults.task ?? {})) {
        const value = [entry?.provider, entry?.model].filter(Boolean).join(" · ");
        if (value) {
            rows.push({ scope: "global", task, value });
        }
    }

    for (const [app, defaults] of Object.entries(config.defaults.app ?? {})) {
        for (const task of TASK_NAMES) {
            const entry = defaults?.[task];
            const value = [entry?.provider, entry?.model].filter(Boolean).join(" · ");
            if (value) {
                rows.push({ scope: app, task, value });
            }
        }
    }

    return rows;
}

/** Resolve an account ref to a name for display; leave anything else alone. */
function labelValue(config: AiConfigData, value: string): string {
    const ref = accountRefIn(value);
    if (!ref) {
        return value;
    }

    const account = config.accounts.find((entry) => entry.id === refToId(ref));
    return account ? `${value} ${pc.dim(`(${account.name})`)}` : `${value} ${pc.red("(dangling)")}`;
}

export async function cmdDefaultSet(
    task: string,
    modelRef: string,
    flags: { app?: string; provider?: string }
): Promise<void> {
    if (!isTaskName(task)) {
        throw new Error(`Unknown task "${task}". Known tasks: ${TASK_NAMES.join(", ")}.`);
    }

    const store = await AiConfigStore.load();

    // An embedded account ref that names nothing would be a dangling link the
    // moment it is written, so it is refused here rather than reported by doctor.
    const embedded = accountRefIn(modelRef);
    if (embedded && !store.data().accounts.some((entry) => entry.id === refToId(embedded))) {
        throw new Error(`"${modelRef}" names account ${refToId(embedded)}, which does not exist.`);
    }

    const pureAccountRef = accountRefSchema.safeParse(modelRef).success;
    let written = "";

    const provider = flags.provider ? { provider: flags.provider } : {};

    await store.mutate((config) => {
        if (flags.app) {
            const existing = config.defaults.app?.[flags.app] ?? {};
            config.defaults.app = {
                ...(config.defaults.app ?? {}),
                [flags.app]: { ...existing, [task]: { ...(existing[task] ?? {}), ...provider, model: modelRef } },
            };
            written = `defaults.app.${flags.app}.${task}`;
            return;
        }

        // A bare account ref belongs in defaults.account, which is the typed slot
        // for "this account answers this task"; anything with a model in it is a
        // model default and belongs in defaults.task.
        if (pureAccountRef && !flags.provider) {
            config.defaults.account = { ...(config.defaults.account ?? {}), [task]: modelRef };
            written = `defaults.account.${task}`;
            return;
        }

        config.defaults.task = {
            ...(config.defaults.task ?? {}),
            [task]: { ...(config.defaults.task?.[task] ?? {}), ...provider, model: modelRef },
        };
        written = `defaults.task.${task}`;
    });

    out.log.success(`Set ${pc.bold(written)} = ${modelRef}`);
}

export async function cmdDefaultList(flags: { json?: boolean }): Promise<void> {
    const store = await AiConfigStore.load();
    const config = store.data();
    const rows = rowsFor(config);

    if (flags.json) {
        out.result(rows);
        return;
    }

    if (rows.length === 0) {
        out.log.info("No defaults configured. Set one with: tools ai config default set chat @account/<id>");
        return;
    }

    renderCliHeader("AI Defaults", `${rows.length} entries`);
    const table = createBoxTable(["SCOPE", "TASK", "MODEL / ACCOUNT"]);
    for (const row of rows) {
        table.push([
            row.scope === "global" ? pc.dim("global") : pc.cyan(row.scope),
            row.task,
            truncateDisplay(labelValue(config, row.value), 52),
        ]);
    }

    out.println(table.toString());
}

export function registerDefaultCommands(config: Command): void {
    const defaults = config.command("default").description("Which model or account answers each task");

    defaults
        .command("set")
        .description("Point a task at a model ref or an account ref")
        .argument("<task>", `One of: ${TASK_NAMES.join(", ")}`)
        .argument("<modelRef>", 'Model id, "@account/<id>", or "@account/<id>:<model>"')
        .option("--app <app>", "Scope the default to one app instead of globally")
        .option("--provider <id>", "Also pin the provider for this task")
        .action(async (task: string, modelRef: string, flags: { app?: string; provider?: string }) => {
            await cmdDefaultSet(task, modelRef, flags);
        });

    defaults
        .command("list")
        .description("Show every configured default")
        .option("--json", "Emit JSON")
        .action(async (flags: { json?: boolean }) => {
            await cmdDefaultList(flags);
        });
}
