import type { Router } from "@app/dev-dashboard/server/router";
import type { RouteContext, RouteResult, RouteServices, SseEmitter } from "@app/dev-dashboard/server/types";
import { SafeJSON } from "@app/utils/json";

export function toResponse(result: RouteResult): Response {
    if (result.kind === "json") {
        return new Response(SafeJSON.stringify(result.body), {
            status: result.status,
            headers: { "Content-Type": "application/json" },
        });
    }

    if (result.kind === "text" || result.kind === "raw") {
        return new Response(result.body, {
            status: result.status,
            headers: {
                "Content-Type": result.contentType ?? "text/plain; charset=utf-8",
                ...(result.kind === "raw" ? (result.headers ?? {}) : {}),
            },
        });
    }

    if (result.kind === "binary") {
        // Copy into an ArrayBuffer-backed view: a Buffer/Uint8Array<ArrayBufferLike>
        // (e.g. an audio buffer) is not assignable to BodyInit under TS 5.7 typed-array generics.
        return new Response(new Uint8Array(result.body), {
            status: result.status,
            headers: {
                "Content-Type": result.contentType,
                "Content-Length": String(result.body.length),
                ...(result.headers ?? {}),
            },
        });
    }

    const encoder = new TextEncoder();
    let handle: { close: () => void } | null = null;
    let closed = false;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const emit: SseEmitter = {
                data: (payload) => {
                    if (closed) {
                        return;
                    }

                    try {
                        controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
                    } catch {
                        closed = true;
                    }
                },
                comment: (text) => {
                    if (closed) {
                        return;
                    }

                    try {
                        controller.enqueue(encoder.encode(`:${text}\n\n`));
                    } catch {
                        closed = true;
                    }
                },
            };
            handle = result.start(emit);
        },
        cancel() {
            closed = true;
            handle?.close();
        },
    });

    return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
    });
}

/**
 * Bun.serve adapter: matches the registry and returns a Response, or null when
 * no route matches (caller decides the 404 / fall-through). Streaming + binary
 * are first-class so SSE and audio/wav round-trip unchanged.
 */
export async function routerToResponse(
    router: Router,
    req: Request,
    opts: { services: RouteServices }
): Promise<Response | null> {
    const url = new URL(req.url);
    const matched = router.match(req.method, url.pathname);

    if (!matched) {
        return null;
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
    });

    let cachedBody: string | undefined;
    const ctx: RouteContext = {
        method: req.method as RouteContext["method"],
        pathname: url.pathname,
        query: url.searchParams,
        params: matched.params,
        headers,
        readJson: async <T>() => {
            if (cachedBody === undefined) {
                cachedBody = (await req.text()) || "{}";
            }

            return SafeJSON.parse(cachedBody, { strict: true }) as T;
        },
        services: opts.services,
    };

    return toResponse(await matched.def.handler(ctx));
}
