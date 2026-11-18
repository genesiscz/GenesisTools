import { swiftJobArgs, withAppBuildSlot } from "@app/macos/lib/permissions/app";

// SwiftPM's own lock is per scratch tree. Share the app's build slot across packages and Git worktrees.
const [command, ...args] = process.argv.slice(2);
if (command !== "build" && command !== "test") {
    throw new Error("Usage: bun scripts/native/swift-package.ts <build|test> [SwiftPM options]");
}

process.exitCode = await withAppBuildSlot(async () => {
    const child = Bun.spawn(["swift", command, ...swiftJobArgs(args), ...args], {
        stdio: ["inherit", "inherit", "inherit"],
    });
    return await child.exited;
});
