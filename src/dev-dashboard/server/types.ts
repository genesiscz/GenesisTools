import type { SystemCollector } from "@app/dev-dashboard/server/collector/SystemCollector";

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT" | "OPTIONS";

/** Everything a handler needs, with zero coupling to Node http / Connect / Bun. */
export interface RouteContext {
    method: HttpMethod;
    /** Pathname only, no query (e.g. "/api/system/pulse"). */
    pathname: string;
    /** Parsed query string. */
    query: URLSearchParams;
    /** Path params captured by the matched pattern (e.g. { slug }). */
    params: Record<string, string>;
    /** Lowercased request headers. */
    headers: Record<string, string>;
    /** Lazily reads + strict-parses the JSON body. Throws on invalid JSON. */
    readJson: <T>() => Promise<T>;
    /** Injected services (lets routes stay pure + testable). */
    services: RouteServices;
}

export interface RouteServices {
    collector: SystemCollector;
}

/** A handler returns a declarative result; adapters serialize it per transport. */
export type RouteResult =
    | { kind: "json"; status: number; body: unknown }
    | { kind: "text"; status: number; body: string; contentType?: string }
    | {
          kind: "binary";
          status: number;
          body: Uint8Array;
          contentType: string;
          headers?: Record<string, string>;
      }
    | { kind: "sse"; start: (emit: SseEmitter) => SseHandle }
    | { kind: "raw"; status: number; body: string; contentType: string; headers?: Record<string, string> };

export interface SseEmitter {
    /** Write one `data:` event. */
    data: (payload: string) => void;
    /** Write a raw line (e.g. a comment keep-alive ": ping"). */
    comment: (text: string) => void;
}

export interface SseHandle {
    /** Called when the client disconnects; clean up timers/subscriptions. */
    close: () => void;
}

export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult> | RouteResult;

export interface RouteDef {
    method: HttpMethod;
    /** Express-style pattern; supports ":param" segments (e.g. "/share/:slug"). */
    pattern: string;
    handler: RouteHandler;
    /** When true, the adapter must NOT apply a short upstream/read timeout (SSE). */
    longLived?: boolean;
}
