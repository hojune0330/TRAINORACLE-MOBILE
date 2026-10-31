# 계정 OFF 전용 독립 건강 기록 미리보기 후보

## 상태와 사용 금지 경계

- 새 `web-adapter/offline-health-preview.js`는 bootstrap에 등록하지 않았다. 설치 함수 기본값 `enabled=false`이고 모듈 최상위 DOM/lifecycle/native 호출은 없다. OFF 설치는 env조차 읽지 않는다.
- 계정 기능이 컴파일 단계에서 제외된 **오프라인 account-OFF 후보에서만** 검토할 코드다. 로그인·계정·일지 API 통합 완료가 아니다. 공개 enable, 운영 배포, 건강 DB 접근, 실제 로그인, CI 또는 기존 파일 변경을 하지 않았다.
- `enabled:true`는 기능 토글일 뿐 계정-OFF 증명이나 네이티브 보안 경계가 아니다. 계정이 켜진 빌드에서 사용하면 안 된다. 부모 작업이 빌드 경계와 bootstrap 등록을 별도로 검수해야 한다. 이 모듈은 계정 상태를 조회하거나 저장하지 않는다.
- JS flag로 네이티브 consent/통합 검수 flag를 우회하지 않는다. iOS 기존 `createIOSHealthContext`를 전달하는 구조를 합성 테스트했다. 실제 native consumer flag 변경이나 실행은 하지 않았다.

## 공개 계약

```js
import { installOfflineHealthPreview } from './offline-health-preview.js';
// driver는 부모가 생성한다. account-OFF compiled 후보만 허용.
const preview = installOfflineHealthPreview(window, {
  driver, platform: 'ios', enabled: false
});
// 부모 lifecycle/auth 경계는 변경 전에 다음을 동기 호출해야 한다.
preview.invalidateContext();
preview.invalidateSession();
preview.background();
// 제거 시 listener/history wrapper/observer/DOM 정리
preview.dispose();
```

- 드라이버 공통 인터페이스: `open()`, `request(method,input)`, `invalidateContext()`, `invalidateSession()`, `background()`, `dispose()`.
- 요청 메서드는 `requestAuthorization` 또는 `readRunningWorkouts`뿐이다. 권한 입력은 `{}`, 조회 입력은 UTC ISO `{start,end,limit:100}`이고 클릭 순간 기준 최근 7×24시간이다. 여러 요청은 동시에 보내지 않는다.
- `open()` UI 진입은 native를 호출하지 않는다. 네이티브 open과 request는 권한/읽기 버튼을 명시적으로 누른 경우에만 실행한다. DOM 이벤트는 `isTrusted===true`만 허용한다. 내보낸 pure controller의 메서드는 테스트/부모 lifecycle용이며 사용자 제스처의 보안 경계가 아니다.
- entry `건강 기록 미리보기`, native `<dialog>` 내부 권한 요청/최근 7일 읽기/닫기. 모달 API가 없는 환경은 실패 종료한다. 렌더는 `textContent`와 `replaceChildren`만 사용한다.

## DTO 경계

`normalizeHealthPreview(payload,platform)`는 allowlist 필드만 복사한 동결 배열을 반환한다. 원본을 저장/로그/직렬화하지 않는다. 날짜는 timezone이 있는 ISO 문자열, finite 파싱, 실제 달력 일자와 종료>시작을 요구한다. 각 payload 입력 최대 100건이며 잘라서 승인하지 않는다.

- iOS: top-level `source:'apple-healthkit'`, `workouts:[{uuid,start,end,durationSeconds,distanceMeters}]`. UUID는 표준 8-4-4-4-12 hex 형태이며 소문자 정규화한다. duration/distance는 finite 비음수 숫자다. distance는 명시적 null 또는 숫자만 허용한다.
- Android: top-level `provider:'health-connect'`, `sessions:[{sourcePackage,sourceRecordId,startTime,endTime,exerciseType:'running'}]`. row provider가 있으면 일치해야 한다. sourceRecordId는 1..256 ASCII 식별자, sourcePackage는 최대 255의 점 구분 package 형식이다. provider를 Samsung 등으로 재라벨링하지 않는다.
- Android native/facade 최종 반환 형식은 부모가 조정 중이다. **이 후보는 top-level provider가 필수**다. 기존 native가 row에만 provider를 넣으면 facade 또는 normalize 계약을 부모가 일치시켜야 한다. 느슨한 추정 fallback은 없다.
- 출력 필드: source/sourcePackage/recordId/start/end/durationSeconds/durationKind/distanceMeters/distanceStatus/reviewStatus. Android 시간은 경과시간으로 명시하며 거리 미제공을 0으로 바꾸지 않는다. iOS 제공시간과 구분한다.
- iOS UUID 또는 Android `(sourcePackage,sourceRecordId)` 복합키로 완전히 동일한 행만 dedup한다. 동일 키에 날짜/거리 등 충돌이 있으면 payload 전체를 거절한다. 다른 출처의 동일 recordId는 다른 identity다.
- 모든 결과는 `UNREVIEWED`. 빈 결과는 기록 부재나 권한 거절의 증명이 아니다. 읽기 허용을 authorization 결과로 확정하지 않는다. 최대100건은 전체 건강 이력 보장이 아니다.

## 동기 무효화와 취소

