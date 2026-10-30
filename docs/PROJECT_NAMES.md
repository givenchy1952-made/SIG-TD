# 프로젝트 명칭·필터·다운로드

프로젝트의 공식 명칭을 목록의 주요 정보로 표시하고 기존 코드·시즌을 함께 확인합니다. 선택과 다운로드 범위는 기존 프로젝트 ID로 구분하므로 같은 이름의 프로젝트를 합치지 않습니다.

## 데이터 연결과 누락 보완

- 공식 정보는 기존 `projects.name`, `projects.code`, `projects.season`입니다. 스타일명이나 임의 문자열을 프로젝트 명칭으로 사용하지 않습니다. 명칭이 없는 데이터는 기존 코드로 표시합니다.
- 오더 원본은 기존 A열 코드·M열 명칭·L열 시즌 매핑을 유지합니다. 동일 코드의 프로젝트 명칭·시즌이 충돌하면 자동 등록을 차단합니다.
- 예전 데이터에서 코드가 프로젝트 이름에 들어간 경우에도 새 프로젝트를 중복 생성하지 않고 관리자 매핑 검토를 안내합니다.
- 관리자는 **사용자·기본 설정 → 프로젝트 관리 → 오더 원본 프로젝트 매핑 검토**에서 원본 파일과 행을 확인합니다. 같은 프로젝트에 연결된 원본 정보가 일치하고 기존 공식 정보와 충돌하지 않을 때만 보완할 수 있습니다. **매핑 검토 → 기존 프로젝트 매핑 보완 확인 → 변경 저장**을 명시적으로 실행해야 저장됩니다.
- 저장은 기존 ID와 이전 코드·이름·시즌이 일치하는 행만 조건부 갱신합니다. 다른 관리자가 먼저 바꾼 정보는 덮어쓰지 않습니다. 스타일 연결·오더 원본·생산·PO·승인·입출고·확정 마감은 수정하지 않습니다.
- 현재 프로젝트 목록 밖의 과거 발주는 이미 접근이 허용된 발주의 공식 명칭·고정 코드를 표시합니다. 이 표시를 위해 프로젝트나 스타일 접근 범위를 확대하지 않습니다.

이번 기능에 **추가 SQL·마이그레이션은 필요하지 않습니다**. 운영 데이터와 SQL은 자동 실행하거나 변경하지 않았습니다. 데이터가 누락된 프로젝트의 명칭은 위 관리자 검토를 거쳐 저장한 뒤 반영됩니다.

## 화면과 필터

오버뷰·샘플 관리·메인 생산·결제·마감 목록은 명칭을 첫 줄, 코드를 보조 줄, 시즌을 별도 줄로 표시합니다. 프로젝트별 현황 카드, 전체/스타일 검색, 프로젝트 캘린더, 스타일 등록·상세와 생산 차수 선택도 같은 공식 명칭을 사용합니다. 긴 이름과 코드는 모바일에서 줄바꿈하거나 선택 내용을 펼쳐 확인할 수 있습니다.

**프로젝트 명칭** 필터에는 검색·복수 선택·전체 선택·선택 해제·초기화가 있습니다. 같은 필터 안의 복수 항목은 OR, 시즌·공장·컬러·담당자·진행 단계 등 다른 필터와의 관계는 AND입니다. 선택 항목은 필터 버튼과 선택한 필터 표시에서 확인합니다. 프로젝트 이름이 같으면 코드로 구분하고 코드까지 같거나 없으면 ID로 구분합니다.

## 다운로드

전체 조사 결과와 각 진입점은 [다운로드 적용 범위](PROJECT_NAME_DOWNLOAD_AUDIT.md)에 있습니다.

- 스타일·샘플·메인 생산·결제 현황 CSV/Excel은 현재 목록의 프로젝트·스타일·컬러 범위를 그대로 사용하며 명칭·코드를 모두 표시합니다. 기존 수량·상태·담당자 열 위치는 유지하고 코드·ID 열을 끝에 추가했습니다. Excel의 변경 이력·코멘트·첨부파일 목록도 같은 스타일 범위입니다.
- 을지 다운로드 창에는 화면의 프로젝트·품번 선택을 기본값으로 전달합니다. 창 안에서 검색·복수 선택·전체 선택/해제해 최종 범위를 바꿀 수 있습니다. 프로젝트와 스타일의 교집합만 출력하며 명칭순·코드순 정렬을 지원합니다.
- 메인 제품은 기존 확정 생산 차수와 기존 컬러별 을지 기준을 유지합니다. 과거 차수의 범위는 확정 스냅샷의 프로젝트 ID로 구분합니다. 중화라벨·비와이 자수·품질검사는 선택한 현재 프로젝트·컬러의 기존 단가·수량 기준을 유지합니다.
- SIG 고정 을지의 A·C·I·N·P·Q·R·T·U·V 등 고정 셀, 수식, 부가세, 합계와 확정 금액은 유지합니다. 프로젝트 명칭·코드·시즌·ID와 출력 행 번호는 별도 **프로젝트 안내** 시트에 표시합니다. 다른 마감 양식에도 같은 안내 시트를 추가하며 기존 병합·수식·입력 범위를 보존합니다.
- 개별 확정 차수·스타일 상세 컬러별 을지에도 공통 작성 로직을 적용했습니다. PO `.eml` 초안은 원래 내용과 발송 기록을 유지하고 파일명에 프로젝트 명칭·코드·스타일을 표시합니다.
- 원본 사진·PDF는 이름과 바이너리를 유지합니다. 전체 암호화 백업을 보고서 필터로 잘라내지 않습니다.

