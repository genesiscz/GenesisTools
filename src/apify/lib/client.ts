import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const ORIGIN = "https://api.apify.com/v2";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const userSchema = z.object({ id: z.string(), username: z.string().optional() });
const runSchema = z.object({
    id: z.string(),
    actId: z.string().optional(),
    status: z.string(),
    startedAt: z.string().optional(),
    finishedAt: z.string().nullable().optional(),
    defaultDatasetId: z.string().optional(),
    defaultKeyValueStoreId: z.string().optional(),
    stats: z.record(z.string(), z.unknown()).optional(),
    statusMessage: z.string().nullish(),
    exitCode: z.number().nullish(),
    usageTotalUsd: z
        .number()
        .nonnegative()
        .nullish()
        .transform((value) => value ?? undefined),
});
const actorSchema = z.object({
    id: z.string(),
    name: z.string().optional(),
    username: z.string().optional(),
    title: z.string().optional(),
    description: z.string().nullable().optional(),
    isPublic: z.boolean().optional(),
    pricingInfos: z.array(z.unknown()).optional(),
    defaultRunOptions: z.record(z.string(), z.unknown()).optional(),
});
const storeActorSchema = actorSchema.extend({ stats: z.record(z.string(), z.unknown()).optional() });
const pageFields = {
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    count: z.number().int().nonnegative().optional(),
};

export type ApifyUser = z.infer<typeof userSchema>;
export type ApifyRun = z.infer<typeof runSchema>;
export interface PageOptions {
    limit: number;
    offset: number;
}
export interface RequestOptions {
    method?: "GET" | "POST";
    query?: Record<string, string | number | boolean | undefined>;
    input?: Record<string, unknown>;
}
export type ApifyFetch = (url: string, init: RequestInit) => Promise<Response>;

export class ApifyError extends Error {
    constructor(
        message: string,
        readonly status?: number
    ) {
        super(message);
        this.name = "ApifyError";
    }
}

export function actorId(value: string): string {
    if (!/^[a-zA-Z0-9_-]+(?:[~/][a-zA-Z0-9_-]+)?$/.test(value)) {
        throw new ApifyError("Actor must be an ID or owner/name.");
    }

    return encodeURIComponent(value.replace("/", "~"));
}

function resourceId(value: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
        throw new ApifyError("Resource ID must contain letters, numbers, hyphens or underscores.");
    }

    return encodeURIComponent(value);
}

export function validatePage(page: PageOptions): void {
    if (!Number.isInteger(page.limit) || page.limit < 1 || page.limit > 1000) {
        throw new ApifyError("Limit must be an integer between 1 and 1000.");
    }

    if (!Number.isSafeInteger(page.offset) || page.offset < 0) {
        throw new ApifyError("Offset must be a nonnegative integer.");
    }
}

export function parseInput(text: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = SafeJSON.parse(text, { strict: true });
    } catch {
        throw new ApifyError("Actor input must be valid JSON.");
    }

    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ApifyError("Actor input must be a JSON object.");
    }

    return z.record(z.string(), z.unknown()).parse(value);
}

export function runCosts(runs: ApifyRun[]) {
    const priced = runs.filter((run) => run.usageTotalUsd !== undefined);
    return {
        usageTotalUsd: priced.reduce((total, run) => total + (run.usageTotalUsd ?? 0), 0),
        runsWithCost: priced.length,
        runsWithoutCost: runs.length - priced.length,
        scope: "returned-page",
    };
}

export function sanitizeResult(value: unknown, token?: string): unknown {
    if (typeof value === "string") {
        return token ? value.split(token).join("[redacted]") : value;
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeResult(item, token));
    }

    if (value !== null && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, field]) => [
                token ? key.split(token).join("[redacted]") : key,
                sanitizeResult(field, token),
            ])
        );
    }

    return value;
}

/**
 * The warning a failed POST carries once it may have reached Apify: a paid start may already exist, and a retry can
 * create a second charged run.
 */
function outcomeHint(options: RequestOptions = {}): string {
    return options.method === "POST" ? " The result is unknown; inspect runs before retrying." : "";
}

async function responseText(response: Response): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) {
        throw new ApifyError("Apify returned an empty response.");
    }

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const chunk = await reader.read();
            if (chunk.done) {
                break;
            }

            bytes += chunk.value.byteLength;

            if (bytes > MAX_RESPONSE_BYTES) {
                await reader.cancel();
                throw new ApifyError("Apify response exceeded 16 MiB. Request fewer items or fields.");
            }

            chunks.push(chunk.value);
        }
    } finally {
        reader.releaseLock();
    }

    return Buffer.concat(chunks).toString("utf8");
}

export class ApifyClient {
    private readonly token?: string;
    private readonly fetcher: ApifyFetch;

    constructor(options: { token?: string; fetcher?: ApifyFetch } = {}) {
        this.token = options.token;
        this.fetcher = options.fetcher ?? fetch;
    }

    private async request(endpoint: string, options: RequestOptions = {}): Promise<unknown> {
        const url = new URL(`${ORIGIN}${endpoint}`);
        for (const [key, value] of Object.entries(options.query ?? {})) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }

        const headers: Record<string, string> = { accept: "application/json" };

        if (this.token) {
            headers.authorization = `Bearer ${this.token}`;
        }

        if (options.input !== undefined) {
            headers["content-type"] = "application/json";
        }

        logger.debug(
            { endpoint: sanitizeResult(`${ORIGIN}${endpoint}`, this.token), method: options.method ?? "GET" },
            "apify API request"
        );
        let response: Response;
        try {
            response = await this.fetcher(url.toString(), {
                method: options.method ?? "GET",
                headers,
                body: options.input === undefined ? undefined : SafeJSON.stringify(options.input),
                signal: AbortSignal.timeout(60_000),
                redirect: "error",
            });
        } catch {
            throw new ApifyError(`Apify request failed or timed out.${outcomeHint(options)}`);
        }

