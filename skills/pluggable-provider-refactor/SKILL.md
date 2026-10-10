---
name: pluggable-provider-refactor
description: 把"单站特化模块"重构为"通用引擎 + 可插拔 provider"的方法与判据。含特化藏在哪些名字里、通用编排与站点特化如何拆解归属、插口契约与注册表、跨站归一化（体积/时间/做种数/磁链编码）、未知值哨兵与比较器陷阱、单站失败不拖垮整体的容错、离线测试夹具、一个解析器服务多个站点、以及可替换的传输层。要把某个只支持单一数据源或站点的模块改成支持多源、或用户说"不要再对某个网站做特化，把网站作为插口接入通用引擎"时读。
---

# 单站特化 → 通用引擎 + 插口

**适用**：加数据源、消除站点特化、改多源聚合逻辑。
**不适用**：纯 UI 改动、单站内部的小修。

- 验证结论怎么才算可信见 `verification-discipline`
- 命名规则见 `user-collaboration-preferences`

---

## 一、特化藏在哪里

**它写在每一个名字上，不只是逻辑里。** 用 `<site>` 代表被特化的那个来源：

| 名字 | 问题 |
|---|---|
| `<site>Service.js` | 模块名 = 站点名 |
| `search<Site>()` | 函数名 = 站点名 |
| `use<Site>` | hook 名 = 站点名 |
| `<Site>Item` / `<Site>SearchOptions` | 类型名 = 站点名 |
| `CATEGORY_OPTIONS` | 该站的分类编码，却当通用常量导出 |
| `<site>-search` / `api.<site>` | IPC 通道与命名空间 = 站点名 |

**重构的第一步是把这些名字改掉。**
留旧名的代价：下一个加站点的人会以为「这只能搜那一个站」。

**判据**：读一遍名字，问「如果加第二个来源，这个名字会变成谎言吗？」

---

## 二、真正的病灶：通用编排与站点特化缠在一起

```js
async function search<Site>({ site, q, category, sort, pages }) {
    for (let p = 1; p <= pageCount; p++) {          // ← 通用：翻页
        const url = buildSearchUrl(site, {...});     // ← 特化：拼 URL
        const html = await httpGetText(url, ...);    // ← 通用：取字节
        const items = parseList(html, dlHost);       // ← 特化：解析
        if (items.length === 0) break;               // ← 通用：终止条件
        await sleep(800);                            // ← 通用：限速
    }
    // 去重、过滤、补字段                            // ← 全是通用
}
```

加第二个站只能再写一个 `searchXxx`，把翻页、去重、限速重抄一遍。

**拆解归属**：

| 内容 | 去哪 |
|---|---|
| 站点地址、分类编码表 | provider |
| `buildSearchUrl`（拼 URL） | provider |
| `parse`（HTML → 条目） | provider |
| 翻页、限速、终止条件 | **引擎** |
| 去重、过滤、补字段 | **引擎** |
| 取字节 | 传输层 |
| 写盘、白名单校验 | 留主进程 |

**特化不是消失，是被隔离。** 站点 URL 格式总得有人知道，变的是它住在哪 ——
住在一个只干两件事（`buildSearchUrl` + `parse`）的纯函数插件里。

---

## 三、插口契约

```ts
export interface SiteProvider {
    descriptor: SiteDescriptor;              // id / label / homepage / adult / kinds
    buildSearchUrl(query: string): string;   // 关键词 → 搜索地址
    parse(body: string, ctx: ParseContext): ProviderHit[];
    headers?: Record<string, string>;
}
```

**三条关键约束**：

1. **`buildSearchUrl` 与 `parse` 必须是纯函数** —— 不发请求、不读全局状态。
   这样才能用保存的真实响应快照做离线测试。
2. **provider 不填 `site` / `siteLabel`** —— 由引擎按注册表盖章。
   否则同一站点名在两处各写一遍，迟早不一致。
