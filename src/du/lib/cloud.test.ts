import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanWithBun } from "./bun-scan";
import { type CloneFixture, makeCloneFixture } from "./clone-fixture";
import {
    domainOf,
    FP_DOMAIN_XATTR,
    ICLOUD_PROVIDER,
    isCloudRoot,
    isDomainCandidate,
    providerOf,
    TRESORIT_PROVIDER,
} from "./cloud";
import { runEvict } from "./cloud-commands";
import { listCloudFiles, scanWithCFfi } from "./engine";
import {
    applyEviction,
    type CloudCtl,
    type CloudItemStatus,
    type EvictOutcome,
    judgeEviction,
    planEviction,
    TRESORIT_REFUSAL,
} from "./evict";
import type { ClonesizeResult, CloudFileEntry } from "./types";

const describeOnDarwin = process.platform === "darwin" ? describe : describe.skip;

describe("cloud path rules", () => {
    it("finds domain-root candidates only where File Provider puts them", () => {
        expect(isDomainCandidate("/Users/alice", "Documents")).toBe(true);
        expect(isDomainCandidate("/System/Volumes/Data/Users/alice", "Desktop")).toBe(true);
        expect(isDomainCandidate("/Users/alice/Library/CloudStorage", "Box")).toBe(true);
        expect(isDomainCandidate("/Users/alice/Library", "Mobile Documents")).toBe(true);
        expect(isDomainCandidate("/Users/alice/Projects", "repo")).toBe(false);
        expect(isDomainCandidate("/Users", "alice")).toBe(false);
        expect(isDomainCandidate("/Users/alice/Library", "Caches")).toBe(false);
    });

    it("skips the two provider roots under any Library", () => {
        expect(isCloudRoot("/Users/alice/Library", "CloudStorage")).toBe(true);
        expect(isCloudRoot("/Users/alice/Library", "Mobile Documents")).toBe(true);
        expect(isCloudRoot("/Users/alice/Documents", "CloudStorage")).toBe(false);
    });

    it("keeps only the provider part of a domain id", () => {
        expect(providerOf("com.example.box/alice@example.com")).toBe("com.example.box");
        expect(providerOf("com.example.box")).toBe("com.example.box");
    });

    it("maps a folder to its innermost domain, never a sibling with a shared prefix", () => {
        const domains = [
            { path: "/u/Docs", provider: "a" },
            { path: "/u/Docs/inner", provider: "b" },
        ];
        expect(domainOf("/u/Docs/x", domains)?.provider).toBe("a");
        expect(domainOf("/u/Docs/inner/y", domains)?.provider).toBe("b");
        expect(domainOf("/u/Docsx", domains)).toBeNull();
    });
});

// A folder carrying the File Provider domain xattr is treated as cloud-backed by
// both engines: stat only by default (nothing opened, clones not deduped), and
// opened with --include-cloud (the negative control: clones dedupe again).
describeOnDarwin("File Provider domain roots are measured by stat only", () => {
    let root: string;
    let fx: CloneFixture;
    let plain: string;
    const r: Record<string, ClonesizeResult> = {};

    beforeAll(async () => {
        root = mkdtempSync(join(tmpdir(), "gt-du-cloud-"));
        fx = makeCloneFixture(join(root, "dom"), { files: 4, copies: 1 });
        execFileSync("xattr", ["-w", FP_DOMAIN_XATTR, "com.example.FakeProvider/fixture", join(root, "dom")], {
            env: process.env,
        });
        plain = join(root, "plain");
        mkdirSync(plain);
        writeFileSync(join(plain, "a.bin"), Buffer.alloc(8192, 1));
        const dir = fx.realClones.dir;
        r.cffi = scanWithCFfi({ path: dir, threads: 2 });
        r.bun = await scanWithBun({ path: dir, threads: 2 });
        r.cffiOpen = scanWithCFfi({ path: dir, threads: 2, includeCloud: true });
        r.bunOpen = await scanWithBun({ path: dir, threads: 2, includeCloud: true });
    });

    afterAll(() => {
        rmSync(root, { recursive: true, force: true });
    });

    for (const engine of ["cffi", "bun"] as const) {
        it(`${engine}: opens nothing and counts every clone at full size`, () => {
            const x = r[engine]!;
            const { baseBytes, clones } = fx.realClones;
            expect(x.files_opened).toBe(0);
            expect(x.naive_bytes).toBe(baseBytes * (clones + 1));
            expect(x.unique_allocated_bytes).toBe(x.naive_bytes);
            expect(x.cloud_backed?.mode).toBe("stat-only");
            expect(x.cloud_backed?.files).toBe(clones + 1);
            expect(x.cloud_backed?.local_bytes).toBe(x.naive_bytes);
            const folder = x.cloud_backed?.folders[0];
            expect(folder?.path).toBe(join(root, "dom"));
            expect(folder?.domain).toBe(true);
            expect(folder?.provider).toBe("com.example.FakeProvider");
        });

        it(`${engine}: --include-cloud opens the files and dedupes the clones again`, () => {
            const x = r[`${engine}Open`]!;
            const { baseBytes, clones } = fx.realClones;
            expect(x.files_opened).toBeGreaterThan(0);
            expect(x.shared_bytes).toBe(baseBytes * clones);
            expect(x.cloud_backed?.mode).toBe("opened");
        });
    }

    it("downloaded lists the domain's files with their provider, and nothing outside a domain", () => {
        const listed = listCloudFiles({ root: join(root, "dom"), threads: 2 });
        expect(listed.files.length).toBeGreaterThan(0);
        expect(listed.files.every((f) => f.provider === "com.example.FakeProvider")).toBe(true);
        expect(listed.files.every((f) => f.domain === join(root, "dom"))).toBe(true);
        expect(listCloudFiles({ root: plain, threads: 2 }).files).toEqual([]);
    });
});

