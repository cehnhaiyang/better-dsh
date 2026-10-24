// prompt-forge —— 纯函数层（无 ctx、无 IO、无运行时状态，可单独测试）。
//
// 三个上游实现各有一套「把结构化字段拼成提示词」的逻辑，这里统一成一份：
//   · 段落顺序与拼法   ← dsh-plugin-structured-prompt 0.4.0 的 shared/prompt.ts
//   · 输出格式骨架     ← 同上的 shared/format.ts
//   · 参数收窄与回退   ← 同上的 host/args.ts（prefer / isProvidedList / splitCallableTools）
//   · 模型输出清洗     ← dsh-prompt-enhancer 3.4.2 的 pure.js cleanOutput
//
// 为什么单独成文件：这些规则全部是「输入 → 输出」的确定性映射，是三个插件里唯一
// 值得逐字保留的部分。把它们和 ctx 生命周期混在一起，就再也没法单测了。

// ─────────────────────────────────────────────────────────────────────────────
// 一、字段模型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 每个字段的运行时形状。
 *
 * 导入 JSON 文档的校验与内置模板库的校验共用这一份定义 —— 后者同样是文件边界，
 * 坏数据在模块加载期就该报出来。
 */
export const FIELD_SHAPES = {
  role: 'string',
  goal: 'string',
  background: 'string',
  successCriteria: 'string',
  rules: 'string[]',
  forbidden: 'string[]',
  toolPolicy: 'tool-policy',
  callableTools: 'string[]',
  toolSlots: 'string[]',
  toolGuidance: 'string[]',
  toolFailure: 'string',
  outputSpec: 'string',
  outputFormat: 'output-format',
  languageTone: 'string',
  fields: 'string[]',
  fallback: 'string',
  examples: 'string',
}

/** `toolPolicy` 的合法取值。 */
const TOOL_POLICY_VALUES = ['', 'auto', 'manual']

/** 空白表单：所有数组为空、所有文本为空，保证「未填写」与「空串」一致。 */
export function createEmptyForm() {
  return {
    role: '',
    goal: '',
    background: '',
    successCriteria: '',
    rules: [],
    forbidden: [],
    toolPolicy: '',
    callableTools: [],
    toolSlots: [],
    toolGuidance: [],
    toolFailure: '',
    outputSpec: '',
    outputFormat: '',
    languageTone: '',
    fields: [],
    fallback: '',
    examples: '',
  }
}

/**
 * 用片段补全成完整表单。
 *
 * 模板与 JSON 导入都只提供部分字段，缺省项由空白表单补齐 —— 这样新增字段时无需
 * 逐个模板补齐，也不会因为 undefined 漏进渲染。
 */
