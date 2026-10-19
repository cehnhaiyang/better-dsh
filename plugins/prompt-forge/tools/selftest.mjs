// prompt.js 的自检：三段渲染 + 清洗。跑法：node tools/selftest.mjs
import * as m from '../lib/prompt.js'

let failed = 0
// 数组与对象按结构比较：`===` 比引用，prefer/splitCallableTools 每次都返回新数组，
// 用引用比较会让本该通过的断言假失败。
function same(a, b) {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (typeof a !== 'object') return false
  return JSON.stringify(a) === JSON.stringify(b)
}
function check(label, actual, expected) {
  if (same(actual, expected)) { console.log('ok   ' + label); return }
  failed += 1
  console.log('FAIL ' + label)
  console.log('  expected: ' + JSON.stringify(expected))
  console.log('  actual  : ' + JSON.stringify(actual))
}

// ── 1. 最小表单：只输出两段 ───────────────────────────────────────────────
const minimal = m.buildPrompt(m.completeForm({ role: '一名严谨的工程师', goal: '把这次改动写成一段说明。' }))
check('minimal', minimal, [
  '# 身份',
  '一名严谨的工程师',
  '',
  '# 目标',
  '把这次改动写成一段说明。',
].join('\n'))

// ── 2. 全字段 + manual 工具 + table 骨架 ─────────────────────────────────
const full = m.buildPrompt(m.completeForm({
  role: '你是一名负责线上稳定性的 SRE 助手',
  background: '服务于一个日订单量百万级的电商系统。',
  goal: '根据监控数据判断告警是否需要人工立即介入。',
  successCriteria: '每条结论都能指向具体的指标与时间窗口。',
  rules: ['只能基于工具返回的数据下结论', '所有数值必须带上单位和时间窗口'],
  forbidden: ['不得引用记忆中其他系统的经验值'],
  toolPolicy: 'manual',
  callableTools: ['query_metrics', 'read_config'],
  toolSlots: ['拉取指标', ''],
  toolGuidance: ['先查配置再下判断'],
  toolFailure: '说明失败原因，不要用默认值代替。',
  outputSpec: '以 Markdown 表格输出，列如下：\n| 项 | 值 | 说明 |\n| --- | --- | --- |',
  fields: ['指标: string', '结论: string'],
  languageTone: '简洁直接，中文。',
  fallback: '若关键指标缺失，明确说明缺失项。',
  examples: '输入 A → 输出 B',
}))
check('full', full, [
  '# 身份',
  '你是一名负责线上稳定性的 SRE 助手',
  '服务于一个日订单量百万级的电商系统。',
  '',
  '# 目标',
  '根据监控数据判断告警是否需要人工立即介入。',
  '完成标准：每条结论都能指向具体的指标与时间窗口。',
  '',
  '# 硬性规则（必须遵守，优先于其他任何要求）',
  '1. 只能基于工具返回的数据下结论',
  '2. 所有数值必须带上单位和时间窗口',
  '禁止行为（同样不可违反）：',
  '- 不得引用记忆中其他系统的经验值',
  '',
  '# 工具使用策略',
  '只允许调用下列已指定的工具，其余工具一律不要使用：',
  '- query_metrics：拉取指标',
  '- read_config',
  '- 先查配置再下判断',
  '工具失败时：说明失败原因，不要用默认值代替。',
  '',
  '# 输出格式',
  '以 Markdown 表格输出，列如下：',
  '| 项 | 值 | 说明 |',
  '| --- | --- | --- |',
  '字段说明：',
  '- 指标: string',
  '- 结论: string',
  '表达要求：简洁直接，中文。',
  '',
  '# 数据不足时',
  '若关键指标缺失，明确说明缺失项。',
  '',
  '# 示例',
  '输入 A → 输出 B',
].join('\n'))

