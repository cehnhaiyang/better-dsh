---
name: react-state-and-identity-audit
description: 审查 React 状态与数据标识时的七类高频缺陷模式与排查手法——键/标识不唯一导致两条数据塌成一条、同一判据多处各写一份而漂移、异步结果写回过期上下文、共享布尔量被并发操作互相覆盖、注释与代码不符、不可达分支与无人用的死代码、以及 memo 被"每轮新引用"悄悄废掉。每类都给出判据、修法与可复制的排查脚本。被要求"审查/修复某模块的所有问题"时、审查 hook 或面板状态与列表渲染与持久化往返时、写完功能自查时、或感觉"界面上显示的和实际发生的不一致"时读。
---

# React 状态与数据标识审查

**用途**：一份**缺陷模式清单**，用于主动找 bug，而不是等它暴露。

一个 Electron + React 应用的浏览器链路连续多轮审查找到 20+ 个真 bug，
事后分类发现它们**反复落在这七类里**。

- 验证手法（变异测试、抽取求值）见 `verification-discipline`
- 编码与工具坑见 `safe-source-file-editing`

---

## 模式 A：键 / 标识不唯一 → 两条数据塌成一条

**最隐蔽的一类**：代码不报错、测试不失败，只是**少显示一条**。

### 判据

列表 / Map / reduce 的键，是否**真的唯一**？

```js
// ✗ 键不含 domain —— 而 Chrome 的 cookie 主键是 name + domain + path
cookiePathIndex = (c) => !c.path || c.path === '/' ? c.name : `${c.name} (${c.path})`

// 访问 https://sub.example.com/ 时 cookies.get 同时返回
//   sid@sub.example.com  (HOST-ONLY)
//   sid@.example.com      (PARENT-DOM)
// reduce 后 { "sid": "PARENT-DOM" }  ← 只显示 1 条，应为 2
```

### 三类连带后果

| 后果 | 说明 |
|---|---|
| 界面少一行 | 用户不知道有两条 |
| 回写改错对象 | `find(c => c.name === key)` 永远命中第一条 |
| **属性被污染** | `setCookie` 是整条覆盖 → 把第一条的 `httpOnly` / 过期时间抄到第二条 |

### 修法：碰撞感知的键，而不是无脑加字段

```js
// 先算最简键，只在真会撞时才补区分信息 —— 否则界面被刷成噪声
export const buildCookieKeys = (cookies) => {
    const brief = cookies.map((c) => !c.path || c.path === '/' ? c.name : `${c.name} (${c.path})`);
    const counts = new Map();
    for (const k of brief) counts.set(k, (counts.get(k) || 0) + 1);
    return brief.map((k, i) => counts.get(k) > 1 && cookies[i].domain
        ? `${k} @${cookies[i].domain}` : k);
};
```

配套 `buildCookieData` / `findCookieByKey`，**面板与 Agent 共用**。

### 排查手法

```js
// 造两条「业务上不同、键上相同」的数据，看 reduce / find 的结果
const cookies = [
  { name:'sid', value:'A', domain:'sub.example.com', path:'/' },
  { name:'sid', value:'B', domain:'.example.com',   path:'/' },
];
const data = cookies.reduce((a,c)=>({...a,[key(c)]:c.value}), {});
console.log(Object.keys(data).length);   // 应为 2
```

### 变体：按「值」去重丢掉了「位置」

```js
// ✗ 同一个 token 常同时躺在 local / session / cookie 里（登录态就是这样）
if (!found.some((f) => f.token === token)) found.push({ token, from, area, key });
// → 只报最先扫到的那一处，模型以为改一处就够了
```

**判据**：去重的目的若是「避免重复条目」，就该按**位置**去重，不是按值。
值相同但位置不同，是**两条需要分别处理的信息**。

---

## 模式 B：同一判据多处各写一份 → 漂移

### 判据

搜同一个语义判断出现了几次：

```powershell
# 例：判断「这条结果是否属于当前页」
Select-String -Path hooks\*.ts,components\*.tsx -Pattern 'pageUrl ===|!.*pageUrl'
```

三份实现里，「清空当前」那份**少了 `!item.pageUrl` 一支**：

```
点「仅当前页」后显示的条目 : a, b
点「清空当前」后剩下的条目 : b, c
清空后仍在列表里的 : b      ← 按钮看起来没生效
```

### 修法

