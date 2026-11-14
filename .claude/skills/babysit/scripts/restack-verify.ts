import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { mustGit, spawnGit } from "./versions";

interface PatchComparison {
    /** null: the old range does not change the file, only the restacked range does. */
    oldPatch: string | null;
    /** null: the restacked range does not change the file. */
    newPatch: string | null;
    equalsReference: boolean;
    /** The new base already holds the old patch: the patch applies in reverse to the new base's copy of the file. */
    absorbed: boolean;
}

interface Branch {
    name: string;
    oldHead: string;
    newHead: string;
    oldBase: string;
    newBase: string;
}

/** The verdicts that fail the run. A verdict with its evidence (ABSORBED, "(equals reference)") passes. */
export const FAILING_VERDICTS = new Set(["DROPPED", "ADDED", "CHANGED"]);

export function classifyPatch({ oldPatch, newPatch, equalsReference, absorbed }: PatchComparison): string {
    if (oldPatch === newPatch) {
        return "OK";
    }

    if (newPatch === null && absorbed) {
        return "ABSORBED";
    }

    const verdict = newPatch === null ? "DROPPED" : oldPatch === null ? "ADDED" : "CHANGED";
    return equalsReference ? `${verdict} (equals reference)` : verdict;
}

function parseBranches(args: string[]): { branches: Branch[]; reference?: string; json: boolean } {
    const branches: Branch[] = [];
    let reference: string | undefined;
    let json = false;
    let current: Branch | undefined;
    let defaultOld: string | undefined;
    let defaultNew: string | undefined;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === "--json") {
            json = true;
            continue;
        }
        const value = args[++i];
        if (!value) {
            throw new Error(`missing value for ${arg}`);
        }
        if (arg === "--branch") {
            const match = /^([^=]+)=(.+)\.\.(.+)$/.exec(value);
            if (!match) {
                throw new Error(`invalid branch: ${value}`);
            }
            current = {
                name: match[1],
                oldHead: match[2],
                newHead: match[3],
                oldBase: defaultOld ?? "",
                newBase: defaultNew ?? "",
            };
            branches.push(current);
        } else if (arg === "--old-base") {
            if (current) {
                current.oldBase = value;
            } else {
                defaultOld = value;
            }
        } else if (arg === "--new-base") {
            if (current) {
                current.newBase = value;
            } else {
                defaultNew = value;
            }
        } else if (arg === "--reference") {
            reference = value;
        } else if (arg === "--file") {
            const input: unknown = SafeJSON.parse(readFileSync(value, "utf8"), { strict: true });
            const items: unknown[] = Array.isArray(input) ? input : [input];
            for (const item of items) {
                if (
                    !item ||
                    typeof item !== "object" ||
                    !("name" in item) ||
                    !("oldHead" in item) ||
                    !("newHead" in item) ||
                    !("oldBase" in item) ||
                    !("newBase" in item) ||
                    typeof item.name !== "string" ||
                    typeof item.oldHead !== "string" ||
                    typeof item.newHead !== "string" ||
                    typeof item.oldBase !== "string" ||
                    typeof item.newBase !== "string" ||
                    !item.name ||
                    !item.oldHead ||
                    !item.newHead ||
                    !item.oldBase ||
                    !item.newBase
                ) {
                    throw new Error("invalid branch object");
                }
                branches.push({
                    name: item.name,
                    oldHead: item.oldHead,
                    newHead: item.newHead,
                    oldBase: item.oldBase,
                    newBase: item.newBase,
                });
            }
        } else {
            throw new Error(`unknown option: ${arg}`);
        }
    }
    if (!branches.length || branches.some((branch) => !branch.oldBase || !branch.newBase)) {
        throw new Error("each branch needs --old-base and --new-base");
    }
    return { branches, reference, json };
}

