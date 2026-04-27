import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import type { ChannelHandle } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";

interface AddChannelsBody {
    handle?: string;
    handles?: string[];
    fromFile?: string[];
}

export async function handleChannelsRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    const segments = url.pathname.split("/").filter(Boolean);
    const handle = segments[3] ? normaliseHandle(decodeURIComponent(segments[3])) : undefined;
    const action = segments[4];

    try {
        if (!handle && req.method === "GET") {
            return Response.json({ channels: yt.channels.list() }, { headers: CORS_HEADERS });
        }

        if (!handle && req.method === "POST") {
            const body = await readJson<AddChannelsBody>(req);
            const inputs = [...(body.handles ?? []), ...(body.handle ? [body.handle] : []), ...(body.fromFile ?? [])];
            const normalised = inputs.map(normaliseHandle);

            for (const channelHandle of normalised) {
                await yt.channels.add(channelHandle);
            }

            return Response.json({ added: normalised }, { headers: CORS_HEADERS });
        }

        if (handle && !action && req.method === "DELETE") {
            yt.channels.remove(handle);
            return Response.json({ removed: handle }, { headers: CORS_HEADERS });
        }

        if (handle && action === "sync" && req.method === "POST") {
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

async function readJson<T>(req: Request): Promise<T> {
    return (await req.json()) as T;
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
