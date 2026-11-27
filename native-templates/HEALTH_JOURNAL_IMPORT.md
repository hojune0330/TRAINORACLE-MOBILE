# 건강 기록 1건 → 일지 1건 저장 (중복 방지·메모/스티커 보존)

## 상태

- 새 `web-adapter/health-journal-import.js`는 계정 OFF 후보 전용 저장기다. 모듈을 bootstrap에 등록하지 않았고, 기본 경로에서 건강 조회·저장을 자동 호출하지 않는다.
- 일지 저장소를 **직접 수정하지 않는다.** 부모(앱 빌드)가 넘긴 포트 `journal.entries()/save()/update()`로만 일지를 읽고 쓴다. localStorage·색인·네트워크·DOM·로그를 이 모듈이 만지지 않는다(정적 검사로 확인).
- 미리보기에서 저장 단추를 쓰려면 `installOfflineHealthPreview(env, { ..., saveRow })`에 이 저장기의 `saveRow`를 넘긴다. 옵션이 없으면 미리보기는 지금처럼 읽기 전용이고 DOM도 이전과 같다.
- **남은 한 가지:** 앱 번들이 자기 일지 저장소(`loadEntries`·`saveEntry`·`updateEntry`)를 이 어댑터에 넘겨주는 연결이 아직 없다. 그 포트를 넘기는 일은 원본 `hojune0330/TRAINORACLE` 쪽 변경(예: 네이티브 브리지가 bootstrap에 `journal` 포트를 주입)이며, 이 저장소에서는 대역 포트로만 검증했다. 포트가 없으면 저장 단추도 설치되지 않는다.

## 포트 계약

```js
const journal = {
  entries(): JournalEntry[],                       // 앱의 loadEntries()
  save(entry): { ok: boolean },                    // 앱의 saveEntry()
  update(entry, expectedSavedAt): { ok: boolean }, // 앱의 updateEntry()
};
const links = {                                    // 기록→일지 연결표. 생략하면 메모리에만 둔다(앱 재시작 시 중복 방지 사라짐)
  get(): string | null,
  set(text: string): boolean,
};
const saver = createHealthJournalSaver({ journal, links, platform: 'ios' | 'android', now, newEntryId, dateOf });
saver.plan(row);                 // 초안 + 중복 판정 (저장 없음)
saver.commit(planned);           // 확인 후 새 일지 1건
saver.commit(planned, { kind: 'ATTACH', entryId, expectedSavedAt }); // 기존 일지에 수치만 채우기
saver.saveRow(row);              // 위 둘을 한 번에. 예외 없이 { ok, status, message, linkRecorded, suspects } 반환
```

- `plan`·`commit`은 동기 함수다. 저장 전후 일지 목록을 다시 읽고, 확인을 받은 뒤 목록이 바뀌었으면 `stale-plan`으로 거절한다(중복·동시 저장 회피).
- `commit`의 의도는 `SAVE_NEW`와 `ATTACH` 둘뿐이다. 다른 값은 `INVALID_INTENT`로 거절하며 아무것도 쓰지 않는다.
- `saveRow`는 미리보기 단추가 바로 부르는 경로이며, 입력 오류·포트 예외·저장 거절을 모두 결과 문구로 바꾼다. 원본 오류 메시지는 UI로 나가지 않는다.

## 만드는 일지

- `kind: 'post-session'`, `syncState: 'local'`, `date`는 운동 **시작 시각의 기기 지역 날짜**, `savedAt`은 호출 시각(단조 증가).
- `title: '달리기'`, `system: ''`, `rpe: 0`, `memo: ''`, `activityOutcome: 'COMPLETED'`, `objectiveDataState: 'CONFIRMED'`.
- 거리: `distanceMeters`가 있을 때만 km 소수 최대 3자리(`5.02`). 없으면 빈 문자열이며 0으로 바꾸지 않는다.
- 시간: `durationSeconds`를 분 소수 최대 2자리(`9.83`). iOS는 HealthKit 제공 시간, Android는 경과시간이며 이 구분은 미리보기 DTO의 `durationKind`를 그대로 따른다.
- 페이스: 거리와 시간이 모두 있을 때만 `1'58"` 표기. 30분/km를 넘거나 거리가 없으면 빈 문자열(값을 꾸며내지 않는다).
- 출처: 가져온 필드는 `{ provenance: 'DERIVED', derivedFrom: ['import:provider-activity'], derivationRuleId: 'HEALTH_PROVIDER_ACTIVITY_V1' }`. 앱의 `EXTERNAL_DERIVATION_INPUTS`에 이미 있는 토큰이며, 파일 가져오기(`import:activity-file`)와 섞지 않는다. 등록된 파생 규칙이 아니므로 통계·추이 입력에서는 제외되고 일지에서는 "가져옴"으로 보인다. 비어 있는 값은 `MISSING`.
- 사용자가 쓴 텍스트, 원본 건강 식별자(UUID·recordId), 메모, 신체 부위 기록은 일지에 넣지 않는다.

