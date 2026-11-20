import { z } from "zod";

/** Any JSON value, as `JSON.parse` returns it. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * A Zod schema of any JSON value, with the same checks as `z.json()` (a finite number, no undefined, plain objects).
 * Use it instead of `z.json()`: tsc-rs 0.8 reports a false TS5115 ("infinitely circular") when it infers the recursive
 * type of `z.json()`, and this schema names its type, so tsc-rs never infers it.
 */
export const jsonValueSchema: z.ZodType<JsonValue, JsonValue> = z.lazy(() =>
    z.union([
        z.string(),
        z.number(),
        z.boolean(),
        z.null(),
        z.array(jsonValueSchema),
        z.record(z.string(), jsonValueSchema),
    ])
);
