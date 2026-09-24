// Notification face of GenesisTools.app.
//
// macOS attributes a notification to the BUNDLE the posting process lives in, not to the TCC
// responsible process. That is why notifications sent through DarwinKit render with a grey
// placeholder: they are posted by com.genesiscz.darwinkit, a bundle that ships no icon. Posting
// from here instead is what puts the GenesisTools icon on the banner.
//
// Click actions are stored in the notification's userInfo, so they outlive the process that posted
// them: macOS relaunches this bundle when a banner is clicked and delivers the response to whatever
// instance is registered as the notification delegate. That is the same mechanism terminal-notifier
// uses, which is why its -execute survives the sender exiting, and it needs no resident process.
//
// The wire shape is deliberately the one a socket would use, carried over argv and stdout instead:
//   in   argv[1] = {"method":"notify.post","params":{...}}
//   out  stdout  = {"ok":true,"result":{...}}  or  {"ok":false,"error":{"code":...,"message":...}}
// Moving this onto a unix socket later is then a transport swap, not a protocol redesign.

import AppKit
import Foundation
import UserNotifications

// MARK: - Request shapes

/// Turns a button into a text field: macOS shows an input box with a send button instead of firing
/// the action immediately. What the user types arrives as the reply's `text`.
struct NotifyActionInput: Decodable {
    /// Label on the send button. Defaults to "Send".
    var buttonTitle: String?
    /// Greyed-out hint inside the empty field.
    var placeholder: String?
}

/// One button on a banner. `open` and `execute` may both be set; open runs after execute.
struct NotifyAction: Decodable {
    var id: String
    var title: String
    var open: String?
    var execute: String?
    /// Renders the button in red. Cosmetic only.
    var destructive: Bool?
    /// Present: the button opens a text field and the answer comes back in the reply file.
    var input: NotifyActionInput?
}

struct NotifyPostParams: Decodable {
    var message: String
    var title: String?
    var subtitle: String?
    var sound: String?
    var group: String?
    var open: String?
    var execute: String?
    var appIcon: String?
    /// Image, audio or video files shown with the banner. A thumbnail rides on the right of the
    /// banner; expanding the notification shows the first one full size.
    var attachments: [String]?
    var ignoreDnD: Bool?
    /// Supply one to make the notification addressable by `notify.remove`, or to replace an
    /// already-delivered notification in place. Generated when absent, and always returned.
    var id: String?
    var actions: [NotifyAction]?
    /// Absolute directory the click handler writes the reply into. Stamped by the poster so a
    /// Launch Services relaunch, which does not inherit `GENESIS_TOOLS_HOME`, still writes where
    /// the waiter is looking.
    var replyDir: String?
    /// Home the click-launched `execute` should see as `GENESIS_TOOLS_HOME`.
    var genesisHome: String?
}

struct NotifyReplyParams: Decodable {
    var id: String
    /// Directory the reply was stamped into at post time. Defaults to `notificationReplyDir()`.
    var replyDir: String?
    /// Delete the reply after reading it, so a second caller cannot consume the same answer twice.
    var consume: Bool?
}

struct NotifyRemoveParams: Decodable {
    var ids: [String]?
    /// Remove every delivered notification whose `group` matches.
    var group: String?
    var all: Bool?
}

private struct MethodEnvelope: Decodable {
    var method: String
}

private struct ParamsEnvelope<T: Decodable>: Decodable {
    var params: T
}

// MARK: - Replies

/// Every face of this entry point exits through one of these, so a caller always gets exactly one
/// JSON line on stdout and never has to guess from the exit code alone.
func emitResult(_ result: [String: Any]) -> Never {
    emit(["ok": true, "result": result])
    exit(0)
}

/// How long a method may wait on `usernoted` before this process gives up and says so.
///
/// Every method exits through `emitResult` or `emitError`, so a method that finishes simply beats
/// the timer and it never fires: nothing needs cancelling. Only the methods that wait on a
/// UserNotifications callback get one; the synchronous ones cannot hang, and `notify.authorize`
/// arms its own 120 s deadline because a human has to click. Without this, a wedged `usernoted`
/// left the process alive at 0% CPU, holding the LaunchServices registration for the bundle and
/// swallowing every notification click, with no signature to find it by.
private func rpcDeadlineSeconds(for method: String) -> Double? {
    switch method {
    case "notify.post", "notify.remove", "notify.list", "notify.status":
        // Under the 10 s the TypeScript caller allows, so this side reports first with a real reason.
        return 8
    default:
        return nil
    }
}

