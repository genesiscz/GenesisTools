// src/automate/lib/schema.ts

import { z } from "zod";

export const presetVariableSchema = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  required: z.boolean().optional(),
});

export const presetStepSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]+$/, "Step ID must be alphanumeric with hyphens/underscores"),
  name: z.string(),
  action: z.string(),
  params: z.record(z.unknown()).optional(),
  output: z.string().optional(),
  onError: z.enum(["stop", "continue", "skip"]).optional(),
  interactive: z.boolean().optional(),
  condition: z.string().optional(),
  then: z.string().optional(),
  else: z.string().optional(),
});

export const presetSchema = z.object({
  $schema: z.string(),
  name: z.string().min(1, "Preset name is required"),
  description: z.string().optional(),
  trigger: z.object({
    type: z.literal("manual"),
  }),
  vars: z.record(presetVariableSchema).optional(),
  steps: z.array(presetStepSchema).min(1, "At least one step is required"),
});

/** Inferred TypeScript type from the Zod schema */
export type ValidatedPreset = z.infer<typeof presetSchema>;

/** Validate a preset and return typed result or throw with clear Zod errors */
export function validatePreset(data: unknown): ValidatedPreset {
  return presetSchema.parse(data);
}

/** Validate that step IDs are unique and conditional jump references point to existing steps */
export function validateStepGraph(steps: z.infer<typeof presetStepSchema>[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();

  for (const step of steps) {
    if (ids.has(step.id)) {
      errors.push(`Duplicate step ID: "${step.id}"`);
    }
    ids.add(step.id);
  }

  for (const step of steps) {
    if (step.action === "if") {
      if (step.then && !ids.has(step.then)) {
        errors.push(`Step "${step.id}": "then" references unknown step "${step.then}"`);
      }
      if (step.else && !ids.has(step.else)) {
        errors.push(`Step "${step.id}": "else" references unknown step "${step.else}"`);
      }
    }
  }

  return errors;
}
