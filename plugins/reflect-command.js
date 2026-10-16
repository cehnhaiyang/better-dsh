'use strict'

// reflect-command.js —— 会话复盘与自动压缩插件 (/reflect, /reflect_project, /reflect_global)
//
// 复盘产出会分流到两个作用域：
//   通用技能   -> $DSH_HOME/skills          （跨项目复用，dsh-skill-filesystem 的 user-dsh 根）
//   项目专属技能 -> <项目根>/.dsh/skills      （仅本项目，project-dsh 根）
// 项目根取「最近含 .git 的祖先目录」而非会话 cwd：技能发现以仓库根为准，
// cwd 常是仓库子目录，写进 cwd 会导致技能根本不被加载。
//
// 三条命令共用同一套提取标准与写作规则，差别只在「本轮允许写哪个作用域」：
//   /reflect          两个作用域都写
//   /reflect_project  只写项目级
//   /reflect_global   只写全局级
// 指令里绝不出现本轮不可写的作用域：只要列出来，模型就会顺手多写一份，
// 而这正是拆分命令要消除的行为。多数会话以项目事实为主，因此单作用域命令
// 必须允许「本轮什么都不写」——否则模型会为了填满作用域硬造一份技能。
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

/**
 * 解析项目根目录：向上取最近的含 .git 的祖先目录。
 * @param cwd - 会话工作目录。
 * @returns 项目根绝对路径；cwd 无效时返回空串。
 */
function resolveProjectRoot(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return ''
  const base = path.resolve(cwd)
  let current = base
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current
    const parent = path.dirname(current)
    if (parent === current) return base
    current = parent
  }
}

/** 列出目录下已存在的技能名（`<name>/SKILL.md` 与扁平 `<name>.md` 两种形态）。 */
function listSkills(dir) {
  const names = []
  try {
    if (!fs.existsSync(dir)) return names
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (fs.existsSync(path.join(dir, entry.name, 'SKILL.md'))) names.push(entry.name)
      } else if (entry.name.endsWith('.md')) {
        names.push(entry.name.replace(/\.md$/, ''))
      }
    }
  } catch (err) {}
  return names
}

/** 把技能名列表渲染成指令里的一小段缩进清单。 */
function describe(names) {
  return names.length > 0 ? names.map((name) => `  - ${name}`).join('\n') : `  (none yet)`
}

const GLOBAL_CRITERION =
  'A lesson belongs here when it stays true and actionable after this project is forgotten: language and tool behavior, pitfalls, debugging and verification procedure, stable user collaboration preferences, general architecture or naming principles.'

const PROJECT_CRITERION =
  "A lesson belongs here when it depends on this project's concrete facts: directory layout, module and file responsibilities, internal interface contracts, business rules, the exact dependency and version combination, this project's own build or run procedure."

/**
 * 项目作用域是否根本不存在：无工作目录，或项目根与全局技能目录重合。
 * 此时 /reflect 只剩一个作用域，指令必须按单作用域措辞，否则它会点名一个
 * 不存在的项目目录、或指使模型去写它算不出来的路径。
 */
function isFolded(scope, dirs) {
  return scope === 'both' && dirs.project === ''
}

/**
 * 生成作用域段落：只描述本轮可写的作用域，并点名另一个作用域归属哪条命令。
 * @param scope - 'both' | 'project' | 'global'。
 * @param dirs - 本轮作用域目录，不涉及的为 ''。
 * @returns 指令中的作用域段落。
 */
