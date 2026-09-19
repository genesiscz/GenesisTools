import { describe, expect, test } from "bun:test";
import { applyNarrow, NARROW_MIN_CANDIDATES, narrowCandidates } from "./narrow";
import type { ListenCandidate } from "./verbs";

const row = (over: Partial<ListenCandidate>): ListenCandidate => ({
    id: "c0",
    label: "row",
    action: "press",
    element: 0,
    ...over,
});

const screen: ListenCandidate[] = [
    row({ id: "b1", label: "Save", role: "AXButton" }),
    row({ id: "b2", label: "Log In", role: "button" }),
    row({ id: "l1", label: "Odablock", role: "link" }),
    row({ id: "f1", label: "Search", role: "searchbox", action: "set" }),
    row({ id: "m1", label: "File > New", action: "menu" }),
    row({ id: "a1", label: "switch to Brave", action: "app" }),
    row({ id: "u1", label: "something with no role" }),
];

describe("narrowing what the next utterance may choose", () => {
    test("a small screen is not worth narrowing, and an active narrowing always offers its way out", () => {
        expect(narrowCandidates(null, 4)).toEqual([]);
        expect(narrowCandidates(null, NARROW_MIN_CANDIDATES).length).toBeGreaterThan(0);

        const wayOut = narrowCandidates("buttons", 4);
        expect(wayOut.map((item) => item.narrow)).toContain("all");
        expect(wayOut.map((item) => item.narrow)).not.toContain("buttons");
    });

    test("each narrowing keeps its own kind, and a link is never a button", () => {
        expect(applyNarrow(screen, "buttons").map((item) => item.id)).toEqual(["b1", "b2", "u1"]);
        expect(applyNarrow(screen, "links").map((item) => item.id)).toEqual(["l1", "u1"]);
        expect(applyNarrow(screen, "fields").map((item) => item.id)).toEqual(["f1"]);
        expect(applyNarrow(screen, "menus").map((item) => item.id)).toEqual(["m1"]);
        expect(applyNarrow(screen, "apps").map((item) => item.id)).toEqual(["a1"]);
    });

    test("no narrowing, or one that matches nothing, offers everything rather than a dead end", () => {
        expect(applyNarrow(screen, null)).toEqual(screen);
        expect(applyNarrow(screen, "all")).toEqual(screen);
        expect(applyNarrow([row({ id: "l1", role: "link" })], "menus").map((item) => item.id)).toEqual(["l1"]);
    });
});
