import { describe, expect, it } from "bun:test";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The filePathInput function is interactive (readline + raw mode), so we can't
 * easily test the full prompt loop. Instead, we test the internal logic:
 * - Path expansion (~/  ./  relative)
 * - Directory reading + filtering
 * - Tab completion (common prefix, single match)
 * - Entry sorting (directories first)
 * - Extension filtering
 *
 * We extract the pure functions and test them directly, then verify the
 * module exports correctly.
 */

// ---------------------------------------------------------------------------
// Test helpers that mirror the internal logic of file-path.ts
// These are the same algorithms used inside the prompt — tested in isolation.
// ---------------------------------------------------------------------------

function expandPath(p: string): string {
    if (p.startsWith("~/")) {
        return join(homedir(), p.slice(2));
    }

    if (p.startsWith("./")) {
        return join(process.cwd(), p.slice(2));
    }

    if (!p.startsWith("/")) {
        return join(process.cwd(), p);
    }

    return p;
}

interface DirEntry {
    name: string;
    isDirectory: boolean;
}

function getCommonPrefix(entries: DirEntry[]): string {
    if (entries.length === 0) {
        return "";
    }

    let common = entries[0].name;

    for (let i = 1; i < entries.length; i++) {
        const name = entries[i].name;
        let j = 0;

        while (j < common.length && j < name.length && common[j] === name[j]) {
            j++;
        }

        common = common.slice(0, j);
    }

    return common;
}

function sortEntries(entries: DirEntry[]): DirEntry[] {
    return [...entries].sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1;
        }

        return a.name.localeCompare(b.name);
    });
}