抽成**唯一实现**（放 `utils/`，因为跨组件 + 可单测），三处共用。
若其中一份在**无法 import 的地方**（如注入脚本的模板字符串里），
就写**交叉验证测试**在同一批输入上比对两边结论。

### 跨进程变体

主进程（CJS）不能 import 渲染层（TS）→ 常量是**派生副本**。
副本漂移**不报错**，只让同一输入在两条路径上得到不同结论：

| 漂移 | 后果 |
|---|---|
| 某扩展名在主进程属 video、在 utils 属 stream | 筛选归错类；`type !== 'stream'` 让它**跳过转码检查** |
| UA 字面量两份 | 三处 UA 矛盾 → Cloudflare 挑战必失败 |

**修法**：在静态自检里加一致性断言 —— **只比对两边都有的键**，
并让报错**打印出具体差异**，否则看到 `FAIL` 也不知道差在哪。

---

## 模式 C：过期结果写回新上下文

**异步操作返回时，它出发时的那个上下文可能已经不在了。**

### 判据

每个 `await` 之后、**写 state 之前**，有没有校验「我还是当初那个我」？

```js
// ✗ AI 接口要十几秒，用户完全可能中途切页
const extracted = await extractMediaLinks(content, ...);
addLinks(extracted.map((item) => ({ ...item, pageUrl: targetUrl })));  // 旧页 URL 入列！
```

### 修法：两种判据，按驱动方式选

```js
// ① 由 URL 变化驱动、有轮次的 → 用 runId
const isCurrentRun = (runId) => runId === undefined || latestRunRef.current === runId;

// ② 不由 URL 驱动、没有轮次的 → 比「出发时那个页面还是当前页吗」
const stillOnPage = () => (activeTabRef.current?.url || '') === targetUrl;
if (!stillOnPage()) return;   // 结果属于上一个页面，丢弃
```

**选错判据的代价**：给②硬套 runId 会永远为真（没有轮次在推进）。

### 同族：下标在过滤后错位

```js
// ✗ activeIndex 是落盘时那份数组的下标，而读回时会过滤掉空白页
const tabs = saved.tabs.filter(t => t.url).slice(0, MAX);
const activeIndex = Math.min(saved.activeIndex, tabs.length - 1);
// [空白, A, B] 且正在看 A（index 1）→ 过滤成 [A, B] → 用 1 索引 → 落到 B
```

**修法**：**一边过滤一边映射下标**，而不是过滤完再套用旧下标。

### 同族：`slice(0, MAX)` 保留的是最旧的

条目按发现 / 收藏顺序**追加**，末尾最新 → `slice(0, MAX)` 把磁盘副本
永久冻结在最早那批，之后**再操作什么都不会落盘**。

```js
// ✗ 攒够 300 条后，磁盘上永远是启动时那批
saveJSON(KEY, items.slice(0, MAX));
// ✓ 保留最新的
saveJSON(KEY, items.slice(-MAX));
```

**同族：`findIndex` 在 `slice` 之后**

```js
// ✗ 25 个标签页、正在看第 25 个 → 存下 index=24，但只保存了 20 条 → 越界
const activeIndex = Math.max(0, tabs.findIndex(t => t.id === activeTabId));
saveJSON(KEY, { tabs: tabs.slice(0, MAX), activeIndex });
// ✓ 先在保存的那一批里找
const kept = tabs.slice(0, MAX);
const found = kept.findIndex(t => t.id === activeTabId);
```

> **元规则**：每修一个 bug，问「同一模式在别处还有吗」。
> 发现 `slice(0, MAX)` 取最旧 → 全仓搜同一模式 → **又找到 3 处**（书签、嗅探、标签页）。

---

## 模式 D：共享布尔量被并发操作互相覆盖

### 判据

`isXxx` 布尔 state 是否被**两个以上独立操作**写？

```js
// ✗ scan 与 analyzeWithAi 共用一个 isAnalyzing
setIsAnalyzing(true);   // scan 开始
setIsAnalyzing(false);  // scan 结束 —— 但 AI 请求还在飞
```

时间线：

```
analyzeWithAi(A) 开始 : isAnalyzing = true
scan(B, run1) 开始    : isAnalyzing = true
scan(B, run1) 结束    : isAnalyzing = false   ← 转圈在这里停了
=> 界面显示「未在分析」、按钮重新可点，用户以为没反应，再点一次 → 并发两轮
```

### 修法：计数 + `trackOp` 包一层

