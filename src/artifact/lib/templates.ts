import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { RUNTIME_DIR } from "./vite";

export type TemplateFile = "catalog.html" | "page.html" | "tsx.html";

const SHIPPED_TEMPLATES_DIR = join(RUNTIME_DIR, "templates");
const DEFAULT_TEMPLATE = "default";

/**
 * Resolve a template set: a shipped name under runtime/templates/<name>, or a
 * directory path carrying the same files. Missing files fall back to the
 * shipped default, so a custom template may override just one page.
 */
export function resolveTemplateDir(nameOrDir: string | undefined): string {
    // "graphite" is the default palette's real name — the shipped dir is "default".
    const requested = nameOrDir === "graphite" ? DEFAULT_TEMPLATE : nameOrDir;

    if (!requested) {
        return join(SHIPPED_TEMPLATES_DIR, DEFAULT_TEMPLATE);
    }

    const shipped = join(SHIPPED_TEMPLATES_DIR, requested);

    if (existsSync(shipped) && statSync(shipped).isDirectory()) {
        return shipped;
    }

    const asDir = resolve(requested);

    if (existsSync(asDir) && statSync(asDir).isDirectory()) {
        return asDir;
    }

    throw new Error(
        `Template "${nameOrDir}" is neither a shipped template (${listShippedTemplates().join(", ")}) nor a directory.`
    );
}

export function listShippedTemplates(): string[] {
    return readdirSync(SHIPPED_TEMPLATES_DIR).filter((n) => statSync(join(SHIPPED_TEMPLATES_DIR, n)).isDirectory());
}

export function loadTemplate(templateDir: string, file: TemplateFile): string {
    const custom = join(templateDir, file);

    if (existsSync(custom)) {
        return readFileSync(custom, "utf8");
    }

    return readFileSync(join(SHIPPED_TEMPLATES_DIR, DEFAULT_TEMPLATE, file), "utf8");
}

/** Absolute path of the active template's theme.css (falls back to the default's). */
export function themeCssPath(templateDir: string): string {
    const custom = join(templateDir, "theme.css");

    return existsSync(custom) ? custom : join(SHIPPED_TEMPLATES_DIR, DEFAULT_TEMPLATE, "theme.css");
}

/** The active template's token CSS (for inlining into chrome pages). */
export function loadThemeCss(templateDir: string): string {
    return readFileSync(themeCssPath(templateDir), "utf8");
}

export interface TemplateInfo {
    name: string;
    /** First comment line of theme.css — the one-line personality. */
    personality: string;
}

export function describeShippedTemplates(): TemplateInfo[] {
    return listShippedTemplates().map((name) => {
        const css = loadThemeCss(join(SHIPPED_TEMPLATES_DIR, name));
        const personality = css.match(/\/\*\s*([^\n]*?)\s*(?:\*\/|\n)/)?.[1] ?? "";

        return { name, personality };
    });
}

/** Fill {{KEY}} placeholders. Unknown placeholders are left intact. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
    return template.replace(/\{\{([A-Z_]+)\}\}/g, (full, key: string) => vars[key] ?? full);
}

/** HTML-escape text for element/attribute interpolation. */
export function escapeHtml(text: string): string {
    return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Percent-encode each path segment (spaces, #, ?) while keeping the slashes. */
export function encodeHrefPath(path: string): string {
    return path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}
