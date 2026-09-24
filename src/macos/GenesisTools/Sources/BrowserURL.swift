import AppKit
import Foundation
import LocalAuthentication

/// Set synchronously from the URL event, before the bare-launch grace period opens the window.
var browserLinkReceived = false
private var browserLinkFinished = false
/// True while a route's command runs off the main thread. A click on the toast then waits for the
/// command to end instead of quitting under it (the child's output pipe would close mid-run).
private var browserCommandRunning = false

func installBrowserURLHandler() {
    NSAppleEventManager.shared().setEventHandler(
        BrowserURLHandler.shared,
        andSelector: #selector(BrowserURLHandler.handle(_:reply:)),
        forEventClass: AEEventClass(kInternetEventClass),
        andEventID: AEEventID(kAEGetURL)
    )
}

/// For a window face (`--hub`, `--review`): GenesisTools.app is the https handler, and macOS hands a
/// link to the RUNNING instance of the bundle, so an open hub received every click and routed none
/// ("the mail link opens the hub", 2026-09-24). `handleBrowserLink` hides this process's windows and
/// quits it when its toast ends, so the link is routed in a fresh process instead (argv, no shell).
func installBrowserURLForwarder() {
    BrowserURLForwarder.shared.trackOtherApps()
    NSAppleEventManager.shared().setEventHandler(
        BrowserURLForwarder.shared,
        andSelector: #selector(BrowserURLForwarder.handle(_:reply:)),
        forEventClass: AEEventClass(kInternetEventClass),
        andEventID: AEEventID(kAEGetURL)
    )
}

private final class BrowserURLForwarder: NSObject {
    static let shared = BrowserURLForwarder()
    /// The app that was active before macOS activated this face to deliver a link: the one the link
    /// was clicked in. `deactivate()` alone is not enough: when the router's toast process quits,
    /// macOS brings back the most recently active app, which is this face again.
    private var lastOtherApp: NSRunningApplication?

    func trackOtherApps() {
        let own = ProcessInfo.processInfo.processIdentifier
        if let front = NSWorkspace.shared.frontmostApplication, front.processIdentifier != own {
            lastOtherApp = front
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] note in
            guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  app.bundleIdentifier != Bundle.main.bundleIdentifier
            else { return }
            self?.lastOtherApp = app
        }
    }

    @objc func handle(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let raw = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              raw.contains("://")
        else { return }
        // A new instance started by LaunchServices, not a child Process: a child inherits this face's
        // session, and a route's `open message://…` then failed inside LaunchServices
        // (`_LSOpenURLsWithCompletionHandler() failed`, 2026-09-24).
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.arguments = [raw]
        configuration.createsNewApplicationInstance = true
        configuration.activates = false
        NSWorkspace.shared.openApplication(at: Bundle.main.bundleURL, configuration: configuration) { _, error in
            if let error {
                FileHandle.standardError.write(Data("link forward failed: \(error)\n".utf8))
                HubPerf.log("link forward failed: \(error)")
            }
        }
        HubPerf.log("link forwarded to a new router instance: \(raw.prefix(80))")
        // macOS activated this window face to deliver the link; give the focus back to the app the
        // link was clicked in, so the hub does not jump in front of it.
        let previous = lastOtherApp
        DispatchQueue.main.async {
            if let previous, !previous.isTerminated {
                previous.activate()
            } else {
                NSApp.deactivate()
            }
        }
    }
}

func runBrowserLink(_ raw: String) -> Never {
    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    handleBrowserLink(raw)
    if !browserLinkFinished {
        app.run()
    }
    exit(0)
}

