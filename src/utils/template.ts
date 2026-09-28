// `{{name}}` templates: the variables a text uses and the text with them filled in. The hub's saved
// prompts are the first user (`tools hub prompts`).

const VARIABLE = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

/** The variables a text uses, each once, in the order they first appear. */
export function promptVariables(text: string): string[] {
    const names: string[] = [];

    for (const match of text.matchAll(VARIABLE)) {
        if (!names.includes(match[1])) {
            names.push(match[1]);
        }
    }

    return names;
}

/** Fill every `{{name}}`; a variable without a value stays as written and is reported missing. */
export function renderPrompt(text: string, vars: Record<string, string>): { text: string; missing: string[] } {
    const missing: string[] = [];
    const rendered = text.replace(VARIABLE, (whole, name: string) => {
        const value = vars[name];

        if (value === undefined || value === "") {
            if (!missing.includes(name)) {
                missing.push(name);
            }

            return whole;
        }

        return value;
    });
    return { text: rendered, missing };
}
