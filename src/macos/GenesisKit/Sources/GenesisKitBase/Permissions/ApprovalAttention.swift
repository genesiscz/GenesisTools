import AppKit
import UserNotifications

/// How a waiting approval request (the vault key, an AI account) gets the user's attention. The panel never takes the
/// keyboard by itself, so a stray Return cannot answer it; without these cues a request on another screen or Space
/// waited out its deadline unseen. Both cues are settings of the host app (GenesisTools Settings, "Approval
/// requests"); the values here are the defaults.
public enum ApprovalAttention {
    /// The sound a request plays when it appears: a name from /System/Library/Sounds, or "none".
    public static let soundKey = "approvals.sound"
    /// Its own sound, so it is not taken for the widget's inbox chime (Glass); Purr is soft and under 1 s.
    public static let defaultSound = "Purr"
    public static let sounds = [
        "Purr", "Bottle", "Tink", "Frog", "Morse", "Basso", "Glass", "Ping", "Pop", "Submarine", "Hero", "Funk", "Blow",
        "Sosumi",
    ]

    /// Seconds a request waits before a notification follows it; 0 posts it at once, -1 never.
    public static let notifyAfterKey = "approvals.notifyAfterSeconds"
    public static let defaultNotifyAfter = 15
    public static let notifyAfterChoices = [
        ApprovalNotifyChoice(seconds: 0, title: "At once"),
        ApprovalNotifyChoice(seconds: 15, title: "After 15 seconds"),
        ApprovalNotifyChoice(seconds: 30, title: "After 30 seconds"),
        ApprovalNotifyChoice(seconds: 60, title: "After 1 minute"),
        ApprovalNotifyChoice(seconds: -1, title: "Never"),
    ]

    public static var sound: String {
        UserDefaults.standard.string(forKey: soundKey) ?? defaultSound
    }

    public static var notifyAfter: Int {
        UserDefaults.standard.object(forKey: notifyAfterKey) as? Int ?? defaultNotifyAfter
    }

    /// When the reminder for a request that appears now would be posted; nil when it would not be posted at all: the
    /// setting says never, or the request denies itself within 5 s of it, when the card could only mislead.
    public static func reminderDelay(notifyAfter: Int, deadline: Date?, now: Date = Date()) -> TimeInterval? {
        guard notifyAfter >= 0 else { return nil }
        let delay = TimeInterval(notifyAfter)
        if let deadline, delay > deadline.timeIntervalSince(now) - 5 { return nil }
        return delay
    }

    /// Plays `name` once; "none" or an unknown name is silent. `NSSound.play` waits for the output device (about
    /// 0.8 s on the main thread, measured for the widget's chime), so it plays from a background queue.
    public static func play(_ name: String) {
        guard name != "none" else { return }
        queue.async {
            guard let player = NSSound(named: NSSound.Name(name)) else {
                KitHost.log("approval unknown sound \(name)")
                return
            }
            player.play()
            playing.append(player)
            if playing.count > 2 { playing.removeFirst() }
        }
    }

    private static let queue = DispatchQueue(label: "genesiskit.approval.sound", qos: .userInitiated)
    /// Keeps the last players alive until they finish; a released NSSound stops at once.
    private nonisolated(unsafe) static var playing: [NSSound] = []
}

public struct ApprovalNotifyChoice: Identifiable, Hashable, Sendable {
    public let seconds: Int
    public let title: String

    public var id: Int { seconds }
}

/// One request's cues: the sound and the VoiceOver line when it appears, the notification while it still waits, and
/// the cleanup when it is answered or its deadline passes.
@MainActor
final class ApprovalReminder {
    private let model: ApprovalDialogModel
    private let onClick: () -> Void
    private let token = UUID().uuidString
    private var pending: DispatchWorkItem?
    private var expiry: DispatchWorkItem?
    private var postedID: String?

    init(model: ApprovalDialogModel, onClick: @escaping () -> Void) {
        self.model = model
        self.onClick = onClick
    }

