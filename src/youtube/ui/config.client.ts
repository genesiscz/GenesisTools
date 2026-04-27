import type { YoutubeConfigPatch } from "@app/youtube/lib/config.api.types";
import type { YoutubeConfigShape } from "@app/youtube/lib/types";

export interface UiConfigResponse {
    config: YoutubeConfigShape;
    where: string;
}

export interface UiConfigPatchResponse {
    config: YoutubeConfigShape;
}

export async function fetchUiConfig(): Promise<UiConfigResponse> {
    const res = await fetch("/__config");

    if (!res.ok) {
        throw new Error(`failed to load config: ${res.status}`);
    }

    return (await res.json()) as UiConfigResponse;
}

export async function patchUiConfig(patch: YoutubeConfigPatch): Promise<UiConfigPatchResponse> {
    const res = await fetch("/__config", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
    });

    if (!res.ok) {
        const body = await res.text();
        throw new Error(`failed to patch config: ${res.status} ${body}`.trim());
    }

    return (await res.json()) as UiConfigPatchResponse;
}
