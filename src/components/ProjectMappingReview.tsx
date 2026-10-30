import type { Workspace } from '../lib/types'
import { buildProjectMappingSuggestions, getProjectIdentity, type ProjectMappingSuggestion } from '../lib/project-identity'
import './project-mapping-review.css'

/** Review only: opening the panel never writes project metadata or style links. */
export default function ProjectMappingReview({ workspace, disabled, onReview }: { workspace: Workspace; disabled: boolean; onReview: (suggestion: ProjectMappingSuggestion) => void }) {
  const suggestions = buildProjectMappingSuggestions(workspace).filter(item => item.status === 'ready' || item.status === 'conflict')
  return <section className="project-mapping-review" aria-label="오더 원본 프로젝트 매핑 검토">
    <div className="section-heading"><div><h3>오더 원본 프로젝트 매핑 검토</h3><p className="muted">기존 프로젝트에 연결된 오더 원본의 A열 코드·M열 명칭·L열 시즌을 비교합니다. 검토 후 저장할 때만 누락 정보를 보완하며, 프로젝트와 스타일 연결은 유지합니다.</p></div></div>
    {suggestions.length ? <div className="project-mapping-candidates">{suggestions.map(item => <article key={item.projectId} className="project-mapping-candidate">
      <div><strong>{getProjectIdentity(workspace, item.projectId).label}</strong><span className="pill">{item.status === 'ready' ? '보완 가능' : '확인 필요'}</span><p className="muted">{item.sources.length}개 원본 행 · {[...new Set(item.sources.map(source => source.fileName))].join(', ')}</p></div>
      {item.status === 'ready' ? <><dl><div><dt>프로젝트 명칭 · M열</dt><dd>{item.proposed.name}</dd></div><div><dt>프로젝트 코드 · A열</dt><dd>{item.proposed.code}</dd></div><div><dt>시즌 · L열</dt><dd>{item.proposed.season}</dd></div></dl><button type="button" className="button" aria-label={`${getProjectIdentity(workspace, item.projectId).label} 매핑 검토`} disabled={disabled || !workspace.refinementsAvailable} onClick={() => onReview(item)}>매핑 검토</button></> : <ul>{item.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
    </article>)}</div> : <p className="muted">원본으로 보완할 누락 정보나 충돌이 없습니다. 원본이 없는 프로젝트는 기존 명칭·코드를 유지합니다.</p>}
  </section>
}