private func armRpcDeadline(for method: String) {
    guard let seconds = rpcDeadlineSeconds(for: method) else { return }
    DispatchQueue.main.asyncAfter(deadline: .now() + seconds) {
        emitError(code: "timeout", message: "\(method) got no answer from the notification service within \(Int(seconds))s", exitCode: 75)
    }
}

func emitError(code: String, message: String, exitCode: Int32) -> Never {
    emit(["ok": false, "error": ["code": code, "message": message]])
    exit(exitCode)
}

private func emit(_ payload: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]),
        let line = String(data: data, encoding: .utf8)
    else {
        let fallback = "{\"ok\":false,\"error\":{\"code\":\"internal\",\"message\":\"could not encode reply\"}}\n"
        FileHandle.standardOutput.write(Data(fallback.utf8))
        return
    }

    FileHandle.standardOutput.write(Data("\(line)\n".utf8))
}

// MARK: - Content

/// Build the notification payload.
///
/// `sound` defaults to the system default, matching the DarwinKit and osascript backends this
/// replaces. terminal-notifier stays silent unless asked, so a caller that relied on that gets a
/// sound it did not before; that is the one deliberate behaviour change here.
func notificationContent(_ params: NotifyPostParams, identifier: String) -> UNMutableNotificationContent {
    let content = UNMutableNotificationContent()
    content.title = params.title ?? "GenesisTools"
    content.body = params.message

    if let subtitle = params.subtitle, !subtitle.isEmpty {
        content.subtitle = subtitle
    }

    if let sound = params.sound, !sound.isEmpty, sound.lowercased() != "default" {
        content.sound = UNNotificationSound(named: UNNotificationSoundName(sound))
    } else {
        content.sound = .default
    }

    if let group = params.group, !group.isEmpty {
        content.threadIdentifier = group
    }

    // Keyed by the action that should run it. The body click is "default"; a button click uses the
    // button's own id. Reading it back needs no knowledge of the category that rendered the buttons.
    var routes: [String: [String: String]] = [:]
    routes[UNNotificationDefaultActionIdentifier] = route(open: params.open, execute: params.execute)

    for action in params.actions ?? [] {
        routes[action.id] = route(open: action.open, execute: action.execute)
    }

    var userInfo: [String: Any] = [
        "replyDir": resolvedReplyDir(params),
        "genesisHome": resolvedGenesisHome(params),
    ]
    let filteredRoutes = routes.filter { !$0.value.isEmpty }

    if !filteredRoutes.isEmpty {
        userInfo["routes"] = filteredRoutes
    }

    content.userInfo = userInfo

    // Best effort only. Punching through a Focus mode needs the time-sensitive entitlement, which a
    // Developer ID signature cannot carry, so this degrades to a normal banner rather than failing.
    if params.ignoreDnD == true {
        content.interruptionLevel = .timeSensitive
    }

    // appIcon first, so it is the thumbnail on the banner. UNUserNotificationCenter has no way to
    // replace the app icon itself (terminal-notifier's -appIcon meaning), so the closest honest
    // mapping is to show the image as the notification's own artwork.
    let files = [params.appIcon].compactMap { $0 } + (params.attachments ?? [])
    content.attachments = files.enumerated().compactMap { index, path in
        buildAttachment(path: path, index: index)
    }

    if let actions = params.actions, !actions.isEmpty {
        // Category registration happens in `post()`, as a union with whatever is already
        // registered. `setNotificationCategories` replaces the entire set, so doing it here
        // with `[one]` would wipe every other notification's buttons.
        content.categoryIdentifier = identifier
    }

    return content
}

private func route(open: String?, execute: String?) -> [String: String] {
    var result: [String: String] = [:]

    if let open, !open.isEmpty {
        result["open"] = open
    }

    if let execute, !execute.isEmpty {
        result["execute"] = execute
    }

    return result
}

