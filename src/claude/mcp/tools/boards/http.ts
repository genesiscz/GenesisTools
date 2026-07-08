import { getConfig } from "@app/dev-dashboard/config";
import { env } from "@app/utils/env";
import { SafeJSON } from "@app/utils/json";

let cachedBase: string | null = null;

export async function boardsBaseUrl(): Promise<string> {
    if (cachedBase) {
        return cachedBase;
    }
    const override = env.boards.getBaseUrl();
    if (override) {
        cachedBase = override.replace(/\/$/, "");
        return cachedBase;
    }
    const { port } = await getConfig();
    cachedBase = `http://127.0.0.1:${port}`;
    return cachedBase;
}

export class BoardsHttpError extends Error {
    constructor(
        public readonly status: number,
        public readonly body: string
    ) {
        super(`HTTP ${status}: ${body.slice(0, 400)}`);
    }
}

export async function boardsFetch<T>(path: string, init?: RequestInit & { rawText?: boolean }): Promise<T> {
    const base = await boardsBaseUrl();
    let res: Response;
    try {
        res = await fetch(`${base}${path}`, {
            ...init,
            headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
            `dev-dashboard unreachable at ${base} (${msg}). Start it with \`tools dev-dashboard\` ` +
                `(or \`tools dev-dashboard agent\`), or set BOARDS_BASE_URL.`
        );
    }
    const text = await res.text();
    if (!res.ok) {
        throw new BoardsHttpError(res.status, text);
    }
    if (init?.rawText) {
        return text as unknown as T;
    }
    return SafeJSON.parse(text, { strict: true }) as T;
}

/** Compact tool output. */
export function compact(value: unknown): string {
    return SafeJSON.stringify(value);
}

/** Test-only. */
export function resetBoardsBaseUrl(): void {
    cachedBase = null;
}
