import { logger } from "@genesiscz/utils/logger";

/**
 * How long the loopback listener waits for the browser to come back.
 *
 * Long enough for a sign-in that needs a password manager and a second factor,
 * short enough that an abandoned tab hands the terminal back to the paste
 * prompt while the user is still looking at it. Nothing is lost when it fires:
 * the authorization URL is still open in the browser, and the paste flow that
 * ran before this listener existed accepts the very same callback URL.
 */
export const CALLBACK_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Host names a browser may legitimately use to reach a loopback redirect URI.
 * The socket binds `127.0.0.1`, so this only refuses a page that pointed its own
 * domain at the loopback address to reach the port (DNS rebinding).
 */
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export interface CallbackParams {
    code: string;
    /** Absent when the provider left `state` off the callback. */
    state: string | undefined;
}

/**
 * What the listener hands back:
 * - the parameters, when a usable callback arrived,
 * - `{ error }`, when a callback arrived that must not be exchanged,
 * - `null`, when none arrived before the deadline or the flow closed it first.
 *
 * The three are distinct because they lead somewhere different: exchange,
 * refuse the login, and fall back to the paste prompt.
 */
export type CallbackResult = CallbackParams | { error: string } | null;

export interface CallbackListener {
    readonly port: number;
    readonly hostname: string;
    readonly callback: Promise<CallbackResult>;
    /** Idempotent, never throws, and always settles a still-pending `callback`. */
    close(): Promise<void>;
}

export interface CallbackListenerOptions {
    /** The redirect URI registered with the provider; its port and path are what get served. */
    redirectUri: string;
    /**
     * Decide from its `state` whether a callback belongs to the waiting sign-in.
     * Returning a message refuses the request WITHOUT settling the listener.
     *
     * Required, not optional. A listener without one accepts anything that
     * reaches the port, and accepting is what ends a login.
     */
    verifyState(state: string | undefined): string | undefined;
    /** Overrides the redirect URI's port. Tests pass 0 to take an ephemeral one. */
    port?: number;
    timeoutMs?: number;
    /** Shown on the success/error HTML. Callers that own the page (mcp-manager) pass this. */
    brand?: CallbackBrand;
}

export interface CallbackBrand {
    app: string;
    product: string;
}

export type StartCallbackListener = (options: CallbackListenerOptions) => Promise<CallbackListener | null>;

/**
 * Both arguments are always literals from this file. Nothing from the request
 * reaches the page, so an authorization code or a provider-supplied error string
 * can never be reflected into the browser and there is nothing to escape.
 */
function markSvg(): string {
    // Same family as GenesisTools AppIcon: dark rounded square, amber ring, sparkles.
    return `<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 72 72" aria-hidden="true">
<defs>
  <linearGradient id="ring" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffbd33"/>
    <stop offset="1" stop-color="#ff751a"/>
  </linearGradient>
</defs>
<rect x="6" y="6" width="60" height="60" rx="16" fill="#0f1219" stroke="rgba(255,255,255,0.08)"/>
<circle cx="36" cy="36" r="22" fill="none" stroke="url(#ring)" stroke-width="3"/>
<g fill="#ffc44a">
  <path d="M36 18l2.2 8.4L46 28.6l-7.8 4.2L36 42l-2.2-9.2L26 28.6l7.8-2.2z"/>
  <path d="M50 34l1.1 4.1L55 39.3l-3.9 2.1L50 46l-1.1-4.6L45 39.3l3.9-1.2z" opacity="0.85"/>
  <path d="M22 30l0.9 3.2L26 34.1l-3.1 1.6L22 39l-0.9-3.3L18 34.1l3.1-0.9z" opacity="0.75"/>
</g>
</svg>`;
}

