type BrandLogoProps = {
  size?: number
  wordmark?: boolean
  inverse?: boolean
}

export function BrandLogo({ size = 38, wordmark = false, inverse = false }: BrandLogoProps): React.JSX.Element {
  const ink = inverse ? '#F7F8F6' : '#172033'
  return (
    <div className="brand-lockup" aria-label="MindMesh">
      <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-hidden="true">
        <path d="M10 48V23C10 15 18 12 24 18L49 43" fill="none" stroke="#1E9E8F" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M54 48V23C54 15 46 12 40 18L15 43" fill="none" stroke="#4F56D9" strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="11" cy="34" r="5" fill="#1E9E8F" />
        <circle cx="32" cy="32" r="6" fill="#4F56D9" stroke="#172033" strokeWidth="2" />
        <circle cx="53" cy="43" r="5" fill="#F7F8F6" stroke="#172033" strokeWidth="2" />
      </svg>
      {wordmark && <span style={{ color: ink }}>MindMesh</span>}
    </div>
  )
}

