import { describe, expect, test } from "bun:test";
import { executeHandoffActions, getHandoff, listHandoffs, postHandoff } from "./executor";
import { generateEditId, generateEventUid, generateHandoffId } from "./ids";
import { appendHandoffEvents } from "./log-store";
import { byFor, freshEnv } from "./test-utils";
import type { HandoffEvent } from "./types";

const POSTER = byFor("sess-poster", "poster");
const WORKER = byFor("sess-worker", "worker");

describe("naming a handoff", () => {
    test("a name is derived from the title when none is given", () => {
        const env = freshEnv();
        const res = postHandoff(
            { title: "Fix e2e Active-filter semantics", tasks: [{ text: "one" }] },
            env.depsFor(POSTER)
        );

        expect(res.handoff.name).toBe("fix-e2e-active-filter-semantics");
        expect(res.paste.name).toBe("fix-e2e-active-filter-semantics");
        expect(res.info.join(" ")).toContain("Readable name");
    });

    test("a supplied name wins and is slugified", () => {
        const env = freshEnv();
        const res = postHandoff(
            { title: "Fix e2e Active-filter semantics", name: "Active Filter", tasks: [{ text: "one" }] },
            env.depsFor(POSTER)
        );

        expect(res.handoff.name).toBe("active-filter");
    });

    test("the name is distinct from the target session name", () => {
        const env = freshEnv();
        const res = postHandoff(
            {
                title: "Ship the fix",
                name: "ship-the-fix",
                tasks: [{ text: "one" }],
                target: { sessionName: "gt-worker" },
            },
            env.depsFor(POSTER)
        );

        expect(res.handoff.name).toBe("ship-the-fix");
        expect(res.handoff.target?.sessionName).toBe("gt-worker");
    });
});