export function completeForm(patch) {
  return { ...createEmptyForm(), ...(patch && typeof patch === 'object' ? patch : {}) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 二、输出格式骨架
// ─────────────────────────────────────────────────────────────────────────────

/** 输出格式类型到 outputSpec 骨架的映射（用户可在表单里再改）。 */
export const OUTPUT_FORMAT_SKELETONS = {
  json: ['以 JSON 输出，字段如下：', '- field_name: type  // 说明'].join('\n'),
  markdown: ['以 Markdown 输出，结构如下：', '## 结论', '## 依据', '## 后续动作'].join('\n'),
  table: ['以 Markdown 表格输出，列如下：', '| 项 | 值 | 说明 |', '| --- | --- | --- |'].join('\n'),
  text: '以纯文本输出，先给结论，再给依据，不要使用 Markdown 标记。',
}

/**
 * 取某个格式类型的骨架。
 *
 * 用 Object.hasOwn 查表而不是直接下标取值：越界的格式类型（模型传了 schema 外的值、
 * 或旧表单里的历史值）下标取值会得到 undefined，被后续 join 折叠成空串，于是整个
 * 输出格式段静默少一段。
 */
export function resolveSkeleton(format) {
  if (typeof format !== 'string' || !Object.hasOwn(OUTPUT_FORMAT_SKELETONS, format)) return ''
  return OUTPUT_FORMAT_SKELETONS[format]
}

/**
 * 按新选的格式类型更新「输出格式说明」。
 *
 * 三种状态：空或恰为某套骨架 → 整段替换；在某套骨架基础上追加过 → 只替换骨架部分、
 * 保留追加内容；完全手写 → 不动（此时说明才是最终契约）。
 *
 * 中间那条是关键：「已被手写就完全不覆盖」会让用户改选格式后，产物里仍是
 * 原格式的契约，而界面已高亮新值 —— 两边静默分叉。
 */
export function applyFormatChoice(current, format) {
  const skeleton = resolveSkeleton(format)
  if (skeleton === '') return current
  const trimmed = String(current ?? '').trim()
  const known = Object.values(OUTPUT_FORMAT_SKELETONS)
  if (trimmed === '' || known.includes(trimmed)) return skeleton
  const previous = known.find((item) => trimmed.startsWith(item))
  return previous === undefined ? current : skeleton + trimmed.slice(previous.length)
}

// ─────────────────────────────────────────────────────────────────────────────
// 三、参数收窄（工具参数边界）
// ─────────────────────────────────────────────────────────────────────────────

/** 需要按「字符串数组」读取的字段名。 */
export const ARRAY_FIELDS = ['rules', 'forbidden', 'callable_tools', 'tool_guidance', 'fields']

/** 需要按「字符串」读取的非必填字段名。 */
export const STRING_FIELDS = [
  'template', 'background', 'success_criteria', 'tool_policy', 'tool_failure',
  'output_format', 'output_spec', 'language_tone', 'fallback', 'examples',
]

/** 数组条目算不算「空白」。非字符串条目按非空白处理。 */
function isBlankItem(item) {
  return typeof item === 'string' && item.trim() === ''
}

/**
 * 取「调用参数优先，未给则用模板默认值」的值。
 *
 * 空串（含纯空白）、空数组、以及**全由空白条目组成的数组**都算「未给」：模板填了 3 条
 * 硬性规则时，模型传 rules: [] 或 rules: [''] 的意图几乎总是「没额外要求」，而不是
 * 「把模板的规则删掉」。整组判定而不是逐条过滤 —— 逐条过滤会丢掉空串、让工具名与
 * 用途的索引错位。
 */
export function prefer(provided, fallback) {
  if (provided === undefined) return fallback
  if (isBlankItem(provided)) return fallback
  if (Array.isArray(provided) && provided.every(isBlankItem)) return fallback
  return provided
}

/**
 * 一批调用参数条目算不算「给了」。
 *
 * 导出它是为了让必须**整组同进同退**的字段（工具名与用途）复用同一条规则 ——
 * 各自判定会让两个数组错位，例如 [': 用途'] 的工具名为空而用途非空。
 */
export function isProvidedList(items) {
  return Array.isArray(items) && !items.every(isBlankItem)
}

/**
 * 把「工具名」或「工具名：用途」形式的条目拆成两个按索引配对的数组。
 *
 * 第一组允许为空：条目以冒号开头时得到空工具名，该行随后与其它空工具名行一样被
 * 整体忽略 —— 否则「:用途」会被当成一个名叫「:用途」的工具写进提示词。
 */
export function splitCallableTools(entries) {
  const tools = []
  const slots = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    const matched = /^([^：:]*)[：:](.*)$/.exec(String(entry ?? ''))
    if (matched === null) {
      tools.push(String(entry ?? '').trim())
      slots.push('')
    } else {
      tools.push((matched[1] ?? '').trim())
      slots.push((matched[2] ?? '').trim())
    }
  }
  return { tools, slots }
}

/**
 * 把模型传入的参数收窄成可用形状。
 *
 * 不合规就**报错**而不是静默丢弃 —— 失败说明会回到模型手里，它能据此改正。
 *
 * role / goal 通常必填，但**模板可以带**（构建时走 prefer(调用参数, 模板底座)）。
 * 所以只有「既没指模板、又没给」时才报错 —— 否则「只填任务特有的字段、其余交给
 * 模板」这条路径会被边界拦住，而模板存在的意义恰恰是少填字段。
 *
 * @param {unknown} raw - 模型传入的参数。
 * @param {string[]} templateIds - 模板 id 白名单。
 * @returns {object} 收窄后的参数。
 * @throws {Error} 字段类型不符、枚举越界，或「未指模板且缺 role/goal」时。
 */
export function narrowArgs(raw, templateIds) {
  if (typeof raw !== 'object' || raw === null) throw new Error('arguments must be an object')
  const args = raw
  const problems = []

  const usesTemplate = typeof args.template === 'string' && args.template.trim() !== ''
  for (const field of ['role', 'goal']) {
    const value = args[field]
    if (value !== undefined && typeof value !== 'string') {
      problems.push(`${field} must be a string`)
      continue
    }
    if (typeof value === 'string' && value.trim() !== '') continue
    if (usesTemplate) continue
    problems.push(
      `${field} is required and must be a non-empty string `
      + '(or pass `template`: every built-in template carries a role and a goal)',
    )
  }
  for (const field of STRING_FIELDS) {
    const value = args[field]
    if (value !== undefined && typeof value !== 'string') problems.push(`${field} must be a string`)
  }
  for (const field of ARRAY_FIELDS) {
    const value = args[field]
    if (value === undefined) continue
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      problems.push(`${field} must be an array of strings`)
    }
  }
  // 枚举校验：越界值必须报错，不能让它带着 schema 外的取值进入构建流程。
  // 空串按「未给」跳过，与 prefer 的约定一致 —— 否则模型用空串表达「不指定格式」
  // 时会白白失败一次，而其它字符串字段的空串都是合法的。
  const enumFields = {
    output_format: Object.keys(OUTPUT_FORMAT_SKELETONS),
    tool_policy: ['auto', 'manual'],
    template: templateIds,
  }
  for (const [field, allowed] of Object.entries(enumFields)) {
    const value = args[field]
    if (value === undefined) continue
    if (typeof value === 'string' && value.trim() === '') continue
    if (typeof value !== 'string' || !allowed.includes(value)) {
      problems.push(`${field} must be one of: ${allowed.join(', ')}`)
    }
  }
  if (problems.length > 0) throw new Error(`invalid arguments: ${problems.join('; ')}`)

  // role/goal 只在确实给出非空串时写入：缺省时留给 prefer 去回退模板底座，
  // 不能在这里写成空串（那会把「未给」变成「给了个空串」）。
  const narrowed = {}
  for (const field of ['role', 'goal']) {
    const value = args[field]
    if (typeof value === 'string' && value.trim() !== '') narrowed[field] = value.trim()
  }
  for (const field of STRING_FIELDS) {
    const value = args[field]
    if (typeof value === 'string') narrowed[field] = value
  }
  for (const field of ARRAY_FIELDS) {
    const value = args[field]
    if (Array.isArray(value)) narrowed[field] = value
  }
  return narrowed
}

