import { resolve } from "node:path";
import { readFileSync } from "node:fs";
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
    const result = chunkFile({ filePath: absPath, content, strategy });
    const elapsed = performance.now() - start;
    const charSizes = result.chunks.map((c) => c.content.length);

    results.push({
        file: filePath,
        strategy,
        parser: result.parser,
        chunks: result.chunks.length,
        avgChars: Math.round(charSizes.reduce((a, b) => a + b, 0) / charSizes.length),
        maxChars: Math.max(...charSizes),
        timeMs: Math.round(elapsed * 100) / 100,
    });
}

console.table(results);
