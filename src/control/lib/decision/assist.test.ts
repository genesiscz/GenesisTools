import { describe, expect, test } from "bun:test";
import { namesTheSameThing } from "./assist";

describe("the repeated-target guard", () => {
    test("a relabelled row is the same thing: the list entry and the opened conversation", () => {
        expect(namesTheSameThing("+1 (888) 555-1212, 01.01.2001", "+1 (888) 555-1212")).toBe(true);
        expect(namesTheSameThing("+1 (888) 555-1212", "+1 (888) 555-1212, 01.01.2001")).toBe(true);
        expect(namesTheSameThing("Accessibility", "Accessibility")).toBe(true);
    });

    test("two genuinely different targets are not the same thing", () => {
        expect(namesTheSameThing("+1 (888) 555-1212", "+1 (555) 564-8583")).toBe(false);
        expect(namesTheSameThing("General", "Accessibility")).toBe(false);
        expect(namesTheSameThing("Camera", "Camera Roll")).toBe(false);
    });

    test("nothing acted on yet is never a repeat", () => {
        expect(namesTheSameThing(undefined, "Accessibility")).toBe(false);
    });

    test("a trailing clause that carries words is a different target, not decoration", () => {
        expect(namesTheSameThing("OK", "OK, continue")).toBe(false);
        expect(namesTheSameThing("OK", "OK")).toBe(true);
        expect(namesTheSameThing("Add", "Address")).toBe(false);
        expect(namesTheSameThing("Wi-Fi", "Wi-Fi, Not Connected")).toBe(false);
    });

    test("only a letterless trailing segment counts as decoration", () => {
        expect(namesTheSameThing("Screen Time", "screen  time")).toBe(true);
        expect(namesTheSameThing("Inbox, 12", "Inbox")).toBe(true);
        expect(namesTheSameThing("Event, 14:30", "Event")).toBe(true);
        expect(namesTheSameThing("Display & Text Size — On", "Display & Text Size")).toBe(false);
    });
});
