import { parseJobStatus, redactJobForApi, toJobStages } from "@app/youtube/lib/queue";
import { resolveUser } from "@app/youtube/lib/server/auth";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { JobStage, JobTargetKind } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";
import { SafeJSON } from "@genesiscz/utils/json";

interface EnqueueBody {
    target: string;
    targetKind?: JobTargetKind;
    stages: JobStage[];
    params?: Record<string, unknown> | null;
    priority?: number;
    force?: boolean;
}

export async function handlePipelineRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        if (matchRoute(req, "POST", "/api/v1/pipeline", url.pathname)) {
            const body = (await req.json()) as EnqueueBody;

            // The cast above is a claim, not a check. Without this guard a missing or
            // mistyped `stages` reached `toJobStages` as a non-array and surfaced to
            // the client as a 500 (`body.stages.map is not a function`) — a bad
            // request reported as a server fault.
            if (typeof body.target !== "string" || !Array.isArray(body.stages)) {
                return jsonError("target (string) and stages (array of stage names) are required", 400);
            }

            const user = resolveUser(req, url, yt.db);
            const result = yt.queue.enqueue({
                target: body.target,
                targetKind: body.targetKind,
                stages: toJobStages(body.stages),
                userId: user?.id ?? null,
                params: body.params ?? null,
                priority: body.priority,
                force: body.force === true,
            });

            return Response.json(
                {
                    job: result.job ? redactJobForApi(result.job) : result.job,
                    reused: result.reused,
                    queuePosition: result.queuePosition,
                    skipped: result.skipped,
                },
                { headers: CORS_HEADERS }
            );
        }

        if (matchRoute(req, "GET", "/api/v1/jobs", url.pathname)) {
            const status = parseJobStatus(url.searchParams.get("status"));
            const limit = parseInt(url.searchParams.get("limit") ?? "100", 10);
            const jobs = yt.queue.list({ status: status ?? undefined, limit, redact: true });

            return Response.json({ jobs }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "GET", "/api/v1/jobs/queue", url.pathname)) {
            return Response.json({ queue: yt.queue.stats() }, { headers: CORS_HEADERS });
        }

        const jobOnly = matchRoute(req, "GET", "/api/v1/jobs/:id", url.pathname);

        if (jobOnly) {
            const id = parseInt(jobOnly.id, 10);
            const result = yt.queue.get(id, { redact: true });

            if (!result) {
                return jsonError("job not found", 404);
            }

            return Response.json(result, { headers: CORS_HEADERS });
        }

        const activity = matchRoute(req, "GET", "/api/v1/jobs/:id/activity", url.pathname);

        if (activity) {
            const id = parseInt(activity.id, 10);
            const rows = yt.queue.activity(id);

            if (!rows) {
                return jsonError("job not found", 404);
            }

            return Response.json({ activity: rows }, { headers: CORS_HEADERS });
        }

        const cancel = matchRoute(req, "POST", "/api/v1/jobs/:id/cancel", url.pathname);

        if (cancel) {
            const id = parseInt(cancel.id, 10);
            const job = yt.queue.cancel(id);

            if (!job) {
                return jsonError("job not found", 404);
            }

            return Response.json({ job }, { headers: CORS_HEADERS });
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