func handleBrowserLink(_ raw: String) {
    browserLinkReceived = true
    let previous = NSWorkspace.shared.frontmostApplication
    NSApp.setActivationPolicy(.accessory)
    NSApp.deactivate()
    for window in NSApp.windows where !(window is RouteToastCard) {
        window.orderOut(nil)
    }
    let decision: RouteDecision
    do {
        decision = try routeURL(raw, configData: try loadConfigData())
    } catch {
        finishBrowserLink(message: "\(error)", failedURL: raw, toast: nil)
        return
    }

    NSApp.setActivationPolicy(.accessory)
    let copy = toastCopy(decision)
    let choice = RouteToast.choice(routeIndex: decision.routeIndex, fallbackTitle: copy.kicker)
    let card: RouteToastCard? = choice.enabled
        ? RouteToast.show(
            kicker: choice.title ?? copy.kicker,
            headline: choice.name ?? copy.headline,
            detail: copy.detail,
            seconds: choice.seconds,
            done: {
                browserLinkFinished = true
                if !browserCommandRunning {
                    NSApp.terminate(nil)
                }
            }
        )
        : nil
    NSApp.deactivate()

    Task { @MainActor in
        browserCommandRunning = true
        let outcome: Result<BrowserOutcome, Error>
        do {
            outcome = .success(try await performBrowserDecision(decision, toastEnabled: card != nil))
        } catch {
            outcome = .failure(error)
        }
        browserCommandRunning = false
        if browserLinkFinished {
            // The toast was clicked away while the command ran; its quit waited for the command.
            NSApp.terminate(nil)
            return
        }

        switch outcome {
        case .success(.denied):
            card?.append("Denied")
        case .success(.recorded(let message)):
            card?.append(message)
        case .success(.ran):
            if let note = decision.notify, !note.isEmpty, note != copy.headline, !copy.detail.contains(note) {
                card?.append(note)
            }
        case .failure(let error):
            card?.append("\(error)")
            finishBrowserLink(message: "\(error)", failedURL: raw, toast: card)
            return
        }
        yieldFocus(to: previous)
        if let card {
            card.holdThenFade()
        } else {
            NSApp.terminate(nil)
        }
    }
}

private func finishBrowserLink(message: String, failedURL: String?, toast: RouteToastCard?) {
    if let toast {
        toast.append(message)
        toast.holdThenFade()
        return
    }
    browserLinkFinished = true
    notifyBrowser(message)
    guard let failedURL, !message.contains("link used up") else {
        NSApp.terminate(nil)
        return
    }
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    task.arguments = fallbackOpenArguments(failedURL)
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        FileHandle.standardError.write(Data("router: could not open \(failedURL) in a fallback browser: \(error)\n".utf8))
    }
    NSApp.terminate(nil)
}

/// Where a link goes when routing failed: the browser recorded before GenesisTools took http(s), else
/// Brave when installed, else Safari. Never a link router, which would hand the link straight back.
private func fallbackOpenArguments(_ url: String) -> [String] {
    let recorded = (try? Data(contentsOf: configDirectory().appendingPathComponent("previous.json"))).flatMap { data in
        (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["appPath"]
    }
    if let path = recorded, FileManager.default.fileExists(atPath: path),
       !linkRouterBundleIDs.contains(Bundle(url: URL(fileURLWithPath: path))?.bundleIdentifier ?? "") {
        return ["-a", path, url]
    }
    if NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.brave.Browser") != nil {
        return ["-b", "com.brave.Browser", url]
    }
    return ["-b", "com.apple.Safari", url]
}

private struct ToastCopy {
    var kicker: String
    var headline: String
    var detail: String
}

private func yieldFocus(to previous: NSRunningApplication?) {
    let ours = Bundle.main.bundleIdentifier
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == ours else { return }
    guard let previous, previous.bundleIdentifier != ours else {
        NSApp.deactivate()
        return
    }
    previous.activate(options: [.activateIgnoringOtherApps])
}

private func decoded(_ value: String) -> String {
    value.removingPercentEncoding ?? value
}

private func toastCopy(_ decision: RouteDecision) -> ToastCopy {
    let clicked = decoded(decision.original)
    if decision.kind == "run" {
        return runCopy(argv: decision.argv ?? [], clicked: clicked)
    }

    let destination = decoded(decision.url)
    if destination.hasPrefix("genesis-md://") {
        let path = URLComponents(string: decision.url)?.queryItems?.first { $0.name == "path" }?.value ?? ""
        if !path.isEmpty {
            let file = URL(fileURLWithPath: path)
            return ToastCopy(kicker: "Opening", headline: file.lastPathComponent, detail: destination)
        }
        return ToastCopy(kicker: "Opening", headline: "Open in Genesis", detail: destination)
    }

    return ToastCopy(kicker: "Opening", headline: destination, detail: clicked == destination ? "" : clicked)
}

