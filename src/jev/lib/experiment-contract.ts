import { z } from "zod";

export const experimentRequestSchema = z
    .object({
        language: z.string().trim().min(1).default("typescript"),
        mode: z.enum(["grammar", "characters"]).default("grammar"),
        goal: z.string().trim().min(1).max(4000),
        literals: z
            .array(
                z
                    .string()
                    .max(120)
                    .regex(/^[\x20-\x7e\n\t]*$/)
            )
            .max(16)
            .default(["Hello, World!"]),
        tokens: z.array(z.string().max(300)).max(2048).default([]),
        maxSteps: z.number().int().min(1).max(2048).default(80),
        stdin: z.string().max(4096).default(""),
        zeroDataRetention: z.boolean().default(false),
    })
    .strict();

export type ExperimentRequest = z.infer<typeof experimentRequestSchema>;
export interface ProgramState {
    source: string;
    tokens: string[];
    candidates: string[];
    slot: string;
    complete: boolean;
}

export interface ExperimentLanguage {
    readonly id: string;
    readonly name: string;
    readonly fileExtension: string;
    readonly generationInstructions?: string;
    state(request: ExperimentRequest): ProgramState;
}
