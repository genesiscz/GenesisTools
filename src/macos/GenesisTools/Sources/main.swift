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
    runWindowApp()
}

if arguments[0] == "--help" || arguments[0] == "-h" {
    launcherUsage()
}

if arguments[0] == "--version" {
    print(bundleVersion())
    exit(0)
}

runLauncher(arguments)