/// Headline = what runs, in words (`open-in-mail.ts 1040832` -> "Open in mail"); the parameter
/// values go to the detail line. `--title` still wins, and a route `name` wins over both.
private func runCopy(argv: [String], clicked: String) -> ToastCopy {
    var title: String?
    var subtitle: String?
    var words: [String] = []
    var index = 1
    while index < argv.count {
        let arg = argv[index]
        if arg == "--title", index + 1 < argv.count {
            title = argv[index + 1]
            index += 2
            continue
        }
        if arg == "--subtitle", index + 1 < argv.count {
            subtitle = argv[index + 1]
            index += 2
            continue
        }
        if arg.hasPrefix("-") {
            index += 1
            if index < argv.count, !argv[index].hasPrefix("-") {
                index += 1
            }
            continue
        }
        if !arg.hasPrefix("/") {
            words.append(arg)
        }
        index += 1
    }
    let command = commandName(argv)
    if let consumed = command.consumed, let at = words.firstIndex(of: consumed) {
        words.remove(at: at)
    }
    let headline = title ?? command.label
    let detail = ([subtitle].compactMap { $0 } + words.filter { $0 != headline }).joined(separator: "\n")
    return ToastCopy(kicker: "Running", headline: headline, detail: detail.isEmpty ? clicked : detail)
}

/// `bun .../rohlik.ts add 12` -> "Rohlik add", `tools say ...` -> "Say", `open-in-mail.ts` -> "Open in mail".
/// `consumed` is the subcommand word that went into the label, so the detail line can skip it.
private func commandName(_ argv: [String]) -> (label: String, consumed: String?) {
    guard let program = argv.first else { return ("Command", nil) }
    var base = (program as NSString).lastPathComponent
    var next = 1
    let runners: Set<String> = ["bun", "node", "deno", "python", "python3", "sh", "bash", "zsh"]
    if runners.contains(base), argv.count > 1, argv[1].contains("/") {
        base = ((argv[1] as NSString).lastPathComponent as NSString).deletingPathExtension
        next = 2
    }
    var consumed: String?
    if next < argv.count, argv[next].range(of: "^[a-z][a-z-]*$", options: .regularExpression) != nil {
        consumed = argv[next]
    }
    let parts = (base == "tools" ? [] : [base]) + [consumed].compactMap { $0 }
    let spaced = parts.joined(separator: " ").replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
    let label = spaced.prefix(1).uppercased() + spaced.dropFirst()
    return (label.isEmpty ? "Command" : label, consumed)
}

private func prettyName(_ script: String) -> String {
    if script.contains("mail") { return "Mail" }
    return script.replacingOccurrences(of: "-", with: " ").capitalized
}

private func shorten(_ path: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    if path.hasPrefix(home) {
        return "~" + path.dropFirst(home.count)
    }
    return path
}

private enum BrowserOutcome {
    case ran
    /// Touch ID failed or the approval card was denied: nothing ran.
    case denied
    /// A `tool` route: recorded, never run. The message says so on the card.
    case recorded(String)
}

/// Touch ID, the approval card and the toast stay on the main thread; the command and `open` run off
/// it, so a route that takes seconds does not freeze the toast or the app.
@MainActor
private func performBrowserDecision(_ decision: RouteDecision, toastEnabled: Bool) async throws -> BrowserOutcome {
    if decision.kind == "run" {
        let argv = decision.argv ?? []
        if decision.touchId && !requireBrowserTouchID() { return .denied }
        if decision.needsApproval == true && !confirmBrowser(argv, open: decision.open) { return .denied }
        let output = try await Task.detached(priority: .userInitiated) { try runBrowserArgv(argv) }.value
        if !toastEnabled {
            notifyBrowser(decision.notify?.isEmpty == false ? decision.notify! : (output.isEmpty ? "Done" : output))
        }
        if let arguments = decision.browserArguments, !arguments.isEmpty {
            try await Task.detached(priority: .userInitiated) { try launchBrowserOpen(arguments) }.value
        }
        return .ran
    }
    if decision.kind == "tool" {
        // The shared contract (src/browser-router/lib/route.ts): a `tool` action "is recorded and not
        // executed", and the CLI's perform() refuses it. The app keeps the same boundary.
        let message = "Tool routes are recorded, not run: " + (["tools", decision.tool ?? ""] + (decision.args ?? [])).joined(separator: " ")
        if !toastEnabled {
            notifyBrowser(message)
        }
        return .recorded(message)
    }
    if decision.openArguments.isEmpty { return .ran }
    let arguments = decision.openArguments
    try await Task.detached(priority: .userInitiated) { try launchBrowserOpen(arguments) }.value
    return .ran
}

