import { keepsHeaders } from "@app/mcp-web-reader/lib/fetch";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import { blockVerdict, describeVerdict } from "./challenge";
import { TRANSPORTS, type TransportOptions } from "./transports";
import type {
    BlockVerdict,
    FetchedPage,
    HttpTransport,
    TransportChoice,
    TransportName,
    TransportResponse,
} from "./types";

const { log } = logger.scoped("fetch");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The page is a bot wall the transport did not pass. Carries every attempt, so the message can say what was tried. */
export class FetchBlockedError extends Error {
    constructor(
        readonly url: string,
        readonly attempts: Array<{ transport: TransportName; status: number; verdict: BlockVerdict }>
    ) {
        super(blockedMessage(url, attempts));
        this.name = "FetchBlockedError";
    }
}

function blockedMessage(
    url: string,
    attempts: Array<{ transport: TransportName; status: number; verdict: BlockVerdict }>
): string {
    const tried = attempts
        .map(
            (attempt) =>
                `${describeVerdict(attempt.verdict, attempt.status)} through the ${attempt.transport} transport`
        )
        .join(", then ");
    const usedChrome = attempts.some((attempt) => attempt.transport === "chrome");
    const hint = usedChrome
        ? "Even the Chrome fingerprint was refused: the site may need a real browser session, or it limits this IP."
        : `Retry with transport "auto" or "chrome" (${toolCommand("fetch", url, "--transport", "auto")}).`;

    return `Blocked: ${url} answered with ${tried}. ${hint}`;
}

export class FetchHttpError extends Error {
    constructor(
        readonly url: string,
        readonly status: number,
        readonly transport: TransportName
    ) {
        super(`HTTP ${status} for ${url} (${transport} transport)`);
        this.name = "FetchHttpError";
    }
}

export interface GetOptions {
    url: string;
    transport: TransportChoice;
    /** Sent only to the origin asked for (or that host upgraded to https), never to another origin a redirect leads to. */
    headers?: Record<string, string>;
    timeoutMs?: number;
    signal?: AbortSignal;
}

export interface FetcherOptions {
    /** Ends the idle chrome sidecar after this many ms. Leave unset in a CLI run, which calls close() itself. */
    idleCloseMs?: number;
    /** Ready transports used instead of creating them from TRANSPORTS (tests pass in-process fakes). */
    transports?: Partial<Record<TransportName, HttpTransport>>;
}

/** Where a redirect points, or null for any other answer. Only http and https addresses are followed. */
function redirectTarget(response: TransportResponse, from: URL): URL | null {
    const location = response.headers.location;
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
        return null;
    }

    const target = URL.parse(location, from);
    if (target === null || (target.protocol !== "http:" && target.protocol !== "https:")) {
        throw new Error(`Refusing the redirect from ${from.href} to ${location}: it is not an http or https address`);
    }

    return target;
}

/**
 * The one fetch path behind `tools fetch`, its MCP server and the genesis-tools `fetch_*` group. It owns the
 * transports it creates (the chrome one holds a Python sidecar), so every owner calls close() when done.
 */
export class Fetcher {
    private readonly transports = new Map<TransportName, HttpTransport>();
    private readonly transportOptions: TransportOptions;

    constructor(options: FetcherOptions = {}) {
        this.transportOptions = { chrome: { idleCloseMs: options.idleCloseMs } };
        for (const transport of Object.values(options.transports ?? {})) {
            this.transports.set(transport.name, transport);
        }
    }

    /**
     * GET a page. `plain` and `chrome` use that transport; `auto` tries plain and retries once through chrome when
     * plain gets a block status (403, 429, 503) or a recognised challenge page. A challenge the last transport did not
     * pass throws FetchBlockedError instead of returning the challenge as content; any other non-2xx throws
     * FetchHttpError.
     */
    async get(options: GetOptions): Promise<FetchedPage> {
        if (options.transport !== "auto") {
            const page = await this.follow(options.transport, options);
            this.assertUsable(page, []);
            return page;
        }

        const plain = await this.follow("plain", options);
        const verdict = blockVerdict(plain);
        if (!verdict) {
            this.assertUsable(plain, []);
            return plain;
        }

        log.debug(
            { url: options.url, status: plain.status, vendor: verdict.vendor, signal: verdict.signal },
            "fetch: plain transport refused, retrying through chrome"
        );
        const chrome = await this.follow("chrome", options);
        const escalated: FetchedPage = {
            ...chrome,
            escalation: { from: "plain", status: plain.status, reason: verdict },
        };
        this.assertUsable(escalated, [{ transport: "plain", status: plain.status, verdict }]);
        return escalated;
    }

    async close(): Promise<void> {
        const open = [...this.transports.values()];
        this.transports.clear();
        await Promise.all(open.map((transport) => transport.close()));
    }

    async [Symbol.asyncDispose](): Promise<void> {
        await this.close();
    }

    private transport(name: TransportName): HttpTransport {
        let transport = this.transports.get(name);
        if (!transport) {
            transport = TRANSPORTS[name](this.transportOptions);
            this.transports.set(name, transport);
        }

        return transport;
    }

    private assertUsable(
        page: FetchedPage,
        earlier: Array<{ transport: TransportName; status: number; verdict: BlockVerdict }>
    ): void {
        const verdict = blockVerdict(page);
        if (verdict) {
            throw new FetchBlockedError(page.url, [
                ...earlier,
                { transport: page.transport, status: page.status, verdict },
            ]);
        }

        if (page.status < 200 || page.status >= 300) {
            throw new FetchHttpError(page.url, page.status, page.transport);
        }
    }

    /** One request through `name`, following up to 5 redirects by hand so caller headers stay with their origin. */
    private async follow(name: TransportName, options: GetOptions): Promise<FetchedPage> {
        const transport = this.transport(name);
        const start = new URL(options.url);
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let current = start;

        log.debug({ url: options.url, transport: name, headerNames: Object.keys(options.headers ?? {}) }, "fetch get");

        for (let redirects = 0; ; redirects++) {
            options.signal?.throwIfAborted();
            const started = performance.now();
            const response = await transport.send({
                url: current.href,
                headers: keepsHeaders(start, current) ? (options.headers ?? {}) : {},
                timeoutMs,
                signal: options.signal,
            });
            log.debug(
                {
                    url: current.href,
                    transport: name,
                    status: response.status,
                    chars: response.body.length,
                    ms: Math.round(performance.now() - started),
                },
                "fetch response"
            );
            const next = redirectTarget(response, current);
            if (next === null) {
                return { url: current.href, ...response, transport: name };
            }

            if (redirects >= MAX_REDIRECTS) {
                throw new Error(`More than ${MAX_REDIRECTS} redirects for ${options.url}`);
            }

            current = next;
        }
    }
}
