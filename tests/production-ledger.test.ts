import { describe, expect, it } from 'vitest'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import { emptyQuantities } from '../src/lib/types'
import { allocateProductionReceiptInWorkspace, assertProductionLedgerTotals, finalizeProductionRunInWorkspace, getLineAllocation, productionAmounts, saveProductionRunInWorkspace, scopeProductionLedgerWorkspace, validateProductionRunInput, voidProductionReceiptInWorkspace, type ProductionLedgerWorkspace, type ProductionRunInput } from '../src/lib/production-ledger'

const qty = (value: number) => ({ XXS:value,XS:value,S:value,M:value,L:value,XL:value })
function seed() {
  const workspace: ProductionLedgerWorkspace = { ...createSeed(),productionRuns:[],productionReceipts:[],productionRunAudits:[],productionLedgerAvailable:true }
  const style = workspace.styles[0],admin = workspace.profiles.find(person=>person.id===DEMO_IDS.admin)!,internal = workspace.profiles.find(person=>person.id===DEMO_IDS.internal)!
  const data: ProductionRunInput = { name:'본생산',projectId:style.projectId,projectCode:'PROJECT-A',expectedDue:'2026-11-20',poId:null,unitCost:1250.25,itemType:'product',order:qty(10),correctsRunId:null }
  workspace.projects.find(project=>project.id===style.projectId)!.code='PROJECT-A'
  return { workspace,style,admin,internal,data }
}
function run() {
  const fixture=seed(),id=crypto.randomUUID(),workspace=saveProductionRunInWorkspace(fixture.workspace,fixture.admin,id,fixture.style.id,fixture.style.production[0].id,fixture.data,0,'생산 차수 생성')
  return { ...fixture,workspace,id }
}
const received=(workspace:ProductionLedgerWorkspace,admin:ReturnType<typeof seed>['admin'],id:string,count=2)=>allocateProductionReceiptInWorkspace(workspace,admin,crypto.randomUUID(),id,{receivedAt:'2026-11-01',quantities:qty(count)},workspace.productionRuns!.find(item=>item.id===id)!.version,'실입고 확인')

