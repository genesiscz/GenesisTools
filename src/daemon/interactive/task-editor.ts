import * as p from "@clack/prompts";
import { getTask } from "../lib/config";
import { parseInterval } from "../lib/interval";
import { DEFAULT_RETENTION } from "../lib/register";
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

    const initialRetention = initial?.retention ?? DEFAULT_RETENTION;
    const usesDefaultRetention =
        initialRetention.maxAgeDays === DEFAULT_RETENTION.maxAgeDays &&
        initialRetention.minRuns === DEFAULT_RETENTION.minRuns;

    const useDefaultRetention = await p.confirm({
        message: `Use default retention (${DEFAULT_RETENTION.maxAgeDays} days, keep ${DEFAULT_RETENTION.minRuns} runs)?`,
        initialValue: usesDefaultRetention,
    });

    if (p.isCancel(useDefaultRetention)) {
        return null;
    }

    let retention = useDefaultRetention ? { ...DEFAULT_RETENTION } : initialRetention;

    if (!useDefaultRetention) {
        const maxAgeDaysRaw = await p.text({
            message: "Retention: delete run logs older than N days",
            initialValue: String(retention.maxAgeDays),
            validate(value = "") {
                const n = Number(value);

                if (!Number.isFinite(n) || n < 0) {
                    return "Enter a non-negative number of days";
                }
            },
        });

        if (p.isCancel(maxAgeDaysRaw)) {
            return null;
        }

        const minRunsRaw = await p.text({
            message: "Retention: always keep at least N newest run logs",
            initialValue: String(retention.minRuns),
            validate(value = "") {
                const n = Number(value);

                if (!Number.isInteger(n) || n < 1) {
                    return "Enter an integer of at least 1";
                }
            },
        });

        if (p.isCancel(minRunsRaw)) {
            return null;
        }

        retention = {
            maxAgeDays: Number(maxAgeDaysRaw),
            minRuns: Number(minRunsRaw),
        };
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
        retention,
    };
}
