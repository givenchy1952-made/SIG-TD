import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
vi.mock('../src/lib/repository',()=>({getDemoWorkspace:vi.fn(),locked:vi.fn(),persist:vi.fn(),supabase:null}))
import { loadProductionLedgerWorkspace } from '../src/lib/production-ledger-repository'

function client(capability: {data:unknown;error:unknown}, pages:Record<string,Record<string,unknown>[][]>={}, failure:unknown=null) {
  const from=vi.fn((table:string)=>{let offset=0;const request={select:()=>request,order:()=>request,range:async(start:number)=>{offset=start/500;return {data:pages[table]?.[offset]||[],error:failure}}};return request})
  return {value:{rpc:vi.fn(async()=>capability),from} as unknown as SupabaseClient,from}
}
describe('생산 원장 클라우드 로딩',()=>{
  it('공장·미승인 계정에는 금융 테이블을 요청하지 않는다',async()=>{
    const mock=client({data:false,error:null}),result=await loadProductionLedgerWorkspace(mock.value)
    expect(mock.from).not.toHaveBeenCalled();expect(result).toEqual({productionRuns:[],productionReceipts:[],productionRunAudits:[],productionLedgerAvailable:false})
  })
  it('007 이전 서버는 가용성 표시만 끄고 기존 기능의 로딩을 계속한다',async()=>{
    const mock=client({data:null,error:{code:'PGRST202'}})
    expect((await loadProductionLedgerWorkspace(mock.value)).productionLedgerAvailable).toBe(false);expect(mock.from).not.toHaveBeenCalled()
  })
  it('권한·연결 오류를 설정 미완료로 숨기지 않는다',async()=>{
    const denied={code:'42501',message:'permission denied'},mock=client({data:null,error:denied})
    await expect(loadProductionLedgerWorkspace(mock.value)).rejects.toEqual(denied)
    const disconnected=client({data:true,error:null},{},{code:'NETWORK',message:'disconnected'})
    await expect(loadProductionLedgerWorkspace(disconnected.value)).rejects.toMatchObject({code:'NETWORK'})
  })
  it('테이블이 빠진 불완전 설치에서는 부분 금융 데이터를 표시하지 않는다',async()=>{
    const mock=client({data:true,error:null},{},{code:'42P01'})
    expect(await loadProductionLedgerWorkspace(mock.value)).toEqual({productionRuns:[],productionReceipts:[],productionRunAudits:[],productionLedgerAvailable:false})
  })
  it('모든 페이지를 읽고 단가·입고 금액과 비공개 이력의 필드명을 변환한다',async()=>{
    const raw={id:'run',project_id:'project',expected_due:null,order_quantities:{S:1},unit_cost:'1250.25',factory_id_snapshot:'factory',snapshot:{netAmount:1250.25}}
    const receipt={id:'receipt',run_id:'run',unit_cost:'1250.25',net_amount:'15003.00',quantities:{S:12}}
    const mock=client({data:true,error:null},{production_runs:[Array.from({length:500},()=>raw),[{...raw,id:'last'}]],production_receipts:[[receipt]],production_run_audits:[[{id:'audit',actor_name:'담당자',before:raw,after:receipt}]]})
    const result=await loadProductionLedgerWorkspace(mock.value)
    expect(result.productionRuns).toHaveLength(501);expect(result.productionRuns!.at(-1)).toMatchObject({id:'last',projectId:'project',expectedDue:'',order:{S:1},unitCost:1250.25,factoryIdSnapshot:'factory',snapshot:{netAmount:1250.25}})
    expect(result.productionReceipts![0]).toMatchObject({runId:'run',unitCost:1250.25,netAmount:15003})
    expect(result.productionRunAudits![0]).toMatchObject({actorName:'담당자',before:{order:{S:1},unitCost:1250.25},after:{runId:'run',netAmount:15003}})
    expect(result.productionLedgerAvailable).toBe(true)
  })
})
