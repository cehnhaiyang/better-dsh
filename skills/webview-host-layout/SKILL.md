---
name: webview-host-layout
description: 在渲染层页面里承载 Electron webview 时的布局与交互硬约束。含 OOPIF 吞掉指针事件导致拖拽"失焦"的正确修法（全视口遮罩 + blur 兜底）、webview 父链一旦变动就重载页面因此只能改宽度不能改结构、常驻边栏与全屏面板该用 flex 兄弟还是 fixed 覆盖、z-index 排序、动态宽度必须用容器查询而非视口断点、CSS 关键帧动画会压住工具类、prefers-reduced-motion 块的书写位置与特异性陷阱、以及何时该把多个组件文件合并成一个。要在 webview 周围加交互、调整含 webview 的面板布局/宽度/开合/全屏、或合并拆分浏览器面板组件文件时读。
---

# webview 宿主页面的布局与交互

**核心事实：`<webview>` 不是普通 DOM 元素，是 Chromium 的跨进程 OOPIF。**

官方文档原文：

> You can not add keyboard, mouse, and scroll event listeners to `webview`

- 主进程侧的约束（模块边界、`webRequest`、属性语义）见 `electron-main-constraints`
- 审查 React 状态与死代码的方法见 `react-state-and-identity-audit`
- HLS 与流媒体下载见 `hls-and-media-download`

---

## 一、指针交互：跨 webview 边界必须盖遮罩

### 症状：拖动侧边栏「失焦」

鼠标从拖拽手柄往左偏一点点，拖动当场失效；挪回来又能接着拖。
表现为「幅度稍大就失焦」，几乎无法改变宽度。

**三个错误归因**（都会先被想到，都不对）：「失焦」、闭包过期、
或配置变化导致 `onMouseDown` 被换成新函数。

**真正原因**：`window.addEventListener('mousemove')` **收不到指针落在 webview 上之后的移动**。
手柄贴在边栏左边缘，鼠标往左一偏就压到 webview 上，
`mousemove` 不再冒泡到宿主页面的 `window`。
**监听器本身没坏，是事件根本送不到。**

**修法**：拖动期间盖一层全视口透明遮罩，让指针始终落在宿主页面里。

```tsx
{resizing && <div className="fixed inset-0 z-[60] cursor-col-resize" />}
```

### 配套：拖到窗口外松手，遮罩会撤不掉

拖出窗口时 `mouseup` 收不到 → `resizing` 一直挂着、遮罩不撤 →
**整个页面再也点不动**。必须同时监听 `blur` 收尾：

```tsx
const onCancel = () => onUp();
window.addEventListener('blur', onCancel);
// 清理时一并 removeEventListener
```

**判据**：任何**跨 webview 边界**的指针交互都要有遮罩 ——
拖拽调宽、框选、拖放、悬浮预览。不要指望「鼠标大概不会移出去」。
**遮罩还必须有兜底撤除路径**，否则一次异常就会锁死整个界面。

---

## 二、webview 的父链不许动

React 一旦在 `<webview>` 上卸载重挂，页面就**重新加载一次** ——
登录态、滚动位置、SPA 路由、播放进度全丢。

| 场景 | 正确做法 | 错误做法 |
|---|---|---|
| 边栏开合 | 只改容器**宽度**，DOM 结构不动 | 把 webview 包进条件渲染的容器 |
| 标签页切换 | 全部常驻，用 `invisible` / `z-0` 切可见性 | `{active && <webview/>}` |

**推论**：边栏必须是 webview 容器的**兄弟节点**，不能包一层。
包了的话，边栏收起时那一层的宽度 / 存在性一变，React 就可能重建子树。

> **布局可以变，树结构不能变。**

**同族**：收起边栏时若内容被**卸载**（提前 `return`），
对话滚动位置与输入草稿会丢。要保留状态就得让内容始终挂载、只用 `hidden` 藏。

---

## 三、面板容器的两种定位

| 需求 | 定位方式 | 为什么 |
|---|---|---|
| 常驻边栏（开合挤压内容） | flex 兄弟 + `style={{ width }}` | 宽度变化只挤压左栏，webview 父链不动 |
| 全屏 / 覆盖层 | `fixed inset-0` | 父容器只有面板那一条的高度，撑不满视口 |

**z-index 参考排序**：

```
悬浮球 z-[70]   ← 全局最高，不该被任何面板盖住
拖动遮罩 z-[60]
全屏面板 z-40
webview 容器 z-10
```

