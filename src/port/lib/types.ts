export interface PortProcess {
    pid: number;
    command: string;
    user: string;
    state: string;
    name: string;
    fd: string;
}

export type ProcessStatus = "healthy" | "orphaned" | "zombie" | "unknown";

export interface PortSnapshot {
    port: number;
    pid: number;
    processName: string;
    command: string;
    user: string;
    state: string;
    name: string;
    fd: string;
    cwd: string | null;
    projectName: string | null;
    framework: string | null;
    uptime: string | null;
    startTime: Date | null;
    memory: string | null;
    status: ProcessStatus;
}

export interface ProcessSnapshot {
    pid: number;
    ppid: number | null;
    processName: string;
    command: string;
    user: string;
    cpu: number;
    memory: string | null;
    cwd: string | null;
    projectName: string | null;
    framework: string | null;
    uptime: string | null;
    startTime: Date | null;
    description: string;
    status: ProcessStatus;
    listeningPorts: number[];
}

export interface KillResult {
    pid: number;
    status: "killed" | "force-killed" | "failed";
    error?: string;
}
