import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { cwdFromTitle } from "@app/cmux/lib/shell-probe";

describe("cwdFromTitle", () => {
    it("returns undefined for empty/null titles", () => {
        expect(cwdFromTitle(null)).toBeUndefined();
        expect(cwdFromTitle(undefined)).toBeUndefined();
        expect(cwdFromTitle("")).toBeUndefined();
    });

    it("expands user@host:~/path titles", () => {
        const out = cwdFromTitle("Martin@MacBook-Pro:~/Tresors/Projects/Foo");
        expect(out).toBe(join(homedir(), "Tresors/Projects/Foo"));
    });

    it("keeps absolute user@host:/abs paths", () => {
        const out = cwdFromTitle("user@host:/usr/local/bin");
        expect(out).toBe("/usr/local/bin");
    });

    it("expands ellipsis prefix titles (cmux abbreviation)", () => {
        const out = cwdFromTitle("…/Projects/Bar");
        expect(out).toBe(join(homedir(), "Projects/Bar"));
    });

    it("expands tilde prefix titles", () => {
        const out = cwdFromTitle("~/Documents");
        expect(out).toBe(join(homedir(), "Documents"));
    });

    it("returns absolute paths verbatim", () => {
        expect(cwdFromTitle("/etc")).toBe("/etc");
        expect(cwdFromTitle("/var/log/system")).toBe("/var/log/system");
    });

    it("ignores titles that don't look like paths (claude-style busy markers)", () => {
        expect(cwdFromTitle("✳ Debug formatting and spacing issues")).toBeUndefined();
        expect(cwdFromTitle("tools claude usage")).toBeUndefined();
        expect(cwdFromTitle("Terminal")).toBeUndefined();
    });
});
