import { describe, expect, test } from "bun:test";
import { buildMerkleTree, deserializeMerkleTree, diffMerkleTrees, serializeMerkleTree } from "./merkle";

const BASE = "/project";

function makeFiles(entries: Record<string, string[]>) {
    return Object.entries(entries).map(([path, chunkHashes]) => ({
        path: `${BASE}/${path}`,
        chunkHashes,
    }));
}

describe("buildMerkleTree", () => {
    test("builds a tree from a single file", () => {
        const tree = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "src/main.ts": ["aaa", "bbb"] }),
        });

        expect(tree.path).toBe(".");
        expect(tree.children).toHaveLength(1);

        const srcDir = tree.children![0];
        expect(srcDir.path).toBe("src");
        expect(srcDir.isFile).toBeUndefined();
        expect(srcDir.children).toHaveLength(1);

        const fileNode = srcDir.children![0];
        expect(fileNode.path).toBe("src/main.ts");
        expect(fileNode.isFile).toBe(true);
        expect(fileNode.chunkHashes).toEqual(["aaa", "bbb"]);
    });

    test("builds a tree with multiple files in nested dirs", () => {
        const tree = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({
                "src/a.ts": ["h1"],
                "src/b.ts": ["h2"],
                "lib/c.ts": ["h3"],
            }),
        });

        expect(tree.path).toBe(".");
        expect(tree.children).toHaveLength(2);

        const libDir = tree.children!.find((c) => c.path === "lib");
        const srcDir = tree.children!.find((c) => c.path === "src");
        expect(libDir).toBeDefined();
        expect(srcDir).toBeDefined();
        expect(srcDir!.children).toHaveLength(2);
        expect(libDir!.children).toHaveLength(1);
    });

    test("deterministic: same input produces same hashes", () => {
        const filesA = makeFiles({
            "src/a.ts": ["h1", "h2"],
            "src/b.ts": ["h3"],
        });
        const filesB = makeFiles({
            "src/b.ts": ["h3"],
            "src/a.ts": ["h1", "h2"],
        });

        const treeA = buildMerkleTree({ baseDir: BASE, files: filesA });
        const treeB = buildMerkleTree({ baseDir: BASE, files: filesB });

        expect(treeA.hash).toBe(treeB.hash);
    });

    test("chunk hash order does not affect file hash (sorted internally)", () => {
        const tree1 = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "f.ts": ["aaa", "bbb"] }),
        });
        const tree2 = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "f.ts": ["bbb", "aaa"] }),
        });

        expect(tree1.hash).toBe(tree2.hash);
    });

    test("different chunk hashes produce different file hashes", () => {
        const tree1 = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "f.ts": ["aaa"] }),
        });
        const tree2 = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "f.ts": ["bbb"] }),
        });

        expect(tree1.hash).not.toBe(tree2.hash);
    });

    test("handles files at root level (no subdirectory)", () => {
        const tree = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "readme.md": ["h1"] }),
        });

        expect(tree.path).toBe(".");
        expect(tree.children).toHaveLength(1);
        expect(tree.children![0].path).toBe("readme.md");
        expect(tree.children![0].isFile).toBe(true);
    });

    test("handles deeply nested paths", () => {
        const tree = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "a/b/c/d.ts": ["h1"] }),
        });

        expect(tree.path).toBe(".");
        const a = tree.children![0];
        expect(a.path).toBe("a");
        const b = a.children![0];
        expect(b.path).toBe("a/b");
        const c = b.children![0];
        expect(c.path).toBe("a/b/c");
        const d = c.children![0];
        expect(d.path).toBe("a/b/c/d.ts");
        expect(d.isFile).toBe(true);
    });
});