function run(args: string[]): number {
    const { branches, reference, json } = parseBranches(args);
    const git = (args: string[], stdin?: Uint8Array) => mustGit(args, { stdin }).stdout;
    const diff = (base: string, head: string, file: string) =>
        git([
            "--literal-pathspecs",
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--binary",
            base,
            head,
            "--",
            file,
        ]);
    const patchId = (patch: Uint8Array, file: string): string | null => {
        if (!patch.length) {
            return null;
        }
        // --stable strips every space, so `"a b"` and `"ab"` hash alike; --verbatim keeps them and still ignores line numbers.
        const id = git(["patch-id", "--verbatim"], patch).toString().trim().split(/\s+/)[0];
        if (!id) {
            throw new Error(`cannot calculate patch id for ${file}`);
        }
        return id;
    };
    // A scratch index holds the new base, so the reverse check reads no checkout and touches none. `apply --check`
    // leaves the index as it was, so one read-tree per new base serves every lost file of every branch on it.
    const scratchDir = mkdtempSync(join(tmpdir(), "restack-verify-"));
    // Both ends of this script are process.exit, also a thrown error.
    process.on("exit", () => rmSync(scratchDir, { recursive: true, force: true }));
    const scratchEnvs = new Map<string, Record<string, string | undefined>>();
    const absorbed = (base: string, patch: Uint8Array): boolean => {
        let scratch = scratchEnvs.get(base);
        if (!scratch) {
            scratch = { ...env.getProcessEnv(), GIT_INDEX_FILE: join(scratchDir, `index-${scratchEnvs.size}`) };
            mustGit(["read-tree", base], { env: scratch });
            scratchEnvs.set(base, scratch);
        }

        return spawnGit(["apply", "--cached", "--check", "--reverse"], { env: scratch, stdin: patch }).exitCode === 0;
    };
    const blob = (ref: string, file: string): string | null => {
        const result = spawnGit(["rev-parse", "--verify", `${ref}:${file}`]);
        return result.exitCode === 0 ? result.stdout.toString().trim() : null;
    };
    const results = branches.map((branch) => {
        for (const ref of [
            branch.oldBase,
            branch.oldHead,
            branch.newBase,
            branch.newHead,
            ...(reference ? [reference] : []),
        ]) {
            git(["rev-parse", "--verify", `${ref}^{commit}`]);
        }
        const changed = (base: string, head: string) =>
            git(["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", base, head, "--"])
                .toString()
                .split("\0")
                .filter(Boolean);
        // A resolution can also change a file the old branch never touched: those come from the restacked range only.
        const files = [
            ...new Set([...changed(branch.oldBase, branch.oldHead), ...changed(branch.newBase, branch.newHead)]),
        ];
        const rows = files.map((file) => {
            const oldDiff = diff(branch.oldBase, branch.oldHead, file);
            const oldPatch = patchId(oldDiff, file);
            const newPatch = patchId(diff(branch.newBase, branch.newHead, file), file);
            const equalsReference = reference ? blob(branch.newHead, file) === blob(reference, file) : false;
            const lost = oldPatch !== null && newPatch === null;
            return {
                file,
                verdict: classifyPatch({
                    oldPatch,
                    newPatch,
                    equalsReference,
                    absorbed: lost && absorbed(branch.newBase, oldDiff),
                }),
                oldPatch,
                newPatch,
                equalsReference,
            };
        });
        return { ...branch, rows };
    });
    if (json) {
        console.log(SafeJSON.stringify(results, null, 2));
    } else {
        for (const branch of results) {
            console.log(`\n${branch.name}`);
            console.log("VERDICT\tFILE");
            for (const row of branch.rows) {
                console.log(`${row.verdict}\t${row.file}`);
            }
            if (!branch.rows.length) {
                console.log("(no changed files)");
            }
        }
    }
    return results.some((branch) => branch.rows.some((row) => FAILING_VERDICTS.has(row.verdict))) ? 1 : 0;
}

if (import.meta.main) {
    try {
        process.exit(run(process.argv.slice(2)));
    } catch (error) {
        console.error(`STOP ${String(error)}`);
        process.exit(2);
    }
}
