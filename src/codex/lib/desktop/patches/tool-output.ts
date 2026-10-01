import { SafeJSON } from "@genesiscz/utils/json";

import type { DesktopPatch } from "../types";

export const TOOL_OUTPUT_PRESETS = ["default", "16rem", "24rem", "40rem", "70vh", "full"] as const;

const TOOL_OUTPUT_SELECTORS = [
    "html.gt-tool-output-sized .vertical-scroll-fade-mask.max-h-36",
    "html.gt-tool-output-sized .vertical-scroll-fade-mask.max-h-56",
    "html.gt-tool-output-sized .vertical-scroll-fade-mask.max-h-40",
    'html.gt-tool-output-sized .vertical-scroll-fade-mask[style*="max-height"]',
    "html.gt-tool-output-sized .max-h-96.min-h-0.flex-1.overflow-y-auto",
    "html.gt-tool-output-sized .max-h-25",
    "html.gt-tool-output-sized .max-h-60",
    "html.gt-tool-output-sized .text-size-chat.max-h-48.overflow-auto",
    "html.gt-tool-output-sized .max-h-48.overflow-y-auto.p-2",
    "html.gt-tool-output-sized .max-h-48.overflow-auto",
    "html.gt-tool-output-sized .max-h-48.rounded-md",
];

function toolOutputLabel(value: string): string {
    if (value === "default") {
        return "App default";
    }

    if (value === "full") {
        return "Full height";
    }

    return value;
}

/** Selectors follow the Codex desktop Tailwind classes targeted by BJDubb/codex-full-output. */
export function toolOutputCss(): string {
    return `${TOOL_OUTPUT_SELECTORS.join(",\n")} {
  max-height: var(--gt-tool-output-max-height) !important;
}

html.gt-full-shell-command .group\\/command .line-clamp-2 {
  display: block !important;
  overflow: visible !important;
  -webkit-box-orient: initial !important;
  -webkit-line-clamp: unset !important;
}
`;
}