/// 🛑 `UNNotificationAttachment` MOVES the file at the url into the notification data store. Handing
/// it the caller's own path deletes that file from where the caller left it. So every attachment is
/// copied into a temp directory first and the copy is what gets consumed. The temp copy is the
/// system's to delete once the notification goes away.
private func buildAttachment(path: String, index: Int) -> UNNotificationAttachment? {
    let source = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)

    guard FileManager.default.fileExists(atPath: source.path) else {
        logClick("attachment missing: \(source.path)")
        return nil
    }

    let staging = URL(fileURLWithPath: NSTemporaryDirectory())
        .appendingPathComponent("genesis-notify-\(UUID().uuidString)", isDirectory: true)

    do {
        try FileManager.default.createDirectory(at: staging, withIntermediateDirectories: true)
        let copy = staging.appendingPathComponent(source.lastPathComponent)
        try FileManager.default.copyItem(at: source, to: copy)
        return try UNNotificationAttachment(identifier: "attachment-\(index)", url: copy, options: nil)
    } catch {
        logClick("attachment failed for \(source.path): \(error.localizedDescription)")
        return nil
    }
}

private func buildAction(_ action: NotifyAction) -> UNNotificationAction {
    // Deliberately NOT .foreground: a foreground action activates the app and would drag the
    // settings window up. Background delivery still launches this bundle if nothing is running.
    let options: UNNotificationActionOptions = action.destructive == true ? [.destructive] : []

    guard let input = action.input else {
        return UNNotificationAction(identifier: action.id, title: action.title, options: options)
    }

    return UNTextInputNotificationAction(
        identifier: action.id,
        title: action.title,
        options: options,
        textInputButtonTitle: input.buttonTitle ?? "Send",
        textInputPlaceholder: input.placeholder ?? ""
    )
}

// MARK: - Replies

/// Where an answer to a notification is left for whoever asked.
///
/// The asking process is long gone by the time the user replies — that is the whole point of a
/// notification — so the answer cannot be returned on its stdout. It is written here instead, and a
/// waiting CLI watches the directory. One file per notification id, overwritten if the same
/// notification is answered twice.
func notificationReplyDir() -> String {
    (genesisHome() as NSString).appendingPathComponent(".genesis-tools/app/replies")
}

/// Notification ids are path components of the reply file. A slash or `..` would let `notify.reply`
/// (and the click writer) read or write outside the reply directory, using the app's TCC grants.
func isSafeNotificationId(_ id: String) -> Bool {
    if id.isEmpty {
        return false
    }

    if id.contains("/") || id.contains("\\") || id.contains("..") {
        return false
    }

    return true
}

/// Fallback when a click arrives without a stamped home in `userInfo` (an old notification,
/// or a raw `--rpc` that omitted `genesisHome`). Prefers `GENESIS_TOOLS_HOME` when this
/// process inherited it — the `--rpc` poster does; a Launch Services relaunch does not.
func genesisHome() -> String {
    let override = ProcessInfo.processInfo.environment["GENESIS_TOOLS_HOME"]
    return override?.isEmpty == false ? override! : NSHomeDirectory()
}

private func resolvedReplyDir(_ params: NotifyPostParams) -> String {
    if let replyDir = params.replyDir, !replyDir.isEmpty {
        return replyDir
    }

    return notificationReplyDir()
}

private func resolvedGenesisHome(_ params: NotifyPostParams) -> String {
    if let home = params.genesisHome, !home.isEmpty {
        return home
    }

    return genesisHome()
}

private func writeReply(notificationId: String, actionId: String, text: String?, userInfo: [AnyHashable: Any]) {
    if !isSafeNotificationId(notificationId) {
        logClick("reply write skipped: unsafe id")
        return
    }

    let dir: String
    if let stamped = userInfo["replyDir"] as? String, !stamped.isEmpty {
        dir = stamped
    } else {
        dir = notificationReplyDir()
    }

    let path = (dir as NSString).appendingPathComponent("\(notificationId).json")

    var payload: [String: Any] = [
        "id": notificationId,
        "actionId": actionId,
        "at": ISO8601DateFormatter().string(from: Date()),
    ]

    if let text {
        payload["text"] = text
    }

    do {
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        // .atomic writes a temp file and renames it, so a watcher never reads a half-written file
        // and the first write does not need an existing original (`replaceItemAt` throws then).
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        logClick("reply written \(path) text=\(text ?? "-")")
    } catch {
        logClick("reply write FAILED for \(notificationId): \(error.localizedDescription)")
    }
}

// MARK: - Click handling

