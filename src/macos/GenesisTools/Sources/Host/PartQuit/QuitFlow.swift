import AppKit
import Foundation

enum QuitAnswer: String, Equatable, Sendable {
    case quitThis
    case quitAll
    case cancel

    /// The setting "Don't ask again" stores with this answer; Cancel stores nothing.
    var remembered: QuitBehavior? {
        switch self {
        case .quitThis: return .thisPart
        case .quitAll: return .allParts
        case .cancel: return nil
        }
    }
}

struct QuitReply: Equatable, Sendable {
    let answer: QuitAnswer
    let dontAskAgain: Bool
}

@MainActor
protocol QuitDialogPresenting {
    func ask(_ question: QuitQuestion) -> QuitReply
}

@MainActor
protocol FaceTerminating {
    func quit(pids: [Int32])
}

@MainActor
protocol QuitBehaviorStoring {
    var behavior: QuitBehavior { get }
    func remember(_ behavior: QuitBehavior)
}

/// ⌘Q in one face: read what runs, decide, ask when the setting says so, then quit the other faces and this one.
@MainActor
struct QuitFlow {
    let face: String
    var probe: RunningPartsProbing
    var presenter: QuitDialogPresenting
    var terminator: FaceTerminating
    var store: QuitBehaviorStoring
    /// This face's own quit (`NSApp.terminate`), which runs its `applicationShouldTerminate` shutdown.
    var quitThis: () -> Void
    var log: (String) -> Void = { _ in }

    @discardableResult
    func run() -> QuitAnswer {
        let snapshot = probe.snapshot()
        switch PartQuit.plan(face: face, snapshot: snapshot, behavior: store.behavior) {
        case .quitThis:
            log("quit \(face): nothing else to ask about (setting \(store.behavior.rawValue))")
            quitThis()
            return .quitThis
        case .quitAll(let pids):
            log("quit \(face): every part by the setting, pids \(pids)")
            terminator.quit(pids: pids)
            quitThis()
            return .quitAll
        case .ask(let question):
            let reply = presenter.ask(question)
            if reply.dontAskAgain, let remembered = reply.answer.remembered { store.remember(remembered) }
            log("quit \(face): asked about \(question.otherNames), answer \(reply.answer.rawValue)\(reply.dontAskAgain ? ", don't ask again" : "")")
            switch reply.answer {
            case .cancel:
                break
            case .quitThis:
                quitThis()
            case .quitAll:
                // Read again: a part may have quit or started while the question was open.
                terminator.quit(pids: PartQuit.otherFaces(of: probe.snapshot()).map(\.pid))
                quitThis()
            }
            return reply.answer
        }
    }
}

extension PartQuit {
    nonisolated(unsafe) private static var asking = false

    /// The quit menu item of a face (⌘Q). Logout, a rebuild's reap and another face's "Quit All" still quit at once:
    /// they never reach this.
    @MainActor
    package static func request(face: String) {
        guard !asking else { return }
        asking = true
        defer { asking = false }
        QuitFlow(
            face: face, probe: LiveRunningPartsProbe(), presenter: AlertQuitDialog(), terminator: FaceQuitSignal(),
            store: DefaultsQuitBehaviorStore(defaults: .standard),
            quitThis: { NSApplication.shared.terminate(nil) },
            log: { PerfLog.mark($0) }
        ).run()
    }
}

struct DefaultsQuitBehaviorStore: QuitBehaviorStoring {
    let defaults: UserDefaults
    var behavior: QuitBehavior { QuitBehavior.stored(in: defaults) }
    func remember(_ behavior: QuitBehavior) { QuitBehavior.store(behavior, in: defaults) }
}

/// The question as a standard alert: Return quits only this part (what ⌘Q always did), ⌘A quits every part, Escape
/// and Cancel keep everything running, and "Don't ask again" turns the answer into the setting.
@MainActor
struct AlertQuitDialog: QuitDialogPresenting {
    func ask(_ question: QuitQuestion) -> QuitReply {
        let alert = Self.alert(for: question)
        // An accessory face (the widget) may hold the keyboard through a panel without being the active app.
        NSApp.activate()
        let response = alert.runModal()
        let dontAskAgain = alert.suppressionButton?.state == .on
        switch response {
        case .alertFirstButtonReturn: return QuitReply(answer: .quitThis, dontAskAgain: dontAskAgain)
        case .alertSecondButtonReturn: return QuitReply(answer: .quitAll, dontAskAgain: dontAskAgain)
        default: return QuitReply(answer: .cancel, dontAskAgain: false)
        }
    }

    /// The alert, built but not shown (the tests read its buttons and keys, and render it).
    static func alert(for question: QuitQuestion) -> NSAlert {
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = question.title
        alert.informativeText = question.message
        alert.addButton(withTitle: question.quitThisTitle)
        let all = alert.addButton(withTitle: QuitQuestion.quitAllTitle)
        all.keyEquivalent = "a"
        all.keyEquivalentModifierMask = .command
        // A button titled Cancel takes Escape.
        alert.addButton(withTitle: QuitQuestion.cancelTitle)
        alert.showsSuppressionButton = true
        alert.suppressionButton?.title = QuitQuestion.dontAskTitle
        alert.suppressionButton?.toolTip = QuitQuestion.dontAskTooltip
        // A logout or a shutdown while the question is open still quits.
        alert.window.preventsApplicationTerminationWhenModal = false
        return alert
    }
}

/// Asks other faces to quit through their own terminate path: a distributed notification with their pids, which each
/// face answers with `NSApp.terminate(nil)`, so its `applicationShouldTerminate` stops its services first. Never a
/// signal: SIGTERM skips that path, and only the faces listen, so the launcher's processes (bun services, the Claude
/// sessions it runs) and the link relay keep running.
struct FaceQuitSignal: FaceTerminating {
    static let name = Notification.Name(NativePreview.namespace + ".face.quit")
    static let pidsKey = "pids"

    func quit(pids: [Int32]) {
        guard !pids.isEmpty else { return }
        DistributedNotificationCenter.default().postNotificationName(
            Self.name, object: nil, userInfo: [Self.pidsKey: pids.map { NSNumber(value: $0) }],
            deliverImmediately: true)
    }

    /// True when the notification asks the process `pid` to quit.
    static func targets(_ userInfo: [AnyHashable: Any]?, pid: Int32) -> Bool {
        guard let pids = userInfo?[pidsKey] as? [NSNumber] else { return false }
        return pids.contains { $0.int32Value == pid }
    }

    nonisolated(unsafe) private static var observer: NSObjectProtocol?

    /// Once per face the quit question can name (HostMain), before its app runs.
    @MainActor
    static func listen() {
        guard observer == nil else { return }
        let own = getpid()
        observer = DistributedNotificationCenter.default().addObserver(forName: name, object: nil, queue: .main) { note in
            MainActor.assumeIsolated {
                guard targets(note.userInfo, pid: own) else { return }
                PerfLog.mark("quit: another GenesisTools part asked this face to quit")
                NSApplication.shared.terminate(nil)
            }
        }
    }
}