function page(title: string, detail: string, brand?: CallbackBrand): string {
    const header = brand ? `<div class="mark">${markSvg()}</div><p class="app">${brand.app}</p>` : "";
    const footer = brand ? `<footer>${brand.app} · ${brand.product}</footer>` : "";

    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${title}</title><style>
body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0b0d10;color:#e6e9ef;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
main{max-width:26rem;text-align:center;padding:0 1.5rem}
.mark{margin:0 auto 1rem}.app{margin:0 0 1.25rem;color:#ffc44a;font-size:.8rem;letter-spacing:.12em;text-transform:uppercase}
h1{font-size:1.25rem;margin:0 0 .5rem;font-weight:600}p{margin:0;color:#9aa4b2}
footer{margin-top:2rem;color:#6b7380;font-size:.75rem}
</style></head>
<body><main>${header}<h1>${title}</h1><p>${detail}</p>${footer}</main></body>
</html>`;
}

/**
 * Serve the provider's redirect URI on loopback for the length of one login.
 *
 * Returns `null` when the port cannot be bound. That is not a failure: the port
 * is the vendor's fixed one (the official CLI listens on it too), so a
 * concurrent login is an ordinary collision, and the caller's paste prompt is a
 * complete flow on its own. A login must never die because a socket was taken.
 */
export async function startCallbackListener(options: CallbackListenerOptions): Promise<CallbackListener | null> {
    const redirect = new URL(options.redirectUri);
    const port = options.port ?? Number(redirect.port);
    const path = redirect.pathname;

    let settle!: (result: CallbackResult) => void;
    const callback = new Promise<CallbackResult>((resolve) => {
        settle = resolve;
    });
    let settled = false;
    let server: ReturnType<typeof Bun.serve> | undefined;
    /** The requested port until the bind lands; after it, the one actually held. */
    let bound = port;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closing: Promise<void> | undefined;

    /**
     * Teardown, written before the happy path and reached from every exit: one
     * served callback, a refusal, the deadline, an abort, or a `finally` while
     * the caller unwinds from an unrelated throw. It never throws, so it cannot
     * replace the reason the login is failing, and it never leaves `callback`
     * pending, so a caller awaiting it is always released.
     */
    async function shutdown(): Promise<void> {
        clearTimeout(timer);

        if (!settled) {
            settled = true;
            settle(null);
        }

        try {
            await server?.stop();
        } catch (error) {
            logger.warn({ error, port: bound }, "[oauth] could not stop the callback listener");
        }
    }

    function close(): Promise<void> {
        // One shared promise, so a second caller waits for the first shutdown to
        // finish rather than returning while the socket is still bound.
        closing ??= shutdown();
        return closing;
    }

    function finish(result: CallbackResult): void {
        if (settled) {
            return;
        }

        settled = true;
        settle(result);
        // The response has not been written yet; a microtask lets Bun flush it,
        // and `stop()` without force never cuts a request already in flight.
        queueMicrotask(() => void close());
    }

    function respond(status: number, title: string, detail: string): Response {
        return new Response(page(title, detail, options.brand), {
            status,
            headers: { "content-type": "text/html; charset=utf-8" },
        });
    }

    function handle(request: Request): Response {
        const url = new URL(request.url);
        const host = request.headers.get("host")?.replace(/:\d+$/, "") ?? "";

        if (!LOOPBACK_HOSTS.has(host)) {
            logger.warn({ host, port: bound }, "[oauth] refused a callback request that used a foreign host name");
            return respond(403, "Not this address", "Open the sign-in link from the terminal that started it.");
        }

        if (url.pathname !== path) {
            return respond(404, "Nothing here", "This address is not part of the sign-in.");
        }

        // A settle-once latch is right here and wrong in a server that expects
        // reconnects: this one serves a single callback and then closes, so
        // there is no later peer to lock out.
        if (settled) {
            return respond(410, "Already finished", "This sign-in already completed. You can close this tab.");
        }

        // `state` says whether this request belongs to the waiting sign-in, so it
        // is checked BEFORE the request is read as a success or as an error. A
        // refusal answers 400 and leaves the listener waiting: any local process
        // can reach a loopback port, and one that could SETTLE it would end a
        // sign-in the user had just completed in the browser. Only the deadline
        // closes an unclaimed listener.
        //
        // The trade: a genuine provider error that arrives with no `state` is now
        // ignored until that deadline, and the login falls back to the paste
        // prompt instead of reporting it. Losing that message is the cheaper
        // failure.
        const state = url.searchParams.get("state") ?? undefined;
        const refusal = options.verifyState(state);

        if (refusal) {
            logger.warn({ port: bound, refusal }, "[oauth] ignored a callback that is not part of this sign-in");
            return respond(400, "Sign-in refused", "This callback belongs to a different sign-in. Check the terminal.");
        }

        const failure = url.searchParams.get("error");

        if (failure) {
            const description = url.searchParams.get("error_description");
            finish({ error: description ? `${failure}: ${description}` : failure });
            return respond(400, "Authorization refused", "The provider refused the sign-in. Check the terminal.");
        }

        const code = url.searchParams.get("code");

        if (!code) {
            finish({ error: "The callback carried no `code` parameter." });
            return respond(400, "Incomplete callback", "No authorization code arrived. Check the terminal.");
        }

        finish({ code, state });
        return respond(200, "Signed in", "You can close this tab and go back to the terminal.");
    }

    let listening: ReturnType<typeof Bun.serve>;
    try {
        listening = Bun.serve({
            // Loopback only, explicitly. This socket accepts an authorization code.
            hostname: "127.0.0.1",
            port,
            // A shared port must collide rather than silently load-balance, or the
            // fallback below never runs and the callback goes to the other listener.
            reusePort: false,
            development: false,
            fetch: handle,
            error(error) {
                logger.warn({ error, port: bound }, "[oauth] callback listener failed to answer a request");
                return respond(500, "Something went wrong", "Go back to the terminal and paste the code instead.");
            },
        });
    } catch (error) {
        logger.info(
            { error, port: bound },
            "[oauth] callback port unavailable; the login falls back to the paste prompt"
        );
        return null;
    }

    server = listening;
    const boundPort = listening.port;
    const boundHostname = listening.hostname;

    // Bun leaves both undefined only for a unix socket, which this never binds.
    // Treating that as a failed bind beats inventing an address nothing serves.
    if (boundPort === undefined || boundHostname === undefined) {
        logger.warn({ port }, "[oauth] the callback listener bound without a reachable address");
        await close();
        return null;
    }

    bound = boundPort;
    timer = setTimeout(() => {
        logger.info({ port: bound }, "[oauth] no browser callback before the deadline; closing the listener");
        void close();
    }, options.timeoutMs ?? CALLBACK_TIMEOUT_MS);

    logger.debug({ port: bound, path }, "[oauth] loopback callback listener is up");

    return { port: boundPort, hostname: boundHostname, callback, close };
}
