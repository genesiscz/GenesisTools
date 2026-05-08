import { SafeJSON } from "@app/utils/json";

export function apiHandler(
    fn: (request: Request) => Promise<Response>,
): (ctx: { request: Request }) => Promise<Response> {
    return async ({ request }) => {
        try {
            return await fn(request);
        } catch (err) {
            const message = err instanceof Error ? err.message : "Internal server error";
            const status = (err as { statusCode?: number }).statusCode ?? 500;
            return Response.json({ error: message }, { status });
        }
    };
}

export async function jsonBody(request: Request): Promise<Record<string, unknown> | Response> {
    try {
        return (await request.json()) as Record<string, unknown>;
    } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid JSON body";
        return Response.json({ error: `Failed to parse request body: ${message}` }, { status: 400 });
    }
}

export function parseQuery<T>(
    request: Request,
    parser: (params: URLSearchParams) => T | Error,
): T | Response {
    const url = new URL(request.url);
    const result = parser(url.searchParams);
    if (result instanceof Error) {
        return Response.json({ error: result.message }, { status: 400 });
    }

    return result;
}

export function intParam(
    params: URLSearchParams,
    key: string,
    fallback: number,
    opts: { min?: number; max?: number } = {},
): number {
    const raw = params.get(key);
    if (raw === null) {
        return fallback;
    }

    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        throw new Error(`Query param '${key}' must be an integer; got ${raw}`);
    }

    if (opts.min !== undefined && parsed < opts.min) {
        return opts.min;
    }

    if (opts.max !== undefined && parsed > opts.max) {
        return opts.max;
    }

    return parsed;
}

export function enumParam<T extends string>(
    params: URLSearchParams,
    key: string,
    allowed: readonly T[],
    fallback: T,
): T {
    const raw = params.get(key);
    if (raw === null) {
        return fallback;
    }

    if (!allowed.includes(raw as T)) {
        throw new Error(`Query param '${key}' must be one of: ${allowed.join(", ")}`);
    }

    return raw as T;
}

export async function safeJsonBody(request: Request): Promise<Record<string, unknown> | Response> {
    try {
        const text = await request.text();
        return SafeJSON.parse(text, { strict: true }) as Record<string, unknown>;
    } catch (err) {
        const message = err instanceof Error ? err.message : "Invalid JSON body";
        return Response.json({ error: `Failed to parse request body: ${message}` }, { status: 400 });
    }
}
