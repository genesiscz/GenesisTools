import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { defineTransclusion, TransclusionError } from "../registry";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg", ".bmp", ".tiff"]);
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export const imageTransclusion = defineTransclusion({
    name: "image",
    description:
        "Copies an image into the question store (named by its content hash, so the same file is stored once) " +
        "and embeds it as markdown, so the picture survives the original being moved or deleted.",
    params: [
        {
            name: "path",
            type: "path",
            required: true,
            description: "A png, jpg, gif, webp, heic, svg, bmp or tiff file.",
        },
        { name: "alt", type: "string", description: "The alt text; the file name when omitted." },
    ],
    examples: ['{{image path="/tmp/hub-before.png" alt="Hub before the fix"}}'],
    action: "substitute",
    async resolve(params, ctx) {
        const path = params.string("path");
        const extension = extname(path).toLowerCase();

        if (!IMAGE_EXTENSIONS.has(extension)) {
            throw new TransclusionError(
                `${basename(path)} is not an image (expected ${[...IMAGE_EXTENSIONS].join(", ")})`
            );
        }

        if (!existsSync(path)) {
            throw new TransclusionError(`file not found: ${path}`);
        }

        const bytes = statSync(path).size;

        if (bytes > MAX_IMAGE_BYTES) {
            throw new TransclusionError(
                `${basename(path)} is ${Math.round(bytes / 1024 / 1024)} MB; the limit is 10 MB`
            );
        }

        const alt = (params.optionalString("alt") ?? basename(path)).replace(/[[\]]/g, "");

        if (ctx.preview) {
            return {
                markdown: `![${alt}](${encodeURI(path)})`,
                meta: { original: path, stored: null, bytes, preview: true },
            };
        }

        if (!ctx.assetDir) {
            throw new TransclusionError("image needs an asset store, and this caller configured none");
        }

        const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
        const stored = join(ctx.assetDir, `${sha256.slice(0, 16)}${extension}`);
        mkdirSync(ctx.assetDir, { recursive: true });

        if (!existsSync(stored)) {
            copyFileSync(path, stored);
        }

        return {
            markdown: `![${alt}](${encodeURI(stored)})`,
            meta: { original: path, stored, bytes, sha256 },
        };
    },
});