function scopeSection(scope, dirs) {
  if (scope === 'global' || isFolded(scope, dirs)) {
    return [
      `## Scope — general only`,
      ``,
      `Directory: ${dirs.global}`,
      GLOBAL_CRITERION,
      ``,
      scope === 'global'
        ? `**Write no project-specific skill this round**, even when the conversation is full of project facts. Those belong to \`/reflect_project\`.`
        : `**No separate project scope exists for this session** (no workspace directory, or the project root coincides with the global skills directory), so general skills are the only scope available.`,
    ].join('\n')
  }
  if (scope === 'project') {
    return [
      `## Scope — project-specific only`,
      ``,
      `Directory: ${dirs.project}`,
      PROJECT_CRITERION,
      ``,
      `**Write no general skill this round**, even when a reusable lesson comes up. Those belong to \`/reflect_global\`.`,
    ].join('\n')
  }
  return [
    `## Two scopes — classify every lesson`,
    ``,
    `Classify every lesson individually. Never generalize a project-specific fact into a general skill, and never bury a general lesson inside a project skill.`,
    ``,
    `**1. General — reusable across projects**`,
    `   Directory: ${dirs.global}`,
    `   ${GLOBAL_CRITERION}`,
    ``,
    `**2. Project-specific — this project only**`,
    `   Directory: ${dirs.project}`,
    `   ${PROJECT_CRITERION}`,
  ].join('\n')
}

/**
 * 生成准入门槛段落。单作用域命令必须显式允许空结果，
 * 否则「本轮只写这一处」会被读成「本轮必须写出点什么」。
 * @param scope - 'both' | 'project' | 'global'。
 * @returns 指令中的准入段落。
 */
function admissionSection(scope, dirs) {
  if (scope === 'global' || isFolded(scope, dirs)) {
    return [
      `## Admission test`,
      ``,
      `Ask of every candidate: **would this still be correct and actionable in an unrelated repository, restated without reference to this project?**`,
      `- Yes → write it here.`,
      `- Only if the reader can see this project's code → **not this round's material.** Do not generalize it to make it fit; leave it out.`,
      `- **Writing nothing is a legitimate outcome.** Most sessions are dominated by project-specific work. If nothing survives the test, report that the general scope yielded nothing and stop — never manufacture a skill to fill the scope.`,
    ].join('\n')
  }
  if (scope === 'project') {
    return [
      `## Admission test`,
      ``,
      `Ask of every candidate: **does this depend on this project's concrete facts — its paths, modules, contracts, dependencies, or its own way of building and running?**`,
      `- Yes → write it here.`,
      `- A statement that would stay true in an unrelated repository → **not this round's material.** Leave it out rather than dressing it up as a project fact.`,
      `- **Writing nothing is a legitimate outcome** when the session produced no project-specific lesson. Report that and stop.`,
    ].join('\n')
  }
  return [
    `## Classification rule`,
    ``,
    `Ask: **would this still be correct in an unrelated repository?**`,
    `- Yes, once restated without reference to this project → general.`,
    `- Only if the reader can see this project's code → project-specific.`,
    `- Genuinely both layers → write it in both, each trimmed to its own scope. Never paste identical text into both.`,
    `- **When in doubt, choose project-specific.** A wrongly generalized skill actively misleads in other projects; a project-specific skill at worst goes unused.`,
    ``,
    `A scope with no material gets no skill — report it as empty instead of writing a thin one to fill it.`,
  ].join('\n')
}

/** 生成「已存在的技能」段落，只列本轮可写的作用域。 */
function existingSection(dirs, existing) {
  const lines = [`## Already present — extend, do not duplicate`, ``]
  if (dirs.global !== '') lines.push(`General skills in ${dirs.global}:`, describe(existing.global), ``)
  if (dirs.project !== '') lines.push(`Project skills in ${dirs.project}:`, describe(existing.project), ``)
  lines.push(`If a lesson falls inside an existing skill, \`read\` it and extend it with \`edit\` rather than creating a parallel skill.`)
  return lines.join('\n')
}

/**
 * 组装复盘指令。
 * @param scope - 'both' | 'project' | 'global'。
 * @param dirs - 本轮作用域目录，不涉及的为 ''。
 * @param existing - 各作用域已存在的技能名。
 * @param compaction - 是否挂载了压缩后端，决定是否要求以 /compaction 收尾。
 * @returns 完整的复盘指令文本。
 */
