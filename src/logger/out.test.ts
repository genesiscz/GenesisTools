import { describe, expect, it } from "bun:test";

describe("out facade discipline", () => {
    it("result()/print() write to STDOUT; log.* write to STDERR", async () => {
        const { out } = await import("./out");
        const o: string[] = [];
        const e: string[] = [];
        const oo = process.stdout.write.bind(process.stdout);
        const oe = process.stderr.write.bind(process.stderr);
        process.stdout.write = (c: string) => {
            o.push(String(c));
            return true;
        };
        process.stderr.write = (c: string) => {
            e.push(String(c));
            return true;
        };
        try {
            out.result({ ok: true });
            out.print("RAW_LINE");
            out.log.info("STATUS_LINE");
            await Bun.sleep(10);
        } finally {
            // Always restore the real writers — a thrown assertion below must
            // not leave the whole suite's stdout/stderr patched.
            process.stdout.write = oo;
            process.stderr.write = oe;
        }
        expect(o.join("")).toContain('"ok":true');
        expect(o.join("")).toContain("RAW_LINE");
        expect(o.join("")).not.toContain("STATUS_LINE");
        expect(e.join("")).toContain("STATUS_LINE");
    });

    it("re-exports the real clack isCancel sentinel", async () => {
        const { out } = await import("./out");
        const clack = await import("@clack/prompts");
        expect(out.isCancel).toBe(clack.isCancel);
    });

    it("out.info/warn/error shortcuts write to STDERR like out.log.info/warn/error", async () => {
        const { out } = await import("./out");
        const e: string[] = [];
        const oe = process.stderr.write.bind(process.stderr);
        process.stderr.write = (c: string) => {
            e.push(String(c));
            return true;
        };
        try {
            out.info("INFO_SHORTCUT");
            out.warn("WARN_SHORTCUT");
            out.error("ERROR_SHORTCUT");
            await Bun.sleep(10);
        } finally {
            process.stderr.write = oe;
        }
        const combined = e.join("");
        expect(combined).toContain("INFO_SHORTCUT");
        expect(combined).toContain("WARN_SHORTCUT");
        expect(combined).toContain("ERROR_SHORTCUT");
    });

    it("out.warn() passes rest args after the message", async () => {
        const { out } = await import("./out");
        const e: string[] = [];
        const oe = process.stderr.write.bind(process.stderr);
        process.stderr.write = (c: string) => {
            e.push(String(c));
            return true;
        };
        try {
            out.warn("WARN_MSG", new Error("rest-err"));
            await Bun.sleep(10);
        } finally {
            process.stderr.write = oe;
        }
        const combined = e.join("");
        expect(combined).toContain("WARN_MSG");
    });
});
