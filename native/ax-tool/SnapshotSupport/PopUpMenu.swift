import Foundation

/// Does pressing this control open a menu INSIDE the window, rather than perform an action?
///
/// `AXShowMenu` says so outright. Otherwise only the two roles AppKit and SwiftUI give a control
/// whose whole job is to present a menu qualify; an ordinary button that happens to open one is
/// indistinguishable from one that does not until it has done it.
public func pressOpensMenu(role: String?, axAction: String) -> Bool {
    if axAction == "AXShowMenu" {
        return true
    }

    guard axAction == "AXPress" else { return false }

    return ["AXMenuButton", "AXPopUpButton"].contains(role ?? "")
}

/// The row index of the menu the element at `owner` currently has open, if any.
///
/// The observed walk is pre-order, so an element's descendants follow it immediately at a greater
/// depth. A menu button that has opened its menu therefore carries an `AXMenu` inside that span.
/// Searching the span rather than the whole tree matters once two menu buttons sit in one window:
/// the answer must be about THIS control, not about any menu being open somewhere.
public func openMenuIndex(owner: Int, rows: [[String: Any]]) -> Int? {
    guard rows.indices.contains(owner), let ownerDepth = rows[owner]["depth"] as? Int else { return nil }

    for index in rows.index(after: owner)..<rows.endIndex {
        guard let depth = rows[index]["depth"] as? Int, depth > ownerDepth else { return nil }

        if rows[index]["role"] as? String == "AXMenu" {
            return index
        }
    }

    return nil
}

/// Whether an opened in-window menu has arrived in this tree: the thing `--refresh` waits for.
///
/// 🛑 Measured 2026-09-22 on a live SwiftUI menu button: `AXUIElementPerformAction` returned
/// `.success` immediately and the menu was built a moment later, so a settle that stops as soon as
/// two reads agree stopped BEFORE the menu existed. Two of five presses returned a tree with no
/// menu in it, and every one of the five reported `ok: true`. A tree that has not started changing
/// reads exactly like a tree that has finished.
public func treeCarriesOpenMenu(_ rows: [[String: Any]]) -> Bool {
    return rows.contains { $0["role"] as? String == "AXMenu" }
}