/// Append one line per click to ~/.genesis-tools/app/notify-clicks.log.
///
/// A click runs in a process macOS launched, with no terminal attached, so stderr goes nowhere and
/// a silent no-op is indistinguishable from a click that never arrived. This file is the only way
/// to tell those apart after the fact.
func logClick(_ message: String) {
    let dir = (genesisHome() as NSString).appendingPathComponent(".genesis-tools/app")
    let path = (dir as NSString).appendingPathComponent("notify-clicks.log")
    let stamp = ISO8601DateFormatter().string(from: Date())
    let line = "\(stamp) \(message)\n"

    try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)

    guard let handle = FileHandle(forWritingAtPath: path) else {
        try? line.write(toFile: path, atomically: true, encoding: .utf8)
        return
    }

    defer { try? handle.close() }
    _ = try? handle.seekToEnd()
    try? handle.write(contentsOf: Data(line.utf8))
}

/// Run whatever the clicked element was carrying. Blocks until an `execute` command finishes, so
/// the caller must not run this on the main queue.
func performClickAction(userInfo: [AnyHashable: Any], actionIdentifier: String) {
    // Read one level at a time. userInfo comes back from the notification store as a plist, so the
    // inner dictionaries arrive as [String: Any] and a direct cast to [String: [String: String]]
    // fails, silently turning every click into a no-op. That was the first shipped bug here.
    let routes = userInfo["routes"] as? [String: Any]
    let route = routes?[actionIdentifier] as? [String: Any]
    let open = route?["open"] as? String
    let execute = route?["execute"] as? String

    logClick(
        "action=\(actionIdentifier) routes=\(routes?.keys.sorted() ?? []) open=\(open ?? "-") execute=\(execute ?? "-")"
    )

    if let execute, !execute.isEmpty {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = ["-c", execute]

        if let home = userInfo["genesisHome"] as? String, !home.isEmpty {
            var environment = ProcessInfo.processInfo.environment
            environment["GENESIS_TOOLS_HOME"] = home
            task.environment = environment
        }

        do {
            let group = DispatchGroup()
            group.enter()
            task.terminationHandler = { _ in group.leave() }

            do {
                try task.run()
            } catch {
                group.leave()
                throw error
            }

            if group.wait(timeout: .now() + 30) == .timedOut {
                task.terminate()
                logClick("execute timed out after 30s; killed")
            } else {
                logClick("execute finished status=\(task.terminationStatus)")
            }
        } catch {
            logClick("execute failed: \(error.localizedDescription)")
        }
    }

    if let open, !open.isEmpty, let url = URL(string: open) {
        NSWorkspace.shared.open(url)
        logClick("opened \(open)")
    }
}

/// Registered by every face of the bundle that can receive a click, including an instance macOS
/// launched purely to deliver one.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    /// Called when a notification arrives while this process is frontmost. Without it the banner is
    /// suppressed and the user never gets the chance to click.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        // Set synchronously: the no-argument launch path polls this to tell a banner click apart
        // from a Finder double-click, and it must be true before that grace period elapses.
        notificationClickReceived = true

        let userInfo = response.notification.request.content.userInfo
        let actionIdentifier = response.actionIdentifier
        let notificationId = response.notification.request.identifier
        let typed = (response as? UNTextInputNotificationResponse)?.userText

        logClick("response id=\(notificationId) action=\(actionIdentifier) text=\(typed ?? "-")")

        // Every response leaves a reply file, not just a typed one, so a caller can await a plain
        // button press exactly as it awaits an answer.
        writeReply(notificationId: notificationId, actionId: actionIdentifier, text: typed, userInfo: userInfo)

        DispatchQueue.global(qos: .userInitiated).async {
            performClickAction(userInfo: userInfo, actionIdentifier: actionIdentifier)

            DispatchQueue.main.async {
                completionHandler()

                if quitAfterNotificationClick {
                    exit(0)
                }
            }
        }
    }
}

/// `UNUserNotificationCenter.delegate` is a weak reference, so the delegate has to be owned by
/// something that outlives the call that registers it.
let sharedNotificationDelegate = NotificationDelegate()

/// True once a banner click has been delivered to this process.
var notificationClickReceived = false

/// A process macOS launched only to deliver a click has nothing else to do, so it quits once the
/// action has run. The settings window clears this, so clicking a banner while the window is open
/// does not close it.
var quitAfterNotificationClick = true

// MARK: - Methods

