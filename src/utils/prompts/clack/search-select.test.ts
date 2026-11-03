import { describe, expect, test } from "bun:test";
import { stripAnsi } from "@genesiscz/utils/string";
import { searchSelect } from "./search-select";

async function drive(options: { message: string; keys: string[] }): Promise<{ result: unknown; frames: string[] }> {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
        chunks.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;

    try {
        const done = searchSelect<string>({
            message: options.message,
            items: [
                { value: "Jenkins", label: "Jenkins" },
                { value: "Jira", label: "Jira" },
            ],
            typed: { label: (q) => `Use "${q}" as typed`, resolve: (q) => q.trim() || undefined },
        });

        for (const key of options.keys) {
            const name = key === "\r" ? "return" : key === "\x1b" ? "escape" : key;
            process.stdin.emit("keypress", key, { name, sequence: key });
        }

        return { result: await done, frames: chunks.map(stripAnsi) };
    } finally {
        process.stdout.write = write as typeof process.stdout.write;
    }
}

describe("searchSelect with a typed row", () => {
    test("Enter takes the typed text when nothing matches", async () => {
        const { result } = await drive({ message: "Who?", keys: ["Y", "e", "n", "\r"] });
        expect(result).toBe("Yen");
    });

    test("the typed row leads, then the matches", async () => {
        const { result } = await drive({ message: "Who?", keys: ["J", "i", "\r"] });
        expect(result).toBe("Ji");
    });

    test("a multi-line message keeps each extra line behind the bar", async () => {
        const { frames } = await drive({ message: "Who?\ncontext line", keys: ["\x1b"] });
        const first = frames.find((f) => f.includes("Who?")) ?? "";
        expect(first).toContain("│  context line");
    });
});
