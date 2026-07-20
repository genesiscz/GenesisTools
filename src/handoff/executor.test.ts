import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { DASHBOARD_ACTOR, executeHandoffActions, getHandoff, listHandoffs, postHandoff } from "./executor";
import { byFor, freshEnv } from "./test-utils";

const A = byFor("session-a", "poster-a");
const B = byFor("session-b", "worker-b");
const C = byFor("session-c", "gt-worker");
const NULL1 = byFor(null, "headless-1");
const NULL2 = byFor(null, "headless-2");

describe("handoff_post (§8.1)", () => {
    test("posts with auto ids, paste block, editId; own-session edit without editId", () => {
        const env = freshEnv();
        const res = postHandoff(
            {
                title: "Fix e2e Active-filter semantics",
                tasks: [{ text: "task one" }, { text: "task two", acceptanceCriteria: "e2e green" }],
                target: { sessionName: "gt-worker" },
            },
            env.depsFor(A)
        );

        expect(res.handoff.tasks.map((t) => t.id)).toEqual(["t1", "t2"]);
        expect(res.editId.startsWith("he_")).toBe(true);
        expect(res.paste.id).toBe(res.handoff.id);
        expect(res.paste._agent).toContain(res.handoff.id);
        expect(res.paste.tasks).toBe("0/2");
        expect(res.info.length).toBeGreaterThan(0);

        // Own-session poster verb WITHOUT editId.
        const edit = executeHandoffActions(
            { id: res.handoff.id, actions: [{ action: "add_tasks", tasks: [{ text: "task three" }] }] },
            env.depsFor(A)
        );
        expect(edit.results[0].ok).toBe(true);
        expect(edit.results[0].assignedTaskIds).toEqual(["t3"]);
        expect(edit.handoff.tasks).toHaveLength(3);
    });

    test("rejects empty input with copy-pasteable example", () => {
        const env = freshEnv();
        expect(() => postHandoff({ title: "", tasks: [] }, env.depsFor(A))).toThrow(/handoff_post needs title/);
    });
});

describe("claims (§8.2, §8.3)", () => {
    function posted(env: ReturnType<typeof freshEnv>) {
        return postHandoff(
            {
                title: "T",
                tasks: [{ text: "one" }, { text: "two" }],
                target: { sessionId: "session-c", sessionName: "gt-worker" },
            },
            env.depsFor(A)
        );
    }

    test("explicit claim recorded via explicit; unclaimed get says NOT claimed", () => {
        const env = freshEnv();
        const { handoff } = posted(env);

        const readB = getHandoff({ id: handoff.id }, env.depsFor(B));
        expect(readB.info.join(" ")).toContain("NOT claimed");
        expect(readB.editId).toBeUndefined();

        const claimed = getHandoff({ id: handoff.id, claim: true }, env.depsFor(B));
        expect(claimed.handoff.claimedBy).toHaveLength(1);
        expect(claimed.handoff.claimedBy[0].via).toBe("explicit");
        expect(claimed.handoff.status).toBe("claimed");
    });

    test("target sessionId auto-claims via target-match; co-owning traced individually", () => {
        const env = freshEnv();
        const { handoff } = posted(env);
        getHandoff({ id: handoff.id, claim: true }, env.depsFor(B));

        const readC = getHandoff({ id: handoff.id }, env.depsFor(C));
        expect(readC.info.join(" ")).toContain("Auto-claimed");
        expect(readC.handoff.claimedBy).toHaveLength(2);
        const viaBySession = Object.fromEntries(readC.handoff.claimedBy.map((c) => [c.sessionId, c.via]));
        expect(viaBySession["session-b"]).toBe("explicit");
        expect(viaBySession["session-c"]).toBe("target-match");
    });

    test("repeat claim dedupes with info; unclaim removes only caller; last unclaim → open", () => {
        const env = freshEnv();
        const { handoff } = posted(env);
        getHandoff({ id: handoff.id, claim: true }, env.depsFor(B));
        const again = getHandoff({ id: handoff.id, claim: true }, env.depsFor(B));
        expect(again.info.join(" ")).toContain("Already claimed by you");
        expect(again.handoff.claimedBy).toHaveLength(1);

        const noopUnclaim = getHandoff({ id: handoff.id, unclaim: true }, env.depsFor(A));
        expect(noopUnclaim.info.join(" ")).toContain("nothing to unclaim");

        const released = getHandoff({ id: handoff.id, unclaim: true }, env.depsFor(B));
        expect(released.handoff.claimedBy).toHaveLength(0);
        expect(released.handoff.status).toBe("open");
    });

    test("claim+unclaim together rejected; sessionName target only nudges", () => {
        const env = freshEnv();
        const { handoff } = posted(env);
        expect(() => getHandoff({ id: handoff.id, claim: true, unclaim: true }, env.depsFor(B))).toThrow(/not both/);

        const nameMatch = getHandoff({ id: handoff.id }, env.depsFor(byFor("session-x", "gt-worker")));
        expect(nameMatch.handoff.claimedBy).toHaveLength(0);
        expect(nameMatch.info.join(" ")).toContain("names aren't unique");
    });
});

