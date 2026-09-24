import { describe, expect, it } from "bun:test";
import type { Ctx } from "../../../lib/git-context.ts";
import { configuredDefault } from "./resolve.ts";

const main: Ctx = {
    toplevel: "/repos/acme",
    branch: "feature/next",
    cwd: "/repos/acme",
    pinned: { project: false, branch: false },
};

describe("configuredDefault", () => {
    it("returns an absolute defaultPath unchanged", () => {
        expect(configuredDefault({ defaultPath: "/vault/Research", pathKind: "absolute" }, main)).toBe(
            "/vault/Research"
        );
    });

    it("resolves a project-relative defaultPath against the toplevel", () => {
        expect(configuredDefault({ defaultPath: ".claude/research", pathKind: "project-relative" }, main)).toBe(
            "/repos/acme/.claude/research"
        );
    });

    it("treats a relative path with no pathKind as project-relative", () => {
        expect(configuredDefault({ defaultPath: ".claude/research" }, main)).toBe("/repos/acme/.claude/research");
    });

    it("returns null when nothing is configured", () => {
        expect(configuredDefault({}, main)).toBeNull();
    });
});
