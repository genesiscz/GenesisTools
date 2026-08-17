/**
 * The read door's behaviour, kept out of the route file so it can be driven with a plain
 * `Request` instead of a running server. The route is the thin adapter; this maps a URL onto
 * the same `lib/reports/*` call the CLI makes.
 */
import { isReportName, type ReportRequest, runReport } from "@app/spotify/lib/reports";
import { boolParam, strParam } from "@app/spotify/ui/server/api-utils";

/**
 * Query parameters answer to the CLI's spelling as well as camelCase (`?min-ms` and `?minMs`
 * both work); `strParam` handles the alias, so this list stays in one form.
 */
export function parseReportRequest(params: URLSearchParams): ReportRequest {
    return {
        profile: strParam(params, "profile"),
        since: strParam(params, "since"),
        until: strParam(params, "until"),
        year: strParam(params, "year"),
        top: strParam(params, "top"),
        tz: strParam(params, "tz"),
        artist: strParam(params, "artist"),
        genre: strParam(params, "genre"),
        platform: strParam(params, "platform"),
        minMs: strParam(params, "minMs"),
        allPlays: boolParam(params, "allPlays"),
        excludeIncognito: boolParam(params, "excludeIncognito"),
        kind: strParam(params, "kind"),
        by: strParam(params, "by"),
        min: strParam(params, "min"),
        maxGlobal: strParam(params, "maxGlobal"),
        bucket: strParam(params, "bucket"),
        gap: strParam(params, "gap"),
        window: strParam(params, "window"),
        quietMonths: strParam(params, "quietMonths"),
        minPlays: strParam(params, "minPlays"),
        trend: boolParam(params, "trend"),
        q: strParam(params, "q"),
        from: strParam(params, "from"),
        to: strParam(params, "to"),
        a: strParam(params, "a"),
        b: strParam(params, "b"),
        timeline: boolParam(params, "timeline"),
    };
}

/**
 * An unknown report name is a 404 rather than a thrown error: it is the one failure here that
 * is about the URL rather than about the data behind it.
 */
export function reportRead(request: Request, name: string): Response {
    if (!isReportName(name)) {
        return Response.json({ error: `unknown report "${name}"` }, { status: 404 });
    }

    const url = new URL(request.url);

    return Response.json(runReport(name, parseReportRequest(url.searchParams)));
}