private func post(_ params: NotifyPostParams) {
    if let supplied = params.id, !supplied.isEmpty, !isSafeNotificationId(supplied) {
        emitError(code: "params_invalid", message: "notify.post id must not contain a path", exitCode: 64)
    }

    let identifier = params.id.flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
    let center = UNUserNotificationCenter.current()

    center.getNotificationSettings { settings in
        switch settings.authorizationStatus {
        case .notDetermined:
            emitError(
                code: "not_determined",
                message: "notifications have never been granted; run tools notify authorize",
                exitCode: 77
            )
        case .denied:
            let bundleId = Bundle.main.bundleIdentifier ?? fallbackBundleId
            emitError(
                code: "denied",
                message: "notifications are not allowed for \(bundleId); open System Settings > Notifications",
                exitCode: 77
            )
        default:
            let request = UNNotificationRequest(
                identifier: identifier,
                content: notificationContent(params, identifier: identifier),
                trigger: nil
            )
            let add = {
                center.add(request) { addError in
                    if let addError {
                        emitError(
                            code: "internal",
                            message: "could not post: \(addError.localizedDescription)",
                            exitCode: 70
                        )
                    }

                    emitResult(["id": identifier])
                }
            }

            guard let actions = params.actions, !actions.isEmpty else {
                add()
                return
            }

            let category = UNNotificationCategory(
                identifier: identifier,
                actions: actions.map(buildAction),
                intentIdentifiers: [],
                options: []
            )
            center.getNotificationCategories { existing in
                var next = existing.filter { $0.identifier != identifier }
                next.insert(category)
                center.setNotificationCategories(next)
                add()
            }
        }
    }
}

private func remove(_ params: NotifyRemoveParams) {
    let center = UNUserNotificationCenter.current()

    // The remove calls are fire-and-forget over XPC and return before usernoted has acted. Exiting
    // straight after one beats the message to the daemon and the banner stays on screen, which is
    // exactly what happened the first time this shipped. A read of the store is ordered behind the
    // remove on the same connection, so it doubles as the flush barrier.
    // Never spin a run loop here. The group branch calls this from inside a
    // getDeliveredNotifications callback, which runs on the framework's own queue, and spinning
    // there waits for a reply that cannot be delivered until the callback returns. That hung the
    // process instead of removing anything. runNotify's app.run() is the only run loop involved,
    // and it is already running by the time any of these callbacks fire.
    func finish(_ removed: Any) {
        center.getDeliveredNotifications { _ in
            emitResult(["removed": removed])
        }
    }

    if params.all == true {
        center.removeAllDeliveredNotifications()
        finish("all")
        return
    }

    if let ids = params.ids, !ids.isEmpty {
        center.removeDeliveredNotifications(withIdentifiers: ids)
        finish(ids)
        return
    }

    guard let group = params.group, !group.isEmpty else {
        emitError(code: "params_invalid", message: "notify.remove needs ids, group or all", exitCode: 64)
    }

    center.getDeliveredNotifications { delivered in
        let ids = delivered
            .filter { $0.request.content.threadIdentifier == group }
            .map { $0.request.identifier }

        center.removeDeliveredNotifications(withIdentifiers: ids)
        finish(ids)
    }
}

/// Deep link to THIS app's own page in System Settings > Notifications. Verified working on
/// macOS 26.3.1: it lands on the GenesisTools page, not the app list.
///
/// `alertStyle` is read-only in `UserNotifications`. An app cannot promote itself from a Temporary
/// banner to a Persistent alert, by design, so handing the user this link is the only thing code
/// can do about it. It lives here rather than in a caller so every door offers the same fix.
let notificationSettingsUrl =
    "x-apple.systempreferences:com.apple.Notifications-Settings.extension?id=\(fallbackBundleId)"

private func openSettings() {
    guard let url = URL(string: notificationSettingsUrl) else {
        emitError(code: "internal", message: "could not build the settings url", exitCode: 70)
    }

    NSWorkspace.shared.open(url)
    emitResult(["opened": notificationSettingsUrl])
}

