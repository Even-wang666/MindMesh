import type { ModelOption } from '../../shared/contracts'
import { getModelContextWindow } from '../../shared/model-providers'

export function displayModelName(model: string): string {
  if (model === 'deepseek-v4-flash' || model === 'deepseek-v4-flash-vision-exp') return 'DeepSeek V4.1 Flash'
  return model.split(/[-_]/).map((part) => part ? part[0].toUpperCase() + part.slice(1) : '').join(' ')
}

export function modelsForProvider(provider: string | undefined, selectedModel: string, configuredModel: string | undefined, models: ModelOption[]): ModelOption[] {
  if (!provider) return []
  const available = models.filter((item) => item.provider === provider)
  for (const id of [configuredModel, selectedModel]) {
    if (id && !available.some((item) => item.id === id)) {
      available.push({ provider, id, name: displayModelName(id), contextWindow: getModelContextWindow(provider, id) })
    }
  }
  return available.filter((item, index) => available.findIndex((candidate) => candidate.name === item.name) === index)
}

