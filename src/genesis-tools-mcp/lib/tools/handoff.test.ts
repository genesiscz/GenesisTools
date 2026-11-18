import { describe, expect, test } from "bun:test";
import {
    executeHandoffActions,
    getHandoff,
    listHandoffs,
    type PostHandoffResponse,
    postHandoff,
} from "@app/handoff/executor";
import { byFor, freshEnv } from "@app/handoff/test-utils";
import type { PlannedLink } from "@genesiscz/utils/browser-router/links";
import { SafeJSON } from "@genesiscz/utils/json";
import { handleHandoffGet, handleHandoffList, settleRunLinks } from "./handoff";

const INFO = "Show paste.runLink.markdown to the user so they can open the handoff in a new cmux surface.";

function response(url: string): Pick<PostHandoffResponse, "paste" | "info"> {
    return {
        paste: { _agent: "go", id: "h_x", title: "t", tasks: "0/1", runLink: { url, markdown: `[Run](${url})` } },
        info: ["first", INFO],
    };
}

function planned(url: string, saved: boolean): PlannedLink {
    const link = { url, markdown: `[Run](${url})` };
    return { link, save: async () => (saved ? link : null) };
}

describe("handoff_post run link", () => {
    test("a link whose token was written stays", async () => {
        const url = "https://genesis.tools/t/abcdefgh1234";
        const settled = await settleRunLinks(response(url), [planned(url, true)]);

        expect(settled.paste.runLink?.url).toBe(url);
        expect(settled.info).toContain(INFO);
    });

    test("a link whose token could not be written is removed with its info line, so no dead link shows", async () => {
        const url = "https://genesis.tools/t/abcdefgh1234";
        const settled = await settleRunLinks(response(url), [planned(url, false)]);

        expect(settled.paste.runLink).toBeUndefined();
        expect(settled.info).toEqual(["first"]);
    });
});

describe("work store handoff reads", () => {
    test("get matches the legacy response for every section and caller", async () => {
        const store = freshEnv();
        const poster = store.depsFor(byFor("session-poster"));
        const other = store.depsFor(byFor("session-reader"));
        const posted = postHandoff(
            {
                title: "Review sample",
                description: "Check the sample output",
                tasks: [{ text: "Read" }, { text: "Decide" }, { text: "Publish" }],
                target: { agent: "codex" },
                refs: ["sample.txt"],
            },
            poster
        );
        const id = posted.handoff.id;
        executeHandoffActions(
            {
                id,
                actions: [
                    { action: "check_task", taskId: "t1", proof: { answer: "Read the sample" } },
                    { action: "deny_task", taskId: "t2", reason: "Out of scope" },
                    { action: "comment", text: "Checked" },
                ],
            },
            poster
        );

        for (const deps of [poster, other]) {
            for (const include of [
                undefined,
                [],
                ["rows"],
                ["description"],
                ["rows", "description"],
                ["full"],
                ["tasks"],
                ["events"],
                ["claimedBy", "comments", "attachments", "postedBy", "postedByContext", "events"],
            ]) {
                const expected = getHandoff({ id, include: include ?? ["rows"] }, deps);
                const actual = await handleHandoffGet({ name: posted.handoff.name, include }, deps);
                expect(actual).toBe(SafeJSON.stringify(expected, { strict: true }, 2));
            }
        }

        const compact = await handleHandoffGet({ id }, other);
        const result: unknown = SafeJSON.parse(compact, { strict: true });
        expect(result).toHaveProperty("handoff.rows", [
            { id: "t1", text: "Read", state: "done" },
            { id: "t2", text: "Decide", state: "denied" },
            { id: "t3", text: "Publish", state: "open" },
        ]);
        expect(result).not.toHaveProperty("handoff.description");
        expect(compact).not.toContain(posted.editId);
        expect(await handleHandoffGet({ id, include: ["events"] }, poster)).not.toContain(posted.editId);
    });

    test("get still auto-claims once and unclaims through the writer", async () => {
        const store = freshEnv();
        const poster = store.depsFor(byFor("session-poster"));
        const ts = new Date().toISOString();
        const reader = { ...store.depsFor(byFor("session-worker")), nowIso: () => ts };
        const posted = postHandoff(
            { title: "Read sample", target: { sessionId: "session-worker" }, tasks: [{ text: "Read" }] },
            poster
        );
        const id = posted.handoff.id;
        const args = { id, include: ["rows", "claimedBy"] };
        const expected = getHandoff(args, reader);
        getHandoff({ id, unclaim: true }, reader);
        const first = await handleHandoffGet(args, reader);
        expect(first).toBe(SafeJSON.stringify(expected, { strict: true }, 2));
        expect(first).toContain("Auto-claimed:");
        expect(getHandoff({ id }, poster).handoff.claimedBy).toHaveLength(1);
        expect(await handleHandoffGet({ id }, reader)).not.toContain("Auto-claimed:");
        await handleHandoffGet({ id, unclaim: true }, reader);
        const latest = getHandoff({ id }, poster);
        expect(latest.handoff.claimedBy).toEqual([]);
        expect(latest.handoff.status).toBe("open");
    });

    test("list matches the legacy filters, paging, warnings and proof previews", async () => {
        const store = freshEnv();
        const poster = store.depsFor(byFor("session-poster"));
        const proof = { answer: "proof ".repeat(50), context: "details", commitIds: ["1", "2", "3", "4", "5", "6"] };
        const posted = postHandoff(
            { title: "First sample", tasks: [{ text: "Read" }], target: { agent: "codex", sessionName: "worker" } },
            poster
        );
        executeHandoffActions(
            { id: posted.handoff.id, actions: [{ action: "check_task", taskId: "t1", proof }] },
            poster
        );
        postHandoff({ title: "Second sample", tasks: [{ text: "Write" }] }, poster);

        for (const input of [
            {},
            { mine: true },
            { agent: "CODEX", session: "worker" },
            { limit: 1, offset: 1 },
            { project: "unknown" },
            { open: true, include: ["tasks", "description"] },
        ]) {
            const expected = listHandoffs(input, poster);
            expect(await handleHandoffList(input, poster)).toBe(SafeJSON.stringify(expected, { strict: true }, 2));
        }

        const rows = await handleHandoffList({ include: ["tasks"] }, poster);
        expect(rows).toContain("Task proofs are previews");
        expect(rows).not.toContain(proof.answer);
    });
});
