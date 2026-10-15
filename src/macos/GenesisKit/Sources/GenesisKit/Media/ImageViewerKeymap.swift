//
//  ImageViewerKeymap.swift
//  GenesisKit
//
//  Keys of the image viewer. Zoom in is the key that types "+", so on a Czech keyboard Command on the
//  key that types "+" zooms in. 100 % is the digit 1: Shift Command on that same key types "1".
//

import AppKit

@MainActor
public enum ImageViewerKeymap {
    public static let shared = Keymap(library: library)

    /// The compare picker. Its arrows and Return work only while it is open.
    public static let pickerScope: KeymapScope = "imageViewer.picker"

    public static let zoomIn = "imageViewer.zoom.in"
    public static let zoomOut = "imageViewer.zoom.out"
    public static let fit = "imageViewer.zoom.fit"
    public static let actualSize = "imageViewer.zoom.actual"
    public static let copy = "imageViewer.edit.copy"
    public static let close = "imageViewer.window.close"
    public static let back = "imageViewer.navigate.back"
    public static let previous = "imageViewer.navigate.previous"
    public static let next = "imageViewer.navigate.next"
    public static let dividerLeft = "imageViewer.compare.left"
    public static let dividerRight = "imageViewer.compare.right"
    public static let pickerLeft = "imageViewer.picker.left"
    public static let pickerRight = "imageViewer.picker.right"
    public static let pickerUp = "imageViewer.picker.up"
    public static let pickerDown = "imageViewer.picker.down"
    public static let pickerChoose = "imageViewer.picker.choose"

    public static let library = KeymapLibrary(id: "imageViewer", title: "Image Viewer", commands: [
        KeymapCommand(zoomIn, "Zoom In", group: "Zoom",
                      keys: [.character("+", .command), .character("=", .command)]),
        KeymapCommand(zoomOut, "Zoom Out", group: "Zoom", keys: [.character("-", .command), .character("_", .command)]),
        KeymapCommand(fit, "Fit to Window", group: "Zoom", keys: [.character("0", .command)]),
        KeymapCommand(actualSize, "Actual Size", group: "Zoom", keys: [.character("1", .command)]),
        KeymapCommand(copy, "Copy Image", group: "Edit",
                      keys: [.character("c", .command), .code(8, .command)]),
        KeymapCommand(close, "Close", group: "Window", keys: [.character("w", .command)]),
        KeymapCommand(back, "Back", group: "Navigate",
                      detail: "One layer: the picker, then the compare, then the window.",
                      keys: [.code(53)]),
        KeymapCommand(previous, "Previous Image", group: "Navigate", keys: [.code(123)]),
        KeymapCommand(next, "Next Image", group: "Navigate", keys: [.code(124)]),
        // Shift is the small step. One command, the same as the handler that reads the modifiers.
        KeymapCommand(dividerLeft, "Divider Left", group: "Compare",
                      keys: [.code(123, .option), .code(123, [.option, .shift])]),
        KeymapCommand(dividerRight, "Divider Right", group: "Compare",
                      keys: [.code(124, .option), .code(124, [.option, .shift])]),
        KeymapCommand(pickerLeft, "Picker Left", group: "Picker", keys: [.code(123)], scope: pickerScope,
                      configurable: false),
        KeymapCommand(pickerRight, "Picker Right", group: "Picker", keys: [.code(124)], scope: pickerScope,
                      configurable: false),
        KeymapCommand(pickerUp, "Picker Up", group: "Picker", keys: [.code(126)], scope: pickerScope,
                      configurable: false),
        KeymapCommand(pickerDown, "Picker Down", group: "Picker", keys: [.code(125)], scope: pickerScope,
                      configurable: false),
        KeymapCommand(pickerChoose, "Choose Picture", group: "Picker", keys: [.code(36), .code(76)],
                      scope: pickerScope, configurable: false),
    ])

    public static func hint(_ title: String, _ id: String) -> String { shared.hint(title, id) }

    public static func label(_ id: String) -> String { shared.label(for: id) ?? "" }
}
