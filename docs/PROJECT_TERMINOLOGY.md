# 프로젝트 명칭과 예산 관리 코드 분리

2026-10-31 사용자가 제공한 SIG 오더 CSV의 열 정의에 따른 기준입니다.

| 원본 | 저장 값 | 용도 |
| --- | --- | --- |
| M열 프로젝트 명칭 | `projects.name` | 생산 일정 협의, 업체 화면, 새 스타일 등록의 프로젝트 선택, PO 제목·본문·선택, 생산 필터·목록 |
| A열 프로젝트 코드 | `projects.code` | 본사 예산 관리와 기존 고정 을지의 A열. 화면에서는 **예산 관리 코드 (A열)**로 구분 |
| L열 년도/시즌 | `projects.season` | 별도의 시즌 정보·필터. 프로젝트 명칭으로 대신 사용하지 않음 |

예산 관리 코드와 프로젝트 명칭은 다른 정보입니다. 생산 화면의 프로젝트 선택은 M열 명칭을 표시하고 기존 프로젝트 ID를 선택 값으로 사용합니다. 같은 명칭의 서로 다른 프로젝트를 자동 합치거나 기존 프로젝트 ID·스타일 연결을 다시 만들지 않습니다. 명칭이 같아 구분이 필요할 때도 A열 코드를 생산 명칭으로 대체하지 않습니다.

## 본사와 업체 화면

본사 오버뷰·샘플 관리·메인 생산·결제·마감의 스타일 목록은 **프로젝트 명칭 / 예산 관리 코드 (본사) / 시즌**을 각각 별도 열로 표시합니다. M열 명칭과 A열 코드를 같은 칸에 합치지 않습니다. 외부 업체에는 A열을 표시하지 않으며, 생산 조건의 오더 목록과 선택 요약은 **프로젝트 명칭 / 품번 / 컬러 / 총 수량**으로 정리합니다. 같은 이름의 복수 오더는 기존 프로젝트·생산 차수 ID로 정확히 구분하며, 부분 납기 계획의 날짜·사이즈별 수량도 선택한 오더에 맞게 표시합니다.

## CSV 가져오기와 신규 등록

SIG CSV는 A·M·L열을 각각 읽어 별도 필드에 저장합니다. M열이 없으면 A열 코드나 L열 시즌으로 채우지 않고 등록 전에 확인을 요청합니다. M열에 A열 코드를 복사해 넣은 경우도 생산용 공식 명칭을 확인하도록 차단합니다.

등록 미리보기에는 M열 프로젝트 명칭과 L열 시즌을 먼저 표시하고 A열은 본사 참조용 예산 관리 코드로 명시합니다. F열 품번·컬러와 AQ~AV의 XXS~XL 오더 수량은 기존 기준을 유지합니다. A열의 정확한 일치는 기존 ID를 찾기 위한 내부 연결에만 사용하며 업체에게 보여줄 이름이나 PO 제목으로 사용하지 않습니다.

## 기존에 코드가 이름에 들어간 자료

**사용자·기본 설정 → 프로젝트 관리 → 오더 원본 프로젝트 매핑 검토**에서 원본 A·M·L과 기존 프로젝트를 비교합니다. 확인한 뒤 저장할 때만 같은 프로젝트 ID의 누락·잘못된 명칭을 보완합니다. 서로 다른 공식 명칭·시즌이나 원본 정보가 충돌하면 자동으로 덮어쓰지 않습니다. 운영 데이터에 일괄 SQL을 실행하거나 프로젝트를 중복 생성하지 않습니다.

본사 원본 탭의 A/M/L 참조 셀과 등록된 프로젝트의 공식 기준 정보는 구분합니다. 원본 참조를 임의 수정하는 것만으로 기존 발송 문서·승인 조건·마감 스냅샷을 재작성하지 않습니다.

## 이력과 을지

이미 발송된 PO와 승인·마감 기록은 당시 원본으로 보존합니다. 새로 작성하는 생산 안내와 PO에는 M열 프로젝트 명칭을 사용합니다. 과거 기록의 잘못된 명칭을 고치기 위해 기존 발송·승인 원본을 덮어쓰지 않습니다.

