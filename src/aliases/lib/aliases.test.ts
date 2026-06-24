import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import {
    BLOCK_END,
    BLOCK_START,
    extractHotPaths,
    isWorthAliasing,
    parseHistory,
    suggestAlias,
    updateLevel,
    upsertManagedBlock,
} from "./core";

describe("parseHistory", () => {
    test("strips zsh extended-format prefixes and keeps order", () => {
        const raw = [": 1700000000:0;git status", ": 1700000005:2;git add .", "git commit"].join("\n");
        expect(parseHistory(raw)).toEqual(["git status", "git add .", "git commit"]);
    });

    test("drops bash HISTTIMEFORMAT timestamp lines and blanks", () => {
        const raw = ["#1700000000", "git status", "", "  ", "#1700000005", "git push"].join("\n");
        expect(parseHistory(raw)).toEqual(["git status", "git push"]);
    });

    test("trims whitespace and keeps plain lines verbatim", () => {
        const raw = ["  ls -la  ", "cd /tmp"].join("\n");
        expect(parseHistory(raw)).toEqual(["ls -la", "cd /tmp"]);
    });

    test("merges zsh multi-line entries (trailing backslash is a continuation marker)", () => {
        const raw = [
            ': 1700000000:0;php -r "\\',
            "require 'vendor/autoload.php';\\",
            "echo 'ok';\\",
            '"',
            ": 1700000005:0;ls",
        ].join("\n");
        expect(parseHistory(raw)).toEqual([`php -r " require 'vendor/autoload.php'; echo 'ok'; "`, "ls"]);
    });

    test("a pasted multi-line block becomes ONE entry (not N continuation-line fakes)", () => {
        // Regression: pasted crash traces used to be shredded into N separate
        // "commands" whose stack-frame lines repeated across pastes and showed
        // up as fake hot paths.
        const crashEntry = [
            ": 1700000000:0;0   libsystem_kernel.dylib  0x1979004f8 __psynch_cvwait + 8\\",
            "1   libsystem_pthread.dylib 0x1979400dc _pthread_cond_wait + 984\\",
            "2   forge                   0x10354ea8c 0x102388000 + 18639500",
            ": 1700000005:0;ls",
        ].join("\n");
        const parsed = parseHistory(crashEntry);
        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toContain("libsystem_kernel.dylib");
        expect(parsed[0]).toContain("forge");
        expect(parsed[1]).toBe("ls");
    });

    test("handles a file that ends mid-continuation without losing the entry", () => {
        const raw = [": 1700000000:0;echo a\\", "b\\"].join("\n");
        expect(parseHistory(raw)).toEqual(["echo a b"]);
    });
});

