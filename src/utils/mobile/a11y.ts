/**
 * The XCUITest accessibility tree (WDA's `/source` XML) as plain data: the nodes with their type, testID, label, value
 * and frame, an indented text dump a person or an agent can read, and a summary of what the screen shows. A React
 * Native `testID` arrives as the element's `name`.
 */

export interface A11yRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface A11yNode {
    /** The element type without the `XCUIElementType` prefix: `Button`, `StaticText`, `Other`. */
    type: string;
    name: string;
    label: string;
    value: string;
    enabled: boolean;
    visible: boolean;
    rect: A11yRect;
    depth: number;
    children: A11yNode[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
        if (entity.startsWith("#x") || entity.startsWith("#X")) {
            return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        }

        if (entity.startsWith("#")) {
            return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        }

        return ENTITIES[entity] ?? whole;
    });
}

function attributes(text: string): Record<string, string> {
    const found: Record<string, string> = {};
    for (const match of text.matchAll(/([\w:-]+)="([^"]*)"/g)) {
        found[match[1]] = decode(match[2]);
    }

    return found;
}

/** Parses WDA's XML page source. Tags other than `XCUIElementType*` (the `AppiumAUT` wrapper) are skipped. */
export function parseSource(xml: string): A11yNode[] {
    const roots: A11yNode[] = [];
    const stack: A11yNode[] = [];

    for (const match of xml.matchAll(/<(\/?)XCUIElementType(\w+)\b([^>]*?)(\/?)>/g)) {
        const [, closing, type, rest, selfClosing] = match;

        if (closing) {
            stack.pop();
            continue;
        }

        const attrs = attributes(rest);
        const node: A11yNode = {
            type,
            name: attrs.name ?? "",
            label: attrs.label ?? "",
            value: attrs.value ?? "",
            enabled: attrs.enabled !== "false",
            visible: attrs.visible !== "false",
            rect: {
                x: Number(attrs.x ?? 0),
                y: Number(attrs.y ?? 0),
                width: Number(attrs.width ?? 0),
                height: Number(attrs.height ?? 0),
            },
            depth: stack.length,
            children: [],
        };
        const parent = stack.at(-1);
        parent ? parent.children.push(node) : roots.push(node);

        if (!selfClosing) {
            stack.push(node);
        }
    }

    return roots;
}

export function flatten(nodes: A11yNode[]): A11yNode[] {
    return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** A testID shape: lower-case words joined by dashes (`screen-agents`, `agent-row-claude:abc`). */
const TEST_ID = /^[a-z][a-z0-9]*(-[a-zA-Z0-9:._]+)+$/;

export function isTestId(name: string): boolean {
    return TEST_ID.test(name);
}

const TAPPABLE = new Set(["Button", "Link", "Cell", "Switch", "TextField", "SecureTextField", "SearchField", "Tab"]);

/** The words an element shows: its label, else its value, else a name that is not a testID. */
export function copyOf(node: A11yNode): string {
    for (const text of [node.label, node.value, node.name]) {
        if (text && !isTestId(text)) {
            return text;
        }
    }

    return "";
}

/**
 * One line per element that says something (a testID, words, or a tap target), indented by depth. Anonymous
 * containers are folded into the next line's depth, so a deep React Native tree stays readable.
 */
export function formatTree(nodes: A11yNode[], options: { visibleOnly?: boolean } = {}): string {
    const lines: string[] = [];
    const walk = (node: A11yNode, depth: number) => {
        if (options.visibleOnly && !node.visible) {
            return;
        }

        const id = isTestId(node.name) ? node.name : "";
        const copy = copyOf(node);
        const says = id || copy || TAPPABLE.has(node.type);

        if (says) {
            const parts = [node.type];

            if (copy) {
                parts.push(quoteCopy(copy));
            }

            if (id) {
                parts.push(`#${id}`);
            }

            if (!node.enabled) {
                parts.push("(disabled)");
            }

            if (!node.visible) {
                parts.push("(hidden)");
            }

            const { x, y, width, height } = node.rect;
            parts.push(`[${x},${y} ${width}x${height}]`);
            lines.push(`${"  ".repeat(depth)}${parts.join(" ")}`);
        }

        for (const child of node.children) {
            walk(child, says ? depth + 1 : depth);
        }
    };

    for (const root of nodes) {
        walk(root, 0);
    }

    return lines.join("\n");
}

function quoteCopy(text: string): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return `"${flat.length > 120 ? `${flat.slice(0, 117)}...` : flat}"`;
}

