import { describe, expect, test } from "bun:test";
import { judgeFacts } from "./three-way";

describe("the check before a push", () => {
    test("a fact the outside still holds as last sent is written; one edited outside stays and is named", () => {
        const judged = judgeFacts({
            ours: { title: "new here", body: "same", state: "done" },
            theirs: { title: "old", body: "same", state: "in_review" },
            base: { title: "old", body: "same", state: "todo" },
        });
        expect(judged.send).toEqual(["title"]);
        expect(judged.sent).toEqual({ title: "new here", body: "same" });
        expect(judged.changedOutside).toEqual([{ fact: "state", outside: "in_review", here: "done" }]);
    });

    test("with no base only an empty outside value is written, and force writes whatever the outside holds", () => {
        const ours = { title: "here", body: "text", parent: "12" };
        const theirs = { title: "edited outside", body: "", parent: "" };
        expect(judgeFacts({ ours, theirs, base: {} })).toEqual({
            send: ["body", "parent"],
            sent: { body: "text", parent: "12" },
            changedOutside: [{ fact: "title", outside: "edited outside", here: "here" }],
        });
        expect(judgeFacts({ ours, theirs, base: {}, force: ["title"] }).send).toEqual(["title", "body", "parent"]);
    });

    test("both sides at the same value settle without a write, whitespace aside; an unread fact is written", () => {
        const judged = judgeFacts({
            ours: { body: "line\n", type: "story" },
            theirs: { body: "line\r\n" },
            base: { body: "older" },
        });
        expect(judged).toEqual({ send: ["type"], sent: { body: "line\n", type: "story" }, changedOutside: [] });
    });
});
