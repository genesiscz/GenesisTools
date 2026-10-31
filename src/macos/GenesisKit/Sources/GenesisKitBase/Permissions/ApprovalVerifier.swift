import AppKit
import LocalAuthentication
import LocalAuthenticationEmbeddedUI
import SwiftUI

/// Touch ID inside an approval window (Martin, 2026-10-29: "this probably can just be accepted by my touchid ... just
/// keep this window open so it captures my touchid confirmation"). The window shows Apple's own Touch ID glyph
/// (`LAAuthenticationView`), and the sensor listens as soon as the panel is on screen, so a touch approves without a
/// click. A failed or cancelled touch never denies: the window offers Try again until its deadline. "Use password…"
/// asks the system's password dialog instead, for a Mac or a moment without Touch ID.
///
/// The verifier answers once, through `onVerified` with the method ("touch-id" or "password"). Every step goes to
/// `onEvent` (the host writes it to its click log), so a live test can be read from the log.
@MainActor
public final class ApprovalVerifier: ObservableObject {
    public enum State: Equatable {
        /// The panel is not on screen yet.
        case idle
        /// The sensor listens.
        case listening
        /// The last try did not approve; the text says what happened and what to do.
        case failed(String)
        /// The system's password dialog is open.
        case password
        /// Touch ID cannot be used now; the password is the way.
        case unavailable(String)
        /// Nothing to approve (every row unticked): the sensor does not listen until a row is on again.
        case paused
        case verified
    }

    /// What to do after a biometric evaluation ended without success.
    public enum Outcome: Equatable {
        /// Show the text and offer Try again.
        case retry(String)
        /// Touch ID is out for now: show the text and offer the password only.
        case passwordOnly(String)
        /// The person picked the password.
        case password
        /// Our own cancel (a deny, the deadline, a restart): nothing to show.
        case ignore
    }

    @Published public private(set) var state: State = .idle
    /// Changes with every new evaluation, so the glyph view is rebuilt for its new context.
    @Published public private(set) var attempt = 0

    public var onVerified: @MainActor (_ method: String) -> Void = { _ in }
    public var onEvent: @MainActor (_ event: String) -> Void = { _ in }

    let reason: String
    private let evaluator: ApprovalBiometricEvaluator
    /// The context the glyph shows and the sensor answers; nil while no evaluation runs.
    private(set) var context: LAContext?
    /// The evaluation started while the panel did not have the keyboard. If the sensor does not answer a panel that is
    /// not key, the click that makes it key starts a fresh one.
    private var startedWhileNotKey = false
    private var answered = false

    /// `reason` is what the system's password dialog says the app wants ("approve: Delete 2 items for shop?").
    public init(reason: String, evaluator: ApprovalBiometricEvaluator = SystemBiometricEvaluator()) {
        self.reason = reason
        self.evaluator = evaluator
    }

    /// Whether this Mac can use Touch ID now, read without starting anything. The window picks its footer from it
    /// before the first frame.
    public var biometricsAvailable: Bool {
        evaluator.unavailableReason(LAContext()) == nil
    }

    /// Called by the glyph's host view once it is in a window on screen: starts listening.
    func begin(windowIsKey: Bool) {
        guard !answered, state == .idle else { return }
        start(windowIsKey: windowIsKey)
    }

    /// "Try again": a new evaluation with a new context.
    public func retry() {
        guard !answered else { return }
        onEvent("biometric.retry")
        start(windowIsKey: NSApp?.keyWindow != nil)
    }

    /// The panel took the keyboard (a click into it). An evaluation started before that, or one that failed then,
    /// starts again, in case the sensor only answers a key window.
    func windowBecameKey() {
        guard !answered, startedWhileNotKey else { return }
        switch state {
        case .listening, .failed:
            onEvent("biometric.restart reason=panel-became-key")
            start(windowIsKey: true)
        default:
            break
        }
    }

