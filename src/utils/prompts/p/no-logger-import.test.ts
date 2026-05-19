import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

describe("p/ has no @app/logger value import", () => {
    it("only type-only imports of @app/logger allowed under p/", () => {
        const dir = join(import.meta.dir);
        const offenders: string[] = [];
        for (const f of readdirSync(dir).filter((x) => x.endsWith(".ts") && !x.endsWith(".test.ts"))) {
            const src = readFileSync(join(dir, f), "utf8");
            for (const m of src.matchAll(/import\s+(type\s+)?[^;]*?from\s+["']@app\/logger["']/g)) {
                if (!m[1]) {
                    offenders.push(`${f}: ${m[0]}`);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
