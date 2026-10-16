'use strict'

// 创作工作流模式插件（宿主级持久插件）
module.exports = {
  name: 'creative-workflow-modes',
  inject: ['commands', 'systemPrompt'],

  apply(ctx) {
    const PRINCIPLE_FILE = 'principle.md'
    // scope：本模式允许读取与修改的路径，相对会话工作区。
    // 以 '/' 结尾的项匹配整棵子树，其余要求路径完全相等。
    const MODES = {
      research_mode: { label: '源研模式', workflow: 'workflows/research_mode.md', scope: ['正文/', '设定/', '设定台账.md'] },
      plan_mode: { label: '筹划模式', workflow: 'workflows/plan_mode.md', scope: ['正文/', '设定/', '设定台账.md', 'creative_requirements.md', 'implementation_plan.md'] },
      creative_mode: { label: '创作模式', workflow: 'workflows/creative_mode.md', scope: ['正文/', '设定台账.md', 'implementation_plan.md'] },
      polish_mode: { label: '润色模式', workflow: 'workflows/polish_mode.md', scope: ['正文/', '设定台账.md'] },
    }
    const SECTION_NAME = 'creative-workflow:rules'
    // 携带文件路径参数的工具 → 参数名。未列出的工具不触碰文件，不受范围限制。
    const PATH_ARGUMENTS = {
      read: 'file_path',
      write: 'file_path',
      edit: 'file_path',
      read_image: 'file_path',
      glob: 'path',
      grep: 'path',
    }
    // 检索工具的 path 可省略，省略即整个工作区，因此必须要求显式给出。
    const SEARCH_TOOLS = new Set(['glob', 'grep'])

    const nodeFs = require('node:fs')
    const nodePath = require('node:path')
    const commands = ctx.get('commands')
    const systemPrompt = ctx.get('systemPrompt')
    if (!commands || !systemPrompt) {
      console.error('[creative-workflow-modes] 缺少核心服务 (commands/systemPrompt)；插件停用')
      return
    }

    const activeModes = new WeakMap()

    const readWorkspaceFile = async (cwd, rel) => {
      if (typeof cwd !== 'string' || cwd.length === 0) return undefined
      try {
        const target = nodePath.resolve(cwd, rel)
        if (nodeFs.existsSync(target)) {
          return nodeFs.readFileSync(target, 'utf8')
        }
      } catch (error) {
        return undefined
      }
      return undefined
    }

    const sanitize = (text) => text.replaceAll('{{', '{\u200b{').replaceAll('}}', '}\u200b}')

    // 把模型给出的路径解析为工作区内的相对路径。解析到工作区之外（含盘符、
    // 上跳越界）返回 undefined，由调用方按越界处理。
    const toWorkspaceRelative = (cwd, raw) => {
      if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
      const base = nodePath.resolve(cwd)
      const target = nodePath.resolve(base, raw)
      const rel = nodePath.relative(base, target)
      if (rel === '') return ''
      if (rel === '..' || rel.startsWith('..' + nodePath.sep) || nodePath.isAbsolute(rel)) return undefined
      return rel.split(nodePath.sep).join('/')
    }

    // 相对路径是否落在某条 scope 项内。空串表示工作区根目录：只有以 '/' 结尾的
    // 目录项能容纳它，单文件项不能。
    const withinScope = (rel, scope) => scope.some((entry) => {
      if (entry.endsWith('/')) return rel === entry.slice(0, -1) || rel.startsWith(entry)
      return rel === entry
    })

    // 工具调用的范围闸门。命中本会话已激活的模式时，只放行该模式 scope 内的
    // 路径；越界一律拒绝并说明原因。无模式激活、工具不碰文件、或路径无法解析
    // （交由工具自身报错）时放行。
    const scopeDenial = (agent, exec) => {
      const name = agent === undefined ? undefined : activeModes.get(agent.session)
      const spec = name === undefined ? undefined : MODES[name]
      if (spec === undefined) return undefined
      const argName = PATH_ARGUMENTS[exec.name]
      if (argName === undefined) return undefined
      const raw = exec.arguments === null || typeof exec.arguments !== 'object' ? undefined : exec.arguments[argName]
      const cwd = agent.session.header.cwd
      if (SEARCH_TOOLS.has(exec.name) && raw === undefined) {
        return `【${spec.label}】禁止在整个工作区范围内检索：${exec.name} 必须显式指定 path。本模式仅允许访问：${spec.scope.join('、')}。`
      }
      if (raw === undefined) return undefined
      const rel = toWorkspaceRelative(cwd, raw)
      if (rel === undefined) {
        return `【${spec.label}】越界访问被拒绝：${raw} 不在本模式允许范围内。本模式仅允许访问：${spec.scope.join('、')}。`
      }
      if (withinScope(rel, spec.scope)) return undefined
      return `【${spec.label}】越界访问被拒绝：${rel === '' ? '（工作区根目录）' : rel} 不在本模式允许范围内。本模式仅允许访问：${spec.scope.join('、')}。`
    }

    ctx.on('tools/pre-execute', (exec, next) => {
      const scopeReason = scopeDenial(exec.agent, exec)
      if (scopeReason !== undefined) return Promise.resolve({ kind: 'deny', reason: scopeReason })
      return next()
    })

    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const agent = context.agent
      const name = agent === undefined ? undefined : activeModes.get(agent.session)
      const spec = name === undefined ? undefined : MODES[name]
      if (spec === undefined) return next()
      const cwd = agent.session.header.cwd
      const [principle, workflow] = await Promise.all([
        readWorkspaceFile(cwd, PRINCIPLE_FILE),
        readWorkspaceFile(cwd, spec.workflow),
      ])
      if (principle === undefined || workflow === undefined) return next()
      const text = [
        `# 规则与工作流：${spec.label}`,
        `## 《创作准则》`,
        sanitize(principle),
        `## 《${spec.label}工作流》`,
        sanitize(workflow),
      ].join('\n\n')
      const assembled = await next()
      if (assembled.sections.some((section) => section.name === SECTION_NAME)) return assembled
      return { ...assembled, sections: [...assembled.sections, { name: SECTION_NAME, text }] }
    }, { global: true })

    for (const [name, spec] of Object.entries(MODES)) {
      commands.register({
        name,
        description: `进入${spec.label}：从当前工作区动态加载《创作准则》与 ${spec.workflow} 并注入提示词`,
        input: { hint: 'off | 附加指令（如润色目标段落）' },
        handler: async ({ agent, rawInput }) => {
          const arg = rawInput.trim()
          if (arg === 'off') {
            if (activeModes.get(agent.session) !== name) {
              return { kind: 'success', text: `当前未处于${spec.label}，无需退出。` }
            }
            activeModes.delete(agent.session)
            return { kind: 'success', text: `已退出${spec.label}：规则文件不再注入提示词。` }
          }
          const cwd = agent.session.header.cwd
          const [principle, workflow] = await Promise.all([
            readWorkspaceFile(cwd, PRINCIPLE_FILE),
            readWorkspaceFile(cwd, spec.workflow),
          ])
          if (principle === undefined || workflow === undefined) {
            const missing = []
            if (principle === undefined) missing.push(PRINCIPLE_FILE)
            if (workflow === undefined) missing.push(spec.workflow)
            return {
              kind: 'error',
              text: `无法读取规则文件：${missing.join('、')}（会话工作区：${cwd ?? '（未设置）'}）。请确认文件存在后再试。`,
            }
          }
          activeModes.set(agent.session, name)
          const summary = `已进入${spec.label}`
          const narration = arg === ''
            ? `已进入${spec.label}，请遵循《创作准则》与《${spec.label}工作流》开始执行。`
            : `已进入${spec.label}。指令：${arg}。请结合该指令并遵循《创作准则》与《${spec.label}工作流》开始执行。`
          try {
            agent.steer({
              id: `mflow:${name}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
              role: 'user',
              content: [{ type: 'text', text: narration }],
              source: { kind: 'plugin:creative-workflow-modes', form: 'notice', summary },
            })
          } catch (error) {
            return { kind: 'error', text: `已进入${spec.label}，但无法启动模型回合：${error instanceof Error ? error.message : String(error)}` }
          }
          return {
            kind: 'success',
            text: `${summary}：${PRINCIPLE_FILE} 与 ${spec.workflow} 已从工作区动态加载并注入提示词。修改规则文件后无需更新插件，下一次模型调用自动生效。`,
          }
        },
      })
    }
  },
}