    /// "Use password…": the system's dialog for the account password (or Touch ID in that dialog).
    public func usePassword() {
        guard !answered else { return }
        stopContext()
        state = .password
        onEvent("password.start")
        evaluator.evaluatePassword(reason: reason) { [weak self] ok, error in
            Task { @MainActor in
                guard let self, !self.answered else { return }
                if ok {
                    self.succeed(method: "password")
                    return
                }

                let code = (error as? LAError)?.code
                self.onEvent("password.end ok=false code=\(code.map { String($0.rawValue) } ?? "none") error=\(error?.localizedDescription ?? "none")")
                // A cancelled password dialog is not a deny: back to the window, which still waits for a decision.
                let available = self.evaluator.unavailableReason(LAContext())
                self.state = available.map { State.unavailable($0) } ?? .failed("The password was not confirmed. Touch the sensor or try the password again.")
                GenAnnounce.post("The password was not confirmed")
            }
        }
    }

    /// The window closed (a deny, the deadline): stop listening.
    public func cancel() {
        answered = true
        stopContext()
    }

    /// Every row was unticked, or the deny note is open: a touch must not approve. Listening stops; `resume` starts
    /// it again.
    public func pause(reason: String = "nothing-selected") {
        guard !answered, state != .paused else { return }
        stopContext()
        state = .paused
        onEvent("biometric.pause reason=\(reason)")
    }

    public func resume() {
        guard !answered, state == .paused else { return }
        onEvent("biometric.resume")
        start(windowIsKey: NSApp?.keyWindow != nil)
    }

    private func start(windowIsKey: Bool) {
        stopContext()
        let context = LAContext()
        if let unavailable = evaluator.unavailableReason(context) {
            state = .unavailable(unavailable)
            onEvent("biometric.unavailable \(unavailable)")
            return
        }

        self.context = context
        startedWhileNotKey = !windowIsKey
        attempt += 1
        state = .listening
        onEvent("biometric.start attempt=\(attempt) windowKey=\(windowIsKey) appActive=\(NSApp?.isActive ?? false)")
    }

    /// Called by the glyph's view once it is paired with `context`: the evaluation runs through that view.
    func evaluate(_ paired: LAContext) {
        guard !answered, paired === context, state == .listening else { return }
        evaluator.evaluateBiometrics(paired, reason: reason) { [weak self] ok, error in
            Task { @MainActor in
                guard let self, paired === self.context, !self.answered else { return }
                if ok {
                    self.succeed(method: "touch-id")
                    return
                }

                let code = (error as? LAError)?.code
                let outcome = Self.outcome(for: code)
                self.onEvent("biometric.end ok=false code=\(code.map { String($0.rawValue) } ?? "none") outcome=\(outcome) error=\(error?.localizedDescription ?? "none")")
                switch outcome {
                case .retry(let text):
                    self.state = .failed(text)
                    GenAnnounce.post(text)
                case .passwordOnly(let text):
                    self.state = .unavailable(text)
                    GenAnnounce.post(text)
                case .password:
                    self.usePassword()
                case .ignore:
                    break
                }
            }
        }
    }

    private func succeed(method: String) {
        guard !answered else { return }
        answered = true
        context = nil
        state = .verified
        onEvent("verified method=\(method)")
        onVerified(method)
    }

    private func stopContext() {
        let old = context
        context = nil
        old?.invalidate()
    }

    /// The words and the next step for a biometric evaluation that ended with `code`. Pure, so tests pin it.
    public nonisolated static func outcome(for code: LAError.Code?) -> Outcome {
        switch code {
        case .appCancel:
            return .ignore
        case .userFallback:
            return .password
        case .biometryLockout:
            return .passwordOnly("Touch ID is locked after too many tries. Use your password.")
        case .biometryNotAvailable, .biometryNotEnrolled, .biometryDisconnected, .passcodeNotSet:
            return .passwordOnly("Touch ID is not available right now. Use your password.")
        case .authenticationFailed:
            return .retry("Touch ID did not recognize the finger. Try again, or use your password.")
        case .userCancel, .systemCancel, .notInteractive:
            return .retry("Touch ID stopped listening. Try again, or use your password.")
        default:
            return .retry("Touch ID did not answer. Try again, or use your password.")
        }
    }
}

/// The LocalAuthentication calls behind `ApprovalVerifier`; a test or a picture uses one that never starts the sensor.
public protocol ApprovalBiometricEvaluator {
    /// nil when Touch ID can be used with `context` now, else a sentence that says why not.
    @MainActor func unavailableReason(_ context: LAContext) -> String?
    @MainActor func evaluateBiometrics(_ context: LAContext, reason: String, reply: @escaping @Sendable (Bool, Error?) -> Void)
    @MainActor func evaluatePassword(reason: String, reply: @escaping @Sendable (Bool, Error?) -> Void)
}

