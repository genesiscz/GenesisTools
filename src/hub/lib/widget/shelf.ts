import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, rename, stat, unlink } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { sha256FileAsync } from "@genesiscz/utils/fs/hash";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { boundedCommand } from "@genesiscz/utils/process/bounded-command";
import { withFileLock } from "@genesiscz/utils/storage/file-lock";
import { z } from "zod";
import { importWidgetAsset } from "../composer/assets";
import { mutateWidgetState, readWidgetState, widgetRoot } from "./storage";

export const shelfItemSchema = z.object({
    id: z.string().uuid(),
    kind: z.enum(["file", "capture"]),
    name: z.string(),
    path: z.string(),
    sourcePath: z.string().optional(),
    sha256: z.string(),
    bytes: z.number().int().nonnegative(),
    createdAt: z.number(),
    assetId: z.string().uuid().optional(),
});
export type ShelfItem = z.infer<typeof shelfItemSchema>;
const shelfStateSchema = z.object({
    version: z.literal(1).default(1),
    revision: z.number().int().nonnegative().default(0),
    items: z.array(shelfItemSchema).default([]),
});
type ShelfState = z.infer<typeof shelfStateSchema>;

function shelfDirectory(root?: string): string {
    return join(widgetRoot(root), "shelf");
}

/** Reads inventory metadata only. It never opens, hashes or probes the staged files. */
export async function listWidgetShelf(root?: string): Promise<ShelfState & { statePath: string }> {
    const statePath = join(shelfDirectory(root), "state.json");
    const file = Bun.file(statePath);
    if (!(await file.exists())) {
        return { ...shelfStateSchema.parse({}), statePath };
    }

    if (file.size > 32 * 1024 * 1024) {
        throw new Error("Shelf inventory exceeds 32 MiB");
    }

    return { ...shelfStateSchema.parse(SafeJSON.parse(await file.text())), statePath };
}

/**
 * `signal` is checked again inside the lock, right before `update`: waiting for another shelf writer can take
 * seconds, and an operation withdrawn meanwhile must not commit.
 */
async function mutateShelf<T>({
    root,
    update,
    signal,
}: {
    root?: string;
    update: (state: ShelfState) => T;
    signal?: AbortSignal;
}): Promise<T> {
    const directory = shelfDirectory(root);
    await mkdir(directory, { recursive: true });
    return withFileLock(
        join(directory, "state.lock"),
        async () => {
            signal?.throwIfAborted();
            const state = shelfStateSchema.parse(await listWidgetShelf(root));
            const previous = SafeJSON.stringify(state);
            const result = update(state);
            if (SafeJSON.stringify(state) === previous) {
                return result;
            }

            state.revision += 1;
            shelfStateSchema.parse(state);
            const temporary = join(directory, `state-${randomUUID()}.tmp`);
            try {
                await Bun.write(temporary, SafeJSON.stringify(state));
                await rename(temporary, join(directory, "state.json"));
            } catch (error) {
                await cleanupOwnedFile(temporary);
                throw error;
            }
            return result;
        },
        10_000
    );
}

async function cleanupOwnedFile(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (error) {
        logger.debug({ error, path }, "Shelf temporary file cleanup");
    }
}

export async function importShelfFile({
    root,
    input,
    signal,
}: {
    root?: string;
    input: string;
    signal?: AbortSignal;
}): Promise<{ item: ShelfItem; duplicate: boolean }> {
    signal?.throwIfAborted();
    const sourcePath = resolve(input);
    logger.debug({ sourcePath }, "Importing file into durable shelf");
    const before = await stat(sourcePath);
    if (!before.isFile()) {
        throw new Error("Choose a regular file; folders cannot be placed on the shelf");
    }

    const digest = await sha256FileAsync(sourcePath, { signal });
    const existing = (await listWidgetShelf(root)).items.find(
        (item) => item.sourcePath === sourcePath && item.sha256 === digest
    );
    if (
        existing &&
        (await Bun.file(existing.path).exists()) &&
        (await sha256FileAsync(existing.path, { signal })) === digest
    ) {
        return { item: existing, duplicate: true };
    }

    const id = randomUUID();
    const directory = join(shelfDirectory(root), "files", id);
    await mkdir(directory, { recursive: true });
    const path = join(directory, basename(sourcePath));
    try {
        await copyFile(sourcePath, path, constants.COPYFILE_EXCL);
        signal?.throwIfAborted();
        const after = await stat(sourcePath);
        if (
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            (await sha256FileAsync(path, { signal })) !== digest
        ) {
            throw new Error("The file changed while importing; choose it again");
        }

        const item: ShelfItem = {
            id,
            kind: "file",
            name: basename(sourcePath),
            path,
            sourcePath,
            sha256: digest,
            bytes: after.size,
            createdAt: Date.now(),
        };
        const result = await mutateShelf({
            root,
            signal,
            update: (state) => {
                const duplicate = state.items.find(
                    (entry) => entry.sourcePath === sourcePath && entry.sha256 === digest
                );
                if (duplicate && duplicate.id !== existing?.id) {
                    return { item: duplicate, duplicate: true };
                }

                state.items = state.items.filter((entry) => entry.id !== existing?.id);
                state.items.unshift(item);
                return { item, duplicate: false };
            },
        });
        if (result.duplicate) {
            await cleanupOwnedFile(path);
        }

        logger.debug({ id: result.item.id, duplicate: result.duplicate }, "Shelf import finished");
        return result;
    } catch (error) {
        await cleanupOwnedFile(path);
        throw error;
    }
}