## 검증 범위

| 완료 조건 | 자동 검증 |
| --- | --- |
| 1·2 명칭 표시·동명 프로젝트 구분 | 프로젝트 식별 단위 테스트, 4개 목록 브라우저 검사 |
| 3·4·5 단일·복수 선택·명칭 검색 | 목록·캘린더의 ID별 선택, 상단 전체/스타일 검색 |
| 6·7 교차 필터·해제·전체 보기 | 시즌·공장·담당자·컬러·단계 AND 조합, 초기화 |
| 8·9 필터된 Excel·CSV | 실제 다운로드 파일을 열어 4개 보기의 명칭·코드·포함/제외 행 확인 |
| 10·11 프로젝트별·여러 프로젝트 을지 | 화면 선택 상속, 창 안의 범위 수정, 프로젝트·품번 교집합, 과거 확정 차수 |
| 12 고정 양식·수식 보존 | 고정 시트 XML·병합·열 위치·금액·부가세·합계·안내 시트 비교 |
| 13 모바일 | 390px 목록·검색·복수 선택·캘린더, 가로 넘침 확인 |
| 14 기존 데이터·권한 | 조회/다운로드 전후 데이터 동일성, 기존 ID 매핑 보완, 동시 수정 거부, 공장 범위·금융 보호 |

실행 명령과 최종 결과는 [테스트 결과](TEST_RESULTS.md)를 참고하세요. 모든 신규 브라우저 자료는 격리된 체험 데이터이며 운영 계정·운영 데이터·실제 메일을 시험에 사용하지 않았습니다.

## 수정 파일 목록

### 화면·선택·반응형

- [src/App.tsx](../src/App.tsx)
- [src/components/CreateStyle.tsx](../src/components/CreateStyle.tsx)
- [src/components/OperationsPanel.tsx](../src/components/OperationsPanel.tsx)
- [src/components/ProductionLedgerPanel.tsx](../src/components/ProductionLedgerPanel.tsx)
- [src/components/ProductionRoundBoard.tsx](../src/components/ProductionRoundBoard.tsx)
- [src/components/ProjectMappingReview.tsx](../src/components/ProjectMappingReview.tsx)
- [src/components/SettlementTemplateExport.tsx](../src/components/SettlementTemplateExport.tsx)
- [src/components/StyleDetail.tsx](../src/components/StyleDetail.tsx)
- [src/components/SupplierOrdersPanel.tsx](../src/components/SupplierOrdersPanel.tsx)
- [src/components/project-mapping-review.css](../src/components/project-mapping-review.css)
- [src/components/settlement-template.css](../src/components/settlement-template.css)
- [src/components/style-detail.css](../src/components/style-detail.css)
- [src/pages/Administration.tsx](../src/pages/Administration.tsx)
- [src/pages/Calendar.tsx](../src/pages/Calendar.tsx)
- [src/pages/Dashboard.tsx](../src/pages/Dashboard.tsx)
- [src/pages/calendar-filters.css](../src/pages/calendar-filters.css)
- [src/pages/dashboard.css](../src/pages/dashboard.css)

### 공통 데이터·매핑·다운로드

- [src/lib/export.ts](../src/lib/export.ts)
- [src/lib/order-registration.ts](../src/lib/order-registration.ts)
- [src/lib/production-ledger-export.ts](../src/lib/production-ledger-export.ts)
- [src/lib/project-identity.ts](../src/lib/project-identity.ts)
- [src/lib/project-mapping-repository.ts](../src/lib/project-mapping-repository.ts)
- [src/lib/settlement-export-scope.ts](../src/lib/settlement-export-scope.ts)
- [src/lib/settlement-template.ts](../src/lib/settlement-template.ts)
- [src/lib/sig-eulji.ts](../src/lib/sig-eulji.ts)

### 자동 검증

- [tests/approval-supplier.e2e.spec.ts](../tests/approval-supplier.e2e.spec.ts)
- [tests/multi-filter.e2e.spec.ts](../tests/multi-filter.e2e.spec.ts)
- [tests/order-registration.test.ts](../tests/order-registration.test.ts)
- [tests/production-conditions.e2e.spec.ts](../tests/production-conditions.e2e.spec.ts)
- [tests/production-ledger-export.test.ts](../tests/production-ledger-export.test.ts)
- [tests/production-ledger.e2e.spec.ts](../tests/production-ledger.e2e.spec.ts)
- [tests/project-eulji-template.test.ts](../tests/project-eulji-template.test.ts)
- [tests/project-identity.test.ts](../tests/project-identity.test.ts)
- [tests/project-mapping-repository.test.ts](../tests/project-mapping-repository.test.ts)
- [tests/project-names.e2e.spec.ts](../tests/project-names.e2e.spec.ts)
- [tests/project-report-export.test.ts](../tests/project-report-export.test.ts)
- [tests/project-screen-consistency.e2e.spec.ts](../tests/project-screen-consistency.e2e.spec.ts)
- [tests/round-import.e2e.spec.ts](../tests/round-import.e2e.spec.ts)
- [tests/settlement-project-scope.test.ts](../tests/settlement-project-scope.test.ts)
- [tests/settlement-template.test.ts](../tests/settlement-template.test.ts)

### 문서

- [docs/TEST_RESULTS.md](../docs/TEST_RESULTS.md)
- [README.md](../README.md)
- [docs/PROJECT_NAMES.md](../docs/PROJECT_NAMES.md)
- [docs/PROJECT_NAME_DOWNLOAD_AUDIT.md](../docs/PROJECT_NAME_DOWNLOAD_AUDIT.md)