/// Ask macOS for notification permission and WAIT for the answer.
///
/// `notify.post` does not prompt: the 8s RPC deadline cannot survive a human clicking Allow, so
/// a still-`notDetermined` grant fails with `not_determined` and names `tools notify authorize`.
/// This is the method that holds the run loop open until the callback fires.
///
/// ⚠️ macOS shows the prompt only while the status is `notDetermined`. Once it is `authorized` or
/// `denied` the call returns immediately with no UI, and the only way to change the answer is
/// System Settings. This reports which of those happened rather than pretending it asked.
private func authorize(timeoutSeconds: Double) {
    let center = UNUserNotificationCenter.current()

    center.getNotificationSettings { before in
        let wasDetermined = before.authorizationStatus != .notDetermined

        center.requestAuthorization(options: [.alert, .sound]) { granted, error in
            center.getNotificationSettings { after in
                emitResult([
                    "granted": granted,
                    // A prompt is only possible while the status is notDetermined. Reporting this
                    // the wrong way round once already made the reply contradict its own note.
                    "prompted": !wasDetermined,
                    "statusBefore": describe(before.authorizationStatus),
                    "statusAfter": describe(after.authorizationStatus),
                    "alertStyle": describe(after.alertStyle),
                    "error": error?.localizedDescription ?? "",
                    "note": wasDetermined
                        ? "Already answered once, so macOS showed no prompt. Change it in System Settings > Notifications."
                        : "macOS was asked for the first time.",
                ])
            }
        }
    }

    // A prompt the user never answers must not wedge the caller forever.
    DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSeconds) {
        emitError(code: "timeout", message: "no answer within \(Int(timeoutSeconds))s", exitCode: 75)
    }
}

/// What macOS actually thinks of us. `notify.post` reporting success only means the request was
/// accepted; a provisional or quiet authorization accepts it and then never shows a banner, which
/// looks identical from the caller's side. This is the only way to tell those apart.
private func status() {
    UNUserNotificationCenter.current().getNotificationSettings { settings in
        emitResult([
            "authorization": describe(settings.authorizationStatus),
            "alertSetting": describe(settings.alertSetting),
            "alertStyle": describe(settings.alertStyle),
            "soundSetting": describe(settings.soundSetting),
            "badgeSetting": describe(settings.badgeSetting),
            "notificationCenterSetting": describe(settings.notificationCenterSetting),
            "lockScreenSetting": describe(settings.lockScreenSetting),
            "criticalAlertSetting": describe(settings.criticalAlertSetting),
            "timeSensitiveSetting": describe(settings.timeSensitiveSetting),
            "bundleId": Bundle.main.bundleIdentifier ?? fallbackBundleId,
            "bundlePath": Bundle.main.bundlePath,
            // "banner" is macOS's "Temporary": it fades after a few seconds, taking its buttons
            // and its attachment with it. Callers that need a click need to know this up front.
            "temporary": settings.alertStyle == .banner,
            "settingsUrl": notificationSettingsUrl,
        ])
    }
}

private func describe(_ value: UNAuthorizationStatus) -> String {
    switch value {
    case .notDetermined: return "notDetermined"
    case .denied: return "denied"
    case .authorized: return "authorized"
    case .provisional: return "provisional"
    case .ephemeral: return "ephemeral"
    @unknown default: return "unknown(\(value.rawValue))"
    }
}

private func describe(_ value: UNNotificationSetting) -> String {
    switch value {
    case .notSupported: return "notSupported"
    case .disabled: return "disabled"
    case .enabled: return "enabled"
    @unknown default: return "unknown(\(value.rawValue))"
    }
}

private func describe(_ value: UNAlertStyle) -> String {
    switch value {
    case .none: return "none"
    case .banner: return "banner"
    case .alert: return "alert"
    @unknown default: return "unknown(\(value.rawValue))"
    }
}

/// Read the answer left for one notification, if the user has answered yet.
///
/// Returns `{answered: false}` rather than an error when there is nothing: "not answered yet" is a
/// normal state for a question, not a failure, and a caller polls or watches until it flips.
private func readReply(_ params: NotifyReplyParams) {
    guard isSafeNotificationId(params.id) else {
        emitError(code: "params_invalid", message: "notify.reply id must not contain a path", exitCode: 64)
    }

    let dir: String
    if let replyDir = params.replyDir, !replyDir.isEmpty {
        dir = replyDir
    } else {
        dir = notificationReplyDir()
    }

    let path = (dir as NSString).appendingPathComponent("\(params.id).json")

    guard
        let data = FileManager.default.contents(atPath: path),
        let stored = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else {
        emitResult(["answered": false, "id": params.id])
    }

    if params.consume == true {
        try? FileManager.default.removeItem(atPath: path)
    }

    var result: [String: Any] = stored
    result["answered"] = true
    emitResult(result)
}

