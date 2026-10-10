---
name: verification-discipline
description: 下「它坏了」或「它没问题」这类结论之前读。让验证结论本身可信：变异测试的完整流程与三条纪律、该造哪几类变异体、变异报红时要先看它为什么红、新写的有状态或带阈值的代码也要当产品代码验一遍、用真实外部工具与不变量验证解析逻辑、以及探测脚本自身的纪律。
---

# 验证纪律

> **「测试全绿」不等于「断言有效」。**
> 一个比被测代码更粗糙的脚本，只会产出看起来像证据的噪音。

---

## 一、变异测试：证明断言不是空的

写错的断言（查了声明没查用法、查了判据没查调用点）会永远为真，
让人误以为验证过了。**变异测试是唯一能证明断言会失败的手段。**

做法：故意把产品代码改坏（模拟真实 bug），跑测试，确认它**变红**，然后还原。

```powershell
# 1. 先确认基线是绿的
npm run test 2>&1 | Select-String '全部通过|通过 \d+ 项'
# 2. 备份 → 改坏 → 跑测试 → 还原
# 3. 还原后再跑一次基线，确认回到绿
```

### 三条必须守住的纪律

#### 1. 基线必须先绿

基线本身失败时，「变异体报红」毫无信息量。
**没有绿色基线，变异结果不可信。**

#### 2. 变异体必须能编译或加载

变异导致的编译失败，会被脚本记成「变异被捕获」——
那是假阳性。变异后确认它至少能跑起来（语法检查、类型检查）。

#### 3. 锚点必须唯一命中

用 PowerShell 做字符串替换有两个坑：锚点漏掉前导空白 → 匹配 0 次，变异根本没写进去；
锚点里的反引号与 `$` 被解析器吃掉 → 同上。

**用 Node 脚本做变异，锚点原样写：**

```js
const fs = require('fs');
const p = 'D:/proj/src/someModule.ts';
const orig = fs.readFileSync(p, 'utf8');
fs.writeFileSync(p + '.bak', orig, 'utf8');

const anchor = "        if (!sess || seen.has(sess)) return;";
if (!orig.includes(anchor)) { console.log('锚点未命中'); process.exit(2); }
fs.writeFileSync(p, orig.replace(anchor, "        if (!sess) return;"), 'utf8');
```

`process.exit(2)` 把「锚点没命中」与「测试失败」区分开 ——
否则两者都会被误读成「变异被捕获」。

需要传正则或反引号时，用 here-string 管道喂 node，不要用 `node -e "..."`：

```powershell
@'
const fs = require('fs');
const p = 'D:/proj/src/someModule.ts';
let s = fs.readFileSync(p, 'utf8');
const needle = 'reasoning: keepReasoning(liveReasoning),';
const i = s.lastIndexOf(needle);
if (i < 0) { console.log('ANCHOR-MISS'); process.exit(2); }
s = s.slice(0, i) + s.slice(i + needle.length);
fs.writeFileSync(p, s, 'utf8');
'@ | node -
```

详见 `safe-source-file-editing`。

### 该造哪几类变异体

| 类型 | 例子 | 验证什么 |
|---|---|---|
| **退回修复前的写法** | `slice(-MAX)` 改回 `slice(0, MAX)` | 新测试确实锁住了这个 bug |
| **取反** | `!inputFocused` → `inputFocused` | 判据方向写错能被抓 |
| **删掉守卫** | 删掉 `if (sameRules(current, next)) return ...` | 分支不是摆设 |
| **放宽判据** | `!== 1` 改成 `if (false)` | 防「修过头」 |
| **删掉记账或上报** | 删 `has()` / `add()` 但保留声明 | 防**空断言** |
| **让核心判据恒假** | `const isBusy = () => !!head();` → `() => false` | 防**判据从未被真正调用** |

最后三类价值最高：**防修过头**、**防空断言**、**防判据未被调用**。

