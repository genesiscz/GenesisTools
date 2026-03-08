/**
 * Wraps an API route handler with error handling that returns clean JSON errors
 * instead of letting TanStack Start produce generic "unhandled" 500s.
 */
export function apiHandler(
    fn: (request: Request) => Promise<Response>
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

/** Helper to read JSON body from request */
export async function jsonBody(request: Request): Promise<Record<string, unknown>> {
    return request.json();
}
