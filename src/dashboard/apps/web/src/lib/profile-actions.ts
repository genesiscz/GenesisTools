import { SafeJSON } from "@dashboard/shared";
import { createServerFn } from "@tanstack/react-start";
import { mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const AVATAR_DIR = join(process.cwd(), ".data", "avatars");

const ALLOWED_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

interface WorkOSUserResponse {
    id: string;
    email: string;
    profile_picture_url: string | null;
}

async function setWorkOSProfilePicture(
    userId: string,
    profilePictureUrl: string | null
): Promise<WorkOSUserResponse> {
    const apiKey = process.env.WORKOS_API_KEY;

    if (!apiKey) {
        throw new Error("WORKOS_API_KEY is not configured");
    }

    const response = await fetch(`https://api.workos.com/user_management/users/${userId}`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: SafeJSON.stringify({ profile_picture_url: profilePictureUrl }),
    });

    if (!response.ok) {
        const body = await response.text();
        throw new Error(`WorkOS REST error ${response.status}: ${body}`);
    }

    return (await response.json()) as WorkOSUserResponse;
}

const updateAvatarSchema = z.object({
    userId: z.string().min(1, "User ID is required"),
    fileBase64: z.string().min(1, "File data is required"),
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/gif"]),
    origin: z.string().url("Origin URL is required"),
});

const removeAvatarSchema = z.object({
    userId: z.string().min(1, "User ID is required"),
});

const MIME_TO_EXT: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/gif": ".gif",
};

export const updateAvatarFn = createServerFn({ method: "POST" })
    .inputValidator((data: unknown) => {
        const parsed = updateAvatarSchema.safeParse(data);

        if (!parsed.success) {
            return {
                code: "validation_error" as const,
                message: parsed.error.issues[0]?.message ?? "Validation failed",
            };
        }

        return parsed.data;
    })
    .handler(async ({ data }) => {
        if ("code" in data) {
            return data;
        }

        const { userId, fileBase64, mimeType, origin } = data;
        const ext = MIME_TO_EXT[mimeType];

        if (!ext || !ALLOWED_EXTS.has(ext)) {
            return { code: "invalid_file" as const, message: "Unsupported image format" };
        }

        try {
            await mkdir(AVATAR_DIR, { recursive: true });

            // Remove old avatar files for this user (any extension)
            for (const oldExt of ALLOWED_EXTS) {
                const oldPath = join(AVATAR_DIR, `${userId}${oldExt}`);
                const oldFile = Bun.file(oldPath);
                const exists = await oldFile.exists();

                if (exists) {
                    await unlink(oldPath);
                }
            }

            const filePath = join(AVATAR_DIR, `${userId}${ext}`);
            const buffer = Buffer.from(fileBase64, "base64");
            await Bun.write(filePath, buffer);

            const avatarUrl = `${origin}/api/avatar/${userId}?v=${Date.now()}`;
            await setWorkOSProfilePicture(userId, avatarUrl);

            return { success: true as const, avatarUrl };
        } catch (error) {
            console.error("[updateAvatarFn] Error:", SafeJSON.stringify(error));
            return {
                code: "upload_error" as const,
                message: error instanceof Error ? error.message : "Failed to update avatar",
            };
        }
    });

export const removeAvatarFn = createServerFn({ method: "POST" })
    .inputValidator((data: unknown) => {
        const parsed = removeAvatarSchema.safeParse(data);

        if (!parsed.success) {
            return {
                code: "validation_error" as const,
                message: parsed.error.issues[0]?.message ?? "Validation failed",
            };
        }

        return parsed.data;
    })
    .handler(async ({ data }) => {
        if ("code" in data) {
            return data;
        }

        const { userId } = data;

        try {
            for (const ext of ALLOWED_EXTS) {
                const filePath = join(AVATAR_DIR, `${userId}${ext}`);
                const file = Bun.file(filePath);
                const exists = await file.exists();

                if (exists) {
                    await unlink(filePath);
                }
            }

            await setWorkOSProfilePicture(userId, null);

            return { success: true as const };
        } catch (error) {
            console.error("[removeAvatarFn] Error:", SafeJSON.stringify(error));
            return {
                code: "remove_error" as const,
                message: error instanceof Error ? error.message : "Failed to remove avatar",
            };
        }
    });
