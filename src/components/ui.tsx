import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { STATUS_LABEL, type Status } from '../lib/types'
export function Badge({ status, label }: { status: Status; label?: string }) { return <span className={`badge badge-${status}`}><span className="status-dot"/>{label || STATUS_LABEL[status]}</span> }
export function Modal({ title, children, onClose, wide = false }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) { return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}><section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}><header className="modal-header"><h2>{title}</h2><button className="icon-button" aria-label="닫기" onClick={onClose}><X size={20}/></button></header>{children}</section></div> }