### 全屏要不要实心：看它是不是「对照工具」

Agent 全屏用半透明 + 背景模糊而**不是**实心，理由：
用户全屏是为了看大图、读长文，**仍需看到底下的页面**来判断 Agent 改得对不对。
实心背景会把它变回一个隔绝的黑箱 —— 那正是把它从悬浮球搬进浏览器面板时要避免的。

**判据**：全屏的目的若包含「与背后的东西对照」，就不要实心。

### 收起与全屏的标记不能互相残留

收起边栏时**必须一并清掉全屏标记**，否则下次展开会突然铺满整屏。

```tsx
onClick={() => persist({ ...prefs, open: false, fullscreen: false })}
```

---

## 四、动态宽度用容器查询，不要视口断点

边栏宽度可拖（典型范围 320–720）。用 `sm:` / `lg:` 是**错的度量**：

> 1440px 的窗口里，拖到 320 的边栏只有 320px 可用，
> 而 `lg:`（1024px）会判定为「宽」，把两个输入框硬挤成并排。

```css
.aside-panel { container-type: inline-size; container-name: asidepanel; }
.field-grid  { display: grid; grid-template-columns: 1fr; gap: 0.625rem; }

@container asidepanel (min-width: 460px) {
    .field-grid { grid-template-columns: 1fr 1fr; }
    .field-wide { grid-column: 1 / -1; }
}
```

**只要容器的宽度不由视口决定，就用容器查询。**
同一个坑很容易在同一个项目里踩两次（播放器底栏的可用宽度 = 视口 − 侧栏宽，也是这一类）。

⚠️ 全局 `index.css` 通常是**无层级** CSS，而 Tailwind v4 的 utilities 在 `@layer utilities`。
按级联层规则，无层级样式**无条件胜过**任何层级样式 ——
所以容器查询里**绝不能写「默认值还原」**（如 `display: revert`），
那会把元素上的 Tailwind `flex` / `inline-flex` 一并顶掉。
只写收窄时需要的 `display: none`，未命中查询时元素自然保留自己的类。

---

## 五、CSS 动画会压住工具类（同一个「无层级」根因）

**静默失效**：悬浮球的呼吸光晕写了 `opacity-45 group-hover:opacity-85`，
但 hover **从来没有生效过**。原因：关键帧里同时补间了 `opacity`。

```css
/* ✗ 关键帧里带 opacity */
@keyframes orb-breath {
    0%, 100% { transform: scale(1);    opacity: 0.55; }
    50%      { transform: scale(1.15); opacity: 0.95; }
}
```

**CSS 动画的优先级高于普通声明。** CSS Animations 规范原文：

> CSS Animations affect computed property values. This effect happens by adding a
> specified value to the CSS cascade (at the level for CSS Animations) ...
> **animations override all normal rules, but are overridden by !important rules.**

所以关键帧里的 `opacity` 无条件赢过 `group-hover:opacity-85`
（除非给它加 `!important` —— 但那是在跟级联打架，不如把关键帧写干净）。

**修法**：关键帧只补间**一个**属性，其余交给工具类。

```css
@keyframes orb-breath {
    0%, 100% { transform: scale(1); }
    50%      { transform: scale(1.15); }
}
/* 元素上：opacity-45 transition-opacity group-hover:opacity-85  ← 这下才生效 */
```

### 无限循环的装饰动画要能关掉

| 坑 | 表现 | 修法 |
|---|---|---|
| 关键帧补间 `opacity` | hover 的透明度变化无反应 | 关键帧只留 `transform` |
| 无限循环的装饰动画 | 界面永远在动，长时间挂着很烦 | 改**有限次**（`animation: ... 3`），或加 `prefers-reduced-motion` |

**`prefers-reduced-motion` 的覆盖块必须放在动画声明之后。**
选择器特异性相同时**后写的胜出**；那个块若在文件上方，
覆盖的是后面才定义的规则 → **等于没写**。

```css
.animate-orb-sonar { animation: orb-sonar 2.4s ... infinite; }

/* 必须在下面：写在上面会被上面的规则原样盖回去 */
@media (prefers-reduced-motion: reduce) {
    .animate-orb-sonar, .animate-orb-breath, .animate-orb-badge { animation: none; }
}
```

> 一条线索：`prefers-reduced-motion` 块如果**只列了 `animate-in` / `animate-fade-in`**
> 这类入场动效，而项目里还有循环动画，那多半是漏了 ——
> **循环动画才是最该被关掉的一批。**

