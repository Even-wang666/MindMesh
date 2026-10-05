import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { MindMeshDatabase, runtimeContextKey } from '../src/main/database'
import { createSkillReference } from '../src/shared/skill-reference'
import { getAgentCapabilityHash } from '../src/main/agent-capability'

describe('starter examples', () => {
  it('provides practical multi-Agent teams and does not recreate deleted examples', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-examples-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    try {
      expect(db.listAgents().map((agent) => agent.name)).toEqual(
        expect.arrayContaining([
          'Researcher',
          'Developer',
          'Product Manager',
          'Project Coordinator',
          'Study Coach',
          'English Tutor',
          'Fitness Coach',
          'Meal Planner',
          'Travel Planner',
        ])
      )
      expect(db.listSpaces().map((space) => space.name)).toEqual(
        expect.arrayContaining([
          'AI Product Research',
          'Product Delivery Squad',
          'Study Growth Circle',
          'Healthy Living Plan',
          'Weekend Trip Crew',
        ])
      )
      expect(db.getAgent('starter-v2-product-manager')?.skills).toEqual([
        createSkillReference('mindmesh-builtin-user-story-writer-v1', '用户故事'),
        createSkillReference('mindmesh-builtin-project-planner-v1', '项目规划'),
      ])
      expect(db.getAgent('starter-v2-study-coach')?.skills).toEqual([
        createSkillReference('mindmesh-builtin-study-plan-builder-v1', '学习计划'),
      ])
      expect(db.getAgent('starter-v2-english-tutor')?.skills).toEqual([
        createSkillReference('mindmesh-builtin-language-tutor-v1', '语言辅导'),
      ])
      expect(db.getAgent('starter-v2-fitness-coach')?.skills).toEqual([
        createSkillReference('mindmesh-builtin-workout-planner-v1', '训练计划'),
      ])
      expect(db.getAgent('starter-v2-meal-planner')?.skills).toEqual([
        createSkillReference('mindmesh-builtin-meal-plan-builder-v1', '餐单规划'),
      ])
      expect(db.getAgent('starter-v2-travel-planner')?.skills).toEqual([
        createSkillReference('mindmesh-builtin-trip-planner-v1', '旅行规划'),
      ])
      const life = db.listSpaces().find((space) => space.name === 'Healthy Living Plan')!
      expect(life.context).toContain('饮食')
      expect(life.memberIds).toHaveLength(2)
      db.removeSpace(life.id)
    } finally {
      db.close()
    }

    const reopened = new MindMeshDatabase(path)
    try {
      expect(reopened.listSpaces().some((space) => space.name === 'Healthy Living Plan')).toBe(
        false
      )
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('preserves deleted legacy examples and isolates starter data from name collisions on upgrade', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-examples-upgrade-'))
    const path = join(directory, 'mindmesh.sqlite')
    new MindMeshDatabase(path).close()
    const old = new DatabaseSync(path)
    old.exec(`PRAGMA foreign_keys = ON;
      DELETE FROM app_meta WHERE key = 'starterExamplesV2';
      DELETE FROM spaces WHERE id LIKE 'starter-v2-%' OR id = 'starter-v1-ai-product-research';
      DELETE FROM agents WHERE id LIKE 'starter-v2-%' OR id LIKE 'starter-v1-%';`)
    old
      .prepare(`INSERT INTO agents
      (id, name, role, persona, provider, model, skills, tools, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'custom-product-manager',
        'Product Manager',
        '自定义角色',
        '用户自建内容',
        'deepseek-official',
        'deepseek-v4-flash',
        '[]',
        '[]',
        '2026-01-01'
      )
    old
      .prepare(`INSERT INTO spaces (id, name, description, context, createdAt)
      VALUES (?, ?, ?, ?, ?)`)
      .run('custom-healthy-space', 'Healthy Living Plan', '用户自建空间', '保留我', '2026-01-01')
    old.close()

    try {
      const db = new MindMeshDatabase(path)
      try {
        expect(
          db.listAgents().some((agent) => ['Researcher', 'Developer'].includes(agent.name))
        ).toBe(false)
        expect(db.listSpaces().some((space) => space.name === 'AI Product Research')).toBe(false)
        expect(db.getAgent('custom-product-manager')).toMatchObject({
          name: 'Product Manager',
          persona: '用户自建内容',
        })
        expect(db.getAgent('starter-v2-product-manager')?.name).toBe('Product Manager (示例)')
        expect(db.getSpace('custom-healthy-space')).toMatchObject({
          name: 'Healthy Living Plan',
          context: '保留我',
        })
        expect(db.getSpace('starter-v2-healthy-living')?.name).toBe('Healthy Living Plan (示例)')
        expect(db.getSpace('starter-v2-product-delivery')?.memberIds).toContain(
          'starter-v2-product-manager'
        )
      } finally {
        db.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('finishes a fresh starter seed after an interrupted first run', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-examples-retry-'))
    const path = join(directory, 'mindmesh.sqlite')
    new MindMeshDatabase(path).close()
    const partial = new DatabaseSync(path)
    partial.exec(`PRAGMA foreign_keys = ON;
      DELETE FROM spaces;
      DELETE FROM agents WHERE id != 'starter-v1-researcher';
      DELETE FROM app_meta WHERE key IN ('seeded', 'starterExamplesV2');
      INSERT INTO app_meta (key, value) VALUES ('starterSeedMode', 'fresh')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;`)
    partial.close()

    try {
      const db = new MindMeshDatabase(path)
      try {
        expect(db.getAgent('starter-v1-researcher')?.name).toBe('Researcher')
        expect(db.getAgent('starter-v1-developer')?.name).toBe('Developer')
        expect(db.getSpace('starter-v1-ai-product-research')?.memberIds).toHaveLength(2)
        expect(db.getAgent('starter-v2-study-coach')?.name).toBe('Study Coach')
      } finally {
        db.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('upgrades unchanged starter skills while preserving user edits', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-skill-upgrade-'))
    const path = join(directory, 'mindmesh.sqlite')
    new MindMeshDatabase(path).close()
    const old = new DatabaseSync(path)
    old
      .prepare('UPDATE agents SET skills = ? WHERE id = ?')
      .run(JSON.stringify(['需求分析', '任务拆解']), 'starter-v2-product-manager')
    old
      .prepare('UPDATE agents SET skills = ? WHERE id = ?')
      .run(JSON.stringify(['我的自定义技能']), 'starter-v2-study-coach')
    old
      .prepare('UPDATE agents SET skills = ? WHERE id = ?')
      .run(JSON.stringify(['训练计划']), 'starter-v2-fitness-coach')
    old.prepare("DELETE FROM app_meta WHERE key = 'starterSkillsV3'").run()
    old.prepare("DELETE FROM app_meta WHERE key = 'starterSkillRefsV4'").run()
    old.close()

    try {
      const db = new MindMeshDatabase(path)
      try {
        expect(db.getAgent('starter-v2-product-manager')?.skills).toEqual([
          createSkillReference('mindmesh-builtin-user-story-writer-v1', '用户故事'),
          createSkillReference('mindmesh-builtin-project-planner-v1', '项目规划'),
        ])
        expect(db.getAgent('starter-v2-study-coach')?.skills).toEqual(['我的自定义技能'])
        expect(db.getAgent('starter-v2-fitness-coach')?.skills).toEqual([
          createSkillReference('mindmesh-builtin-workout-planner-v1', '训练计划'),
        ])
      } finally {
        db.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('updateAgent', () => {
  it('updates editable fields without changing the agent ID or space membership', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-agent-'))
    const db = new MindMeshDatabase(join(directory, 'mindmesh.sqlite'))
    try {
      const original = db.listAgents()[0]
      const space = db.listSpaces()[0]
      const updated = db.updateAgent(original.id, {
        name: 'Research Lead',
        role: '高级研究员',
        persona: '优先核查证据。',
        provider: original.provider,
        model: original.model,
        skills: original.skills,
        tools: original.tools,
      })

      expect(updated.id).toBe(original.id)
      expect(updated.createdAt).toBe(original.createdAt)
      expect(db.getAgent(original.id)?.name).toBe('Research Lead')
      expect(db.listSpaces().find((item) => item.id === space.id)?.memberIds).toContain(original.id)
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('persists and clears the reasoning effort, and rejects invalid values', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const original = db.listAgents()[0]
      expect(original.reasoningEffort).toBeUndefined()

      const editable = {
        name: original.name,
        role: original.role,
        persona: original.persona,
        provider: original.provider,
        model: original.model,
        skills: original.skills,
        tools: original.tools,
      }
      const withEffort = db.updateAgent(original.id, { ...editable, reasoningEffort: 'high' })
      expect(withEffort.reasoningEffort).toBe('high')
      expect(db.getAgent(original.id)?.reasoningEffort).toBe('high')
      expect(db.listAgents().find((item) => item.id === original.id)?.reasoningEffort).toBe('high')

      const cleared = db.updateAgent(original.id, { ...editable, reasoningEffort: undefined })
      expect(cleared.reasoningEffort).toBeUndefined()
      expect(db.getAgent(original.id)?.reasoningEffort).toBeUndefined()

      expect(() => db.updateAgent(original.id, { ...editable, reasoningEffort: 'MAX!' })).toThrow(
        '思考强度无效'
      )
    } finally {
      db.close()
    }
  })

  it('changes the capability hash when the reasoning effort changes', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const original = db.listAgents()[0]
      const base = getAgentCapabilityHash(original)
      expect(getAgentCapabilityHash({ ...original, reasoningEffort: 'max' })).not.toBe(base)
      expect(getAgentCapabilityHash({ ...original, reasoningEffort: undefined })).toBe(base)
    } finally {
      db.close()
    }
  })
})

describe('agent input validation', () => {
  it('rejects invalid update and deletion identifiers before reaching SQLite', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const agent = db.listAgents()[0],
        space = db.listSpaces()[0]
      for (const id of [null, [], 42, '', ' ', 'x'.repeat(257)]) {
        expect(() => db.updateAgent(id as string, agent)).toThrow('记录 ID 无效')
        expect(() => db.removeAgent(id as string)).toThrow('记录 ID 无效')
        expect(() => db.updateSpace(id as string, space)).toThrow('记录 ID 无效')
        expect(() => db.removeSpace(id as string)).toThrow('记录 ID 无效')
        expect(db.getAgent(agent.id)).toEqual(agent)
        expect(db.getSpace(space.id)).toEqual(space)
      }
    } finally {
      db.close()
    }
  })

  it('bounds agent fields and capability lists without changing an existing agent', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const original = db.listAgents()[0]
      for (const patch of [
        { name: 'x'.repeat(201) },
        { role: 'x'.repeat(2001) },
        { persona: 'x'.repeat(100_001) },
        { model: 'x'.repeat(101) },
        { provider: 'x'.repeat(101) },
        { skills: Array(101).fill('skill') },
        { tools: Array(101).fill('tool') },
        { skills: ['x'.repeat(2049)] },
        { tools: ['x'.repeat(2049)] },
      ]) {
        expect(() => db.createAgent({ ...original, name: 'New', ...patch })).toThrow(/不能超过/)
        expect(() => db.updateAgent(original.id, { ...original, ...patch })).toThrow(/不能超过/)
        expect(db.getAgent(original.id)).toEqual(original)
      }
    } finally {
      db.close()
    }
  })

  it('validates and normalizes agent inputs on create and update', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const template = db.listAgents()[0]
      const created = db.createAgent({
        ...template,
        name: '  新研究员  ',
        role: '  分析  ',
        persona: '  谨慎回答。  ',
      })
      expect(created).toMatchObject({ name: '新研究员', role: '分析', persona: '谨慎回答。' })
      expect(() => db.createAgent({ ...template, name: '   ' })).toThrow('名称和身份设定不能为空')
      expect(() => db.updateAgent(created.id, { ...created, persona: '   ' })).toThrow(
        '名称和身份设定不能为空'
      )
      expect(() =>
        db.createAgent({
          ...template,
          name: '数组形状',
          skills: 'not-an-array' as unknown as string[],
        })
      ).toThrow('技能数据无效')
    } finally {
      db.close()
    }
  })

  it('reports duplicate agent names in Chinese on create and update', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const [first, second] = db.listAgents()
      const message = `已存在名为「${first.name}」的智能体，请换一个名称`
      expect(() => db.createAgent({ ...first, name: `  ${first.name}  ` })).toThrow(message)
      expect(() => db.updateAgent(second.id, { ...second, name: `  ${first.name}  ` })).toThrow(
        message
      )
    } finally {
      db.close()
    }
  })
})

describe('updateSpaceContext', () => {
  it('rejects invalid and oversized backgrounds through every write path without changing stored data', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const space = db.listSpaces()[0]
      for (const context of [null, 42, {}, 'x'.repeat(100_001)]) {
        const value = context as string
        expect(() => db.updateSpaceContext(space.id, value)).toThrow(/背景/)
        expect(() => db.updateSpace(space.id, { ...space, context: value })).toThrow(
          /背景|协作空间数据/
        )
        expect(() => db.createSpace({ ...space, name: 'Invalid', context: value })).toThrow(
          /背景|协作空间数据/
        )
        expect(db.getSpace(space.id)).toEqual(space)
      }
      expect(db.updateSpaceContext(space.id, 'x'.repeat(100_000)).context).toHaveLength(100_000)
      expect(db.updateSpaceContext(space.id, '').context).toBe('')
      for (const id of [null, 42, '', 'x'.repeat(257)]) {
        expect(() => db.updateSpaceContext(id as string, '背景')).toThrow(/ID/)
      }
    } finally {
      db.close()
    }
  })

  it('persists the new background without changing members or messages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-space-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    const space = db.listSpaces()[0]
    db.addMessage({
      scope: 'space',
      scopeId: space.id,
      authorType: 'user',
      authorName: '你',
      content: '已有消息',
    })
    try {
      try {
        const updated = db.updateSpaceContext(space.id, '新的背景')
        expect(updated).toMatchObject({
          id: space.id,
          context: '新的背景',
          memberIds: space.memberIds,
        })
        expect(db.listMessages(db.conversationIdFor('space', space.id))).toHaveLength(1)
      } finally {
        db.close()
      }
      const reopened = new MindMeshDatabase(path)
      try {
        expect(reopened.getSpace(space.id)?.context).toBe('新的背景')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('space membership and agent deletion', () => {
  it('bounds space fields and membership before writing', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const original = db.listSpaces()[0]
      for (const patch of [
        { name: 'x'.repeat(101) },
        { description: 'x'.repeat(10_001) },
        { memberIds: Array(101).fill(original.memberIds[0]) },
        { memberIds: ['x'.repeat(257)] },
      ]) {
        expect(() => db.createSpace({ ...original, ...patch })).toThrow(/不能超过/)
        expect(() => db.updateSpace(original.id, { ...original, ...patch })).toThrow(/不能超过/)
        expect(db.getSpace(original.id)).toEqual(original)
      }
    } finally {
      db.close()
    }
  })

  it('reads one Space directly without listing unrelated spaces', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const expected = db.listSpaces()[0]
      const listSpaces = vi.spyOn(db, 'listSpaces').mockImplementation(() => {
        throw new Error('getSpace must not list every Space')
      })

      expect(db.getSpace(expected.id)).toEqual(expected)
      expect(db.getSpace('missing-space')).toBeUndefined()
      expect(listSpaces).not.toHaveBeenCalled()
    } finally {
      db.close()
    }
  })

  it('validates and normalizes space inputs on create and update', () => {
    const db = new MindMeshDatabase(':memory:')
    try {
      const memberIds = db
        .listAgents()
        .slice(0, 2)
        .map((agent) => agent.id)
      const created = db.createSpace({
        name: '  新空间  ',
        description: '  简介  ',
        context: '  背景  ',
        memberIds,
      })
      expect(created).toMatchObject({ name: '新空间', description: '简介', context: '背景' })
      expect(() => db.createSpace({ ...created, name: '   ' })).toThrow('空间名称不能为空')
      expect(() =>
        db.updateSpace(created.id, { ...created, memberIds: [memberIds[0], memberIds[0]] })
      ).toThrow('成员不能重复')
      expect(() =>
        db.createSpace({ ...created, name: '重复成员', memberIds: [memberIds[0], memberIds[0]] })
      ).toThrow('成员不能重复')
    } finally {
      db.close()
    }
  })

  it('deletes only the selected space, its messages, and runtime sessions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-space-delete-'))
    const db = new MindMeshDatabase(join(directory, 'mindmesh.sqlite'))
    try {
      const first = db.listSpaces()[0]
      const second = db.createSpace({
        name: '另一个空间',
        description: '',
        context: '',
        memberIds: first.memberIds,
      })
      const agent = db.getAgent(first.memberIds[0])!
      db.addMessage({
        scope: 'space',
        scopeId: first.id,
        authorType: 'user',
        authorName: '你',
        content: '删除我',
      })
      db.addMessage({
        scope: 'space',
        scopeId: second.id,
        authorType: 'user',
        authorName: '你',
        content: '保留我',
      })
      db.addMessage({
        scope: 'private',
        scopeId: agent.id,
        authorType: 'user',
        authorName: '你',
        content: '私聊',
      })
      const capabilityHash = getAgentCapabilityHash(agent)
      db.getOrCreateRuntimeSession(
        runtimeContextKey(`space:${first.id}`, agent.id),
        agent,
        'first-session',
        capabilityHash
      )
      db.getOrCreateRuntimeSession(
        runtimeContextKey(`space:${second.id}`, agent.id),
        agent,
        'second-session',
        capabilityHash
      )
      db.removeSpace(first.id)
      expect(db.getSpace(first.id)).toBeUndefined()
      expect(db.listMessages(db.conversationIdFor('space', first.id))).toEqual([])
      expect(db.listMessages(db.conversationIdFor('space', second.id))).toHaveLength(1)
      expect(db.listMessages(db.conversationIdFor('private', agent.id))).toHaveLength(1)
      expect(
        db.getOrCreateRuntimeSession(
          runtimeContextKey(`space:${second.id}`, agent.id),
          agent,
          'new',
          capabilityHash
        ).harnessSessionId
      ).toBe('second-session')
      expect(
        db.getOrCreateRuntimeSession(
          runtimeContextKey(`space:${first.id}`, agent.id),
          agent,
          'new',
          capabilityHash
        ).harnessSessionId
      ).toBe('new')
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('updates space details and members atomically while preserving messages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-space-edit-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    try {
      const space = db.listSpaces()[0]
      const originalMembers = space.memberIds
      const message = db.addMessage({
        scope: 'space',
        scopeId: space.id,
        authorType: 'user',
        authorName: '你',
        content: '历史',
      })
      const updated = db.updateSpace(space.id, {
        name: '新空间',
        description: '新简介',
        context: '新背景',
        memberIds: [originalMembers[1]],
      })
      expect(updated).toMatchObject({
        id: space.id,
        name: '新空间',
        description: '新简介',
        context: '新背景',
        memberIds: [originalMembers[1]],
      })
      expect(db.listMessages(db.conversationIdFor('space', space.id))).toMatchObject([message])
      expect(() =>
        db.updateSpace(space.id, { ...updated, name: '不应保存', memberIds: ['missing-agent'] })
      ).toThrow()
      expect(db.getSpace(space.id)).toEqual(updated)
      const restored = db.updateSpace(space.id, { ...updated, memberIds: originalMembers })
      expect(restored.memberIds).toEqual(originalMembers)
      db.removeAgent(originalMembers[0])
      expect(db.getSpace(space.id)?.memberIds).toEqual([originalMembers[1]])
      expect(db.listMessages(db.conversationIdFor('space', space.id))).toMatchObject([message])
    } finally {
      db.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not recreate default agents after the last one is deleted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-delete-last-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    db.listAgents().forEach((item) => db.removeAgent(item.id))
    db.close()
    try {
      const reopened = new MindMeshDatabase(path)
      try {
        expect(reopened.listAgents()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('does not restore starter data after the last Space and Agent are deleted', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-delete-all-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    db.listSpaces().forEach((item) => db.removeSpace(item.id))
    db.listAgents().forEach((item) => db.removeAgent(item.id))
    db.close()
    try {
      const reopened = new MindMeshDatabase(path)
      try {
        expect(reopened.listSpaces()).toEqual([])
        expect(reopened.listAgents()).toEqual([])
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('workspace selection', () => {
  it('persists the selected path and starts fresh runtime sessions while keeping messages', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-workspace-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    const agent = db.listAgents()[0]
    const capabilityHash = getAgentCapabilityHash(agent)
    db.getOrCreateRuntimeSession(
      runtimeContextKey(`private:${agent.id}`, agent.id),
      agent,
      'old-session',
      capabilityHash
    )
    db.addMessage({
      scope: 'private',
      scopeId: agent.id,
      authorType: 'user',
      authorName: '你',
      content: '历史',
    })
    db.changeWorkspace(directory)
    db.close()
    try {
      const reopened = new MindMeshDatabase(path)
      try {
        expect(reopened.getWorkspacePath()).toBe(directory)
        expect(
          reopened.getOrCreateRuntimeSession(
            runtimeContextKey(`private:${agent.id}`, agent.id),
            agent,
            'new-session',
            capabilityHash
          ).harnessSessionId
        ).toBe('new-session')
        expect(reopened.listMessages(db.conversationIdFor('private', agent.id))[0].content).toBe('历史')
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('user profile', () => {
  it('validates and persists a nickname and image', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-profile-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    const avatar = 'data:image/png;base64,aGVsbG8='
    try {
      expect(db.getUserProfile()).toEqual({ name: '你', avatar: null })
      expect(db.saveUserProfile({ name: '  小明  ', avatar })).toEqual({ name: '小明', avatar })
      expect(() => db.saveUserProfile({ name: '  ', avatar })).toThrow('昵称')
      expect(() =>
        db.saveUserProfile({ name: '小明', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' })
      ).toThrow('图片')
    } finally {
      db.close()
    }
    const reopened = new MindMeshDatabase(path)
    try {
      expect(reopened.getUserProfile()).toEqual({ name: '小明', avatar })
    } finally {
      reopened.close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('runtime sessions', () => {
  it('adds snapshot and cursor columns to an existing database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-migration-'))
    const path = join(directory, 'mindmesh.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE runtime_sessions (
      contextKey TEXT PRIMARY KEY, harnessSessionId TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, capabilityHash TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`)
    old
      .prepare(`INSERT INTO runtime_sessions
      (contextKey, harnessSessionId, provider, model, capabilityHash, updatedAt)
      VALUES ('private:old', 'stale-session', 'deepseek-official', 'old-model', 'stale-hash', '2026-01-01')`)
      .run()
    old.close()
    try {
      const db = new MindMeshDatabase(path)
      try {
        const agent = db.listAgents()[0]
        // 'private:old' is re-keyed to a conversation on upgrade, so the row is
        // looked up under its new identity rather than dropped.
        expect(
          db.getOrCreateRuntimeSession(
            runtimeContextKey('private:old', 'old'),
            agent,
            'new-session',
            'current-hash'
          )
        ).toMatchObject({ harnessSessionId: 'new-session', agent, lastConsumedMessageSequence: 0 })
        expect(db.referencedCapabilityHashes()).toEqual(['current-hash'])
      } finally {
        db.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('restores the original agent snapshot and consumed sequence after reopening the database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-session-'))
    const path = join(directory, 'mindmesh.sqlite')
    const db = new MindMeshDatabase(path)
    const agent = db.listAgents()[0]
    const key = runtimeContextKey('space:example', agent.id)
    db.getOrCreateRuntimeSession(key, agent, 'original-session', getAgentCapabilityHash(agent))
    db.saveRuntimeSessionProgress(key, 'saved-session', 7)
    db.close()
    try {
      const reopened = new MindMeshDatabase(path)
      try {
        const restored = reopened.getOrCreateRuntimeSession(
          key,
          { ...agent, persona: '新身份' },
          'new-session',
          'new-hash'
        )
        expect(restored).toMatchObject({
          harnessSessionId: 'saved-session',
          lastConsumedMessageSequence: 7,
          agent: { persona: agent.persona },
        })
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('resets a session whose stored hash does not match its snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-session-mismatch-'))
    const path = join(directory, 'mindmesh.sqlite')
    const snapshot = {
      id: 'legacy',
      name: 'Legacy',
      role: '',
      persona: '冻结身份',
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      skills: [],
      tools: [],
      createdAt: '',
    }
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE runtime_sessions (
      contextKey TEXT PRIMARY KEY, harnessSessionId TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, capabilityHash TEXT NOT NULL,
      agentSnapshot TEXT, lastConsumedMessageSequence INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT NOT NULL
    )`)
    old
      .prepare(`INSERT INTO runtime_sessions
      (contextKey, harnessSessionId, provider, model, capabilityHash, agentSnapshot,
       lastConsumedMessageSequence, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        'space:legacy',
        'stale-session',
        snapshot.provider,
        snapshot.model,
        'stale-hash',
        JSON.stringify(snapshot),
        9,
        '2026-01-01'
      )
    old.close()
    try {
      const db = new MindMeshDatabase(path)
      try {
        const current = db.listAgents()[0]
        const restored = db.getOrCreateRuntimeSession(
          'space:legacy',
          current,
          'new-session',
          'current-hash'
        )
        expect(restored).toMatchObject({
          harnessSessionId: 'new-session',
          agent: snapshot,
          lastConsumedMessageSequence: 9,
        })
        expect(db.referencedCapabilityHashes()).toEqual([getAgentCapabilityHash(snapshot)])
      } finally {
        db.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('message metadata', () => {
  it('upgrades existing messages and keeps reasoning, attachments, and stopped state after reopening', () => {
    const directory = mkdtempSync(join(tmpdir(), 'mindmesh-reasoning-'))
    const path = join(directory, 'mindmesh.sqlite')
    const old = new DatabaseSync(path)
    old.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, scopeId TEXT NOT NULL,
      authorType TEXT NOT NULL, authorId TEXT, authorName TEXT NOT NULL,
      content TEXT NOT NULL, sequence INTEGER NOT NULL, createdAt TEXT NOT NULL
    )`)
    old
      .prepare(`INSERT INTO messages (id, scope, scopeId, authorType, authorName, content, sequence, createdAt)
      VALUES ('old', 'private', 'agent', 'user', '你', '旧消息', 1, '2026-01-01')`)
      .run()
    old.close()
    try {
      const db = new MindMeshDatabase(path)
      try {
        expect(db.listMessages(db.conversationIdFor('private', 'agent'))[0]).toMatchObject({
          content: '旧消息',
          reasoning: null,
          attachments: [],
          stopped: false,
        })
        db.addMessage({
          scope: 'private',
          scopeId: 'agent',
          authorType: 'agent',
          authorName: 'Agent',
          content: '回答',
          reasoning: '先分析\n\n再回答',
          stopped: true,
          attachments: [
            {
              type: 'image',
              name: 'chart.png',
              mediaType: 'image/png',
              bytes: 68,
              data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nCEAAAAASUVORK5CYII=',
            },
          ],
        })
      } finally {
        db.close()
      }
      const reopened = new MindMeshDatabase(path)
      try {
        expect(reopened.listMessages(db.conversationIdFor('private', 'agent'))[1]).toMatchObject({
          content: '回答',
          reasoning: '先分析\n\n再回答',
          stopped: true,
          attachments: [{ name: 'chart.png', mediaType: 'image/png' }],
        })
      } finally {
        reopened.close()
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