describe("extractHotPaths", () => {
    test("returns only n-grams at or above threshold, scored by count*n", () => {
        const commands = [
            "git add .",
            "git commit",
            "git push",
            "ls",
            "git add .",
            "git commit",
            "git push",
            "ls",
            "git add .",
            "git commit",
            "git push",
        ];
        const hot = extractHotPaths({ commands, minN: 2, maxN: 3, threshold: 3 });

        const top = hot[0];
        expect(top.commands).toEqual(["git add .", "git commit", "git push"]);
        expect(top.count).toBe(3);
        expect(top.score).toBe(9);
        // Every returned path must clear the threshold.
        for (const path of hot) {
            expect(path.count).toBeGreaterThanOrEqual(3);
        }
    });

    test("applies equal-count subsumption (drops shorter slice of a longer equal-count chain)", () => {
        const commands = ["a", "b", "c", "x", "a", "b", "c", "x", "a", "b", "c"];
        const hot = extractHotPaths({ commands, minN: 2, maxN: 3, threshold: 3 });
        const keys = hot.map((h) => h.commands.join(" "));
        // "a b c" (count 3) subsumes the equal-count "a b" and "b c".
        expect(keys).toContain("a b c");
        expect(keys).not.toContain("a b");
        expect(keys).not.toContain("b c");
    });

    test("applies separate threshold for single commands vs chains", () => {
        // `ccc` appears 6× — passes singles threshold (3). `ccc → resume` chain
        // appears only 2× — needs the chain threshold (2) to be admitted.
        const commands = ["ccc", "ccc", "ccc", "ccc", "ccc", "ccc", "z", "ccc resume", "z", "ccc resume"];
        const hot = extractHotPaths({ commands, minN: 1, maxN: 2, threshold: 3, chainThreshold: 2 });
        const keys = hot.map((h) => h.commands.join(" "));
        expect(keys).toContain("ccc");
        expect(keys).toContain("z ccc resume");
        // Without the lower chain threshold the chain would have been dropped.
        const onlySingleThreshold = extractHotPaths({ commands, minN: 1, maxN: 2, threshold: 3 });
        expect(onlySingleThreshold.map((h) => h.commands.join(" "))).not.toContain("z ccc resume");
    });

    test("is deterministic across runs", () => {
        const commands = ["a", "b", "a", "b", "a", "b", "c", "d", "c", "d", "c", "d"];
        const first = extractHotPaths({ commands, minN: 2, maxN: 2, threshold: 3 });
        const second = extractHotPaths({ commands, minN: 2, maxN: 2, threshold: 3 });
        expect(first).toEqual(second);
    });
});

describe("updateLevel", () => {
    test("decays first then grows when reused, injected daysSince only", () => {
        // level 5, 3 idle days at 0.1/day -> 4.7, +1 growth -> 5.7
        expect(updateLevel({ level: 5, reused: true, daysSince: 3 })).toBeCloseTo(5.7, 5);
    });

    test("pure decay when not reused, clamped at 0", () => {
        // level 1, 5 idle days at 0.1/day -> 0.5 (not yet dead).
        expect(updateLevel({ level: 1, reused: false, daysSince: 5 })).toBeCloseTo(0.5, 5);
        // 15 idle days -> 1 - 1.5 clamps to 0.
        expect(updateLevel({ level: 1, reused: false, daysSince: 15 })).toBe(0);
        expect(updateLevel({ level: 0.5, reused: false, daysSince: 100 })).toBe(0);
    });

    test("clamps growth to max", () => {
        expect(updateLevel({ level: 10, reused: true, daysSince: 0, max: 10 })).toBe(10);
    });
});

describe("suggestAlias", () => {
    test("joins with && and builds a deterministic mnemonic", () => {
        const a = suggestAlias(["git add .", "git commit", "git push"]);
        expect(a.command).toBe("git add . && git commit && git push");
        expect(a.name).toBe("gagcgp");
    });

    test("flag NAMES contribute their first alnum (so ccc --resume becomes cr, not just c)", () => {
        const a = suggestAlias(["ccc --resume"]);
        expect(a.name).toBe("cr");
    });

    test("short flag stems contribute (git add -A -> gaa)", () => {
        const a = suggestAlias(["git add -A", "git commit"]);
        // tokens: git, add, -A (stem A), git, commit -> "gaagc"
        expect(a.name).toBe("gaagc");
    });

    test("de-dupes against a taken set", () => {
        const taken = new Set<string>(["gagcgp"]);
        const a = suggestAlias(["git add .", "git commit", "git push"], taken);
        expect(a.name).toBe("gagcgp2");
        expect(taken.has("gagcgp2")).toBe(true);
    });
});