describe("work loop (§8.4, §8.5)", () => {
    test("check with proof → progress; deny sans reason rejected with example; finish; reopen; undeny", () => {
        const env = freshEnv();
        const { handoff } = postHandoff({ title: "T", tasks: [{ text: "one" }, { text: "two" }] }, env.depsFor(A));
        getHandoff({ id: handoff.id, claim: true }, env.depsFor(B));

        const check = executeHandoffActions(
            {
                id: handoff.id,
                actions: [
                    {
                        action: "check_task",
                        taskId: "t1",
                        proof: { answer: "done, tests green", commitIds: ["abc1234"] },
                    },
                ],
            },
            env.depsFor(B)
        );
        expect(check.results[0].ok).toBe(true);
        expect(check.handoff.tasks[0].checked).toBe(true);
        expect(check.handoff.tasks[0].proof?.commitIds).toEqual(["abc1234"]);

        const list = listHandoffs({}, env.depsFor(A));
        expect(list.handoffs[0].tasks).toBe("1/2");

        const badDeny = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "deny_task", taskId: "t2" }] },
            env.depsFor(B)
        );
        expect(badDeny.results[0].ok).toBe(false);
        expect(badDeny.results[0].error).toContain('reason: "out of scope');

        const deny = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "deny_task", taskId: "t2", reason: "cannot repro" }] },
            env.depsFor(B)
        );
        expect(deny.results[0].ok).toBe(true);
        expect(deny.handoff.tasks[1].denied).toBe(true);
        expect(deny.info.join(" ")).toContain("finish_handoff");

        const finish = executeHandoffActions({ id: handoff.id, actions: ["finish_handoff"] }, env.depsFor(B));
        expect(finish.results[0].ok).toBe(true);
        expect(finish.handoff.status).toBe("done");
        expect(finish.handoff.finishedTs).toBeDefined();

        const reopen = executeHandoffActions({ id: handoff.id, actions: ["reopen_handoff"] }, env.depsFor(A));
        expect(reopen.results[0].ok).toBe(true);
        expect(reopen.handoff.status).toBe("claimed");
        expect(reopen.handoff.tasks[0].checked).toBe(true);

        const undeny = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "undeny_task", taskId: "t2" }] },
            env.depsFor(B)
        );
        expect(undeny.results[0].ok).toBe(true);
        expect(undeny.handoff.tasks[1].denied).toBe(false);
        expect(undeny.handoff.tasks[1].deniedReason).toBeUndefined();
    });

    test("finish gate lists unresolved ids; force overrides", () => {
        const env = freshEnv();
        const { handoff } = postHandoff({ title: "T", tasks: [{ text: "one" }, { text: "two" }] }, env.depsFor(A));
        getHandoff({ id: handoff.id, claim: true }, env.depsFor(B));

        const gated = executeHandoffActions({ id: handoff.id, actions: ["finish_handoff"] }, env.depsFor(B));
        expect(gated.results[0].ok).toBe(false);
        expect(gated.results[0].error).toContain("t1, t2");

        const forced = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "finish_handoff", force: true }] },
            env.depsFor(B)
        );
        expect(forced.results[0].ok).toBe(true);
        expect(forced.handoff.status).toBe("done");
    });
});

