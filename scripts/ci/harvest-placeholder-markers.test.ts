import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeamsCache } from "@app/ms-teams/lib/store";
import {
    AUTO_BEGIN,
    AUTO_END,
    autoBlockLines,
    harvestLooksDegraded,
    harvestToFile,
    isUsableEmail,
    needlesFromPeople,
    pcreLiteral,
    personDisplayName,
    spliceAutoBlock,
} from "./harvest-placeholder-markers";

describe("harvest-placeholder-markers", () => {
    test("pcreLiteral wraps and escapes \\E", () => {
        expect(pcreLiteral("Ada Lovelace")).toBe("\\QAda Lovelace\\E");
        expect(pcreLiteral("foo\\Ebar")).toBe("\\Qfoo\\E\\\\E\\Qbar\\E");
    });

    test("keeps invented two-word names and emails, drops rooms and orgids", () => {
        const lines = needlesFromPeople([
            { displayName: "Ada Lovelace", email: "ada@example.com", upn: "ada@example.com" },
            { displayName: "8:orgid:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", email: null },
            { displayName: "Room Alpha", email: "room_alpha@example.com" },
            { displayName: "alice", email: "not-an-email" },
            { displayName: "Service Bot", email: "bot@teams.microsoft.com" },
        ]);

        expect(lines.some((line) => line.includes("ada@example.com"))).toBe(true);
        expect(lines.some((line) => line.includes("Ada Lovelace"))).toBe(true);
        expect(lines.some((line) => line.includes("Lovelace Ada"))).toBe(true);
        expect(lines.some((line) => line.toLowerCase().includes("room_alpha"))).toBe(false);
        expect(lines.some((line) => line.includes("orgid"))).toBe(false);
        expect(lines.some((line) => line.includes("microsoft.com"))).toBe(false);
        expect(lines.some((line) => line.includes("Room Alpha"))).toBe(false);
    });

    test("personDisplayName rejects single tokens and digit rooms", () => {
        expect(personDisplayName("Ada Lovelace")).toBe("Ada Lovelace");
        expect(personDisplayName("alice")).toBeNull();
        expect(personDisplayName("Floor 5 NP Linea")).toBeNull();
        expect(isUsableEmail("ada@example.com")).toBe(true);
        expect(isUsableEmail("room_x@example.com")).toBe(false);
    });

    test("spliceAutoBlock replaces only the auto section", () => {
        const dir = mkdtempSync(join(tmpdir(), "markers-"));
        const path = join(dir, "markers.txt");
        const previous = ["# keep me", "manual\t\\QJane Doe\\E", AUTO_BEGIN, "old\t\\Qgone\\E", AUTO_END, ""].join(
            "\n"
        );
        writeFileSync(path, previous);
        const next = spliceAutoBlock(readFileSync(path, "utf8"), ["email\t\\Qada@example.com\\E"]);
        expect(next).toContain("# keep me");
        expect(next).toContain("Jane Doe");
        expect(next).toContain("ada@example.com");
        expect(next).not.toContain("gone");
    });

    test("autoBlockLines reads back only the generated needles", () => {
        const file = ["# keep me", "manual\t\\QJane Doe\\E", AUTO_BEGIN, "email\t\\Qada@example.com\\E", AUTO_END, ""]
            .join("\n")
            .concat("");

        expect(autoBlockLines(file)).toEqual(["email\t\\Qada@example.com\\E"]);
        expect(autoBlockLines("no markers here")).toEqual([]);
    });

    test("a harvest that shrank sharply is refused, not just an empty one", () => {
        // The old guard fired only on zero. A cache that survived a repair with
        // 5 of 400 people passed it, overwrote the block, and the pre-push scan
        // reported "5 pattern(s) checked, no matches" against 395 just deleted.
        expect(harvestLooksDegraded(0, 400)).toBe(true);
        expect(harvestLooksDegraded(5, 400)).toBe(true);
        expect(harvestLooksDegraded(199, 400)).toBe(true);
        expect(harvestLooksDegraded(200, 400)).toBe(false);
        expect(harvestLooksDegraded(600, 400)).toBe(false);
        // A first run has nothing to protect.
        expect(harvestLooksDegraded(0, 0)).toBe(false);
    });

    test("an empty Teams cache keeps the existing needles instead of deleting them", () => {
        // pre-push harvests and THEN runs placeholder-check. A degraded cache
        // used to empty the auto block, so the very push it gates was scanned
        // against needles this run had just removed.
        const dir = mkdtempSync(join(tmpdir(), "markers-"));
        const cachePath = join(dir, "cache.db");
        const empty = new TeamsCache(cachePath);
        empty.close();

        const markersFile = join(dir, "markers.txt");
        const before = ["manual\t\\QJane Doe\\E", AUTO_BEGIN, "email\t\\Qada@example.com\\E", AUTO_END, ""].join("\n");
        writeFileSync(markersFile, before);

        const result = harvestToFile({ cachePath, markersFile });

        expect(result.refused).toBe(true);
        expect(result.lines).toBe(0);
        expect(result.previous).toBe(1);
        expect(readFileSync(markersFile, "utf8")).toBe(before);
    });

    test("a refused harvest reports what it actually found, not zero", () => {
        // A half-sized cache still yields needles. Reporting 0 emails / 0 names
        // reads as "the cache is empty" and hides how close the run was to the
        // floor, which is the difference between a repair and a schema change.
        const dir = mkdtempSync(join(tmpdir(), "markers-"));
        const cachePath = join(dir, "cache.db");
        new TeamsCache(cachePath).close();
        const db = new Database(cachePath);
        db.run("INSERT INTO people (mri, display_name, email, upn) VALUES (?, ?, ?, ?)", [
            "8:orgid:1",
            "Ada Lovelace",
            "ada@example.com",
            "ada@example.com",
        ]);
        db.close();

        const markersFile = join(dir, "markers.txt");
        const previousBlock = Array.from({ length: 40 }, (_, index) => `email\t\\Qold${index}@example.com\\E`);
        writeFileSync(markersFile, [AUTO_BEGIN, ...previousBlock, AUTO_END, ""].join("\n"));

        const result = harvestToFile({ cachePath, markersFile });

        expect(result.refused).toBe(true);
        expect(result.lines).toBeGreaterThan(0);
        expect(result.emails).toBe(1);
        expect(result.names).toBeGreaterThan(0);
        expect(result.previous).toBe(40);
        expect(readFileSync(markersFile, "utf8")).toContain("old0@example.com");
    });

    test("a cache with people still rewrites the block", () => {
        const dir = mkdtempSync(join(tmpdir(), "markers-"));
        const cachePath = join(dir, "cache.db");
        new TeamsCache(cachePath).close();
        const db = new Database(cachePath);
        db.run("INSERT INTO people (mri, display_name, email, upn) VALUES (?, ?, ?, ?)", [
            "8:orgid:1",
            "Ada Lovelace",
            "ada@example.com",
            "ada@example.com",
        ]);
        db.close();

        const markersFile = join(dir, "markers.txt");
        writeFileSync(markersFile, [AUTO_BEGIN, "email\t\\Qold@example.com\\E", AUTO_END, ""].join("\n"));

        const result = harvestToFile({ cachePath, markersFile });
        const after = readFileSync(markersFile, "utf8");

        expect(result.refused).toBe(false);
        expect(after).toContain("ada@example.com");
        expect(after).not.toContain("old@example.com");
    });
});
