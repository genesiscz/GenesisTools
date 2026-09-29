import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachImageFiles, readImageAnswers } from "./form";

function pngPath(dir: string, name: string): string {
    const path = join(dir, name);
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));
    return path;
}

describe("readImageAnswers", () => {
    test("mime comes from the file's own bytes, never its extension", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-form-image-"));
        const path = join(dir, "screenshot.txt");
        writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]));

        const [image] = readImageAnswers([path]);

        expect(image.mime).toBe("image/png");
        expect(image.name).toBe("screenshot.txt");
        expect(Buffer.from(image.base64, "base64")).toEqual(
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])
        );
    });

    test("more than MAX_IMAGES_PER_ANSWER paths are truncated client-side", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-form-image-cap-"));
        const paths = Array.from({ length: 6 }, (_, i) => pngPath(dir, `p${i}.png`));

        expect(readImageAnswers(paths)).toHaveLength(4);
    });
});

describe("attachImageFiles", () => {
    test("with no --image specs, the answers array passes through unchanged", () => {
        const answers = [{ itemId: "q1", freeText: "hi" }];

        expect(attachImageFiles(answers, [])).toBe(answers);
    });

    test("adds images to an item that already has an answer, keeping its other fields", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-form-attach-"));
        const path = pngPath(dir, "shot.png");
        const answers = [{ itemId: "q1", freeText: "see attached" }];

        const merged = attachImageFiles(answers, [`q1=${path}`]);

        expect(merged).toHaveLength(1);
        expect(merged[0].itemId).toBe("q1");
        expect(merged[0].freeText).toBe("see attached");
        expect(merged[0].images).toHaveLength(1);
        expect(merged[0].images?.[0].mime).toBe("image/png");
    });

    test("creates a fresh entry for an item that has no other answer", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-form-attach-new-"));
        const path = pngPath(dir, "shot.png");

        const merged = attachImageFiles([{ itemId: "q1", freeText: "text only" }], [`q2=${path}`]);

        expect(merged).toHaveLength(2);
        expect(merged[0]).toEqual({ itemId: "q1", freeText: "text only" });
        expect(merged[1].itemId).toBe("q2");
        expect(merged[1].images).toHaveLength(1);
    });

    test("several --image specs for the same item accumulate onto one images array", () => {
        const dir = mkdtempSync(join(tmpdir(), "gt-form-attach-multi-"));
        const a = pngPath(dir, "a.png");
        const b = pngPath(dir, "b.png");

        const merged = attachImageFiles([], [`q1=${a}`, `q1=${b}`]);

        expect(merged).toHaveLength(1);
        expect(merged[0].images).toHaveLength(2);
    });

    test("a spec with no itemId=path shape is refused, not silently dropped", () => {
        expect(() => attachImageFiles([], ["no-equals-sign"])).toThrow();
        expect(() => attachImageFiles([], ["=missing-item-id"])).toThrow();
    });
});
