# BYOS Translate

**Bring your own subscription.** Bilingual web page translation for Chrome and Edge, powered by the
Claude Code you already have, with no API key.

[한국어](README.ko.md)

Most AI page translators are paid, and their free tiers fall back to machine translation.
If you already pay for Claude, BYOS Translate shows each paragraph with Claude's translation right below it,
using your own Claude Code installation.

![A page with each paragraph followed by its Korean translation](docs/screenshot.png)

## How it works

```text
┌─────────────── Browser ───────────────┐        ┌───────── Your PC (127.0.0.1) ─────────┐
│ content.js     find and show blocks   │        │ bridge  (Node.js, no dependencies)     │
│     │ runtime messages                │  HTTP  │   POST /v1/messages (Anthropic format) │
│ background.js  batch, cache, retry ───┼───────►│   pool of pre-started `claude -p`      │
└───────────────────────────────────────┘ token  │        │ Claude Code's own sign-in     │
                                                 └────────┼───────────────────────────────┘
                                                          ▼
                                                  Anthropic (your plan)
```

- The extension finds paragraph-like blocks, translates those near the viewport in batches, and appends each
  translation under its source block. Scrolling and page updates trigger more translation.
- The bridge is a loopback HTTP server that runs the unmodified `claude` CLI in headless mode.
  It keeps a few processes started ahead of time, so a request does not wait for Claude Code to boot.

## Terms of use

- BYOS Translate never reads, stores, or forwards your Claude credentials. The bridge only runs the
  unmodified `claude` binary (`claude -p`), and sign-in stays inside Claude Code.
- Run it for yourself, on your own machine, with your own sign-in. The bridge listens on loopback only and
  requires a token. Do not expose it to a network or share it: serving other people through your plan is
  not permitted.
- Translations count against your plan's usage limits, which Anthropic sizes for ordinary individual use.
  Check your plan's terms, and your organization's policy on Team or Enterprise plans.
- Anthropic's rules for subscription sign-in are in
  [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use).

BYOS Translate is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

## Requirements

