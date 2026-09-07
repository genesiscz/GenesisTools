import {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readdirSync,
    readFileSync,
    renameSync,
    statSync,
    writeFileSync,
    writeSync,
} from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const MAX_JOURNAL_BYTES = 1024 * 1024;
const recordSchema = z.object({
    version: z.literal(1),
    surfaceId: z.string().uuid(),
    stableSurfaceId: z.string().uuid().optional(),
    workspaceId: z.string().uuid().optional(),
    command: z.string().min(1).max(65536),
    cwd: z.string().startsWith("/"),
    phase: z.enum(["running", "completed"]),
    exitStatus: z.number().int().min(0).max(255).optional(),
    atMs: z.number().finite().nonnegative(),
});

export type CapturedCommand = z.infer<typeof recordSchema>;

export function captureJournalDirectory(): string {
    return join(env.tools.getHome(), ".genesis-tools", "cmux", "command-journal");
}

/** One owning shell per surface writes synchronously before the command starts. */
export function recordCapturedCommand(
    input: Omit<CapturedCommand, "version" | "atMs"> & {
        atMs?: number;
        directory?: string;
    }
): void {
    const record = recordSchema.parse({ ...input, version: 1, atMs: input.atMs ?? Date.now() });
    record.surfaceId = record.surfaceId.toLowerCase();
    record.stableSurfaceId = record.stableSurfaceId?.toLowerCase();
    const directory = input.directory ?? captureJournalDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (record.stableSurfaceId) {
        associateCapturedSurface({ directory, surfaceId: record.surfaceId, stableSurfaceId: record.stableSurfaceId });
    }
    const path = join(directory, `${record.stableSurfaceId ?? record.surfaceId}.jsonl`);
    const encoded = `${SafeJSON.stringify(record)}\n`;

    if (existsSync(path) && statSync(path).size + Buffer.byteLength(encoded) > MAX_JOURNAL_BYTES) {
        renameSync(path, `${path}.previous`);
    }

    const fd = openSync(path, "a", 0o600);
    try {
        const bytes = Buffer.from(encoded);
        let offset = 0;
        while (offset < bytes.length) {
            const written = writeSync(fd, bytes, offset, bytes.length - offset);
            if (written === 0) {
                throw new Error("Unable to append the complete capture record");
            }
            offset += written;
        }
        fsyncSync(fd);
    } finally {
        closeSync(fd);
    }
}

function journalLines(name: string, text: string): string[] {
    if (!name.includes(".shell")) {
        return text.split("\n");
    }
    const fields = text.split("\0");
    const lines: string[] = [];
    for (let index = 0; index + 9 < fields.length; index++) {
        if (
            fields[index] !== "1" ||
            !z
                .string()
                .uuid()
                .safeParse(fields[index + 1]).success ||
            !["running", "completed"].includes(fields[index + 2])
        ) {
            continue;
        }
        const parsed = recordSchema.safeParse({
            version: 1,
            surfaceId: fields[index + 1],
            phase: fields[index + 2],
            cwd: fields[index + 3],
            workspaceId: fields[index + 4] || undefined,
            exitStatus: fields[index + 5] ? Number(fields[index + 5]) : undefined,
            atMs: Number(fields[index + 6]) * 1000,
            command: fields[index + 8],
        });
        if (parsed.success && Buffer.byteLength(parsed.data.command) === Number(fields[index + 7])) {
            lines.push(SafeJSON.stringify(parsed.data));
            index += 8;
        }
    }
    return lines;
}

/** Cutoff prevents a reused surface from leaking a post-restart command into an old autosave. */
export function loadCapturedCommands(
    options: { directory?: string; beforeMs?: number } = {}
): Map<string, CapturedCommand> {
    const directory = options.directory ?? captureJournalDirectory();
    const records = new Map<string, CapturedCommand>();
    const aliases = new Map<string, string | undefined>();

    if (!existsSync(directory)) {
        return records;
    }

    for (const name of readdirSync(directory)
        .filter((name) => /^[a-f\d-]+\.(?:jsonl|shell)(?:\.previous)?$/.test(name))
        .sort()
        .reverse()) {
        const path = join(directory, name);
        try {
            for (const line of journalLines(name, readFileSync(path, "utf8"))) {
                if (!line) {
                    continue;
                }

                try {
                    const record = recordSchema.parse(SafeJSON.parse(line, { strict: true }));
                    const runtimeId = record.surfaceId.toLowerCase();
                    if (!record.stableSurfaceId && !aliases.has(runtimeId)) {
                        aliases.set(runtimeId, undefined);
                        const alias = join(directory, `${runtimeId}.identity`);
                        try {
                            const parsed = existsSync(alias)
                                ? z.string().uuid().safeParse(readFileSync(alias, "utf8").trim())
                                : undefined;
                            aliases.set(runtimeId, parsed?.success ? parsed.data.toLowerCase() : undefined);
                        } catch (error) {
                            logger.debug({ error, alias }, "[cmux-capture] identity alias unavailable");
                        }
                    }
                    const stableId = record.stableSurfaceId ?? aliases.get(runtimeId);
                    record.stableSurfaceId = stableId;
                    for (const id of [stableId, record.surfaceId]) {
                        if (!id) {
                            continue;
                        }

                        const key = id.toLowerCase();
                        const prior = records.get(key);
                        if (record.atMs <= (options.beforeMs ?? Infinity) && (!prior || record.atMs >= prior.atMs)) {
                            records.set(key, record);
                        }
                    }
                } catch (error) {
                    logger.warn({ error, path }, "[cmux-capture] ignored invalid command journal entry");
                }
            }
        } catch (error) {
            logger.warn({ error, path }, "[cmux-capture] could not read command journal");
        }
    }

    return records;
}

export function associateCapturedSurface(input: {
    directory?: string;
    surfaceId: string;
    stableSurfaceId: string;
}): void {
    const surfaceId = z.string().uuid().parse(input.surfaceId).toLowerCase();
    const stableId = z.string().uuid().parse(input.stableSurfaceId).toLowerCase();
    const directory = input.directory ?? captureJournalDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const alias = join(directory, `${surfaceId}.identity`);
    if (!existsSync(alias) || readFileSync(alias, "utf8") !== stableId) {
        writeFileSync(alias, stableId, { mode: 0o600 });
    }
}