function buildPrompt(scope, dirs, existing, compaction) {
  // 路径说明必须与上面声明的作用域数量一致：/reflect 有两个作用域，只写一个具体
  // 路径会让模型把两个作用域的技能都塞进项目目录；折叠成单作用域时则只有一个。
  const skillDir = dirs.project !== '' && scope !== 'global' ? dirs.project : dirs.global
  const skillPathLine = dirs.global !== '' && dirs.project !== ''
    ? `Path: <scope directory above>/<skill-name>/SKILL.md — use the general directory for general skills and the project directory for project-specific ones. Start with YAML frontmatter, then the body:`
    : `Path: ${skillDir}/<skill-name>/SKILL.md. Start with YAML frontmatter, then the body:`

  return [
    `# Session Retrospective — Extract Skills`,
    ``,
    `Review the **entire conversation above** and extract durable engineering lessons into DSH skills: mistakes and their root causes, corrections the user made, tool and workflow rules, format preferences, hard-won facts about this environment.`,
    ``,
    scopeSection(scope, dirs),
    ``,
    admissionSection(scope, dirs),
    ``,
    `## What to extract, in priority order`,
    ``,
    `1. Mistakes made and their root cause — especially anything the user had to correct.`,
    `2. Rules the user stated or enforced: tool usage, output format, workflow order, things never to do.`,
    `3. Non-obvious facts about this environment, toolchain, or project that took real effort to establish.`,
    `4. Procedures that worked and should be repeated.`,
    ``,
    `Skip what is already obvious from the code, and skip one-off details with no future use.`,
    ``,
    existingSection(dirs, existing),
    ``,
    `## SKILL.md format`,
    ``,
    skillPathLine,
    ``,
    `    ---`,
    `    name: <skill-name>`,
    `    description: <one sentence: what this covers and when it should be read>`,
    `    whenToUse: <optional: the situation that should trigger reading it>`,
    `    ---`,
    `    # <Title>`,
    `    <the rule, why it holds, the concrete steps, the failure it prevents>`,
    ``,
    dirs.project === ''
      ? ''
      : `A project-specific skill's \`description\` must state that it applies to this project only, so it is never mistaken for a general practice elsewhere.`,
    ``,
    `## Language — English only`,
    ``,
    `Write every skill in **English**: the frontmatter (\`name\`, \`description\`, \`whenToUse\`) and the whole body. This holds regardless of the language of the conversation or of the user's messages. Skills are read by later sessions in unrelated projects, so one language keeps them consistent and retrievable.`,
    ``,
    `**Every skill listed above must be checked, and any that is not written in English must be rewritten in full, in English — not only the ones you happen to extend this round.** Read each one, then \`write\` the English version over it. Translate faithfully: keep every fact, and keep every command, path, version number and error string byte-for-byte. Drop nothing and summarize nothing. Leaving a non-English skill in place defeats this rule.`,
    ``,
    `## Writing rules`,
    ``,
    `- Write with the filesystem tools (\`read\`, \`write\`, \`edit\`). Nothing is retained unless it is on disk.`,
    `- One skill per coherent topic. A few dense skills beat many thin ones.`,
    `- Record the fact and its consequence, not the story of how you found it. Keep exact commands, paths, and error strings when they are the actionable part.`,
    `- Every rule must be falsifiable — something a reader could actually violate. Drop anything that only restates the obvious.`,
    `- No filler, and do not summarize the conversation back to the reader.`,
    ``,
    `## Finish`,
    ``,
    `Report which skills you created or updated, in which scope, and the single most important lesson from this session.`,
    `If a scope yielded nothing worth writing, say so plainly — an empty result is a legitimate report, not a failure.`,
    compaction
      ? `## Mandatory final action\n\nOnly after every SKILL.md is written to disk, your last action must be a tool call that outputs the text /compaction (for example \`Write-Output '/compaction'\` or \`echo /compaction\`). That signal triggers context compaction.\n\nDo NOT emit /compaction before the skills are saved.`
      : '',
  ].filter(Boolean).join('\n')
}

