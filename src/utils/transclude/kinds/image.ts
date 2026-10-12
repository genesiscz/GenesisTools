import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { MAX_IMAGE_ATTACHMENT_BYTES } from "../../image/attachments";
import { defineTransclusion, TransclusionError } from "../registry";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".svg", ".bmp", ".tiff"]);

/** `encodeURI` leaves parentheses alone, and an unbalanced one ends a markdown image destination early. */
function markdownDestination(path: string): string {
    return encodeURI(path).replaceAll("(", "%28").replaceAll(")", "%29");
}

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
    examples: ['{{image path="/path/to/hub-before.png" alt="Hub before the fix"}}'],
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

        // The limit every image door shares: question_post validates its attachments with it before they get here.
        if (bytes > MAX_IMAGE_ATTACHMENT_BYTES) {
            throw new TransclusionError(
                `${basename(path)} is ${Math.round(bytes / 1024 / 1024)} MB; the limit is ${MAX_IMAGE_ATTACHMENT_BYTES / 1024 / 1024} MB`
            );
        }

        const alt = (params.optionalString("alt") ?? basename(path)).replace(/[[\]]/g, "");

        if (ctx.preview) {
            return {
                markdown: `![${alt}](${markdownDestination(path)})`,
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
            markdown: `![${alt}](${markdownDestination(stored)})`,
            meta: { original: path, stored, bytes, sha256 },
        };
    },
});
