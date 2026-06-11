import { SafeJSON } from "@app/utils/json";

// The INNER request/response sealed inside an `E2eEnvelope` on the managed tier. The mobile
// `E2eTransport` encodes an `E2eRequest`, seals it; the Agent `e2e-shim` opens it, replays it
// through the route registry, and seals back an `E2eResponse`. Defining the shape here (in the
// RN-safe contract) is what keeps the two endpoints from drifting — exactly like the envelope.
// Pure: `SafeJSON` only (no node:/bun:), strict mode (native JSON) for RN-shim compatibility.

export interface E2eRequest {
    /** HTTP method, e.g. "GET" | "POST". */
    method: string;
    /** Pathname + query, e.g. "/api/system/pulse" or "/api/qa/log?unread=1". */
    path: string;
    /** Raw, already-serialized request body (JSON string), if any. */
    body?: string;
}

export interface E2eResponse {
    status: number;
    /** Raw response body (JSON string for `json` results, text otherwise). */
    body: string;
    contentType?: string;
}

export function encodeE2eRequest(req: E2eRequest): string {
    return SafeJSON.stringify(req, { strict: true });
}

export function decodeE2eRequest(raw: string): E2eRequest {
    const req = SafeJSON.parse(raw, { strict: true }) as E2eRequest;

    if (typeof req.method !== "string" || typeof req.path !== "string" || (req.body !== undefined && typeof req.body !== "string")) {
        throw new Error("invalid E2eRequest");
    }

    return req;
}

export function encodeE2eResponse(res: E2eResponse): string {
    return SafeJSON.stringify(res, { strict: true });
}

export function decodeE2eResponse(raw: string): E2eResponse {
    const res = SafeJSON.parse(raw, { strict: true }) as E2eResponse;

    if (typeof res.status !== "number" || typeof res.body !== "string" || (res.contentType !== undefined && typeof res.contentType !== "string")) {
        throw new Error("invalid E2eResponse");
    }

    return res;
}
