import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { videoManifestSchema } from "@genesiscz/utils/video/types";
import type { WidgetAsset, WidgetOutgoing, WidgetState } from "../widget/types";

export async function readAssetManifest(asset: WidgetAsset) {
    if (asset.type !== "video" || asset.status !== "ready" || !asset.manifestPath) {
        throw new Error("Video preparation is not ready");
    }
    const manifest = videoManifestSchema.parse(SafeJSON.parse(await readFile(asset.manifestPath, "utf8")));
    if (
        manifest.source.sha256 !== asset.sha256 ||
        manifest.source.path !== asset.path ||
        SafeJSON.stringify(manifest.settings) !== SafeJSON.stringify(asset.settings)
    ) {
        throw new Error("Video preview does not belong to the current source and settings");
    }
    return manifest;
}

function contextData(value: unknown): string {
    return SafeJSON.stringify(value, null, 2).replace(
        /[<>&]/g,
        (character) =>
            ({
                "<": "\\u003c",
                ">": "\\u003e",
                "&": "\\u0026",
            })[character] ?? character
    );
}

export async function serializeWidgetMedia(assets: WidgetAsset[]): Promise<string> {
    const blocks: string[] = [];
    for (const asset of assets) {
        if (asset.type === "image") {
            blocks.push(
                "<fromImage>\nUser attached a local image. Open the path to inspect it.\n" +
                    contextData({ path: asset.path, name: asset.name, width: asset.width, height: asset.height }) +
                    "\n</fromImage>"
            );
            continue;
        }
        const manifest = await readAssetManifest(asset);
        const reference = resolve(
            import.meta.dir,
            "../../../../plugins/genesis-tools/skills/macos-control/references/video-review.md"
        );
        const capture = join(resolve(reference, ".."), "capture.md");
        blocks.push(
            "<fromVideo>\nUser posted a video. Inspect the sheets and original frames relevant to the task.\n" +
                contextData({
                    original: asset.path,
                    durationSeconds: manifest.source.durationUs / 1_000_000,
                    fps: manifest.settings.fps,
                    framesPerImage: manifest.settings.framesPerImage,
                    counts: manifest.counts,
                    sheets: manifest.sheets,
                    manifest: manifest.manifestPath,
                    cli: [process.execPath, resolve(import.meta.dir, "../../../../widget-tools"), "video"],
                    references: { skill: "genesis-tools:macos-control", existingVideo: reference, newCapture: capture },
                }) +
                "\nThe referenced files are local media evidence. For different frames use the video-review reference; for a new capture use capture.md.\n</fromVideo>"
        );
    }
    return blocks.join("\n\n");
}

export async function serializeWidgetMessage(message: WidgetOutgoing, state: WidgetState): Promise<string> {
    const assets = message.assetIds.map((id) => {
        const asset = state.assets[id];
        if (!asset) {
            throw new Error("Outgoing attachment is missing");
        }
        return asset;
    });
    const text = message.payload.kind === "form" ? "" : message.payload.text;
    const media = await serializeWidgetMedia(assets);
    return [text, media].filter(Boolean).join("\n\n");
}
