import pc from "picocolors";
import type { Command } from "commander";

/**
 * Enhance a Commander program with better help UX:
 * - Shows help after errors (e.g. too many arguments)
 * - Expands subcommand options in the parent's help output
 * - Recurses into nested subcommands
 *
 * Call once on the root program after all commands are registered.
 */
export function enhanceHelp(cmd: Command): void {
  cmd.showHelpAfterError(true);

  const subs = cmd.commands as Command[];
  if (subs.length > 0) {
    cmd.addHelpText("after", () => {
      const lines: string[] = [pc.dim("\nSubcommand Options:")];
      for (const sub of cmd.commands as Command[]) {
        const opts = sub.options.filter((o) => o.long !== "--help");
        if (opts.length === 0) continue;
        lines.push(`\n  ${pc.bold(sub.name())}:`);
        for (const opt of opts) {
          lines.push(`    ${pc.dim(opt.flags.padEnd(30))} ${opt.description}`);
        }
      }
      return lines.join("\n");
    });
  }

  for (const sub of subs) {
    enhanceHelp(sub);
  }
}

/**
 * Build a CLI command string from a base command and options.
 * Converts camelCase keys to --kebab-case flags.
 * Skips undefined/false values. Boolean true = flag only. String = flag + quoted value.
 */
export function buildCommand(
  base: string,
  args: Record<string, string | boolean | undefined>
): string {
  const parts = [base];
  for (const [key, value] of Object.entries(args)) {
    if (value === undefined || value === false) continue;
    const flag = `--${key.replace(/([A-Z])/g, (_, c) => `-${c.toLowerCase()}`)}`;
    if (value === true) {
      parts.push(flag);
    } else {
      // Quote values that contain spaces
      parts.push(flag, value.includes(" ") ? `"${value}"` : value);
    }
  }
  return parts.join(" ");
}

/**
 * Build a modified version of the current CLI command by adding/removing flags.
 * Uses process.argv to reconstruct the original command.
 *
 * @param toolName - The tool prefix (e.g., "tools azure-devops")
 * @param modifications - Flags to add or remove
 * @returns The modified command string with proper quoting
 */
export function suggestCommand(
  toolName: string,
  modifications: { add?: string[]; remove?: string[] } = {}
): string {
  // process.argv = [bun, script, ...args]
  let args = process.argv.slice(2);

  // Remove specified flags (and their values if they have one)
  if (modifications.remove?.length) {
    const removeSet = new Set(modifications.remove);
    const filtered: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (removeSet.has(args[i])) {
        // Skip the flag — also skip its value if next arg doesn't start with --
        if (i + 1 < args.length && !args[i + 1].startsWith("-")) {
          i++;
        }
        continue;
      }
      filtered.push(args[i]);
    }
    args = filtered;
  }

  // Add new flags
  if (modifications.add?.length) {
    args.push(...modifications.add);
  }

  // Quote args that contain spaces
  const quoted = args.map(a => (a.includes(" ") ? `"${a}"` : a));
  return `${toolName} ${quoted.join(" ")}`;
}

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
