import logo from '../assets/significant-adererror.png'
import './brand-logo.css'

export default function BrandLogo({ tone = 'ink' }: { tone?: 'ink' | 'white' }) {
  // Frame each raster wordmark without the poster margin, retaining the
  // reference lockup's centered secondary mark and generous line spacing.
  return <svg className={`brand-logo brand-logo-${tone}`} viewBox="0 0 1800 494" width={1800} height={494} role="img" aria-label="Significant / ADERERROR" focusable="false">
    <svg x={0} y={0} width={1800} height={242} viewBox="128 214 1800 242" overflow="hidden">
      <image href={logo} width={2055} height={765}/>
    </svg>
    <svg x={572} y={402} width={656} height={92} viewBox="693 480 656 92" overflow="hidden">
      <image href={logo} width={2055} height={765}/>
    </svg>
  </svg>
}
