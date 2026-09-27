import type { ModelProviderId } from '../../shared/contracts'
import anthropicLogo from './assets/providers/anthropic.svg'
import deepseekLogo from './assets/providers/deepseek.svg'
import kimiLogo from './assets/providers/kimi.png'
import minimaxLogo from './assets/providers/minimax.svg'
import openaiLogo from './assets/providers/openai.svg'
import qwenLogo from './assets/providers/qwen.svg'
import stepfunLogo from './assets/providers/stepfun.svg'
import zhipuLogo from './assets/providers/zhipu.svg'

const providerLogos: Partial<Record<ModelProviderId, string>> = {
  'deepseek-official': deepseekLogo,
  'moonshotai-cn': kimiLogo,
  openai: openaiLogo,
  anthropic: anthropicLogo,
  minimax: minimaxLogo,
  zhipu: zhipuLogo,
  qwen: qwenLogo,
  stepfun: stepfunLogo,
}

export function getProviderLogo(provider: ModelProviderId | string): string | undefined {
  return providerLogos[provider as ModelProviderId]
}
