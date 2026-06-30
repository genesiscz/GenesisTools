import type { DuplicateTool } from "./types";

export interface ServerTools {
    name: string;
    tools: string[];
}

export function detectDuplicateTools(servers: ServerTools[]): DuplicateTool[] {
    const owners = new Map<string, Set<string>>();
    for (const server of servers) {
        for (const tool of server.tools) {
            let set = owners.get(tool);
            if (!set) {
                set = new Set<string>();
                owners.set(tool, set);
            }

            set.add(server.name);
        }
    }

    const dups: DuplicateTool[] = [];
    for (const [tool, set] of owners) {
        if (set.size > 1) {
            dups.push({ tool, servers: [...set].sort((a, b) => a.localeCompare(b)) });
        }
    }

    return dups.sort((a, b) => a.tool.localeCompare(b.tool));
}
