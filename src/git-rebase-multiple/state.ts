import { git } from "./git";
import type { RebasePhase, RebaseState } from "./types";

const STATE_FILE_NAME = "rebase-multiple-state.json";

/**
 * Get the path to the state file
 */
async function getStateFilePath(): Promise<string> {
    const repoRoot = await git.getRepoRoot();
    return `${repoRoot}/.git/${STATE_FILE_NAME}`;
}

/**
 * State manager for persisting rebase operation state
 */
export const stateManager = {
    /**
     * Check if a state file exists
     */
    async exists(): Promise<boolean> {
        const path = await getStateFilePath();
        return Bun.file(path).exists();
    },

    /**
     * Load state from file
     */
    async load(): Promise<RebaseState | null> {
        const path = await getStateFilePath();
        const file = Bun.file(path);

        if (!(await file.exists())) {
            return null;
        }

        try {
            const content = await file.text();
            return JSON.parse(content) as RebaseState;
        } catch {
            return null;
        }
    },

    /**
     * Save state to file
     */
    async save(state: RebaseState): Promise<void> {
        const path = await getStateFilePath();
        await Bun.write(path, JSON.stringify(state, null, 2));
    },

    /**
     * Update phase in state
     */
    async updatePhase(phase: RebasePhase): Promise<void> {
        const state = await this.load();
        if (state) {
            state.phase = phase;
            await this.save(state);
        }
    },

    /**
     * Mark a branch as completed
     */
    async markCompleted(branch: string): Promise<void> {
        const state = await this.load();
        if (state) {
            if (!state.completed.includes(branch)) {
                state.completed.push(branch);
            }
            state.pending = state.pending.filter((b) => b !== branch);
            state.currentChild = undefined;
            await this.save(state);
        }
    },

    /**
     * Set current child being rebased
     */
    async setCurrentChild(branch: string): Promise<void> {
        const state = await this.load();
        if (state) {
            state.currentChild = branch;
            state.phase = "CHILD_REBASE";
            await this.save(state);
        }
    },

    /**
     * Clear state file
     */
    async clear(): Promise<void> {
        const path = await getStateFilePath();
        try {
            await Bun.spawn({ cmd: ["rm", "-f", path] }).exited;
        } catch {
            // Ignore errors if file doesn't exist
        }
    },

    /**
     * Create initial state
     */
    async create(config: {
        parentBranch: string;
        targetBranch: string;
        childBranches: string[];
        backups: Record<string, string>;
        forkPoints: Record<string, string>;
        originalBranch: string;
    }): Promise<RebaseState> {
        const state: RebaseState = {
            startedAt: new Date().toISOString(),
            phase: "INIT",
            parentBranch: config.parentBranch,
            targetBranch: config.targetBranch,
            childBranches: config.childBranches,
            backups: config.backups,
            forkPoints: config.forkPoints,
            completed: [],
            pending: [config.parentBranch, ...config.childBranches],
            originalBranch: config.originalBranch,
        };

        await this.save(state);
        return state;
    },

    /**
     * Get state file path (for display)
     */
    async getPath(): Promise<string> {
        return await getStateFilePath();
    },
};
