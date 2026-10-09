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

final class BrowserURLForwarder: NSObject {
    static let shared = BrowserURLForwarder()
    /// The app that was active before macOS activated this face to deliver a link: the one the link
    /// was clicked in. `deactivate()` alone is not enough: when the router's toast process quits,
    /// macOS brings back the most recently active app, which is this face again.
    private var lastOtherApp: NSRunningApplication?
    /// The app to give the focus back to, until the deadline. macOS activates this face to deliver a
    /// link, and that activation can land after the event handler returned: a focus hand-back made
    /// only in the handler ran first, and the hub then came to the front anyway ("the rohlik link
    /// opens the hub", 2026-10-02).
    private var focusReturn: (app: NSRunningApplication, until: Date)?
    /// When this face last became active: an activation just before a link arrives is the delivery's.
    private var activatedAt = Date.distantPast
    /// On-screen normal windows, front to back, as they stood when another app last became active: the
    /// stacking a delivery's activation is undone to. Handing the focus back alone left this face's
    /// windows raised above every other app's (a genesis.tools/md click put the review window over Brave).
    private var stackBeforeDelivery: [Int] = []

    static func onScreenStack() -> [Int] {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        return list.compactMap { info in
            guard (info[kCGWindowLayer as String] as? Int) == 0 else { return nil }
            return info[kCGWindowNumber as String] as? Int
        }
    }

    /// For each of `ours`, the window that sat directly above it in `stack` and is not ours; nil when it was on top.
    static func windowsAbove(_ ours: Set<Int>, in stack: [Int]) -> [Int: Int] {
        var result: [Int: Int] = [:]
        for (index, number) in stack.enumerated() where ours.contains(number) {
            if let above = stack[..<index].last(where: { !ours.contains($0) }) {
                result[number] = above
            }
        }
        return result
    }

