import { SafeJSON } from "@dashboard/shared";
import { createFileRoute } from "@tanstack/react-router";
import { join } from "node:path";

const AVATAR_DIR = join(process.cwd(), ".data", "avatars");

const MIME_BY_EXT: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
};

export const Route = createFileRoute("/api/avatar/$userId")({
    server: {
        handlers: {
            GET: async ({ params }) => {
                const { userId } = params;

                if (userId.includes("..") || userId.includes("/") || userId.includes("\\")) {
                    return new Response(SafeJSON.stringify({ error: "Invalid userId" }), {
                        status: 400,
                        headers: { "Content-Type": "application/json" },
                    });
                }

                for (const ext of Object.keys(MIME_BY_EXT)) {
                    const filePath = join(AVATAR_DIR, `${userId}.${ext}`);
                    const file = Bun.file(filePath);
                    const exists = await file.exists();

                    if (exists) {
                        const buffer = await file.arrayBuffer();
                        return new Response(buffer, {
                            status: 200,
                            headers: {
                                "Content-Type": MIME_BY_EXT[ext] ?? "application/octet-stream",
                                "Cache-Control": "public, max-age=3600",
                            },
                        });
                    }
                }

                return new Response(SafeJSON.stringify({ error: "Avatar not found" }), {
                    status: 404,
                    headers: { "Content-Type": "application/json" },
                });
            },
        },
    },
});
