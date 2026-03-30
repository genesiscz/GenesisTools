export interface DockerContainerConfig {
    name: string;
    image: string;
    ports: Array<{ host: number; container: number }>;
    volumes: Array<{ host: string; container: string }>;
    healthUrl: string;
    restartPolicy?: string;
    env?: Record<string, string>;
}

export type DockerProgressCallback = (message: string) => void;

const READINESS_TTL_MS = 60_000;

export class DockerContainer {
    private config: DockerContainerConfig;
    private readyAt = 0;

    constructor(config: DockerContainerConfig) {
        this.config = config;
    }

    async isDockerAvailable(): Promise<boolean> {
        try {
            await this.run(["info"]);
            return true;
        } catch {
            return false;
        }
    }

    async isImagePresent(): Promise<boolean> {
        try {
            const stdout = await this.run([
                "images",
                "--format",
                "{{.Repository}}:{{.Tag}}",
                this.config.image,
            ]);
            return stdout.includes(this.config.image);
        } catch {
            return false;
        }
    }

    async pullImage(onProgress?: DockerProgressCallback): Promise<void> {
        onProgress?.(`Downloading Docker image ${this.config.image} (first time only, may take a few minutes)...`);

        try {
            await this.run(["pull", this.config.image], 10 * 60_000);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);

            if (msg.includes("timed out")) {
                throw new Error(
                    `Image download timed out after 10 minutes. Check your network connection and try again.`,
                );
            }

            throw new Error(
                `Failed to download image ${this.config.image}. Check your network connection and available disk space.\nDetails: ${msg}`,
            );
        }
    }

    async isRunning(): Promise<boolean> {
        try {
            const stdout = await this.run([
                "ps",
                "--filter",
                `name=${this.config.name}`,
                "--format",
                "{{.Names}}",
            ]);
            return stdout.trim().includes(this.config.name);
        } catch {
            return false;
        }
    }

    async containerExists(): Promise<boolean> {
        try {
            const stdout = await this.run([
                "ps",
                "-a",
                "--filter",
                `name=${this.config.name}`,
                "--format",
                "{{.Names}}",
            ]);
            return stdout.trim().includes(this.config.name);
        } catch {
            return false;
        }
    }

    async start(onProgress?: DockerProgressCallback): Promise<void> {
        if (await this.isRunning()) {
            return;
        }

        if (await this.containerExists()) {
            onProgress?.(`Starting existing ${this.config.name} container...`);
            await this.run(["start", this.config.name]);
            onProgress?.("Waiting for service to be ready...");
            await this.waitForService();
            return;
        }

        onProgress?.(`Creating and starting ${this.config.name} container...`);

        const args = ["run", "-d", "--name", this.config.name];

        for (const port of this.config.ports) {
            args.push("-p", `${port.host}:${port.container}`);
        }

        for (const vol of this.config.volumes) {
            args.push("-v", `${vol.host}:${vol.container}`);
        }

        const restartPolicy = this.config.restartPolicy ?? "unless-stopped";
        args.push("--restart", restartPolicy);

        if (this.config.env) {
            for (const [key, value] of Object.entries(this.config.env)) {
                args.push("-e", `${key}=${value}`);
            }
        }

        args.push(this.config.image);

        try {
            await this.run(args);
        } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            const portList = this.config.ports.map((p) => p.host).join(", ");
            throw new Error(
                `Failed to start container ${this.config.name}. Are ports ${portList} already in use?\nDetails: ${msg}`,
            );
        }

        onProgress?.("Waiting for service to be ready...");
        await this.waitForService();
    }

    async stop(): Promise<void> {
        await this.run(["stop", this.config.name]);
        this.readyAt = 0;
    }

    async ensureReady(onProgress?: DockerProgressCallback): Promise<{ started: boolean; pulled: boolean }> {
        if (Date.now() - this.readyAt < READINESS_TTL_MS) {
            return { started: false, pulled: false };
        }

        if (!(await this.isDockerAvailable())) {
            throw new Error(
                "Docker is not available. Please install Docker Desktop (https://www.docker.com/products/docker-desktop/) and make sure it is running.",
            );
        }

        let pulled = false;
        let started = false;

        onProgress?.(`Checking ${this.config.name}...`);

        if (!(await this.isImagePresent())) {
            await this.pullImage(onProgress);
            pulled = true;
        }

        if (!(await this.isRunning())) {
            await this.start(onProgress);
            started = true;
        }

        this.readyAt = Date.now();
        return { started, pulled };
    }

    resetReadinessCache(): void {
        this.readyAt = 0;
    }

    private async run(args: string[], timeoutMs = 30_000): Promise<string> {
        const proc = Bun.spawn(["docker", ...args], {
            stdout: "pipe",
            stderr: "pipe",
        });

        const result = await (timeoutMs > 0
            ? Promise.race([
                  proc.exited,
                  new Promise<never>((_resolve, reject) => {
                      setTimeout(() => {
                          proc.kill();
                          reject(new Error(`docker ${args[0]} timed out after ${timeoutMs / 1000}s`));
                      }, timeoutMs);
                  }),
              ])
            : proc.exited);

        const stdout = await new Response(proc.stdout).text();

        if (result !== 0) {
            const stderr = await new Response(proc.stderr).text();
            throw new Error(`docker ${args[0]} failed: ${stderr.trim()}`);
        }

        return stdout;
    }

    private async waitForService(retries = 30, delayMs = 1000): Promise<void> {
        for (let i = 0; i < retries; i++) {
            try {
                const resp = await fetch(this.config.healthUrl);

                if (resp.ok) {
                    return;
                }
            } catch {
                // not ready yet
            }

            await new Promise((r) => setTimeout(r, delayMs));
        }

        throw new Error(
            `${this.config.name} did not become ready at ${this.config.healthUrl} within ${(retries * delayMs) / 1000}s`,
        );
    }
}
