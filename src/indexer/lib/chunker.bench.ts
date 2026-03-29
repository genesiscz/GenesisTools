import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chunkFile } from "./chunker";

const testFiles = [
    { path: "src/indexer/lib/chunker.ts", strategy: "auto" as const },
    { path: "src/indexer/lib/types.ts", strategy: "auto" as const },
    { path: "CLAUDE.md", strategy: "auto" as const },
    { path: "package.json", strategy: "auto" as const },
];

const results: Array<{
    file: string;
    strategy: string;
    parser: string;
    chunks: number;
    avgChars: number;
    maxChars: number;
    timeMs: number;
}> = [];

for (const { path: filePath, strategy } of testFiles) {
    const absPath = resolve(filePath);
    const content = readFileSync(absPath, "utf-8");
    const start = performance.now();
    const result = await chunkFile({ filePath: absPath, content, strategy });
    const elapsed = performance.now() - start;
    const charSizes = result.chunks.map((c) => c.content.length);

    results.push({
        file: filePath,
        strategy,
        parser: result.parser,
        chunks: result.chunks.length,
        avgChars: charSizes.length > 0 ? Math.round(charSizes.reduce((a, b) => a + b, 0) / charSizes.length) : 0,
        maxChars: charSizes.length > 0 ? Math.max(...charSizes) : 0,
        timeMs: Math.round(elapsed * 100) / 100,
    });
}

// Inline fixtures for new features
const minifiedJs = `var a=1;${"function b(){return a+1;}".repeat(200)}`;
const manyTypes = Array.from({ length: 20 }, (_, i) => `type T${i} = { field: string };`).join("\n");
const hugeClass = `class Huge {\n${Array.from({ length: 200 }, (_, i) => `    m${i}(x: number) { return x + ${i}; }`).join("\n")}\n}`;

for (const [name, content, filePath] of [
    ["minified", minifiedJs, "bundle.min.js"],
    ["many-types", manyTypes, "types.ts"],
    ["huge-class", hugeClass, "huge.ts"],
] as const) {
    const start = performance.now();
    const result = await chunkFile({ filePath, content, strategy: "auto" });
    const elapsed = performance.now() - start;
    const charSizes = result.chunks.map((c) => c.content.length);

    results.push({
        file: name,
        strategy: "auto",
        parser: result.parser,
        chunks: result.chunks.length,
        avgChars: charSizes.length > 0 ? Math.round(charSizes.reduce((a, b) => a + b, 0) / charSizes.length) : 0,
        maxChars: charSizes.length > 0 ? Math.max(...charSizes) : 0,
        timeMs: Math.round(elapsed * 100) / 100,
    });
}

console.table(results);
