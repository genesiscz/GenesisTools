import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    appendFeedEvent,
    DocumentUnreadableError,
    jsonDocument,
    jsonlLog,
    type UnreadablePolicy,
} from "./locked-document";

interface Counter {
    revision: number;
    count: number;
}

function dir(): string {
    return mkdtempSync(join(tmpdir(), "locked-document-"));
}

function counter(path: string, onUnreadable: UnreadablePolicy = "refuse", extra = {}) {
    return jsonDocument<Counter>({
        path,
        empty: () => ({ revision: 0, count: 0 }),
        decode: (raw) => {
            if (
                typeof raw !== "object" ||
                raw === null ||
                !("count" in raw) ||
                typeof raw.count !== "number" ||
                !("revision" in raw) ||
                typeof raw.revision !== "number"
            ) {
                throw new Error("not a counter");
            }

            return { revision: raw.revision, count: raw.count };
        },
        onUnreadable,
        beforeWrite: (doc) => {
            doc.revision += 1;
        },
        ...extra,
    });
}

describe("jsonDocument", () => {
    test("a missing file reads as empty, and concurrent updates all land", async () => {
        const path = join(dir(), "nested", "counter.json");
        const doc = counter(path);
        expect(doc.read()).toEqual({ revision: 0, count: 0 });

        await Promise.all(
            Array.from({ length: 20 }, () =>
                doc.mutate((current) => {
                    current.count += 1;
                })
            )
        );

        expect(doc.read()).toEqual({ revision: 20, count: 20 });
        expect(existsSync(`${path}.lock`)).toBe(false);
    });

    test("a change that changes nothing writes nothing, unless the store writes always", async () => {
        const path = join(dir(), "counter.json");
        const doc = counter(path);

        expect(await doc.mutate(() => "same")).toBe("same");
        expect(existsSync(path)).toBe(false);
        expect(await doc.update((current) => ({ keep: current.count }))).toBe(0);
        expect(existsSync(path)).toBe(false);

        await counter(path, "refuse", { writes: "always" }).mutate(() => undefined);
        expect(SafeJSON.parse(readFileSync(path, "utf8"))).toEqual({ revision: 1, count: 0 });
    });

    test("refuse: an unusable file throws on read and update and keeps its bytes", async () => {
        const path = join(dir(), "counter.json");
        writeFileSync(path, "{ torn");
        const doc = counter(path);

        expect(() => doc.read()).toThrow(DocumentUnreadableError);
        await expect(doc.mutate((current) => current)).rejects.toThrow("does not parse");
        expect(readFileSync(path, "utf8")).toBe("{ torn");

        writeFileSync(path, '{"count": "x"}');
        await expect(doc.mutate((current) => current)).rejects.toThrow("does not have the expected shape");
        expect(readFileSync(path, "utf8")).toBe('{"count": "x"}');
    });

    test("a mapped error keeps a store's own wording", async () => {
        const path = join(dir(), "counter.json");
        writeFileSync(path, "[]");
        const doc = counter(path, "refuse", {
            unreadableError: (problem: DocumentUnreadableError) => new Error(`counter refused: ${problem.kind}`),
        });

        expect(() => doc.read()).toThrow("counter refused: shape");
        await expect(doc.mutate(() => undefined)).rejects.toThrow("counter refused: shape");
    });

    test("preserve: an unusable file is copied aside before the update starts from empty", async () => {
        const root = dir();
        const path = join(root, "counter.json");
        writeFileSync(path, '{"count": 4');

        await counter(path, "preserve").mutate((current) => {
            current.count += 1;
        });

        expect(SafeJSON.parse(readFileSync(path, "utf8"))).toEqual({ revision: 1, count: 1 });
        const copies = readdirSync(root).filter((name) => name.startsWith("counter.json.corrupt-"));
        expect(copies).toHaveLength(1);
        expect(readFileSync(join(root, copies[0] ?? ""), "utf8")).toBe('{"count": 4');
    });

    test("discard: an unusable cache starts from empty with no copy", async () => {
        const root = dir();
        const path = join(root, "counter.json");
        writeFileSync(path, "nope");

        await counter(path, "discard").mutate((current) => {
            current.count = 7;
        });

        expect(counter(path).read().count).toBe(7);
        expect(readdirSync(root).filter((name) => name.includes(".corrupt-"))).toEqual([]);
    });

    test("a file over maxBytes is too large to read and is never parsed", () => {
        const path = join(dir(), "counter.json");
        writeFileSync(path, SafeJSON.stringify({ revision: 0, count: 1, pad: "x".repeat(100) }));

        expect(() => counter(path, "refuse", { maxBytes: 50 }).read()).toThrow("larger than this store reads");
        expect(counter(path, "refuse", { maxBytes: 500 }).read().count).toBe(1);
    });

    test("readAsync answers what read answers: empty when missing, the value, too-large and unusable files refused", async () => {
        const path = join(dir(), "counter.json");
        expect(await counter(path).readAsync()).toEqual({ revision: 0, count: 0 });

        writeFileSync(path, SafeJSON.stringify({ revision: 2, count: 7, pad: "x".repeat(100) }));
        expect(await counter(path).readAsync()).toEqual(counter(path).read());
        await expect(counter(path, "refuse", { maxBytes: 50 }).readAsync()).rejects.toThrow(
            "larger than this store reads"
        );

        writeFileSync(path, "{ torn");
        await expect(counter(path).readAsync()).rejects.toThrow(DocumentUnreadableError);
    });

    test("an encode that throws refuses the write, and an aborted signal never commits", async () => {
        const path = join(dir(), "counter.json");
        const capped = counter(path, "refuse", {
            encode: (doc: Counter) => {
                if (doc.count > 1) {
                    throw new Error("too big to save");
                }

                return SafeJSON.stringify(doc);
            },
        });

        await capped.mutate((current) => {
            current.count = 1;
        });
        await expect(
            capped.mutate((current) => {
                current.count = 2;
            })
        ).rejects.toThrow("too big to save");
        expect(capped.read().count).toBe(1);

        const aborted = new AbortController();
        aborted.abort();
        await expect(capped.mutate(() => undefined, { signal: aborted.signal })).rejects.toThrow();
        expect(capped.read().count).toBe(1);
    });

    test("the file gets the asked mode", async () => {
        const path = join(dir(), "private.json");
        await counter(path, "refuse", { fileMode: 0o600 }).mutate((current) => {
            current.count = 1;
        });

        expect(statSync(path).mode & 0o777).toBe(0o600);
    });
});