// ─────────────────────────────────────────────────────────────────────────────
// 四、段落渲染
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 把文本按行清洗：去掉行尾空白、折叠连续空行、去首尾空行。
 *
 * 逐行 trimEnd 而不是整体 trim：字段说明里的对齐空格靠这个活下来。
 */
function normalizeBlock(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 逐条清洗数组：丢弃空白条目并去掉首尾空白。 */
function cleanList(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => String(item ?? '').trim())
    .filter((item) => item !== '')
}

/** 工具调用策略为「自动」时的固定引导语。 */
const TOOL_POLICY_AUTO = '由你根据任务需要自行判断并选择要调用的工具；不需要工具时直接回答。'

/**
 * 手动模式下按用户点名的工具生成指定调用语句。
 *
 * 工具名与用途按**原始索引**配对：用途可以留空（只写工具名），工具名留空的行
 * 整体忽略。这里刻意不先过滤数组 —— 过滤会丢掉空串、让用途与工具名错位。
 */
function manualPolicyText(tools, slots) {
  const lines = (Array.isArray(tools) ? tools : [])
    .map((rawTool, index) => {
      const tool = String(rawTool ?? '').trim()
      if (tool === '') return ''
      const purpose = String((Array.isArray(slots) ? slots[index] : '') ?? '').trim()
      return purpose === '' ? `- ${tool}` : `- ${tool}：${purpose}`
    })
    .filter((line) => line !== '')
  if (lines.length === 0) return ''
  return ['只允许调用下列已指定的工具，其余工具一律不要使用：', ...lines].join('\n')
}

