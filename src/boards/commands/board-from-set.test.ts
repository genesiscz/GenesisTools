import { describe, expect, it } from "bun:test";
import { boardSlugFrom } from "./board-from-set";

describe("boardSlugFrom", () => {
    it("lowercases the key", () => {
        expect(boardSlugFrom("S-20260708-0905")).toBe("s-20260708-0905");
    });

    it("dashes any character outside [a-z0-9-]", () => {
        expect(boardSlugFrom("My Set!")).toBe("my-set-");
    });

    it("leaves an already-valid slug untouched", () => {
        expect(boardSlugFrom("my-board-3")).toBe("my-board-3");
    });
});
