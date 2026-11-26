export {
    RequestBodyTooLargeError,
    readBoundedNodeBody,
    readBoundedRequestText,
    readBoundedWebBody,
} from "@genesiscz/utils/http/bounded-body";

export const DEFAULT_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
export const E2E_REQUEST_BODY_BYTES = 1024 * 1024;
const HANDOFF_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const LARGE_UPLOAD_BYTES = 200 * 1024 * 1024;
/** The Mac gateway's one upload route (a photo or a document from the phone). */
export const GATEWAY_UPLOAD_BYTES = 20 * 1024 * 1024;

export function requestBodyLimit(pathname: string): number {
    if (pathname === "/api/e2e/rpc") {
        return E2E_REQUEST_BODY_BYTES;
    }

    if (pathname === "/api/handoff/attach") {
        return HANDOFF_ATTACHMENT_BYTES;
    }

    if (pathname === "/api/gateway/upload") {
        return GATEWAY_UPLOAD_BYTES;
    }

    if (pathname.startsWith("/api/boards/sets/") || /^\/api\/boards\/[^/]+\/(?:upload|msg-uploads)$/.test(pathname)) {
        return LARGE_UPLOAD_BYTES;
    }

    return DEFAULT_REQUEST_BODY_BYTES;
}
