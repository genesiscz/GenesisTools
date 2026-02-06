import pc from "picocolors";

export interface ExecResult {
	success: boolean;
	stdout: string;
	stderr: string;
	exitCode: number;
}

export interface ExecutorOptions {
	/** Base command prefix (e.g., "git" → all calls prepend "git") */
	prefix?: string;
	/** Working directory for all commands */
	cwd?: string;
	/** Enable verbose logging of commands (default: false) */
	verbose?: boolean;
	/** Enable debug logging of stdout/stderr (default: false) */
	debug?: boolean;
	/** Custom label for log output (default: prefix or "exec") */
	label?: string;
}

export class Executor {
	private prefix: string | undefined;
	private cwd: string;
	verbose: boolean;
	debug: boolean;
	private label: string;

	constructor(options: ExecutorOptions = {}) {
		this.prefix = options.prefix;
		this.cwd = options.cwd ?? process.cwd();
		this.verbose = options.verbose ?? false;
		this.debug = options.debug ?? false;
		this.label = options.label ?? options.prefix ?? "exec";
	}

	/** Set working directory */
	setCwd(cwd: string): void {
		this.cwd = cwd;
	}

	/** Get current working directory */
	getCwd(): string {
		return this.cwd;
	}

	/**
	 * Execute a command and capture output.
	 * If prefix is set, args are prepended with it.
	 * e.g., new Executor({ prefix: "git" }).exec(["status"]) → runs "git status"
	 */
	async exec(args: string[], options?: { cwd?: string }): Promise<ExecResult> {
		const cmd = this.prefix ? [this.prefix, ...args] : args;
		const cwd = options?.cwd ?? this.cwd;

		if (this.verbose) {
			console.log(pc.gray(`  $ ${cmd.join(" ")}`));
		}

		const proc = Bun.spawn({
			cmd,
			cwd,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		const result: ExecResult = {
			success: exitCode === 0,
			stdout: stdout.trim(),
			stderr: stderr.trim(),
			exitCode,
		};

		if (this.debug) {
			if (result.stdout) console.log(pc.dim(`  [${this.label}:out] ${result.stdout.substring(0, 200)}`));
			if (result.stderr) console.log(pc.dim(`  [${this.label}:err] ${result.stderr.substring(0, 200)}`));
			if (!result.success) console.log(pc.red(`  [${this.label}] exit ${exitCode}`));
		}

		return result;
	}

	/**
	 * Execute a command with inherited stdio (interactive).
	 * User sees the command's output directly.
	 */
	async execInteractive(args: string[], options?: { cwd?: string }): Promise<ExecResult> {
		const cmd = this.prefix ? [this.prefix, ...args] : args;
		const cwd = options?.cwd ?? this.cwd;

		if (this.verbose) {
			console.log(pc.cyan(`  $ ${cmd.join(" ")}`));
		}

		const proc = Bun.spawn({
			cmd,
			cwd,
			stdio: ["inherit", "inherit", "inherit"],
		});

		const exitCode = await proc.exited;

		return {
			success: exitCode === 0,
			stdout: "",
			stderr: "",
			exitCode,
		};
	}

	/**
	 * Execute and throw on failure.
	 */
	async execOrThrow(args: string[], errorMsg?: string): Promise<ExecResult> {
		const result = await this.exec(args);
		if (!result.success) {
			throw new Error(
				errorMsg ?? `Command failed: ${this.prefix ? this.prefix + " " : ""}${args.join(" ")}\n${result.stderr}`,
			);
		}
		return result;
	}
}
