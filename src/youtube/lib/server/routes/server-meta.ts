import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";

export interface MetaRouteOptions {
    startedAt: number;
}

export async function handleMetaRoute(_req: Request, url: URL, opts: MetaRouteOptions): Promise<Response> {
    if (url.pathname === "/api/v1/healthz") {
        return Response.json(
            {
                ok: true,
                uptimeMs: Date.now() - opts.startedAt,
                version: "2.0.0",
            },
            { headers: CORS_HEADERS }
        );
    }

    if (url.pathname === "/api/v1/version") {
        return Response.json(
            { version: "2.0.0", gitSha: process.env.YOUTUBE_GIT_SHA ?? null },
            { headers: CORS_HEADERS }
        );
    }

    if (url.pathname === "/api/v1/openapi.json") {
        return Response.json({}, { headers: CORS_HEADERS });
    }

    return new Response(SafeJSON.stringify({ error: "not found" }, { strict: true }), {
        status: 404,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