PO 발송 서버도 제목·본문 양쪽의 M열 명칭을 확인합니다. A열 예산 코드가 포함됐거나 공식 M 명칭이 없으면 **발송 시도를 만들기 전에 차단**합니다. 현재 스타일의 프로젝트가 바뀌었더라도 연결된 생산 차수와 PO 비교 원본의 프로젝트를 기준으로 확인하며, 발송 처리권을 확보한 뒤에도 같은 기준인지 다시 검사합니다. 확인 중 명칭·연결 정보가 바뀌면 메일 서비스에 보내지 않고 실패로 기록합니다.

예전 프로젝트의 이름에 A 코드가 저장되어 있고 다른 스타일에만 M 원본이 있는 경우에는 019의 같은 프로젝트 ID 조회로 명칭을 확인합니다. 019 미적용 서버는 동일 스타일의 원본 검증을 유지하며, 공식 명칭을 안전하게 확인할 수 없으면 코드를 대신 보내지 않고 발송을 차단합니다.

기존 미발송 초안에 A열 코드가 있으면 제목·본문을 수정하거나 새 PO로 복사하여 M열 명칭을 확인하세요. 이미 발송을 시도해 편집이 잠긴 문서는 원본과 접수 이력을 유지하고 새 PO를 작성합니다. 전송 결과가 미확인인 문서를 이 수정으로 자동 재발송하지 않습니다. 기존 PDF·사진 원본의 내용을 임의로 고치는 기능도 아닙니다.

고정 을지의 A열 예산 관리 코드와 이를 참조하는 브랜드·시즌 등 수식은 회계 양식의 일부이므로 보존합니다. 이 A열을 생산 프로젝트 명칭으로 바꾸거나 원본 표 머리글을 바꿔 수식을 깨뜨리지 않습니다. 별도 프로젝트 안내 시트에서는 명칭·예산 관리 코드·시즌을 구분합니다.

## 적용 항목

- **부분 납기 사이즈 입력:** 신규 `018_partial_delivery_sizes.sql`을 수동 적용합니다. 기존 총수량 계획은 사이즈별로 추정 배분하지 않고 그대로 보존하며, 사이즈별로 바꿀 때 담당자가 직접 입력합니다. 각 차수의 XXS~XL 합계와 전체 오더의 사이즈별 합계가 맞아야 저장합니다. 실제 입고 기록을 생성하거나 수량을 변경하지 않습니다.
- **업체의 과거 프로젝트 명칭 조회:** 신규 `019_production_project_names.sql`은 접근 가능한 기존 프로젝트의 명칭·시즌만 반환하는 읽기 전용 조회입니다. 과거 이름 칸에 A 코드가 들어간 경우에도 안전하게 일치하는 M 원본이 있을 때만 표시를 보완합니다. 업체에게 본사 원본 행이나 예산 코드를 공개하거나 프로젝트 메타데이터를 자동 수정하지 않습니다.
- **PO 서버 검사:** 배포에 사용하는 `send-po-outlook` 및 `send-po-email` Edge Function을 새 코드로 재배포해야 서버의 M 명칭·A 코드 검사가 적용됩니다. 함수 원본과 공유 `_shared/po-project-policy.ts`를 함께 배포합니다. 기존 인증·메일 서비스 설정·허용 사이트·발신자 검사는 유지합니다.
- **웹 화면:** 새 앱을 배포한 후 새로고침합니다. SQL·함수 배포는 개발 중 자동 실행하지 않습니다. 기존 016·017 파일을 수정하거나 예시 데이터를 운영에 다시 넣지 않습니다.

## 후속 적용 순서와 업체 설정

기존 001~017이 적용된 환경은 적용 이력을 확인한 뒤 **018 → 019 → 020 → 021**을 순서대로 검토·수동 적용합니다. 이 개발 작업에서 운영 SQL은 실행하지 않았으며 앱·메일 함수의 운영 배포도 자동 수행하지 않습니다.

- `020_inspection_assignments.sql`: 관리자 업체 서비스 설정, 에이블·KOTITI의 스타일·컬러별 검사 지정, 미지정·다른 업체 오더의 조회 제한과 최소 검사 정보 조회를 추가합니다. 기존 업체를 이름으로 추측해 분류하지 않습니다.
- `021_supplier_work_rates.sql`: 업체별 라벨 종류·자수 작업명·사양·기본 단가와 검사 품목별 기준 단가를 저장합니다. 새 작업에 기준값을 적용하며, 기존 저장 단가·결제 완료 금액·변경 이력은 자동으로 덮어쓰지 않습니다.

