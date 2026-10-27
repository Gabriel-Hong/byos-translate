# BYOS Translate

**Bring your own subscription.** Bilingual web page translation for Chrome and Edge that uses the Claude Code
you already pay for, instead of a paid translator or an API key.

[한국어](README.ko.md)

![A page with each paragraph followed by its Korean translation](docs/screenshot.png)

The extension sends the paragraphs on screen to a local bridge, which translates them with pre-started
`claude -p` processes and shows each translation under its paragraph.

## Terms of use

- BYOS Translate never reads or stores your Claude credentials. It only runs the unmodified `claude` CLI,
  and sign-in stays inside Claude Code.
- Use it yourself, on your own machine. The bridge listens on 127.0.0.1 and requires a token; do not expose or
  share it, because serving other people through your plan is not permitted.
- Translations count against your plan's usage limits. See Anthropic's
  [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

BYOS Translate is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Requirements

- Node.js 22 or later
- [Claude Code](https://code.claude.com/docs) installed and signed in
- Chrome 116+ or Microsoft Edge

## Install

```sh
git clone https://github.com/Gabriel-Hong/byos-translate.git
cd byos-translate
npm run bridge      # keep this terminal open while you translate
```

The bridge prints a token on first start; `npm run token` shows it again.

1. Open `chrome://extensions` (or `edge://extensions`), turn on **Developer mode**, and **Load unpacked** the
   `extension` folder.
2. In the extension's **Options**, paste the token and press **연결 테스트** (test connection).

Settings such as the port live in `config.json` under `%LOCALAPPDATA%\byos-translate` (Windows),
`~/Library/Application Support/byos-translate` (macOS), or `~/.config/byos-translate` (Linux).

## Use

- Press **Alt+Q**, use the toolbar popup, or right-click → **BYOS Translate 켜기/끄기**. Repeat to remove the
  translations.
- Pick the target language and model (Haiku, Sonnet, Opus) in the popup.
- The UI is in Korean for now.

## Performance

Measured on Windows 11 with Claude Code 2.1.310 and Haiku:

| Scenario | Result |
| --- | --- |
| Request that starts a new process | 4.2 s |
| Request to a pre-started process (short sentence, 6 runs) | 1.25–1.50 s |
| Pre-started process, 8 Wikipedia paragraphs (3 runs) | first token 0.8–1.3 s, all done 3.2–3.8 s (~260 tokens/s) |
| Fixed input per request | ~700 tokens of Claude Code context, reused through the prompt cache |
| Memory per pre-started process | ~210 MB working set |
| First screen of a test page, 13 blocks (Chrome, 7 runs) | 3.5–5.0 s, no failures |
| First screen of a Wikipedia article, 12 blocks (Chrome, 8 runs) | 7.4–9.8 s, no failures |

The `haiku` alias resolves to the latest Haiku (`claude-haiku-5-5` when measured). The first screen is
dominated by generating the longest batch; smaller batches in Options run more requests in parallel at the cost
of more processes and memory.

## Limitations

- Page text only: no PDF, video subtitles, images, or input boxes.
- Turn it on per page; there is no "always translate this site".
- Only the top frame is translated.

## Development

```sh
npm test             # unit and integration tests with a fake claude
npm run e2e:chrome   # end-to-end in your installed Chrome; needs the bridge running
```

## License

[MIT](LICENSE)