    /// Puts this face's windows back under the windows that were above them before the delivery.
    private func restoreStacking() {
        guard !stackBeforeDelivery.isEmpty else { return }
        let ours = Set(NSApp.windows.filter(\.isVisible).map(\.windowNumber))
        let onScreen = Set(Self.onScreenStack())
        // Back to front, so each window lands under its own neighbour, not under one of ours moved later.
        for (number, above) in Self.windowsAbove(ours, in: stackBeforeDelivery).sorted(by: { a, b in
            (stackBeforeDelivery.firstIndex(of: a.key) ?? 0) > (stackBeforeDelivery.firstIndex(of: b.key) ?? 0)
        }) where onScreen.contains(above) {
            NSApp.window(withWindowNumber: number)?.order(.below, relativeTo: above)
        }
        HubPerf.log("link: windows put back under the apps that were above them")
    }

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
            self?.stackBeforeDelivery = Self.onScreenStack()
            // The click's own action brought another app forward (Brave for an `open`): it keeps the focus.
            if let target = self?.focusReturn?.app, target.processIdentifier != app.processIdentifier {
                self?.focusReturn = nil
            }
        }
        NotificationCenter.default.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.activatedAt = Date()
            // A mouse button held while this face activates is the user clicking into its window: they came
            // back on purpose, so the pending hand-back ends. A link or banner delivery activates it after
            // the click was released.
            if NSEvent.pressedMouseButtons != 0 {
                if self?.focusReturn != nil {
                    HubPerf.log("link: a click into the hub keeps the focus here")
                }
                self?.focusReturn = nil
                return
            }
            self?.returnFocus()
        }
    }

    private func returnFocus() {
        guard let target = focusReturn else { return }
        guard Date() < target.until, !target.app.isTerminated else {
            focusReturn = nil
            return
        }
        // Kept until the deadline: a banner click activates this face again when its completion
        // handler runs, after the action (measured 2026-10-02: focus went back, then the hub returned).
        HubPerf.log("link: focus back to \(target.app.localizedName ?? "the previous app")")
        RelayJournal.write("focus back to \(target.app.localizedName ?? "the previous app")")
        target.app.activate()
    }

    @objc func handle(_ event: NSAppleEventDescriptor, reply: NSAppleEventDescriptor) {
        guard let raw = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
              raw.contains("://")
        else { return }
        forward(raw)
    }

    /// One link into a fresh router instance; also the path for links AppKit hands to a delegate's
    /// `application(_:open:)` (LocalFileHandoff.deliver).
    func forward(_ raw: String) {
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
                RelayJournal.write("link forward FAILED: \(error)")
            }
        }
        HubPerf.log("link forwarded to a new router instance: \(raw.prefix(80))")
        let activeFor = Int(Date().timeIntervalSince(activatedAt) * 1000)
        RelayJournal.write(
            "link \(RelayJournal.describe(raw)) forwarded; active=\(NSApp.isActive)"
                + (activeFor < 5000 ? " activated \(activeFor) ms before" : "")
                + "; came from \(lastOtherApp?.localizedName ?? "unknown")"
        )
        if RelayJournal.role != "relay" {
            RelayJournal.write(
                LinkRelay.isRunning
                    ? "this window face is older than the running relay (it restarted after a crash or kill); links come here until the next rebuild"
                    : "no relay runs; links come to the oldest window face"
            )
        }
        yieldActivation()
    }

    /// macOS activates this window face to deliver a link or a banner click; give the focus back to
    /// the app the click came from, so the hub does not jump in front of it. The activation may come
    /// now or after the handler, so it is undone on each one inside the window as well. A click made
    /// in this face itself keeps the focus here.
    func yieldActivation() {
        if NSApp.isActive && Date().timeIntervalSince(activatedAt) > 0.5 {
            return
        }
        restoreStacking()
        guard let previous = lastOtherApp, !previous.isTerminated else {
            DispatchQueue.main.async { NSApp.deactivate() }
            return
        }
        focusReturn = (previous, Date().addingTimeInterval(2))
        DispatchQueue.main.async { [weak self] in
            if NSApp.isActive {
                self?.returnFocus()
            }
        }
    }
}

func runBrowserLink(_ raw: String) -> Never {
    keepRouterDocumentFree()
    let app = NSApplication.shared
    app.delegate = browserLinkApp
    app.setActivationPolicy(.accessory)
    installBrowserURLForwarder()
    armBrowserRouterDeadline()
    handleBrowserLink(raw)
    if !browserLinkFinished {
        app.run()
    }
    exit(0)
}

/// A router is never a document app. When the Info.plist declares document types (Recast), AppKit opens the
/// link in argv as a file ("The document 'genesis-md%3A…' could not be opened", a modal alert, 2026-10-06 02:44)
/// and reopens saved documents. Registered defaults apply to this process only, so the Recast face keeps its own.
private func keepRouterDocumentFree() {
    UserDefaults.standard.register(defaults: ["NSTreatUnknownArgumentsAsOpen": "NO"])
}

private let browserLinkApp = BrowserLinkApp()

private final class BrowserLinkApp: NSObject, NSApplicationDelegate {
    func application(_ application: NSApplication, open urls: [URL]) {
        LocalFileHandoff.deliver(urls)
    }

    func application(_ app: NSApplication, shouldRestoreSecureApplicationState coder: NSCoder) -> Bool { false }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply { .terminateNow }
}

/// A router that outlives its link answers every later link by dropping it, so it gets a hard end. A background
/// queue keeps it from depending on the main thread, which is where a stuck router is stuck.
private let browserRouterDeadlineSeconds = 600.0

private func armBrowserRouterDeadline() {
    DispatchQueue.global().asyncAfter(deadline: .now() + browserRouterDeadlineSeconds) {
        FileHandle.standardError.write(Data("router: still running after \(Int(browserRouterDeadlineSeconds)) s, exiting\n".utf8))
        exit(0)
    }
}

