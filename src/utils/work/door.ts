/**
 * The seam between the actions registry's `work` area and the work tool (work-items P7). The area lives in
 * `src/utils` and cannot import the tool, which owns the session (the caller's identity, the old handoff store, the
 * delivery to a session, the connectors). The tool registers its door when it starts; with none registered, the area's
 * way passes with a reason.
 */
import type { Reply } from "@genesiscz/utils/output/reply";
import type { WorkMethodName } from "./api";

/** The per-call options every door takes beside the params. */
export interface WorkDoorCall {
    request?: string;
    dryRun?: boolean;
    ownerSaid?: string;
    /**
     * Set by the `work` area when the call came through the actions service from a person at a surface (the hub):
     * the write is the owner's, in this project. Absent: the caller is this process, as for the CLI.
     */
    atSurface?: { project: string };
}

export interface WorkDoor {
    call(method: WorkMethodName, params: unknown, options?: WorkDoorCall): Promise<Reply<unknown>>;
}

let registered: WorkDoor | null = null;

export function registerWorkDoor(door: WorkDoor | null): void {
    registered = door;
}

export function workDoor(): WorkDoor | null {
    return registered;
}