3. **`parse` 必须容错** —— 站点改版或返回错误页时返回空数组而非抛错。
   单个站解析失败不该让整个扇出失败。

### 注册表：加站点的唯一动作

```ts
const PROVIDERS: SiteProvider[] = [providerA, providerB, ...];
```

「加一个站点」= 写一个 `providers/<name>.ts` + 在数组里加一项。
**引擎、UI、主进程都不用改。** UI 的站点选择按钮遍历注册表渲染，新站点自动出现。

---

## 四、归一化：跨站排序的前提

各站字段格式完全不同，必须在 provider 里就地归一化：

| | 站点 A | 站点 B | 站点 C |
|---|---|---|---|
| 体积 | `"183567938"`（字节） | `"1.8 GB"` | `"6.6 GiB"` |
| 时间 | epoch 秒 | epoch 秒 | `"2026-09-12 15:45"` |
| 做种 | `"0"` 字符串 | 无 | 数字 |

统一成 `sizeBytes: number` / `publishedAt: epoch ms`，未知一律 `-1`。

**为什么必须**：按 `"1.8 GB"` 与 `"709.4 MiB"` 这类字符串排序毫无意义
（字典序里 `"1.8 GB" > "709.4 MiB"`，而实际相反）。

### 未知值用 -1，不要用 0

`0` 是「确实是零」，`-1` 是「站点没公布」—— **两种不同的信息**。

- 排序时 `-1` 排末尾，不能当成最小值
- 过滤时（如「做种 ≥ 5」）**必须保留未知值**，
  否则会把不公布做种数的站整个滤掉

```js
hits.filter((h) => h.seeders === UNKNOWN || h.seeders >= minSeeders);
```

### 磁链编码要统一

各家用的 btih 编码不同：有的是 **32 位 base32**，有的是 **40 位 hex**。
不统一成 hex 就没法跨站去重。

**验证去重是否真生效，看的是「两站合计 − 去重后 = 交集数」这三个数字能不能对上**，
不是看代码里有没有写 `Set`。

### 哨兵值参与比较器：`-Infinity` 会产出 `NaN`

给「未知值」定的哨兵若是 `-Infinity`，而比较器里做减法（`a - b`）：

```js
-Infinity - (-Infinity)   // → NaN
```

**比较器返回 `NaN` 时排序行为未定义**（不同引擎结果不同，且不报错）。

```js
// ✗ 未知值排末尾用了 -Infinity，两个未知值相减得到 NaN
// ✓ 用有限哨兵，并导出唯一比较器供各处复用
const UNKNOWN_RANK = -Number.MAX_SAFE_INTEGER;
export function compareBy(sort) { /* ... */ }
```

**通用规则**：凡是「用一个特殊值表示未知或缺失」的设计，
都要检查它会不会进入**算术运算**。会 → 换成有限值，或在比较器里先判等。

---

## 五、容错：单站失败不拖垮整体

```js
const settled = await Promise.allSettled(
    providers.map((p) => searchOneSite(p, q, transport, timeoutMs))
);
```

失败的站在 `sites[]` 里带 `error` 上报，其余结果照常返回。

**为什么必须有这个字段**：只给一个合并列表，用户无法区分
「没有这个资源」和「有个站挂了」。UI 要显示「N 站成功 / M 站失败」可展开明细。

`searchOneSite` 内部把所有失败转成状态，**不抛**：
构造 URL 失败、请求失败、解析抛错，各自记不同的 `error` 文案。
其中「解析失败（站点结构可能已变）」要单独报 ——
静默返回空结果会被误读成「这个站没有该资源」。

---

## 六、离线测试夹具（最高价值的一步）

抓一次真实响应存成快照，测试直接读快照、不联网：

```js
const parseFixture = (provider, file, query) =>
    provider.parse(fixture(file), { url: provider.buildSearchUrl(query), query });
```

**价值**：站点改版导致解析失效时，测试直接失败，而不是等用户搜出空结果才发现。

