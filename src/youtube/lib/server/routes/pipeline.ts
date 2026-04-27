import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { JobStage, JobStatus, JobTargetKind } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";

interface EnqueueBody {
    target: string;
    targetKind?: JobTargetKind;
    stages: JobStage[];
}

export async function handlePipelineRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        if (matchRoute(req, "POST", "/api/v1/pipeline", url.pathname)) {
            const body = (await req.json()) as EnqueueBody;
            const targetKind = body.targetKind ?? inferTargetKind(body.target);
            const job = yt.pipeline.enqueue({ targetKind, target: body.target, stages: body.stages });

            return Response.json({ job }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "GET", "/api/v1/jobs", url.pathname)) {
            const status = parseJobStatus(url.searchParams.get("status"));
            const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
            const jobs = yt.pipeline.listJobs({ status: status ?? undefined, limit });

            return Response.json({ jobs }, { headers: CORS_HEADERS });
        }

        const jobOnly = matchRoute(req, "GET", "/api/v1/jobs/:id", url.pathname);

        if (jobOnly) {
            const job = yt.pipeline.getJob(parseInt(jobOnly.id, 10));

            if (!job) {
                return jsonError("job not found", 404);
            }

            return Response.json({ job }, { headers: CORS_HEADERS });
        }

        const activity = matchRoute(req, "GET", "/api/v1/jobs/:id/activity", url.pathname);

        if (activity) {
            const id = parseInt(activity.id, 10);

            if (!yt.pipeline.getJob(id)) {
                return jsonError("job not found", 404);
            }

            return Response.json({ activity: yt.db.listJobActivity(id) }, { headers: CORS_HEADERS });
        }

        const cancel = matchRoute(req, "POST", "/api/v1/jobs/:id/cancel", url.pathname);

        if (cancel) {
            const id = parseInt(cancel.id, 10);
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
