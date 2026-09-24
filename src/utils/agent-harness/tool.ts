import type { Tool, ToolCall, ToolResult } from "./llm";
import { boundOutput, DEFAULT_MAX_OUTPUT_LENGTH, type Operation, type OperationID, type Spec } from "./operation";

/**
 * Model-visible tool selection and the pure translation between a model tool call and
 * durable operations, ported from `harness/tool`.
 *
 * A translator runs synchronously on the coordinator's loop and performs no I/O: it
 * validates the call and submits operation specs through the turn-local `Context`.
 */

export interface CallStatus {
    Error: string;
    ErrorTruncated?: boolean;
    WaitingFor?: OperationID[];
}

export interface ToolContext {
    submit(spec: Spec): OperationID;
}

export interface ResultTranslator {
    translateResult(callID: string, status: CallStatus, operations: Operation[]): ToolResult;
}

export interface Translator extends ResultTranslator {
    translate(context: ToolContext, call: ToolCall): CallStatus;
}

export interface Definition {
    Tool: Tool;
    Metadata?: string;
}

export type RegistrationID = string;

export interface Skill {
    Name: string;
    Description: string;
    Path: string;
}

export interface Registry {
    staticDefinitions(): Definition[];
    resolve(name: string): Translator | undefined;
    registerSkill(skill: Skill): RegistrationID;
    unregisterSkill(id: RegistrationID): void;
    skills(): Skill[];
}

export function errorStatus(message: string, limit: number): CallStatus {
    const bound = limit <= 0 ? DEFAULT_MAX_OUTPUT_LENGTH : limit;
    const [text, truncated] = boundOutput(message, bound);
    return truncated ? { Error: text, ErrorTruncated: true } : { Error: text };
}

/** A registry over a fixed name→translator map, enough for the coordinator and its tests. */
export class MapRegistry implements Registry {
    private readonly skillList = new Map<RegistrationID, Skill>();
    private nextSkill = 0;

    constructor(
        private readonly translators: ReadonlyMap<string, Translator>,
        private readonly definitions: Definition[] = []
    ) {}

    staticDefinitions(): Definition[] {
        return [...this.definitions];
    }

    resolve(name: string): Translator | undefined {
        return this.translators.get(name);
    }

    registerSkill(skill: Skill): RegistrationID {
        const id = `skill-${this.nextSkill++}`;
        this.skillList.set(id, skill);
        return id;
    }

    unregisterSkill(id: RegistrationID): void {
        this.skillList.delete(id);
    }

    skills(): Skill[] {
        return [...this.skillList.values()];
    }
}
