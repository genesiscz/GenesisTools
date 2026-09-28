/**
 * The dark theme tokens of `src/utils/ui/theme/styles.css` (`:root`), as one CSS string for the
 * extension pages and the content script's shadow roots. There is no Tailwind or React here, so
 * the tokens are copied, not imported; keep the values in step with that file.
 *
 * The shadow host is `all: initial` so page CSS cannot reach in. That inline style also beats the
 * `:host` font below (custom properties survive `all`, fonts do not), so every top-level surface
 * sets `font: var(--gt-font)` itself; without it the page's UI falls back to the browser's serif.
 */
export const THEME_CSS = `
:host, :root {
  --background: oklch(0.06 0.01 280);
  --foreground: oklch(0.93 0.005 0);
  --card: oklch(0.08 0.01 280);
  --primary: oklch(0.78 0.19 75);
  --primary-foreground: oklch(0.08 0.01 280);
  --muted: oklch(0.25 0.02 280);
  --muted-foreground: oklch(0.65 0.01 280);
  --accent: oklch(0.68 0.17 195);
  --destructive: oklch(0.60 0.22 25);
  --border: oklch(0.20 0.02 280);
  --ring: oklch(0.78 0.19 75);
  --radius: 0.625rem;
  --gt-font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --gt-mono: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  --gt-glow: 0 0 0 1px oklch(0.78 0.19 75 / 0.35), 0 6px 18px oklch(0.78 0.19 75 / 0.18);
  font: var(--gt-font);
  color: var(--foreground);
}
.gt-surface {
  font: var(--gt-font);
  background: color-mix(in oklch, var(--card) 92%, transparent);
  border: 1px solid color-mix(in oklch, var(--primary) 35%, var(--border));
  border-radius: var(--radius);
  box-shadow: 0 8px 28px oklch(0 0 0 / 0.45), 0 0 0 1px oklch(0.78 0.19 75 / 0.08) inset;
  backdrop-filter: blur(16px);
  color: var(--foreground);
}
.gt-btn {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--muted);
  color: var(--foreground);
  border-radius: calc(var(--radius) - 4px);
  padding: 5px 10px;
  font: inherit;
  cursor: pointer;
  white-space: nowrap;
  transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease, color 0.15s ease;
}
.gt-btn:hover:not(:disabled) { border-color: var(--ring); transform: translateY(-1px); box-shadow: var(--gt-glow); }
.gt-btn:active:not(:disabled) { transform: translateY(0); box-shadow: none; }
.gt-btn:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
.gt-btn:disabled { opacity: 0.5; cursor: default; }
.gt-btn.primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
.gt-btn.ghost { background: transparent; border-color: transparent; color: var(--muted-foreground); padding: 5px 7px; }
.gt-btn.ghost:hover:not(:disabled) { color: var(--foreground); background: var(--muted); box-shadow: none; }
.gt-btn[aria-busy="true"] { cursor: progress; }
.gt-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.gt-spacer { flex: 1; }
.gt-muted { color: var(--muted-foreground); }
.gt-error { color: var(--destructive); }
.gt-ok { color: var(--accent); }
.gt-title { font-weight: 600; letter-spacing: 0.01em; }
.gt-title .mark, .gt-mark { color: var(--primary); font: 700 12px/1 var(--gt-mono); letter-spacing: 0.04em; text-shadow: 0 0 10px oklch(0.78 0.19 75 / 0.45); }
.gt-chip {
  display: inline-flex; align-items: center; gap: 6px;
  font: 600 10.5px/1 var(--gt-mono); text-transform: uppercase; letter-spacing: 0.08em;
  padding: 4px 8px; border-radius: 999px; border: 1px solid var(--border); color: var(--muted-foreground);
}
.gt-chip.ok { color: var(--accent); border-color: color-mix(in oklch, var(--accent) 45%, var(--border)); }
.gt-chip.err { color: var(--destructive); border-color: color-mix(in oklch, var(--destructive) 45%, var(--border)); }
.gt-chip.busy { color: var(--primary); border-color: color-mix(in oklch, var(--primary) 45%, var(--border)); }
.gt-dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; box-shadow: 0 0 8px currentColor; }
.gt-chip.busy .gt-dot { animation: gt-pulse 1s ease-in-out infinite; }
.gt-pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: 12px/1.5 var(--gt-mono); }
.gt-code { font: 12px var(--gt-mono); background: var(--muted); padding: 1px 5px; border-radius: 4px; word-break: break-all; }
.gt-kbd { font: 11px var(--gt-mono); border: 1px solid var(--border); border-bottom-width: 2px; border-radius: 4px; padding: 1px 5px; color: var(--muted-foreground); }
.gt-enter { animation: gt-in 0.18s ease-out; }
@keyframes gt-in { from { opacity: 0; transform: translateY(6px) scale(0.98); } to { opacity: 1; transform: none; } }
@keyframes gt-pulse { 50% { opacity: 0.35; } }
@media (prefers-reduced-motion: reduce) {
  .gt-enter, .gt-chip.busy .gt-dot { animation: none; }
  .gt-btn { transition: none; }
  .gt-btn:hover:not(:disabled) { transform: none; }
}
`;

/** A closed shadow root under a fixed host element, so page CSS cannot reach the extension's UI. */
export function shadowMount(id: string): ShadowRoot {
    const host = document.createElement("div");
    host.id = id;
    host.style.all = "initial";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = THEME_CSS;
    root.append(style);
    document.documentElement.append(host);
    return root;
}

export function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: { className?: string; text?: string; title?: string } = {},
    children: Node[] = []
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);

    if (props.className) {
        node.className = props.className;
    }

    if (props.text !== undefined) {
        node.textContent = props.text;
    }

    if (props.title) {
        node.title = props.title;
    }

    node.append(...children);
    return node;
}

/** A status chip: a glowing dot and a short uppercase label. */
export function chip(label: string, tone: "ok" | "err" | "busy" | "idle"): HTMLSpanElement {
    return el("span", { className: tone === "idle" ? "gt-chip" : `gt-chip ${tone}` }, [
        el("span", { className: "gt-dot" }),
        document.createTextNode(label),
    ]);
}