private func requireBrowserTouchID() -> Bool {
    let context = LAContext()
    var error: NSError?
    guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else { return false }
    var ok = false
    var finished = false
    context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: "GenesisTools wants to run a saved command") { success, _ in
        ok = success
        finished = true
        CFRunLoopStop(CFRunLoopGetMain())
    }
    if !finished { CFRunLoopRun() }
    return ok
}

private func confirmBrowser(_ argv: [String], open: String?) -> Bool {
    RouteApproval.ask(argv: argv, open: open)
}

private func runBrowserArgv(_ argv: [String]) throws -> String {
    guard let program = argv.first else { throw RouteFailure.message("run route has no command") }
    let plan = launchPlan(program: program, args: Array(argv.dropFirst()))
    let task = Process()
    task.executableURL = URL(fileURLWithPath: plan.executable)
    task.arguments = plan.arguments
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = browserCommandPath()
    task.environment = env
    let result = try task.runCapturing(mergeStderr: true)
    let output = String(decoding: result.stdout, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    if result.status != 0 {
        throw RouteFailure.message(output.isEmpty ? "command exited \(result.status)" : output)
    }
    return output
}

private func browserCommandPath() -> String {
    struct Cache { static let value = loadBrowserCommandPath() }
    return Cache.value
}

private func loadBrowserCommandPath() -> String {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/bin/zsh")
    task.arguments = ["-lc", "print -r -- \"$PATH\""]
    let captured = (try? task.runCapturing())?.stdout ?? Data()
    let logged = String(decoding: captured, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    let extras = [NSHomeDirectory() + "/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    let base = logged.isEmpty ? (ProcessInfo.processInfo.environment["PATH"] ?? "/usr/bin:/bin") : logged
    return (extras + [base]).joined(separator: ":")
}

private func resolveBrowserExecutable(_ name: String) -> String {
    if name.contains("/") { return name }
    for dir in browserCommandPath().split(separator: ":") {
        let candidate = (String(dir) as NSString).appendingPathComponent(name)
        if FileManager.default.isExecutableFile(atPath: candidate) { return candidate }
    }
    return name
}

private func launchPlan(program: String, args: [String]) -> (executable: String, arguments: [String]) {
    let resolved = resolveBrowserExecutable(program)
    guard let handle = FileHandle(forReadingAtPath: resolved),
          let line = String(data: handle.readData(ofLength: 80), encoding: .utf8)?.split(separator: "\n").first
    else {
        return (resolved, args)
    }
    if line.contains("env") && line.contains("bun") {
        return (resolveBrowserExecutable("bun"), [resolved] + args)
    }
    return (resolved, args)
}

private func launchBrowserOpen(_ arguments: [String]) throws {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    task.arguments = arguments
    try task.run()
    task.waitUntilExit()
    if task.terminationStatus != 0 {
        throw RouteFailure.message("open exited \(task.terminationStatus)")
    }
}

private func notifyBrowser(_ message: String) {
    let escaped = message.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: " ")
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    task.arguments = ["-e", "display notification \"\(escaped)\" with title \"GenesisTools\""]
    try? task.run()
    task.waitUntilExit()
}

private final class BrowserURLHandler: NSObject {
    static let shared = BrowserURLHandler()

    @objc func handle(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let url = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue else { return }
        handleBrowserLink(url)
    }
}
/// Bundle ids that route links and must never be recorded as "the browser to give http(s) back to".
/// The second one is the retired standalone "Genesis Router.app".
private let linkRouterBundleIDs = ["se.johnste.finicky", "com.genesiscz.genesistools", browserRouterBundleID]

func runDefaultBrowser(_ args: [String]) -> Never {
    switch args.first ?? "status" {
    case "set":
        setDefaultBrowser()
    case "restore":
        restoreDefaultBrowser()
    case "status":
        let https = NSWorkspace.shared.urlForApplication(toOpen: URL(string: "https://example.com")!)
        print("bundle=\(Bundle.main.bundleURL.path)")
        print("https=\(https?.path ?? "")")
        exit(0)
    default:
        FileHandle.standardError.write(Data("usage: GenesisTools --default-browser set|restore|status\n".utf8))
        exit(2)
    }
}

/// Records the browser that had http(s) (unless a router had it, then Brave), then asks macOS to
/// hand both schemes to this bundle. macOS shows its own "change your default web browser?" prompt.
private func setDefaultBrowser() -> Never {
    let workspace = NSWorkspace.shared
    let ours = Bundle.main.bundleURL
    let recorded = configDirectory().appendingPathComponent("previous.json")
    let recordedPath = (try? Data(contentsOf: recorded)).flatMap { data in
        (try? JSONSerialization.jsonObject(with: data) as? [String: String])?["appPath"]
    }
    let recordedBundle = recordedPath.flatMap { Bundle(url: URL(fileURLWithPath: $0))?.bundleIdentifier }
    let keepRecorded = recordedPath != nil && !linkRouterBundleIDs.contains(recordedBundle ?? "")
    let current = workspace.urlForApplication(toOpen: URL(string: "https://example.com")!)
    let currentBundle = current.flatMap { Bundle(url: $0)?.bundleIdentifier }
    let chosen = linkRouterBundleIDs.contains(currentBundle ?? "") ? workspace.urlForApplication(withBundleIdentifier: "com.brave.Browser") : current

    if !keepRecorded, let chosen, let data = try? JSONSerialization.data(withJSONObject: ["appPath": chosen.path]) {
        try? FileManager.default.createDirectory(at: configDirectory(), withIntermediateDirectories: true)
        try? data.write(to: recorded)
    }
    let errors = setHandler(ours)
    let https = workspace.urlForApplication(toOpen: URL(string: "https://example.com")!)

    if https?.standardizedFileURL != ours.standardizedFileURL {
        let detail = errors.isEmpty ? "https handler is \(https?.path ?? "missing") (confirm the macOS prompt, then run status)" : errors.joined(separator: "\n")
        FileHandle.standardError.write(Data((detail + "\n").utf8))
        exit(1)
    }
    print("default=GenesisTools")
    exit(0)
}

private func restoreDefaultBrowser() -> Never {
    let url = configDirectory().appendingPathComponent("previous.json")
    guard let data = try? Data(contentsOf: url),
          let object = try? JSONSerialization.jsonObject(with: data) as? [String: String],
          let path = object["appPath"]
    else {
        FileHandle.standardError.write(Data("no previous browser recorded\n".utf8))
        exit(1)
    }
    let errors = setHandler(URL(fileURLWithPath: path))
    if !errors.isEmpty {
        FileHandle.standardError.write(Data((errors.joined(separator: "\n") + "\n").utf8))
        exit(1)
    }
    print("default=\(path)")
    exit(0)
}

/// Both schemes, waiting on the completion handlers (a run loop spin outside any view: this face
/// has no UI). Returns the per-scheme errors.
private func setHandler(_ app: URL) -> [String] {
    var pending = 2
    var errors: [String] = []
    for scheme in ["https", "http"] {
        NSWorkspace.shared.setDefaultApplication(at: app, toOpenURLsWithScheme: scheme) { error in
            if let error { errors.append("\(scheme): \(error.localizedDescription)") }
            pending -= 1
            if pending == 0 { CFRunLoopStop(CFRunLoopGetMain()) }
        }
    }
    if pending > 0 {
        CFRunLoopRun()
    }
    return errors
}
