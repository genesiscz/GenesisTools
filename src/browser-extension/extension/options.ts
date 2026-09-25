import { SafeJSON } from "@genesiscz/utils/json";
import { ext } from "./chrome";
import { callHost, isRecord } from "./shared/bridge";
import { mountPage, required } from "./shared/page";

const EXAMPLE_ACTION = {
    id: "start-work-item",
    label: "Start branch + session",
    match: "^https://dev\\.example\\.com/org/project/_workitems/edit/(?<id>\\d+)",
    fields: { title: { selector: "input[aria-label='Title']", property: "value" } },
    cwd: "~/Projects/app",
    command: ["./scripts/worktree-init.sh", "{id}", "{title}"],
    sessionCwd: "{stdoutLastLine}",
    prompt: "Work item {id}: {title}. Read it and propose a plan.",
};

async function renderGitlab(hosts: string[]): Promise<void> {
    const box = required<HTMLElement>("#gitlab");
    box.replaceChildren();

    if (hosts.length === 0) {
        box.textContent = "None configured.";
        return;
    }

    for (const host of hosts) {
        const origin = `https://${host}/*`;
        const granted = await ext.permissions.contains({ origins: [origin] });
        const button = document.createElement("button");
        button.className = granted ? "gt-btn" : "gt-btn primary";
        button.textContent = granted ? `${host}: granted` : `Grant ${host}`;
        button.disabled = granted;
        button.addEventListener("click", async () => {
            // permissions.request needs this click as its user gesture.
            if (await ext.permissions.request({ origins: [origin] })) {
                await ext.runtime.sendMessage({ type: "gitlab.sync" });
            }

            await renderGitlab(hosts);
        });
        box.append(button);
    }
}

async function load(): Promise<void> {
    const status = required<HTMLElement>("#status");
    const reply = await callHost("config.get");

    if (!reply.ok || !isRecord(reply.data)) {
        status.className = "gt-error";
        status.textContent = reply.ok ? "no config in the reply" : reply.error;
        return;
    }

    required<HTMLElement>("#path").textContent = String(reply.data.path);
    required<HTMLTextAreaElement>("#config").value = SafeJSON.stringify(reply.data.config, { strict: true }, 2);
    const config = isRecord(reply.data.config) ? reply.data.config : {};
    const hosts = Array.isArray(config.gitlabHosts)
        ? config.gitlabHosts.filter((host): host is string => typeof host === "string")
        : [];
    await renderGitlab(hosts);
}

async function save(): Promise<void> {
    const status = required<HTMLElement>("#status");
    let parsed: unknown;

    try {
        parsed = SafeJSON.parse(required<HTMLTextAreaElement>("#config").value, { strict: true });
    } catch (error) {
        status.className = "gt-error";
        status.textContent = `Not JSON: ${error instanceof Error ? error.message : String(error)}`;
        return;
    }

    const reply = await callHost("config.set", { config: parsed });
    status.className = reply.ok ? "gt-ok" : "gt-error";
    status.textContent = reply.ok ? "Saved." : reply.error;

    if (reply.ok) {
        await ext.runtime.sendMessage({ type: "gitlab.sync" });
        await load();
    }
}

async function main(): Promise<void> {
    mountPage();
    required<HTMLElement>("#example").textContent = SafeJSON.stringify(EXAMPLE_ACTION, { strict: true }, 2);
    required<HTMLElement>("#save").addEventListener("click", () => void save());
    required<HTMLElement>("#reload").addEventListener("click", () => void load());
    const host = required<HTMLElement>("#host");
    const ping = await callHost("ping");
    host.className = ping.ok ? "gt-ok" : "gt-error";
    host.textContent =
        ping.ok && isRecord(ping.data)
            ? `Connected (host ${String(ping.data.version)})`
            : ping.ok
              ? "Connected"
              : ping.error;
    await load();
}

void main();