/**
 * 构建分段结果。
 *
 * 段落顺序：身份 → 目标 → 硬性规则 → 工具使用策略 → 输出格式 → 数据不足时 → 示例。
 * 空段整体省略（body === ''），非空段之间以单个空行连接。
 *
 * @param {object} form - 表单字段。
 * @returns {Array<{title: string, body: string}>} 段落列表。
 */
export function buildSections(form) {
  const rules = cleanList(form.rules)
  const forbidden = cleanList(form.forbidden)
  const guidance = cleanList(form.toolGuidance)
  const fields = cleanList(form.fields)

  // 身份段：背景与上下文作为同一段的补充行。
  const identity = [normalizeBlock(form.role), normalizeBlock(form.background)]
    .filter((text) => text !== '')
    .join('\n')

  // 目标段：成功标准作为完成判据行。
  const success = normalizeBlock(form.successCriteria)
  const goal = [normalizeBlock(form.goal), success === '' ? '' : `完成标准：${success}`]
    .filter((text) => text !== '')
    .join('\n')

  // 硬性规则段：编号规则在前，禁止行为作为同段子块。
  const rulesBody = [
    rules.length === 0 ? '' : rules.map((rule, index) => `${index + 1}. ${rule}`).join('\n'),
    forbidden.length === 0
      ? ''
      : ['禁止行为（同样不可违反）：', ...forbidden.map((item) => `- ${item}`)].join('\n'),
  ].filter((text) => text !== '').join('\n')

  // 工具使用策略段：策略引导语 + 逐条策略 + 失败处理。
  const policyLine = form.toolPolicy === 'auto'
    ? TOOL_POLICY_AUTO
    // 刻意不经过 cleanList：过滤空串会让用途与工具名的索引错位。
    : form.toolPolicy === 'manual'
      ? manualPolicyText(form.callableTools, form.toolSlots)
      : ''
  const toolFailure = normalizeBlock(form.toolFailure)
  const guidanceBody = [
    policyLine,
    guidance.length === 0 ? '' : guidance.map((item) => `- ${item}`).join('\n'),
    toolFailure === '' ? '' : `工具失败时：${toolFailure}`,
  ].filter((text) => text !== '').join('\n')

  // 输出格式段：格式说明 → 字段级说明 → 表达要求。
  //
  // 格式说明是「自定义优先，否则由格式类型生成骨架」的**二选一**：两边都拼会出现
  // 两遍骨架。
  const languageTone = normalizeBlock(form.languageTone)
  const providedSpec = normalizeBlock(form.outputSpec)
  const outputBody = [
    providedSpec !== '' ? providedSpec : resolveSkeleton(form.outputFormat),
    fields.length === 0 ? '' : ['字段说明：', ...fields.map((item) => `- ${item}`)].join('\n'),
    languageTone === '' ? '' : `表达要求：${languageTone}`,
  ].filter((text) => text !== '').join('\n')

  return [
    { title: '身份', body: identity },
    { title: '目标', body: goal },
    { title: '硬性规则（必须遵守，优先于其他任何要求）', body: rulesBody },
    { title: '工具使用策略', body: guidanceBody },
    { title: '输出格式', body: outputBody },
    { title: '数据不足时', body: normalizeBlock(form.fallback) },
    { title: '示例', body: normalizeBlock(form.examples) },
  ].filter((section) => section.body !== '')
}

