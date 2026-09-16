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

/// One button on a banner. `open` and `execute` may both be set; open runs after execute.
struct NotifyAction: Decodable {
    var id: String
    var title: String
    var open: String?
    var execute: String?
    /// Renders the button in red. Cosmetic only.
    var destructive: Bool?
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

    content.userInfo = ["routes": routes.filter { !$0.value.isEmpty }]

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
        // One category per notification, named after it, so two notifications posted with different
        // buttons cannot overwrite each other's set.
        let category = UNNotificationCategory(
            identifier: identifier,
            actions: actions.map(buildAction),
            intentIdentifiers: [],
            options: []
        )
        UNUserNotificationCenter.current().setNotificationCategories([category])
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
    return UNNotificationAction(identifier: action.id, title: action.title, options: options)
}

// MARK: - Click handling

/// Append one line per click to ~/.genesis-tools/app/notify-clicks.log.
///
/// A click runs in a process macOS launched, with no terminal attached, so stderr goes nowhere and
/// a silent no-op is indistinguishable from a click that never arrived. This file is the only way
/// to tell those apart after the fact.
func logClick(_ message: String) {
    let dir = (NSHomeDirectory() as NSString).appendingPathComponent(".genesis-tools/app")
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

        do {
            try task.run()
            task.waitUntilExit()
            logClick("execute finished status=\(task.terminationStatus)")
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
    let identifier = params.id ?? UUID().uuidString
    let center = UNUserNotificationCenter.current()

    center.requestAuthorization(options: [.alert, .sound]) { granted, error in
        if let error {
            emitError(
                code: "internal",
                message: "authorization request failed: \(error.localizedDescription)",
                exitCode: 70
            )
        }

        guard granted else {
            let bundleId = Bundle.main.bundleIdentifier ?? fallbackBundleId
            emitError(
                code: "denied",
                message: "notifications are not allowed for \(bundleId); open System Settings > Notifications",
                exitCode: 77
            )
        }

        let request = UNNotificationRequest(
            identifier: identifier,
            content: notificationContent(params, identifier: identifier),
            trigger: nil
        )

        center.add(request) { addError in
            if let addError {
                emitError(code: "internal", message: "could not post: \(addError.localizedDescription)", exitCode: 70)
            }

            emitResult(["id": identifier])
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

let rpcMethods = ["rpc.hello", "notify.post", "notify.remove", "notify.list", "notify.status"]

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
    UNUserNotificationCenter.current().delegate = sharedNotificationDelegate

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

    default:
        emitError(code: "method_unknown", message: "unknown method \(envelope.method)", exitCode: 69)
    }

    app.run()
    exit(0)
}
