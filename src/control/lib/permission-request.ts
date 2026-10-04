import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { logger } from "@genesiscz/utils/logger";
import {
    type AxLivePermissions,
    holderName,
    type PermissionCheck,
    type ResponsibleHolder,
    tccResetCommand,
} from "./permissions";

/** The grants `tools control permissions request` can ask macOS for. */
export type RequestableGrant = "accessibility" | "screen-recording";

/** Whether ax-tool delivered the request to macOS; `error` says why it did not. */
export interface PermissionPromptResult {
    ok: boolean;
    error?: string;
}

/** Everything the request touches outside this process: the probe, the prompt, the pane, time. */
export interface PermissionRequestBoundary {
    /** Live grant state of the identity every ax-tool spawn runs as, or null when the probe failed. */
    probe(): AxLivePermissions | null;
    /** Asks macOS; the system shows its dialog only while the grant was never decided. */
    prompt(grant: RequestableGrant): PermissionPromptResult;
    openPane(grant: RequestableGrant): void;
    sleep(ms: number, signal: AbortSignal): Promise<void>;
    now(): number;
}

export interface PermissionRequestOutcome {
    granted: RequestableGrant[];
    missing: RequestableGrant[];
}

/** How long the request waits for EACH missing grant, so two grants wait at most twice this. */
export const PERMISSION_REQUEST_TIMEOUT_MS = 120_000;
/** One `ax-tool permissions` spawn per poll; a second apart is fast enough for a person's click. */
const MIN_POLL_MS = 1_000;

function isRequestable(check: PermissionCheck): check is PermissionCheck & { id: RequestableGrant } {
    return check.id === "accessibility" || check.id === "screen-recording";
}

function isLive(live: AxLivePermissions | null, grant: RequestableGrant): boolean {
    return grant === "accessibility" ? live?.accessibility === true : live?.screenRecording === true;
}

/**
 * Asks macOS for each missing grant of the identity every ax-tool spawn runs as, opens its pane,
 * and waits until the grant is live, up to `timeoutMs` per grant. Every poll counts each pending
 * grant, so one turned on while the wait is on another is never reported missing. A denied grant
 * is never prompted: macOS keeps a denial and shows no dialog again, so the pane or a
 * `tccutil reset` is the only way back. Automation is not requested here; macOS asks per target
 * app on the first Apple event.
 */
export async function requestPermissions(input: {
    checks: PermissionCheck[];
    holder: ResponsibleHolder;
    boundary: PermissionRequestBoundary;
    signal: AbortSignal;
    say: (line: string) => void;
    timeoutMs?: number;
    intervalMs?: number;
}): Promise<PermissionRequestOutcome> {
    const { boundary, holder, signal, say } = input;
    const timeoutMs = input.timeoutMs ?? PERMISSION_REQUEST_TIMEOUT_MS;
    const intervalMs = Math.max(MIN_POLL_MS, input.intervalMs ?? MIN_POLL_MS);
    const name = holderName(holder);
    const requestable = input.checks.filter(isRequestable);
    const granted = new Set<RequestableGrant>(requestable.filter((c) => c.status === "granted").map((c) => c.id));
    const pending = requestable.filter((c) => c.status !== "granted");

    if (pending.length === 0) {
        say(`Accessibility and Screen Recording are already granted to ${name}.`);
        return { granted: [...granted], missing: [] };
    }

    const record = (live: AxLivePermissions | null): void => {
        for (const check of pending) {
            if (!granted.has(check.id) && isLive(live, check.id)) {
                granted.add(check.id);
                say(`✓ ${check.label} is now granted to ${name}.`);
            }
        }
    };

    for (const check of pending) {
        if (signal.aborted) {
            break;
        }

        // Turned on while an earlier grant was waited on: nothing left to ask for.
        if (granted.has(check.id)) {
            continue;
        }

        askFor({ check, holder, boundary, say });
        boundary.openPane(check.id);
        logger.debug({ grant: check.id, status: check.status, holder: name }, "permission request: waiting");

        // A deadline per grant: a shared one left a later grant no time once an earlier one timed out.
        await waitUntilLive({
            isDone: () => granted.has(check.id),
            record,
            boundary,
            signal,
            deadline: boundary.now() + timeoutMs,
            intervalMs,
        });
    }

    const missing = pending.map((check) => check.id).filter((id) => !granted.has(id));

    if (missing.length > 0) {
        const labels = pending.filter((check) => missing.includes(check.id)).map((check) => check.label);
        const why = signal.aborted ? "Stopped" : `Still missing after ${Math.round(timeoutMs / 1000)} s`;
        say(
            `${why}: ${labels.join(", ")}. Turn on ${name} in the pane, then run \`${toolCommand("control doctor")}\`.`
        );
    }

    return { granted: requestable.map((check) => check.id).filter((id) => granted.has(id)), missing };
}

function askFor(input: {
    check: PermissionCheck & { id: RequestableGrant };
    holder: ResponsibleHolder;
    boundary: PermissionRequestBoundary;
    say: (line: string) => void;
}): void {
    const { check, holder, boundary, say } = input;
    const name = holderName(holder);

    if (check.status === "denied") {
        const reset = tccResetCommand(check.id, holder);
        say(
            `${check.label} is denied for ${name}, and macOS will not ask again. Turn on ${name} in the pane that opens${reset ? `, or run \`${reset}\` and then \`${toolCommand("control permissions request")}\` again` : ""}.`
        );
    } else {
        const prompted = boundary.prompt(check.id);

        if (prompted.ok) {
            say(
                `Asked macOS for ${check.label} for ${name}. Answer the dialog, or turn on ${name} in the pane that opens; add it with + if it is not listed.`
            );
        } else {
            // No dialog will appear, so the pane is the only way: say so instead of "Asked macOS".
            say(
                `ax-tool could not ask macOS for ${check.label} (${prompted.error ?? "no error given"}). Turn on ${name} in the pane that opens; add it with + if it is not listed.`
            );
        }
    }

    if (check.id === "screen-recording") {
        say(`macOS applies Screen Recording to ${name} after a restart: once it is on, quit and reopen ${name}.`);
    }
}

/**
 * Polls the live probe at least a second apart, handing every result to `record`, until `isDone`,
 * the deadline passes or Ctrl-C.
 */
async function waitUntilLive(input: {
    isDone: () => boolean;
    record: (live: AxLivePermissions | null) => void;
    boundary: PermissionRequestBoundary;
    signal: AbortSignal;
    deadline: number;
    intervalMs: number;
}): Promise<void> {
    const { isDone, record, boundary, signal, deadline, intervalMs } = input;

    while (!signal.aborted && !isDone()) {
        const remaining = deadline - boundary.now();

        if (remaining <= 0) {
            return;
        }

        try {
            await boundary.sleep(Math.min(intervalMs, remaining), signal);
        } catch (error) {
            logger.debug({ error }, "permission request: wait interrupted");
            return;
        }

        record(boundary.probe());
    }
}
