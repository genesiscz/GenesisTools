# Bundled notification sounds — provenance

All files in this directory are **CC0 1.0 / public domain**. They are a curated
subset of the **Kenney "Interface Sounds"** pack, converted from the original
`.ogg` to 16-bit WAV with `ffmpeg` (no other modification). Kenney releases all
assets under CC0, so they are safe to ship in an MIT/OSS product with **no
attribution required** and zero CC-BY / unknown-license risk.

- **Source:** Kenney — Interface Sounds — https://kenney.nl/assets/interface-sounds
- **License:** CC0 1.0 Universal (Public Domain Dedication)
- **Retrieved:** 2026-05-18
- **Selection:** auditioned by the maintainer; 12 of the pack's interface sounds kept.

| File | Original (Kenney) | Character | License |
|------|-------------------|-----------|---------|
| `switch.wav` (default) | `switch_002.ogg` | mechanical switch | CC0 1.0 |
| `confirm.wav` | `confirmation_001.ogg` | positive two-tone | CC0 1.0 |
| `confirm-soft.wav` | `confirmation_003.ogg` | soft rising confirm | CC0 1.0 |
| `glass.wav` | `glass_001.ogg` | bright glassy ding | CC0 1.0 |
| `glass-chime.wav` | `glass_006.ogg` | layered glass chime | CC0 1.0 |
| `pluck.wav` | `pluck_001.ogg` | string pluck | CC0 1.0 |
| `question.wav` | `question_001.ogg` | rising prompt | CC0 1.0 |
| `select.wav` | `select_001.ogg` | clean select blip | CC0 1.0 |
| `open.wav` | `open_001.ogg` | whoosh up / open | CC0 1.0 |
| `close.wav` | `close_001.ogg` | whoosh down / close | CC0 1.0 |
| `error.wav` | `error_002.ogg` | alert / error buzz | CC0 1.0 |
| `drop.wav` | `drop_001.ogg` | descending plop | CC0 1.0 |

Keep this table in sync with `manifest.ts` (`BUNDLED_SOUNDS`). To add more,
download the pack, convert, and append here + in the manifest:

```bash
curl -sL "https://kenney.nl/media/pages/assets/interface-sounds/fa43c1dd4d-1677589452/kenney_interface-sounds.zip" -o /tmp/k.zip
unzip -oq /tmp/k.zip -d /tmp/k
ffmpeg -y -i /tmp/k/Audio/<name>.ogg src/utils/audio/assets/<semantic>.wav
```
