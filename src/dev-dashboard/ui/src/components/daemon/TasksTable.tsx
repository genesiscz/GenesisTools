import type { DaemonTask } from "@app/daemon/lib/types";

interface Props {
    tasks: DaemonTask[];
}

export function TasksTable({ tasks }: Props) {
    if (tasks.length === 0) {
        return <div className="dd-panel p-4 text-sm text-[var(--dd-text-muted)]">No registered tasks.</div>;
    }

    return (
        <div className="dd-panel p-4">
            <h2 className="dd-accent-text mb-3 text-sm font-semibold">Registered Tasks</h2>
            <div className="overflow-x-auto">
                <table className="w-full text-sm">
                    <thead>
                        <tr className="text-left text-[var(--dd-text-secondary)]">
                            <th className="pb-2 pr-4 font-medium">Name</th>
                            <th className="pb-2 pr-4 font-medium">Enabled</th>
                            <th className="pb-2 pr-4 font-medium">Every</th>
                            <th className="pb-2 pr-4 font-medium">Retries</th>
                            <th className="pb-2 font-medium">Command</th>
                        </tr>
                    </thead>
                    <tbody>
                        {tasks.map((task) => (
                            <tr
                                key={task.name}
                                className="border-t border-[var(--dd-border)] text-[var(--dd-text-primary)]"
                            >
                                <td className="py-2 pr-4">{task.name}</td>
                                <td className="py-2 pr-4">
                                    <span className="inline-flex items-center gap-1.5">
                                        <span
                                            aria-hidden="true"
                                            className="inline-block h-2 w-2 rounded-full"
                                            style={{
                                                backgroundColor: task.enabled
                                                    ? "var(--dd-accent-from)"
                                                    : "var(--dd-text-muted)",
                                            }}
                                        />
                                        <span className="text-xs text-[var(--dd-text-secondary)]">
                                            {task.enabled ? "Enabled" : "Disabled"}
                                        </span>
                                    </span>
                                </td>
                                <td className="py-2 pr-4">{task.every}</td>
                                <td className="py-2 pr-4">{task.retries}</td>
                                <td className="max-w-xs truncate py-2 font-mono text-xs text-[var(--dd-text-secondary)]">
                                    {task.command}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
