import { describe, expect, test } from "bun:test";
import { executeHandoffActions, getHandoff, listHandoffs, postHandoff } from "./executor";
import { generateEditId, generateEventUid, generateHandoffId } from "./ids";
import { appendHandoffEvents } from "./log-store";
import { byFor, freshEnv } from "./test-utils";
import type { HandoffEvent, HandoffEventBy } from "./types";

function on(agent: string, sessionId: string | null, sessionName: string | null = null): HandoffEventBy {
    return { ...byFor(sessionId, sessionName), agent };
}

const POSTER = on("claude-code", "sess-poster", "poster");
const CODEX_WORKER = on("codex", "sess-codex", "codex-worker");
const CLAUDE_WORKER = on("claude-code", "sess-claude", "claude-worker");
const GROK_WORKER = on("grok", "sess-grok", "grok-worker");
const FACELESS = on("unknown", null, "headless");

describe("recipient agent on handoff_post", () => {
    test("the documented harnesses are accepted and stored on the target, not on postedBy", () => {
        const env = freshEnv();

        for (const agent of ["claude", "codex", "grok"]) {
            const res = postHandoff(
                { title: `work for ${agent}`, tasks: [{ text: "do it" }], target: { agent } },
                env.depsFor(POSTER)
            );

            expect(res.handoff.target?.agent).toBe(agent);
            // The author's harness is a separate fact and must survive untouched.
            expect(res.handoff.postedBy.agent).toBe("claude-code");
            expect(res.handoff.postedByContext.agent).toBe("claude-code");
        }
    });

    test("a session target still works, alone and beside an agent", () => {
        const env = freshEnv();
        const res = postHandoff(
            {
                title: "addressed twice",
                tasks: [{ text: "do it" }],
                target: { sessionId: "sess-codex", sessionName: "codex-worker", agent: "Codex" },
            },
            env.depsFor(POSTER)
        );

        expect(res.handoff.target).toEqual({
            sessionId: "sess-codex",
            sessionName: "codex-worker",
            agent: "codex",
        });
    });

    test("an undocumented harness is stored as given, with an info line saying warnings cannot fire", () => {
        const env = freshEnv();
        const res = postHandoff(
            { title: "for a future host", tasks: [{ text: "do it" }], target: { agent: "Borg" } },
            env.depsFor(POSTER)
        );

        expect(res.handoff.target?.agent).toBe("borg");
        expect(res.info.join(" ")).toContain("not a documented harness");
    });
});

describe("recipient warnings on handoff_get", () => {
    function postedForCodex(env: ReturnType<typeof freshEnv>) {
        return postHandoff(
            { title: "codex work", tasks: [{ text: "one" }], target: { agent: "codex" } },
            env.depsFor(POSTER)
        ).handoff;
    }

    test("the intended harness sees no warning", () => {
        const env = freshEnv();
        const handoff = postedForCodex(env);
        const res = getHandoff({ id: handoff.id }, env.depsFor(CODEX_WORKER));

        expect(res.warnings).toBeUndefined();
    });

    test("another harness is warned off, and the warning names the override", () => {
        const env = freshEnv();
        const handoff = postedForCodex(env);
        const res = getHandoff({ id: handoff.id }, env.depsFor(CLAUDE_WORKER));

        const text = (res.warnings ?? []).join(" ");
        expect(text).toContain("This task is for another harness");
        expect(text).toContain("unless your user explicitly asks");
    });

    test("a warning never blocks — user-authorized cross-target work still claims and checks", () => {
        const env = freshEnv();
        const handoff = postedForCodex(env);
        const claimed = getHandoff({ id: handoff.id, claim: true }, env.depsFor(GROK_WORKER));

        expect(claimed.handoff.claimedBy).toHaveLength(1);
        expect(claimed.warnings?.length).toBeGreaterThan(0);

        const acted = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "check_task", taskId: "t1", proof: { answer: "did it anyway" } }] },
            env.depsFor(GROK_WORKER)
        );
        expect(acted.results[0].ok).toBe(true);
        // The action response keeps warning, so the mismatch is not lost after the claim.
        expect((acted.warnings ?? []).join(" ")).toContain("another harness");
    });

    test("a caller with no detectable identity is told the check was unverifiable", () => {
        const env = freshEnv();
        const handoff = postHandoff(
            { title: "codex work", tasks: [{ text: "one" }], target: { sessionId: "sess-codex", agent: "codex" } },
            env.depsFor(POSTER)
        ).handoff;
        const res = getHandoff({ id: handoff.id }, env.depsFor(FACELESS));

        const text = (res.warnings ?? []).join(" ");
        expect(text).toContain("unverifiable");
        expect(text).not.toContain("Recipient mismatch");
    });

    test("a legacy untargeted handoff warns nobody", () => {
        const env = freshEnv();
        const handoff = postHandoff({ title: "open to anyone", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;

        expect(getHandoff({ id: handoff.id }, env.depsFor(CODEX_WORKER)).warnings).toBeUndefined();
        expect(getHandoff({ id: handoff.id }, env.depsFor(FACELESS)).warnings).toBeUndefined();
    });

    test("a legacy record stored before targeting existed still reads and warns about nothing", () => {
        const env = freshEnv();
        const id = generateHandoffId();
        // Written the way the log looked before target.agent and name existed.
        const legacy: HandoffEvent = {
            ev: "post",
            ts: new Date().toISOString(),
            uid: generateEventUid(),
            id,
            editId: generateEditId(),
            title: "legacy handoff",
            tasks: [{ text: "one" }],
            by: POSTER,
        };
        appendHandoffEvents([legacy], env.base);

        const res = getHandoff({ id }, env.depsFor(CODEX_WORKER));
        expect(res.handoff.title).toBe("legacy handoff");
        expect(res.handoff.name).toBeUndefined();
        expect(res.handoff.target).toBeUndefined();
        expect(res.warnings).toBeUndefined();
    });
});