- 닫기, invalidateContext, invalidateSession, background, dispose는 즉시 로컬 epoch를 증가시키고 메모리 rows/DOM 결과와 모달 표시를 비운다. native invalidation은 이후 best effort이며 UI 정리의 선행조건이 아니다.
- 요청은 시작 epoch 및 active operation identity, visible/disposed/foreground와 `isContextCurrent()`를 open 전후·request 전후·normalize 후·알림 직전에 확인한다. 이전 성공과 오류는 새 컨텍스트에 결과 또는 알림을 적용하지 않는다. 닫은 뒤 재개방해도 과거 응답은 적용되지 않는다.
- pure controller의 `isContextCurrent`는 기본 true이며 installer가 실제 DOM 신원을 검증하는 콜백을 공급한다. false/예외는 영구 dispose한다. getState/open/read 및 비동기 완료에서도 이 경계를 확인한다. installer는 최초 document/documentElement/body 신원과 root의 ownerDocument/isConnected/body 포함 여부를 검사하므로 observer 호출보다 먼저 응답이 와도 detached UI에 DTO를 적용하지 못한다.
- open/request 전체는 기본 30초(테스트 옵션 1..60000ms) 제한이다. local cancel race는 닫는 즉시 호출자를 false로 완료한다. native cleanup도 같은 제한으로 race하고 오류를 흡수한다. 모든 timer는 완료/무효화 시 정리한다. 건강 raw Error 메시지를 UI에 출력하지 않는다.
- JS에서 미해결 네이티브 Promise 자체를 강제 abort할 수는 없다. driver의 invalidate/background/dispose가 실제 native 취소/콜백 해제를 담당한다. 이 모듈은 지연 응답 적용을 차단하는 로컬 방어 계층이다.
- `onChange`는 동기 콜백이다. 건강자료를 저장하거나 비동기 외부 작업으로 넘기는 콜백을 붙이면 안 된다. 이미 콜백/`getState()`로 받은 immutable snapshot을 외부 코드가 보관하는 것까지 강제 삭제할 수는 없다. 기본 installer는 현재 화면에만 렌더한다.

## 원본 라우터를 수정하지 않는 보수적 경계

- history pushState/replaceState는 원래 함수 호출 **직전** invalidate하고 this/인수/반환값/throw를 유지한다. dispose 시 여전히 자신의 wrapper일 때만 원래 함수로 복원한다.
- popstate/hashchange/pagehide, window 자체의 blur, document visibilitychange 비전경 상태를 감시한다. 자식 input blur는 window 전경 상실로 취급하지 않는다.
- 원본 actionable 요소의 pointerdown/click/keydown/submit/change를 capture에서 관찰하고 원본 핸들러보다 먼저 지운다. preventDefault/전파 차단/anchor prototype 수정은 하지 않는다. 원본 다운로드/document adapter 이벤트를 소비하지 않는다.
- 최초 documentElement의 subtree 및 document childList를 관찰하여 main뿐 아니라 body/documentElement 자체 교체도 감지한다. body/root 분리나 교체는 단순 닫기가 아닌 영구 dispose다. observer를 먼저 disconnect하고 listener/history wrapper/DOM을 정리하며 다시 새 body로 자동 장착하지 않는다. 초기화 변수를 콜백 생성 전에 선언하여 조기 폐기 시 TDZ를 피한다.
- 제거 후 같은 turn에 재삽입해도 removedNodes에 body/root 또는 그 조상이 있으면 폐기한다. preview root 안의 자체 렌더 mutation은 무시하여 무한 invalidate를 피한다. queued observer가 폐기 후 다시 호출되어도 추가 dispose/재개방을 하지 않는다. 원본의 무관한 timer/배지 갱신도 닫을 수 있는 보수적 정책이다.
- **MutationObserver는 microtask 시점**이므로 DOM 제거 그 순간을 동기적으로 가로채는 기능은 아니다. 대신 연결 상태를 모든 요청 경계와 알림 직전 및 showModal의 동기 focus 처리 후에 재확인한다. observer 이전 늦은 성공/오류도 적용하지 않으며, observer가 감지하면 보관 중 자료도 지운다. popstate/hashchange도 브라우저 이벤트 시점이다. 이를 진짜 router/auth integration 완료라고 주장하지 않는다.
- 조작/URL/DOM 변화가 전혀 없는 내부 계정 전환은 추론할 수 없다. 실제 인증 세대와 네이티브 App foreground 이벤트의 부모 연결이 없다. 부모는 계정 변경 전에 invalidateSession, 화면 변경 전에 invalidateContext, 전경 상실 즉시 background를 직접 연결해야 한다. 그 검수 전 account-ON 빌드 사용 금지다.

## 검사 범위

```sh
node --test tests/offline-health-preview.test.mjs
```

의존성 없는 Node pure controller/normalize 및 작은 합성 DOM fixture 검사다. default OFF, 지연 성공/오류, 세션/전경/닫기, 중복조회, 취소/timeout, source/거리/DTO/ID 충돌, 원본 이벤트 비간섭, own-mutation 무시와 cleanup을 검사한다. 기존 iOS driver와 합성 왕복을 포함한다.

P2 회귀: body 교체/root 제거 각각에 대해 observer 전후의 늦은 성공·오류, 늦은 native open, 이미 렌더된 자료 제거, 영구 재개방 차단을 추가했다. 수정 전 늦은 성공·오류 회귀 실패를 확인했고 수정 후 기존 39개와 추가 회귀를 검사했다. fake DOM에 documentElement/body 연결·ownerDocument/isConnected를 모델링하지만 실제 브라우저 mutation 스케줄러의 증명은 아니다.

실제 native 또는 browser UI 컴파일/실행, HealthKit/Health Connect 권한·실데이터, 진짜 로그인, OS lifecycle 통합 성공의 근거가 아니다. bootstrap/build wiring은 부모 작업이다. 건강자료 자동 영구저장·일지/통계/분석 ingest·서버 전송 경로는 없다.
