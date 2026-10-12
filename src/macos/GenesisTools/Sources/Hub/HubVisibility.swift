import AppKit

/// Whether anyone can see the hub window: not hidden with the app, not minimized, not fully covered by other
/// windows and not on another Space (`NSWindow.occlusionState`, which covers all four). The hub's polls wait
/// while it cannot: with no gate, the Agents mode ran `tools hub agents --json` about 60 times an hour all night
/// behind other windows (714 runs and 56.5 s of main-thread renders on 2026-10-10, inventory H2).
///
/// A scripted run (`--snapshot`, `--bench`) never watches: its window is alpha 0 and reads as covered, and it
/// must load exactly as a visible hub does.
@MainActor
final class HubVisibility {
    static let shared = HubVisibility()

    private(set) var visible = true
    private var observer: NSObjectProtocol?
    /// Held weakly: a listener goes when its owner does, so models created and dropped (tests make many) leave
    /// nothing behind.
    private struct Listener {
        weak var owner: AnyObject?
        let call: (Bool) -> Void
    }

    private var listeners: [Listener] = []

    /// Stored listeners; one whose owner went is dropped at the next registration or change.
    var listenerCount: Int {
        listeners.count
    }
    private var waiters: [UUID: CheckedContinuation<Void, Never>] = [:]

    /// Follows `window` from now on; called once, for the live hub's window. The state it has now counts too: a hub
    /// opened behind other windows (`--no-activate`) posts no change until it is uncovered, and polled meanwhile.
    func watch(_ window: NSWindow) {
        observer = NotificationCenter.default.addObserver(forName: NSWindow.didChangeOcclusionStateNotification, object: window, queue: .main) { [weak self, weak window] _ in
            MainActor.assumeIsolated {
                guard let window else { return }
                self?.set(window.occlusionState.contains(.visible))
            }
        }
        set(window.occlusionState.contains(.visible))
    }

    /// `listener` hears every change, with the new value, for as long as `owner` lives.
    func onChange<Owner: AnyObject>(_ owner: Owner, _ listener: @escaping (Owner, Bool) -> Void) {
        listeners.removeAll { $0.owner == nil }
        listeners.append(Listener(owner: owner) { [weak owner] visible in
            if let owner {
                listener(owner, visible)
            }
        })
    }

    /// Returns at once while the window can be seen, else as soon as it can again, or when the task is
    /// cancelled. A poll loop calls it before each round.
    func untilVisible() async {
        guard !visible else { return }
        let id = UUID()
        await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if visible || Task.isCancelled {
                    continuation.resume()
                } else {
                    waiters[id] = continuation
                }
            }
        } onCancel: {
            Task { @MainActor in self.wake(id) }
        }
    }

    private func wake(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume()
    }

    /// Tests and the occlusion observer.
    func set(_ next: Bool) {
        guard next != visible else { return }
        visible = next
        HubPerf.log("hub.visible \(next ? "shown" : "hidden"): polls \(next ? "resume" : "pause")")
        listeners.removeAll { $0.owner == nil }
        for listener in listeners {
            listener.call(next)
        }
        if next {
            let woken = waiters.values
            waiters = [:]
            for waiter in woken {
                waiter.resume()
            }
        }
    }
}
