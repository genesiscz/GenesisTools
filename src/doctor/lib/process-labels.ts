interface Rule {
    pattern: RegExp;
    label: string;
    match?: "comm" | "command" | "both";
}

const RULES: Rule[] = [
    { pattern: /^kernel_task$/, label: "macOS kernel" },
    { pattern: /^launchd$/, label: "launchd init" },
    { pattern: /^loginwindow$/, label: "macOS login" },
    { pattern: /^WindowServer$/, label: "macOS graphics" },
    { pattern: /^mds(_stores)?$/, label: "Spotlight index" },
    { pattern: /^mdworker/, label: "Spotlight worker" },
    { pattern: /^coreaudiod$/, label: "Core Audio" },
    { pattern: /^bluetoothd$/, label: "Bluetooth daemon" },
    { pattern: /^locationd$/, label: "Location daemon" },
    { pattern: /^airportd$/, label: "Wi-Fi daemon" },
    { pattern: /^cfprefsd$/, label: "Preferences daemon" },
    { pattern: /^UserEventAgent$/, label: "User events" },
    { pattern: /^secd$/, label: "Security daemon" },
    { pattern: /^trustd$/, label: "Trust daemon" },
    { pattern: /^powerd$/, label: "Power daemon" },
    { pattern: /^configd$/, label: "Config daemon" },
    { pattern: /^syslogd$/, label: "Syslog" },
    { pattern: /^nsurlsessiond$/, label: "URL session" },
    { pattern: /^PerfPowerServices$/, label: "Apple power metrics" },
    { pattern: /^ApplicationsStorageExtension$/, label: "Storage scanner" },
    { pattern: /^StorageManagementService$/, label: "Storage mgmt" },
    { pattern: /^sysmond$/, label: "System monitor" },
    { pattern: /^SafariHistoryServiceAgent$/, label: "Safari history" },
    { pattern: /^Finder$/, label: "Finder" },
    { pattern: /^Dock$/, label: "macOS Dock" },
    { pattern: /^SystemUIServer$/, label: "System UI" },
    { pattern: /^ControlCenter$/, label: "Control Center" },
    { pattern: /^NotificationCenter$/, label: "Notification Center" },
    { pattern: /^Spotlight$/, label: "Spotlight" },
    { pattern: /^caffeinate$/, label: "Prevents sleep" },
    { pattern: /Virtualization\.xpc|VirtualMachine/, label: "macOS VM", match: "command" },
    { pattern: /\/tsgo$|tsgo$/, label: "TS compiler" },
    { pattern: /^bun$/, label: "Bun runtime" },
    { pattern: /^deno$/, label: "Deno runtime" },
    { pattern: /^node$/, label: "Node.js runtime" },
    { pattern: /^python3?$/, label: "Python runtime" },
    { pattern: /^ruby$/, label: "Ruby runtime" },
    { pattern: /^java$/, label: "Java runtime" },
    { pattern: /^go$/, label: "Go runtime" },
    { pattern: /^cargo$/, label: "Cargo build" },
    { pattern: /^rustc$/, label: "Rust compiler" },
    { pattern: /^docker$|com\.docker/, label: "Docker", match: "both" },
    { pattern: /colima/, label: "Colima VM", match: "command" },
    { pattern: /^Cursor Helper/, label: "Cursor editor" },
    { pattern: /^Cursor$/, label: "Cursor editor" },
    { pattern: /^Code Helper|^Code$/, label: "VS Code" },
    { pattern: /\/Visual Studio Code\.app\//, label: "VS Code", match: "command" },
    { pattern: /\/Xcode\.app\//, label: "Xcode", match: "command" },
    {
        pattern: /^WebStorm|^PhpStorm|^IntelliJ|^GoLand|^PyCharm|^RubyMine|^CLion|^DataGrip|^RustRover/,
        label: "JetBrains IDE",
    },
    {
        pattern: /\/Applications\/(WebStorm|PhpStorm|IntelliJ|GoLand|PyCharm|RubyMine|CLion|DataGrip|RustRover)/,
        label: "JetBrains IDE",
        match: "command",
    },
    { pattern: /^Sublime Text$/, label: "Sublime Text" },
    { pattern: /^Zed$/, label: "Zed editor" },
    { pattern: /^GitKraken Helper/, label: "GitKraken app" },
    { pattern: /^GitKraken$/, label: "GitKraken app" },
    { pattern: /^Sourcetree/, label: "Sourcetree" },
    { pattern: /^Tower/, label: "Tower git" },
    { pattern: /^iTerm2?$/, label: "iTerm terminal" },
    { pattern: /^Terminal$/, label: "Terminal" },
    { pattern: /^Warp$/, label: "Warp terminal" },
    { pattern: /^Ghostty$/, label: "Ghostty terminal" },
    { pattern: /Brave Browser/, label: "Brave browser", match: "both" },
    { pattern: /Google Chrome/, label: "Chrome browser", match: "both" },
    { pattern: /\/Safari\.app\/|^Safari$/, label: "Safari", match: "both" },
    { pattern: /firefox|Firefox/, label: "Firefox", match: "both" },
    { pattern: /\/Arc\.app\/|^Arc( Helper)?$/, label: "Arc browser", match: "both" },
    { pattern: /\/Orion\.app\/|^Orion( Helper)?$/, label: "Orion browser", match: "both" },
    { pattern: /^Microsoft Teams/, label: "Teams" },
    { pattern: /^Slack( Helper)?/, label: "Slack" },
    { pattern: /^Discord( Helper)?/, label: "Discord" },
    { pattern: /^zoom\.us$|^zoom$/, label: "Zoom" },
    { pattern: /^Signal( Helper)?/, label: "Signal" },
    { pattern: /^WhatsApp/, label: "WhatsApp" },
    { pattern: /^Telegram/, label: "Telegram" },
    { pattern: /^Notion( Helper)?/, label: "Notion" },
    { pattern: /^Obsidian( Helper)?/, label: "Obsidian" },
    { pattern: /^1Password( 7| 8)?( Helper)?/, label: "1Password" },
    { pattern: /^Raycast/, label: "Raycast" },
    { pattern: /^Alfred/, label: "Alfred" },
    { pattern: /^Rectangle/, label: "Rectangle window" },
    { pattern: /^iStatistica|^Stats$/, label: "System stats" },
    { pattern: /^Amphetamine$/, label: "Amphetamine" },
    { pattern: /^Spotify( Helper)?/, label: "Spotify" },
    { pattern: /^Music$/, label: "Apple Music" },
    { pattern: /^Mail$/, label: "Apple Mail" },
    { pattern: /^Messages$/, label: "Messages" },
    { pattern: /^Calendar$/, label: "Apple Calendar" },
    { pattern: /^Photos( Agent)?$/, label: "Apple Photos" },
    { pattern: /^iCloud/, label: "iCloud sync" },
    { pattern: /^cloudd$/, label: "iCloud daemon" },
    { pattern: /^bird$/, label: "iCloud Drive" },
    { pattern: /^photoanalysisd$/, label: "Photos analysis" },
    { pattern: /^claude$/, label: "Claude Code" },
    { pattern: /^tools$/, label: "GenesisTools CLI" },
    { pattern: /genesis-tools/, label: "GenesisTools CLI", match: "command" },
];

export interface ProcessInfo {
    comm: string;
    command: string;
}

function haystackForRule(rule: Rule, info: ProcessInfo): string {
    if (rule.match === "command") {
        return info.command;
    }

    if (rule.match === "both") {
        return `${info.comm} ${info.command}`;
    }

    return info.comm;
}

export function labelForProcess(info: ProcessInfo): string | null {
    for (const rule of RULES) {
        const haystack = haystackForRule(rule, info);
        if (rule.pattern.test(haystack)) {
            return rule.label;
        }
    }

    return null;
}
