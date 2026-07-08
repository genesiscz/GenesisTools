import { describe, expect, it } from "bun:test";
import {
    containingSection,
    journeyKey,
    resolveJourneyPass,
    type SectionCard,
    sectionMembers,
    sectionsToJSON,
} from "./sections";

function frame(id: number, x: number, y: number, w: number, h: number, payload: Record<string, unknown>): SectionCard {
    return { id, kind: "section", x, y, w, h, payload };
}
function card(id: number, x: number, y: number, w = 50, h = 50): SectionCard {
    return { id, kind: "shot", x, y, w, h, payload: {} };
}

describe("containingSection — spatial membership", () => {
    const A = frame(1, 0, 0, 1000, 1000, { title: "A" });
    const B = frame(2, 50, 50, 200, 200, { title: "B" });

    it("returns the frame whose bounds contain the card center", () => {
        expect(containingSection([A], card(10, 500, 500))?.id).toBe(1);
    });

    it("returns the SMALLEST frame when nested", () => {
        // center (125,125) lies inside both A and B → the smaller B wins.
        expect(containingSection([A, B], card(10, 100, 100))?.id).toBe(2);
    });

    it("probes a zero-size card with a 340x220 footprint (center = x+170, y+110)", () => {
        const holder = frame(3, 0, 0, 300, 300, { title: "Z" });
        const zero: SectionCard = { id: 9, kind: "shot", x: 10, y: 10, w: 0, h: 0, payload: {} };
        // center = (180, 120) → inside the 300x300 frame
        expect(containingSection([holder], zero)?.id).toBe(3);
    });

    it("returns null when no frame holds the card", () => {
        expect(containingSection([A], card(10, 5000, 5000))).toBeNull();
    });
});

describe("journeyKey", () => {
    it("normalizes spaces/case to a dash slug so variants chain up", () => {
        expect(journeyKey("Checkout Flow")).toBe("checkout-flow");
        expect(journeyKey("checkout-flow")).toBe("checkout-flow");
        expect(journeyKey("  Checkout   Flow!! ")).toBe("checkout-flow");
        expect(journeyKey("---")).toBe("");
    });
});

describe("sectionsToJSON / journeys", () => {
    it("counts spatial members and summarizes a 3-pass chain", () => {
        const cards: SectionCard[] = [
            frame(1, 0, 0, 400, 400, { title: "Checkout", journey: "checkout", pass: 1 }),
            frame(2, 480, 0, 400, 400, { title: "Checkout — pass 2", journey: "checkout", pass: 2 }),
            frame(3, 960, 0, 400, 400, { title: "Checkout — pass 3", journey: "checkout", pass: 3 }),
            card(10, 100, 100), // inside pass 1
            card(11, 580, 100), // inside pass 2
        ];
        const { sections, journeys } = sectionsToJSON(cards);
        expect(sections.map((s) => s.cards)).toEqual([1, 1, 0]);
        expect(sections[0].order).toBe(0);
        expect(journeys).toEqual([{ journey: "checkout", title: "Checkout", passes: 3, latest: "Checkout — pass 3" }]);
    });

    it("sectionMembers resolves the named section case-insensitively", () => {
        const cards: SectionCard[] = [frame(1, 0, 0, 400, 400, { title: "Checkout" }), card(10, 100, 100)];
        const frames = cards.filter((c) => c.kind === "section");
        expect(sectionMembers(frames, cards, "checkout").map((c) => c.id)).toEqual([10]);
        expect(sectionMembers(frames, cards, "nope")).toEqual([]);
    });
});

describe("resolveJourneyPass", () => {
    it("adopts a plain section titled like the journey as pass 1", () => {
        const cards: SectionCard[] = [frame(5, 0, 0, 960, 640, { title: "Onboarding" })];
        const r = resolveJourneyPass({ cards, journey: "onboarding" });
        expect(r.action).toBe("adopt");
        if (r.action === "adopt") {
            expect(r.section.id).toBe(5);
            expect(r.journey).toBe("onboarding");
        }
    });

    it("creates pass 1 when no matching section exists", () => {
        const r = resolveJourneyPass({ cards: [], journey: "checkout" });
        expect(r.action).toBe("create");
        if (r.action === "create") {
            expect(r.frame.payload).toMatchObject({ journey: "checkout", pass: 1, title: "Checkout" });
        }
    });

    it("'next' creates pass N+1 named from the prev base title, beside it, inheriting layout", () => {
        const cards: SectionCard[] = [
            frame(1, 100, 40, 400, 300, { title: "Checkout", journey: "checkout", pass: 1, layout: { mode: "grid" } }),
        ];
        const r = resolveJourneyPass({ cards, journey: "checkout", pass: "next" });
        expect(r.action).toBe("create");
        if (r.action === "create") {
            expect(r.frame.x).toBe(100 + 400 + 80); // prev.x + prev.w + gutter
            expect(r.frame.y).toBe(40);
            expect(r.frame.w).toBe(400);
            expect(r.frame.payload).toMatchObject({
                journey: "checkout",
                pass: 2,
                title: "Checkout — pass 2",
                layout: { mode: "grid" },
            });
        }
    });

    it("errors bad_journey on a pass that would leave a gap", () => {
        const cards: SectionCard[] = [frame(1, 0, 0, 400, 300, { title: "Checkout", journey: "checkout", pass: 1 })];
        const r = resolveJourneyPass({ cards, journey: "checkout", pass: 3 });
        expect(r.action).toBe("error");
        if (r.action === "error") {
            expect(r.code).toBe("bad_journey");
            expect(r.message).toContain("gap");
        }
    });
});
