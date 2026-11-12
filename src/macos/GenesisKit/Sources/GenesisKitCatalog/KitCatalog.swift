import AppKit
import GenesisKit
import SwiftUI

// MARK: - The catalog's parts

/// One drawing of a component: a state, a size or a set of props, with the words that name it.
public struct CatalogVariant: Identifiable {
    public let id = UUID()
    public let title: String
    /// The props that make this drawing, as a reader of the code would write them.
    public let props: String?
    public let content: AnyView

    public init(_ title: String, props: String? = nil, @ViewBuilder content: () -> some View) {
        self.title = title
        self.props = props
        self.content = AnyView(content())
    }
}

/// A named run of variants: "Kinds", "States", "In a narrow column".
public struct CatalogSection: Identifiable {
    public enum Flow { case row, column }

    public let id = UUID()
    public let title: String
    public let flow: Flow
    public let variants: [CatalogVariant]

    public init(_ title: String, flow: Flow = .row, _ variants: [CatalogVariant]) {
        self.title = title
        self.flow = flow
        self.variants = variants
    }
}

/// A component of the kit in the catalog: what it is for, where it lives, and its variants. The same variants are
/// drawn once per look, so a sheet of a proposed look differs from today's sheet only in the look.
public struct CatalogEntry: Identifiable {
    public let id: String
    public let group: String
    public let name: String
    public let summary: String
    /// The file under `Sources/`, so a reader finds the code.
    public let source: String
    /// A component that did not exist before the looks. Its classic sheet shows it in today's greys.
    public let isNew: Bool
    /// What is weak in today's look, one line each.
    public let critique: [String]
    /// The looks that get a sheet. A component no look changes yet has only `.classic`.
    public let looks: [KitLook]
    /// What a look changes for this component, when the look's own pitch does not say it.
    public let notes: [KitLook: String]
    public let sections: [CatalogSection]

    public init(id: String, group: String, name: String, summary: String, source: String, isNew: Bool = false,
                critique: [String], looks: [KitLook] = KitLook.allCases, notes: [KitLook: String] = [:],
                sections: [CatalogSection]) {
        self.id = id
        self.group = group
        self.name = name
        self.summary = summary
        self.source = source
        self.isNew = isNew
        self.critique = critique
        self.looks = looks
        self.notes = notes
        self.sections = sections
    }

    /// The badge of one of its sheets.
    public func sheetTitle(_ look: KitLook) -> String {
        guard look == .classic else { return look.catalogTitle }
        return isNew ? "New · in today's look" : "Today"
    }

    /// The words under the name on one of its sheets.
    public func sheetText(_ look: KitLook) -> String {
        guard look != .classic else { return summary }
        return [look.catalogPitch, notes[look]].compactMap { $0 }.joined(separator: " ")
    }
}

public extension KitLook {
    /// The look's name on a sheet: the proposals carry a letter, so a pick is one letter.
    var catalogTitle: String {
        switch self {
        case .classic: "Today"
        case .aurora: "A · Aurora"
        case .candy: "B · Candy"
        case .glass: "C · Glass"
        }
    }

    var catalogPitch: String {
        switch self {
        case .classic: "What the kit draws today."
        case .aurora: "Raised dark surfaces and a hue per meaning. The selected tab is a lighter pill; colour sits on glyphs, counts and tinted actions, and the one main action glows."
        case .candy: "Capsules and saturated colour. What is selected or primary is a gradient in its hue with a glow, and a count is a bright chip."
        case .glass: "Surfaces lit from above and hairlines. A surface has no colour; a hue shows on a glyph, on a count and as a line under the selected tab."
        }
    }
}

/// The design system's fixture: every catalogued component with its variants. The snapshot tool draws it, and a test
/// keeps it complete. Add an entry here when you add a control to the kit.
@MainActor
public enum KitCatalog {
    public static var entries: [CatalogEntry] {
        [hues, people, tabs, buttons, toggleChips, iconButtons, ghostButton, primaryButton, hoverStyles, badges,
         autocomplete, autocompleteFolder, numberField, failureInline] + statusEntries + inputEntries + settingsEntries + dataEntries
    }
}

// MARK: - A sheet