describe("isWorthAliasing", () => {
    test("always keeps multi-command chains", () => {
        expect(isWorthAliasing({ commands: ["a", "b"], aliasName: "ab" })).toBe(true);
        expect(isWorthAliasing({ commands: ["a", "b", "c"], aliasName: "abc" })).toBe(true);
    });

    test("requires real savings for single-command suggestions", () => {
        // `cd ..` → alias `c..` saves 2 chars, original is 5 chars — not worth it.
        expect(isWorthAliasing({ commands: ["cd .."], aliasName: "c.." })).toBe(false);
        // `ccc` → alias `c` saves 2 chars on a 3-char original — not worth it.
        expect(isWorthAliasing({ commands: ["ccc"], aliasName: "c" })).toBe(false);
        // `tools claude usage` (18 chars) → `tcu` (3) saves 15 — worth it.
        expect(isWorthAliasing({ commands: ["tools claude usage"], aliasName: "tcu" })).toBe(true);
        // `ccc --resume` (12 chars) → `ccr` (3) saves 9 — worth it.
        expect(isWorthAliasing({ commands: ["ccc --resume"], aliasName: "ccr" })).toBe(true);
    });
});

describe("upsertManagedBlock", () => {
    const body = "alias gacp='git add . && git commit && git push'";

    test("appends the block when absent", () => {
        const result = upsertManagedBlock("export PATH=$PATH:/usr/local/bin\n", body);
        expect(result).toContain(BLOCK_START);
        expect(result).toContain(BLOCK_END);
        expect(result).toContain(body);
        expect(result).toContain("export PATH");
    });

    test("replaces the block in place when present", () => {
        const once = upsertManagedBlock("# rc\n", body);
        const twice = upsertManagedBlock(once, "alias x='echo hi'");
        expect(twice).toContain("alias x='echo hi'");
        expect(twice).not.toContain("gacp");
        // Exactly one managed block remains.
        expect(twice.split(BLOCK_START).length - 1).toBe(1);
    });

    test("is idempotent when applying the same body twice", () => {
        const once = upsertManagedBlock("# rc\n", body);
        const twice = upsertManagedBlock(once, body);
        expect(twice).toBe(once);
    });

    test("refuses to rewrite an rc file with duplicate managed blocks", () => {
        const once = upsertManagedBlock("# rc\n", body);
        const doubled = `${once}\n${BLOCK_START}\nalias stale='echo stale'\n${BLOCK_END}\n`;
        expect(() => upsertManagedBlock(doubled, body)).toThrow(/multiple managed block markers/);
    });
});

