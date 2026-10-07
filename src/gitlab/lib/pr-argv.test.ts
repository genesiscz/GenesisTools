import { describe, expect, test } from "bun:test";
import { type CommandNode, isMrRef, rewritePrArgv } from "./pr-argv";

const leaf = (): CommandNode => ({ children: new Map() });
const group = (children: Record<string, CommandNode>, defaultChild?: string): CommandNode => ({
    children: new Map(Object.entries(children)),
    defaultChild,
});

const PR = group(
    {
        show: leaf(),
        review: leaf(),
        comments: group(
            { list: leaf(), drafts: leaf(), reply: leaf(), add: leaf(), delete: leaf(), publish: leaf() },
            "list"
        ),
        labels: leaf(),
        stale: group({ preflight: leaf() }),
        touching: leaf(),
    },
    "show"
);

describe("isMrRef", () => {
    test("a number, a bang number, a comma list and an MR URL are MRs; words and flags are not", () => {
        expect(
            ["7412", "!7412", "7412,7413", "https://gitlab.example.com/g/p/-/merge_requests/7"].map(isMrRef)
        ).toEqual([true, true, true, true]);
        expect(["stale", "touching", "--help", "7412x", "comments"].map(isMrRef)).toEqual([
            false,
            false,
            false,
            false,
            false,
        ]);
    });
});

describe("rewritePrArgv", () => {
    test("the MR moves behind the command path; a bare MR runs `show`", () => {
        expect(rewritePrArgv(["pr", "7412"], PR)).toEqual(["pr", "show", "7412"]);
        expect(rewritePrArgv(["pr", "7412", "review", "--give"], PR)).toEqual(["pr", "review", "7412", "--give"]);
        expect(rewritePrArgv(["pr", "7412", "comments", "reply", "T03", "--body-file", "r.md"], PR)).toEqual([
            "pr",
            "comments",
            "reply",
            "7412",
            "T03",
            "--body-file",
            "r.md",
        ]);
    });

    test("a group without a verb runs its default leaf, and options stay after the MR", () => {
        expect(rewritePrArgv(["pr", "!7412", "comments", "--unresolved"], PR)).toEqual([
            "pr",
            "comments",
            "list",
            "7412",
            "--unresolved",
        ]);
    });

    test("a comma list stays one argument", () => {
        expect(rewritePrArgv(["pr", "7412,7413", "labels", "--add", "x"], PR)).toEqual([
            "pr",
            "labels",
            "7412,7413",
            "--add",
            "x",
        ]);
    });

    test("an MR URL gives the iid, and the host and project unless they were passed", () => {
        expect(rewritePrArgv(["pr", "https://gitlab.example.com/group/app/-/merge_requests/42", "review"], PR)).toEqual(
            ["pr", "review", "42", "--host", "https://gitlab.example.com", "--project", "group/app"]
        );
        expect(
            rewritePrArgv(
                ["pr", "https://gitlab.example.com/group/app/-/merge_requests/42/diffs", "review", "--project", "x/y"],
                PR
            )
        ).toEqual(["pr", "review", "42", "--project", "x/y", "--host", "https://gitlab.example.com"]);
    });

    test("commands about many MRs, help, global flags and other tools' words are left alone", () => {
        expect(rewritePrArgv(["pr", "stale", "preflight"], PR)).toEqual(["pr", "stale", "preflight"]);
        expect(rewritePrArgv(["pr", "--help"], PR)).toEqual(["pr", "--help"]);
        expect(rewritePrArgv(["-v", "pr", "7412", "comments"], PR)).toEqual(["-v", "pr", "comments", "list", "7412"]);
        expect(rewritePrArgv(["user", "activity"], PR)).toEqual(["user", "activity"]);
    });

    test("--help on a group after the MR shows the group, so its verbs are listed", () => {
        expect(rewritePrArgv(["pr", "7412", "comments", "--help"], PR)).toEqual(["pr", "comments", "--help"]);
    });

    test("--help after the MR asks for that leaf's help", () => {
        expect(rewritePrArgv(["pr", "7412", "comments", "reply", "--help"], PR)).toEqual([
            "pr",
            "comments",
            "reply",
            "7412",
            "--help",
        ]);
    });
});
