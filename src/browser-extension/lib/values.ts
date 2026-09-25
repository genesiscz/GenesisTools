/**
 * Page values on their way into a command. Every value that came from a page is checked here
 * before it reaches an argv, and a `{name}` placeholder fills exactly one argv element.
 */
export class PageValueError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PageValueError";
    }
}

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
/** Printable text only: no control characters, newlines or NUL. */
const DEFAULT_VALUE = /^[^\p{Cc}]{1,200}$/u;
const BRANCH = /^(?!-)(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._/-]{1,200}(?<![./])$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function placeholders(template: string): string[] {
    return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

/**
 * A value from a page. Refused when empty, too long, carrying control characters, or starting
 * with `-` (it would read as an option to the program it is passed to). `pattern` is anchored.
 */
export function checkPageValue(name: string, value: unknown, pattern?: string): string {
    if (typeof value !== "string") {
        throw new PageValueError(`${name} is missing`);
    }

    const trimmed = value.trim();

    if (!DEFAULT_VALUE.test(trimmed)) {
        throw new PageValueError(`${name} must be 1 to 200 printable characters`);
    }

    if (trimmed.startsWith("-")) {
        throw new PageValueError(`${name} must not start with "-"`);
    }

    if (pattern && !new RegExp(`^(?:${pattern})$`, "u").test(trimmed)) {
        throw new PageValueError(`${name} does not match ${pattern}`);
    }

    return trimmed;
}

export function checkBranch(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") {
        return undefined;
    }

    if (typeof value !== "string" || !BRANCH.test(value)) {
        throw new PageValueError("branch is not a valid branch name");
    }

    return value;
}

export function checkLine(value: unknown): number | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 9_999_999) {
        throw new PageValueError("line must be a positive integer");
    }

    return value;
}

/** A repo-relative file path from a page: no absolute path, no `..`, no NUL, no backslash. */
export function checkRelativePath(value: unknown): string {
    if (typeof value !== "string" || value.length === 0 || value.length > 1000) {
        throw new PageValueError("path is missing or too long");
    }

    const segments = value.split("/");

    if (
        value.startsWith("/") ||
        value.includes("\\") ||
        /\p{Cc}/u.test(value) ||
        segments.some((segment) => segment === ".." || segment === "." || segment === "")
    ) {
        throw new PageValueError("path must be a plain repository-relative path");
    }

    return value;
}

function fill(template: string, values: Record<string, string>): string {
    return template.replace(PLACEHOLDER, (_whole, name: string) => {
        const value = values[name];

        if (value === undefined) {
            throw new PageValueError(`no value for {${name}}`);
        }

        return value;
    });
}

/** Fill an argv template. Each element stays one element, whatever the values contain. */
export function fillArgv(templates: readonly string[], values: Record<string, string>): string[] {
    return templates.map((template) => fill(template, values));
}

export function fillText(template: string, values: Record<string, string>): string {
    return fill(template, values);
}
