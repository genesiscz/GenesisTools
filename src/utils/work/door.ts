/**
 * The seam between the actions registry's `work` area and the work tool (work-items P7). The area lives in
 * `src/utils` and cannot import the tool, which owns the session (the caller's identity, the old handoff store, the
 * delivery to a session, the connectors). The tool registers its door when it starts; with none registered, the area's
 * way passes with a reason.
 */
import type { Reply } from "@genesiscz/utils/output/reply";
import { z } from "zod";
import type { WorkMethodName } from "./api";

/** The per-call options every door takes beside the params. */
export interface WorkDoorCall {
    request?: string;
    dryRun?: boolean;
    ownerSaid?: string;
    /** Why this session does a write that a role rule refuses. */
    override?: string;
    /**
     * Set by the `work` area when the call came through the actions service from a person at a surface (the hub):
     * the write is the owner's, in this project. Absent: the caller is this process, as for the CLI.
     */
    atSurface?: { project: string };
}

/**
 * The per-call options as the MCP tools and the REPL's `work` global take them, beside a write's own params. The CLI
 * takes them as flags of the same names (`--request-id`, `--dry-run`, `--owner-said`, `--override`).
 */
export const workCallEnvelope = z.object({
    requestId: z.string().optional().describe("a repeat with the same id answers the stored reply and writes nothing"),
    dryRun: z.boolean().optional().describe("answer the changes, write nothing"),
    ownerSaid: z.string().optional().describe("the owner's words when you act on them"),
    override: z
        .string()
        .optional()
        .describe("why this session does a write that a role rule refuses; the journal keeps who did it and why"),
});

/** The door options of the envelope keys in `args`; a key of another type counts as not given. */
export function callOptionsOf(args: Record<string, unknown>): Omit<WorkDoorCall, "atSurface"> {
    return {
        ...(typeof args.requestId === "string" ? { request: args.requestId } : {}),
        ...(args.dryRun === true ? { dryRun: true } : {}),
        ...(typeof args.ownerSaid === "string" ? { ownerSaid: args.ownerSaid } : {}),
        ...(typeof args.override === "string" ? { override: args.override } : {}),
    };
}

/** The method's own params: `args` without the envelope keys. */
export function withoutCallOptions(args: Record<string, unknown>): Record<string, unknown> {
    const { requestId: _r, dryRun: _d, ownerSaid: _o, override: _v, ...rest } = args;
    return rest;
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
