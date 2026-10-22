import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
class ErrorBoundary extends Component<{ children: ReactNode }, { error: string }> {
  state = { error: '' }
  static getDerivedStateFromError(error: Error) { return { error: error.message } }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Render a usable recovery screen; never dump data or credentials. */ }
  render() { if (this.state.error) return <div className="setup-screen"><div className="panel setup-panel"><h1>화면을 표시하지 못했습니다.</h1><p>화면을 새로고침해 다시 시도해 주세요. 계속되면 관리자에게 아래 오류를 전달해 주세요.</p><pre>{this.state.error}</pre><button className="button button-primary" onClick={() => window.location.reload()}>다시 불러오기</button></div></div>; return this.props.children }
}
createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App/></ErrorBoundary></StrictMode>)