describe("edit safety (§8.6)", () => {
    test("modify_task protected fields ignored + named; deny checked needs force; cancel informs claimers", () => {
        const env = freshEnv();
        const { handoff } = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        getHandoff({ id: handoff.id, claim: true }, env.depsFor(B));
        executeHandoffActions(
            { id: handoff.id, actions: [{ action: "check_task", taskId: "t1", proof: { answer: "ok" } }] },
            env.depsFor(B)
        );

        const modify = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "modify_task", taskId: "t1", text: "renamed", checked: false }] },
            env.depsFor(A)
        );
        expect(modify.results[0].ok).toBe(true);
        expect(modify.results[0].info?.join(" ")).toContain("Protected field ignored: checked");
        expect(modify.handoff.tasks[0].text).toBe("renamed");
        expect(modify.handoff.tasks[0].checked).toBe(true);

        const denyChecked = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "deny_task", taskId: "t1", reason: "nope" }] },
            env.depsFor(B)
        );
        expect(denyChecked.results[0].ok).toBe(false);
        expect(denyChecked.results[0].error).toContain("force: true");

        const forceDeny = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "deny_task", taskId: "t1", reason: "nope", force: true }] },
            env.depsFor(B)
        );
        expect(forceDeny.results[0].ok).toBe(true);
        expect(forceDeny.handoff.tasks[0].proof?.answer).toBe("ok");

        const cancel = executeHandoffActions({ id: handoff.id, actions: ["cancel_handoff"] }, env.depsFor(A));
        expect(cancel.results[0].ok).toBe(true);

        const bNext = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "comment", text: "hi" }] },
            env.depsFor(B)
        );
        expect(bNext.results[0].ok).toBe(false);
        expect(bNext.results[0].error).toContain("Cancelled by the poster");
        expect(bNext.info.join(" ")).toContain("stop work");
    });
});

describe("aliases + catalogs (§8.7)", () => {
    test("done alias finishes; close → verb catalog; unknown taskId → task catalog; unknown id → list hint", () => {
        const env = freshEnv();
        const { handoff } = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        getHandoff({ id: handoff.id, claim: true }, env.depsFor(B));
        executeHandoffActions(
            { id: handoff.id, actions: [{ action: "check", taskId: "t1", proof: { answer: "ok" } }] },
            env.depsFor(B)
        );

        const done = executeHandoffActions({ id: handoff.id, actions: ["done"] }, env.depsFor(B));
        expect(done.results[0].action).toBe("finish_handoff");
        expect(done.results[0].ok).toBe(true);

        const close = executeHandoffActions({ id: handoff.id, actions: ["close"] }, env.depsFor(B));
        expect(close.results[0].ok).toBe(false);
        expect(close.results[0].error).toContain("Valid actions:");
        expect(close.results[0].error).toContain("reopen_handoff");

        const reopen = executeHandoffActions({ id: handoff.id, actions: ["reopen_handoff"] }, env.depsFor(A));
        expect(reopen.results[0].ok).toBe(true);

        const badTask = executeHandoffActions(
            { id: handoff.id, actions: [{ action: "check_task", taskId: "t9", proof: { answer: "x" } }] },
            env.depsFor(B)
        );
        expect(badTask.results[0].ok).toBe(false);
        expect(badTask.results[0].error).toContain("t1");

        expect(() => getHandoff({ id: "zzz" }, env.depsFor(B))).toThrow(/handoff_list/);
    });

    test("id tolerance: h_ prefix optional, whitespace trimmed", () => {
        const env = freshEnv();
        const { handoff } = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const bare = handoff.id.replace(/^h_/, "");
        const res = getHandoff({ id: `  ${bare} ` }, env.depsFor(B));
        expect(res.handoff.id).toBe(handoff.id);
    });
});

