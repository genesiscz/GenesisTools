import logger from "@app/logger";
import { SafeJSON } from "@app/utils/json";
import { CORS_HEADERS } from "@app/youtube/lib/server/cors";

export interface ErrorPayload {
    error: string;
    code?: string;
    details?: unknown;
}

export function toErrorResponse(err: unknown, status = 500): Response {
    const payload = toErrorPayload(err);
    logger.warn({ err, status }, "youtube server error");

    return new Response(SafeJSON.stringify(payload, { strict: true }), {
        status,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
}

function toErrorPayload(err: unknown): ErrorPayload {
    if (err instanceof Error) {
        return { error: err.message, code: getErrorCode(err) };
    }

    return { error: String(err) };
}

function getErrorCode(err: Error): string | undefined {
    if (!("code" in err)) {
        return undefined;
    }

    const code = err.code;
    return typeof code === "string" ? code : undefined;
}