const file = (path: string, provider = ICLOUD_PROVIDER): CloudFileEntry => ({
    path,
    size: 4096,
    alloc: 4096,
    domain: "/u/Documents",
    provider,
});

const uploaded = (path: string): CloudItemStatus => ({
    path,
    ubiquitous: true,
    uploaded: true,
    uploading: false,
    downloading: "current",
});

/** A fake whose evict THROWS for any path it was not told is safe, so a leak fails loudly. */
function fakeCtl(statuses: CloudItemStatus[], safe: string[]): CloudCtl & { evicted: string[]; asked: string[] } {
    const evicted: string[] = [];
    const asked: string[] = [];
    return {
        evicted,
        asked,
        status: async (paths) => {
            asked.push(...paths);
            return statuses.filter((s) => paths.includes(s.path));
        },
        evict: async (paths): Promise<EvictOutcome[]> => {
            for (const p of paths) {
                if (!safe.includes(p)) {
                    throw new Error(`evict reached a path that is not safe: ${p}`);
                }
            }

            evicted.push(...paths);
            return paths.map((p) => ({ path: p, evicted: true }));
        },
    };
}

describe("eviction safety", () => {
    it("refuses every state that does not prove the cloud has the file", () => {
        const f = file("/u/Documents/a");
        expect(judgeEviction(f, uploaded(f.path)).ok).toBe(true);
        const cases: [Partial<CloudItemStatus>, string][] = [
            [{ uploaded: false }, "not uploaded yet"],
            [{ uploading: true }, "upload in progress"],
            [{ uploadError: "quota" }, "upload error: quota"],
            [{ ubiquitous: false }, "not an iCloud item"],
            [{ downloading: "downloaded" }, "local copy is not the current version (downloaded)"],
            [{ error: "denied" }, "status unknown: denied"],
        ];
        for (const [patch, reason] of cases) {
            const v = judgeEviction(f, { ...uploaded(f.path), ...patch });
            expect(v.ok).toBe(false);
            expect(v.ok ? "" : v.reason).toBe(reason);
        }

        const missing = judgeEviction(f, undefined);
        expect(missing.ok).toBe(false);
    });

    it("refuses Tresorit and other providers without asking for a status", async () => {
        const t = file("/u/T/a", TRESORIT_PROVIDER);
        const o = file("/u/B/b", "com.example.box");
        const ctl = fakeCtl([uploaded(t.path), uploaded(o.path)], []);
        const plan = await planEviction([t, o], ctl);
        expect(plan.eligible).toEqual([]);
        expect(plan.refused.map((v) => v.reason)[0]).toBe(TRESORIT_REFUSAL);
        expect(plan.refused[1]?.reason).toContain("only iCloud Drive eviction is supported");
        expect(ctl.asked).toEqual([]);
    });

    it("applies only to eligible paths, even when the caller passes others", async () => {
        const good = file("/u/Documents/good");
        const pending = file("/u/Documents/pending");
        const ctl = fakeCtl([uploaded(good.path), { ...uploaded(pending.path), uploaded: false }], [good.path]);
        const plan = await planEviction([good, pending], ctl);
        const res = await applyEviction(plan, [good.path, pending.path, "/etc/hosts"], ctl);
        expect(ctl.evicted).toEqual([good.path]);
        expect(res.filter((x) => !x.evicted).map((x) => x.path)).toEqual([pending.path, "/etc/hosts"]);
    });

    it("a dry run plans but never evicts; --apply evicts the selected eligible files", async () => {
        const good = file("/u/Documents/good");
        const dry = fakeCtl([uploaded(good.path)], []);
        await runEvict({ root: "/u/Documents", files: [good], cli: { all: true }, ctl: dry });
        expect(dry.asked).toEqual([good.path]);
        expect(dry.evicted).toEqual([]);

        const live = fakeCtl([uploaded(good.path)], [good.path]);
        await runEvict({ root: "/u/Documents", files: [good], cli: { all: true, apply: true }, ctl: live });
        expect(live.evicted).toEqual([good.path]);
    });
});
