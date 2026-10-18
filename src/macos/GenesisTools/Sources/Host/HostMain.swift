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
//
// This is the host's part of the entry point. The executable (Sources/GenesisTools/main.swift) registers the parts
// its build links (hub, widget, Clicky, markdown) and then calls `runHost`; their faces start through `AppParts`.

import Foundation

@MainActor
package func runHost() -> Never {
    let suppliedArguments = Array(CommandLine.arguments.dropFirst())
    let arguments = suppliedArguments.isEmpty && NativePreview.enabled ? ["--widget", "--settings"] : suppliedArguments
    // "" when there is none, so no check below can trap on an argument-less launch.
    let firstArgument = arguments.first ?? ""
    let wantsWindow = arguments.isEmpty || firstArgument == "--window" || firstArgument.hasPrefix("-psn_")

    // GenesisTools --permission-status <kind> | --permission-dialog <kind> | --local-network-rules: the fresh-process grant
    // probe, the permission dialog for faces without a window, and the Local Network answers for the CLI (see
    // PermissionFaces.swift). Before any face setup: none needs it.
    if firstArgument == "--permission-status" {
        runPermissionStatus(Array(arguments.dropFirst()))
    }

    if firstArgument == "--permission-dialog" {
        runPermissionDialog(Array(arguments.dropFirst()))
    }

    if firstArgument == "--local-network-rules" {
        runLocalNetworkRules()
    }

    // A face of a part this build does not link says so first, before the staging gate would only say "staging".
    if AppParts.partOfFace[firstArgument] != nil, !AppParts.has(face: firstArgument) {
        AppParts.run(face: firstArgument, Array(arguments.dropFirst()))
    }

    // The widget and Clicky are in staging: the Preview bundles run them, and the normal app only after
    // `bun scripts/native/staging.ts on` on this machine (NativeStaging), so a normal install or `tools update` never does.
    if NativeStaging.refuses(arguments, facesEnabled: NativeStaging.facesEnabled) {
        FileHandle.standardError.write(Data(
            "GenesisTools: \(firstArgument) is in staging. Run it in the Preview app (bun scripts/build-widget-preview.ts) or turn it on for this machine (bun scripts/native/staging.ts on).\n".utf8
        ))
        exit(64)
    }

    // Every face except the launcher: Launch Services starts them with launchd's bare environment, and
    // their `tools` children then miss glab, gh, bun and the login shell's CA bundle. The window faces
    // take the login shell's values; the short-lived ones (--rpc, --mic) only the usual PATH directories.
    // The launcher passes its caller's environment through untouched.
    if wantsWindow || firstArgument.hasPrefix("-") || firstArgument.contains("://") {
        let hubLink = firstArgument.hasPrefix("genesis-tools://hub")
        let windowFace = wantsWindow || AppParts.partOfFace[firstArgument] != nil || hubLink
        ChildEnvironment.install(loginShell: windowFace, refresh: arguments.first == "--hub" || hubLink)
        // A face that is (or runs under) this bundle's responsible process tells its `tools` children to
        // skip the launcher; one started from a plain terminal clears the markers (App/FaceMarker.swift).
        if !NativePreview.enabled { FaceMarker.install() }
        // A rebuild reopens the settings, hub, review, widget and Clicky faces with these exact arguments (App/FaceRecord.swift).
        if !NativePreview.enabled { FaceRecord.write(arguments) }
    }

    // GenesisTools --link-relay: the windowless face that takes every link Launch Services delivers to a running
    // instance, so no window face is raised by a click (LinkRelay.swift). Each window face starts it first.
    if firstArgument == LinkRelay.argument {
        if NativePreview.enabled { exit(0) }
        LinkRelay.run()
    }

    if !NativePreview.enabled && LinkRelay.shouldEnsure(arguments) {
        LinkRelay.ensure(arguments)
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
        if let hubArgs = HubLink.arguments(fromLink: firstArgument) {
            // A link click starts this process in the background: without the hub, an alert names the command.
            if !AppParts.has(face: "--hub") {
                AppParts.alertMissing(face: "--hub")
            }
            AppParts.run(face: "--hub", hubArgs)
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

    // GenesisTools --parts: the optional parts this build links, one id per line (src/macos/lib/permissions/parts.ts).
    if firstArgument == "--parts" {
        for id in AppParts.linked {
            print(id)
        }
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

    // The faces of the optional parts: --hub (sessions, transcripts, changes, decisions; Parts/Hub/Hub/HubWindow.swift),
    // --review (the diff review window, Parts/Hub/Review/ReviewWindow.swift), --widget, --clicky, and --markdown
    // (GenesisKit's markdown viewer, Parts/Markdown/MarkdownFace.swift).
    if AppParts.partOfFace[firstArgument] != nil {
        AppParts.run(face: firstArgument, Array(arguments.dropFirst()))
    }

    runLauncher(arguments)
}
