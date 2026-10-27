import { existsSync, realpathSync, unlinkSync } from "node:fs";
import { parseArgs } from "node:util";
import { newestLoadedModuleMtime } from "@genesiscz/utils/bun/loaded-modules";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import {
    HOSTED_DRAINING_LINE,
    HOSTED_PEER_HEADER,
    HOSTED_READY_LINE,
    type HostedHandler,
    type HostedPeer,
} from "./hosted-protocol";

/**
 * One hosted MCP server in its own process, behind the gateway (`hosted.ts`). The gateway used to import the server
 * into itself, and a launchd gateway runs for days: on 2026-10-27 it still served the code of 2026-10-19, so agents
 * wrote the decision log with a week-old store. A server's child entry (`src/genesis-tools-mcp/hosted-child.ts`)
 * imports its handler STATICALLY (a dynamic `import()` is not in `require.cache`, so its edits would go unseen) and
 * calls this: it serves the handler on `--socket` and exits once a module it loaded under `--source-root` changes
 * (the hub server's rule): it stops listening, prints `draining`, lets the requests in flight finish, and the gateway
 * starts the new code for the next call.
 */
export async function runHostedChild(serve: HostedHandler): Promise<void> {
    const { values } = parseArgs({
        options: {
            socket: { type: "string" },
            "source-root": { type: "string" },
            "check-ms": { type: "string" },
        },
        strict: false,
    });
    const socket = typeof values.socket === "string" ? values.socket : undefined;
    const root = typeof values["source-root"] === "string" ? values["source-root"] : undefined;

    if (!socket || !root) {
        throw new Error("a hosted child needs --socket and --source-root");
    }

    // `require.cache` holds real paths (/private/var/…, not /var/…).
    const sourceRoot = realpathSync(root);
    const log = logger.child({ component: "mcp-gateway:hosted-child", socket });
    const startedAt = Date.now();
    const parentPid = process.ppid;

    if (existsSync(socket)) {
        unlinkSync(socket);
    }

    const peerOf = (request: Request): HostedPeer | null => {
        const raw = request.headers.get(HOSTED_PEER_HEADER);

        if (!raw) {
            return null;
        }

        try {
            const value: unknown = SafeJSON.parse(raw, { strict: true });

            if (
                typeof value === "object" &&
                value !== null &&
                "clientPort" in value &&
                "serverPort" in value &&
                typeof value.clientPort === "number" &&
                typeof value.serverPort === "number"
            ) {
                return { clientPort: value.clientPort, serverPort: value.serverPort };
            }
        } catch (error) {
            log.warn({ error }, "hosted child: unreadable peer header");
        }

        return null;
    };

    const server = Bun.serve({
        unix: socket,
        fetch(request, self) {
            // A blocking tool (question_wait) stays silent longer than Bun's idle default; its own deadline governs.
            self.timeout(request, 0);
            const headers = new Headers(request.headers);
            const peer = peerOf(request);
            headers.delete(HOSTED_PEER_HEADER);
            return serve(new Request(request, { headers }), peer);
        },
    });

    log.info({ pid: process.pid, sourceRoot }, "hosted MCP server listening");
    process.stdout.write(`${HOSTED_READY_LINE}\n`);
    let draining = false;

    const drain = async (reason: string): Promise<void> => {
        if (draining) {
            return;
        }

        draining = true;
        log.info({ reason }, "hosted MCP server draining");
        process.stdout.write(`${HOSTED_DRAINING_LINE}\n`);

        try {
            unlinkSync(socket);
        } catch (error) {
            log.debug({ error }, "hosted child: socket already gone");
        }

        // Stops listening at once and resolves when the requests in flight have ended.
        await server.stop(false);
        process.exit(0);
    };

    const checkMs = Number.parseInt(typeof values["check-ms"] === "string" ? values["check-ms"] : "", 10);
    setInterval(
        () => {
            if (process.ppid !== parentPid) {
                void drain("the gateway exited");
                return;
            }

            if (newestLoadedModuleMtime(sourceRoot) > startedAt) {
                void drain("code changed");
            }
        },
        Number.isFinite(checkMs) && checkMs >= 100 ? checkMs : 5_000
    );
}
