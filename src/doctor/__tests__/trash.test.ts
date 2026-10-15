import { afterAll, describe, expect, it } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveManyToTrash } from "@app/doctor/lib/trash";

const root = mkdtempSync(join(tmpdir(), "doctor-trash-"));
const bin = join(root, "bin");
const trashDir = join(root, "Trash");
mkdirSync(bin);
mkdirSync(trashDir);

/**
 * A stand-in for `/usr/bin/trash -v`, so no test fills the real Trash: it moves each item into `trashDir` and prints
 * the same `# Moved` line, prints the same error line for a name with "fail" in it, and hangs on "hang" (as one
 * process, like the real command, so a timeout kill closes its output).
 */
const fake = join(bin, "trash");
writeFileSync(
    fake,
    `#!/bin/sh
shift 2
for p in "$@"; do
  case "$p" in
    *fail*) echo "trash[1:2] # Error attempting to move $p to the trash folder, Error Domain=NSCocoaErrorDomain Code=513 \\"You don't have permission.\\"" >&2 ;;
    *hang*) exec sleep 30 ;;
    *silent*) mv "$p" "${trashDir}/" ;;
    *) mv "$p" "${trashDir}/" && echo "# Moved \\"$p\\" to \\"${trashDir}/$(basename "$p")\\"" ;;
  esac
done
`
);
chmodSync(fake, 0o755);

function item(name: string): string {
    const path = join(root, name);
    writeFileSync(path, name);
    return path;
}

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("moveManyToTrash", () => {
    it("names each destination and keeps a failure to its own item", async () => {
        const a = item("a.txt");
        const bad = item("fail.txt");
        const [moved, failed] = await moveManyToTrash([a, bad], { command: fake });
        expect(moved).toEqual({ ok: true, trashPath: join(trashDir, "a.txt") });
        expect(failed).toEqual({ ok: false, error: "You don't have permission." });
        expect(existsSync(bad)).toBe(true);
    });

    it("loses nothing when the command times out part-way", async () => {
        const first = item("first.txt");
        const hang = item("hang.txt");
        const [moved, stuck] = await moveManyToTrash([first, hang], { command: fake, timeoutMs: 1_000 });
        expect(moved).toEqual({ ok: true, trashPath: join(trashDir, "first.txt") });
        expect(stuck).toEqual({ ok: false, error: "timed out before this item" });
    });

    it("counts an item whose source is gone as moved even without a line", async () => {
        const quiet = item("silent.txt");
        expect(await moveManyToTrash([quiet], { command: fake })).toEqual([{ ok: true, trashPath: null }]);
    });

    it("refuses a symbolic link and a missing path before the command runs", async () => {
        const target = item("target.txt");
        const link = join(root, "link.txt");
        symlinkSync(target, link);
        const [linkResult, missing] = await moveManyToTrash([link, join(root, "nope.txt")], { command: fake });
        expect(linkResult.ok).toBe(false);
        expect(missing).toEqual({ ok: false, error: `${join(root, "nope.txt")} does not exist` });
        expect(existsSync(target)).toBe(true);
    });

    it("says what is missing when the system has no trash command", async () => {
        const [result] = await moveManyToTrash([item("b.txt")], { command: join(bin, "absent") });
        expect(result.ok).toBe(false);
        expect(result.ok ? "" : result.error).toContain("macOS 15");
    });
});
