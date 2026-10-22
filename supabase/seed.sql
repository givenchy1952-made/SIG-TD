-- OPTIONAL DEVELOPMENT DATA ONLY. Never run on a production project.
-- No auth.users/passwords are created. First sign up and bootstrap an admin.
-- Re-running this file preserves existing rows and user changes.
begin;
insert into public.factories(id,name,country) values
 ('90000000-0000-4000-8000-000000000001','[예시] 중국 A 공장','중국'),
 ('90000000-0000-4000-8000-000000000002','[예시] 베트남 B 공장','베트남')
on conflict (id) do nothing;
insert into public.projects(id,name,season) values
 ('91000000-0000-4000-8000-000000000001','[예시] SIG 2026 FALL / WINTER','2026FW')
on conflict (id) do nothing;
do $$
declare admin_id uuid; d jsonb; quantities jsonb; checks jsonb; line jsonb;
begin
  select id into admin_id from public.profiles where role='admin' and approved and active order by id limit 1;
  if admin_id is null then
    raise notice 'Example factories/projects created. Sign up and bootstrap an admin, then rerun this file to add an example style.';
    return;
  end if;
  if exists(select 1 from public.styles where id='92000000-0000-4000-8000-000000000001') then return; end if;
  perform set_config('request.jwt.claim.sub',admin_id::text,true);
  quantities:='{"XXS":0,"XS":0,"S":0,"M":0,"L":0,"XL":0}'::jsonb;
  checks:='{"tp":"done","pp":"todo","gb":"progress","labels":"todo","care":"unset","materials":"done","packing":"unset","main":"unset","quality":"unset","packingList":"unset"}'::jsonb;
  line:=jsonb_build_object('id','93000000-0000-4000-8000-000000000001','color','BK',
    'order',jsonb_build_object('XXS',10,'XS',20,'S',40,'M',60,'L',40,'XL',20),
    'shipped',quantities,'received',quantities,'packing',quantities,'checks',checks,
    'confirmDue',(current_date+7)::text,'shippedAt','','receivedAt','','invoice','unset','invoiceAmount',0,
    'paymentDue','','paymentStatus','unset','measurements','','factoryComment','체험용 예시입니다.');
  d:=jsonb_build_object(
    'id','92000000-0000-4000-8000-000000000001','code','EXAMPLE-JK1601','name','[예시] DENIM JACKET',
    'category','OUTER','season','2026FW','projectId','91000000-0000-4000-8000-000000000001',
    'factoryId','90000000-0000-4000-8000-000000000001','ownerId',admin_id,'colors',jsonb_build_array('BK'),
    'dueDate',(current_date+21)::text,'stage','sampleN','ppApproved',false,
    'notes','예시 데이터입니다. 실제 생산 수량·결제 자료가 아닙니다.',
    'samples',jsonb_build_array(
      jsonb_build_object('id','94000000-0000-4000-8000-000000000001','round',1,'isPP',false,'status','done',
        'factoryId','90000000-0000-4000-8000-000000000001','ownerId',admin_id,'requestedAt',(current_date-14)::text,
        'plannedAt',(current_date-7)::text,'completedAt',(current_date-7)::text,'shippedAt',(current_date-6)::text,
        'receivedAt',(current_date-4)::text,'reviewedAt',(current_date-3)::text,'tracking','EXAMPLE-TRACKING',
        'request','[예시] 암홀 치수 및 워싱 컬러 조정','factoryComment','[예시] 수정 내용 확인','updatedAt',''),
      jsonb_build_object('id','94000000-0000-4000-8000-000000000002','round',2,'isPP',false,'status','progress',
        'factoryId','90000000-0000-4000-8000-000000000001','ownerId',admin_id,'requestedAt',(current_date-2)::text,
        'plannedAt',(current_date+5)::text,'completedAt','','shippedAt','','receivedAt','','reviewedAt','','tracking','',
        'request','[예시] 2차 샘플 확인 요청','factoryComment','[예시] 패턴 수정 완료','updatedAt','')
    ),'production',jsonb_build_array(line),'version',0,'updatedAt','','updatedBy',admin_id,'deletedAt',null
  );
  perform public.save_style('92000000-0000-4000-8000-000000000001',d,0,'개발용 예시 데이터 등록');
end $$;
commit;
