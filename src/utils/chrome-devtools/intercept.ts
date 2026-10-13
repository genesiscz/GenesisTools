import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { CdpLike } from "./cdp-like.ts";

const prof = profiler.scope("chrome-devtools");

export type InterceptAction =
    | { action: "continue" }
    | { action: "fulfill"; status?: number; headers?: Record<string, string>; body: string }
    | { action: "fail"; reason?: "Failed" | "Aborted" | "BlockedByClient" | "AccessDenied" };

export interface InterceptContext {
    url: string;
    method: string;
    resourceType: string;
    /** Response stage only. */
    status?: number;
    /** Response stage only, names lower-cased. */
    headers?: Record<string, string>;
    /** Response stage only: the original body as text. */
    body?(): Promise<string>;
}

export interface InterceptRule {
    /** Fetch.enable glob: `*` matches any run, `?` one character, e.g. `*\/config.js*`. */
    urlPattern: string;
    /** `request` answers before the network is used; `response` sees the real response first. */
    stage: "request" | "response";
    handle(context: InterceptContext): InterceptAction | Promise<InterceptAction>;
}

export interface InterceptStats {
    paused: number;
    fulfilled: number;
    continued: number;
    failed: number;
    errors: string[];
}

export interface InterceptHandle {
    readonly stats: InterceptStats;
    /** Stops intercepting (Fetch.disable) and removes the listener. */
    stop(): Promise<void>;
}

interface RequestPaused {
    requestId: string;
    request: { url: string; method: string };
    resourceType: string;
    responseStatusCode?: number;
    responseErrorReason?: string;
    responseHeaders?: Array<{ name: string; value: string }>;
}

const active = new WeakSet<CdpLike>();

/** Converts a Fetch.enable glob into a RegExp with the same meaning. */
export function globToRegExp(glob: string): RegExp {
    let source = "";
    for (let i = 0; i < glob.length; i++) {
        const char = glob[i];
        if (char === "\\" && i + 1 < glob.length) {
            i++;
            source += glob[i].replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        } else if (char === "*") {
            source += ".*";
        } else if (char === "?") {
            source += ".";
        } else {
            source += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
        }
    }

    return new RegExp(`^${source}$`);
}

function isRequestPaused(value: unknown): value is RequestPaused {
    if (typeof value !== "object" || value === null) {
        return false;
    }

    const paused = value as Record<string, unknown>;
    return typeof paused.requestId === "string" && typeof paused.request === "object" && paused.request !== null;
}

const lowerName = (header: { name: string }): string => header.name.toLowerCase();

function headerList(headers: Record<string, string>): Array<{ name: string; value: string }> {
    return Object.entries(headers).map(([name, value]) => ({ name, value }));
}

/**
 * Pauses matching requests over the CDP Fetch domain and lets each rule continue, fulfill or fail them.
 * One interceptor per CDP session: Fetch.enable replaces earlier patterns, so a second call throws.
 * Like every override, it ends when the session detaches.
 */
