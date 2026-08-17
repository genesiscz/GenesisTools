/**
 * In-page payloads for `play run` — JavaScript source strings evaluated inside an
 * open.spotify.com tab via chrome-devtools-mcp's `evaluate_script`.
 *
 * The whole approach: pull the web player's OWN internal player (`playerAPI`) off the
 * React fiber tree once, cache it on `window.__playerAPI`, then drive playback through
 * `play()` / `seekTo()` / `skipToNext()` — no DOM clicking, no virtual-list scrolling,
 * and the track does not have to be in Liked Songs. Ported from the mcp-scripting
 * `spotifyPreview` script, where this survived multi-hundred-track runs.
 *
 * These are strings, not functions: they execute in the page, so nothing here may
 * reference module scope, and TypeScript-only syntax would be a syntax error there.
 */
import type { PlayWindow } from "@app/spotify/lib/play/plan";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.child({ component: "spotify:play" });

export const FIND_PLAYER = `() => {
  if (window.__playerAPI?.play) return { ok: true, cached: true };
  const hook = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  if (!hook) return { ok: false, error: 'no react devtools hook' };
  const roots = [];
  for (const [id] of (hook.renderers || new Map())) {
    const set = hook.getFiberRoots ? hook.getFiberRoots(id) : null;
    if (set) for (const r of set) roots.push(r);
  }
  let api = null;
  const seen = new Set();
  // Depth is spent on CHILDREN only, and siblings are walked in a loop rather than by
  // recursing. In a fiber tree the sibling chain is a flat rendered list, so on Liked Songs
  // — the very page this runs against — 3000+ rows used to exhaust the budget and report
  // 'playerAPI not found' while the node sat one level down. The loop also keeps a long list
  // off the call stack.
  const visit = (start, depth) => {
    for (let node = start; node && !api; node = node.sibling) {
      if (depth > 3000) return;
      for (const bag of [node.memoizedProps, node.memoizedState?.memoizedState]) {
        if (bag && typeof bag === 'object' && !seen.has(bag)) {
          seen.add(bag);
          try {
            for (const [k, v] of Object.entries(bag)) {
              if (k === 'playerAPI' && v && typeof v.play === 'function' && typeof v.seekTo === 'function') { api = v; return; }
            }
          } catch {}
        }
      }
      visit(node.child, depth + 1);
    }
  };
  for (const r of roots) visit(r.current, 0);
  if (!api) return { ok: false, error: 'playerAPI not found in fiber tree' };
  window.__playerAPI = api;
  return { ok: true, cached: false };
}`;

/** Shared in-page helpers, inlined into every evaluated function. */
const HELPERS = `
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const pos = () => document.querySelector('[data-testid="playback-position"]')?.innerText || '?';
  const np = () => {
    const w = document.querySelector('[data-testid="now-playing-widget"]');
    return w ? w.innerText.split('\\n').filter(Boolean).slice(0, 2).join(' — ') : '?';
  };
  const secs = () => { const m = /^(\\d+):(\\d\\d)$/.exec(pos()); return m ? +m[1]*60 + +m[2] : -1; };
`;

/**
 * Load the whole run into the player queue in one go, starting at `startAt`.
 * A context with `pages[].items` is what the web player itself builds, so
 * Spotify's own next/previous buttons and the queue view work normally —
 * calling play({uri}) per track would replace the context each time and make
 * "previous" impossible.
 */
export const LOAD_QUEUE = (uris: string[], startAt: number) => `async () => {
  const api = window.__playerAPI;
  if (!api) return { ok: false, error: 'playerAPI missing' };
  ${HELPERS}
  const uris = ${SafeJSON.stringify(uris)};
  try {
    await api.play(
      { pages: [{ items: uris.map(u => ({ uri: u })) }] },
      { skipTo: { pageIndex: 0, trackIndex: ${startAt} } },
      {}
    );
  } catch (e) { return { ok: false, error: 'queue play() threw: ' + String(e) }; }

  for (let i = 0; i < 30; i++) { await sleep(300); if (secs() >= 0) break; }
  return { ok: true, queued: uris.length, track: np() };
}`;

