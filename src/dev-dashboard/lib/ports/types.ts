export interface PortInfo {
    port: number;
    pid: number;
    command: string;
    address: string;
    proto: "tcp4" | "tcp6";
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
