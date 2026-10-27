# BYOS Translate

**Bring your own subscription.** 이미 쓰고 있는 Claude Code로 웹 페이지를 원문·번역 대조로 보여 주는
Chrome/Edge 확장입니다. API 키가 필요 없습니다.

[English](README.md)

AI 페이지 번역 확장은 대부분 유료이고, 무료 등급은 기계번역입니다. Claude를 이미 구독하고 있다면
BYOS Translate가 내 PC의 Claude Code로 각 문단 아래에 Claude 번역을 붙여 줍니다.

![각 문단 아래에 한국어 번역이 붙은 페이지](docs/screenshot.png)

## 동작 방식

```text
┌─────────────── 브라우저 ───────────────┐        ┌────────── 내 PC (127.0.0.1) ──────────┐
│ content.js     블록 탐지·표시          │        │ bridge  (Node.js, 의존성 없음)          │
│     │ runtime 메시지                    │  HTTP  │   POST /v1/messages (Anthropic 형식)    │
│ background.js  배치·캐시·재시도 ───────┼───────►│   미리 띄운 `claude -p` 프로세스 풀      │
└────────────────────────────────────────┘ 토큰   │        │ Claude Code 자체 로그인         │
                                                  └────────┼────────────────────────────────┘
                                                           ▼
                                                   Anthropic (내 구독)
```

- 확장은 문단 같은 블록을 찾아 화면 근처에 온 것만 묶어서 번역하고, 원문 블록 아래에 번역을 붙입니다.
  스크롤하거나 페이지 내용이 바뀌면 이어서 번역합니다.
- 브리지는 루프백 HTTP 서버로, 수정하지 않은 `claude` CLI를 헤드리스 모드로 실행합니다.
  프로세스를 몇 개 미리 띄워 두므로 요청마다 Claude Code 기동을 기다리지 않습니다.

## 이용 조건

- BYOS Translate는 Claude 자격 증명을 읽거나 저장하거나 전달하지 않습니다. 브리지는 수정하지 않은
  `claude` 바이너리(`claude -p`)를 실행할 뿐이고, 로그인은 Claude Code 안에서만 처리됩니다.
- 내 PC에서, 내 로그인으로, 나만 사용하세요. 브리지는 루프백에서만 듣고 토큰을 요구합니다.
  네트워크에 노출하거나 공유하지 마세요. 내 구독으로 다른 사람의 요청을 처리하는 것은 허용되지 않습니다.
- 번역 사용량은 구독 사용 한도에 포함되며, Anthropic은 이 한도를 일반적인 개인 사용 기준으로 정합니다.
  플랜 약관과, Team/Enterprise 플랜이면 소속 조직의 정책도 확인하세요.
- 구독 로그인 관련 규칙: [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)

BYOS Translate는 Anthropic과 관련이 없으며 Anthropic의 보증을 받지 않았습니다.
Claude와 Claude Code는 Anthropic의 상표입니다.

## 요구 사항

