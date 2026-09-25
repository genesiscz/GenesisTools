/**
 * The native-messaging host. The browser starts it through the launcher that
 * `tools browser-extension install-host` writes, with the caller's origin as the first argument,
 * and talks to it in length-prefixed JSON frames on stdin and stdout.
 *
 * stdout carries frames only. Diagnostics go to the log file and stderr, never to stdout.
 */
import { logger } from "@genesiscz/utils/logger";
import { liveDeps } from "../lib/deps";
import { dispatch } from "../lib/host/dispatch";
import { pinnedExtensionId } from "../lib/host/install";
import { encodeFrame, FrameReader } from "../lib/host/protocol";

const log = logger.child({ component: "browser-extension/host" });

function writeFrame(message: unknown): void {
    process.stdout.write(encodeFrame(message));
}

async function main(): Promise<void> {
    const origin = process.argv[2] ?? "";
    const allowed = `chrome-extension://${pinnedExtensionId()}/`;

    if (origin !== allowed) {
        log.warn({ origin, allowed }, "native host started by an unexpected caller; refusing");
        writeFrame({ ok: false, code: "invalid", error: "this host only answers the GenesisTools extension" });
        return;
    }

    log.info({ pid: process.pid }, "native host started");
    const deps = liveDeps();
    const reader = new FrameReader();
    let pending = Promise.resolve();

    for await (const chunk of Bun.stdin.stream()) {
        let messages: unknown[];

        try {
            messages = reader.push(chunk);
        } catch (error) {
            log.warn({ error }, "unreadable frame; closing");
            writeFrame({ ok: false, code: "invalid", error: error instanceof Error ? error.message : String(error) });
            break;
        }

        for (const message of messages) {
            // Answer in order: the extension matches one reply to one request per port.
            pending = pending.then(async () => writeFrame(await dispatch(deps, message)));
        }
    }

    await pending;
    log.info({ pid: process.pid }, "native host stdin closed");
}

await main();
