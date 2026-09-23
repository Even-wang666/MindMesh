const prefix = 'skill:'

export function createSkillReference(id: string, name: string): string {
  return `${prefix}${encodeURIComponent(id)}#${encodeURIComponent(name)}`
}

export function parseSkillReference(value: string): { id: string; name: string } | undefined {
  if (!value.startsWith(prefix)) return undefined
  const separator = value.indexOf('#', prefix.length)
  if (separator < 0) return undefined
  try {
    return {
      id: decodeURIComponent(value.slice(prefix.length, separator)),
      name: decodeURIComponent(value.slice(separator + 1)),
    }
  } catch {
    return undefined
  }
}

export function skillDisplayName(value: string): string {
  return parseSkillReference(value)?.name ?? value
}
