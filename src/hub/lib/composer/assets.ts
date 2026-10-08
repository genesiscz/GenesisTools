import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, stat, unlink } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { importImageAttachments } from "@genesiscz/utils/image/attachments";
import { logger } from "@genesiscz/utils/logger";
import { prepareVideoEvidence, videoDigest } from "@genesiscz/utils/video/evidence";
import { probeVideo } from "@genesiscz/utils/video/probe";
import { planVideoSamples } from "@genesiscz/utils/video/sampling";
import { type VideoSettings, videoSettingsSchema } from "@genesiscz/utils/video/types";
import { mutateWidgetState, readWidgetState, widgetRoot } from "../widget/storage";
import type { WidgetAsset, WidgetState } from "../widget/types";

export async function importWidgetAsset({
    input,
    type,
    root,
}: {
    input: string;
    type: "image" | "video";
    root?: string;
}): Promise<WidgetAsset> {
    const directory = join(widgetRoot(root), "assets");
    let ownedPath: string | undefined;
    try {
        let asset: WidgetAsset;
        if (type === "image") {
            const [image] = await importImageAttachments({
                attachments: [{ type, path: resolve(input) }],
                root: directory,
            });
            ownedPath = image.path;
            asset = {
                type,
                id: image.id,
                name: image.name,
                path: image.path,
                sha256: image.sha256,
                mimeType: image.mimeType,
                width: image.width,
                height: image.height,
                bytes: image.bytes,
            };
        } else {
            await probeVideo({ input });
            const id = randomUUID();
            const path = join(directory, id + extname(input).toLowerCase());
            await mkdir(directory, { recursive: true });
            const before = await stat(input);
            const digest = await videoDigest(input);
            await copyFile(input, path, constants.COPYFILE_EXCL);
            ownedPath = path;
            const after = await stat(input);
            if (
                after.size !== before.size ||
                after.mtimeMs !== before.mtimeMs ||
                (await videoDigest(path)) !== digest
            ) {
                throw new Error("Video changed while importing; choose it again");
            }

            const info = await probeVideo({ input: path });
            asset = {
                type,
                id,
                name: basename(input),
                path,
                sha256: digest,
                durationUs: info.durationUs,
                width: info.displayWidth,
                height: info.displayHeight,
                settings: { fps: 2, framesPerImage: 16, minimumDifferencePct: 0 },
                revision: 1,
                status: "pending",
            };
        }

        await mutateWidgetState(root, (state) => {
            state.assets[asset.id] = asset;
        });
        return asset;
    } catch (error) {
        if (ownedPath) {
            try {
                await unlink(ownedPath);
            } catch (cleanupError) {
                logger.warn(
                    { error: cleanupError, path: ownedPath },
                    "Could not clean up an unreferenced widget import"
                );
            }
        }
        throw error;
    }
}

function assertEditable(state: WidgetState, id: string): void {
    if (
        state.outgoing.some(
            (message) => message.assetIds.includes(id) && ["dispatching", "sent", "unknown"].includes(message.state)
        )
    ) {
        throw new Error("Dispatched media is immutable; attach it to a new follow-up");
    }
}

export async function reviseVideoAsset({
    root,
    id,
    settings,
}: {
    root?: string;
    id: string;
    settings: VideoSettings;
}): Promise<WidgetAsset> {
    const parsed = videoSettingsSchema.parse(settings);
    return mutateWidgetState(root, (state) => {
        assertEditable(state, id);
        const asset = state.assets[id];
        if (asset?.type !== "video") {
            throw new Error("No such video attachment");
        }

        planVideoSamples({ durationUs: asset.durationUs, ...parsed });
        if (
            asset.status !== "failed" &&
            asset.settings.fps === parsed.fps &&
            asset.settings.framesPerImage === parsed.framesPerImage &&
            asset.settings.minimumDifferencePct === parsed.minimumDifferencePct &&
            (asset.settings.startUs ?? 0) === (parsed.startUs ?? 0) &&
            (asset.settings.endUs ?? asset.durationUs) === (parsed.endUs ?? asset.durationUs)
        ) {
            return asset;
        }

        // A failed preparation with the same settings is the "Prepare again" button: it starts over as a new
        // revision, since the watcher prepares only a pending asset.

        asset.settings = parsed;
        asset.revision += 1;
        asset.status = "pending";
        delete asset.confirmedRevision;
        delete asset.manifestPath;
        delete asset.error;
        return asset;
    });
}

export async function prepareWidgetAsset({
    root,
    id,
    signal,
}: {
    root?: string;
    id: string;
    signal?: AbortSignal;
}): Promise<void> {
    const asset = (await readWidgetState(root)).assets[id];
    if (asset?.type !== "video") {
        throw new Error("No such video attachment");
    }

    const revision = asset.revision;
    const update = async (fn: (current: Extract<WidgetAsset, { type: "video" }>) => void) =>
        mutateWidgetState(root, (state) => {
            const current = state.assets[id];
            if (current?.type === "video" && current.revision === revision) {
                fn(current);
            }
        });
    await update((current) => {
        current.status = "preparing";
        delete current.error;
    });
    try {
        const manifest = await prepareVideoEvidence({
            input: asset.path,
            settings: asset.settings,
            outputRoot: join(widgetRoot(root), "video", id),
            signal,
        });
        signal?.throwIfAborted();
        await update((current) => {
            current.status = "ready";
            current.manifestPath = manifest.manifestPath;
            if (current.settings.minimumDifferencePct === 0) {
                current.confirmedRevision = revision;
            }
        });
    } catch (error) {
        await update((current) => {
            current.status = signal?.aborted ? "pending" : "failed";
            current.error = error instanceof Error ? error.message : String(error);
        });
        throw error;
    }
}

export async function confirmVideoAsset({
    root,
    id,
    revision,
}: {
    root?: string;
    id: string;
    revision: number;
}): Promise<void> {
    await mutateWidgetState(root, (state) => {
        const asset = state.assets[id];
        if (asset?.type !== "video" || asset.revision !== revision || asset.status !== "ready") {
            throw new Error("The frame preview changed; review the current frames before confirming");
        }
        asset.confirmedRevision = revision;
    });
}