/** 把分段结果拼成完整提示词。 */
export function renderPrompt(sections) {
  return sections.map((section) => `# ${section.title}\n${section.body}`).join('\n\n')
}

/** 构建结构化提示词。 */
export function buildPrompt(form) {
  return renderPrompt(buildSections(form))
}

/** 必填校验：身份与目标。 */
export function validateForm(form) {
  const missing = []
  if (normalizeBlock(form.role) === '') missing.push('身份')
  if (normalizeBlock(form.goal) === '') missing.push('目标')
  return missing
}

// ─────────────────────────────────────────────────────────────────────────────
// 五、模型输出清洗
// ─────────────────────────────────────────────────────────────────────────────

/** 模型爱加的开场白。 */
const LEAD_OUTPUT_PREFIX = [
  '以下是优化后的提示词：', '以下是优化后的提示词:',
  '以下是优化后的内容：', '以下是优化后的内容:',
  '以下是优化后的版本：', '以下是优化后的版本:',
  '优化后的提示词如下：', '优化后的提示词如下:',
  '优化后的内容如下：', '优化后的内容如下:',
  '优化结果如下：', '优化结果如下:',
  '修改后的提示词：', '修改后的提示词:',
  '最终结果：', '最终结果:',
  '结果如下：', '结果如下:',
  '输出如下：', '输出如下:',
]

/** 模型爱加的结束语。 */
const TAIL_NOTES = [
  '以上是优化后的提示词', '以上就是优化后的提示词', '以上为优化后的提示词',
  '以上是优化后的内容', '以上是修改后的提示词', '以上是优化结果',
]

/** 会把正文整段包起来的成对定界符。 */
const WRAPPER_PAIRS = [
  ['"""', '"""'],
  ['```', '```'],
  ['"', '"'],
  ["'", "'"],
  ['“', '”'],
  ['‘', '’'],
  ['「', '」'],
  ['『', '』'],
  ['（', '）'],
  ['(', ')'],
  ['【', '】'],
]

/**
 * 清洗模型输出，只留提示词本体。
 *
 * 循环剥离直至稳定（≤3 轮）：模型把发给它的完整指令（「请优化以下提示词：\n"""\n<原文>
 * \n"""」）整段复述进输出时，只剥开头会残留原文。按「完整回显」语义处理：
 * 有后续正文 → 取正文；仅回显无正文 → 取包装内原文。
 *
 * @param {string} raw - 模型原始输出。
 * @param {string} [originalText] - 用户原文（用于精确剥离原文回显段）。
 * @returns {string} 清洗后的提示词本体。
 */
export function cleanOutput(raw, originalText) {
  let s = String(raw ?? '').trim()
  for (let round = 0; round < 3; round++) {
    const before = s

    // ① 完整包装回显：「<指令前缀>"""<原文>"""<正文>」
    const echo = /^((?:请优化以下提示词[：:]\s*|优化以下提示词[：:]\s*|【用户输入】\s*\n?)\s*"""(?:\r?\n)?)([\s\S]*?)(?:\n"""\s*)([\s\S]*)$/.exec(s)
    if (echo) {
      const inner = (echo[2] ?? '').trim()
      const after = (echo[3] ?? '').trim()
      if (after !== '') s = after
      else if (inner !== '') s = inner
    }

    // ② 孤立前缀：模型只回显「请优化以下提示词：」而没有闭合包装。
    const lonePrefix = /^(?:请优化以下提示词[：:]\s*\n?|优化以下提示词[：:]\s*\n?|【用户输入】\s*\n?)/
    if (lonePrefix.test(s)) {
      const stripped = s.replace(lonePrefix, '').trim()
      if (stripped !== '') s = stripped
    }

    // ③ 原文回显：结果以原文开头且更长 → 剥掉原文段。结果等于原文时不误伤。
    if (typeof originalText === 'string' && originalText.trim() !== '') {
      const ot = originalText.trim()
      if (s.startsWith(ot) && s.length > ot.length) {
        s = s.slice(ot.length).replace(/^[，。！？!?\s、]+/, '').trim()
      }
    }

    for (const prefix of LEAD_OUTPUT_PREFIX) {
      if (s.startsWith(prefix)) { s = s.slice(prefix.length).trim(); break }
    }
    for (const note of TAIL_NOTES) {
      if (s.endsWith(note)) { s = s.slice(0, -note.length).trim(); break }
    }
    if (s === before) break
  }

  for (const [open, close] of WRAPPER_PAIRS) {
    if (s.length > open.length + close.length && s.startsWith(open) && s.endsWith(close)) {
      s = s.slice(open.length, s.length - close.length).trim()
      break
    }
  }
  return s
}

