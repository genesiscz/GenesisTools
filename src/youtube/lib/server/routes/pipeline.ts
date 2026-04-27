import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import type { JobStage, JobStatus, JobTargetKind } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";

interface EnqueueBody {
    target: string;
    targetKind?: JobTargetKind;
    stages: JobStage[];
}

export async function handlePipelineRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    const segments = url.pathname.split("/").filter(Boolean);

    try {
        if (url.pathname === "/api/v1/pipeline" && req.method === "POST") {
            const body = (await req.json()) as EnqueueBody;
            const targetKind = body.targetKind ?? inferTargetKind(body.target);
            const job = yt.pipeline.enqueue({ targetKind, target: body.target, stages: body.stages });

            return Response.json({ job }, { headers: CORS_HEADERS });
        }

        if (url.pathname === "/api/v1/jobs" && req.method === "GET") {
            const status = parseJobStatus(url.searchParams.get("status"));
            const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
            const jobs = yt.pipeline.listJobs({ status: status ?? undefined, limit });

            return Response.json({ jobs }, { headers: CORS_HEADERS });
        }

        if (segments[2] === "jobs" && segments[3] && !segments[4] && req.method === "GET") {
            const job = yt.pipeline.getJob(parseInt(segments[3], 10));

            if (!job) {
                return jsonError("job not found", 404);
            }

            return Response.json({ job }, { headers: CORS_HEADERS });
        }

        if (segments[2] === "jobs" && segments[3] && segments[4] === "cancel" && req.method === "POST") {
            const id = parseInt(segments[3], 10);
            yt.pipeline.cancelJob(id);
            const job = yt.pipeline.getJob(id);

            return Response.json({ job }, { headers: CORS_HEADERS });
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function inferTargetKind(target: string): JobTargetKind {
    if (target.startsWith("@")) {
        return "channel";
    }

    if (target.includes("://")) {
        return "url";
    }

    return "video";
}

function parseJobStatus(value: string | null): JobStatus | null {
    if (
        value === "pending" ||
        value === "running" ||
        value === "completed" ||
        value === "failed" ||
        value === "cancelled" ||
        value === "interrupted"
    ) {
        return value;
    }

    return null;
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
