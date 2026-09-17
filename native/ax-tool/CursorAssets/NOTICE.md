# Cua cursor artwork

The original `cua.default.lottie`, bundled Inter typeface and their licenses come from
[trycua/cua](https://github.com/trycua/cua/tree/9e60d90b8681d3ba7ccf2c7801dbaa21b0d6efbb/libs/cua-driver/rust/crates/cursor-overlay/assets),
revision `9e60d90b8681d3ba7ccf2c7801dbaa21b0d6efbb`.

Cursor theme: Cua Default 2.0.0, profile cua-driver-actions-v2, MIT, copyright Cua AI, Inc. 2026.
See LICENSE-Cua.txt. Inter: SIL Open Font License, see Inter-OFL.txt.

`compile_theme.py` is original GenesisTools conversion code. It samples the upstream
vector transforms at 30 fps into `SnapshotSupport/Resources/CuaCursor.json`.
Run `python3 native/ax-tool/CursorAssets/compile_theme.py` to regenerate offline.
Runtime uses Core Animation vector layers; no Lottie engine, model, network download
or per-frame JavaScript/Swift timer is needed.

The native movement and badge implementation is original GenesisTools code informed by
Cua's documented 42-point footprint, cyan palette, outline/glow, four-second levitation,
900-point-per-second motion and 20-second hide interval. Attribution is not endorsement.
