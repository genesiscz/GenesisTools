import { describe, expect, it } from "bun:test";
import { CLONES_GLOSSARY, type CloneRenderer, type Format } from "@app/macos/lib/clones/render/types";

describe("clones render types", () => {
    it("exports the canonical glossary footer text", () => {
        expect(CLONES_GLOSSARY).toContain("ATTR_CMNEXT_PRIVATESIZE");
        expect(CLONES_GLOSSARY).toContain("du ÷ real");
        expect(CLONES_GLOSSARY).toContain("clone family");
        expect(CLONES_GLOSSARY).toContain("cross-tree");
    });

    it("CloneRenderer is structurally satisfiable", () => {
        const fmt: Format = "table";
        const r: CloneRenderer = {
            measure: () => "m",
            duplicates: () => "d",
            processReport: () => "p",
            processList: () => "l",
        };
        expect(fmt).toBe("table");
        expect(r.measure({} as never)).toBe("m");
    });
});
