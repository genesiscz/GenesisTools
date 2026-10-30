import { describe, expect, test } from "bun:test";
import { argvSessionId, classifyCommand, isAgentProcess, runsAgent } from "./classify";

// Invented pids, paths and session ids; the process shapes are copied from a real `ps -axo` dump.
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const S3 = "33333333-3333-4333-8333-333333333333";
const HOME = "/Users/alice";
const GT = "/Users/alice/Projects/GenesisTools";

describe("classifyCommand", () => {
    test("agent CLIs by their binary or entry script, with the session id the argv names", () => {
        expect(classifyCommand(`${HOME}/.bun/bin/claude --resume ${S1}`)).toEqual({
            kind: "agent",
            provider: "claude",
            label: "claude",
            sessionId: S1,
            service: false,
        });
        expect(classifyCommand(`${HOME}/.local/share/claude/versions/2.1.112 -p hi`).provider).toBe("claude");
        expect(classifyCommand(`${HOME}/node_modules/@openai/codex/vendor/codex resume ${S2}`)).toMatchObject({
            provider: "codex",
            sessionId: S2,
        });
        expect(classifyCommand(`node ${HOME}/.local/share/cursor-agent/versions/1.2/index.js`).provider).toBe(
            "cursor-agent"
        );
        expect(classifyCommand(`bash ${HOME}/.local/bin/cursor-agent --print`).provider).toBe("cursor-agent");
        expect(classifyCommand("/usr/local/bin/grok").provider).toBe("grok");
    });

    test("a versioned Grok binary is an agent, while grok-proxy remains a tool", () => {
        expect(classifyCommand(`/opt/bin/grok-1.0.52-maco -r ${S1}`)).toMatchObject({
            kind: "agent",
            provider: "grok",
            sessionId: S1,
        });
        expect(classifyCommand("grok-proxy up").kind).toBe("other");
    });

    test("apps and scripts that only share a name are not agents", () => {
        expect(classifyCommand("/Applications/Grok Bot.app/Contents/MacOS/Grok Bot").kind).toBe("other");
        expect(classifyCommand(`${HOME}/.bun/bin/bun ${HOME}/.grok/grok-proxy.ts up`).kind).toBe("other");
        expect(
            classifyCommand("/Applications/Cursor.app/Contents/Frameworks/Cursor Helper (Renderer).app/x").kind
        ).toBe("other");
    });

    test("GenesisTools wrappers, MCP doors and other tools, through gt-* launchers and the app launcher face", () => {
        expect(
            classifyCommand(`${HOME}/.genesis-tools/bin/gt-cc --preload x.ts ${GT}/src/cc/index.ts run work`)
        ).toMatchObject({
            kind: "wrapper",
            provider: "claude",
            label: "tools cc run",
        });
        expect(classifyCommand(`bun ${GT}/tools codex resume ${S2}`)).toMatchObject({
            kind: "wrapper",
            provider: "codex",
            sessionId: S2,
        });
        expect(classifyCommand(`bun ${GT}/tools claude mcp`)).toMatchObject({ kind: "mcp", label: "tools claude mcp" });
        expect(
            classifyCommand(
                `${HOME}/Applications/GenesisTools.app/Contents/MacOS/GenesisTools bun ${GT}/tools mcp-manager gateway start`
            ).kind
        ).toBe("mcp");
        expect(classifyCommand(`bun ${GT}/tools hub procs`)).toMatchObject({ kind: "tools", label: "tools hub procs" });
        expect(classifyCommand(`bun ${GT}/.worktrees/feat-x/src/claude/index.ts resume ${S1}`).kind).toBe("wrapper");
    });

    test("MCP servers get the name that says which one", () => {
        expect(classifyCommand(`node ${HOME}/.bun/bin/context7-mcp`).label).toBe("context7-mcp");
        expect(classifyCommand(`node ${HOME}/.bun/bin/graft mcp`).label).toBe("graft mcp");
        expect(classifyCommand(`node ${HOME}/.bridge/bridgememory-mcp/server.cjs`).label).toBe("bridgememory-mcp");
        expect(classifyCommand("node /opt/x/node_modules/mcporter/dist/cli.js daemon start").label).toBe("mcporter");
        expect(classifyCommand("/usr/bin/python3 -m http.server").kind).toBe("other");
    });

    test("a Claude tool shell carries its session id", () => {
        expect(
            classifyCommand(`/bin/zsh -c source ${HOME}/.claude/shell-snapshots/s.sh && export X_SESSION_ID='${S3}'`)
        ).toEqual({
            kind: "shell",
            provider: "claude",
            label: "claude tool shell",
            sessionId: S3,
            service: false,
        });
    });

    test("an agent binary that runs a helper is a service, not a session", () => {
        for (const command of [
            "codex-gateway serve",
            "/opt/bin/codex-gateway serve",
            `${HOME}/Applications/GenesisTools.app/Contents/MacOS/GenesisTools codex-gateway serve`,
            `${HOME}/.bun/bin/claude mcp serve`,
            `node ${HOME}/node_modules/@anthropic-ai/claude-code/cli.js mcp serve`,
        ]) {
            expect(classifyCommand(command)).toMatchObject({ kind: "agent", service: true });
            expect(isAgentProcess(command, "codex") || isAgentProcess(command, "claude")).toBe(false);
        }

        // A versioned Codex binary resuming a session is the agent; a prompt that says "mcp" is no subcommand.
        expect(classifyCommand(`/opt/bin/codex-aarch64-apple-darwin resume ${S2}`).service).toBe(false);
        expect(isAgentProcess(`${HOME}/.bun/bin/claude --resume ${S1} mcp`, "claude")).toBe(true);
    });

    test("runsAgent takes a tools <agent> run|start|resume launcher from any checkout or off PATH", () => {
        expect(runsAgent("bun /repo/tools codex run work", "codex")).toBe(true);
        expect(runsAgent(`zsh -ic exec tools cc resume ${S1}`, "claude")).toBe(true);
        expect(runsAgent("bun /repo/tools codex run work", "claude")).toBe(false);
        expect(runsAgent("tools claude history", "claude")).toBe(false);
    });

    test("isAgentProcess takes the agent itself; runsAgent takes its wrappers too", () => {
        const binary = `${HOME}/.bun/bin/claude --agent-id mate@team --agent-name mate`;
        const wrapper = `bun run ${GT}/src/claude/index.ts run work`;

        expect(isAgentProcess(binary, "claude")).toBe(true);
        expect(isAgentProcess(wrapper, "claude")).toBe(false);
        expect(runsAgent(wrapper, "claude")).toBe(true);
        expect(runsAgent(binary, "codex")).toBe(false);
        expect(runsAgent(`bun ${GT}/src/claude/index.ts teams discover`, "claude")).toBe(false);
        expect(runsAgent(`rg -n claude ${GT}/src`, "claude")).toBe(false);
    });

    test("argvSessionId takes uuids only, never a resume query", () => {
        expect(argvSessionId("claude --resume agents-window")).toBeNull();
        expect(argvSessionId(`claude --resume=${S1}`)).toBe(S1);
        expect(argvSessionId(`claude -r '${S2}'`)).toBe(S2);
    });
});