「删掉 has/add 保留声明」正是发现空断言的手段。

**「让核心判据恒假」是发现假保证的手段。** 一个被四个地方读取、
决定「要不要拦住用户输入」的判据函数，可能**没有任何测试直接调用过它** ——
测试只查了源码里有没有那行字（`/const isBusy = \(\) => !!head\(\);/`），
于是把它改成恒假，全部测试仍然全绿。

**规则：凡是被多处读取的判据函数，必须有一个测试直接调用它，并覆盖全部状态。**

```js
eq('空时不拦', mod.isBusy(), false);
seed({ … });
eq('有货就拦', mod.isBusy(), true);
```

### 变异报红时，先看它为什么红

报红有两种原因，含义完全不同：

- 断言失败 —— 变异被真正抓住
- 锚点或正则没匹配上 —— **等于没验证**

静态断言必须**只对语义敏感，不对书写顺序或空白敏感**：

```js
// ✗ 对参数顺序敏感：合法重构（换序）就会误报
const call = src.match(/messages:\s*([A-Za-z_$][\w$]*)\s*,\s*\n\s*reasoningEffort/);

// ✓ 先切出整段，再在段内找目标
const start = src.indexOf('await chat({');
const call = src.slice(start, src.indexOf('});', start));
const m = call.match(/messages:\s*([A-Za-z_$][\w$]*)/);
assert(m[1] === 'transcript', `必须是 transcript，实际是 ${m[1]}`);
```

对顺序敏感的断言，代价由下一个合法重构的人承担 —— 他会去改测试，而不是看代码。

### 变异体存活时，先判断它是不是「等价变异体」

**存活不等于测试有洞。** 有两种截然不同的原因：

| 原因 | 判据 | 处置 |
|---|---|---|
| 测试没覆盖 | 装上变异后，**有测试变红**但那个测试没查这条 | 补断言 |
| **等价变异体** | 装上变异后，**跑全部测试仍全绿**，且没有任何调用方依赖那个区别 | 该变异不改变行为，不算漏洞 |

**区分方法：把变异装回去，跑全部测试文件（不是只跑你以为相关的那几个）。**

```js
// 全量跑，而不是只跑目标文件
const files = fs.readdirSync('test').filter(f => f.endsWith('.test.mjs'));
const red = files.filter(f => spawnSync('node', ['test/' + f]).status !== 0);
console.log(red.length ? '变红：' + red.join(', ') : '→ 等价变异体（无调用方依赖该区别）');
```

真实案例：`step()` 的返回值从「本步做成没有」改回「队里还剩没剩」，
目标测试全绿。全量跑 —— **22 个文件全绿**，确认是等价变异体
（重写已经把那个歧义的影响面消掉了，没有调用方再依赖它）。

**但等价变异体仍可能要补断言**：

> 「没有调用方依赖」≠「契约可以含糊」。

那个返回值是**公开契约**的一部分。日后有人加了新调用方、又恰好依赖旧语义，
就会静默出错。所以**契约本身该有直接断言**，与「当前有没有人依赖」无关：

```js
const results = [];
while (q.length) results.push(mod.step());
ok('每次点掉一个都返回 true（含最后一项）', results.every(v => v === true));
eq('队空时什么都没点，才返回 false', mod.step(), false);
```

**顺序**：先判等价（全量跑），再决定是补测试还是补契约断言 —— 不要一看到存活就补断言，
那会把一个不存在的差异固化成测试要求。

### 清理

变异脚本与 `.bak` 备份用完必须删。建之前按 `user-collaboration-preferences` 报备。
备份放**被改文件同目录**比放系统临时目录好排查，但无论放哪都要删干净。

---

## 二、新写的代码也要当产品代码验一遍

**凡是新写的、有状态、有时间或数量阈值的函数，都要写一个小 harness 喂真实输入跑一遍。
编译绿 + 测试绿 + 构建绿，不能证明逻辑对。**

