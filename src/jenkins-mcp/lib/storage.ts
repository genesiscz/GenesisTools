import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Storage } from "@genesiscz/utils/storage/storage";

const TOOL_NAME = "jenkins-mcp";

/**
 * Per-tool storage wrapper for the Jenkins MCP server.
 *
 * Logs themselves are large, regenerable blobs and live in the OS temp dir
 * (`$TMPDIR/jenkins-mcp/`). Small persistent metadata — the markers that a log
 * was fetched after its build finished — lives under
 * `~/.genesis-tools/jenkins-mcp/cache/`. (When the temp log is absent on next
 * read, `fetchLog` refetches it, so a marker without its log is harmless.)
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

    /** Absolute path of a per-build (optionally per-node) log file in `$TMPDIR/jenkins-mcp/`. */
    getLogPath(slug: string, buildNumber: string, nodeId?: string): string {
        const name = nodeId ? `${slug}-${buildNumber}-node${nodeId}.log` : `${slug}-${buildNumber}.log`;
        return join(this.logDir, name);
    }

    /**
     * Marker that a log was fetched after its build had finished, so the cached
     * copy is complete (`~/.genesis-tools/jenkins-mcp/cache/<basename>.log.complete`).
     */
    getCompleteMarkerPath(logPath: string): string {
        return join(this.getCacheDir(), `${basename(logPath)}.complete`);
    }
}

let _instance: JenkinsMcpStorage | null = null;

export function getJenkinsMcpStorage(): JenkinsMcpStorage {
    if (!_instance) {
        _instance = new JenkinsMcpStorage();
    }

    return _instance;
}
