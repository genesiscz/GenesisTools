import { createHash, randomUUID } from "node:crypto";
import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    readFileSync,
    readlinkSync,
    realpathSync,
    renameSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
    disableScreenCollector,
    enableScreenCollector,
    type ScreenCollectorStatus,
    screenCollectorStatus,
} from "@app/cmux/lib/capture-collector-lifecycle";
import { renderCaptureShell } from "@app/cmux/lib/capture-shell";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { z } from "zod";

const START = "# >>> GenesisTools cmux capture >>>";
const END = "# <<< GenesisTools cmux capture <<<";
const manifestSchema = z.object({
    version: z.literal(1),
    runtimeFile: z.string().regex(/^capture-record-[a-f0-9]{16}\.js$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    watcherFile: z
        .string()
        .regex(/^capture-watch-[a-f0-9]{16}\.js$/)
        .optional(),
});

export interface CaptureInstallOptions {
    home?: string;
    rcPath?: string;
    expectedRc?: string;
}

export interface CaptureInstallationStatus {
    installed: boolean;
    rcPath: string;
    hookPath: string;
    runtimePath?: string;
    managedBlock: boolean;
    legacySource: boolean;
    hookPresent: boolean;
    runtimeValid: boolean;
    screens: ScreenCollectorStatus;
}

function paths(options: CaptureInstallOptions) {
    const home = resolve(options.home ?? env.tools.getHome());
    const root = join(home, ".genesis-tools/cmux");
    const configuredRc = resolve(options.rcPath ?? join(home, ".zshrc"));
    let symlink = false;
    try {
        symlink = lstatSync(configuredRc).isSymbolicLink();
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
    }

    const rcPath = symlink ? realpathSync(configuredRc) : configuredRc;
    return {
        home,
        root,
        rcPath,
        hookPath: join(root, "capture.zsh"),
        runtimeDir: join(root, "runtime"),
        manifestPath: join(root, "runtime/installation.json"),
    };
}

function readRc(path: string): string {
    if (!existsSync(path)) {
        return "";
    }

    const bytes = readFileSync(path);
    const text = bytes.toString("utf8");
    if (!Buffer.from(text).equals(bytes)) {
        throw new Error(`Refusing to rewrite non-UTF-8 shell configuration: ${path}`);
    }

    return text;
}

function stripManagedBlock(text: string): string {
    const blocks = [
        ...text.matchAll(
            /(?:^|\n)# >>> GenesisTools cmux capture >>>\r?\n[\s\S]*?\r?\n# <<< GenesisTools cmux capture <<<(?=\r?\n|$)(?:\r?\n)?/g
        ),
    ];
    if (blocks.length > 1 || ((text.includes(START) || text.includes(END)) && blocks.length !== 1)) {
        throw new Error(
            "The cmux capture block is malformed or duplicated; preserve the rc file and repair the markers first."
        );
    }

    const block = blocks[0];
    if (!block) {
        return text;
    }

    const before = text.slice(0, block.index);
    const after = text.slice(block.index + block[0].length);
    const separator = before && after && !before.endsWith("\n") && !after.startsWith("\n") ? "\n" : "";
    return before + separator + after;
}

function stripLegacySource(text: string, hookPath: string): string {
    const known = new Set([
        "source ~/.genesis-tools/cmux/capture.zsh",
        ". ~/.genesis-tools/cmux/capture.zsh",
        'source "$HOME/.genesis-tools/cmux/capture.zsh"',
        '. "$HOME/.genesis-tools/cmux/capture.zsh"',
        `source '${hookPath}'`,
        `source "${hookPath}"`,
        `source ${hookPath}`,
    ]);
    return text
        .split(/(?<=\n)/)
        .filter((line) => !known.has(line.trim()))
        .join("");
}

function digest(text: string): string {
    return createHash("sha256").update(text).digest("hex");
}

function atomicWrite(path: string, text: string): boolean {
    if (existsSync(path) && readFileSync(path, "utf8") === text) {
        return false;
    }

    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { mode: existsSync(path) ? statSync(path).mode & 0o777 : 0o600, flag: "wx" });
    renameSync(temporary, path);
    return true;
}