        if (!response.ok) {
            await response.body?.cancel();
            const auth =
                response.status === 401 || response.status === 403 ? " Check token permissions or log in again." : "";
            const outcome = response.status >= 500 ? outcomeHint(options) : "";
            throw new ApifyError(`Apify HTTP ${response.status}.${auth}${outcome}`, response.status);
        }

        let text: string;
        try {
            text = await responseText(response);
        } catch (error) {
            const reason =
                error instanceof ApifyError ? error.message : "Apify response failed or timed out while reading.";
            throw new ApifyError(`${reason}${outcomeHint(options)}`);
        }

        let raw: unknown;
        try {
            raw = SafeJSON.parse(text, { strict: true });
        } catch {
            throw new ApifyError(`Apify returned invalid JSON.${outcomeHint(options)}`);
        }

        return sanitizeResult(raw, this.token);
    }

    private async data<T>(endpoint: string, schema: z.ZodType<T>, options?: RequestOptions): Promise<T> {
        const raw = await this.request(endpoint, options);
        const parsed = z.object({ data: schema }).safeParse(raw);
        if (!parsed.success) {
            throw new ApifyError(`Apify returned an unexpected response shape.${outcomeHint(options)}`);
        }

        return parsed.data.data;
    }

    me(): Promise<ApifyUser> {
        return this.data("/users/me", userSchema);
    }

    async search(options: PageOptions & { query: string }) {
        validatePage(options);
        return this.data("/store", z.object({ ...pageFields, items: z.array(storeActorSchema) }), {
            query: { search: options.query, limit: options.limit, offset: options.offset },
        });
    }

    async actor(id: string) {
        return this.data(`/actors/${actorId(id)}`, actorSchema);
    }

    async schema(id: string): Promise<unknown> {
        const build = await this.data(
            `/actors/${actorId(id)}/builds/default`,
            z.object({
                actorDefinition: z.object({ input: z.unknown().optional() }).nullish(),
                inputSchema: z.string().nullish(),
            })
        );
        const schema = build.actorDefinition?.input;
        if (schema != null) {
            return schema;
        }

        if (build.inputSchema) {
            try {
                return sanitizeResult(SafeJSON.parse(build.inputSchema, { strict: true }), this.token);
            } catch {
                throw new ApifyError("This Actor's legacy input schema is invalid JSON.");
            }
        }

        throw new ApifyError("This Actor's default build does not publish an input schema.");
    }

    async start(options: {
        actor: string;
        input: Record<string, unknown>;
        maxCost: number;
        maxItems?: number;
        timeout?: number;
        memory?: number;
        build?: string;
        waitSecs?: number;
    }) {
        if (!Number.isFinite(options.maxCost) || options.maxCost <= 0) {
            throw new ApifyError("Max cost must be a positive USD amount.");
        }

        if (options.maxItems !== undefined && (!Number.isSafeInteger(options.maxItems) || options.maxItems < 1)) {
            throw new ApifyError("Max items must be a positive integer.");
        }

        const timeout = options.timeout ?? 300;
        const memory = options.memory ?? 128;
        const waitSecs = options.waitSecs ?? 0;
        if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 86400) {
            throw new ApifyError("Timeout must be 1 to 86400 seconds.");
        }
        if (!Number.isInteger(memory) || memory < 128 || memory > 32768 || (memory & (memory - 1)) !== 0) {
            throw new ApifyError("Memory must be a power of two from 128 to 32768 MiB.");
        }
        if (!Number.isInteger(waitSecs) || waitSecs < 0 || waitSecs > 45) {
            throw new ApifyError("Wait must be 0 to 45 seconds. Expiry does not abort the run.");
        }
        return this.data(`/actors/${actorId(options.actor)}/runs`, runSchema, {
            method: "POST",
            input: options.input,
            query: {
                maxTotalChargeUsd: options.maxCost,
                maxItems: options.maxItems,
                timeout,
                memory,
                build: options.build,
                waitForFinish: waitSecs,
            },
        });
    }

    async runs(page: PageOptions & { startedAfter?: string; startedBefore?: string; desc?: boolean }) {
        validatePage(page);
        return this.data("/actor-runs", z.object({ ...pageFields, items: z.array(runSchema) }), {
            query: { ...page, desc: page.desc ?? true },
        });
    }

    async run(id: string): Promise<ApifyRun> {
        return this.data(`/actor-runs/${resourceId(id)}`, runSchema);
    }

    async abort(id: string): Promise<ApifyRun> {
        return this.data(`/actor-runs/${resourceId(id)}/abort`, runSchema, { method: "POST" });
    }

    async items(
        options: PageOptions & {
            dataset: string;
            fields?: string;
            omit?: string;
            flatten?: string;
            desc?: boolean;
            clean?: boolean;
        }
    ) {
        validatePage(options);
        const raw = await this.request(`/datasets/${actorId(options.dataset)}/items`, {
            query: {
                limit: options.limit,
                offset: options.offset,
                fields: options.fields,
                format: "json",
                clean: options.clean ?? true,
                omit: options.omit,
                flatten: options.flatten,
                desc: options.desc,
            },
        });
        const parsed = z.array(z.unknown()).safeParse(raw);
        if (!parsed.success) {
            throw new ApifyError("Apify returned an unexpected dataset response.");
        }

        return { items: parsed.data, offset: options.offset, limit: options.limit, count: parsed.data.length };
    }

    usage() {
        return this.data("/users/me/usage/monthly", z.record(z.string(), z.unknown()));
    }
}