    func start() {
        let sound = ApprovalAttention.sound
        ApprovalAttention.play(sound)
        GenAnnounce.post("Approval needed. \(model.title)", priority: .high)
        let delay = ApprovalAttention.reminderDelay(notifyAfter: ApprovalAttention.notifyAfter, deadline: model.deadline)
        KitHost.log("approval \(model.identifier) shown sound=\(sound) reminder=\(delay.map { "\(Int($0))s" } ?? "off")")
        guard let delay else { return }

        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated { self?.post() }
        }
        pending = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)

        // The card never outlives the request: the caller's own deadline ends its process right after this.
        if let deadline = model.deadline {
            let end = DispatchWorkItem { [weak self] in
                MainActor.assumeIsolated { self?.stop() }
            }
            expiry = end
            DispatchQueue.main.asyncAfter(deadline: .now() + max(0, deadline.timeIntervalSinceNow - 0.5), execute: end)
        }
    }

    /// nil where Notification Center must not be touched: under `swift test` the bundle is not an app, and
    /// `UNUserNotificationCenter.current()` raises there and ends the process.
    private static var center: UNUserNotificationCenter? {
        guard NSClassFromString("XCTestCase") == nil, Bundle.main.bundlePath.hasSuffix(".app") else { return nil }
        return UNUserNotificationCenter.current()
    }

    private func post() {
        pending = nil
        guard !model.answered, let center = Self.center else { return }
        // A click on the card must reach this process's panel, and must not reach the host's own click handler,
        // which ends a process it finds without a route.
        ApprovalNotificationRelay.register(token: token, center: center, onClick: onClick)

        let content = UNMutableNotificationContent()
        content.title = model.title
        content.subtitle = "Waiting for your answer"
        content.body = [model.purpose, model.command].compactMap { $0 }.joined(separator: " ")
        content.sound = ApprovalAttention.sound == "none" ? nil : UNNotificationSound.default
        content.threadIdentifier = "approval.\(model.identifier)"
        content.userInfo = [ApprovalNotificationRelay.tokenKey: token]
        let id = "approval.\(model.identifier).\(token)"
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
            if let error { KitHost.log("approval reminder failed id=\(id): \(error.localizedDescription)") }
        }
        postedID = id
        KitHost.log("approval \(model.identifier) reminder posted id=\(id)")
    }

    /// Cancels a reminder not posted yet, takes a posted one out of Notification Center, and gives the click handling
    /// back to the host. Safe to call twice.
    func stop() {
        pending?.cancel()
        pending = nil
        expiry?.cancel()
        expiry = nil
        guard let center = Self.center else { return }
        if let id = postedID {
            center.removeDeliveredNotifications(withIdentifiers: [id])
            postedID = nil
        }
        ApprovalNotificationRelay.unregister(token: token, center: center)
    }
}

/// Takes a click on an approval reminder and brings that request's panel forward; every other notification goes on
/// to the delegate that was in place before (the host's), so its routes and replies still run. One relay serves every
/// reminder of the process, and the host's delegate comes back when the last reminder stops.
final class ApprovalNotificationRelay: NSObject, UNUserNotificationCenterDelegate {
    static let tokenKey = "genesis.approval"

    private static var shared: ApprovalNotificationRelay?
    /// The click handler of each reminder still waiting, by its token. Read and written on the main thread only.
    private static var handlers: [String: () -> Void] = [:]

    /// Strong: the notification center holds its delegate weakly, and the host's must still be there on restore.
    private let previous: UNUserNotificationCenterDelegate?

    private init(previous: UNUserNotificationCenterDelegate?) {
        self.previous = previous
    }

    static func register(token: String, center: UNUserNotificationCenter, onClick: @escaping () -> Void) {
        handlers[token] = onClick
        guard shared == nil else { return }
        let relay = ApprovalNotificationRelay(previous: center.delegate)
        shared = relay
        center.delegate = relay
    }

    static func unregister(token: String, center: UNUserNotificationCenter) {
        handlers[token] = nil
        guard handlers.isEmpty, let relay = shared else { return }
        if center.delegate === relay { center.delegate = relay.previous }
        shared = nil
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        if previous?.userNotificationCenter?(center, willPresent: notification, withCompletionHandler: completionHandler) == nil {
            completionHandler([.banner, .sound])
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        guard let token = response.notification.request.content.userInfo[Self.tokenKey] as? String else {
            if previous?.userNotificationCenter?(center, didReceive: response, withCompletionHandler: completionHandler) == nil {
                completionHandler()
            }
            return
        }

        KitHost.log("approval reminder clicked id=\(response.notification.request.identifier)")
        DispatchQueue.main.async {
            // A reminder that already stopped has no handler: its panel is gone, so the click does nothing.
            Self.handlers[token]?()
            completionHandler()
        }
    }
}
