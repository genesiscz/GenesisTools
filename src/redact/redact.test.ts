import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@app/utils/json";
import { detectAll } from "./lib/detectors";
import { redact } from "./lib/redact";
import { restore } from "./lib/restore";
import { buildSession, loadLatestSession, loadMapFile, saveSession } from "./lib/session";
import { DEFAULT_TYPES } from "./lib/types";

const opts = { homeDir: "/Users/test", types: DEFAULT_TYPES };

describe("detectAll", () => {
    it("detects an AWS access key", () => {
        const spans = detectAll("k=AKIAIOSFODNN7EXAMPLE done", opts);
        const key = spans.find((s) => s.type === "keys");
        expect(key?.value).toBe("AKIAIOSFODNN7EXAMPLE");
    });

    it("detects a GitHub token", () => {
        const token = "ghp_aBcD1234aBcD1234aBcD1234aBcD1234aBcD";
        const spans = detectAll(`gh: ${token}`, opts);
        expect(spans.find((s) => s.type === "tokens")?.value).toBe(token);
    });

    it("detects emails and ipv4", () => {
        const spans = detectAll("mail a@b.com host 10.0.0.4", opts);
        expect(spans.find((s) => s.type === "emails")?.value).toBe("a@b.com");
        expect(spans.find((s) => s.type === "ips")?.value).toBe("10.0.0.4");
    });

    it("detects a home path prefix only", () => {
        const spans = detectAll("at /Users/test/projects/x", opts);
        const path = spans.find((s) => s.type === "paths");
        expect(path?.value).toBe("/Users/test");
    });

    it("does not detect a foreign home path", () => {
        const spans = detectAll("at /Users/other/x", opts);
        expect(spans.find((s) => s.type === "paths")).toBeUndefined();
    });

    it("captures only the value of a generic secret assignment", () => {
        const spans = detectAll('password="s3cr3tValue_LongEnough123"', opts);
        const tok = spans.find((s) => s.type === "tokens");
        expect(tok?.value).toBe("s3cr3tValue_LongEnough123");
    });

    it("only enables requested detector types", () => {
        const spans = detectAll("a@b.com 10.0.0.4 AKIAIOSFODNN7EXAMPLE", { homeDir: "/Users/test", types: ["emails"] });
        expect(spans.every((s) => s.type === "emails")).toBe(true);
        expect(spans).toHaveLength(1);
    });
});

describe("redact", () => {
    it("replaces a key with a delimited placeholder", () => {
        const r = redact("k=AKIAIOSFODNN7EXAMPLE", opts);
        expect(r.redacted).toBe("k=[REDACTED_KEY_1]");
        expect(r.mapping["[REDACTED_KEY_1]"]).toBe("AKIAIOSFODNN7EXAMPLE");
    });

    it("dedups identical secrets to one placeholder", () => {
        const r = redact("a@b.com then a@b.com", opts);
        expect(r.redacted).toBe("[EMAIL_1] then [EMAIL_1]");
        expect(Object.keys(r.mapping)).toEqual(["[EMAIL_1]"]);
    });

    it("collapses the home path prefix to [HOME]", () => {
        const r = redact("at /Users/test/projects/x", opts);
        expect(r.redacted).toBe("at [HOME]/projects/x");
        expect(r.mapping["[HOME]"]).toBe("/Users/test");
    });

    it("numbers ten distinct tokens 1..10 without prefix collision", () => {
        const toks = Array.from({ length: 10 }, (_, i) => `ghp_${String(i).padStart(36, "a")}`);
        const r = redact(toks.join(" "), opts);
        expect(r.mapping["[REDACTED_TOKEN_1]"]).toBe(toks[0]);
        expect(r.mapping["[REDACTED_TOKEN_10]"]).toBe(toks[9]);
    });

    it("does not double-redact overlapping matches", () => {
        const r = redact("password=AKIAIOSFODNN7EXAMPLE", opts);
        const placeholders = Object.keys(r.mapping);
        expect(placeholders).toHaveLength(1);
    });
});

