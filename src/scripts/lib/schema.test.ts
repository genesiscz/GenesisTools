import { describe, expect, it } from "bun:test";
import { describeCollection, formatSchema } from "./schema.ts";

describe("formatSchema typescript mode", () => {
    it("quotes keys that are not valid TS identifiers", () => {
        const rendered = formatSchema({ "content-type": "x", "first name": "y", "2fa": true, plain: 1 }, "typescript");

        expect(rendered).toContain('"content-type": string;');
        expect(rendered).toContain('"first name": string;');
        expect(rendered).toContain('"2fa": boolean;');
        expect(rendered).toContain("plain: number;");
    });

    it("emits a root alias when the top-level value is not itself an interface", () => {
        const rendered = formatSchema([{ title: "a" }, { title: "b" }], "typescript", { rootName: "Items" });

        expect(rendered).toContain("interface Item {");
        expect(rendered).toContain("type Items = Item[];");
    });

    it("digit-prefixed keys still yield valid interface names", () => {
        const rendered = formatSchema({ "2fa": { enabled: true } }, "typescript");

        expect(rendered).toContain("interface Fa {");
        expect(rendered).toContain('"2fa": Fa;');
        expect(rendered).not.toContain("interface 2fa");
    });

    it("a digit-prefixed root name is stripped and re-cased", () => {
        const rendered = formatSchema([1, 2], "typescript", { rootName: "2fa" });

        expect(rendered).toBe("type Fa = number[];");
    });

    it("an all-digit root name falls back to Root", () => {
        const rendered = formatSchema([1, 2], "typescript", { rootName: "2" });

        expect(rendered).toBe("type Root = number[];");
    });

    it("still names an object root by its interface alone", () => {
        const rendered = formatSchema({ id: 1 }, "typescript", { rootName: "Payload" });

        expect(rendered).toContain("interface Payload {");
        expect(rendered).not.toContain("type Payload =");
    });
});

describe("describeCollection", () => {
    it("reports count, fields and sometimes-missing keys", () => {
        expect(describeCollection([{ a: 1, b: 2 }, { a: 3 }])).toBe("2 item(s), 2 field(s), sometimes-missing: b");
    });
});