### ⚠️ 特异性陷阱：选择器写短了，整块覆盖就是空的

块里只写 `.animate-in { animation: none; }`，而动画名其实挂在
`.animate-in.fade-in`（特异性 0,2,0）上 ——
裸 `.animate-in`（0,1,0）**根本盖不住**，整块规则一条都没生效。

**规则**：写覆盖块之前，先看清**动画名到底声明在哪个选择器上**，
逐字照抄那个选择器（必要时用复合选择器），不要凭名字想当然。

同族：**Tailwind 的 `animate-ping` / `animate-bounce` 在 `@layer utilities` 里**，
无层级的覆盖块能压过它们；但要**逐个列出具体类名**，不要指望一条通配规则。

**该不该关的判断**：`animate-pulse` / `animate-spin` 这类**传达状态**的
（加载中、LIVE）**故意保留** —— 关掉它们等于把信息藏起来。
只关纯装饰的循环动画。

---

## 六、什么时候把多个组件文件合并成一个

**判据是生命周期是否耦合，不是行数。** 满足任一条即可合并：

| 判据 | 例子 |
|---|---|
| 共享不可见的外部资源（webview / 同一 hook 实例） | Agent 面板 + 浏览器面板 |
| 共享同一套生命周期或 keep-alive 策略 | 嗅探 + 磁力 + 设置三个浮层面板 |

**第一条**：Agent 只能通过 webview 干活（执行脚本、注入规则、读页面 URL），
而 webview 的 `dom-ready` 广播、规则注入、脚本自动执行全挂在同一个浏览器 hook 上。
**拆成两个目录后，一边改接口、另一边不知道，编译期毫无提示。**

**第二条**：那三个浮层面板由**同一个 `visited` 集合**管着 ——
打开过就常驻内存，切页 / 关球只用 `hidden` 藏，输入、滚动、已加载列表原样保留。
**拆成多个文件后，改一次这个策略要同时动好几处，漏一处就是「切个页搜索条件没了」。**

**反过来的判据**：如果两块内容**各有各的持久化与挂载策略**，
即使它们在同一个面板里并排显示，也不该合并。
「把相关的都放一起」不等于「把所有东西都放一起」。

### 合并的操作顺序

1. **先读全部待合并文件**（不要边读边写）
2. 写成一个新文件，**导出名保持不变**（调用方零改动）
3. 删旧文件
4. **同步改测试里硬编码的源码路径** —— 这类路径不在编译期检查范围内

> 合并后静态自检套件里有读源码路径的地方需要跟着改，断言内容不用动。
> **忘了改的表现是测试报「找不到文件」，不是编译错。**

### ⚠️ 同名文件与目录不能并存

`components/Panel.tsx` 与 `components/Panel/` 同时存在时，模块解析会有歧义。
**所以合并必须把旧目录整个删掉**，不能留着当备份。

### 合并后要复查的「隐性契约」

合并本身是纯搬运，但搬运过程最容易丢的是**不成文的约定**。逐条核对：

- [ ] **行尾**：新文件是 LF 还是 CRLF？原目录各文件是否一致？（见 `safe-source-file-editing`）
- [ ] **导出面**：原来 `index.tsx` 末尾有没有 `export { X } from './X'` 这类再导出？
      有的话**先确认零引用**再删
- [ ] **模块级常量**：原文件里的 `const X = [...]` 搬到新文件后，
      有没有和已有常量重名或语义重复？
- [ ] **`useMemo` 的元素数组**：合并后如果多个面板由同一个父组件渲染，
      元素数组要 memo，否则父组件每帧重渲染会带上全部子面板
      （见 `react-state-and-identity-audit` 模式 G）

---

## 自查清单

- [ ] 拖动 / 浮层交互有没有被 webview 吞掉的路径？要遮罩吗？遮罩有兜底撤除吗？
- [ ] webview 的父链有没有变（是否只改了宽度 / 可见性）？
- [ ] 收起 / 展开时内容是否被卸载（对话滚动位置、输入草稿会丢）？
- [ ] 收起与全屏的标记有没有互相残留？
- [ ] 动态宽度的断点用的是容器查询还是视口断点？
- [ ] 容器查询里有没有写「默认值还原」（会被无层级规则顶掉工具类）？
- [ ] 关键帧是不是只补间了一个属性？`prefers-reduced-motion` 块在动画声明之后吗？
- [ ] 覆盖块的选择器特异性够不够（有没有写短了导致整块空转）？
- [ ] 合并 / 改名后，测试里硬编码的源码路径改了吗？
