/**
 * Map a DSH tool name onto a user-facing label and a present-tense action
 * phrase for the runtime status line.
 *
 * The spike captured tool/call names verbatim from the wire (`pwsh`,
 * `job_output`), which are internal identifiers. They must not surface raw in
 * the Tool Card or the "doing what" status (§8 Runtime Status UX). Unknown
 * names fall back to the identifier itself so a future tool degrades to
 * something readable rather than nothing.
 */

const TOOL_LABELS: Record<string, string> = {
  pwsh: '执行命令',
  bash: '执行命令',
  job_output: '查看后台任务输出',
  jobs: '后台任务',
  read: '读取文件',
  write: '写入文件',
  edit: '编辑文件',
  list_files: '查看文件',
  glob: '查找文件',
  grep: '搜索文件内容',
  web_search: '搜索网页',
  web: '搜索网页',
  browser: '操作浏览器',
  todo: '更新待办清单',
  goal: '维护目标',
  subagent: '委派子代理',
  skill: '调用技能',
  workspace: '访问工作目录',
}

/** The human-readable name for a DSH tool, falling back to the raw id. */
export function toolDisplayName(toolName: string): string {
  return TOOL_LABELS[toolName] ?? toolName
}

/** The present-tense action phrase for the runtime status line. */
export function toolStatusPhrase(toolName: string): string {
  const label = toolDisplayName(toolName)
  // Labels are already verb phrases; the status line prefixes "正在".
  return `正在${label}`
}