## 중복 방지

- 같은 기록 키는 iOS `apple-healthkit:<uuid>`(소문자 정규화), Android `health-connect:<sourcePackage>:<sourceRecordId>`다. 같은 recordId라도 출처 패키지가 다르면 다른 기록이다.
- 기록→일지 연결표는 부모가 준 `links`에만 남기고, 원본 식별자 대신 64비트 지문(FNV-1a 두 갈래)만 저장한다. 지문 충돌 확률은 이 규모에서 무시할 수 있지만 암호학적 보장은 아니며, 연결표를 읽지 못하면(손상·저장소 거부) **중복을 확인할 수 없으므로 저장하지 않는다.**
- 연결표 항목의 일지가 사라졌으면(사용자가 삭제) 그 항목만 정리하고 새로 저장한다. 연결표를 쓰지 못했는데 일지 저장은 성공한 경우 결과에 `linkRecorded: false`와 "다시 고르면 중복이 생길 수 있다"는 문구를 담는다.
- 항목 수는 기본 500개로 제한하고 오래된 연결부터 버린다.

## 메모·스티커 보존

- 새 일지는 항상 새 id로 만든다. 기존 일지는 읽기만 하므로 메모·스티커(장식은 일지 id에 붙는다)·신체 기록이 그대로 남는다.
- 붙이기(`ATTACH`)는 같은 id를 유지한 채 `distanceKm`·`durationMin`·`avgPace`와 그 출처만 채운다. 메모·`memoPurpose`·`title`·`system`·`rpe`·신체 기록·계획 연결·장식은 건드리지 않는다.
- 붙이기는 대상이 `post-session`이 아니거나, **날짜가 기록과 다르거나**, 파일 가져온 일지(`fileObservation` 보유)이거나, `savedAt`이 확인 시점과 다르면 거절한다. 잘못된 일지에 수치를 덮어쓰지 않기 위해서다.
- 같은 날 거리 0.2km 이내(거리가 없으면 시간 2분 이내)의 기존 일지는 **알림으로만** 알린다(`suspects`). 자동 병합하지 않는다.

## 미리보기 연결

- `installOfflineHealthPreview(env, { ..., saveRow })`: 행마다 `일지로 저장` 단추가 붙고, 두 번 눌러야 저장한다(첫 번째는 `한 번 더 누르면 저장`, 15초 뒤 자동 취소).
- 저장 중에는 단추가 잠기고, 결과 문구는 미리보기 창 안(`role="status"`)에만 남는다. 미리보기를 닫거나 화면을 옮기면 확인 대기와 문구가 사라진다.
- 안내 문구도 함께 바뀐다: 자동 저장하지 않으며, 고른 1건만 일지가 되고 기존 메모·스티커는 바뀌지 않는다는 사실을 적는다.

## 검사 범위

```sh
node --test tests/health-journal-import.test.mjs
```

- 대역 일지 포트로 앱 저장 관문의 이 경로에 해당하는 부분(스키마 필드·메모 목적·출처 필드·`savedAt` 조건)을 옮겨 검사한다. zod 스키마 전체나 실제 앱 저장소의 실행을 대신하지 않는다.
- 검사 항목: 초안 값과 표기, 거리 없음/0m/느린 페이스, 플랫폼·출처 불일치, 변조 DTO, 승인 없는 저장 없음, 재선택 중복 방지, 대소문자 UUID, 출처 패키지 구분, 사라진 일지 정리, 저장 거절·포트 예외, 확인 후 목록 변경, 연결표 상한·손상·쓰기 실패, 새 일지 저장 시 기존 메모·스티커 불변, 붙이기 보존·거절, 미리보기 두 번 누르기·닫기·실패 문구, 저장기의 정적 경계.
- 실제 기기·HealthKit/Health Connect 권한·실데이터·앱 번들 왕복·OS lifecycle은 검증하지 않았다. 앱 일지 포트 연결 전에는 이 기능이 앱에서 동작한다고 말하지 않는다.
