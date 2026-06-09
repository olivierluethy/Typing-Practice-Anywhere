/* Typing Practice — content script
 *
 * State machine:
 *   IDLE     → off. nothing on screen.
 *   LAUNCH   → mode launcher modal is open, waiting for the user to pick a mode.
 *   ARMED    → mode selected, waiting for the user to click a text block.
 *   TYPING   → block chosen, characters split into spans; key events captured.
 *   RESULTS  → end-of-run modal shown; Restart / Next / Done options.
 *
 * Lifecycle:
 *   activate() goes IDLE → LAUNCH (shows mode picker).
 *   selectMode() goes LAUNCH → ARMED (installs click + hover listeners, the
 *                "selection mode" banner, tooltip + HUD).
 *   onTextClick() goes ARMED → TYPING (splits target into spans, places caret).
 *   showResults() goes TYPING → RESULTS.
 *   deactivate() / ESC goes any → IDLE (restores original DOM).
 *
 * Accuracy / error / WPM model (correction-aware):
 *   - HUD "Errors"  = word-level. Each word (a maximal non-whitespace run of
 *                     expected chars) is at most ONE error, regardless of how
 *                     many chars in it are wrong or skipped. A typo near the
 *                     start of a word doesn't cascade into 5+ errors just
 *                     because the cursor advanced past 5 wrong chars.
 *                     Implemented via `dirtyWords: Set<"blockId:wordIndex">`.
 *                     If the user Backspaces over a wrong char and re-types
 *                     it correctly, the word leaves dirtyWords — the headline
 *                     error count goes back down.
 *   - Accuracy %    = character-level: correctCount / keystrokes * 100.
 *                     All Backspaces are full reversals: backspacing over a
 *                     wrong char rolls back both `keystrokes` and dirtyWords;
 *                     backspacing over a correct char rolls back both
 *                     `keystrokes` and `correctCount`. The only attempt that
 *                     stays sticky in the denominator is a wrong char the
 *                     user moves past without ever Backspacing. This means
 *                     a cascade-fix sequence (Backspace past good chars to
 *                     reach an earlier typo, then re-type the run) lands at
 *                     a clean 100%, instead of penalizing the user for the
 *                     correct-char reversals in between. Tab skips don't
 *                     touch keystrokes either.
 *   - WPM (live)    = rolling window of correct-char timestamps from the
 *                     last 10 seconds. Drives the speedometer.
 *   - Results modal shows a word-level breakdown (correct/wrong/skipped/
 *     incomplete) alongside the WPM and accuracy headlines.
 */