export async function captureShelfImage({
    root,
    signal,
    capture,
}: {
    root?: string;
    signal?: AbortSignal;
    capture?: (options: {
        output: string;
        signal?: AbortSignal;
    }) => Promise<{ status: number; stderr?: string; error?: Error }>;
}): Promise<ShelfItem | { cancelled: true }> {
    signal?.throwIfAborted();
    const directory = shelfDirectory(root);
    await mkdir(directory, { recursive: true });
    return withFileLock(
        join(directory, "capture.lock"),
        async () => {
            const output = join(directory, `capture-${randomUUID()}.png`);
            try {
                const result = capture
                    ? await capture({ output, signal })
                    : await boundedCommand({
                          command: ["/usr/sbin/screencapture", "-i", "-x", output],
                          signal,
                          timeoutMs: 120_000,
                      });
                const outputExists = await Bun.file(output).exists();
                logger.debug(
                    { status: result.status, error: result.error, stderr: result.stderr, outputExists },
                    "Screenshot selection completed"
                );
                signal?.throwIfAborted();
                if (result.error || result.status !== 0) {
                    throw new Error(
                        `Screenshot capture failed: ${result.stderr?.trim() || result.error?.message || `exit ${result.status}`}`
                    );
                }

                if (!outputExists) {
                    return { cancelled: true as const };
                }

                return await stageShelfImage({ root, input: output, name: "Screenshot.png", signal });
            } finally {
                await cleanupOwnedFile(output);
            }
        },
        1
    );
}

export async function stageShelfImage({
    root,
    input,
    name,
    signal,
}: {
    root?: string;
    input: string;
    name?: string;
    signal?: AbortSignal;
}): Promise<ShelfItem> {
    signal?.throwIfAborted();
    const digest = await sha256FileAsync(resolve(input), { signal });
    const previous = (await listWidgetShelf(root)).items.find(
        (entry) => entry.kind === "capture" && entry.sha256 === digest
    );
    if (
        previous &&
        (await Bun.file(previous.path).exists()) &&
        (await sha256FileAsync(previous.path, { signal })) === digest
    ) {
        const assets = (await readWidgetState(root)).assets;
        if (previous.assetId && assets[previous.assetId]?.path === previous.path) {
            return previous;
        }
    }

    const asset = await importWidgetAsset({ root, input, type: "image" });
    signal?.throwIfAborted();
    if (asset.type !== "image") {
        throw new Error("Capture did not produce an image");
    }

    const item: ShelfItem = {
        id: randomUUID(),
        kind: "capture",
        name: name ?? basename(input),
        path: asset.path,
        sha256: asset.sha256,
        bytes: asset.bytes,
        assetId: asset.id,
        createdAt: Date.now(),
    };
    return mutateShelf({
        root,
        signal,
        update: (state) => {
            const existing = state.items.find(
                (entry) => entry.kind === "capture" && entry.sha256 === asset.sha256 && entry.id !== previous?.id
            );
            if (existing) {
                return existing;
            }

            state.items = state.items.filter((entry) => entry.id !== previous?.id);
            state.items.unshift(item);
            logger.debug({ id: item.id }, "Image staged without a recipient");
            return item;
        },
    });
}

/** Removal is an inventory operation. Source files and durable paths already in drafts survive it. */
export async function removeShelfItem({ root, id }: { root?: string; id: string }): Promise<void> {
    await mutateShelf({
        root,
        update: (state) => {
            state.items = state.items.filter((item) => item.id !== id);
        },
    });
}

/** Resolve a staged item's draft contribution without changing either inventory or draft. */
export async function readShelfAttachment({ root, id, key }: { root?: string; id: string; key: string }) {
    if (!key.trim()) {
        throw new Error("Choose a recipient before adding this item to an inbox draft");
    }

    const item = (await listWidgetShelf(root)).items.find((entry) => entry.id === id);
    if (!item || !(await Bun.file(item.path).exists())) {
        throw new Error("The staged item is unavailable; import it again");
    }

    const state = await readWidgetState(root);
    const draft = state.drafts[key] ?? { text: "", assetIds: [] };
    if (item.kind === "capture") {
        if (!item.assetId || !state.assets[item.assetId]) {
            throw new Error("The captured image is unavailable; capture it again");
        }

        return { mode: "image" as const, assetId: item.assetId, draft };
    }

    return { mode: "file-reference" as const, reference: `File: ${item.name}\nLocal path: ${item.path}`, draft };
}

export async function attachShelfItem({
    root,
    id,
    key,
}: {
    root?: string;
    id: string;
    key: string;
}): Promise<{ added: boolean; mode: "image" | "file-reference" }> {
    if (!key.trim()) {
        throw new Error("Choose a recipient before adding this item to an inbox draft");
    }

    const item = (await listWidgetShelf(root)).items.find((entry) => entry.id === id);
    if (!item || !(await Bun.file(item.path).exists())) {
        throw new Error("The staged item is unavailable; import it again");
    }

    return mutateWidgetState(root, (state) => {
        const draft = state.drafts[key] ?? { text: "", assetIds: [] };
        if (item.kind === "capture") {
            if (!item.assetId || !state.assets[item.assetId]) {
                throw new Error("The captured image is unavailable; capture it again");
            }

            const added = !draft.assetIds.includes(item.assetId);
            if (added) {
                draft.assetIds.push(item.assetId);
            }
            state.drafts[key] = draft;
            return { added, mode: "image" as const };
        }

        const reference = `File: ${item.name}\nLocal path: ${item.path}`;
        const added = !draft.text.includes(reference);
        if (added) {
            draft.text = [draft.text, reference].filter(Boolean).join("\n\n");
        }
        state.drafts[key] = draft;
        return { added, mode: "file-reference" as const };
    });
}
