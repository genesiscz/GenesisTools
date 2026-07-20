import { describe, expect, test } from "bun:test";
import { executeHandoffActions, getHandoff, listHandoffs, postHandoff } from "./executor";
import { HANDOFF_INCLUDE_SECTIONS, isEventsOnlyInclude, parseIncludeSections, projectHandoff } from "./project";
import { byFor, freshEnv } from "./test-utils";

const A = byFor("session-a", "poster-a");
const B = byFor("session-b", "worker-b");

describe("include scoping (G4)", () => {
    test("parseIncludeSections rejects unknown names with catalog", () => {
        expect(() => parseIncludeSections(["tasks", "nope"])).toThrow(/Unknown include/);
        expect(() => parseIncludeSections(["tasks", "nope"])).toThrow(HANDOFF_INCLUDE_SECTIONS[0]);
        expect(isEventsOnlyInclude(["events"])).toBe(true);
        expect(isEventsOnlyInclude(["events", "tasks"])).toBe(false);
    });

    test("default MCP lean shape has tasks + core; omits comments/claimedBy", () => {
        const env = freshEnv();
        const posted = postHandoff(
            { title: "T", description: "why", tasks: [{ text: "one" }, { text: "two" }] },
            env.depsFor(A)
        );
        getHandoff({ id: posted.handoff.id, claim: true }, env.depsFor(B));
        executeHandoffActions({ id: posted.handoff.id, actions: [{ action: "comment", text: "hi" }] }, env.depsFor(B));

        const lean = getHandoff({ id: posted.handoff.id, include: ["tasks"] }, env.depsFor(B));
        expect("handoff" in lean).toBe(true);

        if (!("handoff" in lean)) {
            throw new Error("expected handoff envelope");
        }

        expect(lean.handoff.tasks).toHaveLength(2);
        expect("tasksSummary" in lean.handoff).toBe(true);
        expect("comments" in lean.handoff).toBe(false);
        expect("claimedBy" in lean.handoff).toBe(false);
        expect("postedByContext" in lean.handoff).toBe(false);
    });

    test("omit include → full PublicHandoff (HTTP path)", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const full = getHandoff({ id: posted.handoff.id }, env.depsFor(A));
        expect("handoff" in full).toBe(true);

        if (!("handoff" in full)) {
            throw new Error("expected handoff envelope");
        }

        expect(full.handoff.tasks).toHaveLength(1);
        expect("claimedBy" in full.handoff).toBe(true);
        expect("comments" in full.handoff).toBe(true);
        expect("attachments" in full.handoff).toBe(true);
        expect("postedBy" in full.handoff).toBe(true);
        expect("tasksSummary" in full.handoff).toBe(false);
    });

    test("include:[events] alone → bare {events, info}, no editId in payloads", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const bare = getHandoff({ id: posted.handoff.id, include: ["events"] }, env.depsFor(A));
        expect("events" in bare).toBe(true);
        expect("handoff" in bare).toBe(false);

        if (!("events" in bare)) {
            throw new Error("expected events");
        }

        expect(bare.events.length).toBeGreaterThanOrEqual(1);
        expect(bare.events.some((e) => e.ev === "post")).toBe(true);

        for (const event of bare.events) {
            expect("editId" in event).toBe(false);
        }
    });

    test("list include tasks adds taskList; other sections info-no-op", () => {
        const env = freshEnv();
        postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const listed = listHandoffs({ include: ["tasks", "comments"] }, env.depsFor(A));
        expect(listed.handoffs[0].taskList).toHaveLength(1);
        expect(listed.info.some((line) => line.includes("ignored"))).toBe(true);
    });

    test("projectHandoff full sections ≈ public shape keys", () => {
        const env = freshEnv();
        const posted = postHandoff({ title: "T", tasks: [{ text: "one" }] }, env.depsFor(A));
        const full = getHandoff({ id: posted.handoff.id }, env.depsFor(A));

        if (!("handoff" in full)) {
            throw new Error("expected handoff");
        }

        const projected = projectHandoff({
            handoff: full.handoff as Parameters<typeof projectHandoff>[0]["handoff"],
            sections: [...HANDOFF_INCLUDE_SECTIONS].filter((s) => s !== "events"),
        });
        expect(projected.tasks).toHaveLength(1);
        expect(projected.claimedBy).toEqual([]);
        expect(projected.comments).toEqual([]);
        expect(projected.tasksSummary).toBe("0/1");
    });
});
