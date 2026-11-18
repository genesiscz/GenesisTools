import { basename, dirname } from "node:path";
import { whoIsCallingHere } from "@genesiscz/utils/agent/caller-identity";
import { gitCommonRoot } from "@genesiscz/utils/agent/identity";
import type { IdentityFacet } from "@genesiscz/utils/agent/identity/types";
import type { Actor } from "@genesiscz/utils/work/model/item";

/** The calling session as an actor, and its project: the folder name of the main checkout. */
export function actorHere(options: { model?: boolean } = {}): { actor: Actor; project: string } {
    // The model facet reads the transcript (about 400 ms); a read that does not record the actor skips it.
    const facets: IdentityFacet[] =
        options.model === false ? ["cwd", "git", "title", "host"] : ["cwd", "git", "title", "model", "host"];
    const identity = whoIsCallingHere({ facets });
    const cwd = identity.cwd ?? process.cwd();
    const common = gitCommonRoot(cwd);
    // The common git dir is `<main checkout>/.git`; the project is the main checkout's folder name.
    const project = common !== null ? basename(dirname(common)) : (identity.project ?? basename(cwd));
    const actor: Actor = {
        kind: identity.isInAgent ? "agent" : "owner",
        harness: identity.agent,
        sessionId: identity.sessionId,
        sessionTitle: identity.sessionTitle ?? null,
        model: identity.model ?? null,
        host: identity.host ?? null,
        subagentId: identity.subagentId ?? null,
        project,
        repoRoot: identity.repoRoot ?? null,
        branch: identity.branch ?? null,
        commitSha: identity.commitSha ?? null,
    };
    return { actor, project };
}

/**
 * The owner at a surface of this Mac (the hub, the widget), when a call comes through the actions service: the
 * service's own environment names whoever started it, never the person who clicked.
 */
export function ownerAtSurface(project: string, surface: string): { actor: Actor; project: string } {
    return {
        actor: {
            kind: "owner",
            harness: surface,
            sessionId: null,
            sessionTitle: null,
            model: null,
            host: null,
            subagentId: null,
            project,
            repoRoot: null,
            branch: null,
            commitSha: null,
        },
        project,
    };
}
