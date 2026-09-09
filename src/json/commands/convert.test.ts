import { expect, test } from "bun:test";
import { fromToon, toToon } from "@app/json/lib/toon";
import { detectFormat } from "./convert";

/**
 * `tools json` is the pipe the repo tells every agent to read JSON through, so a TOON
 * document it cannot read back is silent data loss. `extractEmbeddedJson` ran first and
 * matched the `[3]` inside a TOON array header, so `users[3]{id,name,role}:` and its three
 * rows came back as the literal `[3]`.
 */

const TABULAR = "users[3]{id,name,role}:\n  1,alice,admin\n  2,bob,user\n  3,carol,user";
const NESTED = "a: 1\nb[3]:\n  - 1\n  - 2\n  - c: x\nd: null";

test("a TOON array header is not read as embedded JSON", () => {
    expect(detectFormat(TABULAR)).toBe("toon");
    expect(detectFormat(NESTED)).toBe("toon");
});

test("every TOON document this tool emits decodes back to the value it came from", () => {
    const values: unknown[] = [
        {
            users: [
                { id: 1, name: "alice" },
                { id: 2, name: "bob" },
            ],
        },
        { a: 1, b: [1, 2, { c: "x" }], d: null },
        [1, 2, 3],
        { nested: { deep: { list: ["one", "two"] } } },
    ];

    for (const value of values) {
        const toon = toToon(value);
        expect(detectFormat(toon)).toBe("toon");
        expect(fromToon(toon)).toEqual(value);
    }
});

test("a JSON island inside prose is still read as embedded JSON", () => {
    // The negative control. TOON's `key: value` syntax decodes this line WITHOUT error,
    // handing back one key whose value is the raw JSON text, so preferring TOON blindly
    // would have regressed the case the embedded path exists for.
    expect(detectFormat('API 400: {"success": false}')).toBe("embedded-json");
    expect(detectFormat('Request failed after 3 retries: {"a":1}')).toBe("embedded-json");
});

test("plain prose is still unknown, and plain JSON is still JSON", () => {
    expect(detectFormat("some prose\nmore prose")).toBe("unknown");
    expect(detectFormat('{"a":1}')).toBe("json");
    expect(detectFormat('{"a":1}\n{"a":2}')).toBe("jsonl");
});
