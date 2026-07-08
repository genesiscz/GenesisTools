import { describe, expect, it } from "bun:test";
import { composeDefaultSize, normalizeOptions, stampLayer, validateComposeCard } from "./compose-validate";

function code(kind: string, payload: Record<string, unknown>): string | "ok" {
    const r = validateComposeCard({ kind, payload });
    return r.ok ? "ok" : r.code;
}

describe("validateComposeCard — per-kind payloads", () => {
    it("accepts well-formed cards of every kind", () => {
        expect(code("text", { md: "# hi" })).toBe("ok");
        expect(code("note", { text: "sticky" })).toBe("ok");
        expect(code("shape", {})).toBe("ok"); // shape has no payload constraints
        expect(code("cluster", {})).toBe("ok"); // cluster has no payload constraints
        expect(code("viz", { viz: "table", data: {} })).toBe("ok");
        expect(code("section", { title: "Checkout" })).toBe("ok");
        expect(code("step", { title: "Cart", status: "pass" })).toBe("ok");
        expect(code("step", { title: "Cart", status: "" })).toBe("ok"); // empty status allowed
        expect(code("callout", { md: "note", tone: "info" })).toBe("ok");
        expect(code("callout", { md: "note" })).toBe("ok"); // tone optional
        expect(code("checklist", { items: [{ text: "one" }] })).toBe("ok");
        expect(code("wireframe", { nodes: [{ t: "nav" }], device: "phone" })).toBe("ok");
        expect(code("compare", { a: { cardId: 12 }, b: { cardId: 15 } })).toBe("ok");
    });

    it("rejects malformed payloads with bad_payload", () => {
        expect(code("text", {})).toBe("bad_payload"); // no md
        expect(code("note", {})).toBe("bad_payload"); // no text
        expect(code("viz", { viz: "pie", data: {} })).toBe("bad_payload"); // unknown viz
        expect(code("viz", { viz: "table" })).toBe("bad_payload"); // no data object
        expect(code("section", {})).toBe("bad_payload"); // no title
        expect(code("step", { title: "x", status: "maybe" })).toBe("bad_payload");
        expect(code("callout", { md: "x", tone: "angry" })).toBe("bad_payload");
        expect(code("checklist", { items: [] })).toBe("bad_payload"); // 0 items
        expect(code("checklist", { items: Array.from({ length: 51 }, () => ({ text: "x" })) })).toBe("bad_payload");
        expect(code("checklist", { items: [{ done: true }] })).toBe("bad_payload"); // item without text
        expect(code("wireframe", { nodes: [] })).toBe("bad_payload"); // 0 nodes
        expect(code("wireframe", { nodes: Array.from({ length: 41 }, () => ({ t: "text" })) })).toBe("bad_payload");
        expect(code("wireframe", { nodes: [{ label: "x" }] })).toBe("bad_payload"); // node without t
        expect(code("wireframe", { nodes: [{ t: "nav" }], device: "watch" })).toBe("bad_payload");
        expect(code("wireframe", { nodes: [{ t: "nav" }], fidelity: "hi" })).toBe("bad_payload");
        expect(code("compare", { a: { cardId: 0 }, b: { cardId: 15 } })).toBe("bad_payload");
        expect(code("compare", { a: { cardId: 12 } })).toBe("bad_payload"); // missing b
    });

    it("rejects an unknown kind with bad_kind", () => {
        expect(code("hologram", { md: "x" })).toBe("bad_kind");
    });
});

describe("stampLayer / validateComposeCard layer marker", () => {
    it("stamps layer:ai on non-section cards and preserves an explicit layer", () => {
        const r = validateComposeCard({ kind: "text", payload: { md: "x" } });
        expect(r.ok && r.payload.layer).toBe("ai");
        const kept = validateComposeCard({ kind: "text", payload: { md: "x", layer: "base" } });
        expect(kept.ok && kept.payload.layer).toBe("base");
    });

    it("strips the layer marker from section cards", () => {
        const r = validateComposeCard({ kind: "section", payload: { title: "Onboarding", layer: "ai" } });
        expect(r.ok && "layer" in r.payload).toBe(false);
    });

    it("stampLayer does not mutate its input", () => {
        const input = { md: "x" };
        stampLayer("text", input);
        expect("layer" in input).toBe(false);
    });
});

describe("composeDefaultSize (vitrinka-exact)", () => {
    it("returns per-kind default footprints", () => {
        expect(composeDefaultSize("text", { role: "heading" })).toEqual({ w: 420, h: 72 });
        expect(composeDefaultSize("text", {})).toEqual({ w: 280, h: 150 });
        expect(composeDefaultSize("note", {})).toEqual({ w: 230, h: 140 });
        expect(composeDefaultSize("viz", { viz: "table" })).toEqual({ w: 380, h: 260 });
        expect(composeDefaultSize("viz", { viz: "matrix" })).toEqual({ w: 340, h: 340 });
        expect(composeDefaultSize("wireframe", { device: "phone" })).toEqual({ w: 260, h: 520 });
        expect(composeDefaultSize("wireframe", { device: "web" })).toEqual({ w: 520, h: 380 });
        expect(composeDefaultSize("checklist", { items: [{ text: "a" }, { text: "b" }] })).toEqual({ w: 300, h: 124 });
        expect(composeDefaultSize("compare", {})).toEqual({ w: 480, h: 340 });
    });
});

describe("normalizeOptions", () => {
    it("accepts strings and objects, normalizing to {label, hint?, recommended?}", () => {
        const r = normalizeOptions(["A", { label: "B", hint: "why B", recommended: true }]);
        expect(r).toEqual({ ok: true, options: [{ label: "A" }, { label: "B", hint: "why B", recommended: true }] });
    });

    it("rejects 0 options, >12 options, empty labels, and oversized labels/hints", () => {
        expect(normalizeOptions([])).toEqual({ ok: false, code: "bad_question" });
        expect(normalizeOptions(Array.from({ length: 13 }, () => "x"))).toEqual({ ok: false, code: "bad_question" });
        expect(normalizeOptions([""])).toEqual({ ok: false, code: "bad_question" });
        expect(normalizeOptions([{ label: "a".repeat(201) }])).toEqual({ ok: false, code: "bad_question" });
        expect(normalizeOptions([{ label: "ok", hint: "h".repeat(301) }])).toEqual({ ok: false, code: "bad_question" });
    });
});
