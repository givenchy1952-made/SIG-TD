import { describe, expect, it } from 'vitest'
import { getPublicAppUrl } from '../src/lib/public-app-url'

describe('업체에게 전달하는 고정 접속 주소', () => {
  it('공개 주소가 없으면 배포 미리보기의 현재 주소 대신 운영 주소를 쓴다', () => {
    expect(getPublicAppUrl('')).toBe('https://sig-td.vercel.app')
  })

  it('설정한 공개 주소를 쓰고 검색값과 문서 위치는 전달하지 않는다', () => {
    expect(getPublicAppUrl('https://production.example.test/app/?preview=private#draft')).toBe('https://production.example.test/app')
  })

  it.each(['invalid-url', 'javascript:alert(1)', 'https://user:secret@example.test'])('잘못된 공개 주소는 운영 주소로 대체한다: %s', configured => {
    expect(getPublicAppUrl(configured)).toBe('https://sig-td.vercel.app')
  })
})