```js
const [pendingOps, setPendingOps] = useState(0);
const isAnalyzing = pendingOps > 0;

const trackOp = useCallback(async (fn) => {
    setPendingOps((n) => n + 1);
    try { return await fn(); }
    finally { setPendingOps((n) => Math.max(0, n - 1)); }   // 必须夹下界
}, []);
```

**三个要点**：

1. 用 `finally` 归还，覆盖成功 / 失败 / 提前 `return` 三条路径
2. `Math.max(0, n - 1)` 夹下界 —— 否则提前 return 累积会让它变负、之后永久 `true`
3. **不要**再按轮次判断何时归还（`if (isCurrentRun(runId)) setX(false)`）——
   过期轮次也持有自己那份计数，漏掉就永久转圈

---

## 模式 E：注释与代码不符

**注释说的和代码做的不一致时，人（和 AI）会照着注释推理，得出错误结论。**

| 注释声称 | 代码实际 |
|---|---|
| 「对外只导出 X 与状态类型」 | 还额外导出了两个纯函数 |
| 某常量注释「全满载占预算 66%」 | 实际值让占用达 **220%** |
| 「Chrome 的 cookie 主键是 name + domain + path」 | 实现只用了 name + path（见模式 A） |
| 「过滤某类切片分段」 | 判据对该类分片**永不成立**（见模式 F） |
| 「内容始终挂载（收起只是 display:none）」 | 代码是提前 `return`，收起时**卸载**了，滚动位置会丢 |

### 手法：核对注释里提到的标识符是否还存在

```js
const inCode = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
for (const id of mentions) {
  if (!new RegExp(`(?<![\\w$])${id}(?![\\w$])`).test(inCode)) console.log('可能过时:', id);
}
```

**注意误报**：`IPC`、`HTML`、`UTF`、`MIDI` 这类缩写会被当成标识符；
跨目录引用的符号也会误报。**逐个核实，不要照着扫描结果直接改。**

### 一条给自己的规矩

**改动让某条注释失真时，同一次改动里就要改掉它。**

写「始终 / 永远 / 不会」这类**绝对化措辞**时，**立刻回代码里找出对应的那一行**。
找不到就是注释在说谎。

```powershell
Select-String -Path components/*.tsx -Pattern '始终|永远|绝不|只是|不会'
```

### 反模式：留下「这里曾经有什么」的历史叙述

删掉一段代码后写注释说明「这里曾有一个 XX 按钮，已删除，因为……」——
**这是给读代码的人增加噪音**：他不需要知道曾经有什么。

**判据**：注释应该解释「为什么现在是这样」，而不是「以前不是这样」。
唯一的例外是记录**仍可能复发的陷阱**（如「不要改回条件渲染，会丢状态」）——
那是在防止未来的错误，不是历史叙述。

---

## 模式 F：不可达 / 无人用的死代码

### 三个子类

| 子类 | 判据 | 例子 |
|---|---|---|
| **分支不可达** | 条件在调用点永远为假 | `ext === 'ts'` 对 HLS 分片永不成立（`ext` 是 `'mp2t'`）→ 里面的判断是死代码 → **几十个分片全进列表** |
| **类 / 常量无人用** | 定义存在、全仓零引用 | 某动画类名 + 对应 `@keyframes`；三个同族常量只剩声明 |
| **机制无入口** | 整条链路没有任何调用方 | 一组导航函数约 53 行，三个提交里都零调用 |

### 分支不可达怎么找

**看条件的取值域是否真的能命中**：

```js
// 步骤 1 先跑：contentType.startsWith('video/') → detectedType='video', ext='mp2t'
// 步骤 2 只在 !detectedType 时跑 → ext 保持 'mp2t'
// 步骤 3 判据 ext === 'ts' → 'mp2t' !== 'ts' → 永不进入
```

**手法**：把判定逻辑复刻出来，喂**真实世界的输入**，看分支走不走得到：

```js
for (const [ct, path] of [['video/mp2t','/hls/seg001.ts'], ['','/hls/seg001.ts']]) {
  const r = detect(ct, path);
  console.log(`ct=${ct} → type=${r.detectedType} ext=${r.ext}`);
}
```

### 死代码的危害不只是冗余

- **掩盖机制失效**：不可达分支让代码「看起来有防护」，实际没有
- **误导下一个读者**：某个常量存在会让人以为「改它能改到对应部位」
- **危险 API 暴露**：把「错误写法」也导出成可用入口，注释明写它会每渲染清空状态 ——
  **删掉它就没有第二条路可选**