/** 三条命令的唯一差异：本轮允许写哪个作用域。 */
const COMMANDS = [
  {
    name: 'reflect',
    scope: 'both',
    description: '复盘当前会话提取 Skill (SKILL.md)，按通用/项目专属分流沉淀，并在复盘后自动压缩历史上下文',
    summary: '已触发 /reflect (通用 + 项目专属技能分流沉淀)',
  },
  {
    name: 'reflect_project',
    scope: 'project',
    description: '复盘当前会话，仅沉淀项目专属技能 (SKILL.md)，复盘后自动压缩历史上下文',
    summary: '已触发 /reflect_project (仅项目专属技能)',
  },
  {
    name: 'reflect_global',
    scope: 'global',
    description: '复盘当前会话，仅沉淀通用技能 (SKILL.md)；没有值得沉淀的通用经验时会如实说明，复盘后自动压缩历史上下文',
    summary: '已触发 /reflect_global (仅通用技能)',
  },
]

module.exports = {
  name: 'command-reflect',
  inject: ['commands'],

  apply(ctx) {
    const commands = ctx.get('commands')
    if (!commands) return

    const pendingCompaction = new Map()

    function extractToolResultText(event) {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return ''
      let text = ''
      for (const item of content) {
        // v4 起消息内容块是扁平的（ToolResultMessage.content 直接就是 ContentBlock[]），
        // 早期版本才会套一层 { type: 'tool-result', content: [...] }。两种形态都要认。
        const blocks = Array.isArray(item.content) ? item.content : [item]
        for (const block of blocks) {
          if (block && block.type === 'text' && typeof block.text === 'string') {
            text += block.text + ' '
          }
        }
      }
      return text
    }

    function extractToolCallText(event) {
      const args = event.data?.arguments
      return typeof args === 'string' ? args : ''
    }

    function extractAssistantText(event) {
      const content = event.data?.message?.content
      if (!Array.isArray(content)) return ''
      let text = ''
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string') {
          text += block.text + ' '
        }
      }
      return text
    }

    function resolveCompaction(agent) {
      const candidates = [
        ctx.get('compaction'),
        agent && agent.ctx ? agent.ctx.get('compaction') : undefined,
      ]
      const presets = ctx.get('agentPresets')
      if (presets && typeof presets.serviceFor === 'function' && agent) {
        candidates.push(presets.serviceFor(agent, 'compaction'))
      }
      return candidates.find((it) => it && typeof it.compactNow === 'function')
    }

    // 压缩总时长上限：压缩会发一次真实的模型请求，输入可达数 MB。
    // 没有上限时，请求一旦悬挂，runMaintenance 的 finally 永不执行，
    // agent 会永久停在维护相位 —— 后续输入全被 latch 住，
    // Web 端表现为「刷新不动、切会话持续加载」。这是必须兜底的根因。
    const COMPACTION_TIMEOUT_MS = 5 * 60 * 1000

    /**
     * 等待 agent 真正静止（既无活动回合，也不在维护中）。
     *
     * 判据用公开的 `agent.whenIdle()`：它等到 activityDone 链收敛，而维护任务
     * 同样会占据 activityDone，所以「真空闲」与「正在维护」都能区分——这正是
     * `agent.status` 做不到的（该 getter 把 maintenance 相位也报成 'idle'）。
     * `agent.phase` 是 agent-loop 的内部实现，不是公开 API，不得依赖。
     *
     * 本函数在 compactNow 之前调用，不在维护任务内部，因此不会触发
     * 「runMaintenance 把 activityDone 设成本次维护 promise」导致的自我死锁；
     * 死锁只在维护内部调用 whenIdle 时才会发生。
     * @param {object} agent - 目标 agent。
     * @param {number} deadline - 等待截止时间戳（毫秒）。
     * @returns {Promise<boolean>} 是否等到静止。
     */
    async function waitForIdle(agent, deadline) {
      if (typeof agent.whenIdle !== 'function') return true
      const remaining = deadline - Date.now()
      if (remaining <= 0) return false
      let timer
      try {
        return await Promise.race([
          agent.whenIdle().then(() => true),
          new Promise((resolve) => { timer = setTimeout(() => resolve(false), remaining) }),
        ])
      } finally {
        clearTimeout(timer)
      }
    }

    async function triggerCompaction(task) {
      const { agent, commandId } = task
      console.log('[reflect-command] 检测到模型输出的 /compaction 信号，等待回合收尾后执行压缩...')

      // 不在此处 await：本函数由 session/event 观察者调用，而压缩要等当前回合
      // 完全结束（相位回到 idle）才可能成功。setTimeout 让出当前调用栈，
      // 避免与 turn/end 的收尾路径相互阻塞。
      setTimeout(async () => {
        const deadline = Date.now() + COMPACTION_TIMEOUT_MS
        try {
          const compaction = resolveCompaction(agent)
          if (!compaction) {
            console.warn('[reflect-command] 当前会话未提供 compaction 服务，跳过复盘后的自动压缩。')
            return
          }

          const idle = await waitForIdle(agent, deadline)
          if (!idle) {
            console.warn('[reflect-command] 等待 agent 空闲超时，本次跳过自动压缩（会话未受影响）。')
            return
          }

          // 让 turn/end 的收尾（含持久化）先落地，再进入维护相位。
          await new Promise((resolve) => setTimeout(resolve, 300))

          // 超时与取消合成同一个信号：无论哪边先触发，compactNow 都会被中断，
          // runMaintenance 的 finally 得以执行，相位必定回到 idle。
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(new Error('reflect compaction timeout')), Math.max(0, deadline - Date.now()))
          try {
            const result = await compaction.compactNow(agent, controller.signal, commandId)
            if (result) {
              console.log(`[reflect-command] 自动压缩完成: 折叠 ${result.shadowedSeqs.length} 条历史 (~${result.shadowedTokenCount} tokens)`)
            } else {
              console.log('[reflect-command] 自动压缩完成（当前无可折叠历史）')
            }
          } finally {
            clearTimeout(timer)
          }
        } catch (err) {
          // 压缩失败绝不能影响会话可用性：只记录，不上抛。
          console.warn('[reflect-command] 自动压缩异常:', err instanceof Error ? err.message : String(err))
        }
      }, 100)
    }

    function isCompactionSignal(text) {
      if (typeof text !== 'string') return false
      const lower = text.toLowerCase()
      return lower.includes('/compaction') || lower.includes('/compation')
    }

    // 触发时机：模型通过工具输出 /compaction 只是「请求压缩」的意图，
    // 此刻回合仍在运行，而 runMaintenance 要求相位为 idle，立即调用必然被拒。
    // 因此这里只登记意图，等 turn/end 落地后再真正启动压缩。
    ctx.on('session/event', async (session, event) => {
      const task = pendingCompaction.get(session)
      if (!task) return

      let matched = false
      if (event.type === 'tool/result') {
        const text = extractToolResultText(event)
        if (isCompactionSignal(text)) matched = true
      } else if (event.type === 'tool/call') {
        const text = extractToolCallText(event)
        if (isCompactionSignal(text)) matched = true
      } else if (event.type === 'assistant/message') {
        const text = extractAssistantText(event)
        if (isCompactionSignal(text)) matched = true
      }

      if (matched) {
        task.requested = true
        return
      }

      // 回合真正结束后才动手；reason.kind === 'completed' 之外（interrupted /
      // aborted / error）同样收尾，因为相位此时也已回到 idle，压缩仍可进行。
      if (event.type === 'turn/end') {
        if (task.requested === true) {
          pendingCompaction.delete(session)
          void triggerCompaction(task)
        } else {
          // 模型始终没有输出 /compaction：本回合不带压缩意图，清理登记，
          // 避免 pendingCompaction 随会话累积。
          pendingCompaction.delete(session)
        }
      }
    })

    for (const { name, scope, description, summary } of COMMANDS) {
      commands.register({
        name,
        description,
        handler: async ({ agent, commandId }) => {
          if (!agent || !agent.session) {
            return { kind: 'error', text: '无法获取当前会话的 Agent 实例。' }
          }

          const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
          const globalSkillsDir = path.join(dshHome, 'skills')
          const projectRoot = resolveProjectRoot(agent.session.header?.cwd)
          // 无 .git 时项目根回退到 cwd，而 cwd 可能就是家目录 —— 此时「项目级」目录
          // 会与全局目录算出同一个路径。必须折叠成单作用域，否则会指使模型把同一份
          // 技能往同一处写两遍，还会让它以为存在两个互不相干的沉淀位置。
          const candidate = projectRoot === '' ? '' : path.join(projectRoot, '.dsh', 'skills')
          const projectSkillsDir = candidate === globalSkillsDir ? '' : candidate

          // 折叠后 /reflect_project 没有可写的独立目录：如实报错，而不是退化成写全局。
          if (scope === 'project' && projectSkillsDir === '') {
            return {
              kind: 'error',
              text: projectRoot === ''
                ? '当前会话未设置工作目录，无法定位项目级技能目录。'
                : `项目根与家目录重合，项目级技能目录与全局技能目录同为 ${globalSkillsDir}，没有独立的项目作用域可写。`,
            }
          }

          const dirs = {
            global: scope === 'project' ? '' : globalSkillsDir,
            project: scope === 'global' ? '' : projectSkillsDir,
          }

          for (const dir of [dirs.global, dirs.project]) {
            if (dir === '') continue
            try {
              if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
            } catch (err) {}
          }

          const existing = {
            global: dirs.global === '' ? [] : listSkills(dirs.global),
            project: dirs.project === '' ? [] : listSkills(dirs.project),
          }

          const compaction = resolveCompaction(agent)
          const prompt = buildPrompt(scope, dirs, existing, Boolean(compaction))

          if (compaction) {
            pendingCompaction.set(agent.session, { agent, commandId })
          }

          try {
            agent.steer({
              id: `reflect:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
              role: 'user',
              content: [{ type: 'text', text: prompt }],
              source: { kind: 'plugin:command-reflect', form: 'notice', summary },
            })
          } catch (error) {
            pendingCompaction.delete(agent.session)
            return {
              kind: 'error',
              text: `无法启动复盘轮次：${error instanceof Error ? error.message : String(error)}`,
            }
          }

          const scopeLines = [
            dirs.global === '' ? '' : `- 通用技能：${dirs.global}`,
            dirs.project === '' ? '' : `- 项目专属技能：${dirs.project}`,
          ].filter(Boolean).join('\n')

          const singleScopeNote = scope === 'both'
            ? ''
            : '\n本轮只写一个作用域：若该作用域确实没有值得沉淀的经验，模型会如实说明，不会强行生成一份。'

          const compactNote = compaction
            ? '技能全部落盘后，模型会通过工具输出 /compaction，系统随即启动上下文压缩总结。'
            : '注意：当前 Agent 预设未挂载压缩后端，本次不会自动压缩上下文。'

          return {
            kind: 'success',
            text: `已触发【复盘${compaction ? ' + 压缩' : ''}】流程：模型正在回顾会话历史，把经验写入本轮作用域：\n${scopeLines}\n${compactNote}${singleScopeNote}`,
          }
        },
      })
    }
  },
}

