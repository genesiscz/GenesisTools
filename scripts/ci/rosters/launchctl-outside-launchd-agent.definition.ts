import { defineRoster } from "./define";

/** C47: the daemon, automate and youtube agents each rendered a plist and called launchctl by hand. */
export default defineRoster({
    name: "roster-launchctl-outside-launchd-agent",
    candidate: "C47",
    message:
        "Install, start, stop and read a launchd agent through @genesiscz/utils/process/launchd-agent " +
        "(renderLaunchdPlist, installLaunchd, kickstartLaunchd, launchdStatus, uninstallLaunchd); it restores the old " +
        "plist when a load fails. A new `launchctl` call outside that module repeats the three copies C47 removed.",
    matcher: { rule: { kind: "string", regex: "^[\"'`]launchctl[\"'`]$" } },
    onlyIn: /^src\//,
    allowedIn: /^src\/utils\/process\/launchd-agent\.ts$/,
});
