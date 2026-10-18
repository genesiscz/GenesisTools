import { describe, expect, it } from "bun:test";
import { checkSubject, scopeFromFiles } from "./commit-scopes";

const KIT = "src/macos/GenesisKit/Sources/GenesisKit";

/** Each case: the old subject, its files, the subject the rules want. */
const CASES: [string, string[], string][] = [
    ["fix(widget): a", [`${KIT}/Widgets/Shelf.swift`], "fix(GenesisHub, widgets): a"],
    ["feat(genesis-kit): a", [`${KIT}/Controls/Pill.swift`], "feat(GenesisKit): a"],
    ["fix(settings): a", [`${KIT}/Settings/Page.swift`], "fix(GenesisHub, settings): a"],
    ["fix(clicky): a", [`${KIT}/Clicky/Board.swift`], "fix(Clicky): a"],
    ["docs(ux): a", [".claude/skills/ux/SKILL.md"], "docs(skills, ux): a"],
    ["docs(skills): a", [".claude/skills/ux/a.md", ".claude/skills/swift/b.md"], "docs(skills, ux, swift): a"],
    ["fix(scripts): a", ["scripts/native/widget-drive.ts"], "fix(scripts, native): a"],
    ["fix(scripts): a", ["scripts/benchmarks/widget/roster.ts"], "fix(scripts): a"],
    ["fix(history): a", ["src/utils/agent-sessions/list.ts"], "fix(ai, history): a"],
    ["fix(hub): a", ["src/macos/GenesisTools/Sources/Parts/Hub/Hub/HubView.swift"], "fix(GenesisHub, hub): a"],
    ["fix(hub): a", ["src/hub/server/doors/frequent.ts"], "fix(hub): a"],
    [
        "fix(dashboards): a",
        ["src/utils/ui/vite.ts", "src/dev-dashboard/vite.config.ts"],
        "fix(dashboards, dev-dashboard): a",
    ],
    ["fix(#485 follow-up): a", ["src/utils/ai/x.ts", "src/cmux/y.ts"], "fix(ai, cmux): #485 followup - a"],
    [
        "fix(widget): address PR #487 review round 5 (#487-only files): a",
        [`${KIT}/Widgets/Tasks.swift`],
        "fix(GenesisHub, widgets): address PR review round 5: a",
    ],
    ["revloop(#482 round 4): a", ["src/question/lib/inbox.ts"], "fix(question): address PR review round 4: a"],
];

describe("checkSubject", () => {
    it.each(CASES)("%s", (subject, files, want) => {
        expect(checkSubject(subject, files).subject).toBe(want);
    });

    it.each(CASES)("the corrected form of %s passes unchanged", (_subject, files, want) => {
        expect(checkSubject(want, files)).toEqual({ subject: want, problems: [] });
    });

    it("reports a PR number it cannot rewrite, and lets a follow-up keep its own", () => {
        expect(checkSubject("fix(cmux): the fix for #123 lands", ["src/cmux/a.ts"]).problems).toHaveLength(1);
        expect(checkSubject("fix(ai, cmux): #485 followup - a", ["src/cmux/a.ts"]).problems).toEqual([]);
    });

    it("rejects a subject without a type and an unknown type", () => {
        expect(checkSubject("Update stuff", []).problems).toEqual(["is not `type(scope): text`"]);
        expect(checkSubject("wip(hub): a", ["src/hub/a.ts"]).problems).toHaveLength(1);
        expect(checkSubject("bench(agent-sessions): a", ["src/utils/agent-sessions/a.ts"]).problems).toEqual([]);
    });
});

describe("scopeFromFiles", () => {
    it("names `tools` once more than three areas change", () => {
        expect(scopeFromFiles(["src/hub/a.ts", "src/question/b.ts", "src/cmux/c.ts", "src/daemon/d.ts"])).toBe("tools");
        expect(scopeFromFiles(["src/hub/a.ts", `${KIT}/Widgets/W.swift`])).toBe("hub, GenesisHub, widgets");
    });
});
