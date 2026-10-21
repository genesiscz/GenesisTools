import type { HostResponse } from "../../lib/host/messages";
import { THEME_CSS } from "./theme";

/** Theme + base layout for the extension's own pages (popup, options, route). */
export function mountPage(): void {
    const style = document.createElement("style");
    style.textContent = `${THEME_CSS}
[hidden] { display: none !important; }
body { margin: 0; background: var(--background); color: var(--foreground); }
main { padding: 14px 16px; display: grid; gap: 12px; }
section { display: grid; gap: 8px; padding: 12px; }
section.gt-surface {
  --wa1: 245, 158, 11; --wa2: 251, 191, 36; --wa3: 6, 182, 212;
  position: relative; border: 1px solid transparent; backdrop-filter: none;
  background-image:
    linear-gradient(135deg, oklch(0.11 0.01 280) 0%, oklch(0.07 0.01 280) 100%),
    linear-gradient(135deg, rgba(var(--wa1), 0.4), rgba(var(--wa2), 0.2), rgba(var(--wa3), 0.2));
  background-origin: border-box; background-clip: padding-box, border-box;
  box-shadow: 0 10px 28px -14px rgba(var(--wa1), 0.22);
  transition: box-shadow 0.4s ease;
}
section.gt-surface::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit; padding: 1px; pointer-events: none;
  background: linear-gradient(135deg, rgb(var(--wa1)), rgb(var(--wa2)), rgb(var(--wa3)));
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor; mask-composite: exclude;
  opacity: 0; transition: opacity 0.4s ease;
}
section.gt-surface:hover::before { opacity: 1; }
section.gt-surface:hover { box-shadow: 0 18px 36px -12px rgba(var(--wa1), 0.3); }
@media (prefers-reduced-motion: reduce) { section.gt-surface, section.gt-surface::before { transition: none; } }
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
