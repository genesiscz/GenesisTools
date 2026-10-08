# GenesisTools widget preview

The installer builds the GenesisTools app in preview mode, renames its executable to GenesisWidgetPreview, and uses a separate preferences domain and widget state directory. The views and panel geometry live in GenesisKit. This installed preview uses the repository CLI and can read live sessions and deliver messages through configured routes.

The GenesisWidgetPreview Swift package supplies a separate sample studio. Run that studio without installing the app:

```sh
swift run --package-path src/macos/GenesisWidgetPreview GenesisWidgetPreview --samples
```

The sample interactions and implementation scope below describe that studio.

Build and install from the repository root:

```sh
bun scripts/build-widget-preview.ts
open -a "$HOME/Applications/GenesisTools Preview.app"
```

Requires macOS 14+, the Swift toolchain, Bun, and a Developer ID Application signing identity.
Quit the running Preview before rebuilding. The builder preserves replaced Preview bundles under the widget-preview data directory and does not terminate running applications.

The app uses bundle ID `com.genesiscz.genesistools.widget-preview`, executable `GenesisWidgetPreview`, and its own preferences domain.
It registers no URL schemes or document handlers. Its preferences and widget state are isolated from the production app; its live CLI reads and delivery routes are available.
Do not use the normal app builder for this preview: that builder replaces the production app and reaps its faces.

## Try it

1. Select Top, Side, or Both in the settings window.
2. Open a card or click a compact agent dot.
3. Press a number-row key to choose an answer, or J/K to switch agents.
4. Focus the composer to type ordinary text; number keys then remain text.
5. Click the send arrow to save a sample reply.
6. Press Escape or click outside to collapse. Reopen to recover the draft.
7. Use the settings icon to change placement or test Reduce motion and Opaque surfaces independently.

Only one card owns input at a time, while both placements share selection, draft, and sample receipts.
The receipt explicitly says “Preview answer saved”; it is not live delivery.

## Verification

```sh
swift test --package-path src/macos/GenesisKit --disable-build-manifest-caching --filter 'EdgePanelGeometryTests|AgentWidgetKeyboardTests'
```

The six focused tests cover anchored frames, negative-origin displays, small display bounds, motion endpoints, and number-row shortcuts on nonnumeric keyboard layouts.
The build disables SwiftPM build-manifest caching so newly added local GenesisKit sources are included.

Native acceptance was exercised through computer use on 2026-10-08:
placement selectors, draft retention, click/number choice, typed submission, settings focus, Escape/reopen, and accessibility toggles.
A rapid open/Escape sequence settled correctly, but a frame-by-frame interruption capture is still pending.

## Scope still to implement

Live Decisions/MCP/history adapters, Hub navigation, transcript continuation, durable outbox and delivery receipts, image/video attachment review, project/session filters, pinning, voice, display selection/removal handling, automatic quiet reduction, and the full decorative bubble/Liquid Glass treatment.
The first preview uses the selected main display, a right-side rail, and a matte surface.