describe("null sessions (§8.8) + editId", () => {
    test("null never matches null; editId is the only credential for id-less sessions", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(NULL1));

        const denied = executeHandoffActions(
            { id: posted.handoff.id, actions: [{ action: "modify_handoff", title: "hijacked" }] },
            env.depsFor(NULL2)
        );
        expect(denied.results[0].ok).toBe(false);
        expect(denied.results[0].error).toContain("editId");

        const allowed = executeHandoffActions(
            { id: posted.handoff.id, editId: posted.editId, actions: [{ action: "modify_handoff", title: "renamed" }] },
            env.depsFor(NULL2)
        );
        expect(allowed.results[0].ok).toBe(true);
        expect(allowed.handoff.title).toBe("renamed");
    });

    test("null session cannot claim; editId never leaks to non-posters", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));

        const claim = getHandoff({ id: posted.handoff.id, claim: true }, env.depsFor(NULL1));
        expect(claim.handoff.claimedBy).toHaveLength(0);
        expect(claim.info.join(" ")).toContain("cannot claim");
        expect(claim.editId).toBeUndefined();

        const posterRead = getHandoff({ id: posted.handoff.id }, env.depsFor(A));
        expect(posterRead.editId).toBe(posted.editId);
    });
});

describe("fold-after-append truthfulness (§8.9c)", () => {
    test("claim+check batch reflects a cancel that landed first", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        executeHandoffActions({ id: posted.handoff.id, actions: ["cancel_handoff"] }, env.depsFor(A));

        const b = executeHandoffActions(
            {
                id: posted.handoff.id,
                actions: ["claim", { action: "check_task", taskId: "t1", proof: { answer: "x" } }],
            },
            env.depsFor(B)
        );
        expect(b.results[0].ok).toBe(false);
        expect(b.results[1].ok).toBe(false);
        expect(b.handoff.status).toBe("cancelled");
    });

    test("claim earlier in the same actions array counts for later verbs", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const b = executeHandoffActions(
            {
                id: posted.handoff.id,
                actions: ["claim", { action: "check_task", taskId: "t1", proof: { answer: "x" } }, "finish_handoff"],
            },
            env.depsFor(B)
        );
        expect(b.results.map((r) => r.ok)).toEqual([true, true, true]);
        expect(b.handoff.status).toBe("done");
    });

    test("unclaimed session using a claimer verb gets claim-first guidance", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const b = executeHandoffActions(
            { id: posted.handoff.id, actions: [{ action: "check_task", taskId: "t1", proof: { answer: "x" } }] },
            env.depsFor(B)
        );
        expect(b.results[0].ok).toBe(false);
        expect(b.results[0].error).toContain("claim first");
    });
});

describe("handoff_list (§8.12)", () => {
    test("mine includes targeted-but-never-claimed; open filters; paging info", () => {
        const env = freshEnv();
        postHandoff({ title: "other", tasks: [{ text: "x" }] }, env.depsFor(A));
        const targeted = postHandoff(
            { title: "for-c", tasks: [{ text: "x" }], target: { sessionId: "session-c" } },
            env.depsFor(A)
        );

        const mineC = listHandoffs({ mine: true }, env.depsFor(C));
        expect(mineC.handoffs.map((h) => h.id)).toEqual([targeted.handoff.id]);

        const done = postHandoff({ title: "done-one", tasks: [{ text: "x" }] }, env.depsFor(A));
        executeHandoffActions(
            {
                id: done.handoff.id,
                actions: ["claim", { action: "check_task", taskId: "t1", proof: { answer: "y" } }, "done"],
            },
            env.depsFor(B)
        );

        const open = listHandoffs({ open: true }, env.depsFor(A));
        expect(open.handoffs.every((h) => h.status === "open" || h.status === "claimed")).toBe(true);
        expect(open.handoffs.some((h) => h.id === done.handoff.id)).toBe(false);
    });
});

describe("reopen paths (§8.13)", () => {
    test("finisher reopens own finish; a different claimer cannot; poster reopens cancelled", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        getHandoff({ id: posted.handoff.id, claim: true }, env.depsFor(B));
        getHandoff({ id: posted.handoff.id, claim: true }, env.depsFor(C));
        executeHandoffActions(
            { id: posted.handoff.id, actions: [{ action: "finish_handoff", force: true }] },
            env.depsFor(B)
        );

        const cReopen = executeHandoffActions({ id: posted.handoff.id, actions: ["reopen_handoff"] }, env.depsFor(C));
        expect(cReopen.results[0].ok).toBe(false);
        expect(cReopen.results[0].error).toContain("whose own finish");

        const bReopen = executeHandoffActions({ id: posted.handoff.id, actions: ["reopen_handoff"] }, env.depsFor(B));
        expect(bReopen.results[0].ok).toBe(true);
        expect(bReopen.handoff.status).toBe("claimed");

        executeHandoffActions({ id: posted.handoff.id, actions: ["cancel_handoff"] }, env.depsFor(A));
        const posterReopen = executeHandoffActions(
            { id: posted.handoff.id, actions: ["reopen_handoff"] },
            env.depsFor(A)
        );
        expect(posterReopen.results[0].ok).toBe(true);
        expect(posterReopen.handoff.status).toBe("claimed");
    });
});