describe("diffMerkleTrees", () => {
    test("identical trees produce no diff", () => {
        const files = makeFiles({
            "src/a.ts": ["h1"],
            "src/b.ts": ["h2"],
        });

        const tree1 = buildMerkleTree({ baseDir: BASE, files });
        const tree2 = buildMerkleTree({ baseDir: BASE, files });

        const diff = diffMerkleTrees({ previous: tree1, current: tree2 });

        expect(diff.added).toHaveLength(0);
        expect(diff.modified).toHaveLength(0);
        expect(diff.deleted).toHaveLength(0);
        expect(diff.unchanged).toEqual(expect.arrayContaining(["src/a.ts", "src/b.ts"]));
    });

    test("null previous means everything is added", () => {
        const tree = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({
                "a.ts": ["h1"],
                "b.ts": ["h2"],
            }),
        });

        const diff = diffMerkleTrees({ previous: null, current: tree });

        expect(diff.added).toEqual(expect.arrayContaining(["a.ts", "b.ts"]));
        expect(diff.modified).toHaveLength(0);
        expect(diff.deleted).toHaveLength(0);
        expect(diff.unchanged).toHaveLength(0);
    });

    test("added file detected", () => {
        const prev = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "src/a.ts": ["h1"] }),
        });
        const curr = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({
                "src/a.ts": ["h1"],
                "src/b.ts": ["h2"],
            }),
        });

        const diff = diffMerkleTrees({ previous: prev, current: curr });

        expect(diff.added).toEqual(["src/b.ts"]);
        expect(diff.modified).toHaveLength(0);
        expect(diff.deleted).toHaveLength(0);
        expect(diff.unchanged).toEqual(["src/a.ts"]);
    });

    test("modified file detected (changed chunk hash)", () => {
        const prev = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "src/a.ts": ["h1"] }),
        });
        const curr = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "src/a.ts": ["h1-modified"] }),
        });

        const diff = diffMerkleTrees({ previous: prev, current: curr });

        expect(diff.added).toHaveLength(0);
        expect(diff.modified).toEqual(["src/a.ts"]);
        expect(diff.deleted).toHaveLength(0);
        expect(diff.unchanged).toHaveLength(0);
    });

    test("deleted file detected", () => {
        const prev = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({
                "src/a.ts": ["h1"],
                "src/b.ts": ["h2"],
            }),
        });
        const curr = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "src/a.ts": ["h1"] }),
        });

        const diff = diffMerkleTrees({ previous: prev, current: curr });

        expect(diff.added).toHaveLength(0);
        expect(diff.modified).toHaveLength(0);
        expect(diff.deleted).toEqual(["src/b.ts"]);
        expect(diff.unchanged).toEqual(["src/a.ts"]);
    });

    test("moved file = delete + add (same chunk hashes)", () => {
        const prev = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "old/a.ts": ["h1", "h2"] }),
        });
        const curr = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "new/a.ts": ["h1", "h2"] }),
        });

        const diff = diffMerkleTrees({ previous: prev, current: curr });

        expect(diff.deleted).toEqual(["old/a.ts"]);
        expect(diff.added).toEqual(["new/a.ts"]);
        expect(diff.modified).toHaveLength(0);
        expect(diff.unchanged).toHaveLength(0);
    });

    test("directory short-circuit: unchanged subtree skips children", () => {
        // Build trees where one subtree is identical and another differs
        const prev = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({
                "lib/utils.ts": ["h1"],
                "lib/helpers.ts": ["h2"],
                "src/main.ts": ["h3"],
            }),
        });
        const curr = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({
                "lib/utils.ts": ["h1"],
                "lib/helpers.ts": ["h2"],
                "src/main.ts": ["h3-changed"],
            }),
        });

        const diff = diffMerkleTrees({ previous: prev, current: curr });

        // lib/ subtree unchanged — both files should be in unchanged
        expect(diff.unchanged).toEqual(expect.arrayContaining(["lib/utils.ts", "lib/helpers.ts"]));
        expect(diff.modified).toEqual(["src/main.ts"]);
        expect(diff.added).toHaveLength(0);
        expect(diff.deleted).toHaveLength(0);
    });

    test("added directory with files", () => {
        const prev = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "src/a.ts": ["h1"] }),
        });
        const curr = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({
                "src/a.ts": ["h1"],
                "tests/a.test.ts": ["h2"],
                "tests/b.test.ts": ["h3"],
            }),
        });

        const diff = diffMerkleTrees({ previous: prev, current: curr });

        expect(diff.added).toEqual(expect.arrayContaining(["tests/a.test.ts", "tests/b.test.ts"]));
        expect(diff.unchanged).toEqual(["src/a.ts"]);
    });

    test("deleted directory with files", () => {
        const prev = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({
                "src/a.ts": ["h1"],
                "tests/a.test.ts": ["h2"],
            }),
        });
        const curr = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({ "src/a.ts": ["h1"] }),
        });

        const diff = diffMerkleTrees({ previous: prev, current: curr });

        expect(diff.deleted).toEqual(["tests/a.test.ts"]);
        expect(diff.unchanged).toEqual(["src/a.ts"]);
    });
});

describe("serialization", () => {
    test("roundtrip serialize/deserialize preserves tree", () => {
        const tree = buildMerkleTree({
            baseDir: BASE,
            files: makeFiles({
                "src/a.ts": ["h1", "h2"],
                "lib/b.ts": ["h3"],
            }),
        });

        const json = serializeMerkleTree(tree);
        const restored = deserializeMerkleTree(json);

        expect(restored.hash).toBe(tree.hash);
        expect(restored.children).toHaveLength(tree.children!.length);

        // Verify deep structure preserved
        const diff = diffMerkleTrees({ previous: tree, current: restored });
        expect(diff.added).toHaveLength(0);
        expect(diff.modified).toHaveLength(0);
        expect(diff.deleted).toHaveLength(0);
        expect(diff.unchanged).toHaveLength(2);
    });
});