describe('프로젝트·차수별 정산 도메인',()=>{
  it('컬러 담당자가 빈칸이면 스타일 담당자로 대체하지 않고 미지정 차수를 만든다',()=>{
    const {workspace,style,admin,data}=seed()
    style.production[0].ownerId=''
    const next=saveProductionRunInWorkspace(workspace,admin,crypto.randomUUID(),style.id,style.production[0].id,data,0,'미지정 오더 업로드')
    expect(next.productionRuns![0]).toMatchObject({ownerIdSnapshot:'',ownerNameSnapshot:''})
    expect(style.ownerId).not.toBe('')
  })
  it('각 컬러의 담당자를 사용하고 컬러 지정이 없는 예전 스타일은 기존 담당자를 쓴다',()=>{
    const {workspace,style,admin,internal,data}=seed()
    style.production[0].ownerId=internal.id
    const first=saveProductionRunInWorkspace(workspace,admin,crypto.randomUUID(),style.id,style.production[0].id,data,0,'컬러 담당자 오더')
    expect(first.productionRuns![0]).toMatchObject({ownerIdSnapshot:internal.id,ownerNameSnapshot:internal.name})
    delete style.production[0].ownerId
    const next=saveProductionRunInWorkspace(workspace,admin,crypto.randomUUID(),style.id,style.production[0].id,data,0,'기존 담당자 오더')
    expect(next.productionRuns![0].ownerIdSnapshot).toBe(style.ownerId)
  })
  it('공장 계정이나 미승인·비활성 본사를 새 차수 담당자로 지정하지 못한다',()=>{
    const {workspace,style,admin,data}=seed()
    for(const invalid of workspace.profiles.filter(item=>item.role==='factory'||!item.approved||!item.active)){
      style.production[0].ownerId=invalid.id
      expect(()=>saveProductionRunInWorkspace(workspace,admin,crypto.randomUUID(),style.id,style.production[0].id,data,0,'담당자 검증')).toThrow(/담당자/)
    }
  })
  it('미지정 차수는 나중에 저장한 컬러 담당자를 한 번 채운 뒤 변경 이력을 보존한다',()=>{
    const {workspace,style,admin,internal,data}=seed(),id=crypto.randomUUID()
    style.production[0].ownerId=''
    const first=saveProductionRunInWorkspace(workspace,admin,id,style.id,style.production[0].id,data,0,'미지정 차수')
    first.styles.find(item=>item.id===style.id)!.production[0].ownerId=internal.id
    const assigned=saveProductionRunInWorkspace(first,admin,id,style.id,style.production[0].id,data,1,'담당자 배정')
    expect(assigned.productionRuns![0]).toMatchObject({ownerIdSnapshot:internal.id,ownerNameSnapshot:internal.name})
    assigned.styles.find(item=>item.id===style.id)!.production[0].ownerId=admin.id
    const preserved=saveProductionRunInWorkspace(assigned,admin,id,style.id,style.production[0].id,data,2,'차수 내용 확인')
    expect(preserved.productionRuns![0]).toMatchObject({ownerIdSnapshot:internal.id,ownerNameSnapshot:internal.name})
  })
  it('미지정 차수는 마감을 막고 수동 담당자 배정 후 처음 확정한 담당자를 보존한다',()=>{
    const {workspace,style,admin,internal,data}=seed(),id=crypto.randomUUID()
    style.production[0].ownerId=''
    const draft=saveProductionRunInWorkspace(workspace,admin,id,style.id,style.production[0].id,data,0,'미지정 차수')
    const next=received(draft,admin,id)
    expect(()=>finalizeProductionRunInWorkspace(next,admin,id,2,'미지정 마감')).toThrow(/담당자/)
    next.styles.find(item=>item.id===style.id)!.production[0].ownerId=internal.id
    const closed=finalizeProductionRunInWorkspace(next,admin,id,2,'담당자 배정 후 확정')
    expect(closed.productionRuns![0]).toMatchObject({ownerIdSnapshot:internal.id,ownerNameSnapshot:internal.name,snapshot:{ownerIdSnapshot:internal.id,owner:internal.name}})
  })
  it('컬러를 포함한 14자리 품번에 컬러 코드를 다시 붙이지 않는다',()=>{
    const {workspace,style,admin,data}=seed()
    style.code='BP06FYDW0101BK';style.production[0].color='BK'
    const next=saveProductionRunInWorkspace(workspace,admin,crypto.randomUUID(),style.id,style.production[0].id,data,0,'전체 품번 차수 생성')
    expect(next.productionRuns![0].styleCodeSnapshot).toBe('BP06FYDW0101BK')
  })
  it('완전한 입력과 소수 둘째 자리 단가·실입고로 정확히 계산한다',()=>{
    const {data}=seed();expect(()=>validateProductionRunInput(data)).not.toThrow()
    expect(productionAmounts(1250.25,12)).toEqual({netAmount:15003,vatAmount:1500.3,grossAmount:16503.3})
    expect(()=>productionAmounts(1_000_000_000,60_000_000)).toThrow(/1조/)
  })
  it('추가 키·배열 UUID·음수·소수 수량·잘못된 날짜를 거부한다',()=>{
    const {data}=seed()
    for(const invalid of [{...data,extra:true},{...data,projectId:[data.projectId]},{...data,order:{...qty(1),S:1.5}},{...data,unitCost:-1},{...data,expectedDue:'2026-02-30'}])expect(()=>validateProductionRunInput(invalid as unknown as ProductionRunInput)).toThrow()
  })
  it('동일 품번의 프로젝트별 차수·오더가 부모 누적 오더와 독립이다',()=>{
    const fixture=run(),other=fixture.workspace.projects.find(project=>project.id!==fixture.style.projectId)!
    other.code='PROJECT-B';fixture.style.production[0].order=emptyQuantities();fixture.style.production[0].received=emptyQuantities()
    const secondId=crypto.randomUUID(),next=saveProductionRunInWorkspace(fixture.workspace,fixture.admin,secondId,fixture.style.id,fixture.style.production[0].id,{...fixture.data,projectId:other.id,projectCode:'PROJECT-B'},0,'리오더 등록')
    expect(next.productionRuns!.map(item=>item.round)).toEqual([1,1])
    const complete=received(received(next,fixture.admin,fixture.id,10),fixture.admin,secondId,10)
    expect(getLineAllocation(complete,fixture.style.id,fixture.style.production[0].id)).toMatchObject({ordered:qty(20),received:qty(20),inconsistent:false})
  })
  it('수정·입고·무효·마감은 저장 시점의 버전을 요구한다',()=>{
    const fixture=run(),next=received(fixture.workspace,fixture.admin,fixture.id),receipt=next.productionReceipts![0]
    expect(()=>saveProductionRunInWorkspace(next,fixture.admin,fixture.id,fixture.style.id,fixture.style.production[0].id,fixture.data,1,'오래된 수정')).toThrow(/VERSION_CONFLICT/)
    expect(()=>allocateProductionReceiptInWorkspace(next,fixture.admin,crypto.randomUUID(),fixture.id,{receivedAt:'2026-11-01',quantities:qty(1)},1,'오래된 입고')).toThrow(/VERSION_CONFLICT/)
    expect(()=>voidProductionReceiptInWorkspace(next,fixture.admin,receipt.id,fixture.id,1,1,'오래된 무효')).toThrow(/VERSION_CONFLICT/)
    expect(()=>finalizeProductionRunInWorkspace(next,fixture.admin,fixture.id,1,'오래된 마감')).toThrow(/VERSION_CONFLICT/)
  })
  it('실입고는 관리자만 입력하며 차수의 사이즈별 오더를 초과하지 못한다',()=>{
    const fixture=run()
    expect(()=>received(fixture.workspace,fixture.internal,fixture.id)).toThrow(/관리자/)
    expect(()=>received(fixture.workspace,fixture.admin,fixture.id,11)).toThrow(/초과/)
    const next=received(fixture.workspace,fixture.admin,fixture.id,6)
    expect(()=>received(next,fixture.admin,fixture.id,5)).toThrow(/초과/)
  })
  it('실입고가 있으면 단가·품목·PO를 고정하며 입고 이하 오더로 줄일 수 없다',()=>{
    const fixture=run(),next=received(fixture.workspace,fixture.admin,fixture.id)
    for(const change of [{unitCost:1},{itemType:'label' as const}])expect(()=>saveProductionRunInWorkspace(next,fixture.admin,fixture.id,fixture.style.id,fixture.style.production[0].id,{...fixture.data,...change},2,'단가 변경')).toThrow(/바꿀 수 없습니다/)
    expect(()=>saveProductionRunInWorkspace(next,fixture.admin,fixture.id,fixture.style.id,fixture.style.production[0].id,{...fixture.data,order:qty(1)},2,'수량 변경')).toThrow(/줄일 수 없습니다/)
  })
  it('무효 입고는 원본 단가·금액과 버전을 보존하며 확정 합계에서 제외한다',()=>{
    const fixture=run(),next=received(fixture.workspace,fixture.admin,fixture.id),receipt=next.productionReceipts![0]
    const voided=voidProductionReceiptInWorkspace(next,fixture.admin,receipt.id,fixture.id,1,2,'입고 정정')
    expect(voided.productionReceipts![0]).toMatchObject({voided:true,version:2,unitCost:1250.25,netAmount:15003})
    expect(()=>finalizeProductionRunInWorkspace(voided,fixture.admin,fixture.id,3,'마감 요청')).toThrow(/입고/)
    expect(next.productionReceipts![0].voided).toBe(false)
  })
  it('확정 금액과 최초 업체·담당자·품번은 부모 재배정이나 최신 단가와 무관하다',()=>{
    const fixture=run(),next=received(fixture.workspace,fixture.admin,fixture.id),saved=next.productionRuns![0]
    next.styles[0].factoryId=next.factories.find(factory=>factory.id!==saved.factoryIdSnapshot)!.id;next.styles[0].ownerId=fixture.internal.id;next.styles[0].code='NEW-CODE'
    const closed=finalizeProductionRunInWorkspace(next,fixture.internal,fixture.id,2,'대조 후 확정'),snapshot=structuredClone(closed.productionRuns![0].snapshot)
    expect(snapshot).toMatchObject({projectId:fixture.data.projectId,expectedDue:'2026-11-20',styleCode:saved.styleCodeSnapshot,factoryIdSnapshot:saved.factoryIdSnapshot,ownerIdSnapshot:saved.ownerIdSnapshot,netAmount:15003})
    closed.settlementTerms=[{styleId:fixture.style.id,lineId:fixture.style.production[0].id,projectCode:'PROJECT-A',unitCost:999999,itemType:'product',version:1,createdAt:'',updatedAt:'',updatedBy:fixture.admin.id}]
    expect(closed.productionRuns![0].snapshot).toEqual(snapshot)
  })
  it('확정 차수의 변경·추가 입고·입고 무효·재확정을 막는다',()=>{
    const fixture=run(),next=received(fixture.workspace,fixture.admin,fixture.id),receipt=next.productionReceipts![0],closed=finalizeProductionRunInWorkspace(next,fixture.admin,fixture.id,2,'차수 확정')
    expect(()=>saveProductionRunInWorkspace(closed,fixture.admin,fixture.id,fixture.style.id,fixture.style.production[0].id,fixture.data,3,'단가 정정')).toThrow(/마감/)
    expect(()=>received(closed,fixture.admin,fixture.id)).toThrow(/마감/)
    expect(()=>voidProductionReceiptInWorkspace(closed,fixture.admin,receipt.id,fixture.id,1,3,'입고 정정')).toThrow(/마감/)
    expect(()=>finalizeProductionRunInWorkspace(closed,fixture.admin,fixture.id,3,'차수 재확정')).toThrow(/마감/)
  })
  it('이미 등록된 차수의 프로젝트를 옮기지 못한다',()=>{
    const fixture=run(),other=fixture.workspace.projects.find(project=>project.id!==fixture.style.projectId)!
    other.code='PROJECT-B'
    expect(()=>saveProductionRunInWorkspace(fixture.workspace,fixture.admin,fixture.id,fixture.style.id,fixture.style.production[0].id,{...fixture.data,projectId:other.id,projectCode:'PROJECT-B'},1,'프로젝트 이동')).toThrow(/프로젝트는 변경/)
  })
  it('부모 스타일 저장은 과거 차수가 참조하는 컬러 삭제를 막지만 누적 수량은 강제하지 않는다',()=>{
    const fixture=run(),changed=structuredClone(fixture.style)
    changed.production[0].order=emptyQuantities();changed.production[0].received=emptyQuantities()
    expect(()=>assertProductionLedgerTotals(fixture.workspace,changed)).not.toThrow()
    changed.production=changed.production.filter(line=>line.id!==fixture.style.production[0].id)
    expect(()=>assertProductionLedgerTotals(fixture.workspace,changed)).toThrow(/컬러를 제거/)
  })
  it('공장에는 금융 데이터를 숨기고 전역 이력에도 금액이나 사유를 노출하지 않는다',()=>{
    const fixture=run(),next=received(fixture.workspace,fixture.admin,fixture.id),factory={...fixture.admin,role:'factory' as const,factoryId:fixture.style.factoryId}
    expect(scopeProductionLedgerWorkspace(next,factory)).toEqual({productionRuns:[],productionReceipts:[],productionRunAudits:[],productionLedgerAvailable:true})
    for(const audit of next.audits.filter(item=>item.action.startsWith('생산'))){expect(audit.before).toBeNull();expect(audit.reason).toBe('본사 전용 생산 차수 정산 변경');expect(JSON.stringify(audit)).not.toContain('1250.25')}
    expect(next.productionRunAudits).toHaveLength(2)
  })
  it('입고·마감은 업체 동의 후 본사가 생산 시작한 상태에서만 허용한다',()=>{
    const fixture=run(),gated={...fixture.workspace,supplierOrdersAvailable:true,supplierProductionOrders:[]}
    expect(()=>received(gated,fixture.admin,fixture.id)).toThrow(/생산 동의/)
  })
})
