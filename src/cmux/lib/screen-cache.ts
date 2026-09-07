import {
    copyFileSync,
    existsSync,
    mkdirSync,
    readdirSync,
    readFileSync,
    renameSync,
    rmSync,
    statSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { stripAnsi } from "@genesiscz/utils/string";
import { z } from "zod";

const schema = z.object({
    surfaceId: z.string().uuid(),
    stableSurfaceId: z.string().uuid().optional(),
    text: z.string().max(200_000),
    atMs: z.number().finite().nonnegative(),
});
export type SavedSurfaceScreen = z.infer<typeof schema>;

export function preferredScreenText(nativeText: string | undefined, cachedText: string | undefined): string {
    return stripAnsi(nativeText ?? "").trimEnd() || stripAnsi(cachedText ?? "").trimEnd();
}

export function screenCacheDirectory(): string {
    return join(env.tools.getHome(), ".genesis-tools", "cmux", "screens");
}

function writeAtomic(path: string, text: string): void {
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600 });
    renameSync(temporary, path);
}

function screenFiles(directory: string): string[] {
    return existsSync(directory)
        ? readdirSync(directory).filter((name) => /^[a-f\d-]+(?:\.previous)?\.json$/.test(name))
        : [];
}

export function advanceScreenEpoch({
    directory = screenCacheDirectory(),
    epoch,
}: {
    directory?: string;
    epoch: string;
}): void {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const marker = join(directory, "epoch");
    const prior = existsSync(marker) ? readFileSync(marker, "utf8") : undefined;
    if (prior === epoch) {
        return;
    }

    if (prior !== undefined) {
        const archive = join(directory, "previous-session");
        if (existsSync(archive)) {
            rmSync(archive, { recursive: true });
        }

        mkdirSync(archive, { mode: 0o700 });
        for (const name of screenFiles(directory)) {
            copyFileSync(join(directory, name), join(archive, name));
        }
    }

    writeAtomic(marker, epoch);
}

export function saveSurfaceScreen(input: SavedSurfaceScreen & { directory?: string }): boolean {
    const record = schema.parse(input);
    record.surfaceId = record.surfaceId.toLowerCase();
    record.stableSurfaceId = record.stableSurfaceId?.toLowerCase();
    const directory = input.directory ?? screenCacheDirectory();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const key = record.stableSurfaceId ?? record.surfaceId;
    const path = join(directory, `${key}.json`);
    if (existsSync(path)) {
        let previous: SavedSurfaceScreen | undefined;
        try {
            previous = schema.parse(SafeJSON.parse(readFileSync(path, "utf8"), { strict: true }));
        } catch (error) {
            logger.warn({ error, path }, "[cmux-screens] replacing unreadable cache entry");
        }

        if (previous?.text === record.text && previous.surfaceId === record.surfaceId) {
            return false;
        }

        if (previous) {
            copyFileSync(path, join(directory, `${key}.previous.json`));
        }
    }

    writeAtomic(path, SafeJSON.stringify(record));
    return true;
}

export function loadSavedScreens(
    options: { directory?: string; beforeMs?: number } = {}
): Map<string, SavedSurfaceScreen> {
    const directory = options.directory ?? screenCacheDirectory();
    const result = new Map<string, SavedSurfaceScreen>();
    for (const root of [join(directory, "previous-session"), directory]) {
        for (const name of screenFiles(root)) {
            try {
                const record = schema.parse(SafeJSON.parse(readFileSync(join(root, name), "utf8"), { strict: true }));
                if (record.atMs > (options.beforeMs ?? Infinity)) {
                    continue;
                }

                for (const id of [record.stableSurfaceId, record.surfaceId]) {
                    if (!id) {
                        continue;
                    }

                    const key = id.toLowerCase();
                    if (!result.has(key) || result.get(key)!.atMs < record.atMs) {
                        result.set(key, record);
                    }
                }
            } catch (error) {
                logger.debug({ error, path: join(root, name) }, "[cmux-screens] ignored unreadable cache entry");
            }
        }
    }

    return result;
}

export function pruneSavedScreens(options: { directory?: string; maxBytes?: number } = {}): number {
    const directory = options.directory ?? screenCacheDirectory();
    const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    const files = [join(directory, "previous-session"), directory]
        .flatMap((root) =>
            screenFiles(root).map((name) => {
                const path = join(root, name);
                const stat = statSync(path);
                return { path, bytes: stat.size, at: stat.mtimeMs, previous: name.includes(".previous.") };
            })
        )
        .sort((a, b) => a.at - b.at || Number(b.previous) - Number(a.previous));
    let bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    for (const file of files) {
        if (bytes <= maxBytes) {
            break;
        }

        unlinkSync(file.path);
        bytes -= file.bytes;
    }

    return bytes;
}