public struct SystemBiometricEvaluator: ApprovalBiometricEvaluator {
    public init() {}

    public func unavailableReason(_ context: LAContext) -> String? {
        var error: NSError?
        if context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) { return nil }
        switch (error as? LAError)?.code {
        case .biometryLockout:
            return "Touch ID is locked after too many tries. Use your password."
        case .biometryNotEnrolled:
            return "No finger is set up for Touch ID. Use your password."
        default:
            return "Touch ID is not available on this Mac. Use your password."
        }
    }

    public func evaluateBiometrics(_ context: LAContext, reason: String, reply: @escaping @Sendable (Bool, Error?) -> Void) {
        context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason, reply: reply)
    }

    public func evaluatePassword(reason: String, reply: @escaping @Sendable (Bool, Error?) -> Void) {
        LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason, reply: reply)
    }
}

/// Apple's Touch ID glyph, paired with the verifier's context. It starts the evaluation once it is in a window, and
/// tells the verifier when that window takes the keyboard.
struct ApprovalTouchIDGlyph: NSViewRepresentable {
    @ObservedObject var verifier: ApprovalVerifier

    func makeNSView(context: Context) -> ApprovalTouchIDHostView {
        let view = ApprovalTouchIDHostView()
        view.verifier = verifier
        view.pair(with: verifier.context)
        return view
    }

    func updateNSView(_ view: ApprovalTouchIDHostView, context: Context) {
        view.verifier = verifier
        view.pair(with: verifier.context)
    }
}

/// Holds the `LAAuthenticationView` for the current context. A new context (a retry) gets a new glyph view, because
/// the glyph is bound to its context for life.
///
/// The glyph draws at its control size whatever frame it gets (measured 2026-10-30: `.mini` 16 pt, `.small` 32,
/// `.regular` 64, `.large` 128), so the host pins it to that size and reports it: the `.regular` glyph in a 32 pt
/// frame spilled over the window's edge and under the buttons.
final class ApprovalTouchIDHostView: NSView {
    /// The glyph of a footer line: 32 pt, as the lock and checkmark it alternates with.
    static let controlSize = NSControl.ControlSize.small
    static let fallbackSize = NSSize(width: 32, height: 32)

    weak var verifier: ApprovalVerifier?
    private var glyph: LAAuthenticationView?
    private var keyObserver: NSObjectProtocol?

    override var intrinsicContentSize: NSSize { glyph?.fittingSize ?? Self.fallbackSize }

    func pair(with context: LAContext?) {
        guard glyph?.context !== context else { return }
        glyph?.removeFromSuperview()
        glyph = nil
        guard let context else { return }
        let view = LAAuthenticationView(context: context, controlSize: Self.controlSize)
        view.translatesAutoresizingMaskIntoConstraints = false
        addSubview(view)
        let size = view.fittingSize
        NSLayoutConstraint.activate([
            view.centerXAnchor.constraint(equalTo: centerXAnchor),
            view.centerYAnchor.constraint(equalTo: centerYAnchor),
            view.widthAnchor.constraint(equalToConstant: size.width),
            view.heightAnchor.constraint(equalToConstant: size.height),
        ])
        glyph = view
        invalidateIntrinsicContentSize()
        evaluateWhenShown()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if let keyObserver { NotificationCenter.default.removeObserver(keyObserver) }
        keyObserver = nil
        guard let window else { return }
        keyObserver = NotificationCenter.default.addObserver(forName: NSWindow.didBecomeKeyNotification, object: window, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.verifier?.windowBecameKey() }
        }
        // The first frame: the panel is being ordered in during this run-loop turn; listen once it is on screen.
        DispatchQueue.main.async { [weak self] in
            guard let self, let window = self.window else { return }
            self.verifier?.begin(windowIsKey: window.isKeyWindow)
        }
    }

    /// The evaluation runs only once the glyph is paired and in a window, so the sensor answers through it and not
    /// through the system's own Touch ID alert.
    private func evaluateWhenShown() {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.window != nil, let context = self.glyph?.context else { return }
            self.verifier?.evaluate(context)
        }
    }

    deinit {
        if let keyObserver { NotificationCenter.default.removeObserver(keyObserver) }
    }
}
