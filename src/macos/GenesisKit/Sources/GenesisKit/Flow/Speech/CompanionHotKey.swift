// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Companion/CompanionHotKey.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
// Copied from /Users/Martin/Tresors/Projects/Rewind/apps/timetravel-app/TimeTravel/TimeTravel/App/HotKeyManager.swift at 2026-07-20T00:25:25+02:00 at commit hash 39b6b2f1865aed017e1ea1a0f6a4c0434df36311
// Adapted for Genesis Companion (spec §6.1): Rewind's three fixed Cmd-combos +
// scroll event tap became ONE configurable press-AND-release hotkey (default F6).
// The Carbon RegisterEventHotKey wiring is the stolen nugget; Rewind only
// listened for kEventHotKeyPressed — the companion also needs
// kEventHotKeyReleased to distinguish tap from hold.

import Foundation
import Carbon
import Cocoa

/// One global press/release hotkey backed by Carbon `RegisterEventHotKey`.
/// The registered key is swallowed system-wide (never reaches the app below),
/// which is exactly what the F6 walkthrough needs.
public final class CompanionHotKey {

    /// Carries WHEN the key event happened (`GetEventTime`, i.e. seconds on the
    /// `ProcessInfo.systemUptime` clock) — not when the callback ran.
    ///
    /// This matters because tap-vs-hold is decided by the gap between down and
    /// up, and a tap that reads as a hold records and sends a voice turn
    /// instead of just opening the panel. The callbacks hop to the main queue
    /// and the down handler kicks off arm() → screen capture, so the UP
    /// callback can run hundreds of ms after its event: measured live
    /// 2026-07-25, a 60 ms press was classified as an 828 ms hold.
    ///
    /// Timestamping here removes the main-queue hop from the measurement. It
    /// does NOT make it exact — with synthetic HID-posted keys the same 60 ms
    /// press still measured ~290 ms afterwards, so some of the delay is in the
    /// event pipeline itself while the app captures the screen. Physical
    /// presses are stamped by the HID layer, which is the case this protects.
    public typealias Callback = (TimeInterval) -> Void

    /// Fired on the main queue when the key goes down / up.
    public var onKeyDown: Callback?
    public var onKeyUp: Callback?

    public private(set) var keyCode: UInt32
    public private(set) var modifiers: UInt32

    private var hotKeyRef: EventHotKeyRef?
    private(set) var eventHandler: EventHandlerRef?
    var registerKeyOverride: (() -> Bool)?
    /// Carbon identity for THIS binding. Two instances must not share a
    /// (signature, id) pair or the second registration silently shadows the
    /// first — which is exactly what happens when Flow's dictation key and the
    /// companion's F6 both live in one process.
    private let hotKeyId: UInt32
    private let signature: OSType

    /// "GNCP" — Genesis CompanioN.
    public static let companionSignature: OSType = 0x474E_4350
    /// "GNFL" — Genesis FLow.
    public static let flowSignature: OSType = 0x474E_464C

    /// Default: bare F6 (kVK_F6 = 0x61), no modifiers, companion identity.
    public init(
        keyCode: UInt32 = UInt32(kVK_F6),
        modifiers: UInt32 = 0,
        signature: OSType = CompanionHotKey.companionSignature,
        hotKeyId: UInt32 = 1
    ) {
        self.keyCode = keyCode
        self.modifiers = modifiers
        self.signature = signature
        self.hotKeyId = hotKeyId
    }

    deinit {
        stop()
    }

    // MARK: - Lifecycle

    /// Register the hotkey + install press/release handlers.
    /// Returns false when Carbon refuses the registration (key taken).
    @discardableResult
    public func start() -> Bool {
        guard hotKeyRef == nil else { return true }
        if eventHandler != nil { return registerKey() }

        var eventTypes = [
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyPressed)
            ),
            EventTypeSpec(
                eventClass: OSType(kEventClassKeyboard),
                eventKind: UInt32(kEventHotKeyReleased)
            ),
        ]

        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            { (_, event, userData) -> OSStatus in
                guard let userData, let event else { return OSStatus(eventNotHandledErr) }
                let hotKey = Unmanaged<CompanionHotKey>.fromOpaque(userData).takeUnretainedValue()
                return hotKey.handleCarbonEvent(event)
            },
            eventTypes.count,
            &eventTypes,
            Unmanaged.passUnretained(self).toOpaque(),
            &eventHandler
        )
        guard installStatus == noErr else {
            FlowFocusLog.speech.error("CompanionHotKey: InstallEventHandler failed status=\(installStatus)")
            return false
        }

        return registerKey()
    }

    /// Unregister everything. Safe to call repeatedly.
    public func stop() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        if let handler = eventHandler {
            RemoveEventHandler(handler)
            eventHandler = nil
        }
    }

    /// Swap the bound key without restarting the app (§10.5 remap acceptance).
    @discardableResult
    public func rebind(keyCode: UInt32, modifiers: UInt32) -> Bool {
        self.keyCode = keyCode
        self.modifiers = modifiers
        guard eventHandler != nil else { return true } // not started yet
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        return registerKey()
    }

    // MARK: - Internals

    private func registerKey() -> Bool {
        if let registerKeyOverride { return registerKeyOverride() }
        let id = EventHotKeyID(signature: signature, id: hotKeyId)
        var ref: EventHotKeyRef?
        let status = RegisterEventHotKey(
            keyCode,
            modifiers,
            id,
            GetApplicationEventTarget(),
            0,
            &ref
        )
        guard status == noErr else {
            FlowFocusLog.speech.error("CompanionHotKey: RegisterEventHotKey failed status=\(status) keyCode=\(self.keyCode)")
            return false
        }
        hotKeyRef = ref
        FlowFocusLog.speech.info("CompanionHotKey registered keyCode=\(self.keyCode) modifiers=\(self.modifiers)")
        return true
    }

    private func handleCarbonEvent(_ event: EventRef) -> OSStatus {
        var id = EventHotKeyID()
        let status = GetEventParameter(
            event,
            UInt32(kEventParamDirectObject),
            UInt32(typeEventHotKeyID),
            nil,
            MemoryLayout<EventHotKeyID>.size,
            nil,
            &id
        )
        guard status == noErr, id.signature == signature, id.id == hotKeyId else {
            return OSStatus(eventNotHandledErr)
        }

        let kind = GetEventKind(event)
        // Stamp the event, not the callback: see the `Callback` doc comment.
        let at = TimeInterval(GetEventTime(event))
        DispatchQueue.main.async { [weak self] in
            switch Int(kind) {
            case kEventHotKeyPressed: self?.onKeyDown?(at)
            case kEventHotKeyReleased: self?.onKeyUp?(at)
            default: break
            }
        }
        return noErr
    }
}
