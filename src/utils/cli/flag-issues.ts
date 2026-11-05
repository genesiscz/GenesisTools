import type { z } from "zod";

/**
 * A command that validates its flags with the schema another door (a REPL toolset, an RPC) already takes: the
 * schema's refusal, one line per problem, each under the flag that set the field (`--ocr-min-chars: Too big: …`).
 * `flags` maps a field path (`ocr.minChars`, or its first key `ocr`) to the flag; an unmapped path is printed as is.
 */
export function flagIssues(error: z.ZodError, flags: Readonly<Record<string, string>>): string {
    return error.issues
        .map((issue) => {
            const path = issue.path.map(String).join(".");
            const flag = flags[path] ?? flags[String(issue.path[0] ?? "")] ?? (path || "options");
            return `${flag}: ${issue.message}`;
        })
        .join("\n");
}

/** `schema.parse(input)`, or one Error whose lines name the flags (`flagIssues`). */
export function parseFlags<S extends z.ZodType>(
    schema: S,
    input: unknown,
    flags: Readonly<Record<string, string>>
): z.infer<S> {
    const parsed = schema.safeParse(input);

    if (!parsed.success) {
        throw new Error(flagIssues(parsed.error, flags));
    }

    return parsed.data;
}
