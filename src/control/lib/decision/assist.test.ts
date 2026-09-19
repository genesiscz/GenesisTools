import { describe, expect, test } from "bun:test";
import { namesTheSameThing } from "./assist";

describe("the repeated-target guard", () => {
    test("a relabelled row is the same thing: the list entry and the opened conversation", () => {
        expect(namesTheSameThing({ label: "+1 (888) 555-1212, 01.01.2001" }, { label: "+1 (888) 555-1212" })).toBe(
            true
        );
        expect(namesTheSameThing({ label: "+1 (888) 555-1212" }, { label: "+1 (888) 555-1212, 01.01.2001" })).toBe(
            true
        );
        expect(namesTheSameThing({ label: "Accessibility" }, { label: "Accessibility" })).toBe(true);
    });

    test("two genuinely different targets are not the same thing", () => {
        expect(namesTheSameThing({ label: "+1 (888) 555-1212" }, { label: "+1 (555) 564-8583" })).toBe(false);
        expect(namesTheSameThing({ label: "General" }, { label: "Accessibility" })).toBe(false);
        expect(namesTheSameThing({ label: "Camera" }, { label: "Camera Roll" })).toBe(false);
    });

    test("nothing acted on yet is never a repeat", () => {
        expect(namesTheSameThing(undefined, { label: "Accessibility" })).toBe(false);
    });

    test("a trailing clause that carries words is a different target, not decoration", () => {
        expect(namesTheSameThing({ label: "OK" }, { label: "OK, continue" })).toBe(false);
        expect(namesTheSameThing({ label: "OK" }, { label: "OK" })).toBe(true);
        expect(namesTheSameThing({ label: "Add" }, { label: "Address" })).toBe(false);
        expect(namesTheSameThing({ label: "Wi-Fi" }, { label: "Wi-Fi, Not Connected" })).toBe(false);
    });

    test("only a letterless trailing segment counts as decoration", () => {
        expect(namesTheSameThing({ label: "Screen Time" }, { label: "screen  time" })).toBe(true);
        expect(namesTheSameThing({ label: "Inbox, 12" }, { label: "Inbox" })).toBe(true);
        expect(namesTheSameThing({ label: "Event, 14:30" }, { label: "Event" })).toBe(true);
        expect(namesTheSameThing({ label: "Display & Text Size — On" }, { label: "Display & Text Size" })).toBe(false);
    });

    test("identity wins over the label when both rows carry one", () => {
        // A second "Continue" after navigation is a DIFFERENT button. Blocking it on the word
        // alone stopped real two-step tasks, which is why targetKey is consulted first.
        expect(namesTheSameThing({ targetKey: "a", label: "Continue" }, { targetKey: "b", label: "Continue" })).toBe(
            false
        );
        expect(
            namesTheSameThing({ targetKey: "a", label: "Continue" }, { targetKey: "a", label: "Continue, 2 left" })
        ).toBe(true);
    });

    test("without a key on both sides the label rule still decides", () => {
        expect(namesTheSameThing({ targetKey: "a", label: "Inbox" }, { label: "Inbox" })).toBe(true);
        expect(namesTheSameThing({ label: "Inbox" }, { label: "Archive" })).toBe(false);
    });
});