/** Sample one track across every configured window. Assumes it is already current. */
export const SAMPLE = (windows: PlayWindow[]) => `async () => {
  const api = window.__playerAPI;
  if (!api) return { ok: false, error: 'playerAPI missing' };
  ${HELPERS}
  const windows = ${SafeJSON.stringify(windows)};

  for (let i = 0; i < 30; i++) { await sleep(300); if (secs() >= 0) break; }
  if (secs() < 0) return { ok: false, error: 'playback never started' };

  const track = np();
  const heard = [];
  let missed = 0;

  for (const [start, dur] of windows) {
    let from = '?', to = '?', landed = false, stalled = false;

    // one retry: a window can land correctly yet play nothing if the stream
    // stalls (buffering), which shows up as the clock not advancing at all.
    for (let attempt = 0; attempt < 2; attempt++) {
      try { await api.seekTo(start * 1000); }
      catch (e) { return { ok: false, error: 'seekTo threw: ' + String(e), track }; }
      await sleep(700);

      from = pos();
      landed = secs() >= start - 1 && secs() <= start + 5;
      const before = secs();

      await sleep(dur * 1000);
      to = pos();
      stalled = secs() === before;

      if (!stalled) break;
      try { await api.resume(); } catch {}
      await sleep(600);
    }

    if (!landed) missed++;
    heard.push(from + '→' + to + (landed ? '' : '!') + (stalled ? ' STALL' : ''));
  }

  return { ok: true, track, heard, missed };
}`;

/** Standalone (no-queue) playback of a single track. */
export const PLAY_ONE = (uri: string) => `async () => {
  const api = window.__playerAPI;
  if (!api) return { ok: false, error: 'playerAPI missing' };
  ${HELPERS}
  try { await api.play({ uri: ${SafeJSON.stringify(uri)} }, {}); }
  catch (e) { return { ok: false, error: 'play() threw: ' + String(e) }; }
  for (let i = 0; i < 25; i++) { await sleep(300); if (secs() >= 0) return { ok: true }; }
  return { ok: false, error: 'playback never started' };
}`;

/**
 * Set the player's volume before anything plays, and report what it was.
 *
 * This exists because previewing is something people do while doing something else — the
 * first real request for this run was "make the audio 1% volume, I am watching a video in
 * another tab". Without it the only options are letting it blast or not running at all.
 *
 * Verified against the live player, because the first version of this was WRONG in the worst
 * way: it reported success at 1% while the player stayed at 100%.
 */
export const SET_VOLUME = (fraction: number) => `async () => {
  const want = ${SafeJSON.stringify(fraction)};

  // The volume is NOT on playerAPI. \`playerAPI.setVolume(0.01)\` exists, returns without
  // throwing, and changes nothing — measured on a live player that stayed at 100% while the
  // tool reported 1%. Nothing in the fiber tree exposes a setVolume either. The real control
  // is the rendered slider, which React owns, so its value has to be written through the
  // native setter and announced with input+change or React overwrites it on the next render.
  const input = document.querySelector('[data-testid="volume-bar"] input[type=range]');
  if (!input) return { ok: false, error: 'no volume slider on this page' };

  const before = Number(input.value);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  setter.call(input, String(want));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await new Promise(r => setTimeout(r, 400));

  const after = Number(input.value);

  // The slider snaps to its step (0.1 on the current build), so an exact match is the wrong
  // test: 0.01 legitimately lands on 0 or 0.1. What must be true is that it MOVED toward the
  // target — and the actual value is reported, never the requested one, because reporting a
  // volume that was not applied is how this shipped wrong the first time.
  const moved = Math.abs(after - want) <= Number(input.step || 0.1) + 1e-9;
  if (!moved && Math.sign(after - before) !== Math.sign(want - before)) {
    return { ok: false, error: 'the volume slider did not move', before, after };
  }

  return { ok: true, how: 'volume slider', before, after, step: input.step };
}`;

export const SKIP_NEXT = `async () => {
  const api = window.__playerAPI;
  if (!api) return { ok: false, error: 'playerAPI missing' };
  ${HELPERS}
  try { await api.skipToNext(); } catch (e) { return { ok: false, error: 'skipToNext threw: ' + String(e) }; }
  await sleep(1200);
  return { ok: true, track: np() };
}`;

/**
 * chrome-devtools-mcp wraps `evaluate_script` return values in a \`\`\`json fence;
 * dig the object out, or null when the reply was not parseable at all.
 */
export function parsePayloadResult<R>(raw: string): R | null {
    const fenced = raw.match(/```json\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf("{"));

    try {
        return SafeJSON.parse(candidate.trim(), { strict: true }) as R;
    } catch (error) {
        log.debug({ error, raw: raw.slice(0, 300) }, "unparsable evaluate_script result");

        return null;
    }
}
