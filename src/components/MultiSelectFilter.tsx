import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search, X } from 'lucide-react'
import './multi-select-filter.css'

export interface MultiSelectFilterOption { value: string; label: string }
export interface MultiSelectFilterProps {
  label: string
  options: MultiSelectFilterOption[]
  value: string[] | null
  onChange: (value: string[] | null) => void
  allLabel: string
  disabled?: boolean
  className?: string
}

/** null means all values, [] deliberately means no values. Selections within
 * this filter are alternatives; the page combines separate filters. */
export default function MultiSelectFilter({ label, options, value, onChange, allLabel, disabled = false, className = '' }: MultiSelectFilterProps) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [position, setPosition] = useState<CSSProperties>({ visibility: 'hidden' })
  const trigger = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const allCheckbox = useRef<HTMLInputElement>(null)
  const id = useId()
  const panelId = `${id}-options`, hintId = `${id}-hint`
  const choices = useMemo(() => [...new Map(options.map(option => [option.value, option])).values()], [options])
  const selected = useMemo(() => value === null ? new Set(choices.map(option => option.value)) : new Set(value), [value, choices])
  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    return needle ? choices.filter(option => option.label.toLocaleLowerCase().includes(needle)) : choices
  }, [choices, query])
  const selectedCount = choices.filter(option => selected.has(option.value)).length
  const allSelected = value === null || choices.length > 0 && selectedCount === choices.length
  const selectedLabels = choices.filter(option => selected.has(option.value)).map(option => option.label)
  const summary = value === null ? allLabel : selectedCount === 0 ? '선택 없음' : selectedCount === 1 ? selectedLabels[0] : `${selectedLabels[0]} 외 ${selectedCount - 1}개`

  const close = useCallback((restoreFocus = true) => {
    setOpen(false)
    if (restoreFocus) trigger.current?.focus()
  }, [])

  const locate = useCallback(() => {
    if (!trigger.current) return
    const rect = trigger.current.getBoundingClientRect()
    const viewportWidth = document.documentElement.clientWidth
    const viewportHeight = window.visualViewport?.height || window.innerHeight
    const margin = 12, gap = 6
    if (rect.bottom < 0 || rect.top > viewportHeight) { close(false); return }
    const width = Math.min(Math.max(280, rect.width), Math.max(0, viewportWidth - margin * 2))
    const left = Math.max(margin, Math.min(rect.left, viewportWidth - width - margin))
    const below = viewportHeight - rect.bottom - margin - gap
    const above = rect.top - margin - gap
    const useBelow = below >= 240 || below >= above
    setPosition({
      width, left,
      ...(useBelow ? { top: rect.bottom + gap } : { bottom: window.innerHeight - rect.top + gap }),
      maxHeight: Math.max(100, Math.min(420, useBelow ? below : above)),
      visibility: 'visible',
    })
  }, [close])

  useLayoutEffect(() => { if (open) locate() }, [open, locate, shown.length, selectedCount])
  useEffect(() => {
    if (allCheckbox.current) allCheckbox.current.indeterminate = !allSelected && selectedCount > 0
  }, [allSelected, selectedCount, open])
  useEffect(() => {
    if (!open) return
    search.current?.focus()
    const outside = (event: PointerEvent) => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false)
    }
    const focusOutside = (event: FocusEvent) => {
      const target = event.target as Node
      if (!panel.current?.contains(target) && !trigger.current?.contains(target)) close(false)
    }
    const scroll = (event: Event) => {
      if (!(event.target instanceof Node) || !panel.current?.contains(event.target)) locate()
    }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('focusin', focusOutside, true)
    window.addEventListener('resize', locate)
    window.addEventListener('scroll', scroll, true)
    window.visualViewport?.addEventListener('resize', locate)
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('focusin', focusOutside, true)
      window.removeEventListener('resize', locate)
      window.removeEventListener('scroll', scroll, true)
      window.visualViewport?.removeEventListener('resize', locate)
    }
  }, [open, close, locate])
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])

  function toggle(option: MultiSelectFilterOption) {
    const next = new Set(selected)
    if (next.has(option.value)) next.delete(option.value)
    else next.add(option.value)
    onChange(choices.filter(item => next.has(item.value)).map(item => item.value))
  }
  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
    if (event.key === 'Tab') {
      const focusable = [...(panel.current?.querySelectorAll<HTMLElement>('input:not(:disabled),button:not(:disabled)') || [])]
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); close() }
      else if (!event.shiftKey && document.activeElement === focusable.at(-1)) { close() }
    }
    if (event.key === 'ArrowDown' && document.activeElement === search.current) {
      event.preventDefault()
      panel.current?.querySelector<HTMLInputElement>('.multi-select-filter-options input')?.focus()
    }
  }

  return <div className={`multi-select-filter ${className}`} data-filtered={value !== null || undefined}>
    <button ref={trigger} type="button" className="multi-select-filter-trigger" aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? panelId : undefined} title={value === null ? allLabel : `${label}: ${selectedLabels.join(', ') || '선택 없음'}`} disabled={disabled} onClick={() => { if (open) close(); else { setQuery(''); setPosition({ visibility: 'hidden' }); setOpen(true) } }}>
      <span>{summary}</span>{value !== null && <small>{selectedCount}</small>}<ChevronDown size={14}/>
    </button>
    {open && createPortal(<div ref={panel} id={panelId} className="multi-select-filter-popover" style={position} role="dialog" aria-label={`${label} 선택`} aria-describedby={hintId} onKeyDownCapture={handleKey}>
      <div className="multi-select-filter-heading"><strong>{label}</strong><button type="button" className="multi-select-filter-close" aria-label={`${label} 닫기`} onClick={() => close()}><X size={15}/></button></div>
      <p id={hintId} className="multi-select-filter-hint">여러 항목을 선택할 수 있습니다. 같은 필터에서 선택한 항목은 함께 표시됩니다.</p>
      <label className="multi-select-filter-search"><Search size={14}/><input ref={search} type="search" aria-label={`${label} 검색`} value={query} onChange={event => setQuery(event.target.value)} placeholder="항목 검색" autoComplete="off"/></label>
      <label className="multi-select-filter-all"><input ref={allCheckbox} type="checkbox" aria-label="전체선택" checked={allSelected} onChange={() => onChange(allSelected ? [] : null)}/><span>전체 선택</span><small>{selectedCount} / {choices.length}</small></label>
      <div className="multi-select-filter-options">
        {shown.map(option => <label key={option.value} title={option.label}><input type="checkbox" aria-label={option.label} checked={selected.has(option.value)} onChange={() => toggle(option)}/><span>{option.label}</span></label>)}
        {!shown.length && <p>{choices.length ? '검색 결과가 없습니다.' : '선택할 항목이 없습니다.'}</p>}
      </div>
      <div className="multi-select-filter-footer"><button type="button" onClick={() => onChange(null)}>전체보기</button><button type="button" onClick={() => onChange([])}>선택해제</button><button type="button" className="multi-select-filter-done" onClick={() => close()}>완료</button></div>
    </div>, document.body)}
  </div>
}