const SCRIPT_BODY = `
const outputKey = "genesis.codex.toolOutput";
const commandKey = "genesis.codex.shellCommands";
const expandKey = "genesis.codex.autoExpand";

const toolOutput = () => localStorage.getItem(outputKey) || "default";
const commands = () => localStorage.getItem(commandKey) || "clamp";
const autoExpand = () => localStorage.getItem(expandKey) || "fold";

const cssHeight = (value) => (value === "full" ? "none" : value);

function collapsedGroup(node) {
  const label = node.getAttribute("aria-label") || "";
  if (label.indexOf("Open ") === 0) {
    return false;
  }
  return !node.querySelector(".lucide-chevron-down, [data-d-component='icon'][name='chevron-down']");
}

function expandGroups() {
  if (autoExpand() !== "expand") {
    return;
  }
  const nodes = document.querySelectorAll(
    'button[data-d-component="pressable"][data-d-direction="row"][aria-label]',
  );
  for (const node of nodes) {
    if (node.dataset.gtAutoExpanded === "1" || !collapsedGroup(node)) {
      continue;
    }
    node.dataset.gtAutoExpanded = "1";
    node.click();
  }
}

const apply = () => {
  const height = toolOutput();
  const root = document.documentElement;
  if (height === "default") {
    root.classList.remove("gt-tool-output-sized");
    root.style.removeProperty("--gt-tool-output-max-height");
  } else {
    root.classList.add("gt-tool-output-sized");
    root.style.setProperty("--gt-tool-output-max-height", cssHeight(height));
  }
  root.classList.toggle("gt-full-shell-command", commands() === "full");
  expandGroups();
};

function findPreferencesSurface() {
  let element = document.querySelector('[role="switch"][aria-label="Use pointer cursors"]');
  while (element) {
    if (
      element.classList &&
      element.classList.contains("rounded-2xl") &&
      element.classList.contains("overflow-hidden")
    ) {
      return element;
    }
    element = element.parentElement;
  }
  return null;
}

function appendText(parent, className, text) {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = text;
  parent.append(node);
  return node;
}

function createOutputRow() {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between px-4 gap-6 py-3 gt-desktop-patch-row";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-0.5";
  appendText(copy, "min-w-0 text-token-text-primary text-sm font-medium", "Tool output height");
  appendText(
    copy,
    "min-w-0 text-xs leading-4 text-token-text-secondary",
    "How tall tool and terminal output can grow before it scrolls",
  );
  const select = document.createElement("select");
  select.className = "text-sm bg-transparent text-token-text-primary";
  select.setAttribute("aria-label", "Tool output height");
  for (const choice of config.choices) {
    const option = document.createElement("option");
    option.value = choice.value;
    option.textContent = choice.label;
    select.append(option);
  }
  select.value = toolOutput();
  select.addEventListener("change", () => {
    localStorage.setItem(outputKey, select.value);
    apply();
  });
  row.append(copy, select);
  return row;
}

function createCommandRow() {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between px-4 gap-6 py-3 gt-desktop-patch-row";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-0.5";
  appendText(copy, "min-w-0 text-token-text-primary text-sm font-medium", "Show full shell commands");
  appendText(
    copy,
    "min-w-0 text-xs leading-4 text-token-text-secondary",
    "Wrap complete shell commands instead of clamping them to two lines",
  );
  const button = document.createElement("button");
  button.type = "button";
  button.role = "switch";
  button.setAttribute("aria-label", "Show full shell commands");
  button.className = "inline-flex items-center text-sm cursor-interaction";
  const paint = () => {
    const on = commands() === "full";
    button.setAttribute("aria-checked", String(on));
    button.textContent = on ? "On" : "Off";
  };
  button.addEventListener("click", () => {
    localStorage.setItem(commandKey, commands() === "full" ? "clamp" : "full");
    paint();
    apply();
  });
  paint();
  row.append(copy, button);
  return row;
}

function createExpandRow() {
  const row = document.createElement("div");
  row.className = "flex items-center justify-between px-4 gap-6 py-3 gt-desktop-patch-row";
  const copy = document.createElement("div");
  copy.className = "flex min-w-0 flex-col gap-0.5";
  appendText(copy, "min-w-0 text-token-text-primary text-sm font-medium", "Auto-expand grouped tool calls");
  appendText(
    copy,
    "min-w-0 text-xs leading-4 text-token-text-secondary",
    "Open a folded row of nearby tool calls instead of leaving it as a one-line summary",
  );
  const button = document.createElement("button");
  button.type = "button";
  button.role = "switch";
  button.setAttribute("aria-label", "Auto-expand grouped tool calls");
  button.className = "inline-flex items-center text-sm cursor-interaction";
  const paint = () => {
    const on = autoExpand() === "expand";
    button.setAttribute("aria-checked", String(on));
    button.textContent = on ? "On" : "Off";
  };
  button.addEventListener("click", () => {
    const next = autoExpand() === "expand" ? "fold" : "expand";
    localStorage.setItem(expandKey, next);
    if (next === "expand") {
      for (const node of document.querySelectorAll("[data-gt-auto-expanded]")) {
        delete node.dataset.gtAutoExpanded;
      }
    }
    paint();
    apply();
  });
  paint();
  row.append(copy, button);
  return row;
}

function injectSettings() {
  const surface = findPreferencesSurface();
  if (!surface || surface.querySelector(".gt-desktop-patch-row")) {
    return;
  }
  surface.append(createOutputRow(), createCommandRow(), createExpandRow());
}

apply();
let scheduled = false;
new MutationObserver(() => {
  if (scheduled) {
    return;
  }
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    injectSettings();
    expandGroups();
  });
}).observe(document.documentElement, { childList: true, subtree: true });
window.addEventListener("storage", apply);
`;

export function toolOutputScript(): string {
    const config = {
        choices: TOOL_OUTPUT_PRESETS.map((value) => ({ value, label: toolOutputLabel(value) })),
    };

    return `(() => {\nconst config = ${SafeJSON.stringify(config)};\n${SCRIPT_BODY}})();\n`;
}

export const toolOutputPatch: DesktopPatch = {
    id: "tool-outputs",
    description: "Tool output height, full shell commands, and grouped tool calls, chosen in the app's Settings",
    needles: ["vertical-scroll-fade-mask", "line-clamp-2"],
    render() {
        return {
            css: toolOutputCss(),
            script: toolOutputScript(),
        };
    },
};
