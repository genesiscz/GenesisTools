import AppKit
import Foundation

/// One hub per login session, through GenesisKit's `SingleInstance` (Window/SingleInstance.swift): the hub holds
/// an exclusive `flock` on `~/.genesis-tools/hub/hub.lock` for its whole life, and a later `GenesisTools --hub`
/// that cannot take it hands its arguments to the hub and exits, so `tools hub` twice never opens two windows.
package enum HubSingleInstance {
    private static let instance = SingleInstance(
        name: "hub",
        lockFile: NativePreview.hubFile("hub.lock"),
        notificationPrefix: NativePreview.namespace + ".hub",
        retryHint: "quit that one, then run tools hub again.",
        log: { HubPerf.log($0) }
    )

    /// True when this process is now THE hub. Call once, before the window is built.
    package static func claim() -> Bool {
        instance.claim()
    }

    /// Another process holds the hub lock, so a hub runs there.
    package static var isRunningElsewhere: Bool {
        instance.isRunningElsewhere
    }

    /// Hands `args` to the hub that holds the lock. True when it answered.
    package static func forwardToRunningHub(_ args: [String]) -> Bool {
        instance.forward(args)
    }

    /// For a window that is already running (a review window's Dock click): post the request and go on.
    package static func handOff(_ args: [String]) {
        instance.handOff(args)
    }

    /// Called by the hub that holds the lock: applies every later launch's arguments.
    package static func serve(_ apply: @escaping ([String]) -> Void) {
        instance.serve(apply)
    }
}