export async function intercept(cdp: CdpLike, rules: InterceptRule[]): Promise<InterceptHandle> {
    const stopProfile = prof.start("intercept.enable");
    try {
        if (active.has(cdp)) {
            throw new Error("this CDP session already has an active interceptor; stop it first");
        }

        const stats: InterceptStats = { paused: 0, fulfilled: 0, continued: 0, failed: 0, errors: [] };
        const compiled = rules.map((rule) => ({ rule, matches: globToRegExp(rule.urlPattern) }));

        const resume = async (event: RequestPaused): Promise<void> => {
            const isResponse = event.responseStatusCode !== undefined || event.responseErrorReason !== undefined;
            const match = compiled.find(
                (candidate) =>
                    (candidate.rule.stage === "response") === isResponse && candidate.matches.test(event.request.url)
            );
            if (!match || event.responseErrorReason) {
                stats.continued++;
                await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
                return;
            }

            const headers = Object.fromEntries(
                (event.responseHeaders ?? []).map((header) => [header.name.toLowerCase(), header.value])
            );
            const context: InterceptContext = {
                url: event.request.url,
                method: event.request.method,
                resourceType: event.resourceType,
                status: event.responseStatusCode,
                headers: isResponse ? headers : undefined,
                body: isResponse
                    ? async () => {
                          const reply = (await cdp.send("Fetch.getResponseBody", { requestId: event.requestId })) as {
                              body: string;
                              base64Encoded: boolean;
                          };
                          return reply.base64Encoded ? Buffer.from(reply.body, "base64").toString("utf8") : reply.body;
                      }
                    : undefined,
            };
            const decision = await match.rule.handle(context);
            if (decision.action === "continue") {
                stats.continued++;
                await cdp.send("Fetch.continueRequest", { requestId: event.requestId });
                return;
            }

            if (decision.action === "fail") {
                stats.failed++;
                await cdp.send("Fetch.failRequest", {
                    requestId: event.requestId,
                    errorReason: decision.reason ?? "Failed",
                });
                return;
            }

            // Fulfil from the original header LIST, so a repeated header (several Set-Cookie) keeps every value.
            // The body changes, so the original length and encoding no longer describe it, and a header the rule
            // sets replaces the original of that name.
            const overrides = headerList(decision.headers ?? {});
            const replaced = new Set(["content-length", "content-encoding", ...overrides.map(lowerName)]);
            const base = isResponse
                ? (event.responseHeaders ?? [])
                : [{ name: "content-type", value: "text/html; charset=utf-8" }];
            stats.fulfilled++;
            await cdp.send("Fetch.fulfillRequest", {
                requestId: event.requestId,
                responseCode: decision.status ?? event.responseStatusCode ?? 200,
                responseHeaders: [...base.filter((header) => !replaced.has(lowerName(header))), ...overrides],
                body: Buffer.from(decision.body, "utf8").toString("base64"),
            });
        };

        const listener = (params: unknown): void => {
            if (!isRequestPaused(params)) {
                return;
            }

            stats.paused++;
            // One timer per paused request only at --detail all: a page load pauses hundreds of them.
            const handled =
                profiler.detail === "all"
                    ? prof.measureAsync("intercept.request", () => resume(params))
                    : resume(params);
            handled.catch(async (error: unknown) => {
                stats.errors.push(`${params.request.url}: ${error instanceof Error ? error.message : String(error)}`);
                await cdp
                    .send("Fetch.continueRequest", { requestId: params.requestId })
                    .catch((continueError: unknown) => {
                        logger.debug(
                            { err: continueError, url: params.request.url },
                            "intercept: continue after a failed rule"
                        );
                    });
            });
        };

        cdp.on("Fetch.requestPaused", listener);
        active.add(cdp);
        try {
            await cdp.send("Fetch.enable", {
                patterns: rules.map((rule) => ({
                    urlPattern: rule.urlPattern,
                    requestStage: rule.stage === "response" ? "Response" : "Request",
                })),
            });
        } catch (error) {
            cdp.off("Fetch.requestPaused", listener);
            active.delete(cdp);
            throw error;
        }

        return {
            stats,
            async stop() {
                cdp.off("Fetch.requestPaused", listener);
                active.delete(cdp);
                await cdp.send("Fetch.disable");
            },
        };
    } finally {
        stopProfile();
    }
}

/**
 * A script body with `map` attached as an inline `sourceMappingURL` (a data URL), replacing any reference it
 * had. DevTools then shows the map's sources for it; the page runs the same code.
 */
export function attachSourceMap(code: string, map: string): string {
    const stripped = code.replace(/\n?\/\/[#@] sourceMappingURL=[^\n]*\s*$/, "");
    return `${stripped}\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(map, "utf8").toString("base64")}\n`;
}

export interface ResponseRewrite {
    urlPattern: string;
    transform(body: string, context: InterceptContext): string | Promise<string>;
}

/** Rewrites matching response bodies in flight and marks them `cache-control: no-store`. */
export function rewriteResponses(cdp: CdpLike, rewrites: ResponseRewrite[]): Promise<InterceptHandle> {
    return intercept(
        cdp,
        rewrites.map((rewrite) => ({
            urlPattern: rewrite.urlPattern,
            stage: "response" as const,
            async handle(context: InterceptContext): Promise<InterceptAction> {
                const original = context.body ? await context.body() : "";
                return {
                    action: "fulfill",
                    body: await rewrite.transform(original, context),
                    headers: { "cache-control": "no-store" },
                };
            },
        }))
    );
}

/**
 * Answers every document request matching `urlPattern` with an empty HTML page and fails every other
 * request there, so an origin can be opened (for its storage) without running its app or using the network.
 */
export function serveBlankDocuments(cdp: CdpLike, urlPattern: string): Promise<InterceptHandle> {
    return intercept(cdp, [
        {
            urlPattern,
            stage: "request",
            handle(context) {
                if (context.resourceType !== "Document") {
                    return { action: "fail", reason: "BlockedByClient" };
                }

                return { action: "fulfill", body: "<!doctype html><title>blank</title>" };
            },
        },
    ]);
}
