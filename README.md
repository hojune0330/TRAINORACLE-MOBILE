# TrainOracle 모바일 후보 빌드

원본 `hojune0330/TRAINORACLE`을 수정하지 않고 고정 소스를 앱 안에 번들링하는 독립 Capacitor 패키징 저장소입니다. 원격 웹사이트만 여는 앱이 아닙니다.

- 원본 고정 커밋: `b744917a2add6b5aff2f69442fd54a90e1522ed9` (`release-config.json`이 빌드 기준)
- 출시 식별자: `io.trainoracle.app`, `TrainOracle`
- 테스트 식별자: `io.trainoracle.app.debug`, `TrainOracle Test`
- 후보 버전: 1.0.0 (2)
- Android: min 26, compile/target 36. iOS: 최소 16.0, 빌드 Xcode/iOS SDK 26 이상.
- 계정·OAuth·동기화·공유·백엔드·원격 게임·Garmin 자동 연동 OFF. 센서/HealthKit/Health Connect 권한 없음.
- 원격 `server.url`·라이브 업데이트·서명·스토어 업로드 없음.

## 결과물의 범위

### 2026-10-17 확인 결과

- [최종 후보 실행 38928117433](https://github.com/hojune0330/TRAINORACLE-MOBILE/actions/runs/38928117433): 웹 묶음·Android·iOS 모두 성공. 원본 SHA는 위 고정 커밋과 같다.
- Android 에뮬레이터: 실제 WebView 저장·동일 APK 재설치 후 유지, 홈/예시 화면, 시스템 선택기를 통한 합성 빈 일지 JSON의 실제 저장 바이트까지 확인했다.
- iOS 시뮬레이터: 실제 WebKit의 암호화·잠금·로컬 저장과 재설치 후 유지 확인. 일반 사용자 기기나 실제 계정 자료를 사용한 검증은 아니다.
- 이 결과는 **1.0.0 (2) 테스트 후보**이며, 서명된 정식 배포·스토어 등록·최소 OS 기기 검증을 완료했다는 뜻은 아니다. 임시 Actions 산출물은 1일 보관이며 별도 보관한 파일과 구분한다.

2026-10-17: 웹과 같은 원본으로 후보를 갱신한다. 체크아웃과 빌드 검증은
`release-config.json`의 단일 SHA를 사용한다. 설정 변경·GitHub 반영과 실제 네이티브
빌드 성공은 별개다. 기존 `*-artifact-*` 워크플로는 고정된 과거 산출물 검증용이며
새 후보가 검증됐다는 증거로 사용하지 않는다. 브랜드 자산의 이전 원본 출처도 보존한다.

`Mobile candidate` 워크플로는 수동으로만 실행됩니다. 공개 저장소의 표준 Ubuntu/macOS 러너를 사용합니다.

- Android 테스트 APK: `.debug` 별도 앱. 정식 앱과 서명/저장소 충돌을 피합니다.
- Android release AAB: **서명 없는 후보**, Play 업로드 가능본이 아닙니다.
- iOS ZIP: **시뮬레이터용 `.app`**, App Store용 IPA가 아닙니다.
- 실제 기기/시뮬레이터 캡처와 boolean-only 진단은 성공한 워크플로 결과로 판단합니다. 단위검사만으로 네이티브 동작을 검증했다고 주장하지 않습니다.
- 원본 전체 회귀 테스트는 별도 게이트이며, 이 모바일 빌드가 전체 회귀 통과를 의미하지 않습니다. OS 16/Android 8 등 최소 버전 기기 QA도 별도로 필요합니다.

## 원본과 사용자 기록 보존

전체 원본 트리의 전후 해시, Git HEAD·tracked 상태, 생성 파일 해시를 확인합니다. 예외는 루트 `.git`과 정확한 `app/node_modules` 설치 출력뿐입니다. 원본의 `dist` 또는 다른 파일을 삭제하거나 수정하지 않습니다.

웹 앱, 테스트 앱, 정식 앱은 서로 다른 저장소입니다. **웹 기록은 자동 이전되지 않습니다.** 기존 JSON 경로가 모든 계획·메모·키까지 완전 복원한다고 보장하지 않습니다. 설치·업데이트 검사는 전용 새 CI 샌드박스에서만 수행하며 기존 사용자 원본 저장소를 읽거나 지우지 않습니다.

iOS 백업 제외 설정은 새/빈 네이티브 저장소 디렉터리의 초기 준비로 제한합니다. 내용 있는 기존 저장소의 메타데이터를 반복 수정하지 않으며, 모든 OS 백업/전송 경로가 차단된다고 보장하지 않습니다.

## 네이티브 파일 처리

기존 JSON/PNG 내보내기 Blob을 사용자 입력 후 5초·1회용 허가로 캡처합니다. 원본 bytes를 32MiB 한도 내에서 Android 시스템 문서 생성 또는 iOS 문서 내보내기 선택기로 전달합니다. 사용자 선택 없이 외부 저장 위치를 확정하지 않습니다. iOS 선택기 준비용 보호 임시 파일은 취소/완료 시 정리합니다.

내장 법률 문서는 로컬 전용 뷰어, HTTPS/mailto 외부 링크는 실제 사용자 입력 후 OS 앱으로 엽니다. 외부 HTTP/WebSocket은 웹 CSP로 차단하며, 실제 최종 데이터 흐름·SDK 검토 없이 스토어의 '수집 없음' 신고를 확정하지 않습니다.

## 재현

소스 빌드는 Linux Node **24.19.0**에서만 실행합니다. 알려진 Windows Vite 경로를 재실행하지 않습니다.

```text
npm ci --ignore-scripts --no-audit --no-fund
node scripts/generate-assets.mjs
npm test
node scripts/prepare-release.mjs --source ../upstream
node scripts/generate-native.mjs --platform android
node scripts/generate-native.mjs --platform ios
```

플랫폼 디렉터리와 `www`는 새 출력이어야 합니다. 기존 디렉터리를 자동 삭제·복구하는 기능은 없습니다.

## 등록 전 보류 항목

회사명 표시 및 정확한 법적 사업 정보·D-U-N-S·개발자 계정 자격·공개 연락처·등록비 승인·서명 자격·심사 자료를 확인한 뒤 별도로 등록합니다. 개인사업자를 법인으로 잘못 신고하거나 개인 이름을 회사명으로 바꾸는 우회는 하지 않습니다. Apple 첫 앱의 Developer Name은 확정 전 생성하지 않습니다.

비밀값·서명키·인증서·프로비저닝·인증 토큰·쿠키를 이 저장소나 빌드 아티팩트에 넣지 않습니다. 나중에 필요하면 Vault/Secret 참조만 사용합니다.

원본 브랜드와 콘텐츠는 소유자의 자료이며, 배포되는 외부 런타임 라이선스는 기존 고지와 모바일 추가 고지를 보존합니다.
