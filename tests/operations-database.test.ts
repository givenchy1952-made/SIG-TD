import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFileSync } from 'node:fs'
import { createSeed, DEMO_IDS } from '../src/lib/seed'
import type { Style, Quantities } from '../src/lib/types'
import { ORDER_SOURCE_COLUMNS } from '../src/lib/operations-types'
import type { OrderSourceData, CalendarEventInput, OperationRow, PoDispatchInput, ShipmentBatchInput } from '../src/lib/operations-types'

// These tests run all production migrations in actual PostgreSQL/WASM. Only
// Supabase auth/storage bindings are stubbed; hosted email delivery is not faked.
const db=new PGlite()
const fixture=createSeed()
const first=structuredClone(fixture.styles[0]),second=structuredClone(fixture.styles[1])
const factoryUser='10000000-0000-4000-8000-000000000006'
const labelCatalog='61000000-0000-4000-8000-000000000001',embroideryCatalog='62000000-0000-4000-8000-000000000001'
const fixedKinds=JSON.parse(readFileSync(new URL('../src/lib/default-operation-catalogs.json',import.meta.url),'utf8')) as {label:string[];embroidery:string[]}
const labelName=fixedKinds.label[0]
const zero:Quantities={XXS:0,XS:0,S:0,M:0,L:0,XL:0}
let insideTransaction=false,queryIndex=0
async function query<T=Record<string,unknown>>(sql:string,params:unknown[]=[]):Promise<{rows:T[]}> {
  if(!insideTransaction) return db.query<T>(sql,params)
  const savepoint=`ops_query_${queryIndex++}`;await db.exec(`savepoint ${savepoint}`)
  try {const result=await db.query<T>(sql,params);await db.exec(`release savepoint ${savepoint}`);return result}
  catch(error) {await db.exec(`rollback to savepoint ${savepoint}`);await db.exec(`release savepoint ${savepoint}`);throw error}
}
const uid=()=>crypto.randomUUID()
async function as(id:string|null,role='authenticated') { await db.exec(`reset role; set role ${role}`);await query("select set_config('request.jwt.claim.sub',$1,false)",[id||'']) }
async function isolated(fn:()=>Promise<void>) { await db.exec('begin');insideTransaction=true;try {await fn()} finally {insideTransaction=false;await db.exec('rollback')} }
async function style(id=first.id):Promise<Style> { const result=await query<{data:Style}>('select data from public.styles where id=$1',[id]);return structuredClone(result.rows[0].data) }
async function saveStyle(d:Style,reason='테스트 변경') {return query<{data:Style;version:number}>('select * from public.save_style($1,$2::jsonb,$3,$4)',[d.id,JSON.stringify(d),d.version,reason])}
const poInput=():PoDispatchInput=>({dueDate:'2026-12-20',recipient:'supplier@example.test',subject:'PO 납기 2026-12-20',body:'납기 2026-12-20 작업 요청입니다.',evidenceAttachmentId:null,voided:false})
async function po(id=uid(),data:PoDispatchInput=poInput(),version=0,styleId=first.id) { return query<Record<string,unknown>>('select * from public.save_po_dispatch($1,$2,$3,$4::jsonb,$5)',[id,styleId,version,JSON.stringify(data),'PO 초안 저장']) }
const shipmentInput=(m=5,date='2026-11-01'):ShipmentBatchInput=>({shippedAt:date,quantities:{...zero,M:m},tracking:'EXAMPLE-TRACK',note:'테스트 분할 출고',voided:false})
async function shipment(id=uid(),data=shipmentInput(),version=0,parentVersion=1,lineId=first.production[0].id,styleId=first.id) {return query<Record<string,unknown>>('select * from public.save_shipment_batch($1,$2,$3,$4,$5,$6::jsonb,$7)',[id,styleId,lineId,version,parentVersion,JSON.stringify(data),'분할 출고 변경'])}
const opRow=(catalogId=labelCatalog):OperationRow=>({id:uid(),catalogId,name:'위조한 종류명',specification:'예시 사양',quantity:100,lossQuantity:3,completedQuantity:90,status:'progress',orderedAt:'2026-10-25',requestedAt:'',completedAt:'',dueDate:'2026-11-05',note:'예시 작업'})
async function operation(id=uid(),kind='label',rows=[opRow()],version=0) {return query<Record<string,unknown>>('select * from public.save_style_operation($1,$2,$3,$4,$5::jsonb,$6)',[id,first.id,kind,version,JSON.stringify({rows,note:'작업 기록',voided:false}),'작업 내역 변경'])}
const eventInput=(kind:CalendarEventInput['kind']='personal_leave',ownerId=DEMO_IDS.internal):CalendarEventInput=>({kind,visibility:kind==='personal_leave'?'private':kind==='launch'?'all':'hq',title:kind==='personal_leave'?'개인 연차':kind==='launch'?'프로젝트 출시':'공장 휴가',startDate:'2026-11-01',endDate:'2026-11-03',ownerId,factoryId:kind==='factory_holiday'?DEMO_IDS.china:null,note:'일정 비고',deleted:false})
async function event(id=uid(),data=eventInput(),version=0) {return query<Record<string,unknown>>('select * from public.save_calendar_event($1,$2,$3::jsonb,$4)',[id,version,JSON.stringify(data),'일정 등록 변경'])}

