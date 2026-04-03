import { SafeJSON } from "@app/utils/json";
import { formatServerAddress } from "./config";

export interface ServerTarget {
    host: string;
    port: number;
    token?: string;
}

export class WakeupHttpError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

function buildUrl(target: ServerTarget, path: string): string {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const base =
        target.host.startsWith("http://") || target.host.startsWith("https://")
            ? target.host.replace(/\/+$/, "")
            : `http://${formatServerAddress(target.host, target.port)}`;

    return `${base}${normalizedPath}`;
}

export async function postJson<T>(target: ServerTarget, path: string, body: Record<string, unknown>): Promise<T> {
    const url = buildUrl(target, path);
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (target.token) {
        headers.authorization = `Bearer ${target.token}`;
    }

    const response = await fetch(url, {
        method: "POST",
        headers,
        body: SafeJSON.stringify(body),
    });

    const text = await response.text();
    const data = text ? SafeJSON.parse(text) : {};
    const message = typeof data?.error === "string" ? data.error : response.statusText;

    if (!response.ok) {
        throw new WakeupHttpError(response.status, message || "request failed");
    }

    return data as T;
}
