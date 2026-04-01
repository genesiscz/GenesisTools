import { isInteractive } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { renderMarkdownToCli } from "@app/utils/markdown/index.js";
import { formatTable } from "@app/utils/table";
import type { OutputFormat, Todo, TodoLink, TodoReminder } from "./types";

function formatLinkCompact(link: TodoLink): string {
    if (link.type === "url") {
        return link.ref;
    }

    const repo = link.repo ? `${link.repo}#` : "";
    return `${link.type}:${repo}${link.ref}`;
}

function formatReminderCompact(reminder: TodoReminder): string {
    return reminder.label ? `${reminder.at} (${reminder.label})` : reminder.at;
}

function formatTodoMarkdown(todo: Todo): string {
    const lines: string[] = [];

    const statusIcon =
        todo.status === "done"
            ? "[x]"
            : todo.status === "in-progress"
              ? "[-]"
              : todo.status === "blocked"
                ? "[!]"
                : "[ ]";

    lines.push(`## ${statusIcon} ${todo.title}`);
    lines.push(`**${todo.id}** | **${todo.priority}** | **${todo.status}**`);

    if (todo.tags.length > 0) {
        lines.push(`Tags: \`${todo.tags.join("`, `")}\``);
    }

    lines.push("");

    const contextParts: string[] = [];

    if (todo.context.git?.branch) {
        contextParts.push(`Branch: \`${todo.context.git.branch}\``);
    }

    if (todo.context.git?.commitSha) {
        const msg = todo.context.git.commitMessage ? ` — ${todo.context.git.commitMessage}` : "";
        contextParts.push(`Commit: \`${todo.context.git.commitSha.slice(0, 8)}\`${msg}`);
    }

    if (todo.sessionId) {
        contextParts.push(`Session: \`${todo.sessionId}\``);
    }

    if (todo.links.length > 0) {
        contextParts.push(`Links: ${todo.links.map(formatLinkCompact).join(", ")}`);
    }

    if (todo.reminders.length > 0) {
        contextParts.push(`Reminders: ${todo.reminders.map(formatReminderCompact).join(", ")}`);
    }

    if (contextParts.length > 0) {
        for (const part of contextParts) {
            lines.push(`- ${part}`);
        }

        lines.push("");
    }

    if (todo.completedAt) {
        lines.push(`**Completed:** ${todo.completedAt}`);

        if (todo.completionNote) {
            lines.push(`**Note:** ${todo.completionNote}`);
        }

        lines.push("");
    }

    if (todo.description) {
        lines.push(todo.description);
        lines.push("");
    }

    if (todo.inlineContent) {
        lines.push("---");
        lines.push(todo.inlineContent);
        lines.push("");
    }

    return lines.join("\n").trimEnd();
}

function formatTodoListMarkdown(todos: Todo[]): string {
    if (todos.length === 0) {
        return "_No todos found._";
    }

    return todos.map(formatTodoMarkdown).join("\n\n---\n\n");
}

function renderForTerminal(markdown: string): string {
    return renderMarkdownToCli(markdown, { theme: "dark" });
}

function formatTodoTable(todos: Todo[]): string {
    if (todos.length === 0) {
        return "No todos found.";
    }

    const headers = ["ID", "Status", "Priority", "Title", "Tags"];
    const rows = todos.map((t) => [t.id, t.status, t.priority, t.title, t.tags.join(", ")]);

    return formatTable(rows, headers, { maxColWidth: 40 });
}

export function formatTodo(todo: Todo, format: OutputFormat): string {
    switch (format) {
        case "json":
            return SafeJSON.stringify(todo, null, 2);
        case "ai":
        case "md": {
            const md = formatTodoMarkdown(todo);
            return isInteractive() ? renderForTerminal(md) : md;
        }
        case "table":
            return formatTodoTable([todo]);
    }
}

export function formatTodoList(todos: Todo[], format: OutputFormat): string {
    switch (format) {
        case "json":
            return SafeJSON.stringify(todos, null, 2);
        case "ai":
        case "md": {
            const md = formatTodoListMarkdown(todos);
            return isInteractive() ? renderForTerminal(md) : md;
        }
        case "table":
            return formatTodoTable(todos);
    }
}
