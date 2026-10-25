import AppKit
import SwiftUI

/// Stale-while-revalidate on screen: a view paints the last answer (`DiskCache`), marks it as
/// refreshing (`RefreshingMark`), always asks again, slides new rows in and flashes the rows the
/// fresh answer changed once. Only the read path: a destructive action never trusts a cached row.
///
///     let moved = SWR.changed(before: shown, after: fresh.map { ($0.id, $0.signature) })
///     withAnimation(SWR.animation) { rows = fresh; changed = moved }
///     SWR.fade(moved, current: { changed }, clear: { changed = [] })
///     row.swrFlash(changed.contains(row.id)).transition(SWR.rowTransition)
public enum SWR {
    /// The refresh spring, or nil (an instant change) while Reduce Motion is on: the system's or the app's own
    /// (`NativeSettingsAppearance`, the hub's General → Reduce motion), the two `@GenReduceMotion` reads. Read at
    /// each refresh, so a change takes effect without a restart.
    public static var animation: Animation? {
        reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.85)
    }

    /// `withAnimation` runs on the main thread, and so does every caller; off it the app's setting cannot be read and
    /// only the system's counts.
    private static var reduceMotion: Bool {
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { return true }
        guard Thread.isMainThread else { return false }
        return MainActor.assumeIsolated { NativeSettingsAppearance.shared.reduceMotion }
    }

    /// New rows slide in from the top; gone rows fade.
    public static let rowTransition: AnyTransition = .asymmetric(
        insertion: .move(edge: .top).combined(with: .opacity),
        removal: .opacity
    )

    /// The ids that are new or whose signature moved. Empty when nothing was on screen before:
    /// a first paint slides in, it does not flash.
    public static func changed<ID: Hashable>(before: [ID: String], after: [(ID, String)]) -> Set<ID> {
        guard !before.isEmpty else { return [] }
        return Set(after.filter { before[$0.0] != $0.1 }.map(\.0))
    }

    /// Whether a refresh is small enough to slide and flash: at most `limit` rows added, changed or gone.
    /// A bigger one (a page from disk that is days old, another filter) swaps without animation. In a lazy
    /// stack the fading rows of a wholesale swap stayed drawn among the new ones, with their old labels
    /// ("14:40 … 3 days ago" inside the 21:00 group of Activity, 2026-10-10).
    public static func animates<ID: Hashable>(before: [ID: String], after: [(ID, String)], limit: Int = 12) -> Bool {
        guard !before.isEmpty else { return false }
        let kept = Set(after.map(\.0))
        let gone = before.keys.filter { !kept.contains($0) }.count
        let moved = after.filter { before[$0.0] != $0.1 }.count
        return gone + moved <= limit
    }

    /// Fades a flash out after it showed: `clear` runs 1.6 s later unless a newer refresh replaced it.
    @MainActor
    public static func fade<ID: Hashable>(_ flashed: Set<ID>, current: @escaping @MainActor () -> Set<ID>?, clear: @escaping @MainActor () -> Void) {
        guard !flashed.isEmpty else { return }
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_600_000_000)
            guard current() == flashed else { return }
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.6)) { clear() }
        }
    }
}

extension View {
    /// The once-per-refresh flash behind a row the last refresh changed.
    public func swrFlash(_ on: Bool, cornerRadius: CGFloat = 8, color: Color = SessionPalette.blue) -> some View {
        background(RoundedRectangle(cornerRadius: cornerRadius).fill(color.opacity(on ? 0.16 : 0)))
    }
}
