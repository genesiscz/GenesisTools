import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Storage } from "@app/utils/storage/storage";

const TOOL_NAME = "jenkins-mcp";

/**
 * Per-tool storage wrapper for the Jenkins MCP server.
 *
 * Logs themselves are large, regenerable blobs and live in the OS temp dir
 * (`$TMPDIR/jenkins-mcp/`). Small persistent metadata — the X-Text-Size offset
 * sidecars used by the incremental whole-build tail — lives under
 * `~/.genesis-tools/jenkins-mcp/cache/`, so an OS `/tmp` wipe doesn't lose
 * cursor state across reboots. (When the temp log is absent on next read,
 * `fetchLog` notices and refetches from offset=0, so any stale offset is
 * harmless.)
 */
export class JenkinsMcpStorage extends Storage {
    private readonly logDir: string;

    constructor() {
        super(TOOL_NAME);
        this.logDir = join(tmpdir(), TOOL_NAME);
    }

    /** Ephemeral log directory: `$TMPDIR/jenkins-mcp/`. */
    getLogDir(): string {
        return this.logDir;
    }

    /** Absolute path of a per-build (optionally per-node) log file in /tmp. */
    getLogPath(slug: string, buildNumber: string, nodeId?: string): string {
        const name = nodeId ? `${slug}-${buildNumber}-node${nodeId}.log` : `${slug}-${buildNumber}.log`;
        return join(this.logDir, name);
    }

    /**
     * Absolute path of the `<basename>.offset` sidecar under the persistent
     * cache dir (`~/.genesis-tools/jenkins-mcp/cache/<basename>.log.offset`).
     */
    getOffsetPath(logPath: string): string {
        return join(this.getCacheDir(), `${basename(logPath)}.offset`);
    }
}

let _instance: JenkinsMcpStorage | null = null;

export function getJenkinsMcpStorage(): JenkinsMcpStorage {
    if (!_instance) {
        _instance = new JenkinsMcpStorage();
    }

    return _instance;
}
