import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSeed, DEMO_IDS } from '../src/lib/seed'

const mock = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../src/lib/repository', () => ({ supabase: { rpc: mock.rpc }, getDemoWorkspace: vi.fn(), locked: vi.fn(), persist: vi.fn(), cloudStyle: (row: Record<string, unknown>) => ({ ...(row.data as object), id: row.id, version: Number(row.version), updatedAt: row.updated_at, updatedBy: row.updated_by, deletedAt: row.deleted_at }) }))
import { confirmMainProductionReceipt, loadMainProductionSync, saveMainProductionStyle } from '../src/lib/production-movements-repository'
import { emptyQuantities } from '../src/lib/types'

const w = createSeed(), style = w.styles[1], actor = w.profiles.find(item => item.id === DEMO_IDS.admin)!
const raw = { id: style.id, data: style, version: style.version + 1, updated_at: '2026-11-09T00:00:00Z', updated_by: actor.id, deleted_at: null }
const client = () => ({ rpc: mock.rpc }) as unknown as SupabaseClient
beforeEach(() => mock.rpc.mockReset())

describe('메인 생산 출입고 연동 서버 경계', () => {
  it('기능 미설치·금지 계정은 출고 연결 정보를 추가 조회하지 않는다', async () => {
    for (const response of [{ data: false, error: null }, { data: null, error: { code: 'PGRST202' } }]) {
      mock.rpc.mockReset().mockResolvedValue(response)
      expect(await loadMainProductionSync(client())).toEqual({ mainProductionSyncAvailable: false, shipmentAdjustments: [] })
      expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('get_main_production_sync_capability')
    }
  })
  it('서버가 권한 범위를 제한한 출고 연결을 행 제한 없는 단일 RPC로 읽는다', async () => {
    const rows = Array.from({ length: 1100 }, (_, id) => ({ id: String(id) }))
    mock.rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: { shipmentAdjustments: rows }, error: null })
    expect(await loadMainProductionSync(client())).toEqual({ mainProductionSyncAvailable: true, shipmentAdjustments: rows })
    expect(mock.rpc.mock.calls).toEqual([['get_main_production_sync_capability'], ['get_main_production_sync']])
  })
  it('권한 회수·통신 오류·잘못된 응답을 설정 누락으로 숨기지 않는다', async () => {
    const denied = { code: '42501', message: 'revoked' }
    mock.rpc.mockResolvedValue({ data: null, error: denied })
    await expect(loadMainProductionSync(client())).rejects.toEqual(denied)
    mock.rpc.mockResolvedValueOnce({ data: true, error: null }).mockResolvedValueOnce({ data: null, error: null })
    await expect(loadMainProductionSync(client())).rejects.toThrow(/연결 정보/)
  })
  it('일반 저장은 스타일 전체·버전·사유를 보내고 인증 역할을 직접 보내지 않는다', async () => {
    mock.rpc.mockResolvedValue({ data: raw, error: null })
    expect(await saveMainProductionStyle(style, '출고 수량 확인', actor)).toMatchObject({ id: style.id, version: style.version + 1 })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('save_main_production_style', { p_id: style.id, p_data: style, p_expected_version: style.version, p_reason: '출고 수량 확인' })
  })
  it('입고 요청을 하나의 원자적 호출로 보내고 실제 저장 스타일과 추가 수량을 반환한다', async () => {
    const request = { requestId: crypto.randomUUID(), styleId: style.id, lineId: style.production[0].id, runId: crypto.randomUUID(), expectedStyleVersion: style.version, expectedRunVersion: 1, style }
    const added = { ...emptyQuantities(), M: 250 }
    mock.rpc.mockResolvedValue({ data: { style: raw, receiptId: request.requestId, added, runVersion: 2 }, error: null })
    expect(await confirmMainProductionReceipt(request, '실입고 확인', actor)).toMatchObject({ style: { id: style.id, version: style.version + 1 }, receiptId: request.requestId, added, runVersion: 2 })
    expect(mock.rpc).toHaveBeenCalledExactlyOnceWith('confirm_main_production_receipt', { p_request: request, p_reason: '실입고 확인' })
  })
  it('버전 충돌·설정 누락·결과 미확인을 가짜 저장 성공으로 처리하지 않는다', async () => {
    const conflict = { code: '40001', message: 'VERSION_CONFLICT' }
    mock.rpc.mockResolvedValue({ data: null, error: conflict })
    await expect(saveMainProductionStyle(style, '출고 수량 확인', actor)).rejects.toEqual(conflict)
    mock.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202' } })
    await expect(saveMainProductionStyle(style, '출고 수량 확인', actor)).rejects.toThrow(/026_main_production_sync/)
    mock.rpc.mockResolvedValue({ data: { version: 2 }, error: null })
    await expect(saveMainProductionStyle(style, '출고 수량 확인', actor)).rejects.toThrow(/저장 결과/)
  })
})
