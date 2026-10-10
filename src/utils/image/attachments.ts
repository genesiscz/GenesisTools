import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";
import { z } from "zod";
import { detectImageFormat } from "./detect-format";
import { checkImageDimensions } from "./dimensions";

export const MAX_IMAGE_ATTACHMENTS = 24;
export const MAX_IMAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BATCH_BYTES = 100 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 48_000_000;

const inputSchema = z
    .object({
        type: z.literal("image"),
        path: z.string().min(1).refine(isAbsolute, "Image path must be absolute"),
        label: z.string().trim().min(1).max(200).optional(),
        comparison: z
            .object({
                group: z.string().trim().min(1).max(100),
                role: z.enum(["before", "after"]),
            })
            .strict()
            .optional(),
    })
    .strict();

export type ImageAttachmentInput = z.infer<typeof inputSchema>;

export interface ImageAttachment extends ImageAttachmentInput {
    id: string;
    name: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    bytes: number;
    width: number;
    height: number;
    sha256: string;
}

export const IMAGE_ATTACHMENT_INPUT_SCHEMA = {
    type: "array",
    maxItems: MAX_IMAGE_ATTACHMENTS,
    description:
        "Local PNG/JPEG/WebP screenshots. Imported into durable storage. Optional matching before/after groups.",
    items: {
        type: "object",
        additionalProperties: false,
        properties: {
            type: { type: "string", enum: ["image"] },
            path: { type: "string", description: "Absolute path to an existing local image; not a URL or base64." },
            label: { type: "string", minLength: 1, maxLength: 200 },
            comparison: {
                type: "object",
                additionalProperties: false,
                properties: {
                    group: { type: "string", minLength: 1, maxLength: 100 },
                    role: { type: "string", enum: ["before", "after"] },
                },
                required: ["group", "role"],
            },
        },
        required: ["type", "path"],
    },
} as const;

export function parseImageAttachmentInputs(value: unknown): ImageAttachmentInput[] {
    const attachments = z.array(inputSchema).max(MAX_IMAGE_ATTACHMENTS).parse(value);
    const roles = new Set<string>();

    for (const attachment of attachments) {
        if (!attachment.comparison) {
            continue;
        }

        const key = `${attachment.comparison.group}\0${attachment.comparison.role}`;
        if (roles.has(key)) {
            throw new Error(
                `Duplicate ${attachment.comparison.role} image in comparison ${attachment.comparison.group}`
            );
        }

        roles.add(key);
    }

    return attachments;
}

async function readBoundedImage(path: string): Promise<Buffer> {
    const file = await open(path, "r");
    try {
        const info = await file.stat();
        if (!info.isFile() || info.size > MAX_IMAGE_ATTACHMENT_BYTES) {
            throw new Error("Image attachment must be a regular file of at most 25 MiB");
        }

        const chunks: Buffer[] = [];
        let length = 0;

        for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 })) {
            length += chunk.length;

            if (length > MAX_IMAGE_ATTACHMENT_BYTES) {
                throw new Error("Image attachment grew beyond 25 MiB while being read");
            }

            chunks.push(chunk);
        }

        return Buffer.concat(chunks, length);
    } finally {
        await file.close();
    }
}

export async function importImageAttachments({
    attachments,
    root = toolDataDir("attachments", "images"),
    publish,
}: {
    attachments: unknown;
    root?: string;
    /** Publish the owning record; a failure rolls back this import. */
    publish?: (images: ImageAttachment[]) => void | Promise<void>;
}): Promise<ImageAttachment[]> {
    const inputs = parseImageAttachmentInputs(attachments);
    if (inputs.length === 0) {
        await publish?.([]);
        return [];
    }

    const { loadImage } = await import("@napi-rs/canvas");
    const prepared: { attachment: ImageAttachment; data: Buffer }[] = [];
    let totalBytes = 0;

    for (const input of inputs) {
        logger.debug({ path: input.path }, "reading image attachment");
        const data = await readBoundedImage(input.path);
        totalBytes += data.length;

        if (totalBytes > MAX_IMAGE_BATCH_BYTES) {
            throw new Error("Image attachments exceed 100 MiB in one message");
        }

        const format = detectImageFormat(data);
        if (!format || (format.mime !== "image/png" && format.mime !== "image/jpeg" && format.mime !== "image/webp")) {
            throw new Error("Attachments must contain PNG, JPEG, or WebP image data");
        }

        checkImageDimensions({ data, maxPixels: MAX_IMAGE_PIXELS });
        const image = await loadImage(data);
        if (image.width < 1 || image.height < 1 || image.width * image.height > MAX_IMAGE_PIXELS) {
            throw new Error("Image attachment must contain between 1 and 48 million pixels");
        }

        const id = randomUUID();
        prepared.push({
            data,
            attachment: {
                ...input,
                id,
                name: basename(input.path),
                path: join(root, `${id}.${format.ext}`),
                mimeType: format.mime,
                bytes: data.length,
                width: image.width,
                height: image.height,
                sha256: createHash("sha256").update(data).digest("hex"),
            },
        });
    }

    // Validate the whole batch before publishing any paths into a message.
    await mkdir(root, { recursive: true, mode: 0o700 });

    const created: string[] = [];
    const images = prepared.map((item) => item.attachment);
    try {
        for (const item of prepared) {
            const file = await open(item.attachment.path, "wx", 0o600);
            created.push(item.attachment.path);
            try {
                await file.writeFile(item.data);
            } finally {
                await file.close();
            }
        }

        await publish?.(images);
    } catch (error) {
        for (const path of created) {
            try {
                await unlink(path);
            } catch (cleanupError) {
                logger.warn({ path, error: cleanupError }, "could not remove an unreferenced imported image");
            }
        }

        throw error;
    }

    logger.info({ root, count: prepared.length, bytes: totalBytes }, "stored durable image attachments");
    return images;
}