(() => {
  if (window.__typingPracticeInstalled) return;
  window.__typingPracticeInstalled = true;

  // Platform detection. Drives the on-screen keyboard's bottom-row modifiers
  // (Ctrl/Opt/Cmd on Mac vs. Ctrl/Win/Alt elsewhere) and the launcher's
  // documented Restart shortcut (⌘R vs. Ctrl+R). navigator.platform is
  // deprecated but still the most reliable Mac signal in extension contexts;
  // the userAgent fallback covers cases where platform is empty.
  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ||
                 /Mac/.test(navigator.userAgent);

  // ---------- state ----------
  const state = {
    mode: "IDLE", // "IDLE" | "LAUNCH" | "ARMED" | "TYPING" | "RESULTS"
    selectedMode: { kind: "free", value: null }, // chosen practice mode
    selectGranularity: "paragraph", // "paragraph" | "sentence" — what a click selects while ARMED
    target: null, // the chosen block element
    originalHTML: null, // saved innerHTML of the target so we can restore
    chars: [], // [{span, ch, status, wordIndex}]  status: "pending" | "correct" | "wrong" | "skipped"
    wordCharIndices: [], // wordIndex → array of char indices belonging to the CURRENT block
    blockId: 0, // monotonically bumped on each installBlock so dirtyWords entries don't collide across blocks
    cursor: 0, // index of next char to type
    startedAt: 0, // ms timestamp of the first keystroke (any key) in TYPING
    correctCount: 0,
    keystrokes: 0, // total non-control key attempts (printable + Enter). Backspace and Tab do NOT count.
    dirtyWords: new Set(), // "blockId:wordIndex" of every word with ≥1 wrong/skipped char — HUD shows .size
    // Word-level classification accumulated across blocks that have been
    // fully typed and left behind via advanceToNextBlock. The final
    // (still-active) block is classified separately at finishRun time and
    // summed in for the results modal.
    finishedWordStats: { correct: 0, wrong: 0, skipped: 0 },
    elapsedMs: 0,
    hudTimer: 0,
    // Rolling-window samples for the live speedometer. Each entry is the
    // performance.now() timestamp of one correct keystroke. Pruned to a 10s
    // window on every HUD tick. Live WPM = (length/5) / (windowSeconds/60).
    recentCorrectChars: [],
    // svg-gauge instance for the speedometer. (Re-)created in
    // refreshHUDLayout via initSpeedometer; nulled on deactivate. The
    // library has no explicit destroy method — its SVG is removed when its
    // parent container is removed/replaced.
    gauge: null,
    theme: "light", // "light" | "dark" — set by detectPageTheme() on activate
  };

  // ---------- elements we manage ----------
  let caretEl = null;
  let hudEl = null;
  let tooltipEl = null;
  let selectBannerEl = null;
  let launcherEl = null;
  let resultsEl = null;
  let keyboardEl = null;
  // Currently next-key-hinted elements. Cleared/re-set after each caret advance.
  let nextHintedEls = [];
  // The block currently glowing under the pointer while ARMED — i.e. the
  // paragraph the next click would select. Tracked so we can move the
  // highlight as the mouse moves and clear it on choose/deactivate.
  let hoverBlockEl = null;
  // Overlay layer that paints the orange highlight over the sentence under the
  // pointer in sentence-granularity mode. We draw absolutely-positioned boxes
  // matching the sentence Range's client rects instead of mutating page DOM on
  // every mousemove. Created lazily, torn down on choose/deactivate.
  let sentenceOverlayEl = null;
  // The sentence currently drawn in the overlay, keyed by its block + text
  // span. Lets onArmedMove skip a redraw while the pointer stays inside the
  // same sentence — otherwise we'd recreate the boxes (and restart their pulse
  // animation) on every mouse move.
  let lastSentenceBlock = null;
  let lastSentenceStart = -1;
  let lastSentenceEnd = -1;

  // Re-entry guards for the smooth-scroll path. The browser's smooth
  // scrollTo dispatches `scroll` events as it animates, and our scroll
  // handler calls positionCaret again. Without these guards, the
  // initial-position auto-scroll (when the caret happens to be near a
  // viewport edge on entry) recurses until the stack blows.
  let isAutoScrolling = false;
  let autoScrollTimer = 0;
  let scrollRaf = 0;

  // ---------- theme detection ----------
  // Tracking for the live re-detect path. The observer is wired up only while
  // the extension is active so we don't burn cycles on every other tab.
  let themeObserver = null;
  let themeMediaQuery = null;
  let themeMediaListener = null;
  let themeRedetectTimer = 0;

  // Parse any CSS color string into {r,g,b,a}. Uses an offscreen DIV +
  // getComputedStyle so the browser does the parsing for us; cheaper than a
  // hand-rolled parser and handles named colors, hex, rgb(), hsl(), etc.
  // Returns null if the color is fully transparent (we treat those as "no
  // signal" and look elsewhere).
  function parseColor(str) {
    if (!str) return null;
    const probe = document.createElement("div");
    probe.style.color = str;
    probe.style.display = "none";
    document.body.appendChild(probe);
    const computed = getComputedStyle(probe).color;
    probe.remove();
    // computed is "rgb(r, g, b)" or "rgba(r, g, b, a)"
    const m = computed.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
    if (!m) return null;
    const a = m[4] != null ? parseFloat(m[4]) : 1;
    if (a === 0) return null;
    return { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]), a };
  }

  // Relative luminance on the standard 0–255 scale (no gamma correction; this
  // is "good enough" for a coarse dark-vs-light decision).
  function luminance(c) {
    return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  }

  // Detect whether the current page is dark or light. Multi-signal vote:
  //   1. <body> background luminance < 110            (dark bg)
  //   2. <body> foreground color luminance > 145      (light text on dark)
  //   3. prefers-color-scheme: dark                   (OS / user preference)
  //   4. dark-themed class/attribute on <html>/<body> (site-applied theme)
  // ≥ 2 votes → "dark". Otherwise "light".
  function detectPageTheme() {
    let votes = 0;

    // Background. Fall back to <html> if body's bg is transparent.
    const bodyBgStr = getComputedStyle(document.body).backgroundColor;
    let bg = parseColor(bodyBgStr);
    if (!bg) {
      const htmlBgStr = getComputedStyle(document.documentElement).backgroundColor;
      bg = parseColor(htmlBgStr);
    }
    if (bg && luminance(bg) < 110) votes += 1;

    // Foreground.
    const fgStr = getComputedStyle(document.body).color;
    const fg = parseColor(fgStr);
    if (fg && luminance(fg) > 145) votes += 1;

    // OS / user preference.
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      votes += 1;
    }

    // Site-applied theme markers on <html> or <body>.
    if (hasDarkMarker(document.documentElement) || hasDarkMarker(document.body)) {
      votes += 1;
    }

    return votes >= 2 ? "dark" : "light";
  }

  // Looks for common dark-mode signals on a single element: class names
  // containing "dark"/"night"/"theme-dark", or data-/attribute values
  // explicitly set to "dark".
  function hasDarkMarker(el) {
    if (!el || el.nodeType !== 1) return false;
    const cls = (el.className && typeof el.className === "string") ? el.className.toLowerCase() : "";
    if (cls && /(^|\s)(dark|night|theme-dark|dark-mode|dark-theme)(\s|$|-)/.test(cls)) return true;
    const attrs = ["data-theme", "data-color-mode", "data-bs-theme", "color-scheme", "data-mode"];
    for (const a of attrs) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v && v.toLowerCase() === "dark") return true;
    }
    return false;
  }

  function applyTheme(theme) {
    state.theme = theme;
    const html = document.documentElement;
    html.classList.remove("tp-theme-light", "tp-theme-dark");
    html.classList.add(theme === "dark" ? "tp-theme-dark" : "tp-theme-light");
  }

  // Some sites toggle dark mode without reload (GitHub, modern Wikipedia).
  // Watch <html> + <body> class/attribute changes plus the OS media query, and
  // re-detect on a 250ms debounce. Only active between activate/deactivate.
  function installThemeWatcher() {
    // Re-run detection with a small debounce so a burst of attribute changes
    // (some frameworks flip multiple at once) coalesces into one update.
    const schedule = () => {
      if (themeRedetectTimer) return;
      themeRedetectTimer = window.setTimeout(() => {
        themeRedetectTimer = 0;
        const next = detectPageTheme();
        if (next !== state.theme) applyTheme(next);
      }, 250);
    };
    themeObserver = new MutationObserver(schedule);
    const opts = { attributes: true, attributeFilter: ["class", "data-theme", "data-color-mode", "data-bs-theme", "color-scheme", "data-mode"] };
    themeObserver.observe(document.documentElement, opts);
    if (document.body) themeObserver.observe(document.body, opts);
    if (window.matchMedia) {
      themeMediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      themeMediaListener = schedule;
      // addEventListener is the modern API; addListener for old Safari.
      if (themeMediaQuery.addEventListener) themeMediaQuery.addEventListener("change", themeMediaListener);
      else if (themeMediaQuery.addListener) themeMediaQuery.addListener(themeMediaListener);
    }
  }

  function removeThemeWatcher() {
    if (themeRedetectTimer) { window.clearTimeout(themeRedetectTimer); themeRedetectTimer = 0; }
    if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
    if (themeMediaQuery && themeMediaListener) {
      if (themeMediaQuery.removeEventListener) themeMediaQuery.removeEventListener("change", themeMediaListener);
      else if (themeMediaQuery.removeListener) themeMediaQuery.removeListener(themeMediaListener);
    }
    themeMediaQuery = null;
    themeMediaListener = null;
  }

  // ---------- message handler from background ----------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "TP_TOGGLE") {
      // T while LAUNCH/ARMED/TYPING/RESULTS toggles off (matches the prior toggle behavior).
      if (state.mode === "IDLE") activate();
      else deactivate();
    }
  });

  // ---------- activation ----------
  function activate() {
    state.mode = "LAUNCH";
    applyTheme(detectPageTheme());
    installThemeWatcher();
    document.documentElement.classList.add("tp-active");
    document.addEventListener("keydown", onGlobalKey, true);
    showLauncher();
  }

  function deactivate() {
    document.removeEventListener("click", onArmedClick, true);
    document.removeEventListener("click", onTypingClick, true);
    document.removeEventListener("keydown", onGlobalKey, true);
    document.removeEventListener("keydown", onTypingKey, true);
    document.removeEventListener("mousemove", onArmedMove, true);
    window.removeEventListener("scroll", onScrollOrResize);
    window.removeEventListener("resize", onScrollOrResize);
    stopHUDLoop();
    clearAllHover();
    restoreTarget();
    removeCaret();
    removeKeyboard();
    removeHUD();
    removeTooltip();
    removeSelectBanner();
    removeLauncher();
    removeResults();
    removeThemeWatcher();
    document.documentElement.classList.remove("tp-active", "tp-armed", "tp-theme-light", "tp-theme-dark");
    Object.assign(state, {
      mode: "IDLE",
      selectedMode: { kind: "free", value: null },
      selectGranularity: "paragraph",
      target: null,
      originalHTML: null,
      chars: [],
      wordCharIndices: [],
      blockId: 0,
      cursor: 0,
      startedAt: 0,
      correctCount: 0,
      keystrokes: 0,
      dirtyWords: new Set(),
      finishedWordStats: { correct: 0, wrong: 0, skipped: 0 },
      elapsedMs: 0,
      theme: "light",
    });
    state.recentCorrectChars = [];
  }

  // ---------- mode launcher (LAUNCH phase) ----------
  function showLauncher() {
    if (launcherEl) return;
    launcherEl = document.createElement("div");
    launcherEl.id = "tp-launcher";
    launcherEl.className = "tp-backdrop";
    launcherEl.innerHTML = `
      <div class="tp-card" role="dialog" aria-label="Choose a practice mode">
        <button class="tp-card-close" type="button" aria-label="Close">&times;</button>
        <h2 class="tp-card-title">Choose a practice mode</h2>
        <div class="tp-row">
          <div class="tp-row-label">Free</div>
          <div class="tp-row-buttons">
            <button type="button" class="tp-btn tp-btn-primary" data-kind="free">Open-ended</button>
          </div>
        </div>
        <div class="tp-row">
          <div class="tp-row-label">Timed</div>
          <div class="tp-row-buttons">
            <button type="button" class="tp-btn" data-kind="timed" data-value="15">15s</button>
            <button type="button" class="tp-btn" data-kind="timed" data-value="30">30s</button>
            <button type="button" class="tp-btn" data-kind="timed" data-value="60">60s</button>
          </div>
        </div>
        <div class="tp-shortcuts">
          <div class="tp-shortcuts-title">Shortcuts</div>
          <div class="tp-shortcut"><kbd class="tp-kbd">Tab</kbd><span>Skip current word</span></div>
          <div class="tp-shortcut">${IS_MAC
            ? `<kbd class="tp-kbd">⌘</kbd> <kbd class="tp-kbd">R</kbd>`
            : `<kbd class="tp-kbd">Ctrl</kbd> + <kbd class="tp-kbd">R</kbd>`
          }<span>Restart run</span></div>
          <div class="tp-shortcut"><kbd class="tp-kbd">Esc</kbd><span>Exit</span></div>
        </div>
      </div>
    `;
    document.body.appendChild(launcherEl);

    launcherEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) {
        // Click on backdrop closes (same as Esc).
        if (e.target === launcherEl) deactivate();
        return;
      }
      if (btn.classList.contains("tp-card-close")) {
        deactivate();
        return;
      }
      const kind = btn.dataset.kind;
      if (!kind) return;
      const value = btn.dataset.value ? Number(btn.dataset.value) : null;
      selectMode({ kind, value });
    });
  }

  function removeLauncher() {
    if (launcherEl) launcherEl.remove();
    launcherEl = null;
  }

  function selectMode(modeObj) {
    state.selectedMode = modeObj;
    removeLauncher();
    enterArmed();
  }

  function enterArmed() {
    state.mode = "ARMED";
    document.documentElement.classList.add("tp-armed");
    installHUD();
    installTooltip();
    installSelectBanner();
    document.addEventListener("click", onArmedClick, true);
    document.addEventListener("mousemove", onArmedMove, true);
  }

  // ---------- target selection (ARMED phase) ----------
  function onArmedClick(e) {
    // Ignore clicks on our own UI.
    if (e.target.closest && e.target.closest("#tp-hud, #tp-tooltip, #tp-select-banner, .tp-backdrop")) return;
    if (state.mode !== "ARMED") return;

    const block = findTextBlock(e.target);
    if (!block) return;

    e.preventDefault();
    e.stopPropagation();

    chooseTarget(block, e.clientX, e.clientY);
  }

  // While ARMED, glow what a click will select so the user can see exactly what
  // they're about to type. In "paragraph" granularity that's the whole block;
  // in "sentence" granularity it's just the sentence under the pointer. This is
  // the core "you're in selection mode and the extension is tracking you"
  // feedback.
  function onArmedMove(e) {
    if (state.mode !== "ARMED") return;
    // Don't highlight anything behind our own UI.
    if (e.target.closest && e.target.closest("#tp-hud, #tp-tooltip, #tp-select-banner, .tp-backdrop")) {
      clearAllHover();
      return;
    }
    const block = findTextBlock(e.target);

    if (state.selectGranularity === "sentence") {
      clearHoverBlock(); // never show the block outline in sentence mode
      const hit = block ? sentenceRangeAtPoint(block, e.clientX, e.clientY) : null;
      if (!hit) { clearSentenceOverlay(); return; }
      // Same sentence as last move? Leave the overlay (and its pulse) alone.
      if (sentenceOverlayEl && block === lastSentenceBlock &&
          hit.start === lastSentenceStart && hit.end === lastSentenceEnd) {
        return;
      }
      lastSentenceBlock = block;
      lastSentenceStart = hit.start;
      lastSentenceEnd = hit.end;
      drawSentenceOverlay(hit.range);
      return;
    }

    // Paragraph granularity.
    clearSentenceOverlay();
    if (block === hoverBlockEl) return; // nothing changed — cheap early out
    clearHoverBlock();
    if (block) {
      hoverBlockEl = block;
      hoverBlockEl.classList.add("tp-hover-block");
    }
  }

  function clearHoverBlock() {
    if (hoverBlockEl) {
      hoverBlockEl.classList.remove("tp-hover-block");
      hoverBlockEl = null;
    }
  }

  // Tear down every kind of hover feedback (block outline + sentence overlay).
  function clearAllHover() {
    clearHoverBlock();
    clearSentenceOverlay();
  }

  // ---------- sentence highlighting (sentence granularity) ----------
  // Paint the orange highlight over a sentence Range without touching page DOM:
  // one absolutely-positioned box per client rect (a multi-line sentence yields
  // several). Boxes live in #tp-sentence-overlay, which is pointer-events:none
  // so it never intercepts clicks or hit-testing.
  function drawSentenceOverlay(range) {
    if (!sentenceOverlayEl) {
      sentenceOverlayEl = document.createElement("div");
      sentenceOverlayEl.id = "tp-sentence-overlay";
      document.body.appendChild(sentenceOverlayEl);
    }
    const rects = range.getClientRects();
    sentenceOverlayEl.textContent = "";
    for (const r of rects) {
      if (r.width < 1 || r.height < 1) continue;
      const box = document.createElement("div");
      box.className = "tp-sentence-box";
      box.style.left = r.left + "px";
      box.style.top = r.top + "px";
      box.style.width = r.width + "px";
      box.style.height = r.height + "px";
      sentenceOverlayEl.appendChild(box);
    }
  }

  function clearSentenceOverlay() {
    if (sentenceOverlayEl) {
      sentenceOverlayEl.remove();
      sentenceOverlayEl = null;
    }
    lastSentenceBlock = null;
    lastSentenceStart = -1;
    lastSentenceEnd = -1;
  }

  // Cross-browser caret hit-test → { node, offset } at viewport point (x, y).
  function caretPositionFromPoint(x, y) {
    if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(x, y);
      return p ? { node: p.offsetNode, offset: p.offset } : null;
    }
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(x, y);
      return r ? { node: r.startContainer, offset: r.startOffset } : null;
    }
    return null;
  }

  // Flatten a block's text nodes into one string plus a per-node offset map, so
  // we can do sentence-boundary math on plain text and then map back to DOM
  // (node, offset) pairs to build a Range.
  function flattenBlockText(block) {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT, null);
    const nodes = [];
    let text = "";
    let n;
    while ((n = walker.nextNode())) {
      const v = n.nodeValue || "";
      nodes.push({ node: n, start: text.length, len: v.length });
      text += v;
    }
    return { nodes, text };
  }

  const SENTENCE_TERM = /[.!?…]/;
  // Closing punctuation that belongs to the sentence it follows (quotes,
  // brackets) — kept on the end / skipped at the start.
  const CLOSERS = /["'”’»)\]]/;

  // Index of the first char of the sentence containing global offset `idx`.
  function sentenceStart(text, idx) {
    for (let p = idx - 1; p >= 0; p--) {
      if (SENTENCE_TERM.test(text[p])) {
        let s = p + 1;
        while (s < text.length && (/\s/.test(text[s]) || CLOSERS.test(text[s]))) s++;
        return s;
      }
    }
    let s = 0;
    while (s < text.length && /\s/.test(text[s])) s++;
    return s;
  }

  // Index just past the last char of the sentence containing global offset.
  function sentenceEnd(text, idx) {
    for (let p = Math.max(0, idx); p < text.length; p++) {
      if (SENTENCE_TERM.test(text[p])) {
        let e = p + 1;
        while (e < text.length && CLOSERS.test(text[e])) e++;
        return e;
      }
    }
    let e = text.length;
    while (e > 0 && /\s/.test(text[e - 1])) e--; // trim trailing whitespace
    return e;
  }

  // Map a global text offset back to a { node, offset } inside the block.
  function mapGlobalToNode(map, g) {
    for (const e of map.nodes) {
      if (g >= e.start && g <= e.start + e.len) {
        return { node: e.node, offset: g - e.start };
      }
    }
    const last = map.nodes[map.nodes.length - 1];
    return last ? { node: last.node, offset: last.len } : null;
  }

  // Resolve the sentence under viewport point (x, y) within `block`. Returns
  // { range, start, end } where start/end are global text offsets within the
  // block (used to dedupe redraws), or null if the point isn't over typeable
  // text (caller then falls back to selecting the whole paragraph).
  function sentenceRangeAtPoint(block, x, y) {
    const pos = caretPositionFromPoint(x, y);
    if (!pos || !pos.node || pos.node.nodeType !== 3) return null;
    if (!block.contains(pos.node)) return null;
    const map = flattenBlockText(block);
    const entry = map.nodes.find((e) => e.node === pos.node);
    if (!entry) return null;
    const g = entry.start + Math.min(pos.offset, entry.len);
    const start = sentenceStart(map.text, g);
    const end = sentenceEnd(map.text, g);
    if (end <= start) return null;
    const a = mapGlobalToNode(map, start);
    const b = mapGlobalToNode(map, end);
    if (!a || !b) return null;
    const range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
    } catch (err) {
      return null;
    }
    return range.collapsed ? null : { range, start, end };
  }

  const BLOCK_TAGS = new Set([
    "P", "LI", "BLOCKQUOTE", "ARTICLE", "SECTION",
    "DIV", "TD", "DD", "H1", "H2", "H3", "H4", "H5", "H6", "FIGCAPTION",
  ]);
  // Tags whose subtree we never auto-advance into (navigation, chrome).
  const NAV_TAGS = new Set(["ASIDE", "NAV", "FOOTER", "HEADER"]);

  // Walk up from the click target until we find a block-ish element that
  // contains enough plain text to practice on.
  function findTextBlock(el) {
    let node = el;
    while (node && node !== document.body) {
      if (
        node.nodeType === 1 &&
        BLOCK_TAGS.has(node.tagName) &&
        (node.textContent || "").trim().length >= 10
      ) {
        return node;
      }
      node = node.parentNode;
    }
    return null;
  }

  // True if `el` would render visibly (rough check — used to skip
  // display:none/visibility:hidden blocks when auto-advancing).
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.offsetParent === null && el.tagName !== "BODY") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Is `el` (or any ancestor up to body) a navigation/chrome element we
  // should not auto-advance into?
  function isInNavChrome(el) {
    let p = el;
    while (p && p !== document.body) {
      if (p.nodeType === 1 && NAV_TAGS.has(p.tagName)) return true;
      p = p.parentNode;
    }
    return false;
  }

  // Does `el` qualify as a next paragraph-like block we can auto-advance to?
  // Same content threshold as findTextBlock, plus visibility + nav checks.
  // Also rejects elements that contain another candidate block as a descendant
  // — we want the innermost paragraph, not its <article>/<section> wrapper.
  function isCandidateBlock(el) {
    if (!el || el.nodeType !== 1) return false;
    if (!BLOCK_TAGS.has(el.tagName)) return false;
    if (isInNavChrome(el)) return false;
    if (!isVisible(el)) return false;
    const cleaned = cleanPracticeText(el.textContent || "").trim();
    if (cleaned.length < 10) return false;
    // Prefer leaf-ish candidates. If this element contains another BLOCK_TAGS
    // descendant with non-trivial text, skip it — the inner one will be
    // visited by the forward DFS walker next.
    for (const child of el.querySelectorAll(Array.from(BLOCK_TAGS).join(","))) {
      const childTxt = cleanPracticeText(child.textContent || "").trim();
      if (childTxt.length >= 10) return false;
    }
    return true;
  }

  // Move to the next node in document order. Returns null at end of document.
  function nextInDocOrder(node) {
    if (!node) return null;
    if (node.firstChild) return node.firstChild;
    while (node) {
      if (node.nextSibling) return node.nextSibling;
      node = node.parentNode;
    }
    return null;
  }

  // Find the next paragraph-like block in document order strictly after the
  // entire subtree of `current`. Returns null if nothing qualifies.
  function findNextBlock(current) {
    if (!current) return null;
    // Start AFTER current's entire subtree: walk up to find the first ancestor
    // with a next sibling, then start from that sibling.
    let node = current;
    while (node && !node.nextSibling) node = node.parentNode;
    node = node ? node.nextSibling : null;
    let safety = 5000;
    while (node && safety-- > 0) {
      if (isCandidateBlock(node)) return node;
      node = nextInDocOrder(node);
    }
    return null;
  }

  // Strip Wikipedia-style citation/reference markers from a text run before we
  // turn it into typeable spans. The visible page can keep these (they get
  // wrapped in a non-typeable span) but we don't want them in the keystroke
  // stream — they're noise.
  function cleanPracticeText(s) {
    return s
      .replace(/\[citation needed\]/gi, "")
      .replace(/\[clarification needed\]/gi, "")
      .replace(/\[note \d+\]/gi, "")
      .replace(/\[nb \d+\]/gi, "")
      .replace(/\[edit\]/gi, "")
      .replace(/\[\d+\]/g, "")
      .replace(/\[[a-z]\]/g, "")
      .replace(/\[\*\]/g, "")
      .replace(/\[†\]/g, "")
      .replace(/\[‡\]/g, "");
  }

  // Tags whose text content should be preserved visually but not typed.
  const SKIP_TAGS = new Set(["SUP", "STYLE", "SCRIPT", "NOSCRIPT"]);
  // CSS class names that indicate citation/reference machinery (Wikipedia +
  // common variants). Matched exactly OR as a class-name prefix for cite_ref-
  // and cite_note-.
  const SKIP_CLASS_EXACT = new Set([
    "reference",
    "reference-accessdate",
    "mw-cite-backlink",
    "cite_ref",
  ]);
  const SKIP_CLASS_PREFIX = ["cite_ref-", "cite_note-"];

  // True if this element (and therefore its whole subtree) should be skipped
  // when building tp-char spans. We keep the element in the DOM so the page
  // still reads correctly — we just don't generate typeable characters for
  // anything underneath it.
  function isSkipElement(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    // Defense in depth: anchors inside a <sup> are reference links.
    if (el.tagName === "A" && el.parentNode && el.parentNode.tagName === "SUP") return true;
    const id = el.id || "";
    if (id.startsWith("cite_ref-") || id.startsWith("cite_note-")) return true;
    const role = el.getAttribute && el.getAttribute("role");
    if (role === "note" || role === "doc-noteref") return true;
    if (el.closest && el.closest('[role="doc-noteref"]')) return true;
    if (el.classList && el.classList.length) {
      for (const cls of el.classList) {
        if (SKIP_CLASS_EXACT.has(cls)) return true;
        for (const pre of SKIP_CLASS_PREFIX) {
          if (cls.startsWith(pre)) return true;
        }
      }
    }
    return false;
  }

  // Walks ancestors up to (and including) `root`. Returns true if any ancestor
  // matches isSkipElement — used to catch text nodes nested inside a skipped
  // subtree (e.g. <sup class="reference"><a>[2]</a></sup>: the text "[2]"'s
  // parent is <a>, but its <sup> ancestor is what makes it a citation).
  function hasSkipAncestor(node, root) {
    let p = node && node.parentNode;
    while (p && p !== root.parentNode) {
      if (isSkipElement(p)) return true;
      p = p.parentNode;
    }
    return false;
  }

  // Install `block` as the active typing target. Builds tp-char spans, assigns
  // wordIndex / wordCharIndices, bumps blockId, sets the cursor. Returns true
  // on success, false if the block had zero typeable chars after cleanup (in
  // which case the caller should try another block — we do not mutate state on
  // failure beyond the always-cleaned tp-target class).
  // `opts.scope`       — restrict span-building to this descendant of `block`
  //                       (used for sentence selection: spans only cover the
  //                       sentence wrapper, the rest of the block stays prose).
  // `opts.originalHTML` — innerHTML to restore later. The sentence path captures
  //                       this *before* it wraps the sentence, so restore removes
  //                       the wrapper too.
  function installBlock(block, startCursor, opts) {
    opts = opts || {};
    const scope = opts.scope || block;
    state.target = block;
    // Save innerHTML *before* any mutation so restoreTarget fully reverts.
    state.originalHTML = opts.originalHTML != null ? opts.originalHTML : block.innerHTML;
    block.classList.add("tp-target");
    state.blockId += 1;

    // Collect all text nodes inside the scope, but skip any whose ancestor
    // chain includes a citation/reference element. We use SHOW_TEXT and check
    // ancestry manually so the page DOM stays intact (the visible [2] etc.
    // still renders — it just isn't typeable).
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    const textNodes = [];
    const skipNodes = [];
    let n;
    while ((n = walker.nextNode())) {
      if (hasSkipAncestor(n, block)) skipNodes.push(n);
      else textNodes.push(n);
    }

    // Mark skipped text nodes' nearest skip ancestors so they get the dim
    // styling. We don't need to remove them — they stay in the DOM verbatim.
    for (const tn of skipNodes) {
      let p = tn.parentNode;
      while (p && p !== block.parentNode && !isSkipElement(p)) p = p.parentNode;
      if (p && p !== block.parentNode) p.classList.add("tp-skip-render");
    }

    state.chars = [];
    for (const textNode of textNodes) {
      const rawTxt = textNode.nodeValue;
      if (!rawTxt) continue;

      // Second-pass cleanup: even after element-level skipping, some pages
      // render `[1]` as a literal text run alongside prose (no <sup> wrapper).
      // Strip those patterns so they never enter the keystroke stream.
      const txt = cleanPracticeText(rawTxt);
      if (!txt) {
        // Whole node was just citation markers — drop it.
        textNode.parentNode.removeChild(textNode);
        continue;
      }
      const frag = document.createDocumentFragment();
      for (const ch of txt) {
        const span = document.createElement("span");
        span.className = "tp-char";
        span.textContent = ch;
        span.dataset.ch = ch;
        frag.appendChild(span);
        state.chars.push({ span, ch, status: "pending", wordIndex: -1 });
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }

    if (state.chars.length === 0) {
      // Block had no typeable text after cleanup — restore and bail. We don't
      // touch state.originalHTML for previous blocks; this just rolls back the
      // mutation we may have started.
      block.innerHTML = state.originalHTML;
      block.classList.remove("tp-target");
      state.target = null;
      state.originalHTML = null;
      state.chars = [];
      return false;
    }

    // Assign each char a wordIndex. A "word" is a maximal run of non-whitespace
    // expected chars. Whitespace gets wordIndex = -1. wordCharIndices[w] is the
    // array of char indices in word `w` — used by recomputeWordDirtiness for a
    // cheap, bounded recompute when a Backspace clears a char's status.
    state.wordCharIndices = [];
    let curWord = -1;
    for (let i = 0; i < state.chars.length; i++) {
      const c = state.chars[i];
      if (/\s/.test(c.ch)) {
        c.wordIndex = -1;
        curWord = -1;
      } else {
        if (curWord === -1) {
          curWord = state.wordCharIndices.length;
          state.wordCharIndices.push([]);
        }
        c.wordIndex = curWord;
        state.wordCharIndices[curWord].push(i);
      }
    }

    state.cursor = Math.max(0, Math.min(startCursor | 0, state.chars.length - 1));
    return true;
  }

  // Mid-run transition: restore the current block visually (so the page reads
  // normally) and install the next paragraph-like block as the typing target.
  // Counters (correct, keystrokes, wrong, words, startedAt, dirtyWords) stay
  // intact — they're cumulative for the run. Returns true if a next block was
  // found and installed; false if the caller should fall back to finishRun.
  function advanceToNextBlock() {
    const prevTarget = state.target;
    const prevHTML = state.originalHTML;
    if (!prevTarget) return false;

    // Accumulate the leaving block's word classification BEFORE we drop
    // wordCharIndices. Incomplete should always be 0 here (end-of-block is
    // the trigger) but we add it anyway in case a future caller changes that.
    const leavingStats = classifyCurrentBlockWords();
    state.finishedWordStats.correct += leavingStats.correct;
    state.finishedWordStats.wrong   += leavingStats.wrong;
    state.finishedWordStats.skipped += leavingStats.skipped;

    // Restore the just-finished block so the user sees plain prose again.
    prevTarget.innerHTML = prevHTML;
    prevTarget.classList.remove("tp-target");

    // wordCharIndices is per-block — drop it now. dirtyWords entries from the
    // previous block survive (their compound keys use the old blockId, which
    // installBlock has already incremented past).
    state.wordCharIndices = [];
    state.target = null;
    state.originalHTML = null;

    let candidate = findNextBlock(prevTarget);
    let safety = 50;
    while (candidate && safety-- > 0) {
      if (installBlock(candidate, 0)) {
        // Place caret + auto-scroll smoothly to the new block.
        positionCaret(true);
        return true;
      }
      // installBlock failed (no typeable chars) — try the next one.
      candidate = findNextBlock(candidate);
    }
    return false;
  }

  function chooseTarget(block, clickX, clickY) {
    clearAllHover();

    // Sentence granularity: try to carve out just the clicked sentence. If
    // detection fails (click landed off text, etc.) fall back to the paragraph.
    if (state.selectGranularity === "sentence" && chooseSentence(block, clickX, clickY)) {
      return;
    }

    if (!installBlock(block, 0)) return;
    // Always start at the top of the chosen block. Previously the caret was
    // placed at the character nearest the click, so a click low in a paragraph
    // silently started the run mid-text — users read that as "it only grabbed
    // the text from the bottom". We highlight the whole block on hover, so the
    // whole block is what we type, top to bottom.
    beginTyping(block);
  }

  // Wrap the sentence under (clickX, clickY) in a span and install just that
  // span as the typing target. Returns false (without side effects) if the
  // sentence can't be resolved, so chooseTarget can fall back to the paragraph.
  function chooseSentence(block, clickX, clickY) {
    const hit = sentenceRangeAtPoint(block, clickX, clickY);
    if (!hit) return false;
    // Capture pristine HTML *before* wrapping so restore reverts the wrapper.
    const pristine = block.innerHTML;
    const wrap = document.createElement("span");
    wrap.className = "tp-sentence-wrap";
    try {
      wrap.appendChild(hit.range.extractContents());
      hit.range.insertNode(wrap);
    } catch (err) {
      block.innerHTML = pristine; // undo any partial mutation
      return false;
    }
    if (!installBlock(block, 0, { scope: wrap, originalHTML: pristine })) {
      block.innerHTML = pristine;
      return false;
    }
    beginTyping(wrap);
    return true;
  }

  // Shared LAUNCH/ARMED → TYPING transition. `flashEl` is the element to pulse
  // orange as the "selection received" confirmation (the block, or the sentence
  // wrapper for sentence selection).
  function beginTyping(flashEl) {
    state.cursor = 0;

    // Confirmation pulse: flash the chosen text orange so it's unmistakable
    // that the click was received before the prose turns into typeable spans.
    flashSelected(flashEl);

    document.documentElement.classList.remove("tp-armed");
    removeTooltip();
    removeSelectBanner();
    document.removeEventListener("mousemove", onArmedMove, true);

    // Switch listeners: ARMED click listener stays (handles repick? no — we drop it),
    // typing listener takes over.
    document.removeEventListener("click", onArmedClick, true);
    document.addEventListener("click", onTypingClick, true);
    document.addEventListener("keydown", onTypingKey, true);

    state.mode = "TYPING";
    installCaret();
    installKeyboard();
    positionCaret();
    updateNextKeyHint();
    refreshHUDLayout();
    startHUDLoop();
  }

  // One-shot orange confirmation pulse on a freshly chosen block. The class is
  // stripped after the animation so picking the same element again re-triggers
  // it. Purely cosmetic — safe to no-op if the element is gone.
  function flashSelected(el) {
    if (!el) return;
    el.classList.add("tp-selected-flash");
    window.setTimeout(() => el.classList.remove("tp-selected-flash"), 650);
  }

  // ---------- typing (TYPING phase) ----------
  function onGlobalKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      // In RESULTS, Esc maps to Done (full deactivate). Same effect either way.
      deactivate();
    }
  }

  function onTypingKey(e) {
    if (state.mode !== "TYPING") return;

    // Always handle Escape via the global handler — but stop it from bubbling here.
    if (e.key === "Escape") return; // handled by onGlobalKey

    // Flash the matching keyboard cap for any keydown while typing.
    flashKeyboard(e.key);

    // Tab: skip the current word. Shift+Tab is intentionally a no-op now —
    // per-char skipping turned out to be more confusing than useful.
    if (e.key === "Tab") {
      e.preventDefault();
      e.stopPropagation();
      if (e.shiftKey) return;
      // Tab is a deliberate user action; start the Timed countdown the same
      // way Backspace does. Otherwise a user who Tab-skips before typing any
      // char would see the timer frozen.
      if (state.startedAt === 0) state.startedAt = performance.now();
      skipCurrentWord();
      // Tab can run cursor off the end of the block (skipping the last word).
      // Use the same auto-advance / finishRun fallback as the printable path
      // so the user isn't stuck at cursor === chars.length.
      if (state.cursor >= state.chars.length) {
        if (handleEndOfBlock()) return;
        finishRun();
        return;
      }
      positionCaret(true);
      updateNextKeyHint();
      updateHUD();
      return;
    }

    // Cmd+R / Ctrl+R: restart the current run. We intercept the browser's
    // reload shortcut intentionally while in TYPING — reloading would
    // discard the run silently. preventDefault + stopPropagation stops the
    // reload; restartRun resets char statuses, counters, and caret to 0.
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey &&
        (e.key === "r" || e.key === "R")) {
      e.preventDefault();
      e.stopPropagation();
      restartRun();
      return;
    }

    // Backspace: step the cursor back one (and reset that char to pending).
    if (e.key === "Backspace") {
      e.preventDefault();
      e.stopPropagation();
      // Treat Backspace as a real user action — start the clock if it hasn't
      // already started. (Bug fix: timer used to only start on first correct
      // keystroke, leaving Timed mode frozen if the user only made mistakes.)
      if (state.startedAt === 0) state.startedAt = performance.now();
      stepBack();
      positionCaret(true);
      updateNextKeyHint();
      updateHUD();
      return;
    }

    // Ignore pure modifiers and navigation keys.
    if (e.key.length !== 1 && e.key !== "Enter") return;
    // Ignore when a modifier other than Shift is held (e.g. Cmd+R reload).
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    const expected = currentExpectedChar();
    if (expected == null) return; // finished

    const typed = e.key === "Enter" ? "\n" : e.key;
    state.keystrokes += 1;
    // Timer starts on the first printable keystroke — correct or wrong. We
    // also start it on Backspace (see onTypingKey above) so any deliberate
    // user action begins the clock.
    if (state.startedAt === 0) state.startedAt = performance.now();

    if (charMatches(typed, expected)) {
      markChar(state.cursor, "correct");
      state.correctCount += 1;
      noteCorrectChar();
      state.cursor += 1;
    } else {
      markChar(state.cursor, "wrong");
      // Forgiving: still advance so the user can keep going. The wrong char
      // stays highlighted so they see the mistake.
      state.cursor += 1;
    }

    if (state.cursor >= state.chars.length) {
      if (handleEndOfBlock()) return;
      finishRun();
      return;
    }
    positionCaret(true);
    updateNextKeyHint();
    updateHUD();
  }

  // Called when state.cursor has overshot the end of the current block (from
  // either the printable-keystroke path or Tab-skip). Tries to auto-advance
  // to the next paragraph for Timed runs that still have budget left; returns
  // true if we advanced (caller should return; HUD/hint already refreshed).
  // Returns false to mean "no advance happened" — caller should call finishRun
  // or fall through to its normal flow.
  function handleEndOfBlock() {
    // Sentence selection is deliberate and self-contained: when you finish the
    // sentence the run ends with results, rather than auto-advancing into the
    // surrounding paragraph (which would defeat the point of picking a
    // sentence). Continuous timed flow is what paragraph granularity is for.
    if (state.selectGranularity === "sentence") return false;
    const kind = state.selectedMode.kind;
    let canAdvance = false;
    if (kind === "timed") {
      const total = state.selectedMode.value * 1000;
      const elapsed = state.startedAt > 0 ? (performance.now() - state.startedAt) : 0;
      canAdvance = elapsed < total;
    }
    if (canAdvance && advanceToNextBlock()) {
      updateNextKeyHint();
      updateHUD();
      return true;
    }
    return false;
  }

  function currentExpectedChar() {
    if (state.cursor >= state.chars.length) return null;
    return state.chars[state.cursor].ch;
  }

  // Loose matching: treat curly quotes/dashes the same as straight ones.
  function charMatches(typed, expected) {
    if (typed === expected) return true;
    const norm = (c) =>
      c
        .replace(/[‘’ʼ]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/[–—]/g, "-")
        .replace(/ /g, " ");
    return norm(typed) === norm(expected);
  }

  // Compound key for the dirtyWords set. Lets a single run accumulate errors
  // across multiple blocks (auto-advance) without word-0-of-block-2 colliding
  // with word-0-of-block-1.
  function wordKey(wordIndex) {
    return state.blockId + ":" + wordIndex;
  }

  function markChar(i, status) {
    const c = state.chars[i];
    if (!c) return;
    c.status = status;
    c.span.classList.remove("tp-correct", "tp-wrong", "tp-skipped");
    if (status === "correct") c.span.classList.add("tp-correct");
    else if (status === "wrong") c.span.classList.add("tp-wrong");
    else if (status === "skipped") c.span.classList.add("tp-skipped");
    // Maintain dirtyWords incrementally on the hot path. Wrong/skipped chars
    // make their word dirty; correct chars do nothing here (clearing happens
    // in stepBack via recomputeWordDirtiness).
    if (c.wordIndex >= 0 && (status === "wrong" || status === "skipped")) {
      state.dirtyWords.add(wordKey(c.wordIndex));
    }
  }

  // Re-scan all chars in `wordIndex` (within the CURRENT block) and add or
  // remove its compound key from dirtyWords. Bounded scan — words are short.
  // Called when a char's status is cleared (Backspace) since at that point we
  // can't tell from one char whether the whole word is still dirty.
  function recomputeWordDirtiness(wordIndex) {
    if (wordIndex < 0) return;
    const indices = state.wordCharIndices[wordIndex];
    if (!indices) return;
    const key = wordKey(wordIndex);
    for (const ci of indices) {
      const s = state.chars[ci].status;
      if (s === "wrong" || s === "skipped") {
        state.dirtyWords.add(key);
        return;
      }
    }
    // No remaining wrong/skipped chars — the user corrected the whole word.
    state.dirtyWords.delete(key);
  }

  // Classify every word in the current block into correct / wrong / skipped /
  // incomplete buckets. Used by advanceToNextBlock (to accumulate the leaving
  // block — incomplete will always be 0 there since end-of-block is the
  // trigger) and by statsSnapshot at finish time (where the trailing word can
  // legitimately be incomplete because the timer cut the user off mid-word).
  //
  // A word counts only if the user PHYSICALLY TOUCHED at least one of its
  // chars (i.e. some char has a non-pending status). Words entirely pending
  // — including all words before a mid-block click position — are excluded
  // from every bucket. Without this guard, clicking mid-block would flood
  // the "incomplete" bucket with every pre-click word (bug fix).
  //
  // Precedence when a touched word has chars of multiple statuses:
  //   1. any char "wrong"               → wrong   (overrides skipped — typos
  //                                              are louder than tab-skips)
  //   2. any char "skipped" (no wrong)  → skipped
  //   3. any char still "pending"       → incomplete  (mid-typed, e.g. timer
  //                                              cut the user off mid-word)
  //   4. otherwise                      → correct
  function classifyCurrentBlockWords() {
    const out = { correct: 0, wrong: 0, skipped: 0, incomplete: 0 };
    for (const indices of state.wordCharIndices) {
      if (!indices.length) continue;
      let hasPending = false, hasWrong = false, hasSkipped = false, hasNonPending = false;
      for (const ci of indices) {
        const s = state.chars[ci].status;
        if (s === "pending") hasPending = true;
        else hasNonPending = true;
        if (s === "wrong") hasWrong = true;
        else if (s === "skipped") hasSkipped = true;
      }
      if (!hasNonPending) continue; // user never touched this word — don't count it
      if (hasWrong) out.wrong += 1;
      else if (hasSkipped) out.skipped += 1;
      else if (hasPending) out.incomplete += 1;
      else out.correct += 1;
    }
    return out;
  }

  function skipCurrentWord() {
    // Advance until we hit a whitespace, then consume the whitespace too.
    while (state.cursor < state.chars.length && !/\s/.test(state.chars[state.cursor].ch)) {
      markChar(state.cursor, "skipped");
      state.cursor += 1;
    }
    while (state.cursor < state.chars.length && /\s/.test(state.chars[state.cursor].ch)) {
      markChar(state.cursor, "skipped");
      state.cursor += 1;
    }
  }

  function stepBack() {
    if (state.cursor === 0) return;
    state.cursor -= 1;
    const c = state.chars[state.cursor];
    if (c.status === "correct") {
      // Voluntary backspace over a correct char fully reverses the keystroke:
      // both `keystrokes` and `correctCount` roll back. This keeps accuracy
      // at 100% across cascade-fix sequences where the user backspaces past
      // good chars to reach an earlier typo, then retypes correctly.
      state.correctCount = Math.max(0, state.correctCount - 1);
      state.keystrokes = Math.max(0, state.keystrokes - 1);
    } else if (c.status === "wrong") {
      // Backspace over a wrong char fully reverses the failed attempt. Both
      // `keystrokes` and dirtyWords accounting roll back so accuracy and the
      // headline error count agree: a fully-corrected typo costs the user
      // nothing on either metric. Matches the existing word-error semantics.
      state.keystrokes = Math.max(0, state.keystrokes - 1);
    }
    const prevWordIndex = c.wordIndex;
    c.status = "pending";
    c.span.classList.remove("tp-correct", "tp-wrong", "tp-skipped");
    // After clearing the status, the word may no longer be dirty (if the
    // user is re-typing it correctly). Recompute that one word's dirtiness.
    recomputeWordDirtiness(prevWordIndex);
  }

  // ---------- caret ----------
  function installCaret() {
    if (caretEl) return;
    caretEl = document.createElement("div");
    caretEl.id = "tp-caret";
    document.body.appendChild(caretEl);
    window.addEventListener("scroll", onScrollOrResize, { passive: true });
    window.addEventListener("resize", onScrollOrResize);
  }
  function removeCaret() {
    if (caretEl) caretEl.remove();
    caretEl = null;
    window.removeEventListener("scroll", onScrollOrResize);
    window.removeEventListener("resize", onScrollOrResize);
    if (scrollRaf) { cancelAnimationFrame(scrollRaf); scrollRaf = 0; }
    if (autoScrollTimer) { window.clearTimeout(autoScrollTimer); autoScrollTimer = 0; }
    isAutoScrolling = false;
  }
  // `advanced` true when the caret moved because of a keystroke (vs. a scroll
  // or resize event). Only advance-driven repositions get to auto-scroll the
  // viewport — otherwise we'd fight the user's own scrolling.
  function positionCaret(advanced) {
    if (!caretEl) return;
    // While a smooth auto-scroll is animating, ignore scroll-driven
    // repositions. They'd re-trigger the auto-scroll branch below and
    // recurse until the stack blows. Keystroke-driven calls (advanced)
    // are still allowed through.
    if (isAutoScrolling && !advanced) return;
    const i = state.cursor;
    let r;
    if (i >= state.chars.length) {
      // Park caret at end of last char.
      const last = state.chars[state.chars.length - 1];
      if (!last) return;
      r = last.span.getBoundingClientRect();
      caretEl.style.top = window.scrollY + r.top + "px";
      caretEl.style.left = window.scrollX + r.right + "px";
      caretEl.style.height = r.height + "px";
    } else {
      const span = state.chars[i].span;
      r = span.getBoundingClientRect();
      caretEl.style.top = window.scrollY + r.top + "px";
      caretEl.style.left = window.scrollX + r.left + "px";
      caretEl.style.height = r.height + "px";
    }

    if (advanced) {
      // Keep the caret near the vertical center of the viewport (slightly
      // above — 40% from top reads more naturally, like a normal reading
      // line). On every keystroke advance, compute the caret's current
      // viewport Y and the delta to the target band. A 24px dead zone
      // prevents micro-scrolls on every single character. The re-entry
      // guards (isAutoScrolling + autoScrollTimer) ensure the smooth-scroll
      // animation's own scroll events don't recurse back into here.
      const caretCenterY = r.top + r.height / 2;
      const targetY = window.innerHeight * 0.4;
      const delta = caretCenterY - targetY;
      if (Math.abs(delta) > 24) {
        isAutoScrolling = true;
        if (autoScrollTimer) window.clearTimeout(autoScrollTimer);
        autoScrollTimer = window.setTimeout(() => {
          isAutoScrolling = false;
          autoScrollTimer = 0;
        }, 400);
        window.scrollBy({ top: delta, behavior: "smooth" });
      }
    }
  }

  // Reposition caret on scroll / resize. Attached only while caret exists.
  // rAF-debounced so we don't call positionCaret on every scroll event.
  function onScrollOrResize() {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (state.mode === "TYPING") positionCaret(false);
    });
  }

  // While typing, swallow clicks landing inside the practice block so an
  // <a>-wrapped span doesn't navigate away. Clicks on our own HUD/tooltip
  // pass through, and clicks elsewhere on the page are allowed.
  function onTypingClick(e) {
    if (state.mode !== "TYPING") return;
    if (e.target.closest && e.target.closest("#tp-hud, #tp-tooltip, #tp-select-banner, .tp-backdrop")) return;
    if (state.target && state.target.contains(e.target)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  // ---------- on-screen keyboard ----------
  // Rows of [key-label, data-key, optional CSS class for width]. The label is
  // what shows on the cap; data-key is what we match keystrokes against.
  const KEYBOARD_ROWS = [
    [
      ["`", "`"], ["1", "1"], ["2", "2"], ["3", "3"], ["4", "4"], ["5", "5"],
      ["6", "6"], ["7", "7"], ["8", "8"], ["9", "9"], ["0", "0"],
      ["-", "-"], ["=", "="],
      ["Backspace", "backspace", "tp-key-wide-2"],
    ],
    [
      ["Tab", "tab", "tp-key-wide-1_5"],
      ["q", "q"], ["w", "w"], ["e", "e"], ["r", "r"], ["t", "t"],
      ["y", "y"], ["u", "u"], ["i", "i"], ["o", "o"], ["p", "p"],
      ["[", "["], ["]", "]"], ["\\", "\\"],
    ],
    [
      ["Caps", "caps", "tp-key-wide-1_75"],
      ["a", "a"], ["s", "s"], ["d", "d"], ["f", "f"], ["g", "g"],
      ["h", "h"], ["j", "j"], ["k", "k"], ["l", "l"],
      [";", ";"], ["'", "'"],
      ["Enter", "enter", "tp-key-wide-2_25"],
    ],
    [
      ["Shift", "shift", "tp-key-wide-2_25"],
      ["z", "z"], ["x", "x"], ["c", "c"], ["v", "v"], ["b", "b"],
      ["n", "n"], ["m", "m"], [",", ","], [".", "."], ["/", "/"],
      ["Shift", "shift", "tp-key-wide-2_25"],
    ],
    // Bottom row is platform-specific. Mac keyboards have Ctrl/Opt/Cmd on
    // each side of Space; Windows/Linux keyboards have Ctrl/Win/Alt. We
    // render only the user's actual layout so the visual matches muscle
    // memory. Modifier flashing in flashKeyboard maps Meta→cmd/win and
    // Alt→opt/alt accordingly.
    IS_MAC ? [
      ["Ctrl", "ctrl"], ["Opt", "opt"], ["Cmd", "cmd"],
      ["", "space", "tp-key-space"],
      ["Cmd", "cmd"], ["Opt", "opt"], ["Ctrl", "ctrl"],
    ] : [
      ["Ctrl", "ctrl"], ["Win", "win"], ["Alt", "alt"],
      ["", "space", "tp-key-space"],
      ["Alt", "alt"], ["Win", "win"], ["Ctrl", "ctrl"],
    ],
  ];

  // Map shifted symbol → its unshifted base key on a US QWERTY layout. Used to
  // find which physical key to flash/hint when a shifted character appears.
  const SHIFT_MAP = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5",
    "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=",
    "{": "[", "}": "]", "|": "\\",
    ":": ";", '"': "'",
    "<": ",", ">": ".", "?": "/",
    "~": "`",
  };

  // Finger-zone classification by data-key. Used to color each key according
  // to which finger should press it in standard touch-typing form. Some keys
  // appear twice on the keyboard (Shift, Ctrl, Alt, Cmd) but are assigned to
  // the same finger group (left/right are merged) — distinguishing left vs.
  // right would require lookup by (row, col) and the educational benefit is
  // marginal, since both sides belong to the pinky/thumb zones anyway.
  const FINGER_BY_KEY = {
    // Left pinky. Shift/Ctrl/Alt are duplicated on the keyboard but both
    // sides belong to the pinky group, so a single mapping covers both.
    "`": "left-pinky", "1": "left-pinky", "q": "left-pinky", "a": "left-pinky",
    "z": "left-pinky", "tab": "left-pinky", "caps": "left-pinky",
    "shift": "left-pinky", "ctrl": "left-pinky", "alt": "left-pinky",
    "opt": "left-pinky", // Mac-only alias for Alt
    // Left ring
    "2": "left-ring", "w": "left-ring", "s": "left-ring", "x": "left-ring",
    // Left middle
    "3": "left-middle", "e": "left-middle", "d": "left-middle", "c": "left-middle",
    // Left index — covers two columns (the index finger reaches across).
    "4": "left-index", "5": "left-index",
    "r": "left-index", "t": "left-index",
    "f": "left-index", "g": "left-index",
    "v": "left-index", "b": "left-index",
    // Thumbs. Cmd/Win sit next to space on each platform and are thumb-reached.
    "space": "thumbs", "cmd": "thumbs", "win": "thumbs",
    // Right index
    "6": "right-index", "7": "right-index",
    "y": "right-index", "u": "right-index",
    "h": "right-index", "j": "right-index",
    "n": "right-index", "m": "right-index",
    // Right middle
    "8": "right-middle", "i": "right-middle", "k": "right-middle", ",": "right-middle",
    // Right ring
    "9": "right-ring", "o": "right-ring", "l": "right-ring", ".": "right-ring",
    // Right pinky. Backspace, Enter, and the symbol cluster all reach with
    // the same finger in standard touch-typing form.
    "0": "right-pinky", "-": "right-pinky", "=": "right-pinky",
    "p": "right-pinky", "[": "right-pinky", "]": "right-pinky", "\\": "right-pinky",
    ";": "right-pinky", "'": "right-pinky",
    "enter": "right-pinky", "/": "right-pinky", "backspace": "right-pinky",
  };

  function installKeyboard() {
    if (keyboardEl) return;
    keyboardEl = document.createElement("div");
    keyboardEl.id = "tp-keyboard";
    for (const row of KEYBOARD_ROWS) {
      const rowEl = document.createElement("div");
      rowEl.className = "tp-keyboard-row";
      for (const def of row) {
        const [label, key, widthCls] = def;
        const k = document.createElement("div");
        k.className = "tp-key" + (widthCls ? " " + widthCls : "");
        k.dataset.key = key;
        const finger = FINGER_BY_KEY[key];
        if (finger) k.dataset.finger = finger;
        k.textContent = label;
        rowEl.appendChild(k);
      }
      keyboardEl.appendChild(rowEl);
    }
    document.body.appendChild(keyboardEl);
  }

  function removeKeyboard() {
    if (keyboardEl) keyboardEl.remove();
    keyboardEl = null;
    nextHintedEls = [];
  }

  // Find all keyboard key elements matching `key` (data-key attribute). There
  // are two Shift keys, two Cmd/Alt/Ctrl — flashing both reads naturally.
  function findKeyEls(key) {
    if (!keyboardEl || !key) return [];
    return Array.from(keyboardEl.querySelectorAll(`.tp-key[data-key="${CSS.escape(key)}"]`));
  }

  // Map a raw KeyboardEvent.key to one or more data-key values to flash.
  // Returns an array because shifted symbols flash both the base key and Shift.
  function dataKeysForEventKey(eventKey) {
    if (eventKey == null) return [];
    if (eventKey === " ") return ["space"];
    if (eventKey === "Backspace") return ["backspace"];
    if (eventKey === "Tab") return ["tab"];
    if (eventKey === "Enter") return ["enter"];
    if (eventKey === "Shift") return ["shift"];
    if (eventKey === "Control") return ["ctrl"];
    // Alt vs. Opt and Meta (Cmd vs. Win) depend on platform — flash whichever
    // cap is actually rendered for this user.
    if (eventKey === "Alt") return [IS_MAC ? "opt" : "alt"];
    if (eventKey === "Meta") return [IS_MAC ? "cmd" : "win"];
    if (eventKey === "CapsLock") return ["caps"];
    if (eventKey.length !== 1) return [];
    // Uppercase letter → flash lowercase letter and Shift.
    if (/[A-Z]/.test(eventKey)) return [eventKey.toLowerCase(), "shift"];
    // Shifted punctuation → flash base key and Shift.
    if (SHIFT_MAP[eventKey]) return [SHIFT_MAP[eventKey], "shift"];
    // Lowercase letter or unshifted punctuation.
    return [eventKey];
  }

  // Map an *expected* character into data-keys to highlight as the next-key
  // hint. Same shape as the flash mapper but treats uppercase/shifted as
  // base-key + Shift so the user sees they need to hold Shift.
  function dataKeysForExpectedChar(ch) {
    if (ch == null) return [];
    if (ch === " ") return ["space"];
    if (ch === "\n") return ["enter"];
    if (ch === "\t") return ["tab"];
    if (ch.length !== 1) return [];
    if (/[A-Z]/.test(ch)) return [ch.toLowerCase(), "shift"];
    if (SHIFT_MAP[ch]) return [SHIFT_MAP[ch], "shift"];
    return [ch];
  }

  function flashKeyboard(eventKey) {
    if (!keyboardEl) return;
    const keys = dataKeysForEventKey(eventKey);
    for (const k of keys) {
      for (const el of findKeyEls(k)) {
        el.classList.add("tp-key-active");
        window.setTimeout(() => {
          if (el.isConnected) el.classList.remove("tp-key-active");
        }, 120);
      }
    }
  }

  // Highlight whichever physical key(s) correspond to the next expected char.
  // Clears any previous hint first so only the current expectation lights up.
  function updateNextKeyHint() {
    if (!keyboardEl) return;
    for (const el of nextHintedEls) el.classList.remove("tp-key-next");
    nextHintedEls = [];
    const expected = currentExpectedChar();
    if (expected == null) return;
    const keys = dataKeysForExpectedChar(expected);
    for (const k of keys) {
      for (const el of findKeyEls(k)) {
        el.classList.add("tp-key-next");
        nextHintedEls.push(el);
      }
    }
  }

  // ---------- HUD ----------
  function installHUD() {
    if (hudEl) return;
    hudEl = document.createElement("div");
    hudEl.id = "tp-hud";
    document.body.appendChild(hudEl);
    refreshHUDLayout();
  }
  // Rebuilds the HUD rows based on selectedMode (timer label changes between
  // Free/Timed). Called when entering TYPING and whenever mode changes.
  // Also (re-)initializes the svg-gauge speedometer that mounts into
  // #tp-speedo. The library's own value text is hidden (showValue:false) —
  // we render our own bigger, color-coded readout in the absolutely-positioned
  // .tp-speedo-readout overlay.
  function refreshHUDLayout() {
    if (!hudEl) return;
    const timeLabel = state.selectedMode.kind === "timed" ? "Time left:" : "Time:";
    hudEl.innerHTML = `
      <div class="tp-speedo">
        <div class="tp-speedo-container" id="tp-speedo"></div>
        <div class="tp-speedo-readout">
          <div class="tp-speedo-value" id="tp-speedo-value">—</div>
          <div class="tp-speedo-label">WPM</div>
        </div>
      </div>
      <div class="tp-hud-rows">
        <span class="tp-label">${timeLabel}</span><span class="tp-value"><span id="tp-time">0:00</span></span>
        <span class="tp-label">Errors:</span><span class="tp-value"><span id="tp-err">0</span></span>
        <span class="tp-label">Accuracy:</span><span class="tp-value"><span id="tp-acc">100.0</span><span class="tp-unit">%</span></span>
      </div>
    `;
    initSpeedometer();
  }

  // (Re-)mount the svg-gauge into #tp-speedo. Called any time the HUD HTML is
  // rebuilt (refreshHUDLayout replaces innerHTML, which throws away the
  // previous gauge's SVG). The library exposes a UMD global at window.Gauge.
  // dialStartAngle:180 + dialEndAngle:0 traces a half-circle that opens
  // upward (left edge at 180°, right edge at 0°). max:LIVE_WPM_MAX so the
  // arc fills at 120 WPM. showValue:false hides the library's own text so
  // our overlay renders unobstructed. The `color` callback runs on every
  // animated tick and lets us shift the arc through the speed-band palette.
  function initSpeedometer() {
    const container = hudEl && hudEl.querySelector("#tp-speedo");
    if (!container || typeof window.Gauge !== "function") {
      state.gauge = null;
      return;
    }
    state.gauge = window.Gauge(container, {
      min: 0,
      max: LIVE_WPM_MAX,
      dialStartAngle: 180,
      dialEndAngle: 0,
      value: 0,
      showValue: false,
      // wpmColor() never returns null here — the callback is only invoked
      // with numeric gauge values, not the warmup sentinel.
      color: (value) => wpmColor(value),
    });
  }
  function removeHUD() {
    if (hudEl) hudEl.remove();
    hudEl = null;
    // The gauge's SVG was inside hudEl, so it's already gone — just clear
    // our reference to let the library instance be GC'd.
    state.gauge = null;
  }
  function startHUDLoop() {
    stopHUDLoop();
    state.hudTimer = window.setInterval(updateHUD, 250);
  }
  function stopHUDLoop() {
    if (state.hudTimer) window.clearInterval(state.hudTimer);
    state.hudTimer = 0;
  }
  function formatTime(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function elapsedMs() {
    return state.startedAt > 0 ? (performance.now() - state.startedAt) : 0;
  }

  // Live-WPM rolling window. Push the timestamp of every correct keystroke;
  // prune entries older than the window during HUD ticks.
  const LIVE_WPM_WINDOW_MS = 10000;
  const LIVE_WPM_WARMUP_MS = 2000; // show "—" until we have a stable read
  const LIVE_WPM_MAX = 120;        // full-arc threshold
  const LIVE_WPM_DISPLAY_CAP = 200; // never display more than this

  // Speed-band color for the speedometer arc and readout. Bands match a
  // typing-skill progression: under 30 is hunt-and-peck, 30–60 is casual,
  // 60–90 is competent, 90+ is fast. Returns a hex string. During warmup
  // (wpm === null) we fall back to the muted foreground so the readout
  // dash and empty arc don't shout.
  function wpmColor(wpm) {
    if (wpm == null) return null; // caller uses CSS var fallback
    if (wpm < 30) return "#ef4444"; // red
    if (wpm < 60) return "#f59e0b"; // orange
    if (wpm < 90) return "#10b981"; // green
    return "#3b82f6";               // bright blue
  }

  function noteCorrectChar() {
    state.recentCorrectChars.push(performance.now());
  }

  // Compute live WPM from the rolling window. Returns null during warmup so
  // the gauge can render a dash instead of a noisy number.
  function liveWPM() {
    const now = performance.now();
    const since = state.startedAt > 0 ? now - state.startedAt : 0;
    if (state.startedAt === 0 || since < LIVE_WPM_WARMUP_MS) return null;
    // Prune outside the window.
    const cutoff = now - LIVE_WPM_WINDOW_MS;
    const arr = state.recentCorrectChars;
    let drop = 0;
    while (drop < arr.length && arr[drop] < cutoff) drop += 1;
    if (drop > 0) arr.splice(0, drop);
    const count = arr.length;
    // Use the shorter of (window, time since start) so the metric ramps in
    // honestly during the first 10 seconds.
    const windowMs = Math.min(LIVE_WPM_WINDOW_MS, since);
    const minutes = windowMs / 60000;
    if (minutes <= 0) return 0;
    return Math.min(LIVE_WPM_DISPLAY_CAP, Math.round((count / 5) / minutes));
  }

  function updateHUD() {
    if (!hudEl) return;
    const ms = elapsedMs();
    state.elapsedMs = ms;
    const acc = state.keystrokes > 0 ? (state.correctCount / state.keystrokes) * 100 : 100;
    const accEl = hudEl.querySelector("#tp-acc");
    const timeEl = hudEl.querySelector("#tp-time");
    const errEl = hudEl.querySelector("#tp-err");
    if (accEl) accEl.textContent = acc.toFixed(1);
    if (errEl) errEl.textContent = String(state.dirtyWords.size);

    // Speedometer: live WPM with rolling 10s window, driving the svg-gauge
    // library's animated arc. During the 2s warmup, target=0 (empty arc) and
    // the readout shows "—". The library's `color` callback already shifts
    // the arc through the speed-band palette as the value animates; we still
    // drive the readout text color from JS so it band-hops in lockstep.
    const wpm = liveWPM();
    const valueEl = hudEl.querySelector("#tp-speedo-value");
    const color = wpmColor(wpm);
    if (valueEl) {
      valueEl.textContent = wpm == null ? "—" : String(wpm);
      valueEl.style.color = color || "";
    }
    if (state.gauge) {
      const target = wpm == null ? 0 : Math.max(0, Math.min(LIVE_WPM_MAX, wpm));
      state.gauge.setValueAnimated(target, 0.3); // 300ms animation
    }

    if (state.selectedMode.kind === "timed") {
      const total = state.selectedMode.value * 1000;
      const remaining = total - ms;
      if (timeEl) timeEl.textContent = formatTime(state.startedAt > 0 ? Math.max(0, remaining) : total);
      if (state.startedAt > 0 && remaining <= 0 && state.mode === "TYPING") {
        finishRun();
      }
    } else {
      if (timeEl) timeEl.textContent = formatTime(ms);
    }
  }

  // ---------- selection-mode banner ----------
  // Top-center, unmissable "you are in selection mode" prompt. Shown the whole
  // time we're ARMED and torn down the moment a block is chosen (chooseTarget)
  // or the run ends (deactivate). The animated dot + orange border echo the
  // hover highlight so the two read as one feature.
  function installSelectBanner() {
    if (selectBannerEl) return;
    selectBannerEl = document.createElement("div");
    selectBannerEl.id = "tp-select-banner";
    selectBannerEl.innerHTML = `
      <span class="tp-select-dot"></span>
      <span class="tp-select-text">Selection mode — hover, then <b>click</b> to start typing</span>
      <span class="tp-select-toggle" role="group" aria-label="What a click selects">
        <button type="button" class="tp-gran-btn" data-gran="sentence">Sentence</button>
        <button type="button" class="tp-gran-btn" data-gran="paragraph">Paragraph</button>
      </span>
    `;
    document.body.appendChild(selectBannerEl);
    selectBannerEl.querySelector(".tp-select-toggle").addEventListener("click", (e) => {
      const btn = e.target.closest(".tp-gran-btn");
      if (btn) setGranularity(btn.dataset.gran);
    });
    updateGranularityButtons();
  }
  function removeSelectBanner() {
    if (selectBannerEl) selectBannerEl.remove();
    selectBannerEl = null;
  }

  // Switch what a click selects (paragraph vs. sentence). Clears the current
  // hover feedback so the next mousemove redraws it at the new granularity.
  function setGranularity(gran) {
    if (gran !== "sentence" && gran !== "paragraph") return;
    state.selectGranularity = gran;
    clearAllHover();
    updateGranularityButtons();
  }
  function updateGranularityButtons() {
    if (!selectBannerEl) return;
    for (const b of selectBannerEl.querySelectorAll(".tp-gran-btn")) {
      const active = b.dataset.gran === state.selectGranularity;
      b.classList.toggle("tp-gran-active", active);
      b.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  // ---------- tooltip ----------
  function installTooltip() {
    if (tooltipEl) return;
    tooltipEl = document.createElement("div");
    tooltipEl.id = "tp-tooltip";
    tooltipEl.innerHTML = `
      <ul>
        <li>Hover text — it glows orange — then click to start.</li>
        <li>Use the banner toggle to pick <b>Sentence</b> or <b>Paragraph</b>.</li>
        <li>Press <kbd>Tab</kbd> to skip the current word.</li>
        <li>Press ${IS_MAC ? "<kbd>⌘</kbd> <kbd>R</kbd>" : "<kbd>Ctrl</kbd>+<kbd>R</kbd>"} to restart.</li>
        <li>Press <kbd>ESC</kbd> to finish.</li>
      </ul>
    `;
    document.body.appendChild(tooltipEl);
    // Position top-right-ish, below the toolbar area.
    const place = () => {
      const r = tooltipEl.getBoundingClientRect();
      tooltipEl.style.top = "90px";
      tooltipEl.style.left = (window.innerWidth - r.width - 40) + "px";
    };
    place();
  }
  function removeTooltip() {
    if (tooltipEl) tooltipEl.remove();
    tooltipEl = null;
  }

  // ---------- results modal (RESULTS phase) ----------
  function finishRun() {
    if (state.mode !== "TYPING") return;
    // Flip state BEFORE updateHUD so a concurrent interval tick or the
    // updateHUD call below cannot re-enter finishRun (Timed mode race).
    state.mode = "RESULTS";
    stopHUDLoop();
    document.removeEventListener("keydown", onTypingKey, true);
    document.removeEventListener("click", onTypingClick, true);
    // Freeze final values into the HUD before unmounting the caret.
    updateHUD();
    removeCaret();
    removeKeyboard();
    showResults();
  }

  function statsSnapshot() {
    const ms = state.startedAt > 0 ? state.elapsedMs : 0;
    const minutes = ms / 60000;
    // Gross WPM: only correct chars count toward speed, divided by 5 (the
    // industry-standard word length) and elapsed minutes.
    const wpm = minutes > 0 ? Math.round(state.correctCount / 5 / minutes) : 0;
    // Character-level accuracy: every printable+Enter attempt counts in the
    // denominator; only correct attempts count in the numerator.
    const acc = state.keystrokes > 0 ? (state.correctCount / state.keystrokes) * 100 : 100;
    // Cumulative word breakdown = (blocks already left behind via
    // advanceToNextBlock) + (current block, including any incomplete trailing
    // word the timer cut off).
    const currentBlock = classifyCurrentBlockWords();
    const words = {
      correct:    state.finishedWordStats.correct + currentBlock.correct,
      wrong:      state.finishedWordStats.wrong   + currentBlock.wrong,
      skipped:    state.finishedWordStats.skipped + currentBlock.skipped,
      incomplete: currentBlock.incomplete, // only the current block contributes
    };
    return {
      wpm,
      acc,
      // Headline error count is word-level (one typo per word = 1 error).
      errors: state.dirtyWords.size,
      elapsed: formatTime(ms),
      words,
    };
  }

  // Render the word-breakdown string. Always include correct + wrong;
  // include skipped / incomplete only when non-zero to keep it tight.
  function renderWordsBreakdown(w) {
    const parts = [
      `${w.correct} correct`,
      `${w.wrong} wrong`,
    ];
    if (w.skipped > 0) parts.push(`${w.skipped} skipped`);
    if (w.incomplete > 0) parts.push(`${w.incomplete} incomplete`);
    return parts.join(" · ");
  }

  function showResults() {
    if (resultsEl) return;
    const s = statsSnapshot();
    resultsEl = document.createElement("div");
    resultsEl.id = "tp-results";
    resultsEl.className = "tp-backdrop";
    resultsEl.innerHTML = `
      <div class="tp-card" role="dialog" aria-label="Results">
        <button class="tp-card-close" type="button" aria-label="Close">&times;</button>
        <h2 class="tp-card-title">Run complete</h2>
        <div class="tp-hero">
          <div class="tp-hero-wpm">${s.wpm}</div>
          <div class="tp-hero-label">Words per minute</div>
        </div>
        <div class="tp-stats">
          <div class="tp-stat-label">Accuracy</div><div class="tp-stat-value">${s.acc.toFixed(1)}%</div>
          <div class="tp-stat-label">Errors</div><div class="tp-stat-value">${s.errors}</div>
          <div class="tp-stat-label">Time</div><div class="tp-stat-value">${s.elapsed}</div>
        </div>
        <div class="tp-words-row">
          <span class="tp-stat-label">Words</span>
          <span class="tp-words-value">${renderWordsBreakdown(s.words)}</span>
        </div>
        <div class="tp-actions">
          <button type="button" class="tp-btn" data-action="share">Share</button>
          <button type="button" class="tp-btn" data-action="next">Next paragraph</button>
          <button type="button" class="tp-btn" data-action="restart">Restart</button>
          <button type="button" class="tp-btn tp-btn-primary" data-action="done">Done</button>
        </div>
      </div>
    `;
    document.body.appendChild(resultsEl);
    resultsEl.addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      if (btn.classList.contains("tp-card-close")) { deactivate(); return; }
      const action = btn.dataset.action;
      if (action === "done") deactivate();
      else if (action === "restart") restartRun();
      else if (action === "next") nextParagraph();
      else if (action === "share") shareResults(btn);
    });
  }

  function describeMode() {
    const m = state.selectedMode;
    if (m.kind === "timed") return `Timed ${m.value}s`;
    return "Free";
  }

  function shareResults(btn) {
    const s = statsSnapshot();
    const text = `Typed at ${s.wpm} WPM (${s.acc.toFixed(0)}% accuracy) on Typing Practice Anywhere — ${describeMode()}. https://github.com/trenbolone1122/typing-practice-anywhere`;
    const flashCopied = () => {
      const original = btn.textContent;
      btn.textContent = "Copied!";
      btn.disabled = true;
      window.setTimeout(() => {
        if (!btn.isConnected) return;
        btn.textContent = original;
        btn.disabled = false;
      }, 1200);
    };
    const fallbackCopy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.left = "-1000px";
      ta.setAttribute("readonly", "");
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch (_) { /* swallow */ }
      ta.remove();
      flashCopied();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(flashCopied, fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  function removeResults() {
    if (resultsEl) resultsEl.remove();
    resultsEl = null;
  }

  // Restart the same block in the same mode. Resets char statuses + counters.
  function restartRun() {
    removeResults();
    for (const c of state.chars) {
      c.status = "pending";
      c.span.classList.remove("tp-correct", "tp-wrong", "tp-skipped");
    }
    // wordCharIndices and each char's wordIndex stay the same — only the
    // statuses get reset, so the word topology is unchanged.
    Object.assign(state, {
      blockId: 0,
      cursor: 0,
      startedAt: 0,
      correctCount: 0,
      keystrokes: 0,
      dirtyWords: new Set(),
      finishedWordStats: { correct: 0, wrong: 0, skipped: 0 },
      elapsedMs: 0,
    });
    // Re-bump blockId so the current block's wordKey() entries match what
    // future markChar() calls will produce. installBlock would normally
    // increment from 0, but restartRun reuses the current chars/spans (it
    // doesn't rebuild the block), so we set it to 1 here directly.
    state.blockId = 1;
    state.recentCorrectChars = [];
    state.mode = "TYPING";
    installCaret();
    installKeyboard();
    // Setup call, not a keystroke advance — don't auto-scroll on restart.
    positionCaret(false);
    updateNextKeyHint();
    document.addEventListener("click", onTypingClick, true);
    document.addEventListener("keydown", onTypingKey, true);
    refreshHUDLayout();
    updateHUD();
    startHUDLoop();
  }

  // Restore the current block and go back to ARMED so the user can pick a new
  // paragraph with the same selected mode.
  function nextParagraph() {
    removeResults();
    restoreTarget();
    Object.assign(state, {
      target: null,
      originalHTML: null,
      chars: [],
      wordCharIndices: [],
      cursor: 0,
      startedAt: 0,
      correctCount: 0,
      keystrokes: 0,
      dirtyWords: new Set(),
      finishedWordStats: { correct: 0, wrong: 0, skipped: 0 },
      elapsedMs: 0,
    });
    state.recentCorrectChars = [];
    stopHUDLoop();
    enterArmed();
    refreshHUDLayout();
    updateHUD();
  }

  // ---------- restore ----------
  function restoreTarget() {
    if (state.target && state.originalHTML != null) {
      state.target.innerHTML = state.originalHTML;
      state.target.classList.remove("tp-target");
    }
  }
})();
