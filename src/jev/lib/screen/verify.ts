import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { SafeJSON } from "@genesiscz/utils/json";
import { z } from "zod";
import { parsePurpose, type ScreenPurpose } from "./templates";

export interface Claim {
    id: string;
    text: string;
}

export interface ClaimScore {
    id: string;
    supported: number;
    contradicted: number;
    sensitive: number;
}

const claimSchema = z.object({ id: z.string().min(1), text: z.string().min(1) }).strict();

export function parseClaims(input: string): Claim[] {
    const trimmed = input.trim();
    if (!trimmed) {
        throw new Error("Claims input is empty.");
    }

    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
        const parsed = trimmed.startsWith("[") ? SafeJSON.parse(trimmed) : [SafeJSON.parse(trimmed)];
        return z.array(claimSchema).parse(parsed);
    }

    return trimmed
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .filter((line) => !line.startsWith("#"))
        .map((line, index) => ({ id: `c${index}`, text: line.replace(/^[-*]\s+/, "") }));
}

export async function verifyClaims(options: {
    claims: Claim[];
    against: string;
    purpose?: string;
    evaluate: Evaluator;
    signal?: AbortSignal;
}): Promise<{ purpose: ScreenPurpose | "claims"; scores: ClaimScore[] }> {
    const purpose = options.purpose ? parsePurpose(options.purpose) : "claims";
    const evaluation = await options.evaluate({
        input: {
            state: {
                purpose,
                against: options.against.slice(0, 12000),
                claims: options.claims,
            },
            questions: Object.fromEntries(
                options.claims.flatMap((claim) => [
                    [
                        `${claim.id}_supported`,
                        { type: "boolean", instructions: `Is this claim supported by the against-set? ${claim.text}` },
                    ],
                    [
                        `${claim.id}_contradicted`,
                        {
                            type: "boolean",
                            instructions: `Is this claim contradicted by the against-set? ${claim.text}`,
                        },
                    ],
                    [
                        `${claim.id}_sensitive`,
                        {
                            type: "boolean",
                            instructions: `Does this claim include names, secrets, or other sensitive stuff? ${claim.text}`,
                        },
                    ],
                ])
            ),
        },
        signal: options.signal,
    });
    return {
        purpose: purpose === "claims" ? "claims" : purpose,
        scores: options.claims.map((claim) => {
            const read = (suffix: string) => {
                const answer = evaluation.answers[`${claim.id}_${suffix}`];
                return answer?.type === "boolean" ? answer.probability : 0;
            };
            return {
                id: claim.id,
                supported: read("supported"),
                contradicted: read("contradicted"),
                sensitive: read("sensitive"),
            };
        }),
    };
}
