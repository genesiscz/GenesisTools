import type { HostResponse } from "../lib/host/messages";
import { parseForgeUrl } from "../lib/page-url";
import { ext } from "./chrome";
import { callHost, isRecord } from "./shared/bridge";
import { describe, mountPage, required } from "./shared/page";

interface PopupField {
    selector: string;
    property?: string;
}

interface PopupAction {
    id: string;
    label: string;
    match: string;
    fields: Record<string, PopupField>;
}

/** Runs in the page (via activeTab + scripting): reads each field with its selector. */
function readFields(fields: Record<string, PopupField>): Record<string, string> {
    const values: Record<string, string> = {};

    for (const [name, spec] of Object.entries(fields)) {
        const node = document.querySelector(spec.selector);
        const property = spec.property ?? "textContent";

        if (!node) {
            continue;
        }

        if (property === "value") {
            values[name] = node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement ? node.value : "";
        } else if (property.startsWith("attr:")) {
            values[name] = node.getAttribute(property.slice(5)) ?? "";
        } else {
            values[name] = node.textContent ?? "";
        }
    }

    return values;
}

function actionsFrom(data: unknown): { actions: PopupAction[]; gitlabHosts: string[] } {
    const config = isRecord(data) && isRecord(data.config) ? data.config : {};
    const gitlabHosts = Array.isArray(config.gitlabHosts)
        ? config.gitlabHosts.filter((host): host is string => typeof host === "string")
        : [];
    const actions = (Array.isArray(config.actions) ? config.actions : []).flatMap((raw): PopupAction[] => {
        if (
            !isRecord(raw) ||
            typeof raw.id !== "string" ||
            typeof raw.label !== "string" ||
            typeof raw.match !== "string"
        ) {
            return [];
        }

        const fields: Record<string, PopupField> = {};

        for (const [name, spec] of Object.entries(isRecord(raw.fields) ? raw.fields : {})) {
            if (isRecord(spec) && typeof spec.selector === "string") {
                fields[name] = {
                    selector: spec.selector,
                    property: typeof spec.property === "string" ? spec.property : undefined,
                };
            }
        }

        return [{ id: raw.id, label: raw.label, match: raw.match, fields }];
    });
    return { actions, gitlabHosts };
}

async function main(): Promise<void> {
    mountPage();
    const host = required<HTMLElement>("#host");
    const result = required<HTMLElement>("#result");
    required<HTMLElement>("#options").addEventListener("click", (event) => {
        event.preventDefault();
        void ext.runtime.openOptionsPage();
    });

    const show = (reply: HostResponse, ok: (data: unknown) => string) => {
        const shown = describe(reply, ok);
        result.className = `gt-pre ${shown.tone}`;
        result.textContent = shown.text;
    };

    const ping = await callHost("ping");

    if (!ping.ok) {
        host.className = "gt-error";
        host.textContent = "host not reachable";
        show(ping, () => "");
        return;
    }

    host.className = "gt-ok";
    host.textContent = "host ok";
    const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ?? "";
    const configReply = await callHost("config.get");
    const { actions, gitlabHosts } = actionsFrom(configReply.ok ? configReply.data : null);
    const page = parseForgeUrl(url, gitlabHosts);

    if (page) {
        required<HTMLElement>("#page").hidden = false;
        required<HTMLElement>("#page-info").textContent =
            `${page.kind} ${page.project}${page.number ? ` #${page.number}` : ""}`;
        const buttons = required<HTMLElement>("#page-buttons");
        const add = (label: string, run: () => Promise<void>, primary = false) => {
            const button = document.createElement("button");
            button.className = primary ? "gt-btn primary" : "gt-btn";
            button.textContent = label;
            // A second click while the host works would start the same command again (two reviews).
            button.addEventListener("click", async () => {
                button.disabled = true;

                try {
                    await run();
                } finally {
                    button.disabled = false;
                }
            });
            buttons.append(button);
        };

        if (page.view === "pr") {
            add(
                "Review with agent",
                async () =>
                    show(
                        await callHost("review.start", { url }),
                        (data) => `Started: ${isRecord(data) ? String(data.detail) : ""}`
                    ),
                true
            );
        }

        add("Open locally", async () => show(await callHost("open.file", { url }), () => "Opened in the editor"));
        add("Terminal", async () => show(await callHost("open.terminal", { url }), () => "Terminal opened"));
    }

    // The host validated each pattern, but this engine may still refuse one: skip it, keep the others.
    const refused: string[] = [];
    const matching = actions.filter((action) => {
        try {
            return new RegExp(action.match, "u").test(url);
        } catch (error) {
            refused.push(`${action.label}: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    });

    if (refused.length > 0) {
        result.className = "gt-pre gt-error";
        result.textContent = `Skipped actions with an invalid match:\n${refused.join("\n")}`;
    }

    if (matching.length === 0 || tab?.id === undefined) {
        return;
    }

    const tabId = tab.id;
    required<HTMLElement>("#actions").hidden = false;
    const actionButtons = required<HTMLElement>("#action-buttons");

    for (const action of matching) {
        const button = document.createElement("button");
        button.className = "gt-btn primary";
        button.textContent = action.label;
        button.addEventListener("click", async () => {
            button.disabled = true;
            result.className = "gt-pre gt-muted";
            result.textContent = `Running ${action.label}...`;

            // The page may refuse scripting, and a configured selector may be invalid; either
            // rejects here, and the button must come back with the reason shown.
            try {
                const [injected] = await ext.scripting.executeScript({
                    target: { tabId },
                    func: readFields,
                    args: [action.fields],
                });
                const reply = await callHost("action.run", {
                    actionId: action.id,
                    url,
                    fields: injected?.result ?? {},
                });
                show(reply, (data) =>
                    isRecord(data) ? `Done. ${String(data.session ?? data.stdoutLastLine ?? "")}` : "Done"
                );
            } catch (error) {
                result.className = "gt-pre gt-error";
                result.textContent = `Cannot run ${action.label}: ${error instanceof Error ? error.message : String(error)}`;
            } finally {
                button.disabled = false;
            }
        });
        actionButtons.append(button);
    }
}

void main();
