import { createHash } from "node:crypto";
import { cp, mkdir, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { buildDiffViewer } from "@app/macos/lib/permissions/app";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger, out } from "@genesiscz/utils/logger";
import { toolDataDir } from "@genesiscz/utils/storage/root";

const bundleId = "com.genesiscz.genesistools.widget-preview";
const appName = "GenesisTools Preview.app";
const repo = resolve(import.meta.dir, "..");
const packagePath = join(repo, "src/macos/GenesisTools");
/** The paths the build provenance describes: the digest hashes them and `workingTree` reports changes in them only. */
const nativePaths = ["src/macos/GenesisKit", "src/macos/GenesisTools", "scripts/build-widget-preview.ts"];

interface SourceSnapshot {
    commit: string;
    nativeSourceDigest: string;
    workingTree: "clean" | "wip";
}

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

async function nativeSourceDigest(): Promise<string> {
    const description: { targets: { name: string; path: string; sources: string[] }[] } = SafeJSON.parse(
        await command(["swift", "package", "--package-path", "src/macos/GenesisKit", "describe", "--type", "json"]),
        { strict: true }
    );
    const kit = description.targets.find((target) => target.name === "GenesisKit");
    if (!kit?.sources.length) {
        throw new Error("SwiftPM did not report the GenesisKit sources; build provenance cannot be established.");
    }
    const compiledKitSources = new Set(kit.sources.map((name) => `src/macos/GenesisKit/${kit.path}/${name}`));
    const names = await command([
        "git",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ...nativePaths,
    ]);
    const hash = createHash("sha256");
    for (const name of [...new Set(names.split("\0").filter(Boolean))].sort()) {
        if (
            name.includes("/Tests/") ||
            (name.startsWith("src/macos/GenesisKit/Sources/") &&
                name.endsWith(".swift") &&
                !compiledKitSources.has(name))
        ) {
            continue;
        }
        const file = Bun.file(join(repo, name));
        if (await file.exists()) {
            hash.update(name)
                .update("\0")
                .update(Buffer.from(await file.arrayBuffer()));
        }
    }
    return hash.digest("hex");
}

/**
 * Everything PreviewBuild.json claims about the sources, read together. `wip` means a tracked change or an
 * untracked file under `nativePaths` (tests excluded, as in the digest); edits elsewhere in the repo do not count.
 */
async function sourceSnapshot(): Promise<SourceSnapshot> {
    const commit = await command(["git", "rev-parse", "HEAD"]);
    const digest = await nativeSourceDigest();
    const trackedDirty = await command(["git", "diff", "--name-only", "-z", "HEAD", "--", ...nativePaths]);
    const untracked = await command(["git", "ls-files", "-z", "--others", "--exclude-standard", "--", ...nativePaths]);
    const changed = `${trackedDirty}\0${untracked}`.split("\0").filter((name) => name && !name.includes("/Tests/"));
    return { commit, nativeSourceDigest: digest, workingTree: changed.length > 0 ? "wip" : "clean" };
}

async function buildPreview(): Promise<void> {
    const before = await sourceSnapshot();
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
    await cp(join(binPath, "GenesisTools"), join(contents, "MacOS", "GenesisWidgetPreview"));
    const after = await sourceSnapshot();
    if (
        after.commit !== before.commit ||
        after.nativeSourceDigest !== before.nativeSourceDigest ||
        after.workingTree !== before.workingTree
    ) {
        throw new Error(
            "The commit, native sources or working tree changed during the build; retry with a stable source snapshot."
        );
    }

    await Bun.write(
        join(contents, "Resources", "PreviewBuild.json"),
        SafeJSON.stringify({
            ...before,
            builtAt: new Date().toISOString(),
            unsignedBinarySHA256: createHash("sha256")
                .update(Buffer.from(await Bun.file(join(binPath, "GenesisTools")).arrayBuffer()))
                .digest("hex"),
        })
    );
    await buildDiffViewer(contents, (step) => logger.info(step));
    await cp(join(packagePath, "scripts/AppIcon.icns"), join(contents, "Resources/AppIcon.icns"));
    const plist =
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0"><dict>' +
        "<key>CFBundleIdentifier</key><string>" +
        bundleId +
        "</string>" +
        "<key>CFBundleExecutable</key><string>GenesisWidgetPreview</string>" +
        "<key>CFBundleName</key><string>GenesisTools Preview</string>" +
        "<key>CFBundleIconFile</key><string>AppIcon</string>" +
        "<key>CFBundleDisplayName</key><string>GenesisTools Preview</string>" +
        "<key>GenesisToolsPreview</key><true/>" +
        "<key>NSMicrophoneUsageDescription</key><string>Transcribe speech that you explicitly record.</string>" +
        "<key>GenesisToolsWidgetCLI</key><string>" +
        join(repo, "widget-tools").replaceAll("&", "&amp;").replaceAll("<", "&lt;") +
        "</string>" +
        "<key>GenesisToolsWidgetStateRoot</key><string>" +
        toolDataDir("widget-preview", "data").replaceAll("&", "&amp;").replaceAll("<", "&lt;") +
        "</string>" +
        "<key>CFBundlePackageType</key><string>APPL</string>" +
        "<key>CFBundleVersion</key><string>" +
        stamp +
        "</string>" +
        "<key>CFBundleShortVersionString</key><string>0.1</string>" +
        "<key>LSMinimumSystemVersion</key><string>14.0</string>" +
        "<key>NSHighResolutionCapable</key><true/>" +
        "<key>NSPrincipalClass</key><string>NSApplication</string>" +
        "</dict></plist>\n";
    if (plist.includes("CFBundleURLTypes") || plist.includes("CFBundleDocumentTypes")) {
        throw new Error("Preview must not register production link or document handlers");
    }

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

    out.result({ appPath: destination, bundleId, executable: "GenesisWidgetPreview", productionAppTargeted: false });
}

await buildPreview();
