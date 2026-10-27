# BYOS Translate

**Bring your own subscription.** 유료 번역기나 API 키 대신, 이미 구독 중인 AI(Claude, ChatGPT, Gemini)로
웹 페이지를 원문·번역 대조로 보여 주는 Chrome/Edge 확장입니다.

[English](README.md)

![각 문단 아래에 한국어 번역이 붙은 페이지](docs/screenshot.png)

확장이 화면에 보이는 문단을 로컬 브리지로 보냅니다. 브리지는 필요할 때 브라우저가 네이티브 메시징으로
직접 실행하며, 각 회사의 공식 CLI를 내 로그인으로 실행해 번역하고 각 문단 아래에 표시합니다.

## 이용 조건

- BYOS Translate는 자격 증명을 읽거나 저장하지 않습니다. 수정하지 않은 `claude`, `codex`, `gemini` CLI를
  실행할 뿐이며, 로그인은 각 도구 안에서만 처리됩니다.
- 본인이 자기 PC와 자기 로그인으로만 사용하세요. 브리지는 네트워크 포트를 열지 않고 이 확장에만 응답합니다.
  내 구독으로 다른 사람의 요청을 처리하는 것은 허용되지 않습니다.
- 번역 사용량은 구독 사용 한도에 포함되며, 각 제공자의 약관이 적용됩니다. Claude는 Anthropic의
  [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use)를
  참고하세요.

BYOS Translate는 Anthropic, OpenAI, Google과 관련이 없으며 이들의 보증을 받지 않았습니다.
Claude, ChatGPT, Codex, Gemini는 각 소유자의 상표입니다.

## 요구 사항

- Node.js 22 이상
- 다음 중 하나 이상 설치 및 로그인:
  [Claude Code](https://code.claude.com/docs)(`claude`), [Codex CLI](https://github.com/openai/codex)(`codex`),
  [Gemini CLI](https://github.com/google-gemini/gemini-cli)(`gemini`)
- Chrome 116 이상 또는 Microsoft Edge

Codex와 Gemini CLI 지원은 각 도구의 문서화된 헤드리스 모드를 따르며 가짜 CLI로 테스트했습니다.
실제 도구로는 아직 실행해 보지 않았습니다.

## 설치

```sh
git clone https://github.com/Gabriel-Hong/byos-translate.git
cd byos-translate
npm run install-host   # 한 번만: 브리지를 Chrome·Edge에 사용자 단위로 등록
```

그다음 `chrome://extensions`(또는 `edge://extensions`)에서 **개발자 모드**를 켜고, **압축해제된 확장 프로그램을
로드합니다**로 `extension` 폴더를 선택합니다. 따로 켜 둘 것은 없습니다. 번역할 때 브라우저가 브리지를 실행합니다.

폴더를 옮기면 `npm run install-host`를 다시 실행하세요. `npm run uninstall-host`로 등록을 지울 수 있습니다.
선택 설정(`config.json`)과 브리지 로그(`native-host.log`)는 `%LOCALAPPDATA%\byos-translate`(Windows),
`~/Library/Application Support/byos-translate`(macOS), `~/.config/byos-translate`(Linux)에 있습니다.

## 사용

- **Alt+Q**, 툴바 팝업, 또는 우클릭 메뉴 **BYOS Translate 켜기/끄기**로 켭니다. 한 번 더 하면 번역이 사라집니다.
- 팝업에서 번역 엔진(Claude, OpenAI, Google), 모델, 번역 언어를 고릅니다. Claude 모델은 항상 각 계열의 최신 모델로
  연결되며, 목록에 없는 모델은 "직접 입력…"으로 지정합니다.

## 성능

Windows 11, Claude Code 2.1.310, Haiku에서 측정(Codex와 Gemini CLI는 요청마다 실행하며 아직 측정하지 않음):

| 시나리오 | 결과 |
| --- | --- |
| 새 프로세스를 띄우는 요청 | 4.2 s |
| 미리 띄운 프로세스, 짧은 문장(6회) | 1.25~1.50 s |
| 미리 띄운 프로세스, 위키백과 문단 8개(3회) | 첫 토큰 0.8~1.3 s, 완료 3.2~3.8 s(약 260 tokens/s) |
| 요청당 고정 입력 | Claude Code 기본 컨텍스트 약 700토큰(프롬프트 캐시로 재사용) |
| 미리 띄운 프로세스 메모리 | 약 210 MB(작업 집합) |
| 테스트 페이지 첫 화면 13블록, Claude Code가 이미 떠 있을 때(Chrome, 7회) | 3.5~5.0 s, 실패 0 |
| 위키백과 첫 화면 12블록, Claude Code가 이미 떠 있을 때(Chrome, 8회) | 7.4~9.8 s, 실패 0 |
| 브라우저가 브리지를 막 실행했을 때 첫 화면(Chrome·Edge, 4회) | 10.9~15.5 s, 실패 0 |

`haiku` 별칭은 최신 Haiku로 해석됩니다(측정 당시 `claude-haiku-5-5`). 첫 화면 시간은 가장 긴 배치의 생성
시간이 대부분이고, 브리지가 막 실행됐거나 10분 동안 쓰이지 않았다면 Claude Code 기동 시간이 더해집니다.
팝업을 열면 미리 기동을 시작합니다. 옵션에서 배치를 줄이면 병렬 요청이 늘어 빨라지지만 프로세스와 메모리가
더 필요합니다.

## 한계

- 페이지 텍스트만 번역합니다. PDF, 영상 자막, 이미지, 입력창은 번역하지 않습니다.
- 페이지마다 직접 켜야 합니다. "이 사이트는 항상 번역" 기능은 없습니다.
- 최상위 프레임만 번역합니다.

## 개발

```sh
npm test             # 가짜 claude를 쓰는 단위·통합 테스트
npm run e2e:chrome   # 설치된 Chrome으로 실제 번역 E2E, npm run install-host 필요
npm run try:chrome   # 확장을 넣은 임시 프로필 Chrome을 열어 직접 테스트
```

## 라이선스

[MIT](LICENSE)