describe("integration (hermetic state + rc round-trips)", () => {
    let home: string;
    let previousGenesisToolsHome: string | undefined;

    beforeEach(() => {
        previousGenesisToolsHome = process.env.GENESIS_TOOLS_HOME;
        home = mkdtempSync(join(tmpdir(), "aliases-test-"));
        process.env.GENESIS_TOOLS_HOME = home;
    });

    afterEach(() => {
        if (previousGenesisToolsHome === undefined) {
            delete process.env.GENESIS_TOOLS_HOME;
        } else {
            process.env.GENESIS_TOOLS_HOME = previousGenesisToolsHome;
        }

        rmSync(home, { recursive: true, force: true });
    });

    function synthHistory(): string {
        const block = [": 1700000000:0;git add .", ": 1700000001:0;git commit", ": 1700000002:0;git push"];
        const lines: string[] = [];
        for (let i = 0; i < 4; i++) {
            lines.push(...block);
            lines.push(": 1700000003:0;ls");
        }

        return lines.join("\n");
    }

    test("analyze persists levels; a second hot run raises level; decay lowers and prunes", async () => {
        const { Storage } = await import("@app/utils/storage/storage");
        const { extractHotPaths: extract } = await import("./core");
        const { updateLevel: update } = await import("./core");

        const storage = new Storage("aliases");
        const commands = parseHistory(synthHistory());
        const hot = extract({ commands, minN: 2, maxN: 4, threshold: 3 });
        expect(hot.length).toBeGreaterThan(0);

        interface PathState {
            commands: string[];
            level: number;
            lastSeen: string;
            count: number;
        }
        interface AliasState {
            paths: Record<string, PathState>;
        }

        const t0 = Date.parse("2026-06-01T00:00:00.000Z");
        const key = hot[0].commands.join(" ");

        // First analyze-like write: prior level 0, reused, daysSince 0 -> level 1.
        await storage.atomicUpdate<AliasState>("state.json", () => ({
            paths: {
                [key]: {
                    commands: hot[0].commands,
                    level: update({ level: 0, reused: true, daysSince: 0 }),
                    lastSeen: new Date(t0).toISOString(),
                    count: hot[0].count,
                },
            },
        }));

        const stateFile = join(storage.getCacheDir(), "state.json");
        expect(existsSync(stateFile)).toBe(true);
        const first = SafeJSON.parse(readFileSync(stateFile, "utf8")) as AliasState;
        expect(first.paths[key].level).toBeCloseTo(1, 5);

        // Second hot run 2 days later: decay 0.2, +1 growth -> ~1.8.
        const t1 = t0 + 2 * 24 * 60 * 60 * 1000;
        await storage.atomicUpdate<AliasState>("state.json", (current) => {
            const prior = current?.paths[key];
            const daysSince = prior ? (t1 - Date.parse(prior.lastSeen)) / (24 * 60 * 60 * 1000) : 0;
            const next = current ?? { paths: {} };
            next.paths[key] = {
                commands: hot[0].commands,
                level: update({ level: prior?.level ?? 0, reused: true, daysSince }),
                lastSeen: new Date(t1).toISOString(),
                count: hot[0].count,
            };
            return next;
        });
        const second = SafeJSON.parse(readFileSync(stateFile, "utf8")) as AliasState;
        expect(second.paths[key].level).toBeCloseTo(1.8, 5);

        // Decay far into the future: level should hit 0 and be pruned.
        const tFar = t1 + 100 * 24 * 60 * 60 * 1000;
        await storage.atomicUpdate<AliasState>("state.json", (current) => {
            const result: AliasState = { paths: {} };
            for (const [k, path] of Object.entries(current?.paths ?? {})) {
                const daysSince = (tFar - Date.parse(path.lastSeen)) / (24 * 60 * 60 * 1000);
                const level = update({ level: path.level, reused: false, daysSince });
                if (level > 0) {
                    result.paths[k] = { ...path, level };
                }
            }

            return result;
        });
        const third = SafeJSON.parse(readFileSync(stateFile, "utf8")) as AliasState;
        expect(Object.keys(third.paths)).toHaveLength(0);
    });

    test("rc round-trip writes a managed block to a tmp file, never a real dotfile", async () => {
        const rc = join(home, ".zshrc");
        const body = "alias gacp='git add . && git commit && git push'";
        const updated = upsertManagedBlock("# existing rc\nexport FOO=1\n", body);
        await Bun.write(rc, updated);

        const onDisk = readFileSync(rc, "utf8");
        expect(onDisk).toContain(BLOCK_START);
        expect(onDisk).toContain(body);
        expect(onDisk).toContain("export FOO=1");

        // Re-apply is idempotent on disk too.
        const reapplied = upsertManagedBlock(onDisk, body);
        expect(reapplied).toBe(onDisk);
    });

    test("a JSON report shape is parseable and matches the documented fields", () => {
        const commands = parseHistory(synthHistory());
        const hot = extractHotPaths({ commands, minN: 2, maxN: 4, threshold: 3 });
        const taken = new Set<string>();
        const report = {
            history: "/tmp/synthetic_history",
            scannedAt: "2026-06-02T00:00:00.000Z",
            params: { minN: 2, maxN: 4, threshold: 3, top: 20 },
            counts: { lines: commands.length, hot: hot.length },
            paths: hot.map((h) => ({
                key: h.commands.join(" "),
                commands: h.commands,
                count: h.count,
                score: h.score,
                level: 1,
                alias: suggestAlias(h.commands, taken),
            })),
        };

        const round = SafeJSON.parse(SafeJSON.stringify(report)) as typeof report;
        expect(round.paths[0].alias.command).toContain(" && ");
        expect(round.counts.hot).toBe(hot.length);
        expect(round.params.threshold).toBe(3);
    });
});
