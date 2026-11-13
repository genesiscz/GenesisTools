import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

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

/** The fetch an exchange sends through: `fetchDirect` for the API keys, a logged-in client's own fetch for a seat. */
export type ExchangeFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What every exchange log line carries: which provider and account sent which route. */
export interface ExchangeLog {
    provider: string;
    account: string;
    route: string;
    /** Extra fields for every line of this exchange (the upstream model, an image route). */
    fields?: Record<string, unknown>;
}

export interface ExchangeInput {
    fetch: ExchangeFetch;
    request: Request | { url: string; init: RequestInit };
    signal: AbortSignal;
    log: ExchangeLog;
    /** The provider's own answer for an upstream error; without it the upstream answer is relayed as it came. */
    mapNonOk?: (response: Response) => Promise<Response> | Response;
    /** The provider's own answer for a thrown error it knows (an expired login); undefined falls through to the 502. */
    mapThrown?: (err: unknown) => Response | undefined;
    /** The `code` of the 502 envelope for a fetch that threw. */
    failureCode?: string;
}

/**
 * One single-shot upstream exchange: send, log, relay the upstream headers. A client that hung up gets 499,
 * logged at debug, because the client chose it and nobody reads the answer. A fetch that threw becomes a 502
 * in the OpenAI error envelope. A non-OK answer goes to `mapNonOk` when the provider has one.
 */
export async function exchange(input: ExchangeInput): Promise<Response> {
    const { log } = input;
    const started = performance.now();
    const fields = { account: log.account, path: log.route, ...log.fields };
    const elapsedMs = () => Math.round(performance.now() - started);

    try {
        const upstream =
            input.request instanceof Request
                ? await input.fetch(input.request, { signal: input.signal })
                : await input.fetch(input.request.url, { ...input.request.init, signal: input.signal });

        logger[upstream.ok ? "debug" : "warn"](
            { ...fields, status: upstream.status, elapsedMs: elapsedMs() },
            `ai-proxy: ${log.provider} upstream request ${upstream.ok ? "ok" : "failed"}`
        );

        if (!upstream.ok && input.mapNonOk) {
            return await input.mapNonOk(upstream);
        }

        return new Response(upstream.body, { status: upstream.status, headers: relayHeaders(upstream) });
    } catch (err) {
        if (input.signal.aborted) {
            logger.debug({ ...fields, elapsedMs: elapsedMs() }, `ai-proxy: ${log.provider} client aborted`);
            return new Response(null, { status: 499 });
        }

        const mapped = input.mapThrown?.(err);

        if (mapped) {
            return mapped;
        }

        logger.warn({ ...fields, err, elapsedMs: elapsedMs() }, `ai-proxy: ${log.provider} upstream fetch threw`);

        return new Response(
            SafeJSON.stringify({
                error: {
                    message: err instanceof Error ? err.message : String(err),
                    type: "upstream_error",
                    code: input.failureCode ?? "upstream_fetch_failed",
                },
            }),
            { status: 502, headers: { "Content-Type": "application/json" } }
        );
    }
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
