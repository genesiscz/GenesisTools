import { existsSync } from "node:fs";
import { join } from "node:path";
import type { SavedCommand, SavedCommandInput } from "@app/dev-dashboard/lib/commands/types";
import { getDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { logger } from "@app/logger";
import { SafeJSON } from "@app/utils/json";

function commandsFilePath(): string {
    return join(getDevDashboardStorage().getBaseDir(), "commands.json");
}

/** Trim + reject empty label/command. Pure — no I/O. The only validation surface. */
export function validateCommandInput(input: SavedCommandInput): SavedCommandInput {
    const label = input.label?.trim() ?? "";
    const command = input.command?.trim() ?? "";

    if (!label) {
        throw new Error("Command label is required");
    }

    if (!command) {
        throw new Error("Command text is required");
    }

    return { label, command };
}

/** Stable-enough unique id (sortable prefix + random suffix). Pure. */
export function makeCommandId(): string {
    return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readAll(): Promise<SavedCommand[]> {
    const path = commandsFilePath();

    if (!existsSync(path)) {
        return [];
    }

    try {
        const raw = await Bun.file(path).text();
        const parsed = SafeJSON.parse(raw, { strict: true });
        return Array.isArray(parsed) ? (parsed as SavedCommand[]) : [];
    } catch (err) {
        logger.warn({ error: err, path }, "dev-dashboard commands: commands.json unreadable; treating as empty");
        return [];
    }
}

async function writeAll(commands: SavedCommand[]): Promise<void> {
    await getDevDashboardStorage().ensureDirs();
    await Bun.write(commandsFilePath(), SafeJSON.stringify(commands, null, 2));
}

export async function listCommands(): Promise<SavedCommand[]> {
    return readAll();
}

export async function addCommand(input: SavedCommandInput): Promise<SavedCommand> {
    const clean = validateCommandInput(input);
    const command: SavedCommand = { id: makeCommandId(), ...clean };
    const all = await readAll();
    all.push(command);
    await writeAll(all);
    logger.debug({ id: command.id, label: command.label }, "dev-dashboard commands: added snippet");
    return command;
}

export async function deleteCommand(id: string): Promise<number> {
    const all = await readAll();
    const next = all.filter((c) => c.id !== id);
    const removed = all.length - next.length;

    if (removed > 0) {
        await writeAll(next);
    }

    logger.debug({ id, removed }, "dev-dashboard commands: delete snippet");
    return removed;
}
