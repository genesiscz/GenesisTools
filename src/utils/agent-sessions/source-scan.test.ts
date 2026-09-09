import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { scanJsonlRecords } from "./source-scan";

function hasOpenDescriptor(path: string): boolean | undefined {
    if (process.platform === "linux") {
        for (const descriptor of readdirSync("/proc/self/fd")) {
            try {
                if (readlinkSync(`/proc/self/fd/${descriptor}`) === path) {
                    return true;
                }
            } catch {
                // File descriptors can close between directory enumeration and readlink.
            }
        }
        return false;
    }
}

test("streams strict JSONL values with dense valid positions", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-source-scan-"));
    const path = join(directory, "records.jsonl");
    const unicode = `${"a".repeat(64 * 1024 - 20)}🙂tail`;
    const first = SafeJSON.stringify({ type: "first", unicode }, { strict: true });
    const final = SafeJSON.stringify({ type: "final", value: "EOF 🙂" }, { strict: true });
    writeFileSync(path, `${first}\r\n\r\n{"broken":\r\n"scalar"\n${final}`);
    const issues: Array<{ path: string; message: string }> = [];
    const records = [];
    for await (const record of scanJsonlRecords({
        path,
        onIssue: (entry) => issues.push(entry),
    })) {
        records.push(record);
    }

    expect(records.map((record) => [record.position, record.line, record.original])).toEqual([
        [0, 1, first],
        [1, 4, '"scalar"'],
        [2, 5, final],
    ]);
    expect(records[0]?.value).toEqual({ type: "first", unicode });
    expect(records[1]?.value).toBe("scalar");
    expect(records[2]?.value).toEqual({ type: "final", value: "EOF 🙂" });
    expect(issues).toEqual([{ path, message: "Malformed record at line 3" }]);
    expect(issues[0]?.message).not.toContain('{"broken"');
});

test("distinguishes malformed records from an incomplete final fragment", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-source-scan-partial-"));
    const path = join(directory, "partial.jsonl");
    writeFileSync(path, '{"malformed":\n{"partial":');
    const issues: string[] = [];
    const records = [];
    for await (const record of scanJsonlRecords({
        path,
        onIssue: (entry) => issues.push(entry.message),
    })) {
        records.push(record);
    }

    expect(records).toEqual([]);
    expect(issues).toEqual(["Malformed record at line 1", "Partial final record at line 2"]);
});

test.skipIf(process.platform !== "linux")("consumer early return closes the real source descriptor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-source-scan-return-"));
    const path = join(directory, "large.jsonl");
    writeFileSync(path, `{"first":true}\n{"large":"${"x".repeat(8 * 1024 * 1024)}"}\n`);
    const iterator = scanJsonlRecords({ path });
    const first = await iterator.next();

    expect(first.value?.value).toEqual({ first: true });
    expect(hasOpenDescriptor(path)).not.toBe(false);

    await iterator.return(undefined);

    expect(hasOpenDescriptor(path)).not.toBe(true);
    expect((await iterator.next()).done).toBe(true);
});

test.skipIf(process.platform !== "linux")("abort propagates without a source issue or leaked descriptor", async () => {
    const directory = mkdtempSync(join(tmpdir(), "gt-source-scan-abort-"));
    const path = join(directory, "abort.jsonl");
    writeFileSync(path, `{"large":"${"x".repeat(8 * 1024 * 1024)}"}\n`);
    const controller = new AbortController();
    const issues: string[] = [];
    const iterator = scanJsonlRecords({
        path,
        signal: controller.signal,
        onIssue: (entry) => issues.push(entry.message),
    });
    controller.abort();

    await expect(iterator.next()).rejects.toMatchObject({ name: "AbortError" });
    expect(issues).toEqual([]);
    expect(hasOpenDescriptor(path)).not.toBe(true);
});
