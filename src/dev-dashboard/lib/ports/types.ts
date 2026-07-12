export interface PortInfo {
    port: number;
    pid: number;
    command: string;
    address: string;
    proto: "tcp4" | "tcp6";
    /** Full argv, resolved only for generic runtimes (bun/node/python…) so "bun" reads meaningfully. */
    fullCommand?: string;
    /** Friendly project/webapp name (package.json `name`, else HTML `<title>`). */
    title?: string;
    /** Process working directory (project path). */
    cwd?: string;
    /** True when the port answered an HTTP probe on localhost — i.e. it's a running web app. */
    isWebapp?: boolean;
}

export interface PortsResult {
    lsofAvailable: boolean;
    ports: PortInfo[];
}

export interface KillPortResult {
    ok: boolean;
    killed: boolean;
    reason?: string;
}
