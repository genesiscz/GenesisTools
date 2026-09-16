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

if arguments[0] == "--help" || arguments[0] == "-h" {
    launcherUsage()
}

if arguments[0] == "--version" {
    print(bundleVersion())
    exit(0)
}

// GenesisTools --rpc '<json>' (or --rpc - to read stdin): run one request as this bundle, then
// exit. The reply is one JSON line on stdout. This is the door a unix socket would replace without
// changing the envelope, so it stays the single entry point for anything the CLI wants done under
// this bundle's identity (see Notify.swift).
if arguments[0] == "--rpc" {
    runRpc(Array(arguments.dropFirst()))
}

runLauncher(arguments)
