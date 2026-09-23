type BrandLogoProps = {
  size?: number
  wordmark?: boolean
}

/**
 * 品牌标记：双笔画沿用「薄荷绿 / 灰紫」的分工 —— 品牌资产不参与
 * 「导航图标只在选中时上色」的规则，它是导航里唯一的常驻彩色，用于标识身份。
 * 颜色一律从设计令牌取值而非写死十六进制——否则换配色时它会成为
 * 界面上唯一残留旧色的地方，和周围的新强调色互相打架。
 *
 * 这里刻意用「薄荷绿原值」（--p-positive-bright-rgb）而不是文字用的
 * --mm-color-jade：logo 是 8px 笔画的实心图形，要的是鲜明的薄荷色；
 * 压暗版是给白底文字保证对比度的。
 * SVG 的呈现属性（fill= / stroke=）不解析 var()，所以走内联样式。
 */
export function BrandLogo({ size = 38, wordmark = false }: BrandLogoProps): React.JSX.Element {
  const strand = { stroke: 'rgb(var(--p-positive-bright-rgb))' }
  const spine = { stroke: 'var(--mm-color-iris)' }
  return (
    <div className="brand-lockup" aria-label="MindMesh">
      <svg width={size} height={size} viewBox="0 0 64 64" role="img" aria-hidden="true">
        <path d="M10 48V23C10 15 18 12 24 18L49 43" fill="none" style={strand} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M54 48V23C54 15 46 12 40 18L15 43" fill="none" style={spine} strokeWidth="8" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="11" cy="34" r="5" style={{ fill: 'rgb(var(--p-positive-bright-rgb))' }} />
        <circle cx="32" cy="32" r="6" style={{ fill: 'var(--mm-color-iris)', stroke: 'var(--mm-color-midnight)' }} strokeWidth="2" />
        <circle cx="53" cy="43" r="5" style={{ fill: 'var(--p-raised)', stroke: 'var(--mm-color-midnight)' }} strokeWidth="2" />
      </svg>
      {wordmark && <span style={{ color: 'var(--text-primary)' }}>MindMesh</span>}
    </div>
  )
}
