// GenesisTools.app (built by `tools macos permissions build`).
//
// Two faces, one signed bundle, so macOS sees one identity:
//   GenesisTools <program> [args...]   launcher: makes this bundle the TCC "responsible process"
//                                      for the tool it runs (see Launcher.swift)
//   GenesisTools                       no arguments (Finder, `open -a GenesisTools`,
//                                      `tools macos permissions ui`): the settings window
//                                      (see App/GenesisToolsApp.swift)
//
// The launcher path never touches AppKit, so a `tools` run costs two tiny processes and no
// Dock icon; the window path opts into a regular app with `NSApplication`.

import Foundation

let arguments = Array(CommandLine.arguments.dropFirst())
// "" when there is none, so no check below can trap on an argument-less launch.
let firstArgument = arguments.first ?? ""
let wantsWindow = arguments.isEmpty || firstArgument == "--window" || firstArgument.hasPrefix("-psn_")

// Every face except the launcher: Launch Services starts them with launchd's bare environment, and
// their `tools` children then miss glab, gh, bun and the login shell's CA bundle. The window faces
// take the login shell's values; the short-lived ones (--rpc, --mic) only the usual PATH directories.
// The launcher passes its caller's environment through untouched.
if wantsWindow || firstArgument.hasPrefix("-") || firstArgument.contains("://") {
    let hubLink = firstArgument.hasPrefix("genesis-tools://hub")
    let windowFace = wantsWindow || firstArgument == "--hub" || firstArgument == "--review" || hubLink
    ChildEnvironment.install(loginShell: windowFace, refresh: arguments.first == "--hub" || hubLink)
    // A face that is (or runs under) this bundle's responsible process tells its `tools` children to
    // skip the launcher; one started from a plain terminal clears the markers (App/FaceMarker.swift).
    FaceMarker.install()
}

if wantsWindow {
    // Only an explicit --window is certainly a request for the window. A bare launch may instead be
    // macOS relaunching this bundle to deliver a notification click, which looks identical here.
    runWindowApp(showWindowImmediately: arguments.first == "--window")
}

// Only the first argument: the link forwarder passes the URL alone, and a URL later in the argv is
// a value of the program the launcher runs (`GenesisTools <program> https://...`) or of `--rpc`.
if firstArgument.contains("://"), !firstArgument.hasPrefix("-") {
    // `genesis-tools://hub?…` opens a place in the hub (the running one takes it); every other link is routed.
    if let hubArgs = HubRequest.arguments(fromLink: firstArgument) {
        runHub(hubArgs)
    }
    runBrowserLink(firstArgument)
}

if firstArgument == "--help" || firstArgument == "-h" {
    launcherUsage()
}

if firstArgument == "--version" {
    print(bundleVersion())
    exit(0)
}

// GenesisTools --default-browser set|restore|status: make this bundle the http(s) handler (macOS asks
// the user to confirm), give http(s) back to the browser recorded before, or print the handler.
// It replaced the separate "Genesis Router.app" (see BrowserURL.swift).
if firstArgument == "--default-browser" {
    runDefaultBrowser(Array(arguments.dropFirst()))
}

// GenesisTools --rpc '<json>' (or --rpc - to read stdin): run one request as this bundle, then
// exit. The reply is one JSON line on stdout. This is the door a unix socket would replace without
// changing the envelope, so it stays the single entry point for anything the CLI wants done under
// this bundle's identity (see Notify.swift).
if firstArgument == "--rpc" {
    runRpc(Array(arguments.dropFirst()))
}

// GenesisTools --mic [--rate 16000]: stream microphone PCM on stdout as this bundle, so the
// microphone grant attaches to GenesisTools (see Mic.swift).
if firstArgument == "--mic" {
    runMic(Array(arguments.dropFirst()))
}

// GenesisTools --capsule [--theme dark|light] [--screen main|<index>] [--position bottom|top]: draw
// the floating voice capsule, fed one JSON event per line on stdin (see Capsule.swift).
if firstArgument == "--capsule" {
    runCapsule(Array(arguments.dropFirst()))
}

// GenesisTools --hub [--session <id>] [--tab transcript|changes|files|decisions] [--snapshot <png>]:
// every agent session with its transcript, changes, files and decisions (see Hub/HubWindow.swift).
if firstArgument == "--hub" {
    runHub(Array(arguments.dropFirst()))
}

// GenesisTools --review [--repo <path>] [--style split|unified] [--snapshot <png>]: the diff review
// window (see Review/ReviewWindow.swift).
if firstArgument == "--review" {
    runReview(Array(arguments.dropFirst()))
}

runLauncher(arguments)
