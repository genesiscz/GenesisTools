import { SafeJSON } from "@app/utils/json";
import { grantArtifactAccess } from "@app/youtube/lib/artifact-access";
import { estimateReportCost, REPORT_MAX_MEMBERS, REPORT_MIN_MEMBERS } from "@app/youtube/lib/reports";
import { requireUser } from "@app/youtube/lib/server/auth";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";
import { toErrorResponse } from "@app/youtube/lib/server/error";
import { matchRoute } from "@app/youtube/lib/server/match-route";
import type { Youtube } from "@app/youtube/lib/youtube";

export async function handleReportsRoute(req: Request, url: URL, yt: Youtube): Promise<Response> {
    try {
        const user = requireUser(req, url, yt.db);

        if (user instanceof Response) {
            return user;
        }

        if (matchRoute(req, "POST", "/api/v1/reports/estimate", url.pathname)) {
            const body = await safeJsonBody(req);
            const videoIds = parseVideoIds(body?.videoIds);

            if (!videoIds) {
                return jsonError(
                    `body must include {videoIds: string[]} with ${REPORT_MIN_MEMBERS}-${REPORT_MAX_MEMBERS} members`,
                    400
                );
            }

            return Response.json(estimateReportCost(yt.db, { userId: user.id, videoIds }), {
                headers: CORS_HEADERS,
            });
        }

        if (matchRoute(req, "POST", "/api/v1/reports", url.pathname)) {
            const body = await safeJsonBody(req);
            const videoIds = parseVideoIds(body?.videoIds);

            if (!videoIds) {
                return jsonError(
                    `body must include {videoIds: string[]} with ${REPORT_MIN_MEMBERS}-${REPORT_MAX_MEMBERS} members`,
                    400
                );
            }

            const estimate = estimateReportCost(yt.db, { userId: user.id, videoIds });

            if (user.credits < estimate.creditCost) {
                return new Response(
                    SafeJSON.stringify(
                        { error: "Not enough diamonds", balance: user.credits, required: estimate.creditCost },
                        { strict: true }
                    ),
                    { status: 402, headers: { "Content-Type": "application/json", ...CORS_HEADERS } }
                );
            }

            const title =
                typeof body?.title === "string" && body.title.trim() !== ""
                    ? body.title.trim()
                    : `Report · ${videoIds.length} videos`;
            const provider = typeof body?.provider === "string" ? body.provider : undefined;
            const model = typeof body?.model === "string" ? body.model : undefined;
            const report = yt.db.insertReport({
                userId: user.id,
                title,
                memberIds: videoIds,
                params: { provider, model },
            });
            // The full quote is charged up front; member access rows are granted
            // at their quoted price so summaries generated (or reused) for this
            // report stay unlocked for the requester afterwards.
            const credits = yt.db.spendCredits(user.id, estimate.creditCost, `report:${report.id}`);

            for (const videoId of videoIds) {
                grantArtifactAccess(yt.db, {
                    userId: user.id,
                    kind: "summary:long",
                    videoId,
                    creditsSpent: estimate.perMemberCost[videoId] ?? 0,
                });
            }

            const job = yt.pipeline.enqueue({
                targetKind: "report",
                target: String(report.id),
                stages: ["reportSynthesize"],
            });

            return Response.json(
                { report, jobId: job.id, creditsSpent: estimate.creditCost, credits },
                { headers: CORS_HEADERS }
            );
        }

        if (matchRoute(req, "GET", "/api/v1/reports", url.pathname)) {
            return Response.json({ reports: yt.db.listReports(user.id) }, { headers: CORS_HEADERS });
        }

        const show = matchRoute(req, "GET", "/api/v1/reports/:id", url.pathname);

        if (show) {
            const report = yt.db.getReport(Number(show.id));

            if (!report || report.userId !== user.id) {
                return jsonError("report not found", 404);
            }

            return Response.json({ report }, { headers: CORS_HEADERS });
        }

        return jsonError("not found", 404);
    } catch (err) {
        return toErrorResponse(err);
    }
}

function parseVideoIds(value: unknown): string[] | null {
    if (!Array.isArray(value)) {
        return null;
    }

    const ids = [...new Set(value.filter((entry): entry is string => typeof entry === "string" && entry !== ""))];

    if (ids.length < REPORT_MIN_MEMBERS || ids.length > REPORT_MAX_MEMBERS) {
        return null;
    }

    return ids;
}

function jsonError(error: string, status: number): Response {
    return new Response(SafeJSON.stringify({ error }, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

async function safeJsonBody(req: Request): Promise<Record<string, unknown> | null> {
    if (!req.headers.get("content-type")?.includes("application/json")) {
        return null;
    }

    try {
        const parsed = await req.json();

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // ignore — caller treats null as "no body"
    }

    return null;
}
