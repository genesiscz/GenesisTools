import { type ControlMessage, type Input, InputError, parseJsonText } from "./inbox";
import type { Item, Model, Reasoning, Request, Response, Tool, ToolResult, ToolResultOutput } from "./llm";
import type { Skill } from "./tool";

/**
 * In-memory model request construction, ported 1:1 from `harness/contextbuilder`.
 *
 * The history has two parts. `committedPrefix` is what a model request already carried; it
 * only ever grows, so the provider's prompt cache keeps hitting. `stagedSuffix` is what
 * arrived since; `commit()` folds it in when the next turn starts. A tool call that is still
 * running shows `TOOL_CALL_RUNNING_PAYLOAD` until its result lands; if that happens before
 * the next commit the placeholder is replaced in place and the model never sees it.
 */

/** Verbatim `prompts/preamble.md` of the pinned upstream commit (UPSTREAM.md). */
export const PREAMBLE = `You run on Unreal Agent Harness built by Unreal Labs.

You work in turns. A turn is one reading of the conversation and one reply: text, tool calls, or both. Each turn re-sends the whole conversation, so prefer to go wider with tool calls — they are cheap — rather than chaining them across a longer sequence of turns. When the next commands do not depend on each other's output (inspecting several files, running the build and the tests, probing two hypotheses), issue them as separate tool calls in the same turn instead of one at a time.

Tool calls are asynchronous: each starts the moment you issue it and runs in the background, so issuing one never blocks you and many run at once. As each finishes, its result is appended and wakes a new turn; results that land together arrive in the same turn, and a call still running shows a placeholder until its own result comes.

You never have to babysit a running call: harness does it for you. As a backup, if calls are active and nothing has happened for ten minutes, a heartbeat wakes you, and this is an opportunity to check that all is well.

Ending a turn with no tool calls while calls are running means you sleep until one finishes; ending a turn with nothing running ends the session, so do that only when the task is complete.

Treat the prompt as a goal and keep working until it is met. I believe in you!`;

/** Verbatim `prompts/skill-preamble.md`. */
export const SKILL_PREAMBLE = `The following skills provide specialized instructions for specific tasks.
Use SkillUse to load a skill's file when the task matches its description.
When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool calls.`;

/** The result a running call shows until it completes. */
export const TOOL_CALL_RUNNING_PAYLOAD =
    "Tool call is still running. Its result arrives in a later turn: continue with independent work, or end your turn to wait for it.";

export type ChangeKind = "omitted" | "truncated" | "compacted";

export interface Change {
    Kind: ChangeKind;
    Source: string;
    Reason: string;
}

export interface Report {
    Changes: Change[];
}

export interface BuildResult {
    Request: Request;
    Report: Report;
}

/** Retains model request state without performing I/O. */
export interface Builder {
    addExternalInput(input: Input): void;
    addControlMessage(request: ControlMessage): void;
    setModel(model: Model): void;
    setSystemPrompt(prompt: string): void;
    addModelResponse(response: Response): void;
    addReasoning(reasoning: Reasoning): void;
    addTool(tool: Tool): void;
    addToolResult(callID: string, payload: ToolResultOutput[], running: boolean): void;
    commit(): void;
    build(): BuildResult;
}

function escapeXml(text: string): string {
    return text
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&#34;")
        .replaceAll("'", "&#39;")
        .replaceAll("\t", "&#x9;")
        .replaceAll("\n", "&#xA;")
        .replaceAll("\r", "&#xD;");
}

/** Same bytes Go's `encoding/xml` emits for `availableSkills`: no whitespace, escaped text. */
export function formatSkillsForPrompt(skills: Skill[]): string {
    if (skills.length === 0) {
        return "";
    }

    const encoded = skills
        .map(
            (skill) =>
                `<skill><name>${escapeXml(skill.Name)}</name><description>${escapeXml(skill.Description)}</description><location>${escapeXml(skill.Path)}</location></skill>`
        )
        .join("");
    return `${SKILL_PREAMBLE}\n\n<available_skills>${encoded}</available_skills>`;
}

function runningOutput(): ToolResultOutput[] {
    return [{ Kind: "text", Value: TOOL_CALL_RUNNING_PAYLOAD }];
}

function isRunningOutput(output: ToolResultOutput[]): boolean {
    return output.length === 1 && output[0].Kind === "text" && output[0].Value === TOOL_CALL_RUNNING_PAYLOAD;
}

class ContextBuilder implements Builder {
    private request: Request = { Model: { ID: "" }, Input: [], Tools: [] };
    private readonly preamble: string;
    private systemPrompt = "";
    private committedPrefix: Item[];
    private stagedSuffix: Item[] = [];

    constructor(skills: Skill[]) {
        const skillPrompt = formatSkillsForPrompt(skills);
        this.preamble = skillPrompt ? `${PREAMBLE}\n\n${skillPrompt}` : PREAMBLE;
        this.committedPrefix = [{ Type: "message", Data: { Role: "system", Text: "" } }];
        this.setSystemPrompt("");
    }

    addExternalInput(input: Input): void {
        if (input.Kind !== "external") {
            throw new InputError(`external input "${input.ID}" has input kind "${input.Kind}"`);
        }

        let text: unknown;

        try {
            text = parseJsonText(input.Payload ?? "");
        } catch (error) {
            throw new InputError(
                `decode external input "${input.ID}": ${error instanceof Error ? error.message : String(error)}`
            );
        }

        if (typeof text !== "string") {
            throw new InputError(`decode external input "${input.ID}": payload is not a JSON string`);
        }

        this.stagedSuffix.push({ Type: "message", Data: { Role: "user", Text: text } });
    }

    setModel(model: Model): void {
        this.request.Model = { ...model };
    }

    addControlMessage(request: ControlMessage): void {
        switch (request.Mode) {
            case "settings":
                this.request.Model.ReasoningEffort = request.Parameters?.ReasoningEffort;
                break;
            case "heartbeat":
                this.stagedSuffix.push({ Type: "message", Data: { Role: "user", Text: request.Reason } });
                break;
            default:
                break;
        }
    }

    setSystemPrompt(prompt: string): void {
        this.systemPrompt = prompt;
        this.committedPrefix[0] = {
            Type: "message",
            Data: { Role: "system", Text: `${this.preamble}\n\n${this.systemPrompt}`.trim() },
        };
    }

    addModelResponse(response: Response): void {
        this.committedPrefix.push(...(response.Output ?? []));
    }

    addReasoning(reasoning: Reasoning): void {
        this.stagedSuffix.push({ Type: "reasoning", Data: reasoning });
    }

    addTool(tool: Tool): void {
        this.request.Tools.push(tool);
    }

    addToolResult(callID: string, payload: ToolResultOutput[], running: boolean): void {
        const output = running ? runningOutput() : payload;
        this.stagedSuffix = this.stagedSuffix.filter(
            (item) => !(item.Type === "tool_result" && item.Data.CallID === callID && isRunningOutput(item.Data.Output))
        );
        const result: ToolResult = { CallID: callID, Output: output };
        this.stagedSuffix.push({ Type: "tool_result", Data: result });
    }

    commit(): void {
        this.committedPrefix.push(...this.stagedSuffix);
        this.stagedSuffix = [];
    }

    build(): BuildResult {
        return {
            Request: {
                Model: { ...this.request.Model },
                Input: [...this.committedPrefix, ...this.stagedSuffix],
                Tools: [...this.request.Tools],
            },
            Report: { Changes: [] },
        };
    }
}

export function newBuilder(...skills: Skill[]): Builder {
    return new ContextBuilder(skills);
}
