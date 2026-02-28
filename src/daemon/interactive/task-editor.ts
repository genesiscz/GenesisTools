import * as p from "@clack/prompts";
import { getTask } from "../lib/config";
import { parseInterval } from "../lib/interval";
import type { DaemonTask } from "../lib/types";

export async function runTaskEditor(initial?: Partial<DaemonTask>): Promise<DaemonTask | null> {
    const name = await p.text({
        message: "Task name",
        placeholder: "my-task",
        initialValue: initial?.name,
        validate(value = "") {
            if (!value.trim()) {
                return "Name is required";
            }

            if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
                return "Only letters, numbers, hyphens, and underscores";
            }
        },
    });

    if (p.isCancel(name)) {
        return null;
    }

    if (!initial?.name) {
        const existing = await getTask(name);

        if (existing) {
            p.log.warn(`Task "${name}" already exists`);
            return null;
        }
    }

    const command = await p.text({
        message: "Shell command",
        placeholder: "echo hello",
        initialValue: initial?.command,
        validate(value = "") {
            if (!value.trim()) {
                return "Command is required";
            }
        },
    });

    if (p.isCancel(command)) {
        return null;
    }

    const every = await p.text({
        message: "Run interval",
        placeholder: "every 5 minutes",
        initialValue: initial?.every,
        validate(value = "") {
            if (!value.trim()) {
                return "Interval is required";
            }

            try {
                parseInterval(value);
            } catch (err) {
                return err instanceof Error ? err.message : String(err);
            }
        },
    });

    if (p.isCancel(every)) {
        return null;
    }

    const retries = await p.select({
        message: "Retries on failure",
        initialValue: String(initial?.retries ?? 3),
        options: [
            { value: "0", label: "0 — no retries" },
            { value: "1", label: "1 retry" },
            { value: "3", label: "3 retries (default)" },
            { value: "5", label: "5 retries" },
        ],
    });

    if (p.isCancel(retries)) {
        return null;
    }

    const description = await p.text({
        message: "Description (optional)",
        placeholder: "What does this task do?",
        initialValue: initial?.description ?? "",
    });

    if (p.isCancel(description)) {
        return null;
    }

    const confirmed = await p.confirm({
        message: `Create task "${name}"?`,
    });

    if (p.isCancel(confirmed) || !confirmed) {
        return null;
    }

    return {
        name,
        command,
        every,
        retries: parseInt(retries, 10),
        enabled: initial?.enabled ?? true,
        description: description || undefined,
    };
}
