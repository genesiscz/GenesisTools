import { z } from "zod";

export const customTemplateSchema = z.object({
    id: z.string().min(1).max(64),
    type: z.enum(["boolean", "choice", "score"]),
    instructions: z.string().min(1).max(4000),
    criteria: z.unknown().optional(),
    gate: z.number().min(0).max(1).optional(),
});
export type CustomTemplate = z.infer<typeof customTemplateSchema>;

export function mergeTemplates(builtins: readonly string[], custom: CustomTemplate[]): CustomTemplate[] {
    const seen = new Set(builtins);
    for (const template of custom) {
        if (seen.has(template.id)) {
            throw new Error(`Custom template name collides with builtin: ${template.id}`);
        }
        seen.add(template.id);
    }
    return custom;
}

export function toSarif(options: {
    document: Record<string, number | undefined>;
    gate: { block: boolean; reasons: string[] };
    uri: string;
}) {
    const results = options.gate.reasons.map((reason) => ({
        ruleId: reason,
        level: "error" as const,
        message: { text: `verify gate: ${reason}` },
        locations: [{ physicalLocation: { artifactLocation: { uri: options.uri } } }],
        properties: { probability: options.document[reason] },
    }));
    return {
        version: "2.1.0",
        $schema: "https://json.schemastore.org/sarif-2.1.0.json",
        runs: [
            {
                tool: { driver: { name: "tools-jev-verify", rules: results.map((result) => ({ id: result.ruleId })) } },
                results,
            },
        ],
    };
}

export function listFiles(paths: string[], maxFiles: number): { files: string[]; remainder: number } {
    if (paths.length > maxFiles) {
        return { files: paths.slice(0, maxFiles), remainder: paths.length - maxFiles };
    }
    return { files: paths, remainder: 0 };
}