- Node.js 22 or later
- [Claude Code](https://code.claude.com/docs) installed and signed in (run `claude` once and use `/login`)
- Chrome 116+ or Microsoft Edge

## Install

```sh
git clone https://github.com/Gabriel-Hong/byos-translate.git
cd byos-translate
npm run bridge      # keep this terminal open while you translate
```

There is nothing to `npm install`. On first start the bridge creates a token, prints it, and saves it in its
config file. `npm run token` prints it again.

Load the extension:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode**, choose **Load unpacked**, and select the `extension` folder.
3. Open the extension's **Options**, paste the token, and press **연결 테스트** (test connection).

## Use

- Press **Alt+Q**, use **이 페이지 번역** in the toolbar popup, or right-click → **BYOS Translate 켜기/끄기**.
  Do it again to remove the translations.
- Choose the target language and model (Haiku, Sonnet, Opus) in the popup. Display style and batch size are
  in Options.
- Click a red failure note to retry that block.

The extension asks for the minimum: it injects its script only into a tab you invoke it on (`activeTab`),
has no content script running on every site, and keeps the bridge token in the service worker.
The UI text is currently Korean; translation works for any target language in the list.

## Use with Immersive Translate (optional)

The bridge speaks the Anthropic Messages format, so Immersive Translate's custom Claude service can use it:

- API URL: `http://127.0.0.1:18765/v1/messages`
- API key: the bridge token
- Model: `claude-haiku-5-5` or another listed model, or the custom model `haiku`

This was verified only by sending requests of the same shape to the bridge, not inside Immersive Translate.
Immersive Translate puts the page title in its system prompt, so the first request on each page starts a new
Claude Code process (4–7 s).

## Bridge configuration

The config file is `%LOCALAPPDATA%\byos-translate\config.json` on Windows,
`~/Library/Application Support/byos-translate/config.json` on macOS, and `~/.config/byos-translate/config.json`
on Linux (`BYOS_DATA_DIR` overrides the folder). Restart the bridge after editing it.

| Key | Default | Meaning |
| --- | --- | --- |
| `port` | 18765 | Loopback port (`npm run bridge -- --port 18800` overrides it once) |
| `defaultModel` | `haiku` | Model when a request names none |
| `claudeCommand` | `claude` | Claude Code executable |
| `maxConcurrent` | 4 | Requests processed at once; up to 64 more wait, beyond that 429 |
| `warmPerKey` | 2 | Pre-started processes per (model, system prompt) |
| `maxIdleProcesses` | 4 | Cap on pre-started processes (about 200 MB each) |
| `idleTtlMs` | 600000 | Idle time before a pre-started process is stopped |
| `requestTimeoutMs` | 120000 | Per-request limit; the process is killed and the request gets 504 |

### API

- `GET /health`: no token; reports only that the bridge is up.
- `POST /v1/messages`: Anthropic Messages subset. Non-streaming, exactly one user message, text only.
  Sampling fields such as `max_tokens`, `temperature`, and `thinking` are ignored because Claude Code has no
  flags for them.
- `GET /v1/models`, `GET /v1/bridge/status`: token required.

Every API route requires the token (`x-api-key` or `Authorization: Bearer`). Requests whose `Host` is not the
loopback listener are refused (DNS rebinding), and so are requests from web page origins; CORS is allowed only
for extension origins.

Each Claude Code process gets exactly one prompt and then exits, so no conversation builds up between requests.
Tools, MCP servers, hooks, settings files, and session saving are turned off, and the processes run in an empty
folder so no project `CLAUDE.md` applies.

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

## Development

```sh
npm test                 # bridge (with a fake claude) and batch protocol tests
npm run e2e:chrome       # real translation in your installed Chrome; needs the bridge running
npm run e2e:chrome -- https://en.wikipedia.org/wiki/Reverse_engineering
```

`e2e:chrome` starts your installed Chrome with a throwaway profile and installs the unmodified extension with
the CDP command `Extensions.loadUnpacked` (`--remote-debugging-pipe` and `--enable-unsafe-extension-debugging`,
because Chrome 137+ ignores `--load-extension`). It then follows the user path: toolbar action
(`Extensions.triggerAction`), popup button, translation, scrolling, and switching off. The default page is served
from `127.0.0.2`, outside the extension's host permissions, so the `activeTab` grant is exercised too.
It calls the real Claude Code and uses a little of your plan.

| Path | Contents |
| --- | --- |
| `bridge/` | `config.mjs` (config, token), `claude-runner.mjs` (process pool), `messages.mjs` (request parsing, responses), `server.mjs` (HTTP) |
| `extension/` | `content.js` (block detection, display), `background.js` (batching, cache, retry), `protocol.js` (prompt, reply parsing) |
| `test/` | Tests, `fake-claude.mjs` (stream-json stand-in for Claude Code), `fixtures/article.html` |
| `scripts/e2e-chrome.mjs` | Chrome end-to-end check |

Verified: the unit and integration tests; a bridge smoke test with the real Claude Code; Chrome 156 end-to-end
on the test page (7 runs) and Wikipedia (8 runs); Edge with a throwaway profile. Not verified automatically:
pressing the real **Alt+Q** key, because synthetic CDP key events do not reach browser shortcuts. Chrome reports
the `toggle-translation=Alt+Q` binding.

## Limitations

- Only page text is translated; links and emphasis become plain text in the translation. No PDF, video
  subtitle, image, or input box translation.
- The translation cache lives in service worker memory and is lost when the browser stops the worker.
- Only the top frame is translated, and Shadow DOM content is skipped.
- There is no "always translate this site"; press Alt+Q on each page.
- Translations appear when a whole batch finishes, not while it is being generated.

## License

[MIT](LICENSE)