- Node.js 22 이상
- [Claude Code](https://code.claude.com/docs) 설치 및 로그인(`claude`를 한 번 실행해 `/login`)
- Chrome 116 이상 또는 Microsoft Edge

## 설치

```sh
git clone https://github.com/Gabriel-Hong/byos-translate.git
cd byos-translate
npm run bridge      # 번역하는 동안 이 터미널을 열어 두세요
```

`npm install`은 필요 없습니다. 브리지를 처음 실행하면 토큰을 만들어 화면에 출력하고 설정 파일에 저장합니다.
`npm run token`으로 다시 볼 수 있습니다.

확장 로드:

1. `chrome://extensions`(또는 `edge://extensions`)를 엽니다.
2. **개발자 모드**를 켜고 **압축해제된 확장 프로그램을 로드합니다**를 누른 뒤 `extension` 폴더를 선택합니다.
3. 확장 **옵션**에서 토큰을 붙여 넣고 **연결 테스트**를 누릅니다.

## 사용

- **Alt+Q**, 툴바 팝업의 **이 페이지 번역**, 또는 우클릭 메뉴 **BYOS Translate 켜기/끄기**로 켭니다.
  다시 하면 번역을 지웁니다.
- 팝업에서 번역 언어와 모델(Haiku, Sonnet, Opus)을 고르고, 표시 방식과 배치 크기는 옵션에서 바꿉니다.
- 빨간 실패 안내를 클릭하면 그 블록을 다시 번역합니다.

권한은 최소한으로 둡니다. 사용자가 실행한 탭에만 `activeTab`으로 스크립트를 넣고, 모든 사이트에 상주하는
콘텐츠 스크립트는 없으며, 브리지 토큰은 서비스 워커만 사용합니다.

## Immersive Translate와 함께 쓰기 (선택)

브리지가 Anthropic Messages 형식을 쓰므로, Immersive Translate의 사용자 지정 Claude 서비스에 연결할 수 있습니다.

- API 주소: `http://127.0.0.1:18765/v1/messages`
- API Key: 브리지 토큰
- 모델: `claude-haiku-5-5` 등 목록의 모델, 또는 사용자 지정 모델 `haiku`

같은 모양의 요청을 브리지에 보내는 방식으로만 확인했고, Immersive Translate 안에서는 시험하지 않았습니다.
Immersive Translate는 시스템 프롬프트에 페이지 제목을 넣기 때문에, 페이지마다 첫 요청은 Claude Code
프로세스를 새로 띄웁니다(4~7초).

## 브리지 설정

설정 파일은 Windows `%LOCALAPPDATA%\byos-translate\config.json`, macOS
`~/Library/Application Support/byos-translate/config.json`, Linux `~/.config/byos-translate/config.json`입니다
(`BYOS_DATA_DIR`로 폴더 변경 가능). 수정한 뒤에는 브리지를 다시 시작하세요.

| 키 | 기본값 | 설명 |
| --- | --- | --- |
| `port` | 18765 | 루프백 포트(`npm run bridge -- --port 18800`으로 일시 변경) |
| `defaultModel` | `haiku` | 요청에 모델이 없을 때 쓰는 모델 |
| `claudeCommand` | `claude` | Claude Code 실행 파일 |
| `maxConcurrent` | 4 | 동시 처리 요청 수. 초과분 64개까지 대기, 그 이상은 429 |
| `warmPerKey` | 2 | (모델, 시스템 프롬프트) 조합별로 미리 띄울 프로세스 수 |
| `maxIdleProcesses` | 4 | 미리 띄운 프로세스 총 상한(프로세스당 약 200 MB) |
| `idleTtlMs` | 600000 | 쓰이지 않은 프로세스를 종료하기까지의 시간 |
| `requestTimeoutMs` | 120000 | 요청 제한 시간. 넘으면 프로세스를 종료하고 504 |

### API

- `GET /health`: 토큰 없이 브리지 동작 여부만 반환
- `POST /v1/messages`: Anthropic Messages 부분집합. 비스트리밍, user 메시지 1개, 텍스트만.
  `max_tokens`, `temperature`, `thinking` 같은 샘플링 필드는 Claude Code에 전달할 방법이 없어 무시합니다.
- `GET /v1/models`, `GET /v1/bridge/status`: 토큰 필요

모든 API는 토큰(`x-api-key` 또는 `Authorization: Bearer`)을 요구합니다. `Host`가 루프백 주소가 아닌 요청
(DNS 리바인딩)과 웹 페이지 Origin의 요청은 거부하고, CORS는 확장 Origin에만 허용합니다.

Claude Code 프로세스 하나는 프롬프트 하나만 처리하고 종료하므로 요청 사이에 대화가 쌓이지 않습니다.
도구, MCP 서버, 훅, 설정 파일, 세션 저장은 모두 끄고, 빈 폴더에서 실행해 프로젝트 `CLAUDE.md`가 섞이지 않습니다.

## 성능

Windows 11, Claude Code 2.1.310, Haiku에서 측정:

| 시나리오 | 결과 |
| --- | --- |
| 새 프로세스를 띄우는 요청 | 4.2 s |
| 미리 띄운 프로세스, 짧은 문장(6회) | 1.25~1.50 s |
| 미리 띄운 프로세스, 위키백과 문단 8개(3회) | 첫 토큰 0.8~1.3 s, 완료 3.2~3.8 s(약 260 tokens/s) |
| 요청당 고정 입력 | Claude Code 기본 컨텍스트 약 700토큰(프롬프트 캐시로 재사용) |
| 미리 띄운 프로세스 메모리 | 약 210 MB(작업 집합) |
| 테스트 페이지 첫 화면 13블록(Chrome, 7회) | 3.5~5.0 s, 실패 0 |
| 위키백과 첫 화면 12블록(Chrome, 8회) | 7.4~9.8 s, 실패 0 |

`haiku` 별칭은 최신 Haiku로 해석됩니다(측정 당시 `claude-haiku-5-5`). 첫 화면 시간은 가장 긴 배치의
생성 시간이 대부분입니다. 옵션에서 배치를 줄이면 병렬 요청이 늘어 빨라지지만 프로세스와 메모리가 더 필요합니다.

## 개발

```sh
npm test                 # 브리지(가짜 claude 사용)와 배치 프로토콜 테스트
npm run e2e:chrome       # 설치된 Chrome으로 실제 번역 E2E, 브리지 실행 필요
npm run e2e:chrome -- https://en.wikipedia.org/wiki/Reverse_engineering
```

`e2e:chrome`은 설치된 Chrome을 임시 프로필로 띄우고, 수정하지 않은 확장을 CDP `Extensions.loadUnpacked`로
설치합니다(`--remote-debugging-pipe`, `--enable-unsafe-extension-debugging`. Chrome 137부터
`--load-extension`이 무시되기 때문). 이어서 툴바 액션(`Extensions.triggerAction`) → 팝업 버튼 → 번역 →
스크롤 → 끄기 순서로 사용자 경로를 실행합니다. 기본 테스트 페이지는 확장 호스트 권한 밖인 `127.0.0.2`에서
서빙하므로 `activeTab` 부여 경로도 검증됩니다. 실제 Claude Code를 호출하므로 구독 사용량을 조금 씁니다.

| 경로 | 내용 |
| --- | --- |
| `bridge/` | `config.mjs`(설정·토큰), `claude-runner.mjs`(프로세스 풀), `messages.mjs`(요청 파싱·응답), `server.mjs`(HTTP) |
| `extension/` | `content.js`(블록 탐지·표시), `background.js`(배치·캐시·재시도), `protocol.js`(프롬프트·응답 파싱) |
| `test/` | 테스트, `fake-claude.mjs`(stream-json을 흉내 내는 가짜 Claude Code), `fixtures/article.html` |
| `scripts/e2e-chrome.mjs` | Chrome E2E |

검증한 것: 단위·통합 테스트, 실제 Claude Code를 쓰는 브리지 스모크 테스트, Chrome 156 E2E(테스트 페이지 7회,
위키백과 8회), 임시 프로필 Edge 확인. 자동으로 검증하지 못한 것: 실제 **Alt+Q** 키 입력. CDP 합성 키 이벤트는
브라우저 단축키로 전달되지 않습니다. Chrome에 `toggle-translation=Alt+Q` 바인딩이 등록된 것은 확인했습니다.

## 한계

- 페이지 텍스트만 번역합니다. 링크·강조 서식은 번역문에서 일반 텍스트가 되며, PDF·영상 자막·이미지·입력창
  번역은 없습니다.
- 번역 캐시는 서비스 워커 메모리에만 있어 브라우저가 워커를 멈추면 사라집니다.
- 최상위 프레임만 번역하고 Shadow DOM 내부는 건너뜁니다.
- "이 사이트는 항상 번역" 기능이 없어 페이지마다 Alt+Q를 눌러야 합니다.
- 배치 전체가 끝나야 번역이 표시됩니다(생성 중 스트리밍 표시 없음).

## 라이선스

[MIT](LICENSE)
