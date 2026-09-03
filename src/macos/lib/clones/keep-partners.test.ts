import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    bunCacheCandidates,
    KEEP_PARTNER_IDS,
    makePartnerFor,
    packageIdentityOf,
    resolveKeepPartners,
} from "@app/macos/lib/clones/keep-partners";

function worktreePkg(base: string, name: string, version: string): string {
    const dir = join(base, "node_modules", ...name.split("/"));
    mkdirSync(join(dir, "lib"), { recursive: true });
    writeFileSync(join(dir, "package.json"), `{"name":"${name}","version":"${version}"}\n`);
    writeFileSync(join(dir, "lib", "x.a"), Buffer.alloc(4096, 3));
    return dir;
}

describe("packageIdentityOf", () => {
    it("reads name and version from the enclosing scoped package", () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-kp-id-"));
        try {
            const dir = worktreePkg(outer, "@scope/pkg", "1.2.3");
            expect(packageIdentityOf(join(dir, "lib", "x.a"))).toEqual({ dir, name: "@scope/pkg", version: "1.2.3" });
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("reads an unscoped package too, and returns null outside node_modules", () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-kp-id2-"));
        try {
            const dir = worktreePkg(outer, "plain", "0.1.0");
            expect(packageIdentityOf(join(dir, "lib", "x.a"))?.name).toBe("plain");
            writeFileSync(join(outer, "loose.a"), "x");
            expect(packageIdentityOf(join(outer, "loose.a"))).toBeNull();
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});

describe("bunCacheCandidates", () => {
    const listDir = (dir: string): string[] =>
        dir.endsWith("@scope")
            ? ["pkg", "pkg@1.2.3@@@1", "pkg@1.2.3@@registry.example@@@1", "pkg@9.9.9@@@1", "other@1.2.3@@@1"]
            : ["plain@0.1.0@@@1", "plainer@0.1.0@@@1"];

    it("matches every cache entry for that exact name and version, scoped", () => {
        const got = bunCacheCandidates("/c", { dir: "/w", name: "@scope/pkg", version: "1.2.3" }, "lib/x.a", listDir);
        expect(got).toEqual([
            join("/c", "@scope", "pkg@1.2.3@@@1", "lib/x.a"),
            join("/c", "@scope", "pkg@1.2.3@@registry.example@@@1", "lib/x.a"),
        ]);
    });

    it("does not match a different package whose name merely shares the prefix", () => {
        const got = bunCacheCandidates("/c", { dir: "/w", name: "plain", version: "0.1.0" }, "lib/x.a", listDir);
        expect(got).toEqual([join("/c", "plain@0.1.0@@@1", "lib/x.a")]);
    });
});

describe("resolveKeepPartners", () => {
    it("uses each manager's own command and keeps only roots that exist", () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-kp-root-"));
        try {
            const bunRoot = join(outer, "bun-cache");
            mkdirSync(bunRoot, { recursive: true });
            const calls: string[][] = [];
            const run = (argv: string[]): string | null => {
                calls.push(argv);
                if (argv[0] === "bun") {
                    return `${bunRoot}\n`;
                }

                if (argv[0] === "npm") {
                    return join(outer, "no-such-npm-cache");
                }

                return null;
            };

            const got = resolveKeepPartners(["bun", "npm", "pnpm"], run);
            expect(got).toEqual([{ id: "bun", root: bunRoot }]);
            expect(calls[0]).toEqual(["bun", "pm", "cache"]);
            expect(calls[1]).toEqual(["npm", "config", "get", "cache"]);
            expect(calls[2]).toEqual(["pnpm", "store", "path"]);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("names all five managers", () => {
        expect([...KEEP_PARTNER_IDS]).toEqual(["bun", "npm", "pnpm", "yarn", "composer"]);
    });
});

describe("makePartnerFor", () => {
    it("returns existing bun cache files for a worktree file", () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-kp-partner-"));
        try {
            const dir = worktreePkg(outer, "@scope/pkg", "1.2.3");
            const cache = join(outer, "cache");
            const entry = join(cache, "@scope", "pkg@1.2.3@@@1");
            mkdirSync(join(entry, "lib"), { recursive: true });
            writeFileSync(join(entry, "lib", "x.a"), Buffer.alloc(4096, 3));

            const partnerFor = makePartnerFor([{ id: "bun", root: cache }]);
            expect(partnerFor(join(dir, "lib", "x.a"), 4096)).toEqual([join(entry, "lib", "x.a")]);
            expect(partnerFor(join(dir, "lib", "missing.a"), 4096)).toEqual([]);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("a non-bun partner resolves nothing rather than guessing", () => {
        const outer = mkdtempSync(join(tmpdir(), "gt-cl-kp-nonbun-"));
        try {
            const dir = worktreePkg(outer, "@scope/pkg", "1.2.3");
            const partnerFor = makePartnerFor([{ id: "npm", root: join(outer, "npm-cache") }]);
            expect(partnerFor(join(dir, "lib", "x.a"), 4096)).toEqual([]);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });
});