describe("auto-claim under a mismatched recipient", () => {
    test("a session target still auto-claims when the harness agrees", () => {
        const env = freshEnv();
        const handoff = postHandoff(
            { title: "for codex", tasks: [{ text: "one" }], target: { sessionId: "sess-codex", agent: "codex" } },
            env.depsFor(POSTER)
        ).handoff;

        const res = getHandoff({ id: handoff.id }, env.depsFor(CODEX_WORKER));
        expect(res.info.join(" ")).toContain("Auto-claimed");
        expect(res.handoff.claimedBy).toHaveLength(1);
    });

    test("a session-id hit under the wrong harness never claims silently", () => {
        const env = freshEnv();
        const handoff = postHandoff(
            {
                title: "contradictory address",
                tasks: [{ text: "one" }],
                // The poster named a claude session but addressed the codex harness.
                target: { sessionId: "sess-claude", agent: "codex" },
            },
            env.depsFor(POSTER)
        ).handoff;

        const res = getHandoff({ id: handoff.id }, env.depsFor(CLAUDE_WORKER));
        expect(res.handoff.claimedBy).toEqual([]);
        expect(res.handoff.status).toBe("open");
        expect(res.info.join(" ")).toContain("NOT auto-claimed");
        expect((res.warnings ?? []).join(" ")).toContain("another harness");
    });
});

describe("handoff_list recipient filters", () => {
    function seeded() {
        const env = freshEnv();
        postHandoff(
            { title: "for codex", tasks: [{ text: "one" }], target: { agent: "codex", sessionId: "sess-codex" } },
            env.depsFor(POSTER)
        );
        postHandoff(
            { title: "for claude", tasks: [{ text: "one" }], target: { agent: "claude", sessionId: "sess-claude" } },
            env.depsFor(POSTER)
        );
        postHandoff(
            { title: "for a named session", tasks: [{ text: "one" }], target: { sessionName: "gt-worker" } },
            env.depsFor(POSTER)
        );
        postHandoff({ title: "for anybody", tasks: [{ text: "one" }] }, env.depsFor(POSTER));
        return env;
    }

    test("the default listing is unfiltered", () => {
        const env = seeded();
        const res = listHandoffs({}, env.depsFor(CODEX_WORKER));

        expect(res.handoffs).toHaveLength(4);
        expect(res.info.join(" ")).not.toContain("Filtered to handoffs");
    });

    test("the agent filter keeps only the intended harness", () => {
        const env = seeded();
        const res = listHandoffs({ agent: "codex" }, env.depsFor(POSTER));

        expect(res.handoffs.map((h) => h.title)).toEqual(["for codex"]);
        expect(res.info.join(" ")).toContain("intended recipient, not the poster");
    });

    test("the session filter matches an id or a session name", () => {
        const env = seeded();

        expect(listHandoffs({ session: "sess-claude" }, env.depsFor(POSTER)).handoffs.map((h) => h.title)).toEqual([
            "for claude",
        ]);
        expect(listHandoffs({ session: "gt-worker" }, env.depsFor(POSTER)).handoffs.map((h) => h.title)).toEqual([
            "for a named session",
        ]);
    });

    test("both filters together narrow to their intersection", () => {
        const env = seeded();

        expect(
            listHandoffs({ agent: "codex", session: "sess-codex" }, env.depsFor(POSTER)).handoffs.map((h) => h.title)
        ).toEqual(["for codex"]);
        expect(listHandoffs({ agent: "codex", session: "sess-claude" }, env.depsFor(POSTER)).handoffs).toHaveLength(0);
    });

    test("an undocumented filter value says so instead of pretending to match a harness", () => {
        const env = seeded();
        const res = listHandoffs({ agent: "borg" }, env.depsFor(POSTER));

        expect(res.handoffs).toHaveLength(0);
        expect(res.info.join(" ")).toContain("not a documented harness");
    });

    test("rows carry the name, the recipient target and per-row warnings", () => {
        const env = seeded();
        const rows = listHandoffs({}, env.depsFor(GROK_WORKER)).handoffs;
        const codexRow = rows.find((h) => h.title === "for codex");

        expect(codexRow?.name).toBe("for-codex");
        expect(codexRow?.target?.agent).toBe("codex");
        expect((codexRow?.warnings ?? []).join(" ")).toContain("another harness");
        expect(rows.find((h) => h.title === "for anybody")?.warnings).toBeUndefined();
    });
});
