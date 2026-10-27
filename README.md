# BYOS Translate

**Bring your own subscription.** Bilingual web page translation for Chrome and Edge that uses the AI
subscription you already pay for (Claude, ChatGPT or Gemini) instead of a paid translator or an API key.

[한국어](README.ko.md)

![A page with each paragraph followed by its Korean translation](docs/screenshot.png)

The extension sends the paragraphs on screen to a local bridge, which the browser starts on demand through
native messaging. The bridge runs the provider's official command-line tool with your own sign-in, and each
translation appears under its paragraph.

## Terms of use

- BYOS Translate never reads or stores your credentials. It only runs the unmodified `claude`, `codex` or
  `gemini` CLI, and sign-in stays inside that tool.
- Use it yourself, on your own machine and sign-in. The bridge has no network port and answers only this
  extension; serving other people through your plan is not permitted.
- Translations count against your plan's usage limits, and each provider's terms apply. For Claude, see
  Anthropic's [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

BYOS Translate is not affiliated with or endorsed by Anthropic, OpenAI or Google. Claude, ChatGPT, Codex and
Gemini are trademarks of their respective owners.

## Requirements

- Node.js 22 or later
- At least one of these, installed and signed in:
  [Claude Code](https://code.claude.com/docs) (`claude`), [Codex CLI](https://github.com/openai/codex) (`codex`),
  [Gemini CLI](https://github.com/google-gemini/gemini-cli) (`gemini`)
- Chrome 116+ or Microsoft Edge

Codex and Gemini CLI support follows their documented headless modes and is tested with stand-ins; it has not
yet been run against the real tools.

## Install

```sh
git clone https://github.com/Gabriel-Hong/byos-translate.git
cd byos-translate
npm run install-host   # once: registers the bridge with Chrome and Edge for your user
```

Then open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, and **Load unpacked** the
`extension` folder. Nothing needs to keep running; the browser starts the bridge when you translate.

Run `npm run install-host` again if you move the folder; `npm run uninstall-host` removes the registration.
Optional settings (`config.json`) and the bridge log (`native-host.log`) are in `%LOCALAPPDATA%\byos-translate`
(Windows), `~/Library/Application Support/byos-translate` (macOS), or `~/.config/byos-translate` (Linux).

## Use

- Press **Alt+Q**, use the toolbar popup, or right-click → **BYOS Translate 켜기/끄기**. Repeat to remove the
  translations.
- Pick the engine (Claude, OpenAI or Google), model and target language in the popup. Leave the model empty
  for the provider's default.
- The UI is in Korean for now.

## Performance

Measured on Windows 11 with Claude Code 2.1.310 and Haiku (Codex and Gemini CLI start per request and have not
been measured):

| Scenario | Result |
| --- | --- |
| Request that starts a new process | 4.2 s |
| Request to a pre-started process (short sentence, 6 runs) | 1.25–1.50 s |
| Pre-started process, 8 Wikipedia paragraphs (3 runs) | first token 0.8–1.3 s, all done 3.2–3.8 s (~260 tokens/s) |
| Fixed input per request | ~700 tokens of Claude Code context, reused through the prompt cache |
| Memory per pre-started process | ~210 MB working set |
| First screen of a test page, 13 blocks, Claude Code already started (Chrome, 7 runs) | 3.5–5.0 s, no failures |
| First screen of a Wikipedia article, 12 blocks, Claude Code already started (Chrome, 8 runs) | 7.4–9.8 s, no failures |
| First screen right after the browser starts the bridge (Chrome and Edge, 4 runs) | 10.9–15.5 s, no failures |

The `haiku` alias resolves to the latest Haiku (`claude-haiku-5-5` when measured). The first screen is
dominated by generating the longest batch, plus starting Claude Code when the bridge has just started or sat
idle for 10 minutes; opening the popup starts it ahead of time. Smaller batches in Options run more requests in
parallel at the cost of more processes and memory.

## Limitations

- Page text only: no PDF, video subtitles, images, or input boxes.
- Turn it on per page; there is no "always translate this site".
- Only the top frame is translated.

## Development

```sh
npm test             # unit and integration tests with a fake claude
npm run e2e:chrome   # end-to-end in your installed Chrome; needs npm run install-host
npm run try:chrome   # opens a temporary Chrome profile with the extension for manual testing
```

## License

[MIT](LICENSE)
