import { describe, expect, it, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReclaimCommand } from "@app/macos/commands/clones/reclaim";
import { getCachedPlan } from "@app/macos/lib/clones/cache";
import { presetsPath } from "@app/macos/lib/clones/presets";
import { SafeJSON } from "@genesiscz/utils/json";

interface Captured {
    out: string;
    err: string;
    code: number | undefined;
}

async function run(argv: string[]): Promise<Captured> {
    let output = "";
    const errLines: string[] = [];
    const origErr = console.error;
    const origExit = process.exit;
    let code: number | undefined;
    process.exitCode = undefined;
    const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
        (
            chunk: string | Uint8Array,
            encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
            callback?: (error?: Error | null) => void
        ) => {
            output += String(chunk);
            const cb = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
            cb?.();
            return true;
        }
    );
    console.error = (...x: unknown[]) => errLines.push(x.join(" "));
    process.exit = ((c?: number) => {
        code = c;
        throw new Error("__exit__");
    }) as typeof process.exit;
    try {
        await createReclaimCommand().parseAsync(["node", "reclaim", ...argv], { from: "node" });
    } catch (e) {
        if (!(e instanceof Error) || e.message !== "__exit__") {
            throw e;
        }
    } finally {
        stdoutSpy.mockRestore();
        console.error = origErr;
        process.exit = origExit;
    }

    const exitCode = process.exitCode;
    process.exitCode = undefined;
    return { out: output.replace(/\n$/, ""), err: errLines.join("\n"), code: code ?? exitCode };
}

function twoTrees(): string {
    const outer = mkdtempSync(join(tmpdir(), "gt-cl-recl-cmd-"));
    for (const name of ["w1", "w2"]) {
        const dep = join(outer, name, "node_modules", "dep");
        mkdirSync(join(dep, "lib"), { recursive: true });
        writeFileSync(join(dep, "index.js"), Buffer.alloc(50_000, 1));
        writeFileSync(join(dep, "lib", "a.js"), Buffer.alloc(40_000, 2));
    }

    return outer;
}

interface PlanJson {
    roots: string[];
    sets: Array<{ copies: number }>;
    totalReclaimable: number;
    fromSnapshot: boolean;
    selector: { minReal: number; exclude: string[]; targets: string[]; keepPartners: string[] };
}

describe("createReclaimCommand", () => {
    it("exposes plan, apply and presets", () => {
        const subs = createReclaimCommand()
            .commands.map((c) => c.name())
            .sort();
        expect(subs).toEqual(["apply", "plan", "presets"]);
    });

    it("plan --format json reports the discovered roots and the duplicate set, and writes the snapshot", async () => {
        const outer = twoTrees();
        try {
            const res = await run([
                "plan",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1024",
                "--format",
                "json",
            ]);
            const plan = SafeJSON.parse(res.out) as PlanJson;
            expect(plan.roots.length).toBe(2);
            expect(plan.sets.length).toBe(1);
            expect(plan.sets[0].copies).toBe(2);
            expect(plan.totalReclaimable).toBeGreaterThan(0);
            expect(plan.fromSnapshot).toBe(false);

            const cached = await getCachedPlan({
                roots: plan.roots,
                minSize: 1024,
                include: [],
                exclude: [],
                nodeModules: false,
                targets: ["node_modules"],
                worktreesOf: "",
                keepPartners: [],
            });
            expect(cached?.plan.length).toBe(1);
            expect(cached?.rootStamps.length).toBe(2);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("an empty --targets in non-TTY prints the possible values and exits 1", async () => {
        const res = await run(["plan", "--dir", tmpdir(), "--targets"]);
        expect(res.code).toBe(1);
        expect(res.err).toContain("gitignored");
        expect(res.err).toContain("node_modules");
        expect(res.err).toContain("--targets");
    });

    it("an unknown --keep-partners value is refused with the possible values", async () => {
        const res = await run(["plan", "--dir", tmpdir(), "--keep-partners", "cargo"]);
        expect(res.code).toBe(1);
        expect(res.err).toContain("cargo");
        expect(res.err).toContain("bun");
    });

    it("apply without --yes in non-TTY refuses and names the flag", async () => {
        const outer = twoTrees();
        try {
            const res = await run(["apply", "--dir", outer, "--targets", "node_modules", "--min-real", "1024"]);
            expect(res.code).toBe(1);
            expect(res.err).toContain("--yes");
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("apply reuses the plan snapshot while the roots are unchanged, and rescans after a change", async () => {
        const outer = twoTrees();
        try {
            await run(["plan", "--dir", outer, "--targets", "node_modules", "--min-real", "1024", "--format", "json"]);
            const reused = await run([
                "apply",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1024",
                "--format",
                "json",
            ]);
            expect(reused.code).toBe(1);
            expect(reused.err).toContain("--yes");

            // A new top-level entry moves the root's mtime → stale → rescan.
            writeFileSync(join(outer, "w1", "node_modules", "newcomer"), "x");
            const fresh = await run([
                "plan",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1024",
                "--format",
                "json",
            ]);
            expect((SafeJSON.parse(fresh.out) as PlanJson).fromSnapshot).toBe(false);
        } finally {
            rmSync(outer, { recursive: true, force: true });
        }
    });

    it("plan --save stores the selector; presets list, show, save and rm round-trip", async () => {
        const outer = twoTrees();
        try {
            await run([
                "plan",
                "--dir",
                outer,
                "--targets",
                "node_modules",
                "--min-real",
                "1024",
                "--format",
                "json",
                "--save",
                "fixture",
            ]);
            const listed = await run(["presets", "list", "--format", "json"]);
            const parsed = SafeJSON.parse(listed.out) as { presets: Array<{ id: string; targets: string[] }> };
            expect(parsed.presets.some((x) => x.id === "fixture" && x.targets[0] === "node_modules")).toBe(true);

            const saved = await run(["presets", "save", "second", "--dir", outer, "--targets", "vendor"]);
            expect(saved.out).toContain("second");
            const shown = await run(["presets", "show", "second"]);
            expect((SafeJSON.parse(shown.out) as { targets: string[] }).targets).toEqual(["vendor"]);

            expect((await run(["presets", "rm", "fixture"])).out).toContain("fixture");
            expect((await run(["presets", "rm", "second"])).out).toContain("second");
            expect((await run(["presets", "rm", "second"])).code).toBe(1);
        } finally {
            if (existsSync(presetsPath())) {
                rmSync(presetsPath());
            }

            rmSync(outer, { recursive: true, force: true });
        }
    });
});
