import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteMatch, Router } from "@app/dev-dashboard/server/router";
import type { RouteContext, RouteResult, RouteServices, SseEmitter } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { profiler } from "@genesiscz/utils/profile";
import { RequestBodyTooLargeError, readBoundedNodeBody, requestBodyLimit } from "./body-reader";

// Per-endpoint handler time, keyed by route pattern so `:id` routes aggregate.
//   PROFILE=route,ttyd,tmux tools dev-dashboard …
const prof = profiler.scope("route");

function lowerHeaders(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};

    for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
            out[key.toLowerCase()] = value;
        } else if (Array.isArray(value)) {
            out[key.toLowerCase()] = value.join(", ");
        }
    }

    return out;
}

function writeResult(res: ServerResponse, result: RouteResult): void {
    if (result.kind === "json") {
        res.statusCode = result.status;
        res.setHeader("Content-Type", "application/json");
        res.end(SafeJSON.stringify(result.body));
        return;
    }

    if (result.kind === "text" || result.kind === "raw") {
        res.statusCode = result.status;
        res.setHeader("Content-Type", result.contentType ?? "text/plain; charset=utf-8");

        if (result.kind === "raw" && result.headers) {
            for (const [key, value] of Object.entries(result.headers)) {
                res.setHeader(key, value);
            }
        }

        res.end(result.body);
        return;
    }

    if (result.kind === "binary") {
        res.statusCode = result.status;
        res.setHeader("Content-Type", result.contentType);
        res.setHeader("Content-Length", String(result.body.length));

        for (const [key, value] of Object.entries(result.headers ?? {})) {
            res.setHeader(key, value);
        }

        res.end(Buffer.from(result.body));
        return;
    }

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    const emit: SseEmitter = {
        data: (payload) => {
            res.write(`data: ${payload}\n\n`);
        },
        comment: (text) => {
            res.write(`:${text}\n\n`);
        },
    };
    const handle = result.start(emit);
    res.on("close", () => {
        handle.close();
    });
}

/**
 * Connect/Vite adapter: matches the registry, builds a transport-neutral
 * RouteContext, and serializes the RouteResult. Returns false (→ call next())
 * when no route matches, so the host middleware chain continues.
 */
export async function handleWithRouter(
    router: Router,
    req: IncomingMessage,
    res: ServerResponse,
    opts: { services: RouteServices }
): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://dev-dashboard.local");
    const matched: RouteMatch | null = router.match(req.method ?? "GET", url.pathname);

    if (!matched) {
        return false;
    }

    let bodyLimitError: RequestBodyTooLargeError | undefined;
    let rawBodyPromise: Promise<Uint8Array> | undefined;
    const readRawBody = (): Promise<Uint8Array> => {
        rawBodyPromise ??= readBoundedNodeBody(req, requestBodyLimit(url.pathname)).catch((error) => {
            if (error instanceof RequestBodyTooLargeError) {
                bodyLimitError = error;
            }
            throw error;
        });
        return rawBodyPromise;
    };
    const ctx: RouteContext = {
        method: (req.method ?? "GET") as RouteContext["method"],
        pathname: url.pathname,
        query: url.searchParams,
        params: matched.params,
        headers: lowerHeaders(req),
        readJson: async <T>() => {
            const text = new TextDecoder().decode(await readRawBody()) || "{}";
            return SafeJSON.parse(text, { strict: true }) as T;
        },
        readRawBody,
        services: opts.services,
    };

    const label = `${matched.def.method} ${matched.def.pattern}`;
    try {
        const result = await prof.measureAsync(label, async () => matched.def.handler(ctx));
        if (bodyLimitError) {
            throw bodyLimitError;
        }
        writeResult(res, result);
    } catch (error) {
        if (!(error instanceof RequestBodyTooLargeError)) {
            throw error;
        }

        writeResult(res, {
            kind: "json",
            status: 413,
            body: { error: error.message, maxBytes: error.maxBytes },
        });
    }

    return true;
}
