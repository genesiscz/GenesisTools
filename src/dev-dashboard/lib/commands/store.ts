import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SavedCommand, SavedCommandInput } from "@app/dev-dashboard/lib/commands/types";
import { getDevDashboardStorage } from "@app/dev-dashboard/lib/storage";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { atomicWriteFileSync } from "@genesiscz/utils/storage/storage";

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

type CommandsFile = { state: "ok"; commands: SavedCommand[] } | { state: "unreadable"; path: string; error: unknown };

function readCommandsFile(): CommandsFile {
    const path = commandsFilePath();
    let raw: string;

    try {
        raw = readFileSync(path, "utf8");
    } catch (err) {
        if (err instanceof Error && "code" in err && err.code === "ENOENT") {
            return { state: "ok", commands: [] };
        }

        return { state: "unreadable", path, error: err };
    }

    try {
        const parsed = SafeJSON.parse(raw, { strict: true });

        if (!Array.isArray(parsed)) {
            return { state: "unreadable", path, error: new Error("expected a JSON array") };
        }

        return { state: "ok", commands: parsed };
    } catch (err) {
        return { state: "unreadable", path, error: err };
    }
}

/** For display: an unreadable file lists as empty, with a warning. */
function readAll(): SavedCommand[] {
    const file = readCommandsFile();

    if (file.state === "unreadable") {
        logger.warn(
            { error: file.error, path: file.path },
            "dev-dashboard commands: commands.json unreadable; listing none"
        );
        return [];
    }

    return file.commands;
}

/** For a rewrite: an unreadable file is refused, never replaced by the one command being added. */
function readAllForUpdate(): SavedCommand[] {
    const file = readCommandsFile();

    if (file.state === "unreadable") {
        throw new Error(`Saved commands file ${file.path} is unreadable, so it was left untouched. Fix or move it.`, {
            cause: file.error,
        });
    }

    return file.commands;
}

function writeAll(commands: SavedCommand[]): void {
    atomicWriteFileSync(commandsFilePath(), SafeJSON.stringify(commands, null, 2));
}

export async function listCommands(): Promise<SavedCommand[]> {
    return readAll();
}

export async function addCommand(input: SavedCommandInput): Promise<SavedCommand> {
    const clean = validateCommandInput(input);
    const command: SavedCommand = { id: makeCommandId(), ...clean };
    const all = readAllForUpdate();
    all.push(command);
    writeAll(all);
    logger.debug({ id: command.id, label: command.label }, "dev-dashboard commands: added snippet");
    return command;
}

export async function deleteCommand(id: string): Promise<number> {
    const all = readAllForUpdate();
    const next = all.filter((c) => c.id !== id);
    const removed = all.length - next.length;

    if (removed > 0) {
        writeAll(next);
    }

    logger.debug({ id, removed }, "dev-dashboard commands: delete snippet");
    return removed;
}
