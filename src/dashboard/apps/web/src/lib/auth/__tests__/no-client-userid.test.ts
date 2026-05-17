import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

// Regression guard for the universal-IDOR bug class (prod-audit 01 P0-1):
// a `userId` accepted from client input lets any member read/mutate another
// member's data. After Phase 2, every data server function derives the user
// from requireUserId() (the session) — NEVER from the request payload.
//
// This statically scans every *.server.ts for an `inputValidator` whose input
// shape declares a `userId` field (or is the bare userId string). If this test
// fails, a server fn reintroduced client-supplied identity — fix it, don't
// weaken the test.

const SERVER_FN_DIR = join(import.meta.dirname, "../../..");

function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === "__tests__") {
            continue;
        }

        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            out.push(...walk(full));
        } else if (entry.endsWith(".server.ts")) {
            out.push(full);
        }
    }

    return out;
}

// Matches `.inputValidator(... userId ...)` up to the closing `)` of the call.
const INPUT_VALIDATOR_BLOCK = /\.inputValidator\(([\s\S]*?)\)\s*\.handler/g;

describe("no client-supplied userId in server fn inputValidators", () => {
    const files = walk(SERVER_FN_DIR);

    test("at least the known server-fn files are scanned", () => {
        expect(files.length).toBeGreaterThanOrEqual(5);
    });

    for (const file of files) {
        test(`${file.split("/apps/web/")[1]} has no userId in any inputValidator`, () => {
            const src = readFileSync(file, "utf8");
            const offenders: string[] = [];

            for (const match of src.matchAll(INPUT_VALIDATOR_BLOCK)) {
                const block = match[1];
                // Strip string literals so `Omit<NewX, "userId">` (the SECURE
                // exclusion pattern) is not flagged — only a `userId` used as an
                // input field / bare param is a real client-supplied-id offender.
                const code = block.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
                if (/\buserId\b/.test(code) || /\/\/\s*userId/.test(block)) {
                    offenders.push(block.trim().slice(0, 120));
                }
            }

            expect(offenders, `client-supplied userId found in inputValidator:\n${offenders.join("\n")}`).toEqual([]);
        });
    }
});
