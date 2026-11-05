/**
 * The Touch ID waiting card (F22): everything that waits on the Mac's sensor, read from the gate ledger
 * (`@genesiscz/utils/audit/gate-ledger`). Types only (`contract-purity.test.ts`); the ledger's own types are not
 * imported, so the phone's `tsc` does not walk the rm and audit modules.
 */

export type GateKindDto = "vault" | "ai-account" | "rm";

export interface GateWindowDto {
    pid: number;
    openedAt: string;
    deadline: string;
}

export interface GateRmRequestDto {
    id: string;
    reason: string | null;
    paths: Array<{ path: string; bytes?: number; reason: string }>;
    /** Null for a request whose files already wait aside: it never expires. */
    expiresAt: string | null;
}

export interface GateWaitDto {
    id: string;
    gate: GateKindDto;
    title: string;
    who: string | null;
    askedAt: string;
    window: GateWindowDto | null;
    request: GateRmRequestDto | null;
    account?: string;
    provider?: string;
}

export interface GateDecisionDto {
    gate: GateKindDto;
    event: string;
    at: string;
    who: string | null;
    title: string;
}

export interface GateLedgerDto {
    pending: GateWaitDto[];
    recent: GateDecisionDto[];
}

/**
 * What a raise did. `opened`: an rm request had no window, and the Mac opened one (`tools rm ask`). `asked`: macOS
 * was asked to bring the open window to the front (it may keep it behind the app in use). `gone`: the id no longer
 * waits. The decision itself stays on the Mac.
 */
export type GateRaiseOutcome = "opened" | "asked" | "gone";

export interface GateRaiseReceiptDto {
    id: string;
    outcome: GateRaiseOutcome;
    detail: string;
}
