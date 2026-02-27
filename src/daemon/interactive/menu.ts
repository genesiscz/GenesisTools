import * as p from "@clack/prompts";
import pc from "picocolors";
import { loadConfig, removeTask, setTaskEnabled, upsertTask } from "../lib/config";
import { formatInterval } from "../lib/interval";
import { getDaemonStatus, installLaunchd, uninstallLaunchd } from "../lib/launchd";
import { getDaemonPid, startDaemon } from "../daemon";
import { runLogViewer } from "./log-viewer";
import { runTaskEditor } from "./task-editor";

export async function runInteractiveMenu(): Promise<void> {
    while (true) {
        const action = await p.select({
            message: "What would you like to do?",
            options: [
                { value: "status", label: "Status", hint: "daemon & task status" },
                { value: "tasks", label: "Tasks", hint: "manage background tasks" },
                { value: "logs", label: "Logs", hint: "view task run logs" },
                { value: "start", label: "Start", hint: "run daemon in foreground" },
                { value: "stop", label: "Stop", hint: "stop running daemon" },
                { value: "launchd", label: "Launchd", hint: "install/uninstall auto-start" },
                { value: "quit", label: "Quit" },
            ],
        });

        if (p.isCancel(action) || action === "quit") {
            p.outro(pc.dim("Bye!"));
            break;
        }

        switch (action) {
            case "status":
                await showStatus();
                break;
            case "tasks":
                await tasksSubmenu();
                break;
            case "logs":
                await runLogViewer();
                break;
            case "start":
                await handleStart();
                break;
            case "stop":
                handleStop();
                break;
            case "launchd":
                await launchdSubmenu();
                break;
        }

        console.log("");
    }
}

async function showStatus(): Promise<void> {
    const status = await getDaemonStatus();
    const fgPid = getDaemonPid();
    const config = await loadConfig();

    if (status.running) {
        p.log.success(`Daemon running ${pc.dim(`(launchd, PID ${status.pid})`)}`);
    } else if (fgPid) {
        p.log.success(`Daemon running ${pc.dim(`(foreground, PID ${fgPid})`)}`);
    } else if (status.installed) {
        p.log.warn("Daemon installed but not running");
    } else {
        p.log.info("Daemon not running");
    }

    const enabled = config.tasks.filter((t) => t.enabled);
    const disabled = config.tasks.filter((t) => !t.enabled);
    p.log.info(
        `Tasks: ${pc.green(String(enabled.length))} enabled, ${pc.dim(String(disabled.length))} disabled`
    );

    if (enabled.length > 0) {
        for (const task of enabled) {
            p.log.step(
                `  ${pc.bold(task.name)} — ${pc.dim(formatInterval(task.every))} — ${pc.cyan(truncate(task.command, 40))}`
            );
        }
    }
}

async function tasksSubmenu(): Promise<void> {
    while (true) {
        const action = await p.select({
            message: "Task management",
            options: [
                { value: "list", label: "List tasks" },
                { value: "add", label: "Add task" },
                { value: "toggle", label: "Enable/Disable" },
                { value: "delete", label: "Delete task" },
                { value: "back", label: pc.dim("← Back") },
            ],
        });

        if (p.isCancel(action) || action === "back") {
            break;
        }

        switch (action) {
            case "list":
                await listTasks();
                break;
            case "add":
                await addTask();
                break;
            case "toggle":
                await toggleTask();
                break;
            case "delete":
                await deleteTask();
                break;
        }
    }
}

async function listTasks(): Promise<void> {
    const config = await loadConfig();

    if (config.tasks.length === 0) {
        p.log.info("No tasks configured.");
        return;
    }

    for (const task of config.tasks) {
        const status = task.enabled ? pc.green("enabled") : pc.dim("disabled");
        const retries = task.retries > 0 ? pc.dim(` retries:${task.retries}`) : "";
        p.log.step(
            `${pc.bold(task.name)} [${status}] ${pc.dim(formatInterval(task.every))}${retries}\n  ${pc.cyan(task.command)}${task.description ? `\n  ${pc.dim(task.description)}` : ""}`
        );
    }
}

async function addTask(): Promise<void> {
    const task = await runTaskEditor();

    if (!task) {
        return;
    }

    await upsertTask(task);
    p.log.success(`Task "${task.name}" created`);
}

async function toggleTask(): Promise<void> {
    const config = await loadConfig();

    if (config.tasks.length === 0) {
        p.log.info("No tasks to toggle.");
        return;
    }

    const taskName = await p.select({
        message: "Select task",
        options: [
            ...config.tasks.map((t) => ({
                value: t.name,
                label: `${t.name} — ${t.enabled ? pc.green("enabled") : pc.dim("disabled")}`,
            })),
            { value: "back", label: pc.dim("← Back") },
        ],
    });

    if (p.isCancel(taskName) || taskName === "back") {
        return;
    }

    const task = config.tasks.find((t) => t.name === taskName);

    if (!task) {
        p.log.warn(`Task "${taskName}" no longer exists.`);
        return;
    }

    const newState = !task.enabled;
    await setTaskEnabled(taskName, newState);
    p.log.success(`Task "${taskName}" ${newState ? "enabled" : "disabled"}`);
}

async function deleteTask(): Promise<void> {
    const config = await loadConfig();

    if (config.tasks.length === 0) {
        p.log.info("No tasks to delete.");
        return;
    }

    const taskName = await p.select({
        message: "Select task to delete",
        options: [
            ...config.tasks.map((t) => ({ value: t.name, label: t.name })),
            { value: "back", label: pc.dim("← Back") },
        ],
    });

    if (p.isCancel(taskName) || taskName === "back") {
        return;
    }

    const confirmed = await p.confirm({ message: `Delete task "${taskName}"?` });

    if (p.isCancel(confirmed) || !confirmed) {
        return;
    }

    await removeTask(taskName);
    p.log.success(`Task "${taskName}" deleted`);
}

async function handleStart(): Promise<void> {
    const existing = getDaemonPid();

    if (existing) {
        p.log.info(`Daemon already running (PID ${existing})`);
        return;
    }

    p.log.info("Starting daemon in foreground... (Ctrl+C to stop)");
    await startDaemon();
}

function handleStop(): void {
    const pid = getDaemonPid();

    if (!pid) {
        p.log.info("Daemon is not running.");
        return;
    }

    process.kill(pid, "SIGTERM");
    p.log.success(`Sent SIGTERM to daemon (PID ${pid})`);
}

async function launchdSubmenu(): Promise<void> {
    const status = await getDaemonStatus();

    const action = await p.select({
        message: `Launchd ${status.installed ? pc.green("(installed)") : pc.dim("(not installed)")}`,
        options: [
            ...(status.installed
                ? [{ value: "uninstall" as const, label: "Uninstall", hint: "remove auto-start" }]
                : [{ value: "install" as const, label: "Install", hint: "auto-start on login" }]),
            { value: "back" as const, label: pc.dim("← Back") },
        ],
    });

    if (p.isCancel(action) || action === "back") {
        return;
    }

    if (action === "install") {
        try {
            await installLaunchd();
            p.log.success("Daemon installed via launchd (starts on login)");
        } catch (err) {
            p.log.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    } else {
        await uninstallLaunchd();
        p.log.success("Daemon uninstalled from launchd");
    }
}

function truncate(s: string, max: number): string {
    if (s.length <= max) {
        return s;
    }

    return s.slice(0, max - 1) + "…";
}