### 子类四：删掉一个 UI 特判会带出一整条死 prop 链

删掉「按域名决定显示哪个按钮」的 UI 特判后，那条特判用到的 prop
**就此失去唯一消费点**，但编译**不会报错**
（TS 的 prop 类型允许父组件传一个子组件不用的值）——
于是它变成一条**空转的管道**：父组件算、传、子组件收，没人用。

**连锁清单**：

| 死掉的东西 | 原因 |
|---|---|
| 一个回调 prop（穿过两层组件 + 顶层传参） | 那个按钮是唯一用处 |
| 另一个回调 prop（穿过两层组件 + 顶层传参） | 那条横幅是唯一用处 |
| 若干 icon / 判定函数的 import | 随代码一起失效 |
| 顶层一个 ~75 行的处理函数 | 它的两个调用点正是被删的两个入口 |

**手法**：删完 UI 后，对每个曾用到的 prop / import **数一次引用**：

```powershell
@'
const fs = require('fs');
const src = fs.readFileSync('D:/proj/components/Panel.tsx', 'utf8');
const noComments = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
for (const n of ['SomeIcon','OtherIcon','isSpecialSite','onOpenThing']) {
  const c = (noComments.match(new RegExp('(?<![\\w$])' + n + '(?![\\w$])', 'g')) || []).length;
  console.log(n.padEnd(24) + c + (c <= 1 ? '  <-- 只剩 import 行，死代码' : ''));
}
'@ | node -
```

**判据**：**引用数 = 1 且那一处就是 import / 类型声明** → 死代码。

**终审用编译器**，比肉眼看可靠：

```powershell
npx tsc --noEmit --noUnusedLocals --noUnusedParameters 2>&1 |
  Select-String -Pattern 'Panel|App\.tsx'
```

> 默认的 `tsc --noEmit` **不报**未使用的局部变量 / 参数，
> 所以「构建是绿的」不能证明没有死代码。要专门开这两个开关查一次。
> ⚠️ 全项目跑这个开关会有既有告警（音频面板、解析器等），
> **只看你改过的文件**，不要去修别人的。

**删入口前先摸清依赖归属**：那些 prop 的**兄弟**可能还活着 ——
若某个 handler 同时是另一个面板的 props，就**必须保留**。
判据是「除了这条死链，还有谁在用」。

### 子类五：纯 UI 的站点特判

**判据**：这段代码只因为「当前站点是 X」而改变**外观或入口**，不影响数据正确性。

**典型的两处（可删）**：

- 地址栏按域名 + 路径关键字切换按钮文案与配色
- 嗅探面板顶部「本站页面…请走画廊」的横幅

**但同一批站点判定调用里，另两处必须保留** —— 它们**不是 UI**：

| 保留 | 为什么 |
|---|---|
| 嗅探过滤里的站点判定 | **过滤规则**：删了图床会把封面 / 分片灌进嗅探列表 |
| 站点判定工具函数本身 | 同时是 HLS 请求签名的开关：删了该类视频**全部 403** |
| 主进程的嗅探排除后缀表 | 主进程是嗅探的实际拦截点，且被静态自检校验同口径 |

**教训**：用户说「删掉某站点的特殊检测」时，
**先按「它改变的是外观还是数据」分类**，把清单和后果列给用户确认，
**不要整批删**。同一个判定函数的调用点可能分属两类。

---

## 模式 G：记忆化被「每轮新引用」悄悄废掉

**不报错、不影响功能，只是白写了 `React.memo`** ——
所以没人会发现，直到某天列表长到卡顿。

### 判据：`useMemo` / `React.memo` 的依赖里，有没有**每轮新建**的东西

**其一：依赖了整个 actions 对象。**

```tsx
// 逐个取出：actions 对象每轮都是新引用，直接依赖它会让下面所有 memo 失效
const { downloadHit, saveFile, setNotice, setError } = actions;

const onDeleteTask = useCallback((task) => {
  if (window.confirm(msg)) void actions.cancelTask(task.id);   // ✗ 又用了 actions
}, [actions]);                                                  // ✗ 依赖也带上了
```

某个 hook 的返回是**裸对象字面量**（不是 `useMemo`），
所以 `actions` 每次渲染都是新引用 → `onDeleteTask` 每轮重建 →
传给 `React.memo(TaskRow)`（列表行组件）的 prop 每轮都变 → **memo 完全无效**。

