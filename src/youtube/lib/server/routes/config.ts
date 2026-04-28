import { SafeJSON } from "@app/utils/json";
import type { YoutubeConfigPatch } from "@app/youtube/lib/config.api.types";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import type { Youtube } from "@app/youtube/lib/youtube";

export async function handleConfigRoute(req: Request, _url: URL, yt: Youtube): Promise<Response> {
    try {
        if (req.method === "GET") {
            return Response.json(
                { config: await yt.config.getAll(), where: yt.config.where() },
                { headers: CORS_HEADERS }
            );
        }

        if (req.method === "PATCH") {
            const body = (await req.json()) as YoutubeConfigPatch;
            await yt.config.update(body);

            return Response.json({ config: await yt.config.getAll() }, { headers: CORS_HEADERS });
        }

        return new Response(SafeJSON.stringify({ error: "method not allowed" }, { strict: true }), {
            status: 405,
            headers: { "Content-Type": "application/json", ...CORS_HEADERS },
        });
    } catch (err) {
        return toErrorResponse(err);
    }
}