private func list() {
    UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
        let rows = delivered.map { notification -> [String: Any] in
            let content = notification.request.content

            return [
                "id": notification.request.identifier,
                "title": content.title,
                "subtitle": content.subtitle,
                "message": content.body,
                "group": content.threadIdentifier,
                "deliveredAt": notification.date.timeIntervalSince1970,
                // Reported so "the image did not show" can be told apart from "the image was never
                // attached". Those have completely different causes and the banner looks the same.
                "attachments": content.attachments.map { $0.url.lastPathComponent },
                "actions": content.categoryIdentifier,
            ]
        }

        emitResult(["notifications": rows])
    }
}

// MARK: - Entry point

/// Bumped only when an existing method's request or reply changes shape. Adding a method does not
/// bump it: a client discovers those from `rpc.hello`'s method list instead.
let rpcProtocolVersion = 1

let rpcMethods = ["rpc.hello", "notify.post", "notify.remove", "notify.list", "notify.status", "notify.authorize", "notify.settings", "notify.reply", "gate.approve"]

/// `GenesisTools --rpc '<json>'`, or `--rpc -` to read the request from stdin: run one method and
/// exit with one JSON line on stdout.
///
/// `.accessory` keeps the process off the Dock, the same footprint terminal-notifier gets from
/// LSUIElement. An NSApplication run loop is what lets the UserNotifications callbacks land, and
/// every path exits from inside a callback, so the request is always settled.
func runRpc(_ arguments: [String]) -> Never {
    let payload: String

    if let first = arguments.first, first != "-" {
        payload = first
    } else {
        // stdin keeps the door open for a request too big or too awkward to quote into argv.
        payload = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
    }

    guard let data = payload.data(using: .utf8), !payload.isEmpty else {
        emitError(code: "bad_request", message: "--rpc needs a JSON request on argv or stdin", exitCode: 64)
    }

    let decoder = JSONDecoder()

    guard let envelope = try? decoder.decode(MethodEnvelope.self, from: data) else {
        emitError(code: "bad_request", message: "--rpc takes {\"method\":\"...\",\"params\":{...}}", exitCode: 64)
    }

    let app = NSApplication.shared
    app.setActivationPolicy(.accessory)
    armRpcDeadline(for: envelope.method)
    UNUserNotificationCenter.current().delegate = sharedNotificationDelegate

    // Every request is logged, so the file is a complete record of what this bundle was asked to do
    // rather than only what went wrong. A click runs with no terminal attached; so does an rpc call
    // spawned by a daemon.
    logClick("rpc method=\(envelope.method) payload=\(payload.prefix(400))")

    switch envelope.method {
    case "rpc.hello":
        // Lets a client find out what this installed build can do before it sends a request it
        // cannot know is supported. A stale bundle answers with a shorter method list, not an error.
        emitResult([
            "protocol": rpcProtocolVersion,
            "bundleId": Bundle.main.bundleIdentifier ?? fallbackBundleId,
            "version": bundleVersion(),
            "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "0",
            "methods": rpcMethods,
        ])

    case "notify.post":
        guard let request = try? decoder.decode(ParamsEnvelope<NotifyPostParams>.self, from: data) else {
            emitError(code: "params_invalid", message: "notify.post needs params.message", exitCode: 64)
        }

        post(request.params)

    case "notify.remove":
        guard let request = try? decoder.decode(ParamsEnvelope<NotifyRemoveParams>.self, from: data) else {
            emitError(code: "params_invalid", message: "notify.remove needs params with ids, group or all", exitCode: 64)
        }

        remove(request.params)

    case "notify.list":
        list()

    case "notify.status":
        status()

    case "notify.authorize":
        authorize(timeoutSeconds: 120)

    case "notify.settings":
        openSettings()

    case "notify.reply":
        guard let request = try? decoder.decode(ParamsEnvelope<NotifyReplyParams>.self, from: data) else {
            emitError(code: "params_invalid", message: "notify.reply needs params.id", exitCode: 64)
        }

        readReply(request.params)

    case "gate.approve":
        guard let request = try? decoder.decode(ParamsEnvelope<GateApproveParams>.self, from: data) else {
            emitError(code: "params_invalid", message: "gate.approve needs params.client, params.provider and params.account", exitCode: 64)
        }

        approveGate(request.params)

    default:
        emitError(code: "method_unknown", message: "unknown method \(envelope.method)", exitCode: 69)
    }

    app.run()
    exit(0)
}