**修法**：`const { …, cancelTask } = actions;` 然后 `[cancelTask]`。

**其二：JSX 元素数组每次重建。**

```tsx
// ✗ 拖动悬浮球时 position 每帧变 → 整个组件重渲染 →
//   这个数组每帧重建 → 里面 300 条列表跟着每帧重建
const panels = [
  { key: 'sniff', node: <SniffPanel ... /> },
  { key: 'tasks', node: <TaskPanel /> },
];
```

**修法**：元素本身 memo 住，引用不变时 React 会跳过整棵子树
（**与它是不是 `hidden` 无关**）：

```tsx
const sniffNode = useMemo(() => <SniffPanel ... />, [sniffer, onPlay, onAiAnalyze, currentUrl]);
const taskNode = useMemo(() => <TaskPanel />, []);   // 不吃 props → 真正一次性
```

### 变体：内联 `style` 悄悄盖掉类上的过渡

```tsx
// 原来：transition: 'all 320ms ...' 顺带覆盖了 transform
// 改成显式列属性时漏了 transform ↓
style={{ transition: 'left 320ms, top 320ms, width 320ms' }}
className="transition-transform hover:scale-105"   // ✗ 永远不生效
```

**内联 `transition` 会盖掉类上的 `transition-*`。**
把 `all` 展开成显式属性时，**必须把类里用到的属性一并列进去**（这里是 `transform`），
否则 hover 缩放从「渐变」退化成「瞬变」。

### 排查手法

```js
// 1. 找「每轮新建」的对象来源：hook 返回的那个对象是不是 useMemo 的？
//    判据要落到具体那个对象，不是整个 return：
//      某个 hook → 裸对象字面量，actions 每轮新引用  ← 出问题的就是它
//      另一个   → return useMemo(...)，actions 稳定
//      第三个   → 外层 return 是字面量，但内部 methods 本身是 useMemo，稳定
const s = fs.readFileSync('hooks/useSearch.ts','utf8');
console.log(/return useMemo/.test(s) ? 'useMemo（引用稳定）' : '裸对象字面量（每轮新引用）');

// 2. 找 useCallback 依赖里的大对象
//    逐个列出依赖数组，扫一眼有没有 actions / state / props 整体
```

> **元规则**：给某个组件加 `React.memo` 时，
> **必须同时检查它收到的每个 prop 是否引用稳定**。
> 加 memo 而不修 prop，等于没加 —— 而且更难发现，因为代码「看起来已经优化过了」。

---

## 通用排查顺序

面对「审查某模块所有问题」这类任务，按这个顺序走效率最高：

1. **列出数据流**：什么数据、存哪（state / localStorage / 主进程）、谁读写
2. **查键唯一性**（模式 A）—— 最隐蔽，先查
3. **搜重复判据**（模式 B）—— 同一个语义判断出现 >1 次就有风险
4. **每个 `await` 后问「上下文还在吗」**（模式 C）
5. **每个布尔 state 问「谁会写它」**（模式 D）
6. **核对注释提到的标识符**（模式 E）
7. **找不可达分支与零引用导出**（模式 F）
8. **看每个 memo 的依赖是否引用稳定**（模式 G）

---

## 一条元规则

> **每修一个 bug，问「同一模式在别处还有吗」。**

收益几乎都来自这一步：

- 发现 `slice(0, MAX)` 取最旧 → 全仓搜同一模式 → **又找到 3 处**（书签、嗅探、标签页）
- 发现 cookie 键缺 domain → 同一缺陷在另一处 `tokens` 里**更严重**（两条来源字段完全相同）
- 发现 `analyzeWithAi` 无过期保护 → 对照 `scan` 有 6 处守卫 → 确认是遗漏而非设计

---

## 自查清单

- [ ] 每个列表 / Map 的键都真的唯一吗（造两条「业务不同、键相同」的数据验一下）？
- [ ] 同一个语义判断在全仓出现几次？超过一次就抽成唯一实现
- [ ] 每个 `await` 写 state 前，校验「我还是当初那个我」了吗？
- [ ] 过滤 / 截断之后，下标是在**过滤后的那份**里算的吗？
- [ ] 每个 `isXxx` 布尔量有几个写者？并发时会不会互相覆盖？
- [ ] 注释里提到的东西，代码里都还在吗？绝对化措辞有对应实现吗？
- [ ] 有没有永假分支、零引用导出、无入口机制？
- [ ] 每个 `React.memo` 的每个 prop 都引用稳定吗？
