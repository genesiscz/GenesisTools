import { readFileSync } from "node:fs";
import { SafeJSON } from "@genesiscz/utils/json";

interface PatchComparison {
    oldPatch: string;
    newPatch: string | null;
    equalsReference: boolean;
}

interface Branch {
    name: string;
    oldHead: string;
    newHead: string;
    oldBase: string;
    newBase: string;
}

export function classifyPatch({ oldPatch, newPatch, equalsReference }: PatchComparison): string {
    if (newPatch === null) {
        return "DROPPED";
    }
    if (oldPatch === newPatch) {
        return "OK";
    }
    return equalsReference ? "CHANGED (equals reference)" : "CHANGED";
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
    const git = (args: string[], stdin?: Uint8Array) => {
        const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe", ...(stdin ? { stdin } : {}) });
        if (result.exitCode !== 0) {
            throw new Error(`git ${args[0]}: ${result.stderr.toString().trim()}`);
        }
        return result.stdout;
    };
    const patch = (base: string, head: string, file: string): string | null => {
        const diff = git([
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
        if (!diff.length) {
            return null;
        }
        const id = git(["patch-id", "--stable"], diff).toString().trim().split(/\s+/)[0];
        if (!id) {
            throw new Error(`cannot calculate patch id for ${file}`);
        }
        return id;
    };
    const blob = (ref: string, file: string): string | null => {
        const result = Bun.spawnSync(["git", "rev-parse", "--verify", `${ref}:${file}`], {
            stdout: "pipe",
            stderr: "pipe",
        });
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
        const files = git([
            "diff",
            "--no-ext-diff",
            "--no-renames",
            "--name-only",
            "-z",
            branch.oldBase,
            branch.oldHead,
            "--",
        ])
            .toString()
            .split("\0")
            .filter(Boolean);
        const rows = files.map((file) => {
            const oldPatch = patch(branch.oldBase, branch.oldHead, file);
            if (!oldPatch) {
                throw new Error(`missing old patch for ${file}`);
            }
            const newPatch = patch(branch.newBase, branch.newHead, file);
            const equalsReference = reference ? blob(branch.newHead, file) === blob(reference, file) : false;
            return {
                file,
                verdict: classifyPatch({ oldPatch, newPatch, equalsReference }),
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
    return results.some((branch) => branch.rows.some((row) => row.verdict === "DROPPED" || row.verdict === "CHANGED"))
        ? 1
        : 0;
}

if (import.meta.main) {
    try {
        process.exit(run(process.argv.slice(2)));
    } catch (error) {
        console.error(`STOP ${String(error)}`);
        process.exit(2);
    }
}
