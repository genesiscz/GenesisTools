import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

export interface PageNode {
    uid: string;
    role: string;
    name: string;
    /** Indentation depth in the snapshot text; the root web area is 0. */
    depth: number;
    /** `value="…"` as the snapshot prints it (text fields, comboboxes, options). */
    value?: string;
    /** `url="…"` on links and on the root web area. */
    href?: string;
    disabled?: boolean;
    /**
     * A field that takes a secret. The accessibility snapshot never prints the DOM input type, so
     * this is the label reading `password`, plus an explicit `type="password"` attribute when a
     * caller supplies one (the JSON branch, or a future server build). A caller that needs
     * certainty asks the DOM through `evaluate_script`.
     */
    password?: boolean;
}

/**
 * `uid=1_5 button "Export report"` — the id, the role, an optional quoted accessible name, then
 * `key="value"` attributes and bare flags (`disabled`, `selected`, `expandable`).
 */
const NODE_RE = /^(\s*)(?:uid\s*[=:]\s*)?([A-Za-z0-9_-]+)\s+([A-Za-z][A-Za-z0-9_-]*)\s*(.*)$/;
const NAME_RE = /^"((?:[^"\\]|\\.)*)"\s*(.*)$/;
const ATTRIBUTE_RE = /([A-Za-z][A-Za-z0-9_-]*)\s*=\s*"((?:[^"\\]|\\.)*)"/g;
const PASSWORD_RE = /\b(password|passwd|passphrase|heslo)\b/i;

const FILLABLE_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "textarea"]);
const CLICKABLE_ROLES = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "tab",
    "switch",
    "treeitem",
]);

export function isFillableRole(role: string): boolean {
    return FILLABLE_ROLES.has(role.toLowerCase());
}

export function isClickableRole(role: string): boolean {
    return CLICKABLE_ROLES.has(role.toLowerCase());
}

function unquote(text: string): string {
    return text.replace(/\\(.)/g, "$1");
}

function readNode(line: string): PageNode | undefined {
    const match = NODE_RE.exec(line);
    if (!match) {
        return undefined;
    }

    const [, indent, uid, role, rest] = match;
    const named = NAME_RE.exec(rest);
    const name = named ? unquote(named[1]) : "";
    const attributeText = named ? named[2] : rest;
    const node: PageNode = { uid, role, name, depth: Math.floor(indent.length / 2) };
    ATTRIBUTE_RE.lastIndex = 0;
    let attribute = ATTRIBUTE_RE.exec(attributeText);
    while (attribute) {
        const key = attribute[1].toLowerCase();
        const value = unquote(attribute[2]);
        if (key === "url" || key === "href") {
            node.href = value;
        } else if (key === "value") {
            node.value = value;
        } else if (key === "type" && value.toLowerCase() === "password") {
            node.password = true;
        }

        attribute = ATTRIBUTE_RE.exec(attributeText);
    }

    if (/(^|\s)disabled(\s|$)/.test(attributeText)) {
        node.disabled = true;
    }

    if (isFillableRole(role) && PASSWORD_RE.test(name)) {
        node.password = true;
    }

    return node;
}

function readJsonNodes(text: string): PageNode[] | undefined {
    const trimmed = text.trim();
    if (!trimmed.startsWith("[") && !trimmed.startsWith("{")) {
        return undefined;
    }

    try {
        const parsed = SafeJSON.parse(trimmed) as unknown;
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const nodes: PageNode[] = [];
        for (const row of rows) {
            if (!row || typeof row !== "object") {
                continue;
            }

            const record = row as Record<string, unknown>;
            if (typeof record.uid !== "string") {
                continue;
            }

            const role = typeof record.role === "string" ? record.role : "generic";
            const name = typeof record.name === "string" ? record.name : "";
            const node: PageNode = {
                uid: record.uid,
                role,
                name,
                depth: typeof record.depth === "number" ? record.depth : 0,
            };
            if (typeof record.value === "string") {
                node.value = record.value;
            }

            const href = record.href ?? record.url;
            if (typeof href === "string") {
                node.href = href;
            }

            if (record.disabled === true) {
                node.disabled = true;
            }

            if (
                record.password === true ||
                record.type === "password" ||
                (isFillableRole(role) && PASSWORD_RE.test(name))
            ) {
                node.password = true;
            }

            nodes.push(node);
        }
        return nodes;
    } catch (error) {
        logger.debug({ error }, "page snapshot JSON did not parse; falling back to the text tree");
        return undefined;
    }
}

/**
 * Reads a chrome-devtools-mcp `take_snapshot` result into nodes. The wrapper headings the tool
 * prints around the tree (`## Latest page snapshot`, `## Page content`) are NOT nodes; an earlier
 * parser read one of them as the page heading and every run reported an empty title.
 */
export function parsePageSnapshot(text: string): PageNode[] {
    if (!text.trim()) {
        return [];
    }

    const fromJson = readJsonNodes(text);
    if (fromJson) {
        return fromJson;
    }

    const nodes: PageNode[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line.trim() || line.trimStart().startsWith("#")) {
            continue;
        }

        const node = readNode(line);
        if (node) {
            nodes.push(node);
        }
    }
    return nodes;
}

/** The page URL and title the snapshot's root web area carries, when it has one. */
export function snapshotPage(nodes: PageNode[]): { url?: string; title?: string } {
    const root = nodes.find((node) => node.role.toLowerCase() === "rootwebarea");
    return { url: root?.href, title: root?.name };
}
