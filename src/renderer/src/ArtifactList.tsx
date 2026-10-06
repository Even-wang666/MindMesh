import { useState } from 'react'
import type { Artifact } from '../../shared/contracts'

export function ArtifactList({
  artifacts,
  title,
}: {
  artifacts: Artifact[]
  title?: string
}): React.JSX.Element | null {
  const [error, setError] = useState('')
  if (!artifacts.length) return null
  return (
    <section className="artifact-list" aria-label={title ?? '成果文件'}>
      {title && <strong>{title}</strong>}
      {artifacts.map((artifact) => (
        <div className="artifact-file" key={artifact.id}>
          <div>
            <strong>{artifact.name}</strong>
            <span>{artifact.type === 'generated_file' ? '新建文件' : '已修改'}</span>
            <small title={artifact.path}>{artifact.path}</small>
          </div>
          <button
            className="ghost-button compact"
            aria-label={`在文件夹中显示 ${artifact.name}`}
            onClick={() => {
              setError('')
              void window.mindmesh.chat
                .revealArtifact(artifact.id)
                .catch(() => setError('无法定位文件：文件可能已被移动或删除。'))
            }}
          >
            在文件夹中显示
          </button>
        </div>
      ))}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

export function ExecutionOutputs({
  artifacts,
  title = '本次协作成果',
}: {
  artifacts: Artifact[]
  title?: string
}): React.JSX.Element | null {
  if (!artifacts.length) return null
  const executions = [...new Set(artifacts.map((item) => item.executionId))]
  return (
    <div className="execution-outputs">
      {executions.map((executionId, index) => {
        const outputs = artifacts.filter((item) => item.executionId === executionId)
        const agents = [...new Set(outputs.map((item) => item.agentId))]
        return (
          <details key={executionId} open={index === executions.length - 1}>
            <summary>
              {title} · {outputs.length} 项
            </summary>
            {agents.map((agentId) => {
              const files = outputs.filter((item) => item.agentId === agentId)
              return (
                <ArtifactList
                  key={agentId ?? 'execution'}
                  artifacts={files}
                  title={files[0].agentName ?? '协作成果'}
                />
              )
            })}
          </details>
        )
      })}
    </div>
  )
}