/// One look of one entry as a design-system sheet: the name, what it is for, then each section with its variants and
/// their props.
public struct CatalogSheet: View {
    let entry: CatalogEntry
    let look: KitLook

    public init(entry: CatalogEntry, look: KitLook) {
        self.entry = entry
        self.look = look
    }

    public static let width: CGFloat = 760

    public var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            ForEach(entry.sections) { section in
                Rectangle().fill(Color.white.opacity(0.07)).frame(height: 1)
                sectionView(section)
                    .kitLook(look)
            }
        }
        .frame(width: Self.width, alignment: .leading)
        .background(Color(nsColor: KitPalette.background))
        .environment(\.colorScheme, .dark)
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Text(verbatim: entry.group.uppercased())
                    .font(.system(size: 10.5, weight: .bold)).kerning(0.8)
                    .foregroundStyle(Color.white.opacity(0.45))
                Spacer()
                Text(verbatim: entry.sheetTitle(look))
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(look == .classic ? Color.white.opacity(0.78) : Color.black.opacity(0.85))
                    .padding(.horizontal, 9).padding(.vertical, 3)
                    .background(look == .classic ? Color.white.opacity(0.12) : KitHue.care.ink, in: Capsule())
            }
            Text(verbatim: entry.name).font(.system(size: 22, weight: .bold)).foregroundStyle(.white)
            Text(verbatim: entry.sheetText(look))
                .font(.system(size: 13)).foregroundStyle(Color.white.opacity(0.72))
                .fixedSize(horizontal: false, vertical: true)
            Text(verbatim: entry.source).font(.system(size: 11, design: .monospaced)).foregroundStyle(Color.white.opacity(0.4))
        }
        .padding(.horizontal, 24).padding(.top, 20).padding(.bottom, 16)
    }

    private func sectionView(_ section: CatalogSection) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(verbatim: section.title).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(Color.white.opacity(0.55))
            switch section.flow {
            case .row:
                WrapLayout(spacing: 22, lineSpacing: 16) {
                    ForEach(section.variants) { variant in
                        variantView(variant)
                    }
                }
            case .column:
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(section.variants) { variant in
                        variantView(variant)
                    }
                }
            }
        }
        .padding(.horizontal, 24).padding(.vertical, 16)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func variantView(_ variant: CatalogVariant) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            variant.content
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: variant.title).font(.system(size: 10.5, weight: .medium)).foregroundStyle(Color.white.opacity(0.6))
                // Always two lines of caption, so the drawings of one row stand on one line.
                Text(verbatim: variant.props ?? " ").font(.system(size: 10, design: .monospaced)).foregroundStyle(Color.white.opacity(0.36))
            }
        }
    }
}

// MARK: - Drawing a sheet to a picture

/// Draws a view to PNG data through a hosting view in a window that is never shown, so controls that AppKit backs
/// (a text field, a menu) draw too. The caller owns the application object and its activation policy.
@MainActor
public enum KitCatalogRenderer {
    public static func png(of view: some View, width: CGFloat, scale: CGFloat = 2) async -> Data? {
        let hosting = NSHostingView(rootView: AnyView(view.frame(width: width, alignment: .topLeading)))
        let fitting = hosting.fittingSize
        let size = NSSize(width: width, height: max(1, fitting.height))
        let window = NSWindow(contentRect: NSRect(origin: .zero, size: size), styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.isReleasedWhenClosed = false
        window.contentView = hosting
        hosting.frame = NSRect(origin: .zero, size: size)
        window.orderInForSnapshot()
        defer { window.close() }
        hosting.layoutSubtreeIfNeeded()
        // Anchor preferences and asynchronous control state settle before the window server captures them.
        try? await Task.sleep(for: .milliseconds(120))
        hosting.layoutSubtreeIfNeeded()
        guard let capture = await WindowSnapshot.capture(window) else { return nil }
        if capture.method != "window server" {
            FileHandle.standardError.write(Data("catalog snapshot: \(capture.method)\n".utf8))
        }

        let pixels = NSSize(width: size.width * scale, height: size.height * scale)
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(pixels.width), pixelsHigh: Int(pixels.height),
                                            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        bitmap.size = size
        guard let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        capture.image.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        return bitmap.representation(using: .png, properties: [:])
    }
}
