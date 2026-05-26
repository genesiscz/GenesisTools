import { describe, expect, it } from "bun:test";
import { resolveRunMode } from "@app/task/lib/run-mode";

describe("resolveRunMode", () => {
    it("honours commander tty=false from --no-tty", () => {
        expect(resolveRunMode({ tty: false })).toBe("pipe");
    });

    it("honours explicit tty=true", () => {
        expect(resolveRunMode({ tty: true })).toBe("pty");
    });
});
