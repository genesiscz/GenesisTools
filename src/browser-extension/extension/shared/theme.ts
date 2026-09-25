/**
 * The dark theme tokens of `src/utils/ui/theme/styles.css` (`:root`), as one CSS string for the
 * extension pages and the content script's shadow roots. There is no Tailwind or React here, so
 * the tokens are copied, not imported; keep the values in step with that file.
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
  font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--foreground);
}
.gt-surface {
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
}
.gt-btn:hover { border-color: var(--ring); }
.gt-btn:disabled { opacity: 0.5; cursor: default; }
.gt-btn.primary { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); font-weight: 600; }
.gt-row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.gt-muted { color: var(--muted-foreground); }
.gt-error { color: var(--destructive); }
.gt-ok { color: var(--accent); }
.gt-title { font-weight: 600; letter-spacing: 0.01em; }
.gt-title .mark { color: var(--primary); }
.gt-pre { white-space: pre-wrap; word-break: break-word; margin: 0; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
.gt-code { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--muted); padding: 1px 5px; border-radius: 4px; }
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
