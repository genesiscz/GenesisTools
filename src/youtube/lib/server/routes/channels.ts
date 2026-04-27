import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { ChannelHandle } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";

interface AddChannelsBody {
    handle?: string;
    handles?: string[];
    fromFile?: string[];
}

export async function handleChannelsRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        if (matchRoute(req, "GET", "/api/v1/channels", url.pathname)) {
            return Response.json({ channels: yt.channels.list() }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "POST", "/api/v1/channels", url.pathname)) {
            const body = (await req.json()) as AddChannelsBody;
            const inputs = [...(body.handles ?? []), ...(body.handle ? [body.handle] : []), ...(body.fromFile ?? [])];
            const normalised = inputs.map(normaliseHandle);

            for (const channelHandle of normalised) {
                await yt.channels.add(channelHandle);
            }

            return Response.json({ added: normalised }, { headers: CORS_HEADERS });
        }

        const remove = matchRoute(req, "DELETE", "/api/v1/channels/:handle", url.pathname);

        if (remove) {
            const handle = normaliseHandle(remove.handle);
            yt.channels.remove(handle);

            return Response.json({ removed: handle }, { headers: CORS_HEADERS });
        }

        const sync = matchRoute(req, "POST", "/api/v1/channels/:handle/sync", url.pathname);

        if (sync) {
            const handle = normaliseHandle(sync.handle);
            const job = yt.pipeline.enqueue({
                targetKind: "channel",
                target: handle,
                stages: ["discover", "metadata"],
            });

            return Response.json({ enqueuedJobIds: [job.id], enqueuedJobId: job.id }, { headers: CORS_HEADERS });
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function normaliseHandle(input: string): ChannelHandle {
    const trimmed = input.trim();

    if (!trimmed) {
        throw new Error("channel handle is required");
    }

    return (trimmed.startsWith("@") ? trimmed : `@${trimmed}`) as ChannelHandle;
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
