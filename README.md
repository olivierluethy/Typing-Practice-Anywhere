<div align="center">
  <img src="icons/icon128.png" alt="Typing Practice Anywhere logo" width="140" />
  <h1>Typing Practice Anywhere</h1>
  <p><b>Turn any web page into a typing test.</b><br/>A Chrome extension that lets you practice typing on real text from any site, with live WPM, error tracking and a color-coded keyboard.</p>
  <p>
    <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-blue.svg"></a>
    <img alt="JavaScript" src="https://img.shields.io/badge/JavaScript-F7DF1E?logo=javascript&logoColor=black">
    <img alt="Chrome Extension" src="https://img.shields.io/badge/Chrome-Extension-4285F4?logo=googlechrome&logoColor=white">
  </p>
</div>

---

A Chrome extension that turns any web page into a typing test. Click the T icon in your toolbar, pick a mode, hover the text you want (it glows orange), click — and start typing.

## Features

- Free or Timed (15s / 30s / 60s) modes
- Selection mode highlights what you're about to type and lets you choose a whole **paragraph** or a single **sentence** (toggle in the on-screen banner)
- Auto-advance through paragraphs so you stay in flow (paragraph selection)
- Live WPM speedometer + word-level error tracking
- Color-coded virtual keyboard with next-key hints
- Adapts to light / dark themed pages automatically
- Strips Wikipedia-style citation markers like [1] [2] so they aren't typed
- Restore the page exactly as it was with Esc

## Install (developer mode)

1. Clone or download this repo
2. Open `chrome://extensions` in Chrome
3. Enable Developer Mode (top right)
4. Click **Load unpacked** and select the project folder
5. Pin the T icon to your toolbar

The extension works fully offline. No tracking, no analytics, no network calls.

## Shortcuts

| Key | Action |
|---|---|
| Click T icon | Open mode launcher |
| Tab | Skip current word |
| Cmd + R (Mac) / Ctrl + R | Restart current run |
| Esc | Exit |

## How accuracy is calculated

Accuracy = correct characters ÷ total keystrokes × 100

Every printable keystroke counts toward the denominator. Backspace fully reverses a keystroke — if you backspace over a wrong char and re-type it correctly, both the failed attempt and its keystroke are removed from the count. Only mistakes you move past without ever correcting stay sticky.

Errors in the HUD are word-level: one typo in a word counts as one error, regardless of how many characters in it were wrong. WPM uses the gross convention: (correct characters ÷ 5) ÷ elapsed minutes.

## License

Released under the [MIT License](LICENSE) © 2026 Olivier Lüthy. You're free to use, modify and distribute this
software, including commercially, as long as the copyright notice and license are included.

## Author

Built by **Olivier Lüthy** — [GitHub](https://github.com/olivierluethy).
