# 오프라인 건강 미리보기 후속 후보

기준: 2026-10-29, 이전 검증 커밋 a58dad9fda054a44d2b620ed3d402929f31fa18e.
이전 CI 40863490534는 Android/iOS 빌드와 fresh emulator/simulator 보관·재설치 probe를 통과했다. 이는 아래 후속 소스의 검증이나 실제 건강 자료 수신 증거가 아니다.

## 이번 후속 범위
- 기본 웹·기본 네이티브 빌드는 건강 호출 OFF 유지.
- `prepare-release --offline-health-preview`와 `generate-health-candidate --enable-health --platform ... --enable-offline-preview`가 함께 맞을 때에만 계정 OFF 전용 읽기 미리보기 후보를 구성한다.
- immutable web receipt에 source-bound config를 넣고 웹/네이티브 enabled 값을 대조한다. root capacitor config·원본 앱 source pin·사용자 보관 자료는 바꾸지 않는다.
- iOS는 main-frame ticket·document/context/session/request 바인딩과 native Info 플래그를 모두 요구한다.
- Android는 public Capacitor 건강 호출을 계속 drop하며, 별도 origin/main-frame 확인 WebMessageListener 채널과 원문서 proxy에 한정한다. 문서·세션·요청·TTL·전경 조건을 검사한다.
- native permission UI는 수동 사용자 클릭으로만 연다. 실제 background/stop이나 문서·화면 교체는 요청을 폐기한다. 권한 화면 후 미리보기를 다시 열어 조회할 수 있다.
- 최근 7일 달리기의 허용 필드만 미검토로 표시한다. Health Connect는 여러 운동 세션 SDK 객체를 받은 뒤 달리기를 필터링하므로, SDK 조회 범위와 표시·보관 범위를 혼동하지 않는다.
- 자료는 UI 메모리에만 두고 닫기·이동·배경 전환 때 폐기한다. 일지·통계·분석·서버로 자동 저장하지 않는다.

## 검증 근거와 한계
- 합성 JS driver·DTO·context 및 생성기 fixture를 실행한다. 숫자는 해당 최종 로그 범위로만 보고한다.
- 실제 브라우저 합성 화면에서 iOS/Android DTO, 거리 미제공, 수동 조회/닫기, 늦은 응답 미표시를 확인했다.
- 합성 QA origin의 localStorage/sessionStorage 바이트와 IndexedDB 목록은 조회 전후 동일했다. 원래 사용자 origin/실기기 전체 보관 자료에 대한 검증을 대신하지 않는다.
- 후속 Kotlin/Swift·실제 WebView ingress startup과 실제 권한·건강 자료 조회는 새 커밋의 CI/실기기로 별도 검증해야 한다.
- 일반 로그인 계정·auth 세대 연동, 일지 채택·중복/삭제·동의 저장과 서버 provider 연동은 미완료다. 오프라인 UI 격리를 일반 account-safe 보장으로 확대하지 않는다.
- WHOOP 로그인·제공자 OAuth·Garmin API 승인은 이 후보 빌드로 해결되지 않는다. production 자동 연동·서명·스토어 업로드는 하지 않는다.
