import { expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { foldJsonlResumable } from "./jsonl-fold";
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

/**
 * The descriptor closes a few milliseconds AFTER `reader.cancel()` resolves, on every bun
 * version, so an instant check races the runtime. Measured in Linux containers on the bare
 * `Bun.file().stream().getReader()` primitive, 30 trials per arm: still open the instant
 * cancel resolved in 3/30 and 6/30 on bun 1.3.13 and 1/30 and 0/30 on 1.4.2, closed within
 * 0-6 ms every single time, never left open. Through this file's real path the rate differs
 * by version: this test file, 15 runs per version in the same containers, failed 4/15 on bun
 * 1.4.2 and 0/15 on 1.3.13, which is why it first showed the day CI moved to 1.4.2. That race
 * is what turned these two tests red on CI (runs 35010398967, 35010407288: lines 80 and 99,
 * never the open-while-reading check).
 * A bounded wait keeps the leak detection: a descriptor that is never closed still fails here,
 * one second later.
 */
async function expectDescriptorClosed(path: string): Promise<void> {
    const deadline = Date.now() + 1000;

    while (hasOpenDescriptor(path) === true) {
        if (Date.now() >= deadline) {
            throw new Error(`descriptor for ${path} still open 1000 ms after the scanner released it`);
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
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

    await expectDescriptorClosed(path);
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
    await expectDescriptorClosed(path);
});

async function fullScan(path: string): Promise<{ rows: unknown[]; issues: string[] }> {
    const rows: unknown[] = [];
    const issues: string[] = [];
    for await (const record of scanJsonlRecords({ path, onIssue: (issue) => issues.push(issue.message) })) {
        rows.push(record.value);
    }
    return { rows, issues };
}

function resumedFold(path: string, storePath: string): { rows: unknown[]; issues: string[] } {
    const issues: string[] = [];
    const rows =
        foldJsonlResumable<unknown[]>({
            path,
            storePath,
            initial: () => [],
            copy: (list) => [...list],
            apply: (list, row) => list.push(row),
            onIssue: (message) => issues.push(message),
            resumeMinBytes: 0,
        }) ?? [];
    return { rows, issues };
}

test("a resumed fold sees what a full scan sees after every append: rows, malformed and partial lines", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-jsonl-fold-"));
    const path = join(root, "rollout.jsonl");
    const storePath = join(root, "store.json");
    const pieces = [
        '{"n":1}\n{"n":2}\n',
        "\n",
        '{"n":3,"t":"half',
        ' done"}\n{broken\n',
        '{"n":4}\r\n{"n":5}',
        "\n",
        '{"n":6,"text":"žluťoučký"}\n',
    ];
    writeFileSync(path, "");
    for (const piece of pieces) {
        appendFileSync(path, piece);
        expect(resumedFold(path, storePath)).toEqual(await fullScan(path));
    }

    // Rewritten in place, same inode: folded from the start, not from the stored end.
    writeFileSync(path, '{"n":9}\n{"n":10}\n{"n":11}\n{"n":12}\n{"n":13}\n{"n":14}\n{"n":15}\n');
    expect(resumedFold(path, storePath)).toEqual(await fullScan(path));
    expect(resumedFold(join(root, "missing.jsonl"), storePath)).toEqual({ rows: [], issues: ["Source missing"] });
});

test("a small file resumes in this process without writing the store, and starts over when rewritten", async () => {
    const root = mkdtempSync(join(tmpdir(), "gt-jsonl-fold-small-"));
    const path = join(root, "rollout.jsonl");
    const storePath = join(root, "store.json");
    let applied = 0;
    const fold = (): { rows: unknown[]; issues: string[] } => {
        const issues: string[] = [];
        const rows =
            foldJsonlResumable<unknown[]>({
                path,
                storePath,
                initial: () => [],
                copy: (list) => [...list],
                apply: (list, row) => {
                    applied++;
                    list.push(row);
                },
                onIssue: (message) => issues.push(message),
            }) ?? [];
        return { rows, issues };
    };

    writeFileSync(path, '{"n":1}\n{bad\n{"n":2}\n');
    expect(fold()).toEqual(await fullScan(path));
    appendFileSync(path, '{"n":3}\n');
    applied = 0;
    expect(fold()).toEqual(await fullScan(path));
    expect(applied).toBe(1);
    expect(existsSync(storePath)).toBe(false);

    writeFileSync(path, '{"n":7}\n{"n":8}\n{"n":9}\n{"n":0}\n');
    applied = 0;
    expect(fold()).toEqual(await fullScan(path));
    expect(applied).toBe(4);
});