// ── 3. 空段省略：没有规则/工具/格式时不出现空标题 ──────────────────────
const bare = m.buildPrompt(m.completeForm({ role: 'R', goal: 'G' }))
check('no-empty-headings', /^# 硬性规则/m.test(bare), false)

// ── 4. cleanOutput：开场白 + 围栏 ───────────────────────────────────────
check('clean-prefix-fence',
  m.cleanOutput('以下是优化后的提示词：\n```\n请编写排序算法\n```\n以上是优化后的提示词'),
  '请编写排序算法')

// ── 5. cleanOutput：完整指令回显 → 取正文 ───────────────────────────────
check('clean-echo-body',
  m.cleanOutput('请优化以下提示词：\n"""\n帮我写个脚本\n"""\n\n请编写一个备份脚本'),
  '请编写一个备份脚本')

// ── 6. cleanOutput：只回显无正文 → 取包装内原文 ─────────────────────────
check('clean-echo-inner',
  m.cleanOutput('请优化以下提示词：\n"""\n帮我写个脚本\n"""'),
  '帮我写个脚本')

// ── 7. prefer：全空白数组算「未给」 ─────────────────────────────────────
check('prefer-blank-array', m.prefer(['', '  '], ['模板规则']), ['模板规则'])
check('prefer-empty-string', m.prefer('   ', '模板值'), '模板值')
check('prefer-given', m.prefer(['自己的'], ['模板规则']), ['自己的'])

// ── 8. splitCallableTools：全角/半角冒号 ────────────────────────────────
const split = m.splitCallableTools(['query_metrics：取指标', 'read_config: 读配置', 'plain', ': 只有用途'])
check('split-tools', split.tools, ['query_metrics', 'read_config', 'plain', ''])
check('split-slots', split.slots, ['取指标', '读配置', '', '只有用途'])

// ── 9. applyFormatChoice：骨架基础上追加 → 只换骨架 ─────────────────────
const tableSkel = m.resolveSkeleton('table')
check('format-replace-empty', m.applyFormatChoice('', 'table'), tableSkel)
check('format-keep-append', m.applyFormatChoice(tableSkel + '\n额外一行', 'json'), m.resolveSkeleton('json') + '\n额外一行')
check('format-detached', m.applyFormatChoice('完全手写的契约', 'json'), '完全手写的契约')

// ── 10. narrowArgs：模板在场时可省 role/goal ────────────────────────────
const ids = ['alert-triage']
check('narrow-template-ok', typeof m.narrowArgs({ template: 'alert-triage' }, ids), 'object')
let threw = false
try { m.narrowArgs({ goal: 'x' }, ids) } catch { threw = true }
check('narrow-missing-role-throws', threw, true)
threw = false
try { m.narrowArgs({ role: 'r', goal: 'g', output_format: 'xml' }, ids) } catch { threw = true }
check('narrow-bad-enum-throws', threw, true)

// ── 11. 模板库完整性：每套都有非空 role + goal ──────────────────────────
const tpl = await import('../lib/templates.js')
for (const t of tpl.TEMPLATES) {
  const ok = typeof t.fields?.role === 'string' && t.fields.role.trim() !== ''
    && typeof t.fields?.goal === 'string' && t.fields.goal.trim() !== ''
  if (!ok) { failed += 1; console.log('FAIL template ' + t.id + ' lacks role/goal') }
}
console.log('ok   templates: ' + tpl.TEMPLATES.length + ' 套，均有 role+goal')

// ── 12. 模板 → 表单 → 提示词：端到端不炸 ────────────────────────────────
for (const t of tpl.TEMPLATES) {
  const prompt = m.buildPrompt(m.completeForm(t.fields))
  if (prompt === '' || m.validateForm(m.completeForm(t.fields)).length > 0) {
    failed += 1
    console.log('FAIL template ' + t.id + ' produced invalid prompt')
  }
}
console.log('ok   templates render')

console.log(failed === 0 ? '\nALL PASS' : '\n' + failed + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