interface Row {
    id: string;
    n: number;
}

function isRow(value: unknown): value is Row {
    return (
        typeof value === "object" &&
        value !== null &&
        "id" in value &&
        typeof value.id === "string" &&
        "n" in value &&
        typeof value.n === "number"
    );
}

describe("jsonlLog", () => {
    test("read counts torn and malformed lines and keeps every readable row", () => {
        const path = join(dir(), "log.jsonl");
        writeFileSync(path, '{"id":"a","n":1}\n{"id":"b","n"\n{"other":true}\n{"id":"c","n":3}\n');

        expect(jsonlLog({ path, isRow }).read()).toEqual({
            rows: [
                { id: "a", n: 1 },
                { id: "c", n: 3 },
            ],
            torn: 1,
            malformed: 1,
            missing: false,
        });
        expect(jsonlLog({ path: join(dir(), "none.jsonl"), isRow }).read()).toEqual({
            rows: [],
            torn: 0,
            malformed: 0,
            missing: true,
        });
    });

    test("append after a torn last line starts a fresh line", () => {
        const path = join(dir(), "log.jsonl");
        writeFileSync(path, '{"id":"a","n":1}\n{"id":"b"');
        const log = jsonlLog({ path, isRow });

        log.append({ id: "c", n: 3 });

        expect(log.read().rows.map((row) => row.id)).toEqual(["a", "c"]);
        expect(readFileSync(path, "utf8")).toBe('{"id":"a","n":1}\n{"id":"b"\n{"id":"c","n":3}\n');
    });

    test("rewrite carries the unreadable lines over verbatim at the top", async () => {
        const path = join(dir(), "log.jsonl");
        writeFileSync(path, '{"id":"a","n":1}\n{"id":"b"\n{"other":true}\n');
        const log = jsonlLog({ path, isRow });

        await log.locked(() => {
            log.rewrite(log.read().rows.map((row) => ({ ...row, n: row.n + 10 })));
        });

        expect(readFileSync(path, "utf8")).toBe('{"id":"b"\n{"other":true}\n{"id":"a","n":11}\n');

        const empty = join(dir(), "empty.jsonl");
        jsonlLog({ path: empty, isRow }).rewrite([]);
        expect(readFileSync(empty, "utf8")).toBe("");
    });

    test("locked serializes writers: no appended row is lost to a concurrent rewrite", async () => {
        const path = join(dir(), "log.jsonl");
        const log = jsonlLog({ path, isRow });

        await Promise.all(
            Array.from({ length: 10 }, (_, index) =>
                log.locked(() => {
                    const { rows } = log.read();
                    log.rewrite([...rows, { id: `r${index}`, n: index }]);
                })
            )
        );

        expect(log.read().rows).toHaveLength(10);
    });
});

describe("appendFeedEvent", () => {
    test("appends a line, and a failed append reports instead of throwing", () => {
        const root = dir();
        const path = join(root, "events.jsonl");
        const lost: unknown[] = [];

        appendFeedEvent(path, { ev: "posted" }, (error) => lost.push(error));
        expect(readFileSync(path, "utf8")).toBe('{"ev":"posted"}\n');

        // A directory where the file should be: the append fails, and the caller is told.
        appendFeedEvent(root, { ev: "lost" }, (error) => lost.push(error));
        expect(lost).toHaveLength(1);
    });
});