라벨·자수 업체는 배정 스타일이 없어도 오버뷰의 **내 업체 공통 작업·단가**에서 자기 업체의 기준 정보를 관리합니다. 본사는 스타일별 작업을 지시하고, 품질검사는 업체를 명시적으로 지정합니다. 자세한 화면 사용법은 [업체 공통 작업·기본 단가](SUPPLIER_WORK_CATALOG.md)와 [검사 업체 지정](INSPECTION_ASSIGNMENTS.md)을 참고하세요. 기존 프로젝트 ID·품번·생산 차수·PO·승인·입출고·확정 마감 기록은 유지합니다.

## 제공 파일 확인

제공 CSV는 CP949, 153열, 첫 행 머리글 구조입니다. 실제 파일은 작업 공간에서만 읽었으며 저장소·시험 파일에 복사하지 않았습니다. 자동 시험은 같은 3행×153열 구조를 가상 코드·명칭·수량으로 만든 별도 자료로 검증합니다.

## 이번 개선의 변경 파일

PR #6의 기존 프로젝트 명칭·부분 납기 수정과 이번 업체 작업·검사 지정 변경을 함께 포함합니다. 실제 업로드 파일과 운영 데이터는 포함하지 않습니다.

### 화면 및 공통 코드

- [src/App.tsx](../src/App.tsx)
- [src/components/CreateStyle.tsx](../src/components/CreateStyle.tsx)
- [src/components/InspectionAssignmentPanel.tsx](../src/components/InspectionAssignmentPanel.tsx)
- [src/components/InspectionOrdersPortal.tsx](../src/components/InspectionOrdersPortal.tsx)
- [src/components/OperationsPanel.tsx](../src/components/OperationsPanel.tsx)
- [src/components/OrderImport.tsx](../src/components/OrderImport.tsx)
- [src/components/OrderSourcePanel.tsx](../src/components/OrderSourcePanel.tsx)
- [src/components/PartialDeliveryPanel.tsx](../src/components/PartialDeliveryPanel.tsx)
- [src/components/ProcessingUnitPricePanel.tsx](../src/components/ProcessingUnitPricePanel.tsx)
- [src/components/ProductionDetailsPanel.tsx](../src/components/ProductionDetailsPanel.tsx)
- [src/components/ProductionLedgerPanel.tsx](../src/components/ProductionLedgerPanel.tsx)
- [src/components/ProductionPoLinkPanel.tsx](../src/components/ProductionPoLinkPanel.tsx)
- [src/components/ProductionRoundBoard.tsx](../src/components/ProductionRoundBoard.tsx)
- [src/components/ProjectMappingReview.tsx](../src/components/ProjectMappingReview.tsx)
- [src/components/SettlementTemplateExport.tsx](../src/components/SettlementTemplateExport.tsx)
- [src/components/SettlementTermsPanel.tsx](../src/components/SettlementTermsPanel.tsx)
- [src/components/StyleDetail.tsx](../src/components/StyleDetail.tsx)
- [src/components/SupplierOrdersPanel.tsx](../src/components/SupplierOrdersPanel.tsx)
- [src/components/SupplierWorkCatalogPanel.tsx](../src/components/SupplierWorkCatalogPanel.tsx)
- [src/components/inspection-orders.css](../src/components/inspection-orders.css)
- [src/components/partial-deliveries.css](../src/components/partial-deliveries.css)
- [src/components/supplier-orders.css](../src/components/supplier-orders.css)
- [src/components/supplier-work-catalog.css](../src/components/supplier-work-catalog.css)
- [src/lib/export.ts](../src/lib/export.ts)
- [src/lib/inspection-assignments-repository.ts](../src/lib/inspection-assignments-repository.ts)
- [src/lib/inspection-assignments.ts](../src/lib/inspection-assignments.ts)
- [src/lib/inspection-cloud-workspace.ts](../src/lib/inspection-cloud-workspace.ts)
- [src/lib/inspection-workspace.ts](../src/lib/inspection-workspace.ts)
- [src/lib/operations-domain.ts](../src/lib/operations-domain.ts)
- [src/lib/operations-repository.ts](../src/lib/operations-repository.ts)
- [src/lib/operations-types.ts](../src/lib/operations-types.ts)
- [src/lib/order-registration.ts](../src/lib/order-registration.ts)
- [src/lib/partial-deliveries-repository.ts](../src/lib/partial-deliveries-repository.ts)
- [src/lib/partial-deliveries.ts](../src/lib/partial-deliveries.ts)
- [src/lib/po-project-context.ts](../src/lib/po-project-context.ts)
- [src/lib/processing-prices-repository.ts](../src/lib/processing-prices-repository.ts)
- [src/lib/processing-prices.ts](../src/lib/processing-prices.ts)
- [src/lib/production-ledger-export.ts](../src/lib/production-ledger-export.ts)
- [src/lib/production-ledger.ts](../src/lib/production-ledger.ts)
- [src/lib/production-project-names-repository.ts](../src/lib/production-project-names-repository.ts)
- [src/lib/project-identity.ts](../src/lib/project-identity.ts)
- [src/lib/project-mapping-repository.ts](../src/lib/project-mapping-repository.ts)
- [src/lib/repository.ts](../src/lib/repository.ts)
- [src/lib/round-import.ts](../src/lib/round-import.ts)
- [src/lib/settlement-domain.ts](../src/lib/settlement-domain.ts)
- [src/lib/settlement-export-scope.ts](../src/lib/settlement-export-scope.ts)
- [src/lib/settlement-template.ts](../src/lib/settlement-template.ts)
- [src/lib/sig-eulji.ts](../src/lib/sig-eulji.ts)
- [src/lib/supplier-work-rates-repository.ts](../src/lib/supplier-work-rates-repository.ts)
- [src/lib/supplier-work-rates.ts](../src/lib/supplier-work-rates.ts)
- [src/lib/types.ts](../src/lib/types.ts)
- [src/lib/utils.ts](../src/lib/utils.ts)
- [src/pages/Administration.tsx](../src/pages/Administration.tsx)
- [src/pages/Calendar.tsx](../src/pages/Calendar.tsx)
- [src/pages/Dashboard.tsx](../src/pages/Dashboard.tsx)
- [src/pages/dashboard.css](../src/pages/dashboard.css)
- [src/pages/support.css](../src/pages/support.css)

