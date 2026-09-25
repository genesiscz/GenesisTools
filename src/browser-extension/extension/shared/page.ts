import type { HostResponse } from "../../lib/host/messages";
import { THEME_CSS } from "./theme";

/** Theme + base layout for the extension's own pages (popup, options, route). */
export function mountPage(): void {
    const style = document.createElement("style");
    style.textContent = `${THEME_CSS}
body { margin: 0; background: var(--background); color: var(--foreground); }
main { padding: 14px 16px; display: grid; gap: 12px; }
section { display: grid; gap: 8px; padding: 12px; }
h1 { font-size: 15px; margin: 0; }
h2 { font-size: 13px; margin: 0; color: var(--muted-foreground); font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
textarea { width: 100%; min-height: 360px; box-sizing: border-box; background: var(--card); color: var(--foreground);
  border: 1px solid var(--border); border-radius: calc(var(--radius) - 4px); padding: 10px;
  font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
a { color: var(--accent); }
`;
    document.head.append(style);
}

/** One line of result text for a host reply. */
export function describe(reply: HostResponse, ok: (data: unknown) => string): { text: string; tone: string } {
    if (reply.ok) {
        return { text: ok(reply.data), tone: "gt-ok" };
    }

    return { text: reply.error, tone: reply.code === "unavailable" ? "gt-muted" : "gt-error" };
}

export function required<T extends HTMLElement>(selector: string): T {
    const node = document.querySelector<T>(selector);

    if (!node) {
        throw new Error(`missing ${selector}`);
    }

    return node;
}