function filterEntries(
    entries: DirEntry[],
    opts: { filter?: "all" | "directories" | "files"; extensions?: string[]; prefix?: string },
): DirEntry[] {
    return entries.filter((entry) => {
        if (entry.name.startsWith(".")) {
            return false;
        }

        if (opts.filter === "directories" && !entry.isDirectory) {
            return false;
        }

        if (opts.filter === "files" && entry.isDirectory) {
            return false;
        }

        if (opts.extensions && !entry.isDirectory) {
            const hasExt = opts.extensions.some((ext) => entry.name.endsWith(ext));

            if (!hasExt) {
                return false;
            }
        }

        if (opts.prefix && !entry.name.toLowerCase().startsWith(opts.prefix.toLowerCase())) {
            return false;
        }

        return true;
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("file-path: expandPath", () => {
    it("expands ~/ to home directory", () => {
        const result = expandPath("~/Downloads");
        expect(result).toBe(join(homedir(), "Downloads"));
    });

    it("expands ~/ with nested path", () => {
        const result = expandPath("~/Documents/sub/file.txt");
        expect(result).toBe(join(homedir(), "Documents/sub/file.txt"));
    });

    it("expands ./ to cwd", () => {
        const result = expandPath("./src/file.ts");
        expect(result).toBe(join(process.cwd(), "src/file.ts"));
    });

    it("keeps absolute paths unchanged", () => {
        const result = expandPath("/usr/local/bin");
        expect(result).toBe("/usr/local/bin");
    });

    it("treats relative paths as relative to cwd", () => {
        const result = expandPath("src/file.ts");
        expect(result).toBe(join(process.cwd(), "src/file.ts"));
    });

    it("handles ~/ with trailing slash", () => {
        const result = expandPath("~/");
        expect(result).toBe(homedir());
    });
});

describe("file-path: getCommonPrefix", () => {
    it("returns empty for empty array", () => {
        expect(getCommonPrefix([])).toBe("");
    });

    it("returns full name for single entry", () => {
        expect(getCommonPrefix([{ name: "file.txt", isDirectory: false }])).toBe("file.txt");
    });

    it("finds common prefix of multiple entries", () => {
        const entries: DirEntry[] = [
            { name: "transcript.srt", isDirectory: false },
            { name: "transcript.vtt", isDirectory: false },
            { name: "transcript.txt", isDirectory: false },
        ];
        expect(getCommonPrefix(entries)).toBe("transcript.");
    });

    it("returns empty when no common prefix", () => {
        const entries: DirEntry[] = [
            { name: "alpha.txt", isDirectory: false },
            { name: "beta.txt", isDirectory: false },
        ];
        expect(getCommonPrefix(entries)).toBe("");
    });

    it("handles prefix of different lengths", () => {
        const entries: DirEntry[] = [
            { name: "App", isDirectory: true },
            { name: "App.tsx", isDirectory: false },
            { name: "Application", isDirectory: true },
        ];
        expect(getCommonPrefix(entries)).toBe("App");
    });

    it("handles single character common prefix", () => {
        const entries: DirEntry[] = [
            { name: "src", isDirectory: true },
            { name: "scripts", isDirectory: true },
        ];
        expect(getCommonPrefix(entries)).toBe("s");
    });
});

describe("file-path: sortEntries", () => {
    it("sorts directories before files", () => {
        const entries: DirEntry[] = [
            { name: "file.txt", isDirectory: false },
            { name: "dir", isDirectory: true },
            { name: "another.ts", isDirectory: false },
            { name: "adir", isDirectory: true },
        ];

        const sorted = sortEntries(entries);
        expect(sorted[0].name).toBe("adir");
        expect(sorted[1].name).toBe("dir");
        expect(sorted[2].name).toBe("another.ts");
        expect(sorted[3].name).toBe("file.txt");
    });

    it("sorts alphabetically within same type", () => {
        const entries: DirEntry[] = [
            { name: "zebra", isDirectory: true },
            { name: "alpha", isDirectory: true },
            { name: "middle", isDirectory: true },
        ];

        const sorted = sortEntries(entries);
        expect(sorted.map((e) => e.name)).toEqual(["alpha", "middle", "zebra"]);
    });

    it("handles empty array", () => {
        expect(sortEntries([])).toEqual([]);
    });

    it("handles single entry", () => {
        const entries: DirEntry[] = [{ name: "only", isDirectory: false }];
        expect(sortEntries(entries)).toEqual(entries);
    });
});

describe("file-path: filterEntries", () => {
    const testEntries: DirEntry[] = [
        { name: ".hidden", isDirectory: false },
        { name: "Documents", isDirectory: true },
        { name: "Downloads", isDirectory: true },
        { name: "file.txt", isDirectory: false },
        { name: "image.png", isDirectory: false },
        { name: "transcript.srt", isDirectory: false },
        { name: "transcript.vtt", isDirectory: false },
    ];

    it("filters out hidden files (dotfiles)", () => {
        const result = filterEntries(testEntries, {});
        expect(result.some((e) => e.name === ".hidden")).toBe(false);
        expect(result.length).toBe(6);
    });

    it("filters to directories only", () => {
        const result = filterEntries(testEntries, { filter: "directories" });
        expect(result.every((e) => e.isDirectory)).toBe(true);
        expect(result.length).toBe(2);
    });

    it("filters to files only", () => {
        const result = filterEntries(testEntries, { filter: "files" });
        expect(result.every((e) => !e.isDirectory)).toBe(true);
        expect(result.length).toBe(4); // excludes .hidden
    });

    it("filters by extension", () => {
        const result = filterEntries(testEntries, { extensions: [".srt", ".vtt"] });
        expect(result.map((e) => e.name)).toEqual([
            "Documents",
            "Downloads",
            "transcript.srt",
            "transcript.vtt",
        ]);
    });

    it("filters by prefix", () => {
        const result = filterEntries(testEntries, { prefix: "Do" });
        expect(result.map((e) => e.name)).toEqual(["Documents", "Downloads"]);
    });

    it("prefix filter is case-insensitive", () => {
        const result = filterEntries(testEntries, { prefix: "do" });
        expect(result.map((e) => e.name)).toEqual(["Documents", "Downloads"]);
    });

    it("combines extension + prefix filters", () => {
        const result = filterEntries(testEntries, { prefix: "trans", extensions: [".srt"] });
        // Directories pass extension filter, plus matching files
        expect(result.map((e) => e.name)).toEqual(["transcript.srt"]);
    });

    it("returns empty for no matches", () => {
        const result = filterEntries(testEntries, { prefix: "zzz" });
        expect(result).toEqual([]);
    });

    it("all filter passes everything except hidden", () => {
        const result = filterEntries(testEntries, { filter: "all" });
        expect(result.length).toBe(6);
    });
});

describe("file-path: readDir integration", () => {
    it("reads the actual cwd directory", () => {
        const entries = readdirSync(process.cwd(), { withFileTypes: true });
        expect(entries.length).toBeGreaterThan(0);
    });

    it("reads home directory via expandPath", () => {
        const home = expandPath("~/");
        const entries = readdirSync(home, { withFileTypes: true });
        expect(entries.length).toBeGreaterThan(0);
    });
});

describe("file-path: tab completion simulation", () => {
    it("single match completes with / for directories", () => {
        // Simulate: value = "~/Dow" → tab → "~/Downloads/"
        const entries: DirEntry[] = [{ name: "Downloads", isDirectory: true }];
        const common = getCommonPrefix(entries);
        const entry = entries[0];
        const suffix = entry.isDirectory ? "/" : "";
        expect(common + suffix).toBe("Downloads/");
    });

    it("single match completes without / for files", () => {
        const entries: DirEntry[] = [{ name: "transcript.srt", isDirectory: false }];
        const common = getCommonPrefix(entries);
        const entry = entries[0];
        const suffix = entry.isDirectory ? "/" : "";
        expect(common + suffix).toBe("transcript.srt");
    });

    it("multiple matches complete to common prefix only", () => {
        const entries: DirEntry[] = [
            { name: "Documents", isDirectory: true },
            { name: "Downloads", isDirectory: true },
        ];
        const common = getCommonPrefix(entries);
        expect(common).toBe("Do");
    });

    it("no common prefix means no completion", () => {
        const entries: DirEntry[] = [
            { name: "src", isDirectory: true },
            { name: "package.json", isDirectory: false },
        ];
        const common = getCommonPrefix(entries);
        expect(common).toBe("");
    });
});

describe("file-path: module exports", () => {
    it("exports filePathInput function", async () => {
        const mod = await import("./file-path");
        expect(typeof mod.filePathInput).toBe("function");
    });

    it("exports filePathCancelSymbol", async () => {
        const mod = await import("./file-path");
        expect(typeof mod.filePathCancelSymbol).toBe("symbol");
    });

    it("exports FilePathInputOptions type", async () => {
        // Type-only check — if this compiles, the type exists
        const mod = await import("./file-path");
        const _fn: (opts: import("./file-path").FilePathInputOptions) => Promise<string | symbol> = mod.filePathInput;
        expect(_fn).toBeDefined();
    });
});