describe("restore + round-trip", () => {
    it("restores placeholders back to originals (one pass)", () => {
        const mapping = { "[EMAIL_1]": "a@b.com", "[IP_1]": "10.0.0.4" };
        expect(restore("[EMAIL_1] @ [IP_1]", mapping)).toBe("a@b.com @ 10.0.0.4");
    });

    it("does not expand placeholder-like text already inside a value", () => {
        const mapping = { "[EMAIL_1]": "[IP_1]@b.com" };
        expect(restore("[EMAIL_1]", mapping)).toBe("[IP_1]@b.com");
    });

    it("round-trips a sample covering every default detector", () => {
        const sample = [
            "export AWS_KEY=AKIAIOSFODNN7EXAMPLE",
            "github: ghp_aBcD1234aBcD1234aBcD1234aBcD1234aBcD",
            "contact jane.doe@example.com or jane.doe@example.com",
            "server 192.168.1.42 home /Users/test/projects/x",
        ].join("\n");
        const r = redact(sample, opts);
        expect(restore(r.redacted, r.mapping)).toBe(sample);
    });

    it("distinguishes _1 from _10 on restore", () => {
        const toks = Array.from({ length: 10 }, (_, i) => `ghp_${String(i).padStart(36, "a")}`);
        const r = redact(toks.join(" "), opts);
        expect(restore(r.redacted, r.mapping)).toBe(toks.join(" "));
    });

    it("leaves a foreign home path untouched through the round-trip", () => {
        const r = redact("mine /Users/test/a and theirs /Users/other/b", opts);
        expect(r.redacted).toBe("mine [HOME]/a and theirs /Users/other/b");
        expect(restore(r.redacted, r.mapping)).toBe("mine /Users/test/a and theirs /Users/other/b");
    });

    it("does not collide with a literal placeholder token already in the input", () => {
        const sample = "user [EMAIL_1] real a@b.com here";
        const r = redact(sample, opts);
        expect(r.mapping["[EMAIL_1]"]).toBeUndefined();
        expect(r.mapping["[EMAIL_2]"]).toBe("a@b.com");
        expect(restore(r.redacted, r.mapping)).toBe(sample);
    });

    it("does not collide with a literal [HOME] token already in the input", () => {
        const sample = "config says [HOME] but home is /Users/test";
        const r = redact(sample, opts);
        expect(r.mapping["[HOME]"]).toBeUndefined();
        expect(r.mapping["[HOME_2]"]).toBe("/Users/test");
        expect(restore(r.redacted, r.mapping)).toBe(sample);
    });
});

describe("session", () => {
    let prevHome: string | undefined;
    let sandbox: string;

    beforeEach(() => {
        prevHome = process.env.GENESIS_TOOLS_HOME;
        sandbox = mkdtempSync(join(tmpdir(), "redact-test-"));
        process.env.GENESIS_TOOLS_HOME = sandbox;
    });

    afterEach(() => {
        if (prevHome === undefined) {
            delete process.env.GENESIS_TOOLS_HOME;
        } else {
            process.env.GENESIS_TOOLS_HOME = prevHome;
        }
    });

    it("buildSession stamps the injected now and is deterministic", () => {
        const now = new Date("2026-06-02T12:00:00.000Z");
        const rec = buildSession({ mapping: { "[EMAIL_1]": "a@b.com" }, now, types: ["emails"] });
        expect(rec.createdAt).toBe("2026-06-02T12:00:00.000Z");
        expect(rec.mapping["[EMAIL_1]"]).toBe("a@b.com");
        expect(rec.types).toEqual(["emails"]);
    });

    it("saveSession then loadLatestSession round-trips the mapping", async () => {
        const now = new Date("2026-06-02T12:00:00.000Z");
        const rec = buildSession({ mapping: { "[IP_1]": "10.0.0.4" }, now, types: ["ips"] });
        const path = await saveSession(rec);
        expect(path.startsWith(sandbox)).toBe(true);
        const latest = await loadLatestSession();
        expect(latest?.mapping["[IP_1]"]).toBe("10.0.0.4");
    });

    it("loadLatestSession returns the newest of several sessions", async () => {
        await saveSession(
            buildSession({
                mapping: { "[IP_1]": "1.1.1.1" },
                now: new Date("2026-06-01T00:00:00.000Z"),
                types: ["ips"],
            })
        );
        await saveSession(
            buildSession({
                mapping: { "[IP_1]": "2.2.2.2" },
                now: new Date("2026-06-02T00:00:00.000Z"),
                types: ["ips"],
            })
        );
        const latest = await loadLatestSession();
        expect(latest?.mapping["[IP_1]"]).toBe("2.2.2.2");
    });

    it("loadMapFile reads both a bare mapping and a session record", async () => {
        const mapPath = join(sandbox, "map.json");
        await Bun.write(mapPath, SafeJSON.stringify({ "[EMAIL_1]": "a@b.com" }));
        expect((await loadMapFile(mapPath))["[EMAIL_1]"]).toBe("a@b.com");

        const recPath = join(sandbox, "rec.json");
        const rec = buildSession({
            mapping: { "[IP_1]": "9.9.9.9" },
            now: new Date("2026-06-02T12:00:00.000Z"),
            types: ["ips"],
        });
        await Bun.write(recPath, SafeJSON.stringify(rec));
        expect((await loadMapFile(recPath))["[IP_1]"]).toBe("9.9.9.9");
    });

    it("redact then save then restore round-trips through a real session file", async () => {
        const r = redact("ping 10.0.0.4 from jane@example.com", opts);
        await saveSession(
            buildSession({ mapping: r.mapping, now: new Date("2026-06-02T12:00:00.000Z"), types: DEFAULT_TYPES })
        );
        const latest = await loadLatestSession();
        expect(latest).not.toBeNull();
        if (latest !== null) {
            expect(restore(r.redacted, latest.mapping)).toBe("ping 10.0.0.4 from jane@example.com");
        }
    });
});
