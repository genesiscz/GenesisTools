import AppKit
import Combine

/// The order a key press is matched in. A position is the most specific (⌘ on the key right of P), a typed character
/// next, the US position only for keys that type no ASCII character (`KeyChord.matchesByUSPosition`).
public enum KeyMatchPass: CaseIterable, Sendable {
    case position, character, usPosition
}

/// Two commands that share a key where both work.
public struct KeymapConflict: Hashable, Sendable {
    public let chord: KeyChord
    public let commands: [String]
}

/// A library plus the user's configuration: the keys in force now. One per library and process; menus, tooltips,
/// `.keymapAction` views and the help window all read the same instance, so a key changed in the editor changes
/// everywhere at once.
@MainActor
public final class Keymap: ObservableObject {
    public let library: KeymapLibrary
    @Published public private(set) var configuration: KeymapConfiguration
    public let store: KeymapStore?
    private let layout: KeyLayout
    private var menuItems: [(item: WeakMenuItem, command: String)] = []
    private var activation: NSObjectProtocol?

    /// Reads the user's keys from `KeymapStore.standard(library:)`.
    public convenience init(library: KeymapLibrary) {
        self.init(library: library, store: .standard(library: library.id))
    }

    /// `store` nil keeps every change in memory (tests, previews). `layout` names the keys in labels; nil is the
    /// user's current keyboard layout.
    public init(library: KeymapLibrary, store: KeymapStore?, layout: KeyLayout? = nil) {
        self.library = library
        self.store = store
        self.layout = layout ?? SystemKeyLayout.shared
        configuration = store?.load() ?? KeymapConfiguration()
        // Another process may have changed the file (Genesis's Settings edits the markdown viewer's keys while the
        // viewer runs as its own app): read it again whenever this app comes to the front.
        if store != nil {
            activation = NotificationCenter.default.addObserver(
                forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.reload() }
            }
        }
    }

    deinit {
        if let activation { NotificationCenter.default.removeObserver(activation) }
    }

    // MARK: Reading

    /// The keys in force for a command: the user's, else the defaults. Empty when the user turned it off or the id is
    /// unknown.
    public func chords(for id: String) -> [KeyChord] {
        if let own = configuration.overrides[id] { return own }
        return library.command(id)?.defaults ?? []
    }

    public func chord(for id: String) -> KeyChord? { chords(for: id).first }

    /// "⇧⌘Ú", or nil when the command has no key.
    public func label(for id: String) -> String? { chord(for: id).map(label) }

    public func label(_ chord: KeyChord) -> String { chord.label(layout: layout) }

    /// "Save (⌘S)", the tooltip convention of the kit; "Save" when the command has no key.
    public func hint(_ title: String, _ id: String) -> String {
        guard let label = label(for: id) else { return title }
        return "\(title) (\(label))"
    }

    public func isCustomized(_ id: String) -> Bool { configuration.overrides[id] != nil }

    /// The chord of `id` this press is in one matching pass, if any.
    public func matchingChord(_ id: String, _ press: KeyStroke, pass: KeyMatchPass) -> KeyChord? {
        chords(for: id).first { chord in
            switch (pass, chord.key) {
            case (.position, .code), (.character, .character): return chord.matches(press)
            case (.usPosition, _): return chord.matchesByUSPosition(press)
            default: return false
            }
        }
    }

    /// The commands this press runs, among `scopes` (nil: all), from the first pass that finds any.
    public func commands(for press: KeyStroke, in scopes: Set<KeymapScope>? = nil) -> [KeymapCommand] {
        let candidates = library.commands.filter { scopes?.contains($0.scope) ?? true }
        for pass in KeyMatchPass.allCases {
            let found = candidates.filter { matchingChord($0.id, press, pass: pass) != nil }
            if !found.isEmpty { return found }
        }
        return []
    }

    // MARK: Conflicts

    /// Every key that two or more commands share where they all work.
    public func conflicts() -> [KeymapConflict] {
        var found: [KeymapConflict] = []
        var reported = Set<Set<String>>()
        for command in library.commands {
            for chord in chords(for: command.id) {
                let others = commands(using: chord, besides: command.id)
                guard !others.isEmpty else { continue }
                let ids = [command.id] + others.map(\.id)
                if reported.insert(Set(ids)).inserted { found.append(KeymapConflict(chord: chord, commands: ids)) }
            }
        }
        return found
    }

    /// The other commands that already use `chord` where `id` works: what a recorder warns about.
    public func commands(using chord: KeyChord, besides id: String) -> [KeymapCommand] {
        guard let command = library.command(id) else { return [] }
        return library.commands.filter { other in
            other.id != id && other.scope.meets(command.scope) && chords(for: other.id).contains { same($0, chord) }
        }
    }

    /// Whether two chords are the same key on this layout: equal; a position and the character the layout types
    /// there; a position with Shift and the symbol Shift types there (the Czech ⇧ú is "/"); or one symbol with and
    /// without the Shift its layout needs.
    func same(_ a: KeyChord, _ b: KeyChord) -> Bool {
        if a == b { return true }
        switch (a.key, b.key) {
        case (.code(let code), .character(let text)):
            return sameKey(code: code, a.modifiers, text: text, b.modifiers)
        case (.character(let text), .code(let code)):
            return sameKey(code: code, b.modifiers, text: text, a.modifiers)
        case (.character(let left), .character(let right)):
            return left == right && !KeyChord.isCased(left)
                && a.modifiers.subtracting(.shift) == b.modifiers.subtracting(.shift)
        default:
            return false
        }
    }

    private func sameKey(code: UInt16, _ codeModifiers: KeyModifiers, text: String, _ textModifiers: KeyModifiers) -> Bool {
        if codeModifiers == textModifiers, layout.character(for: code)?.lowercased() == text { return true }
        return !KeyChord.isCased(text) && !textModifiers.contains(.shift)
            && codeModifiers == textModifiers.union(.shift) && layout.shiftedCharacter(for: code) == text
    }

    // MARK: Changing

    /// Saves the user's keys for a command. The defaults again clear the override; an empty list turns the key off.
    public func setChords(_ chords: [KeyChord], for id: String) {
        guard library.command(id)?.configurable == true else { return }
        if chords == library.command(id)?.defaults {
            configuration.overrides.removeValue(forKey: id)
        } else {
            configuration.overrides[id] = chords
        }
        changed()
    }

    public func reset(_ id: String) {
        guard configuration.overrides.removeValue(forKey: id) != nil else { return }
        changed()
    }

    public func resetAll() {
        guard !configuration.overrides.isEmpty else { return }
        configuration.overrides = [:]
        changed()
    }

    /// Reads the file again (another process changed it). Runs by itself when the app becomes active.
    public func reload() {
        guard let store else { return }
        let fresh = store.load()
        guard fresh != configuration else { return }
        configuration = fresh
        applyMenus()
    }

    private func changed() {
        if let store {
            do {
                try store.save(configuration)
            } catch {
                GenesisKit.log("keymap: saving \(store.fileURL.path) failed: \(error)")
            }
        }
        applyMenus()
    }

    // MARK: Menus

    /// Gives the item the command's key and keeps it current when the user changes it. The item only shows the key
    /// and runs on a click: a live `.keymapAction` or a `KeymapDispatcher` registration takes the key press first.
    public func bind(_ item: NSMenuItem, to id: String) {
        menuItems.removeAll { $0.item.value == nil || $0.item.value === item }
        menuItems.append((WeakMenuItem(item), id))
        apply(item, id)
    }

    private func applyMenus() {
        menuItems.removeAll { $0.item.value == nil }
        for entry in menuItems {
            if let item = entry.item.value { apply(item, entry.command) }
        }
    }

    private func apply(_ item: NSMenuItem, _ id: String) {
        guard let chord = chord(for: id) else {
            item.keyEquivalent = ""
            item.keyEquivalentModifierMask = []
            return
        }
        item.keyEquivalent = chord.menuKeyEquivalent
        item.keyEquivalentModifierMask = chord.modifiers.eventFlags
    }
}

final class WeakMenuItem {
    weak var value: NSMenuItem?
    init(_ value: NSMenuItem) { self.value = value }
}
