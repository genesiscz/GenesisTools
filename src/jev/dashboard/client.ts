import type { EvaluationProviderId } from "@genesiscz/utils/ai/evaluation/types";
import { SafeJSON } from "@genesiscz/utils/json";

let provider: EvaluationProviderId = "vercel";
export function selectProvider(value: EvaluationProviderId) {
    provider = value;
}

export async function api<T>({
    route,
    body,
    signal,
}: {
    route: string;
    body?: unknown;
    signal?: AbortSignal;
}): Promise<T> {
    const response = await fetch(`/api/jev${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { "Content-Type": "application/json", "X-Jev-Request": "1", "X-Jev-Provider": provider },
        body: body === undefined ? undefined : SafeJSON.stringify(body),
        signal,
    });
    if (!response.headers.get("content-type")?.includes("application/json")) {
        throw new Error("Start this dashboard with tools jev dashboard to enable the local API.");
    }

    const data: T & { error?: string } = await response.json();
    if (!response.ok) {
        throw new Error(data.error ?? `Request failed (${response.status}).`);
    }

    return data;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Request failed.";
}

export function download({
    filename,
    content,
    type = "application/json",
}: {
    filename: string;
    content: string;
    type?: string;
}) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
