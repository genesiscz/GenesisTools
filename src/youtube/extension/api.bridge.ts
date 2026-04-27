import type { ExtensionRequest, ExtensionResponse } from "@ext/shared/messages";

export async function send<T>(req: ExtensionRequest): Promise<T> {
    const res = (await chrome.runtime.sendMessage(req)) as ExtensionResponse;

    if (!res.ok) {
        throw new Error(res.error);
    }

    return res.data as T;
}