/// Ends a router for good. `NSApp.terminate` first asks every open document to close and can be cancelled
/// ("NSDocumentController canceling termination - not all documents were closed", 2026-10-05 21:18): that left
/// a router with no URL handler alive for 5 h, and macOS handed it every link.
func quitBrowserLink() -> Never {
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
                    quitBrowserLink()
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
            quitBrowserLink()
        }

        switch outcome {
        case .success(.denied):
            card?.append("Denied")
        case .success(.recorded(let message)):
            card?.append(message)
        case .success(.ran):
            if startsLocalServer(decision) {
                card?.append("Opening")
            } else if let note = decision.notify, !note.isEmpty, note != copy.headline, !copy.detail.contains(note) {
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
            quitBrowserLink()
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
        quitBrowserLink()
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
    quitBrowserLink()
}

/// A local file macOS handed to this app. Being the default browser makes macOS give it `.html` (and
/// `.xhtml`, `.webarchive`…) files too; every face used to drop them, the window faces with a modal
/// "GenesisTools cannot open files in the HTML text format" (2026-10-07). They go to the browser a
/// failed route falls back to (`fallbackOpenArguments`), without waiting for it.
enum LocalFileHandoff {
    static func arguments(for file: URL) -> [String] {
        fallbackOpenArguments(file.path)
    }

    /// Everything AppKit hands to a delegate's `application(_:open:)`. 🛑 A delegate that implements it
    /// makes AppKit install its own URL-event handler at launch, over `installBrowserURLForwarder`'s, so
    /// links arrive here too: they go on to the forwarder exactly as before, files to the browser. Dropping
    /// the non-file URLs sent every https click to a running window face into nothing (2026-10-07 21:40
    /// to 22:0x: a genesis.tools/md link only brought the review window forward).
    /// Returns how many local files went to the browser.
    @discardableResult
    static func deliver(_ urls: [URL]) -> Int {
        for url in urls where !url.isFileURL {
            BrowserURLForwarder.shared.forward(url.absoluteString)
        }
        return open(urls)
    }

    /// The file URLs among `urls` go to the browser; returns how many.
    @discardableResult
    static func open(_ urls: [URL]) -> Int {
        let files = urls.filter(\.isFileURL)
        for file in files {
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
            task.arguments = arguments(for: file)
            do {
                try task.run()
                HubPerf.log("app.file handed to the browser: \(file.lastPathComponent)")
            } catch {
                FileHandle.standardError.write(Data("app: could not hand \(file.path) to a browser: \(error)\n".utf8))
            }
        }
        return files.count
    }
}

/// Where a link goes when routing failed: the browser recorded before GenesisTools took http(s), else
/// Brave when installed, else Safari. Never a link router, which would hand the link straight back.
func fallbackOpenArguments(_ url: String) -> [String] {
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

/// A click on a registered local server that is not running: `tools browser-router ensure <port>`
/// starts it, and the page opens only after the command succeeded (route.ts `registeredService`).
private func startsLocalServer(_ decision: RouteDecision) -> Bool {
    guard decision.kind == "run", let argv = decision.argv, argv.count == 4 else { return false }
    return argv[0] == "tools" && argv[1] == "browser-router" && argv[2] == "ensure"
}

private func toastCopy(_ decision: RouteDecision) -> ToastCopy {
    let clicked = decoded(decision.original)
    if startsLocalServer(decision) {
        // notify is "Starting <name>": the card says Starting <name> while ensure waits, then Opening.
        let name = decision.notify.map { $0.hasPrefix("Starting ") ? String($0.dropFirst("Starting ".count)) : $0 }
        return ToastCopy(kicker: "Starting", headline: name ?? "Local server", detail: decoded(decision.open ?? decision.url))
    }
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
        // The shared contract (src/utils/browser-router/route.ts): a `tool` action "is recorded and not
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