function replaceRc(input: { path: string; before: string; after: string }): string | undefined {
    if (input.before === input.after) {
        return undefined;
    }

    if (readRc(input.path) !== input.before) {
        throw new Error("Shell configuration changed during installation; retry to preserve the concurrent edit.");
    }

    let backupPath: string | undefined;
    if (existsSync(input.path)) {
        backupPath = `${input.path}.cmux-backup-${Date.now()}-${randomUUID()}`;
        copyFileSync(input.path, backupPath);
        chmodSync(backupPath, 0o600);
    }

    atomicWrite(input.path, input.after);
    return backupPath;
}

function updateRuntimeLink(runtimeDir: string, runtimeFile: string): boolean {
    const path = join(runtimeDir, "capture-record.js");
    try {
        if (!lstatSync(path).isSymbolicLink()) {
            throw new Error(`Refusing to replace a non-symlink runtime entrypoint: ${path}`);
        }
        if (readlinkSync(path) === runtimeFile) {
            return false;
        }
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
    }
    const temporary = `${path}.${randomUUID()}.tmp`;
    symlinkSync(runtimeFile, temporary, "file");
    renameSync(temporary, path);
    return true;
}

export function captureInstallationStatus(options: CaptureInstallOptions = {}): CaptureInstallationStatus {
    const location = paths(options);
    const rc = readRc(location.rcPath);
    const unmanaged = stripManagedBlock(rc);
    const managedBlock = unmanaged !== rc;
    let runtimePath: string | undefined;
    let runtimeValid = false;
    let runtimeFile: string | undefined;

    if (existsSync(location.manifestPath)) {
        try {
            const manifest = manifestSchema.safeParse(SafeJSON.parse(readFileSync(location.manifestPath, "utf8")));
            if (manifest.success) {
                runtimeFile = manifest.data.runtimeFile;
                runtimePath = join(location.runtimeDir, manifest.data.runtimeFile);
                runtimeValid =
                    existsSync(runtimePath) && digest(readFileSync(runtimePath, "utf8")) === manifest.data.sha256;
            }
        } catch (error) {
            logger.warn({ error, path: location.manifestPath }, "[cmux-install] invalid installation manifest");
        }
    }

    const hookPresent = existsSync(location.hookPath);
    const entrypoint = join(location.runtimeDir, "capture-record.js");
    if (hookPresent && readFileSync(location.hookPath, "utf8").includes(entrypoint)) {
        try {
            runtimeValid =
                runtimeValid && lstatSync(entrypoint).isSymbolicLink() && readlinkSync(entrypoint) === runtimeFile;
        } catch (error) {
            logger.debug({ error, entrypoint }, "[cmux-install] managed runtime link unavailable");
            runtimeValid = false;
        }
    }
    return {
        installed: managedBlock && hookPresent && runtimeValid,
        rcPath: location.rcPath,
        hookPath: location.hookPath,
        runtimePath,
        managedBlock,
        legacySource: stripLegacySource(unmanaged, location.hookPath) !== unmanaged,
        hookPresent,
        runtimeValid,
        screens: screenCollectorStatus(location.root),
    };
}

export function planCaptureRcChange(options: CaptureInstallOptions & { action: "install" | "uninstall" }) {
    const location = paths(options);
    const before = readRc(location.rcPath);
    const base = stripManagedBlock(before);
    const sourceLine = `source '${location.hookPath.replace(/'/g, "'\\''")}'`;
    const block = `${START}\n${sourceLine}\n${END}`;
    const installedBlock =
        /(^|\n)# >>> GenesisTools cmux capture >>>\r?\n[\s\S]*?\r?\n# <<< GenesisTools cmux capture <<<(?=\r?\n|$)/;
    const after =
        options.action === "uninstall"
            ? base
            : base !== before
              ? before.replace(installedBlock, (matched, prefix: string) => {
                    const newline = matched.includes("\r\n") ? "\r\n" : "\n";
                    return `${prefix}${block.split("\n").join(newline)}`;
                })
              : `${stripLegacySource(base, location.hookPath)}\n${block}\n`;
    return {
        rcPath: location.rcPath,
        before,
        after,
        block: options.action === "install" ? block : "",
        changesRc: before !== after,
    };
}

