import { JOB_STAGES, JOB_TARGET_KINDS } from "@app/youtube/lib/jobs.types";
import { parseJobStages, parseJobStatus, redactJobForApi } from "@app/youtube/lib/queue";
import { resolveJobActor } from "@app/youtube/lib/server/auth";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { JobStage, JobTargetKind } from "@app/youtube/lib/types";
import type { Youtube } from "@app/youtube/lib/youtube";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

interface EnqueueBody {
    target: string;
    targetKind?: JobTargetKind;
    stages: JobStage[];
    params: Record<string, unknown> | null;
    priority?: number;
    force: boolean;
}

type ParseResult = { ok: true; value: EnqueueBody } | { ok: false; error: string };

export async function handlePipelineRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        // Resolved once, for every branch below: the same identity decides who a new
        // job is attributed to and whose jobs the reads and the cancel may touch.
        const actor = resolveJobActor(req, url, yt.db);

        if (matchRoute(req, "POST", "/api/v1/pipeline", url.pathname)) {
            let raw: unknown;

            try {
                raw = await req.json();
            } catch (err) {
                logger.debug({ err, path: url.pathname }, "youtube API: pipeline enqueue body was not valid JSON");

                return jsonError("request body must be valid JSON", 400);
            }

            // Everything below is a check rather than the `as EnqueueBody` claim this
            // used to make. Each field that `QueueService.enqueue` would throw on is
            // rejected here instead, because the outer catch turns a throw into a 500
            // and every one of these is a bad request, not a server fault.
            const body = parseEnqueueBody(raw);

            if (!body.ok) {
                return jsonError(body.error, 400);
            }

            const result = yt.queue.enqueue({
                target: body.value.target,
                targetKind: body.value.targetKind,
                stages: body.value.stages,
                userId: actor.kind === "user" ? actor.userId : null,
                params: body.value.params,
                priority: body.value.priority,
                force: body.value.force,
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
            const jobs = yt.queue.list({ status: status ?? undefined, limit, redact: true, actor });

            return Response.json({ jobs }, { headers: CORS_HEADERS });
        }

        if (matchRoute(req, "GET", "/api/v1/jobs/queue", url.pathname)) {
            return Response.json({ queue: yt.queue.stats() }, { headers: CORS_HEADERS });
        }

        const jobOnly = matchRoute(req, "GET", "/api/v1/jobs/:id", url.pathname);

        if (jobOnly) {
            const id = parseInt(jobOnly.id, 10);
            const result = yt.queue.get(id, { redact: true, actor });

            if (!result) {
                return jsonError("job not found", 404);
            }

            return Response.json(result, { headers: CORS_HEADERS });
        }

        const activity = matchRoute(req, "GET", "/api/v1/jobs/:id/activity", url.pathname);

        if (activity) {
            const id = parseInt(activity.id, 10);
            const rows = yt.queue.activity(id, actor);

            if (!rows) {
                return jsonError("job not found", 404);
            }

            return Response.json({ activity: rows }, { headers: CORS_HEADERS });
        }

        const cancel = matchRoute(req, "POST", "/api/v1/jobs/:id/cancel", url.pathname);

        if (cancel) {
            const id = parseInt(cancel.id, 10);
            const job = yt.queue.cancel(id, actor);

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

function parseEnqueueBody(raw: unknown): ParseResult {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return { ok: false, error: "request body must be a JSON object" };
    }

    const body = raw as Record<string, unknown>;

    if (typeof body.target !== "string" || body.target.trim() === "") {
        return { ok: false, error: "target is required and must be a non-empty string" };
    }

    const stages = parseJobStages(body.stages);

    if (!stages) {
        return { ok: false, error: `stages must be a non-empty array of: ${JOB_STAGES.join(", ")}` };
    }

    if (body.targetKind !== undefined && !isTargetKind(body.targetKind)) {
        return { ok: false, error: `targetKind must be one of: ${JOB_TARGET_KINDS.join(", ")}` };
    }

    if (body.priority !== undefined && !Number.isFinite(body.priority)) {
        return { ok: false, error: "priority must be a number" };
    }

    if (body.params !== undefined && body.params !== null && !isPlainObject(body.params)) {
        return { ok: false, error: "params must be a JSON object or null" };
    }

    return {
        ok: true,
        value: {
            target: body.target,
            targetKind: body.targetKind,
            stages,
            params: isPlainObject(body.params) ? body.params : null,
            priority: typeof body.priority === "number" ? body.priority : undefined,
            force: body.force === true,
        },
    };
}

function isTargetKind(value: unknown): value is JobTargetKind {
    return typeof value === "string" && JOB_TARGET_KINDS.some((kind) => kind === value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}
