import { SafeJSON } from "@genesiscz/utils/json";

export function jsonError(status: number, message: string, extra?: { type?: string; code?: string }): Response {
    return new Response(SafeJSON.stringify({ error: { message, ...extra } }), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}
