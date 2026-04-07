export interface GitContext {
    branch: string;
    commitSha: string;
    commitMessage: string;
    stagedFiles: string[];
    unstagedFiles: string[];
    untrackedFiles: string[];
    remote?: string;
}

export interface TodoContext {
    git?: GitContext;
    cwd: string;
    projectRoot: string;
    hostname: string;
    createdAt: string;
    updatedAt: string;
}

export interface TodoAttachment {
    originalPath: string;
    storedPath: string;
    filename: string;
    mimeType?: string;
}

export interface TodoLink {
    type: "pr" | "issue" | "ado" | "url";
    ref: string;
    repo?: string;
}

export interface TodoReminder {
    at: string;
    label?: string;
    synced?: "calendar" | "reminders" | null;
    syncId?: string;
}

export type TodoStatus = "todo" | "in-progress" | "blocked" | "done";
export type TodoPriority = "critical" | "high" | "medium" | "low";

export interface Todo {
    id: string;
    title: string;
    description?: string;
    status: TodoStatus;
    priority: TodoPriority;
    tags: string[];
    attachments: TodoAttachment[];
    inlineContent?: string;
    context: TodoContext;
    sessionId?: string;
    links: TodoLink[];
    reminders: TodoReminder[];
    at?: string;
    completedAt?: string;
    completionNote?: string;
}

export interface AddTodoInput {
    title: string;
    description?: string;
    priority?: TodoPriority;
    tags?: string[];
    links?: TodoLink[];
    reminders?: string[];
    at?: string;
    sessionId?: string;
    attachFiles?: string[];
    mdFile?: string;
    projectRoot?: string;
}

export interface TodoFilters {
    status?: TodoStatus[];
    priority?: TodoPriority[];
    tags?: string[];
    sessionId?: string;
    search?: string;
}

export interface ProjectMeta {
    projectRoot: string;
    name: string;
    lastAccessed: string;
    todoCount: number;
}

export type OutputFormat = "ai" | "json" | "md" | "table";
