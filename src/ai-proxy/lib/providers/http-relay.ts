import { SafeJSON } from "@genesiscz/utils/json";

/**
 * Bun's fetch transparently decodes compressed upstream bodies but leaves
 * Content-Encoding/Content-Length on the headers; relaying those verbatim
 * makes the client try to gunzip already-plain bytes (ZlibError — bit the
 * /stt relay live 2026-07-20). Strip the now-stale framing headers.
 */
export function relayHeaders(upstream: Response): Headers {
    const headers = new Headers(upstream.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    headers.delete("transfer-encoding");
    return headers;
}

/**
 * client_secrets bodies nest the model under `session.model` (top-level `model`
 * is handled by rewriteBodyModel in the provider's forward); rewrite the nested
 * one here.
 */
export function rewriteSessionModel(bodyText: string, upstreamModel: string): string {
    try {
        const parsed = SafeJSON.parse(bodyText, { strict: true }) as Record<string, unknown>;
        const session = parsed.session;

        if (session && typeof session === "object" && "model" in session) {
            return SafeJSON.stringify({ ...parsed, session: { ...session, model: upstreamModel } });
        }

        return bodyText;
    } catch {
        return bodyText;
    }
}

/** http(s) base → ws(s) base for a provider's realtime endpoint. */
export function toWsBase(httpOrWsBase: string): string {
    return httpOrWsBase.replace(/\/$/, "").replace(/^http/, "ws");
}
