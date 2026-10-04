import type { CSSProperties, ReactNode } from 'react'

export function Field({
  label,
  children,
}: {
  label: string
  children: ReactNode
}): React.JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function avatarInitials(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) return 'M'
  if (/^[\p{Script=Latin}\p{N}]/u.test(trimmed)) {
    const words = trimmed.split(/[\s._-]+/).filter(Boolean)
    const initials = words.length > 1 ? words[0][0] + words[1][0] : trimmed.slice(0, 2)
    return initials.toUpperCase()
  }
  return Array.from(trimmed).slice(0, 2).join('')
}

function avatarTone(name: string): number {
  let hash = 0
  for (const character of name.trim()) hash = (hash * 31 + (character.codePointAt(0) ?? 0)) % 100003
  return Number(((hash % 1000) / 1000).toFixed(3))
}

export function Avatar({
  name,
  image,
  large = false,
}: {
  name: string
  image?: string | null
  large?: boolean
}): React.JSX.Element {
  return (
    <span
      className={large ? 'avatar large' : 'avatar'}
      style={{ '--avatar-t': avatarTone(name) } as CSSProperties}
      aria-hidden="true"
    >
      {image ? <img src={image} alt="" /> : avatarInitials(name)}
    </span>
  )
}