### 서버 및 신규 SQL

- [supabase/functions/_shared/po-project-policy.ts](../supabase/functions/_shared/po-project-policy.ts)
- [supabase/functions/send-po-email/handler.ts](../supabase/functions/send-po-email/handler.ts)
- [supabase/functions/send-po-email/index.ts](../supabase/functions/send-po-email/index.ts)
- [supabase/functions/send-po-outlook/handler.ts](../supabase/functions/send-po-outlook/handler.ts)
- [supabase/functions/send-po-outlook/index.ts](../supabase/functions/send-po-outlook/index.ts)
- [supabase/migrations/018_partial_delivery_sizes.sql](../supabase/migrations/018_partial_delivery_sizes.sql)
- [supabase/migrations/019_production_project_names.sql](../supabase/migrations/019_production_project_names.sql)
- [supabase/migrations/020_inspection_assignments.sql](../supabase/migrations/020_inspection_assignments.sql)
- [supabase/migrations/021_supplier_work_rates.sql](../supabase/migrations/021_supplier_work_rates.sql)

### 자동 테스트

- [tests/approval-supplier.e2e.spec.ts](../tests/approval-supplier.e2e.spec.ts)
- [tests/e2e.spec.ts](../tests/e2e.spec.ts)
- [tests/fixtures/sig-project-columns-cp949.csv](../tests/fixtures/sig-project-columns-cp949.csv)
- [tests/inspection-access.e2e.spec.ts](../tests/inspection-access.e2e.spec.ts)
- [tests/inspection-assignments-cloud.test.ts](../tests/inspection-assignments-cloud.test.ts)
- [tests/inspection-assignments-database.test.ts](../tests/inspection-assignments-database.test.ts)
- [tests/inspection-assignments.test.ts](../tests/inspection-assignments.test.ts)
- [tests/inspection-cloud-workspace.test.ts](../tests/inspection-cloud-workspace.test.ts)
- [tests/inspection-rate-conflict.e2e.spec.ts](../tests/inspection-rate-conflict.e2e.spec.ts)
- [tests/operations.e2e.spec.ts](../tests/operations.e2e.spec.ts)
- [tests/order-project-columns.test.ts](../tests/order-project-columns.test.ts)
- [tests/outlook-email.test.ts](../tests/outlook-email.test.ts)
- [tests/partial-deliveries-cloud.test.ts](../tests/partial-deliveries-cloud.test.ts)
- [tests/partial-deliveries-database.test.ts](../tests/partial-deliveries-database.test.ts)
- [tests/partial-deliveries.test.ts](../tests/partial-deliveries.test.ts)
- [tests/partial-delivery-sizes.e2e.spec.ts](../tests/partial-delivery-sizes.e2e.spec.ts)
- [tests/po-email.test.ts](../tests/po-email.test.ts)
- [tests/po-project-context.e2e.spec.ts](../tests/po-project-context.e2e.spec.ts)
- [tests/po-project-context.test.ts](../tests/po-project-context.test.ts)
- [tests/po-project-policy.test.ts](../tests/po-project-policy.test.ts)
- [tests/processing-eulji.e2e.spec.ts](../tests/processing-eulji.e2e.spec.ts)
- [tests/processing-eulji.test.ts](../tests/processing-eulji.test.ts)
- [tests/processing-prices-repository.test.ts](../tests/processing-prices-repository.test.ts)
- [tests/processing-prices.e2e.spec.ts](../tests/processing-prices.e2e.spec.ts)
- [tests/processing-prices.test.ts](../tests/processing-prices.test.ts)
- [tests/production-conditions.e2e.spec.ts](../tests/production-conditions.e2e.spec.ts)
- [tests/production-ledger-price-code.e2e.spec.ts](../tests/production-ledger-price-code.e2e.spec.ts)
- [tests/production-ledger.e2e.spec.ts](../tests/production-ledger.e2e.spec.ts)
- [tests/production-project-names-database.test.ts](../tests/production-project-names-database.test.ts)
- [tests/production-project-names.e2e.spec.ts](../tests/production-project-names.e2e.spec.ts)
- [tests/production-project-names.test.ts](../tests/production-project-names.test.ts)
- [tests/project-eulji-template.test.ts](../tests/project-eulji-template.test.ts)
- [tests/project-identity.test.ts](../tests/project-identity.test.ts)
- [tests/project-names.e2e.spec.ts](../tests/project-names.e2e.spec.ts)
- [tests/project-report-export.test.ts](../tests/project-report-export.test.ts)
- [tests/project-screen-consistency.e2e.spec.ts](../tests/project-screen-consistency.e2e.spec.ts)
- [tests/round-import.e2e.spec.ts](../tests/round-import.e2e.spec.ts)
- [tests/round-import.test.ts](../tests/round-import.test.ts)
- [tests/settlement-project-scope.test.ts](../tests/settlement-project-scope.test.ts)
- [tests/settlement.e2e.spec.ts](../tests/settlement.e2e.spec.ts)
- [tests/supplier-library-scope.test.ts](../tests/supplier-library-scope.test.ts)
- [tests/supplier-own-library.e2e.spec.ts](../tests/supplier-own-library.e2e.spec.ts)
- [tests/supplier-work-catalog.e2e.spec.ts](../tests/supplier-work-catalog.e2e.spec.ts)
- [tests/supplier-work-rates-database.test.ts](../tests/supplier-work-rates-database.test.ts)
- [tests/supplier-work-rates-repository.test.ts](../tests/supplier-work-rates-repository.test.ts)
- [tests/supplier-work-rates.test.ts](../tests/supplier-work-rates.test.ts)

### 문서

- [README.md](../README.md)
- [docs/INSPECTION_ASSIGNMENTS.md](../docs/INSPECTION_ASSIGNMENTS.md)
- [docs/OUTLOOK_SETUP.md](../docs/OUTLOOK_SETUP.md)
- [docs/PARTIAL_DELIVERY_SIZES.md](../docs/PARTIAL_DELIVERY_SIZES.md)
- [docs/PRODUCTION_CONDITIONS.md](../docs/PRODUCTION_CONDITIONS.md)
- [docs/PRODUCTION_WORKFLOW_UPDATE.md](../docs/PRODUCTION_WORKFLOW_UPDATE.md)
- [docs/PROJECT_NAMES.md](../docs/PROJECT_NAMES.md)
- [docs/PROJECT_NAME_DOWNLOAD_AUDIT.md](../docs/PROJECT_NAME_DOWNLOAD_AUDIT.md)
- [docs/PROJECT_TERMINOLOGY.md](../docs/PROJECT_TERMINOLOGY.md)
- [docs/SUPPLIER_WORK_CATALOG.md](../docs/SUPPLIER_WORK_CATALOG.md)
- [docs/TEST_RESULTS.md](../docs/TEST_RESULTS.md)
