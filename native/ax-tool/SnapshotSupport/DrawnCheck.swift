import CoreGraphics
import Foundation

/// How far in from a control's edge its inside is read, past a neighbour's border reaching over it.
public let blankInsetPixels = 4
/// 8-bit gray spread at or below which a patch is one flat colour.
public let blankRange = 12
/// Rows checked per snapshot at most; the check reads pixels, so its cost follows the row count.
public let drawnCheckRowLimit = 400

public enum DrawnVerdict: Equatable {
    case drawn
    case blank
    /// Too small to judge, or not wholly inside the capture: never reported as blank.
    case unknown
}

/// Whether the capture shows anything where a control says it is, ported from
/// typesafe-computer-use's `drawn`.
///
/// A page can hide an element with CSS clipping and still report it to Accessibility as visible:
/// Chosen, a common dropdown widget, keeps its search box in a clipped panel under the closed
/// control, so a press there lands on empty page. Such a box is one flat colour inside and has no
/// border down either side. An empty field has its border, and a control with a label or an icon
/// has ink inside, so both count as drawn. Every patch is read a few pixels in from the top and
/// bottom edges, where a neighbour's border can reach over, and the inside a few pixels in from the
/// sides as well. Blank means all three patches are flat.
public func drawnVerdict(_ image: GrayImage, pixels rect: CGRect) -> DrawnVerdict {
    guard [rect.minX, rect.minY, rect.maxX, rect.maxY].allSatisfy({ $0.isFinite }) else {
        return .unknown
    }

    let x1 = Int(rect.minX.rounded())
    let y1 = Int(rect.minY.rounded())
    let x2 = Int(rect.maxX.rounded())
    let y2 = Int(rect.maxY.rounded())
    guard x1 >= 0, y1 >= 0, x2 <= image.width, y2 <= image.height, x2 - x1 >= 2, y2 - y1 >= 2 else {
        return .unknown
    }

    let insetX = min(blankInsetPixels, (x2 - x1) / 4)
    let insetY = min(blankInsetPixels, (y2 - y1) / 4)
    let patches = [
        (x1 + insetX, y1 + insetY, x2 - insetX, y2 - insetY),
        (x1, y1 + insetY, x1 + insetX, y2 - insetY),
        (x2 - insetX, y1 + insetY, x2, y2 - insetY),
    ]
    for (px1, py1, px2, py2) in patches {
        if let spread = image.extrema(x1: px1, y1: py1, x2: px2, y2: py2, stopAbove: blankRange),
           Int(spread.high) - Int(spread.low) > blankRange {
            return .drawn
        }
    }
    return .blank
}

/// Roles a caller presses or sets.
private let drawnCheckRoles: Set<String> = [
    "AXButton", "AXLink", "AXTextField", "AXTextArea", "AXComboBox", "AXPopUpButton", "AXCheckBox",
    "AXRadioButton", "AXMenuButton", "AXCell",
]
/// Chromium puts these two on nearly every node, so on their own they do not make a row a control.
private let ambientActions: Set<String> = ["AXScrollToVisible", "AXShowMenu"]

/// Indexes of the actionable rows whose frame the capture shows as blank, for `"drawn": false`.
///
/// Only a row that is visible in its scroll clip, maps wholly into the capture and reads blank is
/// named; the window row itself is skipped. At most `limit` rows are read, in tree order.
public func undrawnRows(rows: [[String: Any]], frames: [CGRect], window: CGRect, image: GrayImage,
                        limit: Int = drawnCheckRowLimit) -> [Int] {
    var checked = 0
    var blank: [Int] = []
    for index in rows.indices.dropFirst() where index < frames.count {
        guard checked < limit else {
            break
        }

        let row = rows[index]
        let actions = row["actions"] as? [String] ?? []
        guard row["visible"] as? Bool == true,
              drawnCheckRoles.contains(row["role"] as? String ?? "") || actions.contains(where: { !ambientActions.contains($0) }),
              let rect = sourcePixelRect(frames[index], window: window, imageWidth: image.width, imageHeight: image.height) else {
            continue
        }

        checked += 1
        if drawnVerdict(image, pixels: rect) == .blank {
            blank.append(index)
        }
    }
    return blank
}