async function bundleRuntime(entrypoint: string): Promise<string> {
    const build = await Bun.build({
        entrypoints: [entrypoint],
        target: "bun",
        format: "esm",
        minify: true,
        sourcemap: "none",
        tsconfig: resolve(import.meta.dir, "../../../tsconfig.json"),
        plugins: [
            {
                name: "standalone-capture-diagnostics",
                setup(builder) {
                    builder.onResolve({ filter: /^@genesiscz\/utils\/logger$/ }, () => ({
                        path: resolve(import.meta.dir, "capture-runtime-logger.ts"),
                    }));
                },
            },
        ],
    });
    if (!build.success || build.outputs.length !== 1) {
        throw new Error(`Unable to bundle cmux runtime: ${build.logs.map(String).join("\n")}`);
    }

    return build.outputs[0].text();
}

/** process.execPath can temporarily identify the macOS launcher during concurrent subprocess work. */
export function resolveCaptureBun(options: { searchPath?: string; argv0?: string; execPath?: string } = {}): string {
    const fromPath = Bun.which("bun", { PATH: options.searchPath ?? env.getProcessEnv().PATH ?? "" });
    const candidate =
        fromPath ??
        [options.argv0 ?? process.argv[0], options.execPath ?? process.execPath].find(
            (path) => path && ["bun", "bun.exe"].includes(basename(path))
        );
    if (!candidate || !existsSync(candidate)) {
        throw new Error("Bun executable not found; put Bun on PATH before installing cmux capture.");
    }

    return resolve(candidate);
}

export async function installCapture(
    options: CaptureInstallOptions & { recorderEntrypoint?: string; screens?: boolean } = {}
): Promise<CaptureInstallationStatus & { changed: boolean; backupPath?: string }> {
    const bunPath = resolveCaptureBun();
    const location = paths(options);
    const { before, after } = planCaptureRcChange({ ...options, action: "install" });
    if (options.expectedRc !== undefined && before !== options.expectedRc) {
        throw new Error("Shell configuration changed after preview; review it again before installing.");
    }
    const runtime = await bundleRuntime(options.recorderEntrypoint ?? resolve(import.meta.dir, "../capture-record.ts"));
    const watcher =
        options.screens === false ? undefined : await bundleRuntime(resolve(import.meta.dir, "../capture-watch.ts"));
    const watcherFile = watcher ? `capture-watch-${digest(watcher).slice(0, 16)}.js` : undefined;
    const sha256 = digest(runtime);
    const runtimeFile = `capture-record-${sha256.slice(0, 16)}.js`;
    const runtimePath = join(location.runtimeDir, runtimeFile);
    const hook = renderCaptureShell({
        recorderPath: join(location.runtimeDir, "capture-record.js"),
        bunPath: /\/(?:\.worktrees|node_modules)\//.test(bunPath) ? "" : bunPath,
        preferPathBun: true,
        directory: join(location.root, "command-journal"),
    });
    const runtimeChanged = atomicWrite(runtimePath, runtime);

    const watcherChanged =
        watcher && watcherFile ? atomicWrite(join(location.runtimeDir, watcherFile), watcher) : false;
    if (readRc(location.rcPath) !== before) {
        throw new Error("Shell configuration changed during installation; review it again before installing.");
    }
    const backupPath = replaceRc({ path: location.rcPath, before, after });
    const linkChanged = updateRuntimeLink(location.runtimeDir, runtimeFile);
    const hookChanged = atomicWrite(location.hookPath, hook);
    const manifestChanged = atomicWrite(
        location.manifestPath,
        `${SafeJSON.stringify({ version: 1, runtimeFile, sha256, watcherFile })}\n`
    );
    const collectorChanged = watcherFile
        ? await enableScreenCollector({
              root: location.root,
              runtimePath: join(location.runtimeDir, watcherFile),
              bunPath,
          })
        : disableScreenCollector(location.root);
    return {
        ...captureInstallationStatus(options),
        changed:
            runtimeChanged ||
            linkChanged ||
            watcherChanged ||
            hookChanged ||
            manifestChanged ||
            collectorChanged ||
            before !== after,
        backupPath,
    };
}

export function uninstallCapture(
    options: CaptureInstallOptions = {}
): CaptureInstallationStatus & { changed: boolean; backupPath?: string } {
    const location = paths(options);
    const { before, after } = planCaptureRcChange({ ...options, action: "uninstall" });
    if (options.expectedRc !== undefined && before !== options.expectedRc) {
        throw new Error("Shell configuration changed after preview; review it again before uninstalling.");
    }

    const backupPath = replaceRc({ path: location.rcPath, before, after });
    const collectorChanged = disableScreenCollector(location.root);
    return { ...captureInstallationStatus(options), changed: before !== after || collectorChanged, backupPath };
}