典型失效：一个节流函数内部读的是 `progress.currentBytes`，而调用方传的对象字段叫
`receivedBytes`；同时又传了 `minBytes = 0`，让判定变成 `Math.abs(0 - 0) >= 0` —— **恒真**。
节流完全失效，每条数据都发一次。三个「绿」都没抓到它：
类型上 `minBytes: number` 收 `0` 合法，没有测试覆盖该函数，构建不看语义。

抓它的方法 —— **从产品源码抽函数，不复制逻辑**（复制等于在测自己的副本）：

```js
const src = fs.readFileSync('electron/main.js', 'utf8');
const start = src.indexOf('function throttleProgress');
const end = src.indexOf('\n}\n', start) + 3;
const throttleProgress = new Function(src.slice(start, end) + '; return throttleProgress;')();

// 模拟真实洪水：同一 tick 连发 10 条
const got = [];
const push = throttleProgress((p) => got.push(p.receivedBytes), 250, 0, (p) => Number(p?.receivedBytes) || 0);
for (let i = 1; i <= 10; i++) push({ receivedBytes: i * 1000, status: 'downloading' });
console.log(got.length);   // 期望 1（合并成一条）
```

同类必须验的：节流与防抖、计数与累加、跨 chunk 的字符串匹配、正则解析、
任何带 `Math.abs(...) >= 阈值` 的判定。

### 跨 chunk 匹配要用两个缓冲

`skipped += countIn(combined) - countIn(carry)` 这种写法必须**逐字符**喂一遍验证。
用一个缓冲兼做拼接与截断，会重复计数或漏数。

---

## 三、用真实外部工具验证解析逻辑

解析外部进程或第三方输出的代码，不要凭文档写，也不要凭一次成功就下结论。
跑真实进程，把解析结果打出来，并检查**不变量**：

```js
// 进度、时间戳、序号都适用
const pct = frames.map(f => f.percent).filter(x => x !== null);
console.log('百分比单调不减:', pct.every((v, i) => i === 0 || v >= pct[i - 1]) ? '是' : '否 ← 有问题');
```

**「单调不减」这类不变量是最省事的正确性判据** —— 比逐帧核对数值快得多，也更能抓到跳变。

---

## 四、用产品代码本身，不要用重写的副本

**判据必须复用产品代码。** 要判断「这是不是挑战页」，就调用产品自己的判定函数；
要判断「某请求是否走代理」，就用产品自己的 agent。

自己重写的判据往往比被测代码更粗糙，却拿它的输出去否定产品。
典型误判：只看单个关键词特征就断言「站点返回了 Cloudflare 挑战页」——
而 Cloudflare 会给**所有**它代理的页面注入同一个脚本标签，不只是挑战页。
产品代码用的是**与**逻辑（脚本特征 **且** 文本特征），那个组合才对。

### 结论前先自证探测本身可信

下「X 坏了」之前先问：

- 我的判据和产品用的是同一套吗？
- 有没有**对照组**能证明我的探测能区分好坏？

那次如果加一个「同样被 CF 代理但确认可用」的对照站，会立刻发现两个站都被判成挑战页 ——
判据显然错了。

### 从产品代码里抽取函数求值

**顶层 const 不在抽取的区段内，必须显式注入：**

```js
const factory = new Function(
    'require', 'http', 'https', 'net', 'tls',
    `${block}\nreturn { setProxy, getProxy };`
);
return factory(require, require('http'), require('https'), require('net'), require('tls'));
```

区段用标记定位，找不到就 `throw`，**不要静默返回空**：

```js
const grab = (marker) => {
    const start = src.indexOf(marker);
    if (start < 0) throw new Error(`源码里找不到 ${marker}`);
    const rest = src.slice(start);
    const nextIdx = rest.slice(1).search(/\n(async )?function /);
    return nextIdx < 0 ? rest : rest.slice(0, nextIdx + 1);
};
```

### 探测脚本自身的纪律

