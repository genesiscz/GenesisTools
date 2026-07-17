import type { ExtensionRequest, ExtensionResponse } from "@ext/shared/messages";

/** Server error surfaced through the background bridge; `code` carries the
 *  server's stable error code (e.g. "login_required") when present. */
export class ApiError extends Error {
    constructor(
        message: string,
        public readonly code?: string
    ) {
        super(message);
        this.name = "ApiError";
    }
}

export async function send<T>(req: ExtensionRequest): Promise<T> {
    const res = (await chrome.runtime.sendMessage(req)) as ExtensionResponse;

    if (!res.ok) {
        throw new ApiError(res.error, res.code);
    }

    return res.data as T;
}
