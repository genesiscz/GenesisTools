import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
    agentsArgs,
    claudeCodexConfigRoot,
    leadPrompt,
    sessionAgents,
    writeAgentFiles,
} from "@app/claude/lib/codex-session/agents";
import { type CodexModelInfo, mergeCodexModelRecords } from "@genesiscz/utils/ai/openai/codex-models";
import { SafeJSON } from "@genesiscz/utils/json";

const catalog = mergeCodexModelRecords({ cache: [] });
const codexModel = (slug: string): CodexModelInfo | undefined => catalog.get(slug);

describe("leadPrompt", () => {
    it("names the Codex subagents with their models and sends Codex work to them, not to tools codex spawn", () => {
        const text = leadPrompt(sessionAgents({ codexModel }));

        expect(text).toContain("sol (gpt-6.1-sol, effort high)");
        expect(text).toContain("luna (gpt-6-luna, effort high)");
        expect(text).not.toContain("codex-worker (");
        expect(text).toContain("with the Agent tool");
        expect(text).toContain("codex spawn");
        expect(text).toContain("names the skills the subagent should load");
    });

    it("keeps one-off scripts inline and short commands in the foreground", () => {
        const text = leadPrompt(sessionAgents({ codexModel }));

        expect(text).toContain("Run one-off code inline");
        expect(text).toContain(
            "Write a script file only when you will run it again or it is longer than about 40 lines"
        );
        expect(text).toContain("in the foreground");
    });

    it("takes the configured note and skills list, and the nudge can be turned off", () => {
        const settings = {
            global: { lead: { systemNote: { append: "Prefer terra for reviews." } } },
            providers: { codex: { subagents: { skills: { allowed: ["genesis-tools:github", "simplify"] } } } },
        };
        const agents = sessionAgents({ codexModel, settings });
        const text = leadPrompt(agents, settings);

        expect(text.endsWith("Prefer terra for reviews.")).toBe(true);
        expect(text).toContain("Pick them from: genesis-tools:github, simplify.");
        expect(agents.sol.prompt).toContain("load only the skills your brief names");

        const off = {
            providers: { codex: { subagents: { skills: { nudge: false }, systemNote: { replace: "Own prompt." } } } },
        };
        expect(leadPrompt(sessionAgents({ codexModel, settings: off }), off)).not.toContain("names the skills");
        expect(sessionAgents({ codexModel, settings: off }).sol.prompt).toBe("Own prompt.");
    });
});

describe("sessionAgents", () => {
    it("lists the Codex agents with their own windows, the codex-worker, and no Claude agent without a Claude account", () => {
        const agents = sessionAgents({ codexModel });

        expect(Object.keys(agents)).toEqual(["sol", "sol-xhigh", "sol6", "astra", "terra", "luna", "codex-worker"]);
        expect(agents.sol.model).toBe("codex/gpt-6.1-sol");
        expect(agents.sol.effort).toBe("high");
        expect(agents.terra.model).toBe("codex/gpt-6.1-terra");
        expect(agents.terra.effort).toBe("high");
        expect(agents["sol-xhigh"].model).toBe("codex/gpt-6.1-sol");
        expect(agents["sol-xhigh"].effort).toBe("xhigh");
        expect(agents.sol.autoCompactWindow).toBe(codexModel("gpt-6.1-sol")?.window);
        // A 272K model gets its own window, not the main loop's.
        expect(agents.luna.autoCompactWindow).toBe(codexModel("gpt-6-luna")?.window);
        expect(agents.luna.autoCompactWindow).toBeLessThan(agents.sol.autoCompactWindow ?? 0);
        expect(agents.sol.disallowedTools).toEqual(["Agent"]);
        expect(agents["codex-worker"].tools).toEqual(["Bash", "Read", "Write"]);
    });

    it("adds opus on the Claude account ([1m] only where the model is not natively 1M), and fable only with Fable", () => {
        const withClaude = sessionAgents({ codexModel, claude: { fable: false } });

        expect(withClaude.opus.model).toMatch(/^claude-opus-[\d-]+(\[1m\])?$/);
        expect(withClaude.opus.effort).toBe("high");
        expect(withClaude.fable).toBeUndefined();
        expect(sessionAgents({ codexModel, claude: { fable: true } }).fable?.model).toMatch(/^claude-fable-/);
    });

    it("pins the codex-worker to the session's Codex login when it has one", () => {
        expect(sessionAgents({ codexModel, codexAccount: "work" })["codex-worker"].prompt).toContain(" -a work`");
        expect(sessionAgents({ codexModel })["codex-worker"].prompt).not.toContain(" -a ");
    });

    it("skips an agent whose effort the model does not have", () => {
        const noXhigh = (slug: string): CodexModelInfo | undefined => {
            const info = codexModel(slug);
            return info ? { ...info, efforts: info.efforts.filter((effort) => effort !== "xhigh") } : undefined;
        };

        expect(sessionAgents({ codexModel: noXhigh })["sol-xhigh"]).toBeUndefined();
    });
});

describe("agentsArgs", () => {
    const agents = sessionAgents({ codexModel });

    it("passes --agents JSON, unless the user passed their own after --", () => {
        const args = agentsArgs(["--verbose"], agents);

        expect(args[0]).toBe("--agents");
        expect(Object.keys(SafeJSON.parse(args[1] ?? "{}"))).toContain("codex-worker");
        expect(agentsArgs(["--agents", "{}"], agents)).toEqual([]);
        expect(agentsArgs(["--agents={}"], agents)).toEqual([]);
    });
});

describe("writeAgentFiles", () => {
    const agents = sessionAgents({ codexModel, claude: { fable: false } });

    it("writes agent files into an isolated config folder", () => {
        const dir = join(claudeCodexConfigRoot(), "test-session");
        const files = writeAgentFiles(dir, agents);
        const sol = readFileSync(join(dir, "agents", "sol.md"), "utf8");

        expect(files).toHaveLength(Object.keys(agents).length);
        expect(sol).toStartWith('---\nname: "sol"\n');
        expect(sol).toContain('model: "codex/gpt-6.1-sol"');
        expect(sol).toContain('effort: "high"');
        expect(sol).toContain("disallowedTools: Agent");
    });

    it("refuses any folder outside the config root (a home folder, a project) and the root itself", () => {
        for (const dir of [
            homedir(),
            process.cwd(),
            claudeCodexConfigRoot(),
            join(claudeCodexConfigRoot(), "..", "x"),
        ]) {
            expect(() => writeAgentFiles(dir, agents)).toThrow("agent files are written only into a folder under");
        }
    });
});