// ─────────────────────────────────────────────────────────────────────────────
// 六、表单文档（导入 / 导出）
// ─────────────────────────────────────────────────────────────────────────────

/** 导出文档的当前 schema 版本。字段增删或语义变化时递增。 */
export const FORM_DOCUMENT_VERSION = 1

/** 把表单序列化成带版本号的导出文档。 */
export function serializeForm(form) {
  return { version: FORM_DOCUMENT_VERSION, form: completeForm(form) }
}

/** 按声明的形状校验一个字段值。 */
export function matchesShape(value, shape) {
  if (shape === 'string') return typeof value === 'string'
  if (shape === 'string[]') return Array.isArray(value) && value.every((item) => typeof item === 'string')
  if (shape === 'tool-policy') return TOOL_POLICY_VALUES.includes(value)
  if (shape === 'output-format') return value === '' || Object.hasOwn(OUTPUT_FORMAT_SKELETONS, value)
  return false
}

/**
 * 解析导入的表单文档。
 *
 * 接受两种输入：本版本导出的 {version, form}，以及早期版本直接导出的**裸表单**。
 * 只保留已知字段并逐字段校验形状：未知键、类型不符、越界枚举都会被丢弃并记进
 * warnings，而不是混进表单。
 *
 * @param {string} text - 文件内容。
 * @returns {{patch: object, warnings: string[]}} 表单片段与被忽略内容的说明。
 * @throws {Error} 内容不是合法 JSON、或顶层不是对象时。
 */
export function parseFormDocument(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error('不是合法的 JSON')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('顶层必须是对象')

  const warnings = []
  let source = raw
  // 只用 version 判定版本化文档：form 这个键本身不能作为标志 —— 用户手写
  // {form: {...}} 却忘写 version 时会被判成「缺少版本号」，报出与内容无关的错误。
  if ('version' in raw) {
    const version = raw.version
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      throw new Error('version 必须是正整数')
    }
    if (version > FORM_DOCUMENT_VERSION) {
      warnings.push(`文档版本 ${version} 比本插件支持的 ${FORM_DOCUMENT_VERSION} 新，未识别的字段会被忽略`)
    }
    const inner = raw.form
    if (typeof inner !== 'object' || inner === null || Array.isArray(inner)) throw new Error('form 必须是对象')
    source = inner
  } else if (raw.form && typeof raw.form === 'object' && !Array.isArray(raw.form)) {
    // 手写成 {form: {...}} 却漏了 version：按那个对象解析，不要把内容整份丢掉 ——
    // 丢掉之后调用方会拿空 patch 覆盖表单，把用户已填的内容清空。
    warnings.push('缺少版本号：已按 form 字段的内容解析')
    source = raw.form
  } else {
    warnings.push('这是没有版本号的旧导出文件，已按最初版本解析')
  }

  const patch = {}
  for (const [key, value] of Object.entries(source)) {
    const shape = FIELD_SHAPES[key]
    if (shape === undefined) { warnings.push(`忽略未知字段 ${key}`); continue }
    if (!matchesShape(value, shape)) { warnings.push(`忽略字段 ${key}：取值不符合 ${shape}`); continue }
    patch[key] = value
  }
  return { patch, warnings }
}