- 每一步都要有硬超时（`Promise.race` 或 socket timeout）。
- 并发控制在个位数；超时设短（9–12 秒）并**显式报告「超时」**，而不是笼统的失败。
- 逐项输出，不要一次并发几十个连接把代理或对端打爆 —— 那会制造一批自己造成的 `ECONNRESET`。
- 隧道建好后若对端不回，socket 永远不会交给 request，`req` 的 timeout 也就无从启动。
  **握手本身必须自带超时。**

### 不要为验证而破坏现场

删文件、移文件、改配置、装卸依赖 —— **即使有备份、即使能还原、即使放在临时目录**，都要先问。

**先找非破坏性的证据路径。** 要判断某个重建步骤是否真的下载了东西，
可以读该工具的源码看它的下载与缓存判断，或看 `--foreground-scripts` 的详细输出；
「删了再试」是最后手段。

**时间戳不变 ≠ 走了代理。** 重建报成功只说明退出码为 0。
**「事后重建成功」和「首次安装成功」是两件事**，不要用前者冒充后者。

---

## 四点五、没有 shell 时，验证只能停在「核对」这一级

**当环境不提供任意命令执行时，「验证」的含义要降级，并且必须在报告里说清降到哪一级。**

可行的一级叫**核对（reconcile）**：逐条读实现代码，确认自己写下的每个构造
在实现里都能找到对应的消费点。它比「凭记忆写」强得多，但**不等于执行过**。

不可行的一级叫**运行（execute）**：跑解析器、跑测试、看真实输出。

规则：

- **报告里必须用准确的动词。** 「逐条对着实现核对过，未执行验证」是可以的；
  「已验证」不行。含糊的「看起来没问题」最差 —— 它让读者以为有证据。
- **不要为了凑出「验证过」而绕路。** 例如把被测逻辑抄进一个临时脚本自己跑：
  抄出来的副本一旦与产品代码有偏差，得到的结论比没有结论更坏（见第四节）。
- **不要用不相干的绿灯冒充。** 类型检查通过、仓库测试套件全绿，
  都不能证明一个**未被任何测试读取的数据文件**是对的。
- 用户若要真正执行，把「需要他做什么」写进报告的操作项，
  而不是暗示自己已经做过。

---

## 五、Electron 环境的安全跑法

验证主进程 Node 能力用 `ELECTRON_RUN_AS_NODE=1` —— **不弹窗口、不起 Chromium**：

```powershell
$env:ELECTRON_RUN_AS_NODE=1
node_modules\electron\dist\electron.exe -e "console.log(process.versions.node)"
```

**绝不要为了验证启动 GUI 窗口** —— 会让用户屏幕弹窗。
需要真实 Electron 环境时，用项目里已有的、用户认可的脚本，不要临时新建。

跑之前先确认二进制版本与包声明一致：`node_modules/electron/dist/` 里的二进制
**可能与 `package.json` 声明的版本不一致**（install 脚本没跑成时会留着旧的），
此时**基于它做的任何运行时能力断言都是错的**。命令见 `electron-main-constraints`。

---

## 通用原则

> 不确定时，先跑产品自己的路径（项目自带的检查脚本），
> 不要临时手搓一个「差不多的」。

---

## 自查清单

- [ ] 变异测试前，基线确认是绿的吗？
- [ ] 每个变异体都能编译或加载吗？
- [ ] 变异报红时，读的是「断言失败」还是「锚点没匹配上」？
- [ ] 断言对书写顺序敏感吗（合法重构会不会误报）？
- [ ] 新写的有状态、带阈值的函数，喂过真实输入吗？
- [ ] 没有 shell 时，报告里用的是「核对过」还是含糊的「验证过」？
- [ ] 下「它坏了」之前，判据和产品是同一套吗？有对照组吗？
- [ ] 探测脚本每步都有硬超时吗？并发可控吗？
- [ ] 有没有为验证而做破坏性操作？问过用户吗？
