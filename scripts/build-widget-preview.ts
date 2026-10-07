import { cp, mkdir, readFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env } from "@genesiscz/utils/env";
import { logger, out } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const bundleId = "com.genesiscz.genesistools.widget-preview";
const appName = "GenesisTools Preview.app";
const repo = resolve(import.meta.dir, "..");
const packagePath = join(repo, "src/macos/GenesisWidgetPreview");

async function command(argv: string[]): Promise<string> {
    logger.info({ argv }, "widget preview build command");
    const child = Bun.spawn(argv, { cwd: repo, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => child.kill("SIGTERM"), 600_000);
    try {
        const [exit, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        if (exit !== 0) {
            throw new Error(`${argv[0]} failed: ${stderr}${stdout}`);
        }

        if (stderr.trim()) {
            logger.info(stderr.trim());
        }

        return stdout.trim();
    } finally {
        clearTimeout(timer);
    }
}

async function buildPreview(): Promise<void> {
    await command([
        "swift",
        "build",
        "--package-path",
        packagePath,
        "--configuration",
        "debug",
        "--disable-build-manifest-caching",
    ]);
    const binPath = await command([
        "swift",
        "build",
        "--package-path",
        packagePath,
        "--configuration",
        "debug",
        "--show-bin-path",
    ]);
    const identities = await command(["/usr/bin/security", "find-identity", "-v", "-p", "codesigning"]);
    const identity = identities.match(/\b([A-F0-9]{40})\s+"Developer ID Application:/)?.[1];
    if (!identity) {
        throw new Error(
            "A Developer ID Application identity is required for the isolated preview; no ad-hoc fallback."
        );
    }

    const stamp = String(Date.now());
    const stage = join(repo, ".build", `widget-preview-${stamp}`, appName);
    const contents = join(stage, "Contents");
    await mkdir(join(contents, "MacOS"), { recursive: true });
    await cp(join(binPath, "GenesisWidgetPreview"), join(contents, "MacOS", "GenesisWidgetPreview"));
    const plist =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><dict>' +
        "<key>CFBundleIdentifier</key><string>" +
        bundleId +
        "</string>" +
        "<key>CFBundleExecutable</key><string>GenesisWidgetPreview</string>" +
        "<key>CFBundleName</key><string>GenesisTools Preview</string>" +
        "<key>CFBundleDisplayName</key><string>GenesisTools Preview</string>" +
        "<key>CFBundlePackageType</key><string>APPL</string>" +
        "<key>CFBundleVersion</key><string>" +
        stamp +
        "</string>" +
        "<key>CFBundleShortVersionString</key><string>0.1</string>" +
        "<key>LSMinimumSystemVersion</key><string>14.0</string>" +
        "<key>NSHighResolutionCapable</key><true/>" +
        "<key>NSPrincipalClass</key><string>NSApplication</string>" +
        "</dict></plist>\n";
    await Bun.write(join(contents, "Info.plist"), plist);
    await command([
        "/usr/bin/codesign",
        "--force",
        "--sign",
        identity,
        "--identifier",
        bundleId,
        "--timestamp=none",
        stage,
    ]);
    await command(["/usr/bin/codesign", "--verify", "--strict", stage]);

    const destination = join(env.paths.getHome(), "Applications", appName);
    await mkdir(dirname(destination), { recursive: true });
    let previous: string | undefined;
    if (await Bun.file(join(destination, "Contents", "Info.plist")).exists()) {
        const existing = await command([
            "/usr/bin/plutil",
            "-extract",
            "CFBundleIdentifier",
            "raw",
            "-o",
            "-",
            join(destination, "Contents", "Info.plist"),
        ]);
        if (existing !== bundleId) {
            throw new Error("Refusing to replace an application with a different bundle identity");
        }

        previous = join(toolDataDir("widget-preview", "retired"), stamp, appName);
        await mkdir(dirname(previous), { recursive: true });
        await rename(destination, previous);
    }

    try {
        await rename(stage, destination);
    } catch (error) {
        if (previous) {
            await rename(previous, destination);
        }

        throw error;
    }

    const installed = await readFile(join(destination, "Contents", "Info.plist"), "utf8");
    if (installed.includes("CFBundleURLTypes") || installed.includes("CFBundleDocumentTypes")) {
        throw new Error("Preview must not register production link or document handlers");
    }

    out.result({ appPath: destination, bundleId, executable: "GenesisWidgetPreview", productionAppTargeted: false });
}

await buildPreview();