**实测抓出的两个真 bug**（手写假 HTML 时不可能发现）：

1. `alt` 属性出现在 `class` **之前**，而正则假设了相反顺序 —— 两种排列都要认
2. 某个字段名里带**斜杠**（`Date/time submitted`），
   写进正则字面量会提前结束匹配，必须转义成 `Date\/time`

---

## 七、一个解析器服务多个站点

**前提是先做一件事：确认两个站是不是跑同一套程序。**

很多站点是**同一个程序的不同实例**（同一套论坛 / 博客 / 资源站软件，
只是域名和皮肤不同），HTML 结构逐字段一致。这时不要写两个 provider，
用工厂函数传不同配置生成两个实例：

```ts
export function createProvider(cfg: SiteConfig): SiteProvider { /* 一份解析逻辑 */ }

export const providerA = createProvider({ id:'a', base:'https://a.example', ... });
export const providerB = createProvider({ id:'b', base:'https://b.example',
    downloadBase:'https://dl.b.example',   // ← 直链域名可能与页面域名不同
    adult:true, ... });
```

**差异往往只有三处**，全在配置里：

1. 域名
2. 相对地址 vs 绝对地址
3. **直链域名可能与页面域名不同**（页面挂在一个域，下载链却指向另一个域）

> **判据**：加第二个站之前，先抓两个站的真实响应 diff 一遍。
> 结构一致 → 工厂函数；结构不同 → 老实写第二个 provider。
> **不要凭「看起来像同一套程序」就合并** ——
> 那会得到一个到处是 `if (site === ...)` 的解析器。

**测试注意**：别断言 `p1.parse === p2.parse` —— 工厂每次返回新对象，引用不同。
要断言「同一份 HTML 交给两者，解析出的字段结构一致」。

---

## 八、传输层要可替换

```ts
export interface Transport {
    get(req: TransportRequest): Promise<TransportResponse>;
}
```

**两个实际好处**：

1. 测试注入假实现，离线跑完整扇出流程（含失败注入）
2. 将来某站要过 Cloudflare 挑战（需开 `BrowserWindow` + CDP），
   只需换一个实现，引擎与全部 provider 一行都不用改

**渲染层 fetch 的两个注意点**：

- `referrer` 选项只接受同源地址，传跨域会直接抛 `TypeError`（一传所有站点全挂）
- `Referer` 是 fetch 的禁止头，放进 `headers` 会被静默丢弃

---

## 九、验证清单

| 项 | 手段 |
|---|---|
| 各 provider 解析正确 | 真实快照离线测试 |
| 引擎扇出 / 容错 / 去重 / 排序 | 假 transport 注入失败 |
| 端到端可用 | 真实站点跑一次，打印各站条数 / 耗时 |
| 跨站去重真的生效 | 对比「两站合计」与「去重后」，并验证交集数字对得上 |

**并发扇出的总耗时约等于最慢那个站，不是各站相加。**

---

## 自查清单

- [ ] 模块名 / 函数名 / 类型名 / IPC 通道里还有站点名吗？
- [ ] 翻页、限速、去重、补字段这些通用逻辑，是否已全部上提到引擎？
- [ ] `buildSearchUrl` 与 `parse` 是纯函数吗（不联网、不读全局）？
- [ ] provider 有没有重复填 `site` / `siteLabel`（应由引擎盖章）？
- [ ] 未知值用的是 `-1` 还是 `0`？过滤时会不会把不公布该字段的站滤掉？
- [ ] 哨兵值会不会进入比较器的减法，产出 `NaN`？
- [ ] 磁链编码统一成 hex 了吗？「合计 − 去重后 = 交集」对得上吗？
- [ ] 合并两个站之前，diff 过它们的真实响应结构吗？
- [ ] 单站失败时，用户能区分「没有资源」和「这个站挂了」吗？
- [ ] 解析器测试用的是真实快照，还是手写的假 HTML？
