import SwiftUI

@MainActor
public enum ScrollViewPositioning {
    /// NSTableView places rows it has not measured yet at estimated heights, so the first
    /// `scrollTo` of a far row lands short. The second pass, after those rows were measured on
    /// the way, lands exactly.
    public static func scroll(_ proxy: ScrollViewProxy, to id: String, anchor: UnitPoint) {
        DispatchQueue.main.async { proxy.scrollTo(id, anchor: anchor) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { proxy.scrollTo(id, anchor: anchor) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { proxy.scrollTo(id, anchor: anchor) }
    }

}
