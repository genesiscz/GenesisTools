import type { GateLedgerDto, GateRaiseReceiptDto } from "@app/dev-dashboard/contract/gates";
import { type GateLedgerDeps, readGateLedger } from "@genesiscz/utils/audit/gate-ledger";
import { spawnToolDetached } from "@genesiscz/utils/cli";
import { logger } from "@genesiscz/utils/logger";

/**
 * The Touch ID waiting card (F22). `gateLedger` is the read the phone's card and `tools hub gates` show; `raiseGate`
 * is its one button. A raise never answers a gate: an rm request without a window gets its window (`tools rm ask`,
 * the agent's verb that only opens it), and an open window is asked to come to the front. The person decides at the
 * Mac.
 */

export function gateLedger(deps?: GateLedgerDeps): GateLedgerDto {
    return readGateLedger(deps);
}

export interface GateRaiseDeps {
    ledger?: () => GateLedgerDto;
    /** Opens the window of an rm request. Default: `tools rm ask <id>`, detached (it waits up to 180 s). */
    openRmWindow?: (requestId: string) => void;
    /** Asks macOS to bring a process to the front; answers what macOS said. */
    activate?: (pid: number) => Promise<string>;
}

/** JXA through `osascript`: `NSRunningApplication.activate` needs no privacy grant. */
async function activateProcess(pid: number): Promise<string> {
    const script = [
        "ObjC.import('AppKit');",
        `var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid});`,
        "app.isNil() ? 'gone' : (app.activateWithOptions($.NSApplicationActivateAllWindows) ? 'ok' : 'refused');",
    ].join(" ");
    const proc = Bun.spawn(["/usr/bin/osascript", "-l", "JavaScript", "-e", script], {
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    logger.debug({ pid, code, stdout: stdout.trim(), stderr: stderr.trim() }, "gates: activate a window process");
    return code === 0 ? stdout.trim() : `failed: ${stderr.trim() || `exit ${code}`}`;
}

/** Raises one waiting gate by its ledger id. An id the ledger no longer lists answers `gone`. */
export async function raiseGate(id: string, deps: GateRaiseDeps = {}): Promise<GateRaiseReceiptDto> {
    const wait = (deps.ledger ?? gateLedger)().pending.find((entry) => entry.id === id);

    if (!wait) {
        return { id, outcome: "gone", detail: "Nothing waits under this id any more." };
    }

    if (!wait.window) {
        if (!wait.request) {
            return { id, outcome: "gone", detail: "The window closed." };
        }

        const open =
            deps.openRmWindow ?? ((requestId) => spawnToolDetached(["rm", "ask", requestId], { reparent: true }));
        open(wait.request.id);
        logger.info({ id, request: wait.request.id }, "gates: opened the approval window of an rm request");
        return { id, outcome: "opened", detail: "The approval window is open on the Mac for the next 3 minutes." };
    }

    const said = await (deps.activate ?? activateProcess)(wait.window.pid);
    logger.info({ id, pid: wait.window.pid, said }, "gates: asked macOS to bring a waiting window to the front");

    if (said === "gone") {
        return { id, outcome: "gone", detail: "The window closed." };
    }

    return {
        id,
        outcome: "asked",
        detail:
            said === "ok"
                ? "macOS brought the window to the front."
                : "macOS was asked to bring the window to the front; it may stay behind the app in use.",
    };
}
