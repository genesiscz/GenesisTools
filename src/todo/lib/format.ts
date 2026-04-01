import { SafeJSON } from "@app/utils/json";
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

function formatTodoAi(todo: Todo): string {
    const lines: string[] = [];
    lines.push(`[${todo.id}] ${todo.title} (${todo.priority}, ${todo.status})`);

    if (todo.tags.length > 0) {
        lines.push(`tags: ${todo.tags.join(", ")}`);
    }

    const ctxParts: string[] = [];

    if (todo.context.git?.branch) {
        ctxParts.push(`branch: ${todo.context.git.branch}`);
    }

    if (todo.context.git?.commitSha) {
        ctxParts.push(`commit: ${todo.context.git.commitSha.slice(0, 7)}`);
    }

    if (ctxParts.length > 0) {
        lines.push(ctxParts.join(" | "));
    }

    if (todo.sessionId) {
        lines.push(`session: ${todo.sessionId}`);
    }

    if (todo.links.length > 0) {
        lines.push(`links: ${todo.links.map(formatLinkCompact).join(", ")}`);
    }

    if (todo.reminders.length > 0) {
        lines.push(`reminders: ${todo.reminders.map(formatReminderCompact).join(", ")}`);
    }

    if (todo.completedAt) {
        lines.push(`completed: ${todo.completedAt}`);
    }

    if (todo.completionNote) {
        lines.push(`note: ${todo.completionNote}`);
    }

    if (todo.description) {
        lines.push("---");
        lines.push(todo.description);
    }

    if (todo.inlineContent) {
        lines.push("---");
        lines.push(todo.inlineContent);
    }

    return lines.join("\n");
}

function formatTodoMdShow(todo: Todo): string {
    const lines: string[] = [];
    lines.push(`## ${todo.id}: ${todo.title}`);

    const statusParts = [`**Status:** ${todo.status}`, `**Priority:** ${todo.priority}`];
    lines.push(statusParts.join(" | "));

    if (todo.tags.length > 0) {
        lines.push(`**Tags:** ${todo.tags.join(", ")}`);
    }

    lines.push("");

    const hasContext =
        todo.context.git?.branch ||
        todo.context.git?.commitSha ||
        todo.sessionId ||
        todo.links.length > 0 ||
        todo.reminders.length > 0;

    if (hasContext) {
        lines.push("### Context");

        if (todo.context.git?.branch) {
            lines.push(`- Branch: \`${todo.context.git.branch}\``);
        }

        if (todo.context.git?.commitSha) {
            const msg = todo.context.git.commitMessage ? ` — ${todo.context.git.commitMessage}` : "";
            lines.push(`- Commit: \`${todo.context.git.commitSha.slice(0, 8)}\`${msg}`);
        }

        if (todo.sessionId) {
            lines.push(`- Session: \`${todo.sessionId}\``);
        }

        if (todo.links.length > 0) {
            lines.push(`- Links: ${todo.links.map(formatLinkCompact).join(", ")}`);
        }

        if (todo.reminders.length > 0) {
            lines.push(`- Reminders: ${todo.reminders.map(formatReminderCompact).join(", ")}`);
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
        lines.push("### Description");
        lines.push(todo.description);
        lines.push("");
    }

    if (todo.inlineContent) {
        lines.push("### Content");
        lines.push(todo.inlineContent);
        lines.push("");
    }

    return lines.join("\n").trimEnd();
}

function formatTodoMdList(todos: Todo[]): string {
    if (todos.length === 0) {
        return "_No todos found._";
    }

    const lines = todos.map((t) => {
        const tags = t.tags.length > 0 ? ` [${t.tags.join(", ")}]` : "";
        return `- **${t.id}**: ${t.title} (${t.priority}, ${t.status})${tags}`;
    });

    return lines.join("\n");
}

function formatTodoTable(todos: Todo[]): string {
    if (todos.length === 0) {
        return "No todos found.";
    }

    const headers = ["ID", "Status", "Priority", "Title", "Tags"];
    const rows = todos.map((t) => [
        t.id,
        t.status,
        t.priority,
        t.title,
        t.tags.join(", "),
    ]);

    return formatTable(rows, headers, { maxColWidth: 40 });
}

export function formatTodo(todo: Todo, format: OutputFormat): string {
    switch (format) {
        case "json":
            return SafeJSON.stringify(todo, null, 2);
        case "ai":
            return formatTodoAi(todo);
        case "md":
            return formatTodoMdShow(todo);
        case "table":
            return formatTodoTable([todo]);
    }
}

export function formatTodoList(todos: Todo[], format: OutputFormat): string {
    switch (format) {
        case "json":
            return SafeJSON.stringify(todos, null, 2);
        case "ai":
            return todos.map(formatTodoAi).join("\n\n");
        case "md":
            return formatTodoMdList(todos);
        case "table":
            return formatTodoTable(todos);
    }
}
