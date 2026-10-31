# 건강 연동 후속 구현: 지원 상태·만료 재조회·실행 검증

## 기준과 운영 경계
- 모바일 기준 커밋: `bd6fe9573fda52274af0310dde56552ceb15e58d`, 초안 PR 1.
- 기존 CI 40868865623 성공은 그 커밋의 증거이며 이 후속 변경의 실행 성공이 아니다.
- 계정 OFF, 기본 건강 미리보기 OFF, 읽기 전용 명시적 후보, 서명·스토어 업로드 OFF를 유지한다. 원본 앱 source pin·사용자 기록·기존 브리지 ingress/TTL은 변경하지 않는다.

## 구현한 변경
1. 수동 `기기 지원·권한 상태 확인` 버튼. 애플의 지원 여부와 읽기 권한 unknown, Android의 Health Connect 지원·업데이트 필요·운동 읽기 권한을 구분한다. 지원 상태만 확인하며 권한 창 또는 운동 조회를 자동 호출하지 않는다.
2. Android의 90초 네이티브 컨텍스트 만료 뒤 재조회가 응답 없이 끝나던 경계를 보완한다. 매 수동 건강 동작 직전에 원문서에 새 컨텍스트를 발급하고 기존 TTL·stale 결과 차단은 유지한다.
3. iOS 운동 시작·종료 시각 직렬화에 소수초를 포함한다. 제공 운동시간과 벽시계 경과시간이 같다고 강제하지 않는다. 소수초 DTO의 JS 정규화 시험과 Swift 소스 계약 시험을 별도로 둔다. 실제 Swift 직렬화 실행 증거로 확대하지 않는다.
4. 기존 Android 실제 runtime 단계에 상태 전용 검사를 추가한다. immutable web receipt와 source-bound/account-OFF config를 확인하고, 같은 CI 소유 emulator/앱 PID의 실제 WebView에 연결한다. 최초 실행 및 reload 후 상태 버튼 응답만 확인한다. 권한 요청·운동 조회·사용자 저장소 조작을 하지 않는다. OFF인 경우 건강 채널에 연결하지 않고 검사 미실행을 명시한다.

## 검증
- Windows Node 26.5.0의 선택된 건강 관련·문서 어댑터·Android runtime 참조 시험 292건 통과, 실패·취소·생략 0. 전체 source CI 성공이 아니다.
- 새 runtime 검사의 단위시험은 합성 UI 참조 검사다. 실제 WebView/플러그인 상태 왕복은 새 커밋의 CI 결과와 `native-android-health-status.json`에서 별도로 확인한다.
- 전체 래퍼 시험을 의존성 설치 없이 시도했을 때 pngjs·Capacitor CLI 템플릿 부재와 로컬 자식 프로세스 실행 오류가 있었다. 이를 테스트 삭제·기준 완화로 해결하지 않았다. 잠긴 의존성이 설치되는 기존 CI에서 전체 npm test와 빌드를 다시 실행해야 한다.
- 첫 정적 검토에서 컨텍스트 만료·소수초 및 실제 runtime 공백을 발견했다. 두 결함 수정과 상태 점검 추가분의 독립 정적 재검토에서는 blocker가 발견되지 않았다. 정적 검토는 실기기·권한·자료 수신 성공이 아니다.

## 공식 연동 방향
- 애플: iPhone의 HealthKit 운동 읽기. 빈 결과나 권한 요청 완료를 읽기 권한 허용/거절의 확정 근거로 쓰지 않는다.
  https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data
- 삼성: Galaxy Watch → 휴대폰 Samsung Health → Health Connect → TrainOracle. 원본 앱이 실제 공유한 자료만 대상이며 Watch→휴대폰 동기화 시차가 있다.
  https://developer.samsung.com/health/health-connect-faq.html
- 거리·심박·경로 등 추가 유형은 별도 권한과 정확한 출처·시간 결합을 구현한 뒤 추가한다. 현재 Android 운동세션 경과시간을 이동시간으로 표시하거나 미제공 거리를 0으로 바꾸지 않는다.

## 아직 완료하지 않은 것
- [blocked] 실제 iPhone/Android 휴대폰의 OS 권한 및 본인 운동기록 1건 이상 왕복: 지원 기기에서 사용자의 명시적 권한 동의가 필요하다. 테스트 앱은 기존 정식 앱과 다른 ID를 유지한다.
- 실제 iOS WKWebView의 건강 상태·권한 반환·조회 및 lifecycle 통합 검증. simulator 빌드나 Swift 소스 검사로 대체하지 않는다.
- 일지 채택: 출처별 ID·중복·수정/삭제·시간대·사용자 명시적 확인·취소/철회·계정 세대/소유권을 포함하는 별도 ingestion 계약과 UI가 필요하다. 기존 파일 가져오기에 건강 DTO를 가짜 파일로 넣지 않는다.
- COROS/WHOOP 서버 후보 PR 373: 실제 암호화 DB adapter·인증 HTTP endpoint·사용자 확인 inbox·제공자 OAuth 왕복과 전체 원본 CI 수리는 별도 미완료다.
- Garmin은 Starter 신청 접수와 API 승인이 다르며 승인 근거 없이 활성화하지 않는다.
- 공개 정책·건강 앱 신고·개발자 계정 자격·서명·스토어 제출은 별도 검토/승인 전까지 보류한다.