describe("attachments + comments (§8.16b/16c agent side)", () => {
    test("attach_file ingests; comment screenshots sugar; proof screenshots sugar; cap enforced", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        getHandoff({ id: posted.handoff.id, claim: true }, env.depsFor(B));

        const shot = join(env.base, "..", "shot.png");
        writeFileSync(shot, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]));

        const attach = executeHandoffActions(
            { id: posted.handoff.id, actions: [{ action: "attach_file", path: shot, taskId: "t1", note: "before" }] },
            env.depsFor(B)
        );
        expect(attach.results[0].ok).toBe(true);
        expect(attach.results[0].attachmentId).toBeDefined();
        expect(attach.handoff.attachments).toHaveLength(1);
        expect(attach.handoff.attachments[0].taskId).toBe("t1");
        expect(attach.handoff.attachments[0].missing).toBeUndefined();
        expect(attach.handoff.attachments[0].path).toBeDefined();

        const comment = executeHandoffActions(
            { id: posted.handoff.id, actions: [{ action: "comment", text: "see shot", screenshots: [shot] }] },
            env.depsFor(B)
        );
        expect(comment.results[0].ok).toBe(true);
        expect(comment.handoff.comments[0].attachmentIds).toHaveLength(1);
        expect(comment.handoff.attachments).toHaveLength(2);

        const check = executeHandoffActions(
            {
                id: posted.handoff.id,
                actions: [{ action: "check_task", taskId: "t1", proof: { answer: "done", screenshots: [shot] } }],
            },
            env.depsFor(B)
        );
        expect(check.results[0].ok).toBe(true);
        expect(check.handoff.tasks[0].proof?.attachmentIds).toHaveLength(1);

        const big = join(env.base, "..", "big.bin");
        writeFileSync(big, new Uint8Array(10 * 1024 * 1024 + 1));
        const over = executeHandoffActions(
            { id: posted.handoff.id, actions: [{ action: "attach_file", path: big }] },
            env.depsFor(B)
        );
        expect(over.results[0].ok).toBe(false);
        expect(over.results[0].error).toContain("10 MB");
    });
});

describe("dashboard owner authority (§7.1)", () => {
    test("human actor bypasses claim + poster credentials; stamped via dashboard", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));

        const human = executeHandoffActions(
            {
                id: posted.handoff.id,
                actions: [
                    { action: "check_task", taskId: "t1", proof: { answer: "Verified manually via dashboard" } },
                    { action: "add_tasks", tasks: [{ text: "follow-up" }] },
                    { action: "comment", text: "looks good" },
                ],
            },
            env.depsFor(DASHBOARD_ACTOR)
        );
        expect(human.results.map((r) => r.ok)).toEqual([true, true, true]);
        expect(human.handoff.tasks[0].checkedBy?.agent).toBe("human");
        expect(human.handoff.tasks[0].checkedBy?.via).toBe("dashboard");
        expect(human.handoff.comments[0].by.agent).toBe("human");

        // Human actor is NOT a session identity: it never becomes poster session.
        const humanRead = getHandoff({ id: posted.handoff.id }, env.depsFor(DASHBOARD_ACTOR));
        expect(humanRead.editId).toBe(posted.editId);
    });
});

describe("actions[] item shape errors", () => {
    test("malformed item gets the item-shape gloss; empty actions throws", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));

        const bad = executeHandoffActions(
            { id: posted.handoff.id, actions: [42 as unknown as string] },
            env.depsFor(A)
        );
        expect(bad.results[0].ok).toBe(false);
        expect(bad.results[0].error).toContain('{ action: "<verb>"');

        expect(() => executeHandoffActions({ id: posted.handoff.id, actions: [] }, env.depsFor(A))).toThrow(
            /actions array/
        );
    });
});
