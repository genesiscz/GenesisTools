import { git } from "./git";
import type { BackupInfo } from "./types";

const BACKUP_REF_PREFIX = "refs/backup/grm";

/**
 * Backup manager for creating and restoring branch backups
 */
export const backupManager = {
    /**
     * Get backup ref name for a branch
     */
    getRefName(branch: string): string {
        return `${BACKUP_REF_PREFIX}/${branch}`;
    },

    /**
     * Create a backup of a branch
     */
    async createBackup(branch: string): Promise<BackupInfo> {
        const sha = await git.getSha(branch);
        const ref = this.getRefName(branch);
        await git.updateRef(ref, sha);

        return {
            branch,
            sha,
            ref,
        };
    },

    /**
     * Create backups for multiple branches
     */
    async createBackups(branches: string[]): Promise<BackupInfo[]> {
        const backups: BackupInfo[] = [];
        for (const branch of branches) {
            const backup = await this.createBackup(branch);
            backups.push(backup);
        }
        return backups;
    },

    /**
     * Restore a branch from its backup
     */
    async restoreBackup(branch: string): Promise<void> {
        const ref = this.getRefName(branch);
        const sha = await git.getSha(ref);

        // Checkout the branch and reset to backup
        await git.checkout(branch);
        await git.resetHard(sha);
    },

    /**
     * Restore all branches from their backups
     */
    async restoreAll(branches: string[]): Promise<void> {
        for (const branch of branches) {
            await this.restoreBackup(branch);
        }
    },

    /**
     * Check if a backup exists for a branch
     */
    async backupExists(branch: string): Promise<boolean> {
        const ref = this.getRefName(branch);
        return git.refExists(ref);
    },

    /**
     * Get all existing backup refs
     */
    async listBackups(): Promise<BackupInfo[]> {
        const refs = await git.listRefs(`${BACKUP_REF_PREFIX}/*`);
        const backups: BackupInfo[] = [];

        for (const ref of refs) {
            const branch = ref.replace(`${BACKUP_REF_PREFIX}/`, "");
            try {
                const sha = await git.getSha(ref);
                backups.push({ branch, sha, ref });
            } catch {
                // Skip invalid refs
            }
        }

        return backups;
    },

    /**
     * Delete a backup for a specific branch
     */
    async deleteBackup(branch: string): Promise<void> {
        const ref = this.getRefName(branch);
        await git.deleteRef(ref);
    },

    /**
     * Delete all backups
     */
    async cleanup(): Promise<void> {
        const backups = await this.listBackups();
        for (const backup of backups) {
            await git.deleteRef(backup.ref);
        }
    },

    /**
     * Get backup info for a branch
     */
    async getBackup(branch: string): Promise<BackupInfo | null> {
        const ref = this.getRefName(branch);
        try {
            const sha = await git.getSha(ref);
            return { branch, sha, ref };
        } catch {
            return null;
        }
    },
};
