import Foundation

/// What ⌘Q does in a face while other GenesisTools parts run beside it (the widget, the feature settings face with
/// Clicky). One choice for every face, in the app's defaults: General → Quitting edits it, and the quit question's
/// "Don't ask again" writes it.
package enum QuitBehavior: String, CaseIterable, Sendable {
    case ask
    case thisPart
    case allParts

    package static let defaultsKey = "app.quit.behavior"
    /// Posted after a write, so a settings window open in another face shows the new choice.
    package static let changedNotification = Notification.Name(NativePreview.namespace + ".quit-behavior.changed")

    package static func stored(in defaults: UserDefaults) -> QuitBehavior {
        defaults.string(forKey: defaultsKey).flatMap(QuitBehavior.init(rawValue:)) ?? .ask
    }

    package static func store(_ behavior: QuitBehavior, in defaults: UserDefaults) {
        defaults.set(behavior.rawValue, forKey: defaultsKey)
        DistributedNotificationCenter.default().postNotificationName(
            changedNotification, object: nil, userInfo: nil, deliverImmediately: true)
    }
}

/// The question ⌘Q asks: quit only this part, or every running part. Every word comes from here, so the tests read
/// what the person reads.
struct QuitQuestion: Equatable, Sendable {
    let thisName: String
    let otherNames: [String]

    static let quitAllTitle = "Quit All"
    static let cancelTitle = "Cancel"
    static let dontAskTitle = "Don't ask again"
    static let dontAskTooltip = "Remembers this choice. You can change it later in Settings, on the General page."

    var title: String { "Quit only \(thisName), or all GenesisTools parts?" }
    var quitThisTitle: String { "Quit \(thisName)" }
    var message: String {
        let others = PartQuit.list(otherNames)
        return otherNames.count == 1
            ? "\(others) is also running. Quit All stops it too."
            : "\(others) are also running. Quit All stops them too."
    }
}

enum QuitPlan: Equatable, Sendable {
    /// Nothing else runs, or the setting says so: this face quits, with no question.
    case quitThis
    /// The setting says every part: these faces are asked to quit, then this one quits.
    case quitAll(otherPids: [Int32])
    case ask(QuitQuestion)
}

/// ⌘Q in a face that may have other GenesisTools parts running beside it. The tables here name every face the
/// question can list; a new face adds one row to `faceNames` and one to `faceOrder`.
package enum PartQuit {
    /// The name each face has in the question. The bare launch is the permissions window (`--window`).
    static let faceNames: [String: String] = [
        "--widget": "Widget",
        "--features": "Settings",
        "--hub": "Hub",
        "--review": "Review",
        "--markdown": "Markdown viewer",
        "--window": "Permissions",
    ]
    /// The order the question lists the faces in.
    static let faceOrder = ["--widget", "--features", "--hub", "--review", "--markdown", "--window"]

    /// A part that runs inside another face's process. While it is up (PartPresence) and the build links it, that
    /// face is called by the part's name: the feature settings face with Clicky's status item is "Clicky".
    struct HostedPart: Equatable, Sendable {
        let id: String
        let face: String
        let name: String
    }
    static let hostedParts = [HostedPart(id: "clicky", face: "--features", name: "Clicky")]

    /// The face of a process from its arguments after the executable, or nil for a process the question never names:
    /// the launcher (`GenesisTools <program> ...`), the link relay, `--rpc`, `--mic`, and the scripted runs
    /// (`--snapshot`, `--bench`, `--headless`), which nobody sees.
    static func face(ofArguments arguments: [String], preview: Bool = NativePreview.enabled) -> String? {
        if arguments.contains(where: { ["--snapshot", "--bench", "--headless"].contains($0) }) { return nil }
        let first = arguments.first ?? ""
        // A Preview bundle's bare launch is the widget (HostMain).
        if first.isEmpty, preview { return "--widget" }
        if first.isEmpty || first.hasPrefix("-psn_") { return "--window" }
        // The settings face's old name.
        if first == "--clicky" { return "--features" }
        // A hub link click that found no hub runs the hub in that process (HostMain).
        if HubLink.arguments(fromLink: first) != nil { return "--hub" }
        return faceNames[first] == nil ? nil : first
    }

    /// The name of `face`: its hosted parts that are up, or its own name.
    static func name(of face: String, linkedParts: Set<String>, liveHostedParts: Set<String>) -> String? {
        let hosted = hostedParts.filter {
            $0.face == face && linkedParts.contains($0.id) && liveHostedParts.contains($0.id)
        }
        return hosted.isEmpty ? faceNames[face] : list(hosted.map(\.name))
    }

    static func name(of face: String, in snapshot: RunningPartsSnapshot) -> String? {
        name(of: face, linkedParts: snapshot.linkedParts, liveHostedParts: snapshot.liveHostedParts)
    }

    /// This process's own name for its quit menu item: no process scan, only its own hosted parts.
    @MainActor
    package static func ownName(face: String) -> String {
        name(
            of: face, linkedParts: Set(AppParts.linked),
            liveHostedParts: Set(hostedParts.map(\.id).filter { PartPresence.isUp($0) })) ?? "GenesisTools"
    }

    /// Every named face but this process, in the question's order.
    static func otherFaces(of snapshot: RunningPartsSnapshot) -> [RunningFace] {
        snapshot.faces
            .filter { $0.pid != snapshot.ownPid && name(of: $0.face, in: snapshot) != nil }
            .sorted {
                let left = faceOrder.firstIndex(of: $0.face) ?? faceOrder.count
                let right = faceOrder.firstIndex(of: $1.face) ?? faceOrder.count
                return left == right ? $0.pid < $1.pid : left < right
            }
    }

    /// What ⌘Q does in `face`: quit at once when nothing else runs, else what the setting says, else ask.
    static func plan(face: String, snapshot: RunningPartsSnapshot, behavior: QuitBehavior) -> QuitPlan {
        let others = otherFaces(of: snapshot)
        guard !others.isEmpty else { return .quitThis }
        switch behavior {
        case .thisPart:
            return .quitThis
        case .allParts:
            return .quitAll(otherPids: others.map(\.pid))
        case .ask:
            var names: [String] = []
            for other in others {
                if let name = name(of: other.face, in: snapshot), !names.contains(name) { names.append(name) }
            }
            return .ask(QuitQuestion(thisName: name(of: face, in: snapshot) ?? "GenesisTools", otherNames: names))
        }
    }

    /// "Widget", "Widget and Hub", "Widget, Clicky and Hub".
    static func list(_ names: [String]) -> String {
        guard let last = names.last else { return "" }
        guard names.count > 1 else { return last }
        return names.dropLast().joined(separator: ", ") + " and " + last
    }
}