export interface ScreenSummary {
    /** Every testID in the tree, in tree order, once each. */
    testIds: string[];
    /** The visible words, once each, in tree order. */
    texts: string[];
    /** The visible tap targets. */
    buttons: Array<{ label: string; id: string }>;
    /** The text of an open alert (a system alert or the app's own `Alert.alert`). */
    alerts: string[];
    elements: number;
}

export function summarize(nodes: A11yNode[]): ScreenSummary {
    const all = flatten(nodes);
    const unique = (values: string[]) => [...new Set(values.filter(Boolean))];
    // XCUITest reports a React Native text twice (the Text and its parent), so the words are deduped.
    const texts = unique(
        all.filter((node) => node.visible && node.type === "StaticText").map((node) => copyOf(node).trim())
    );

    return {
        testIds: unique(all.map((node) => (isTestId(node.name) ? node.name : ""))),
        texts,
        buttons: all
            .filter((node) => node.visible && TAPPABLE.has(node.type))
            .map((node) => ({ label: copyOf(node), id: isTestId(node.name) ? node.name : "" })),
        alerts: all
            .filter((node) => node.type === "Alert")
            .map((node) =>
                flatten(node.children)
                    .filter((child) => child.type === "StaticText")
                    .map(copyOf)
                    .filter(Boolean)
                    .join(" / ")
            ),
        elements: all.length,
    };
}

export function findById(nodes: A11yNode[], id: string): A11yNode | undefined {
    return flatten(nodes).find((node) => node.name === id);
}

export function center(rect: A11yRect): { x: number; y: number } {
    return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

/**
 * React Native's LogBox as it reads in the tree. Collapsed it is one toast whose name starts with the count
 * (`1, <message>`). Expanded it shows `Log N of M`, a heading (`Console Error`, `Render Error`, …), the message,
 * and `Dismiss` / `Minimize` buttons; the app's screen under the overlay stays in the tree, so the entry is the text
 * between the counter and the Dismiss row.
 */
export interface LogBoxView {
    state: "none" | "collapsed" | "expanded";
    /** The collapsed toast, to tap it open. */
    toast?: A11yNode;
    index?: number;
    total?: number;
    heading?: string;
    message: string[];
    /** The y of the counter row, where the unnamed back and forward arrows sit. */
    headerY?: number;
    dismiss?: A11yNode;
    minimize?: A11yNode;
}

const LOGBOX_HEADINGS = /^(Console Error|Console Warning|Render Error|Uncaught Error|Syntax Error|Warning|Error)$/;

export function readLogBox(nodes: A11yNode[]): LogBoxView {
    const all = flatten(nodes).filter((node) => node.visible);
    const counter = all.find((node) => /^Log \d+ of \d+$/.test(copyOf(node)));

    if (!counter) {
        const toast = all.find((node) => /^\d+, \S/.test(node.name) || /^\d+, \S/.test(node.label));
        return toast
            ? { state: "collapsed", toast, message: [copyOf(toast).replace(/^\d+, /, "")] }
            : { state: "none", message: [] };
    }

    const [, index, total] = copyOf(counter).match(/^Log (\d+) of (\d+)$/) ?? [];
    const dismiss = all.find((node) => copyOf(node) === "Dismiss");
    const minimize = all.find((node) => copyOf(node) === "Minimize");
    const top = counter.rect.y;
    const bottom = dismiss?.rect.y ?? Number.POSITIVE_INFINITY;
    const seen = new Set<string>();
    const body = all
        .filter((node) => node.type === "StaticText" && node.rect.y > top && node.rect.y < bottom)
        .sort((a, b) => a.rect.y - b.rect.y)
        .map((node) => copyOf(node).replace(/^‎/, "").replace(/\t/g, "  "))
        .filter((text) => {
            const keep = text && !seen.has(text) && !/^(Source|Call Stack|See More|See \d+ more frames)$/.test(text);
            seen.add(text);
            return keep;
        });
    const heading = body.find((text) => LOGBOX_HEADINGS.test(text));

    return {
        state: "expanded",
        index: Number(index),
        total: Number(total),
        heading,
        message: body.filter((text) => text !== heading),
        headerY: counter.rect.y + Math.round(counter.rect.height / 2),
        dismiss,
        minimize,
    };
}
