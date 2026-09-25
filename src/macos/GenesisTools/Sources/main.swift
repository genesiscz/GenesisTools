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
let wantsWindow = arguments.isEmpty || arguments[0] == "--window" || arguments[0].hasPrefix("-psn_")

if wantsWindow {
    // Only an explicit --window is certainly a request for the window. A bare launch may instead be
    // macOS relaunching this bundle to deliver a notification click, which looks identical here.
    runWindowApp(showWindowImmediately: arguments.first == "--window")
}

// Only the first argument: the link forwarder passes the URL alone, and a URL later in the argv is
// a value of the program the launcher runs (`GenesisTools <program> https://...`) or of `--rpc`.
if arguments[0].contains("://"), !arguments[0].hasPrefix("-") {
    runBrowserLink(arguments[0])
}

if arguments[0] == "--help" || arguments[0] == "-h" {
    launcherUsage()
}

if arguments[0] == "--version" {
    print(bundleVersion())
    exit(0)
}

// GenesisTools --default-browser set|restore|status: make this bundle the http(s) handler (macOS asks
// the user to confirm), give http(s) back to the browser recorded before, or print the handler.
// It replaced the separate "Genesis Router.app" (see BrowserURL.swift).
if arguments[0] == "--default-browser" {
    runDefaultBrowser(Array(arguments.dropFirst()))
}

// GenesisTools --rpc '<json>' (or --rpc - to read stdin): run one request as this bundle, then
// exit. The reply is one JSON line on stdout. This is the door a unix socket would replace without
// changing the envelope, so it stays the single entry point for anything the CLI wants done under
// this bundle's identity (see Notify.swift).
if arguments[0] == "--rpc" {
    runRpc(Array(arguments.dropFirst()))
}

// GenesisTools --mic [--rate 16000]: stream microphone PCM on stdout as this bundle, so the
// microphone grant attaches to GenesisTools (see Mic.swift).
if arguments[0] == "--mic" {
    runMic(Array(arguments.dropFirst()))
}

// GenesisTools --capsule [--theme dark|light] [--screen main|<index>] [--position bottom|top]: draw
// the floating voice capsule, fed one JSON event per line on stdin (see Capsule.swift).
if arguments[0] == "--capsule" {
    runCapsule(Array(arguments.dropFirst()))
}

// GenesisTools --hub [--session <id>] [--tab transcript|changes|files|decisions] [--snapshot <png>]:
// every agent session with its transcript, changes, files and decisions (see Hub/HubWindow.swift).
if arguments[0] == "--hub" {
    runHub(Array(arguments.dropFirst()))
}

// GenesisTools --review [--repo <path>] [--style split|unified] [--snapshot <png>]: the diff review
// window (see Review/ReviewWindow.swift).
if arguments[0] == "--review" {
    runReview(Array(arguments.dropFirst()))
}

runLauncher(arguments)
