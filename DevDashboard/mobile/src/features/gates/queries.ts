import { type DashboardClient, ENDPOINTS, type GateLedgerDto, type GateRaiseReceiptDto, type GateWaitDto } from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const gatesKeys = { ledger: ["gates", "ledger"] as const };

/** A window gives up after 170 s, so the card polls fast while it is on screen. */
export const GATES_INTERVAL_MS = 5_000;

export function gatesQuery(client: DashboardClient) {
    return queryOptions<GateLedgerDto>({
        queryKey: gatesKeys.ledger,
        queryFn: () => client.call(ENDPOINTS.gatewayGates, {}),
        refetchInterval: GATES_INTERVAL_MS,
    });
}

export function raiseGate(client: DashboardClient, input: { id: string; idempotencyKey: string }): Promise<GateRaiseReceiptDto> {
    return client.call(ENDPOINTS.gatesRaise, { id: input.id }, { idempotencyKey: input.idempotencyKey });
}

/** "2 min 10 s left" for an open window, or how long an rm request has waited. */
export function waitLine(wait: GateWaitDto, now: number): string {
    if (wait.window) {
        const left = Math.max(0, Math.round((Date.parse(wait.window.deadline) - now) / 1000));
        return left >= 60 ? `${Math.floor(left / 60)} min ${left % 60} s left` : `${left} s left`;
    }

    const minutes = Math.max(0, Math.round((now - Date.parse(wait.askedAt)) / 60_000));
    const waited = minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
    return `no window, waiting ${waited}`;
}

/** The size of an rm request's paths, when the Mac measured them. */
export function requestBytes(wait: GateWaitDto): number | null {
    const sizes = wait.request?.paths.map((path) => path.bytes).filter((bytes): bytes is number => bytes !== undefined);
    return sizes && sizes.length > 0 ? sizes.reduce((sum, bytes) => sum + bytes, 0) : null;
}

export const GATE_LABELS: Readonly<Record<GateWaitDto["gate"], string>> = {
    vault: "Vault key",
    "ai-account": "AI account",
    rm: "Delete request",
};
