import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";
import { PURPOSE_ALIASES, type PurposeTemplate, templateById } from "./templates";

/**
 * User templates from `--custom <file>`. Each one becomes a single-question document template
 * whose question id is `answer`, so its key is `<id>__answer` like every builtin key.
 *
 * A custom id that collides with a builtin (or with another custom entry) throws instead of
 * silently shadowing it: a shadowed `secrets` template would change what the gate blocks on.
 */
export const customTemplateSchema = z
    .object({
        id: z
            .string()
            .min(1)
            .max(64)
            .regex(/^[a-z0-9][a-z0-9-]*$/, "Custom template ids are lowercase letters, digits and dashes."),
        summary: z.string().max(200).optional(),
        type: z.enum(["boolean", "score"]),
        instructions: z.string().min(1).max(4000),
        criteria: z.array(z.string().min(1)).min(2).optional(),
        gate: z.number().min(0).max(10).optional(),
    })
    .strict();

export type CustomTemplate = z.infer<typeof customTemplateSchema>;

export const CUSTOM_QUESTION_ID = "answer";

export function parseCustomTemplates(text: string): CustomTemplate[] {
    const parsed = SafeJSON.parse(text);
    const templates = z.array(customTemplateSchema).min(1).max(40).parse(parsed);
    for (const template of templates) {
        if (template.type === "score" && !template.criteria) {
            throw new Error(`Custom template '${template.id}' is a score question and needs at least two criteria.`);
        }
    }

    assertNoCollisions(templates);
    logger.debug({ count: templates.length, ids: templates.map((t) => t.id) }, "Loaded custom verify templates");
    return templates;
}

function assertNoCollisions(templates: CustomTemplate[]): void {
    const seen = new Set<string>();
    for (const template of templates) {
        if (templateById(template.id) || PURPOSE_ALIASES[template.id]) {
            throw new Error(`Custom template id '${template.id}' collides with a builtin template.`);
        }

        if (seen.has(template.id)) {
            throw new Error(`Custom template id '${template.id}' appears twice in the custom file.`);
        }

        seen.add(template.id);
    }
}

export function customAsTemplate(template: CustomTemplate): PurposeTemplate {
    return {
        id: template.id,
        summary: template.summary ?? template.instructions.slice(0, 120),
        scope: "document",
        questions: [
            {
                id: CUSTOM_QUESTION_ID,
                type: template.type,
                instructions: template.instructions,
                criteria: template.criteria,
            },
        ],
    };
}