const sourceInput=():OrderSourceData=>({fileName:'synthetic-order.xlsx',sheetName:'ORDER QTY',headers:Object.fromEntries(ORDER_SOURCE_COLUMNS.map(k=>[k,`실제제목 ${k}`])) as OrderSourceData['headers'],rows:[{rowNumber:7,columns:Object.fromEntries(ORDER_SOURCE_COLUMNS.map((k,i)=>[k,i===0?true:i===1?'B042FYTS0110OW':i===2?null:i===3?'원본값':i])) as OrderSourceData['rows'][number]['columns']}]})
async function source(data:OrderSourceData=sourceInput(),version=0,lineId=first.production[0].id,styleId=first.id) {return query<Record<string,unknown>>('select * from public.save_order_source_record($1,$2,$3,$4::jsonb,$5)',[styleId,lineId,version,JSON.stringify(data),'오더 원본 정보 저장'])}
const sourceChange=(s:Style)=>({styleId:s.id,expectedVersion:1,lines:[{lineId:s.production[0].id,color:s.production[0].color,quantities:{...zero,M:400},source:{...sourceInput(),expectedVersion:0}}]})

beforeAll(async()=>{
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
    create schema auth;create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema public,auth,storage to authenticated,anon,service_role;
    grant execute on function auth.uid() to authenticated,anon,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;`)
  for(const name of ['001_initial.sql','002_style_images.sql','003_operations.sql']) await db.exec(readFileSync(new URL(`../supabase/migrations/${name}`,import.meta.url),'utf8'))
  for(const f of fixture.factories) await query('insert into public.factories(id,name,country) values($1,$2,$3)',[f.id,f.name,f.country])
  for(const p of fixture.projects) await query('insert into public.projects(id,name,season) values($1,$2,$3)',[p.id,p.name,p.season])
  for(const p of [...fixture.profiles,{id:factoryUser,name:'한국 공장 사용자',email:'korea@example.test',role:'factory',approved:true,active:true,factoryId:DEMO_IDS.korea}]) {
    await query('insert into auth.users(id,email) values($1,$2)',[p.id,p.email])
    await query('update public.profiles set name=$2,role=$3,approved=$4,active=$5,factory_id=$6 where id=$1',[p.id,p.name,p.role,p.approved,p.active,p.factoryId])
  }
  await as(DEMO_IDS.admin)
  first.version=0;first.production[0].shipped={...zero,M:10};first.production[0].shippedAt=''
  second.version=0
  await saveStyle(first,'기존 출고 수량 예시 등록');await saveStyle(second,'다른 공장 스타일 예시 등록')
},30000)
afterAll(async()=>{await db.close()})

describe.sequential('003 operations production SQL',()=>{
  it('migrates all operations tables and preserves the existing style contract',async()=>{
    await as(DEMO_IDS.admin)
    expect((await style()).production[0].shipped.M).toBe(10)
    for(const table of ['po_dispatches','po_dispatch_attempts','shipment_ledgers','shipment_batches','style_operations','calendar_events','calendar_event_audits','employee_factory_assignments','operation_catalogs']) expect((await query(`select * from public.${table}`)).rows).toBeDefined()
  })
  it('seeds the exact 23 label and 33 embroidery kinds without a fake user and preserves repeated seed runs',async()=>isolated(async()=>{
    const expected=JSON.parse(readFileSync(new URL('../src/lib/default-operation-catalogs.json',import.meta.url),'utf8'))
    await as(DEMO_IDS.admin)
    for(const kind of ['label','embroidery']) {
      const rows=(await query<{id:string;name:string;updated_by:string|null}>('select * from public.operation_catalogs where kind=$1 and updated_by is null order by id',[kind])).rows
      expect(rows.map(row=>row.name)).toEqual(expected[kind]);expect(rows).toHaveLength(kind==='label'?23:33)
    }
    const sql=readFileSync(new URL('../supabase/migrations/003_operations.sql',import.meta.url),'utf8').split('-- BEGIN USER-APPROVED CATALOG SEED')[1].split('-- END USER-APPROVED CATALOG SEED')[0]
    await db.exec('reset role');await db.exec(sql)
    expect((await query('select * from public.operation_catalogs where updated_by is null')).rows).toHaveLength(56)
  }))
  it('denies pending and anonymous access and direct writes even for admin',async()=>isolated(async()=>{
    await as(fixture.profiles.find(p=>!p.approved)!.id)
    expect((await query('select * from public.operation_catalogs')).rows).toHaveLength(0)
    await expect(po()).rejects.toThrow(/FORBIDDEN/)
    await as(null,'anon');await expect(query('select * from public.calendar_events')).rejects.toThrow(/permission denied/)
    await expect(query('select public.begin_po_dispatch($1,1)',[uid()])).rejects.toThrow(/permission denied/)
  }))
  it('creates a PO draft without claiming any email was sent',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const {rows}=await po()
    expect(rows[0].status).toBe('draft');expect(rows[0].sent_at).toBeNull();expect(rows[0].provider_message_id).toBeNull();expect(rows[0].attempts).toBe(0)
    expect(new Date(rows[0].due_date as string).toISOString().slice(0,10)).toBe('2026-12-20');expect(rows[0].factory_id_snapshot).toBe(DEMO_IDS.korea)
  }))
  it('denies direct operation table writes and private helper execution even to admin',async()=>isolated(async()=>{
    await as(DEMO_IDS.admin)
    for(const table of ['po_dispatches','shipment_ledgers','shipment_batches','style_operations','calendar_events','calendar_event_audits','employee_factory_assignments','operation_catalogs']) await expect(query(`delete from public.${table}`)).rejects.toThrow(/permission denied/)
    await expect(query('select public.shipment_ledger_total($1,$2)',[first.id,first.production[0].id])).rejects.toThrow(/permission denied/)
  }))
  it('keeps PO drafts scoped to the assigned factory and writable only by HQ',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid();await po(id)
    await as(factoryUser);expect((await query('select * from public.po_dispatches')).rows).toHaveLength(1)
    await expect(po(uid())).rejects.toThrow(/FORBIDDEN/)
    await expect(query('select public.begin_po_dispatch($1,1)',[id])).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.factory);expect((await query('select * from public.po_dispatches')).rows).toHaveLength(0)
  }))
  it('CAS-protects editable drafts and rejects caller-forged sent status/timestamps',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid();await po(id)
    const data=poInput();data.dueDate='2026-12-22';await po(id,data,1)
    await expect(po(id,data,1)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(po(uid(),{...poInput(),status:'sent',sentAt:'2026-11-01'} as PoDispatchInput)).rejects.toThrow(/unknown field/)
    await expect(query('select public.finalize_po_dispatch($1,$2,null,$3)',[id,'fake-provider','sent'])).rejects.toThrow(/permission denied/)
  }))
  it('only service-role finalization can stamp provider-confirmed sent evidence and immutable attempts',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid();await po(id)
    const began=(await query('select * from public.begin_po_dispatch($1,1)',[id])).rows[0]
    expect(began.status).toBe('sending');expect(began.sent_at).toBeNull();expect(began.attempts).toBe(1)
    await expect(query('select public.begin_po_dispatch($1,2)',[id])).rejects.toThrow(/PO_SEND_BLOCKED/)
    await as(null,'service_role')
    await expect(query('select * from public.finalize_po_dispatch($1,null,null,$2)',[id,'sent'])).rejects.toThrow(/provider message id/)
    const sent=(await query('select * from public.finalize_po_dispatch($1,$2,null,$3)',[id,'provider-test-id','sent'])).rows[0]
    expect(sent.status).toBe('sent');expect(sent.sent_at).toBeTruthy();expect(sent.provider_message_id).toBe('provider-test-id')
    await as(DEMO_IDS.internal)
    await expect(po(id,poInput(),3)).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(query('select public.begin_po_dispatch($1,3)',[id])).rejects.toThrow(/PO_SEND_BLOCKED/)
    const attempts=(await query('select * from public.po_dispatch_attempts where dispatch_id=$1',[id])).rows
    expect(attempts).toHaveLength(1);expect(attempts[0].status).toBe('sent')
    expect((attempts[0].snapshot as Record<string,unknown>).dueDate).toBe('2026-12-20')
    expect((attempts[0].snapshot as Record<string,unknown>).recipient).toBe('supplier@example.test')
  }))
  it('preserves failed attempts and retries the same immutable payload/idempotency key',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid();await po(id)
    const firstAttempt=(await query('select * from public.begin_po_dispatch($1,1)',[id])).rows[0]
    await as(null,'service_role');await query('select public.finalize_po_dispatch($1,null,$2,$3)',[id,'Provider rejected the request','failed'])
    await as(DEMO_IDS.internal)
    await expect(po(id,{...poInput(),body:'다른 내용'},3)).rejects.toThrow(/HISTORY_PROTECTED/)
    const secondAttempt=(await query('select * from public.begin_po_dispatch($1,3)',[id])).rows[0]
    expect(secondAttempt.idempotency_key).toBe(firstAttempt.idempotency_key);expect(secondAttempt.attempts).toBe(2)
    expect((await query('select * from public.po_dispatch_attempts where dispatch_id=$1',[id])).rows).toHaveLength(2)
  }))
  it('blocks automatic retries after unknown provider outcomes and preserves unconfirmed state',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid();await po(id);await query('select public.begin_po_dispatch($1,1)',[id])
    await as(null,'service_role');await query('select public.finalize_po_dispatch($1,null,$2,$3)',[id,'Request timed out after transmission','unknown'])
    await as(DEMO_IDS.internal)
    const row=(await query('select * from public.po_dispatches where id=$1',[id])).rows[0]
    expect(row.status).toBe('unknown');expect(row.sent_at).toBeNull()
    await expect(query('select public.begin_po_dispatch($1,3)',[id])).rejects.toThrow(/PO_SEND_BLOCKED/)
  }))
  it('blocks stale draft factory/code snapshots until HQ reviews and resaves the unattempted draft',async()=>isolated(async()=>{
    await as(DEMO_IDS.admin);const id=uid();await po(id)
    const d=await style();d.factoryId=DEMO_IDS.china;d.code='REASSIGNED-STYLE';d.samples=d.samples.map(sample=>({...sample,factoryId:DEMO_IDS.china}));await saveStyle(d)
    await expect(query('select public.begin_po_dispatch($1,1)',[id])).rejects.toThrow(/PO_ASSIGNMENT_CHANGED/)
    expect((await query('select * from public.po_dispatch_attempts')).rows).toHaveLength(0)
    const refreshed=(await po(id,{...poInput(),body:'배정된 중국 공장과 변경 품번 검토 후 발주합니다.'},1)).rows[0]
    expect(refreshed.factory_id_snapshot).toBe(DEMO_IDS.china);expect(refreshed.style_code_snapshot).toBe('REASSIGNED-STYLE');expect(refreshed.status).toBe('draft');expect(refreshed.attempts).toBe(0)
    const started=(await query('select * from public.begin_po_dispatch($1,2)',[id])).rows[0]
    expect(started.status).toBe('sending');expect(started.attempts).toBe(1)
    const attempt=(await query<{snapshot:{factoryId:string;styleCode:string}}>('select snapshot from public.po_dispatch_attempts where dispatch_id=$1',[id])).rows[0].snapshot
    expect(attempt.factoryId).toBe(DEMO_IDS.china);expect(attempt.styleCode).toBe('REASSIGNED-STYLE')
    await expect(po(id,poInput(),3)).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('also blocks code-only changes until an unattempted PO draft is resaved',async()=>isolated(async()=>{
    await as(DEMO_IDS.admin);const id=uid();await po(id)
    const d=await style();d.code='RENAMED-ONLY';await saveStyle(d)
    await expect(query('select public.begin_po_dispatch($1,1)',[id])).rejects.toThrow(/PO_ASSIGNMENT_CHANGED/)
    expect((await po(id,poInput(),1)).rows[0].style_code_snapshot).toBe('RENAMED-ONLY')
    expect((await query('select * from public.begin_po_dispatch($1,2)',[id])).rows[0].status).toBe('sending')
  }))
  it('captures unknown-date legacy quantities once and atomically aggregates N shipment rounds',async()=>isolated(async()=>{
    await as(factoryUser);const a=uid(),b=uid()
    const firstBatch=(await shipment(a)).rows[0];expect(firstBatch.round).toBe(1)
    let d=await style();expect(d.version).toBe(2);expect(d.production[0].shipped.M).toBe(15);expect(d.production[0].shippedAt).toBe('2026-11-01')
    const ledger=(await query('select * from public.shipment_ledgers')).rows[0];expect((ledger.baseline_quantities as Quantities).M).toBe(10);expect(ledger.baseline_date).toBeNull()
    const next=(await shipment(b,shipmentInput(7,'2026-11-03'),0,2)).rows[0];expect(next.round).toBe(2)
    d=await style();expect(d.version).toBe(3);expect(d.production[0].shipped.M).toBe(22)
    await shipment(a,shipmentInput(3),1,3);d=await style();expect(d.production[0].shipped.M).toBe(20)
    await as(DEMO_IDS.admin);await shipment(b,{...shipmentInput(7,'2026-11-03'),voided:true},1,4)
    d=await style();expect(d.production[0].shipped.M).toBe(13);expect(d.production[0].shippedAt).toBe('2026-11-01')
    expect((await query('select * from public.shipment_batches')).rows).toHaveLength(2)
    expect((await query('select * from public.shipment_ledgers')).rows).toHaveLength(1)
  }))
  it('preserves a known legacy date when a new batch has an earlier date',async()=>isolated(async()=>{
    await as(DEMO_IDS.factory)
    const before=await style(second.id)
    await shipment(uid(),shipmentInput(1,'2020-01-01'),0,1,second.production[0].id,second.id)
    const after=await style(second.id)
    expect(after.production[0].shipped.M).toBe(before.production[0].shipped.M+1)
    expect(after.production[0].shippedAt).toBe(before.production[0].shippedAt)
  }))
  it('blocks legacy direct aggregate edits after a shipment ledger exists',async()=>isolated(async()=>{
    await as(factoryUser);await shipment()
    let d=await style();d.production[0].shipped.M=999
    await expect(saveStyle(d)).rejects.toThrow(/SHIPMENT_LEDGER_PROTECTED/)
    d=await style();d.production[0].shippedAt='2030-01-01'
    await expect(saveStyle(d)).rejects.toThrow(/SHIPMENT_LEDGER_PROTECTED/)
    await as(DEMO_IDS.internal);d=await style();d.notes='일반 업무 수정은 허용';await saveStyle(d)
    expect((await style()).production[0].shipped.M).toBe(15)
  }))
  it('CAS rejects stale parent/batch edits atomically without inserting batches or losing quantities',async()=>isolated(async()=>{
    await as(factoryUser);const id=uid();await shipment(id)
    await expect(shipment(uid(),shipmentInput(),0,1)).rejects.toThrow(/VERSION_CONFLICT/)
    await expect(shipment(id,shipmentInput(),0,2)).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await query('select * from public.shipment_batches')).rows).toHaveLength(1)
    expect((await style()).production[0].shipped.M).toBe(15)
  }))
  it('reserves cancellation/restoration to admin and forbids factories from editing cancelled shipments',async()=>isolated(async()=>{
    await as(factoryUser);const id=uid();await shipment(id)
    await expect(shipment(id,{...shipmentInput(),voided:true},1,2)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin);await shipment(id,{...shipmentInput(),voided:true},1,2)
    expect((await style()).production[0].shipped.M).toBe(10)
    await as(factoryUser)
    await expect(shipment(id,shipmentInput(),2,3)).rejects.toThrow(/FORBIDDEN/)
    await expect(shipment(id,{...shipmentInput(),tracking:'cancelled-edit',voided:true},2,3)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin);await shipment(id,shipmentInput(),2,3)
    expect((await style()).production[0].shipped.M).toBe(15)
  }))
  it('requires a positive active shipment and at least one bounded work row',async()=>isolated(async()=>{
    await as(factoryUser);await expect(shipment(uid(),shipmentInput(0))).rejects.toThrow(/at least one item/)
    await as(DEMO_IDS.internal);await expect(operation(uid(),'label',[])).rejects.toThrow(/INVALID_OPERATION/)
    await expect(operation(uid(),'embroidery',[{...opRow(embroideryCatalog),completedQuantity:104}])).rejects.toThrow(/completed quantity/)
  }))
  it('denies internal and cross-factory shipment writes while allowing internal reads',async()=>isolated(async()=>{
    await as(factoryUser);await shipment()
    await as(DEMO_IDS.internal);expect((await query('select * from public.shipment_batches')).rows).toHaveLength(1)
    await expect(shipment(uid(),shipmentInput(),0,2)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.factory);expect((await query('select * from public.shipment_batches')).rows).toHaveLength(0)
    await expect(shipment(uid(),shipmentInput(),0,2)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('validates shipment quantities and rolls back oversized aggregate changes',async()=>isolated(async()=>{
    await as(factoryUser)
    await expect(shipment(uid(),shipmentInput(-1))).rejects.toThrow(/INVALID_QUANTITIES/)
    await expect(shipment(uid(),shipmentInput(1.5))).rejects.toThrow(/INVALID_QUANTITIES/)
    await expect(shipment(uid(),shipmentInput(10000000))).rejects.toThrow(/aggregate exceeds/)
    expect((await query('select * from public.shipment_batches')).rows).toHaveLength(0)
    expect((await query('select * from public.shipment_ledgers')).rows).toHaveLength(0)
    expect((await style()).production[0].shipped.M).toBe(10)
  }))
  it('restricts catalog management to admin and derives row names from the fixed catalog',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal)
    await expect(query('select public.save_operation_catalog($1,$2,$3,true,0,$4)',[uid(),'label','임의 종류','종류 추가'])).rejects.toThrow(/FORBIDDEN/)
    const id=uid();const {rows}=await operation(id);expect((rows[0].rows_data as OperationRow[])[0].name).toBe(labelName)
    await expect(operation(id,'label',[opRow(embroideryCatalog)],1)).rejects.toThrow(/registered work kind/)
    await expect(operation(uid(),'embroidery',[opRow(uid())])).rejects.toThrow(/registered work kind/)
  }))
  it('keeps order/loss/completion quantities distinct and protects work-record versions',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid(),row=opRow();await operation(id,'label',[row])
    const saved=(await operation(id,'label',[{...row,lossQuantity:7,completedQuantity:95}],1)).rows[0]
    expect((saved.rows_data as OperationRow[])[0]).toMatchObject({quantity:100,lossQuantity:7,completedQuantity:95})
    await expect(operation(id,'label',[row],1)).rejects.toThrow(/VERSION_CONFLICT/)
    await as(factoryUser);expect((await query('select * from public.style_operations')).rows).toHaveLength(1)
    expect((await query('select * from public.operation_catalogs')).rows).toHaveLength(0)
    await expect(operation(id,'label',[row],2)).rejects.toThrow(/FORBIDDEN/)
  }))
  it('preserves existing inactive-catalog rows but refuses new inactive work selections',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid(),row=opRow();await operation(id,'label',[row])
    await as(DEMO_IDS.admin);await query('select public.save_operation_catalog($1,$2,$3,false,1,$4)',[labelCatalog,'label',labelName,'종류 비활성'] )
    await as(DEMO_IDS.internal);const saved=(await operation(id,'label',[{...row,note:'기존 작업 수정'}],1)).rows[0]
    expect((saved.rows_data as OperationRow[])[0].name).toBe(labelName)
    await expect(operation(id,'label',[row,opRow()],2)).rejects.toThrow(/inactive work kind/)
  }))
  it('keeps personal leave and its audit owner-private even from other administrators',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid();await event(id)
    expect((await query('select * from public.calendar_events')).rows).toHaveLength(1)
    expect((await query('select * from public.calendar_event_audits')).rows).toHaveLength(1)
    await as(DEMO_IDS.admin)
    expect((await query('select * from public.calendar_events')).rows).toHaveLength(0)
    expect((await query('select * from public.calendar_event_audits')).rows).toHaveLength(0)
    await expect(event(id,{...eventInput(),title:'다른 관리자 변경'},1)).rejects.toThrow(/FORBIDDEN/)
    const globalAudits=(await query('select * from public.audits')).rows
    expect(JSON.stringify(globalAudits)).not.toContain('개인 연차')
    await as(factoryUser);expect((await query('select * from public.calendar_events')).rows).toHaveLength(0)
  }))
  it('does not leak formerly private snapshots when personal leave becomes HQ-shared',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid();await event(id)
    await event(id,{...eventInput(),visibility:'hq',note:'공유 가능한 현재 비고'},1)
    await as(DEMO_IDS.admin);expect((await query('select * from public.calendar_events')).rows).toHaveLength(1)
    expect((await query('select * from public.calendar_event_audits')).rows).toHaveLength(0)
    await as(DEMO_IDS.internal);await event(id,{...eventInput(),visibility:'hq',note:'공유 후 변경'},2)
    await as(DEMO_IDS.admin);expect((await query('select * from public.calendar_event_audits')).rows).toHaveLength(1)
  }))
  it('shows launches to approved factories while hiding every factory holiday and its audit',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);await event(uid(),eventInput('launch'));await event(uid(),eventInput('factory_holiday'))
    await as(factoryUser)
    const visible=(await query('select * from public.calendar_events')).rows
    expect(visible).toHaveLength(1);expect(visible[0].kind).toBe('launch')
    const auditRows=(await query('select * from public.calendar_event_audits')).rows
    expect(auditRows).toHaveLength(1);expect(JSON.stringify(auditRows)).not.toContain('공장 휴가')
    await expect(event(uid(),eventInput('factory_holiday',factoryUser))).rejects.toThrow(/FORBIDDEN/)
    await expect(event(uid(),eventInput('launch',factoryUser))).rejects.toThrow(/FORBIDDEN/)
  }))
  it('allows only factory-owned private leave and prevents a factory from sharing it to HQ',async()=>isolated(async()=>{
    await as(factoryUser);const id=uid();await event(id,eventInput('personal_leave',factoryUser))
    await expect(event(id,{...eventInput('personal_leave',factoryUser),visibility:'hq'},1)).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin);expect((await query('select * from public.calendar_events')).rows).toHaveLength(0)
  }))
  it('protects event ownership/kind, validates date ranges and preserves tombstones/audits',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid();await event(id)
    await expect(event(id,{...eventInput('launch'),visibility:'all'},1)).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(event(id,{...eventInput(),endDate:'2026-10-01'},1)).rejects.toThrow(/end date/)
    await expect(event(id,{...eventInput(),startDate:'2026-02-30'},1)).rejects.toThrow()
    const deleted=(await event(id,{...eventInput(),deleted:true},1)).rows[0]
    expect(deleted.deleted_at).toBeTruthy();expect(deleted.version).toBe(2)
    expect((await query('select * from public.calendar_event_audits')).rows).toHaveLength(2)
    await expect(event(id,eventInput(),1)).rejects.toThrow(/VERSION_CONFLICT/)
  }))
  it('lets another HQ employee update shared launches but never change their owner/kind',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const id=uid();await event(id,eventInput('launch'))
    await as(fixture.profiles[2].id);await event(id,{...eventInput('launch'),title:'HQ 공동 출시 일정 변경'},1)
    await expect(event(id,{...eventInput('launch'),ownerId:fixture.profiles[2].id},2)).rejects.toThrow(/HISTORY_PROTECTED/)
  }))
  it('admin assigns factories with CAS while HQ retains all style visibility',async()=>isolated(async()=>{
    await as(DEMO_IDS.admin)
    const saved=(await query('select * from public.save_employee_factory_assignment($1,$2,0,$3)',[DEMO_IDS.internal,[DEMO_IDS.korea],'업무 담당 공장 배정'])).rows[0]
    expect(saved.version).toBe(1);expect(saved.factory_ids).toEqual([DEMO_IDS.korea])
    await expect(query('select public.save_employee_factory_assignment($1,$2,0,$3)',[DEMO_IDS.internal,[],'배정 변경'])).rejects.toThrow(/VERSION_CONFLICT/)
    await as(DEMO_IDS.internal)
    expect((await query('select * from public.employee_factory_assignments')).rows).toHaveLength(1)
    expect((await query('select * from public.styles')).rows).toHaveLength(2)
    await expect(query('select public.save_employee_factory_assignment($1,$2,1,$3)',[DEMO_IDS.internal,[],'임의 배정 해제'])).rejects.toThrow(/FORBIDDEN/)
    await as(factoryUser);expect((await query('select * from public.employee_factory_assignments')).rows).toHaveLength(0)
  }))
  it('rejects unknown/duplicate factories and non-HQ employee assignments',async()=>isolated(async()=>{
    await as(DEMO_IDS.admin)
    for(const factoryIds of [[uid()],[DEMO_IDS.korea,DEMO_IDS.korea],[null]]) await expect(query('select public.save_employee_factory_assignment($1,$2,0,$3)',[DEMO_IDS.internal,factoryIds,'잘못된 배정 검증'])).rejects.toThrow(/INVALID_OPERATION/)
    await expect(query('select public.save_employee_factory_assignment($1,$2,0,$3)',[factoryUser,[DEMO_IDS.korea],'외부 사용자 배정'])).rejects.toThrow(/INVALID_OPERATION/)
  }))
  it('atomically replaces/adds imported orders across styles and preserves shipment data',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal)
    const changes=[first,second].map(s=>({styleId:s.id,expectedVersion:1,lines:[{lineId:s.production[0].id,color:s.production[0].color,quantities:{...zero,M:300}}]}))
    const firstResult=(await query<{result:unknown}>('select public.bulk_import_order_quantities($1::jsonb,$2,$3) result',[JSON.stringify(changes),'replace','오더 수량 일괄 교체'])).rows[0].result
    expect(Array.isArray(firstResult)).toBe(true)
    expect((await style()).production[0].order.M).toBe(300);expect((await style(second.id)).production[0].order.M).toBe(300)
    expect((await style()).production[0].shipped.M).toBe(10)
    changes.forEach(change=>{change.expectedVersion=2;change.lines[0].quantities.M=20})
    await query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify(changes),'add','추가 오더 반영'])
    expect((await style()).production[0].order.M).toBe(320);expect((await style()).version).toBe(3)
  }))
  it('rolls every import row and audit back if a later style has a stale version or wrong color',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal)
    const beforeAudits=(await query('select * from public.audits')).rows.length
    const changes=[first,second].map((s,index)=>({styleId:s.id,expectedVersion:index?99:1,lines:[{lineId:s.production[0].id,color:s.production[0].color,quantities:{...zero,M:999}}]}))
    await expect(query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify(changes),'replace','충돌 검증 일괄 입력'])).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await style()).production[0].order.M).toBe(first.production[0].order.M);expect((await style()).version).toBe(1)
    expect((await query('select * from public.audits')).rows).toHaveLength(beforeAudits)
    changes[1].expectedVersion=1;changes[1].lines[0].color='ZZ'
    await expect(query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify(changes),'replace','컬러 불일치 검증'])).rejects.toThrow(/line\/color/)
    expect((await style()).version).toBe(1)
  }))
  it('refuses factory imports, duplicate target lines, oversized add results and invalid sizes',async()=>isolated(async()=>{
    const change={styleId:first.id,expectedVersion:1,lines:[{lineId:first.production[0].id,color:first.production[0].color,quantities:{...zero,M:10000000}}]}
    await as(factoryUser);await expect(query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify([change]),'replace','공장 임의 오더'])).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.internal)
    await expect(query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify([change]),'add','상한 초과 입력'])).rejects.toThrow(/INVALID_QUANTITIES/)
    await expect(query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify([{...change,lines:[change.lines[0],change.lines[0]]}]),'replace','중복 행 입력'])).rejects.toThrow(/duplicate production/)
    change.lines[0].quantities.M=-1
    await expect(query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify([change]),'replace','음수 수량 입력'])).rejects.toThrow(/INVALID_QUANTITIES/)
  }))
  it('preserves all 16 ORDER QTY source columns and exact headers through PostgreSQL, with a separate source version',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal)
    const data=sourceInput(),saved=(await source(data)).rows[0]
    expect(saved.version).toBe(1);expect(saved.file_name).toBe('synthetic-order.xlsx');expect(saved.sheet_name).toBe('ORDER QTY')
    expect(saved.headers).toEqual(data.headers);expect(saved.rows_data).toEqual(data.rows)
    expect(Object.keys((saved.rows_data as OrderSourceData['rows'])[0].columns)).toHaveLength(16)
    expect((await style()).version).toBe(1)
    expect((await query('select * from public.order_source_records')).rows).toHaveLength(1)
  }))
  it('allows admin/internal manual source edits with CAS without silently changing order quantities',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const data=sourceInput();await source(data)
    await as(DEMO_IDS.admin);data.rows[0].columns.L='본사 수동 수정';data.rows[0].columns.AQ=99
    expect((await source(data,1)).rows[0].version).toBe(2)
    expect((await style()).production[0].order).toEqual(first.production[0].order)
    await expect(source(data,1)).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await query<{rows_data:OrderSourceData['rows']}>('select rows_data from public.order_source_records')).rows[0].rows_data[0].columns.L).toBe('본사 수동 수정')
  }))
  it('keeps source files, headers and cell values hidden from factories, including the shared audit trail',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);const data=sourceInput();data.rows[0].columns.L='HQ_SECRET_12345';data.fileName='HQ_PRIVATE_FILE.xlsx';await source(data)
    await as(factoryUser)
    expect((await query('select * from public.order_source_records')).rows).toHaveLength(0)
    await expect(source(data)).rejects.toThrow(/FORBIDDEN/)
    const audits=(await query<{before:unknown;after:unknown}>('select before,after from public.audits where action=$1',['오더 원본 정보 수정'])).rows
    expect(audits).toHaveLength(1);expect(JSON.stringify(audits)).not.toContain('HQ_SECRET');expect(JSON.stringify(audits)).not.toContain('HQ_PRIVATE')
    expect(audits[0].after).toEqual({styleId:first.id,lineId:first.production[0].id,version:1,rowCount:1})
    await as(DEMO_IDS.admin);await expect(query('delete from public.order_source_records')).rejects.toThrow(/permission denied/)
    await expect(query('select public.validate_order_source_data($1::jsonb)',[JSON.stringify(data)])).rejects.toThrow(/permission denied/)
  }))
  it('requires live approval and a valid active style/production line for source records',async()=>isolated(async()=>{
    await as(fixture.profiles.find(p=>!p.approved)!.id);await expect(source()).rejects.toThrow(/FORBIDDEN/)
    await as(DEMO_IDS.admin);await expect(source(sourceInput(),0,uid())).rejects.toThrow(/unknown production line/)
    await expect(source(sourceInput(),0,first.production[0].id,uid())).rejects.toThrow(/FORBIDDEN/)
    await query('select public.soft_delete_style($1,1,$2)',[first.id,'원본 접근 삭제 검증'])
    await expect(source()).rejects.toThrow(/FORBIDDEN/)
  }))
  it('rejects source formulas/objects, unsupported columns, invalid row numbers and oversized cells without partial writes',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal)
    const invalid:unknown[]=[]
    let d=sourceInput();(d.rows[0].columns as Record<string,unknown>).AZ='unknown';invalid.push(d)
    d=sourceInput();delete (d.headers as Partial<OrderSourceData['headers']>).AQ;invalid.push(d)
    d=sourceInput();(d.rows[0].columns as Record<string,unknown>).L={formula:'1+1',result:2};invalid.push(d)
    d=sourceInput();d.rows[0].columns.L='x'.repeat(4001);invalid.push(d)
    d=sourceInput();d.rows[0].columns.L=1000000000000001;invalid.push(d)
    d=sourceInput();d.rows[0].rowNumber=0;invalid.push(d)
    d=sourceInput();d.rows.push(structuredClone(d.rows[0]));invalid.push(d)
    d=sourceInput();d.rows=Array.from({length:101},(_,i)=>({...d.rows[0],rowNumber:i+1}));invalid.push(d)
    for(const bad of invalid) await expect(source(bad as OrderSourceData)).rejects.toThrow(/INVALID_/)
    expect((await query('select * from public.order_source_records')).rows).toHaveLength(0)
  }))
  it('imports quantity and source data atomically and still accepts earlier generic quantity-only imports',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal)
    const changes=[sourceChange(first),sourceChange(second)]
    await query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify(changes),'replace','전체 오더 원본 수량 등록'])
    expect((await style()).production[0].order.M).toBe(400)
    expect((await query('select * from public.order_source_records')).rows).toHaveLength(2)
    expect((await query<{rows_data:unknown}>('select rows_data from public.order_source_records where style_id=$1',[first.id])).rows[0].rows_data).toEqual(sourceInput().rows)
    const generic={...changes[0],expectedVersion:2,lines:[{lineId:first.production[0].id,color:first.production[0].color,quantities:{...zero,M:15}}]}
    await query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify([generic]),'add','기존 일반 양식 추가'])
    expect((await style()).production[0].order.M).toBe(415)
    expect((await query<{version:number}>('select version from public.order_source_records where style_id=$1',[first.id])).rows[0].version).toBe(1)
  }))
  it('rolls all quantities, source records and audits back when a later source snapshot is stale',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal);await source(sourceInput(),0,second.production[0].id,second.id)
    const beforeAudits=(await query('select * from public.audits')).rows.length
    await expect(query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify([sourceChange(first),sourceChange(second)]),'replace','원본 충돌 전체 취소'])).rejects.toThrow(/VERSION_CONFLICT/)
    expect((await style()).version).toBe(1);expect((await style(second.id)).version).toBe(1)
    expect((await query('select * from public.order_source_records')).rows).toHaveLength(1)
    expect((await query('select * from public.audits')).rows).toHaveLength(beforeAudits)
  }))
  it('accepts source-only refreshes with unchanged quantities and keeps row/cell text literal',async()=>isolated(async()=>{
    await as(DEMO_IDS.internal)
    const change=sourceChange(first);change.lines[0].quantities=structuredClone(first.production[0].order);change.lines[0].source.rows[0].columns.L='=SUM(1,2)'
    await query('select public.bulk_import_order_quantities($1::jsonb,$2,$3)',[JSON.stringify([change]),'replace','수량 동일 원본만 저장'])
    expect((await style()).production[0].order).toEqual(first.production[0].order)
    expect((await query<{rows_data:OrderSourceData['rows']}>('select rows_data from public.order_source_records')).rows[0].rows_data[0].columns.L).toBe('=SUM(1,2)')
  }))
  it('applies aligned PO length limits at the server boundary',async()=>isolated(async()=>{
    await as(DEMO_IDS.admin);await po(uid(),{...poInput(),subject:'x'.repeat(500),body:'x'.repeat(20000)})
    await expect(po(uid(),{...poInput(),subject:'x'.repeat(501)})).rejects.toThrow(/INVALID_OPERATION/)
    await expect(po(uid(),{...poInput(),body:'x'.repeat(20001)})).rejects.toThrow(/INVALID_OPERATION/)
  }))

  it('restricts administrators to activating existing fixed kinds with CAS and rejects additions or renames',async()=>isolated(async()=>{
    await as(DEMO_IDS.admin)
    await expect(query('select public.save_operation_catalog($1,$2,$3,true,0,$4)',[uid(),'label','임의 신규 라벨','정해진 종류 검증'])).rejects.toThrow(/INVALID_CATALOG/)
    await expect(query('select public.save_operation_catalog($1,$2,$3,true,1,$4)',[labelCatalog,'label','임의 변경 라벨','정해진 명칭 검증'])).rejects.toThrow(/HISTORY_PROTECTED/)
    await expect(query('select public.save_operation_catalog($1,$2,$3,true,1,$4)',[labelCatalog,'embroidery',labelName,'정해진 분류 검증'])).rejects.toThrow(/HISTORY_PROTECTED/)
    const disabled=(await query('select * from public.save_operation_catalog($1,$2,$3,false,1,$4)',[labelCatalog,'label',labelName,'정해진 종류 사용 중지'])).rows[0]
    expect(disabled.active).toBe(false);expect(disabled.version).toBe(2);expect(disabled.name).toBe(labelName)
    await expect(query('select public.save_operation_catalog($1,$2,$3,true,1,$4)',[labelCatalog,'label',labelName,'오래된 종류 설정 검증'])).rejects.toThrow(/VERSION_CONFLICT/)
    const enabled=(await query('select * from public.save_operation_catalog($1,$2,$3,true,2,$4)',[labelCatalog,'label',labelName,'정해진 종류 사용 재개'])).rows[0]
    expect(enabled.active).toBe(true);expect(enabled.version).toBe(3);expect(enabled.name).toBe(labelName)
    expect((await query('select * from public.operation_catalogs')).rows).toHaveLength(56)
  }))

})