describe("resolving by name", () => {
    test("a unique name resolves, through the name field and through id", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "Ship the fix", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;

        expect(getHandoff({ name: "ship-the-fix" }, env.depsFor(WORKER)).handoff.id).toBe(posted.id);
        // Agents paste whatever they were handed into `id`; a name has to work there too.
        expect(getHandoff({ id: "ship-the-fix" }, env.depsFor(WORKER)).handoff.id).toBe(posted.id);
        // The un-slugged form a human would type resolves as well.
        expect(getHandoff({ name: "Ship The Fix" }, env.depsFor(WORKER)).handoff.id).toBe(posted.id);
    });

    test("the id path is unchanged and still wins", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "Ship the fix", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;

        expect(getHandoff({ id: posted.id }, env.depsFor(WORKER)).handoff.id).toBe(posted.id);
        // The `h_` prefix stays optional.
        expect(getHandoff({ id: posted.id.slice(2) }, env.depsFor(WORKER)).handoff.id).toBe(posted.id);
    });

    test("a duplicate name is refused with its candidates instead of silently picking one", () => {
        const env = freshEnv();
        const first = postHandoff({ title: "Ship the fix", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;
        const secondPost = postHandoff({ title: "Ship the fix", tasks: [{ text: "two" }] }, env.depsFor(POSTER));
        const second = secondPost.handoff;

        // The poster is told at post time, instead of the receiver finding out at lookup time.
        const nameInfo = secondPost.info.find((line) => line.includes("Readable name")) ?? "";
        expect(nameInfo).toContain(`already carried by ${first.id}`);
        expect(nameInfo).toContain("refused as ambiguous");

        expect(() => getHandoff({ name: "ship-the-fix" }, env.depsFor(WORKER))).toThrow(/ambiguous/);

        try {
            getHandoff({ name: "ship-the-fix" }, env.depsFor(WORKER));
            throw new Error("expected an ambiguity error");
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            expect(message).toContain(first.id);
            expect(message).toContain(second.id);
            expect(message).toContain("Re-call with the id");
        }

        // Disambiguation by id keeps working for both.
        expect(getHandoff({ id: first.id }, env.depsFor(WORKER)).handoff.tasks[0].text).toBe("one");
        expect(getHandoff({ id: second.id }, env.depsFor(WORKER)).handoff.tasks[0].text).toBe("two");
    });

    test("an id and a name that disagree is an error, never a silent pick", () => {
        const env = freshEnv();
        const a = postHandoff({ title: "Alpha work", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;
        postHandoff({ title: "Beta work", tasks: [{ text: "one" }] }, env.depsFor(POSTER));

        expect(() => getHandoff({ id: a.id, name: "beta-work" }, env.depsFor(WORKER))).toThrow(
            /point at different handoffs/
        );
        // Agreeing values resolve normally.
        expect(getHandoff({ id: a.id, name: "alpha-work" }, env.depsFor(WORKER)).handoff.id).toBe(a.id);
    });

    test("two names that disagree are refused too, even when one arrives in the id field", () => {
        const env = freshEnv();
        postHandoff({ title: "Alpha work", tasks: [{ text: "one" }] }, env.depsFor(POSTER));
        const b = postHandoff({ title: "Beta work", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;

        expect(() => getHandoff({ id: "alpha-work", name: "beta-work" }, env.depsFor(WORKER))).toThrow(
            /point at different handoffs/
        );
        expect(() =>
            executeHandoffActions({ id: "alpha-work", name: "beta-work", actions: ["claim"] }, env.depsFor(WORKER))
        ).toThrow(/point at different handoffs/);
        // The same name twice is one reference, not a conflict.
        expect(getHandoff({ id: "beta-work", name: "Beta Work" }, env.depsFor(WORKER)).handoff.id).toBe(b.id);
    });

    test("a stale h_ id beside a name never falls back to the name, even one spelled like the id", () => {
        const env = freshEnv();
        // A handoff whose readable name is the slug of a stale id: the one case where
        // the two-name comparison alone would agree.
        postHandoff({ title: "h_deadbeef", tasks: [{ text: "one" }] }, env.depsFor(POSTER));

        expect(() => getHandoff({ id: "h_deadbeef", name: "h-deadbeef" }, env.depsFor(WORKER))).toThrow(
            /No handoff h_deadbeef — the id does not resolve/
        );
        expect(() => getHandoff({ id: "h_deadbeef", name: "beta-work" }, env.depsFor(WORKER))).toThrow(
            /No handoff h_deadbeef/
        );
        // Alone, the same value still resolves as a name, as documented.
        expect(getHandoff({ name: "h-deadbeef" }, env.depsFor(WORKER)).handoff.name).toBe("h-deadbeef");
    });

    test("an unknown name and an unknown id fail differently, and both say where to look", () => {
        const env = freshEnv();

        expect(() => getHandoff({ name: "nothing-here" }, env.depsFor(WORKER))).toThrow(
            /No handoff named "nothing-here"/
        );
        expect(() => getHandoff({ id: "h_zzzzzzzz" }, env.depsFor(WORKER))).toThrow(/No handoff h_zzzzzzzz/);
        expect(() => getHandoff({}, env.depsFor(WORKER))).toThrow(/Pass id or name/);
    });

    test("recipient warnings apply after a name lookup exactly as after an id lookup", () => {
        const env = freshEnv();
        postHandoff({ title: "Codex only", tasks: [{ text: "one" }], target: { agent: "codex" } }, env.depsFor(POSTER));

        const byName = getHandoff({ name: "codex-only" }, env.depsFor(WORKER));
        expect((byName.warnings ?? []).join(" ")).toContain("another harness");
    });

    test("a legacy handoff has no name, keeps working by id, and is not found by name", () => {
        const env = freshEnv();
        const id = generateHandoffId();
        const legacy: HandoffEvent = {
            ev: "post",
            ts: new Date().toISOString(),
            uid: generateEventUid(),
            id,
            editId: generateEditId(),
            title: "Legacy handoff",
            tasks: [{ text: "one" }],
            by: POSTER,
        };
        appendHandoffEvents([legacy], env.base);

        expect(getHandoff({ id }, env.depsFor(WORKER)).handoff.name).toBeUndefined();
        expect(listHandoffs({}, env.depsFor(WORKER)).handoffs[0].name).toBeUndefined();
        expect(() => getHandoff({ name: "legacy-handoff" }, env.depsFor(WORKER))).toThrow(/No handoff named/);
    });
});

describe("names survive edits and reach handoff_action", () => {
    test("handoff_action resolves by name too", () => {
        const env = freshEnv();
        postHandoff({ title: "Ship the fix", tasks: [{ text: "one" }] }, env.depsFor(POSTER));

        const res = executeHandoffActions({ id: "ship-the-fix", actions: [{ action: "claim" }] }, env.depsFor(WORKER));
        expect(res.results[0].ok).toBe(true);
        expect(res.handoff.claimedBy).toHaveLength(1);
    });

    test("modify_handoff renames, and the new name is what resolves", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "Ship the fix", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;

        const res = executeHandoffActions(
            { id: posted.id, actions: [{ action: "modify_handoff", name: "Active Filter" }] },
            env.depsFor(POSTER)
        );
        expect(res.results[0].ok).toBe(true);
        expect(res.handoff.name).toBe("active-filter");
        expect(getHandoff({ name: "active-filter" }, env.depsFor(WORKER)).handoff.id).toBe(posted.id);
        expect(() => getHandoff({ name: "ship-the-fix" }, env.depsFor(WORKER))).toThrow(/No handoff named/);
    });

    test("an empty name clears it; a title edit never renames", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "Ship the fix", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;

        const retitled = executeHandoffActions(
            { id: posted.id, actions: [{ action: "modify_handoff", title: "Something else entirely" }] },
            env.depsFor(POSTER)
        );
        expect(retitled.handoff.title).toBe("Something else entirely");
        expect(retitled.handoff.name).toBe("ship-the-fix");

        const cleared = executeHandoffActions(
            { id: posted.id, actions: [{ action: "modify_handoff", name: "" }] },
            env.depsFor(POSTER)
        );
        expect(cleared.results[0].ok).toBe(true);
        expect(cleared.handoff.name).toBeUndefined();
    });

    test("a name with nothing to slug is refused rather than clearing the name", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "Ship the fix", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;

        const res = executeHandoffActions(
            { id: posted.id, actions: [{ action: "modify_handoff", name: "!!!" }] },
            env.depsFor(POSTER)
        );
        expect(res.results[0].ok).toBe(false);
        expect(res.results[0].error).toContain("no letters or digits");
        expect(res.handoff.name).toBe("ship-the-fix");
    });

    test("modify_handoff can retarget the recipient harness", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "Ship the fix", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;

        const res = executeHandoffActions(
            { id: posted.id, actions: [{ action: "modify_handoff", target: { agent: "Grok" } }] },
            env.depsFor(POSTER)
        );
        expect(res.results[0].ok).toBe(true);
        expect(res.handoff.target).toEqual({ agent: "grok" });
    });

    test("the action response warns from the target AFTER the batch, not before it", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "Ship the fix", tasks: [{ text: "one" }] }, env.depsFor(POSTER)).handoff;
        const codexWorker = { ...byFor("sess-codex", "codex-worker"), agent: "codex" };

        // Untargeted → retargeted away from the caller: the warning appears in this response.
        const away = executeHandoffActions(
            { id: posted.id, actions: [{ action: "modify_handoff", target: { agent: "grok" } }] },
            env.depsFor(POSTER)
        );
        expect(away.results[0].ok).toBe(true);
        expect((away.warnings ?? []).join(" ")).toContain('targets harness "grok"');

        // Mismatched → retargeted to the caller: the stale warning is gone from this response.
        const back = executeHandoffActions(
            { id: posted.id, actions: [{ action: "modify_handoff", target: { agent: "codex" } }] },
            env.depsFor({ ...codexWorker, sessionId: POSTER.sessionId })
        );
        expect(back.results[0].ok).toBe(true);
        expect(back.warnings).toBeUndefined();
    });
});
