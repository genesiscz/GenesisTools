import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { type WidgetState, widgetStateSchema } from "./types";

export function widgetRoot(root?: string): string {
    return root ? resolve(root) : toolDataDir("hub", "widget");
}
export async function readWidgetState(root?: string): Promise<WidgetState> {
    const file = Bun.file(join(widgetRoot(root), "state.json"));
    if (!(await file.exists())) {
        return widgetStateSchema.parse({});
    }

    if (file.size > 32 * 1024 * 1024) {
        throw new Error("Widget history exceeds 32 MiB; export and clean up old outgoing items");
    }

    return widgetStateSchema.parse(SafeJSON.parse(await file.text()));
}
export async function mutateWidgetState<T>(root: string | undefined, update: (state: WidgetState) => T): Promise<T> {
    const directory = widgetRoot(root);
    await mkdir(directory, { recursive: true });
    return withFileLock(
        join(directory, "state.lock"),
        async () => {
            const state = await readWidgetState(directory);
            const previous = SafeJSON.stringify(state);
            const value = update(state);
            if (SafeJSON.stringify(state) === previous) {
                return value;
            }
            state.revision += 1;
            widgetStateSchema.parse(state);
            const temporary = join(directory, `state.${randomUUID()}.tmp`);
            try {
                await Bun.write(temporary, SafeJSON.stringify(state));
                await rename(temporary, join(directory, "state.json"));
            } catch (error) {
                try {
                    await unlink(temporary);
                } catch (cleanupError) {
                    logger.debug({ error: cleanupError }, "Widget temporary state already gone");
                }
                throw error;
            }
            return value;
        },
        10_000
    );
}
