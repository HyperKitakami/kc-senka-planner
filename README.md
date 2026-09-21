# Kancolle Senka Planner

《艦隊これくしょん》的战果记录、规划与统计工具。**完全本地运行**——无服务器、无数据库、无构建步骤，双击 `index.html` 即可离线使用。

> 需求与设计以 [`docs/`](docs/) 为准，本 README 只做导航与上手说明。

---

## 特性

### 9 个页面

| 页面 | 职责 |
| --- | --- |
| **首页** | 总览：战果进度条、11 张可配置卡片（顺序 / 尺寸 / 显隐）、近 14 天趋势、最近数据摘要 |
| **周期查询** | 时间边界速查：任务刷新周期（04:00）与战果结算周期（末日 13:00 / 21:00） |
| **战果记录** | 每日出击战果的录入 / 修改 / 删除，按月份浏览；列表 / 日历双模式；poi 建议值与一键填充 |
| **战果任务** | EO / EX / 活动 / 自定义任务，按周期管理完成状态与规划池；poi EO 批量同步 |
| **战果规划** | 目标设定、所需日均、预计月底战果，实际 / 综合双口径 |
| **数据分析** | 每日增长趋势、月度比较、战果构成、战果线对比 |
| **历史归档** | 每月最终结果、奖励区间与奖励装备的长期留存 |
| **数据管理** | 导出 / 导入（整体替换 + 合并导入）、本地备份、清空 |
| **设置** | 主题、首页卡片顺序 / 尺寸 / 显隐、默认规划方式、poi 快照管理 |

### 其它

- **深色主题** —— 只覆盖 CSS 变量，样式规则与浅色主题完全共用
- **零外部网络** —— 图表由本地引入的 Chart.js 渲染，不发起任何网络请求
- **可配置首页** —— 点「编辑布局」进入编辑模式后可拖动排序、按小 / 中 / 大改尺寸；
  平时首页是纯展示的，不会被误拖。面板卡（日历 / 趋势 / 摘要）与统计卡同处一个网格，
  一样可排序可缩放；窄屏下大号自动退化为整行。设置页另有一套等价的键盘可用控件。
- **数据可迁移** —— 导出含版本号，导入按版本顺序自动迁移
- **poi 数据接入** —— 读取 [poi](https://github.com/poooi/poi) 战果插件的数据文件，
  提供每日建议值与一键填充、战果线对比图、EO 完成状态批量同步。
  **同步完全手动触发**：浏览器不允许网页自行读取本地路径，需在页面上手动选取文件。

---

## 快速开始

双击 `index.html`。没有安装步骤，也不需要服务器。

> **为什么不用 ES Modules？**
> 浏览器会以 CORS 为由拦截 `file://` 下的模块加载。为了保住「双击即用」这个体验，
> 项目采用 **经典脚本 + 全局命名空间 `window.KC`**，在 `index.html` 中按依赖顺序引入。
> 代价是新增文件时必须手动维护 `<script>` 顺序（见「开发」一节）。

---

## ⚠️ 数据保存在本机浏览器

所有数据存在浏览器的 **IndexedDB**（库名 `kc-senka-planner`）。

**浏览器清理站点数据会一并清除，且无法找回。**

请定期到「数据管理」页 **导出 JSON 备份** 到文件——这是唯一能扛住清缓存的手段。
页面内的「本地备份」与主数据存放在同一处，只能防误操作，防不了清缓存。

> **poi 快照单独存放。** 从 poi 同步来的数据快照存在浏览器的 localStorage 里
> （前缀 `kc-senka-planner:`），**不参与导出 / 导入**，清理站点数据同样会丢失。
> 它只用于展示建议值、战果线与 EO 比对，可在「设置」页单独清除；
> 清除快照不会影响任何业务数据。

---

## 技术形态

- 原生 HTML / CSS / JavaScript，**无框架、无构建步骤、无包管理**
- 数据层：IndexedDB，封装于 `js/core/db.js`
- 图表：`vendor/chart.umd.min.js`（Chart.js 4.5.1，MIT，本地引入）
- 统计结果 **一律运行时计算，绝不落库**（见 `docs/03_data.md` §1.2）

### 目录结构

```
index.html                 唯一入口，按依赖顺序引入全部脚本
css/style.css              :root 与 :root[data-theme="dark"] 两套配色变量
js/core/   utils            通用工具
           periods          周期解析与两套时间边界
           schema           数据结构、schemaVersion、迁移链
           db               IndexedDB 封装（含导入 / 合并 / 导出）
           store            内存状态 + 自动保存 + 订阅
js/data/   defaultTasks     内置 EO 任务模板
js/calc/   stats            月度统计
           tasks            任务周期与战果汇总
           plan             规划：实际 / 规划战果、所需日均、预测
           analysis         逐日序列、月度比较、战果构成
           periods          周期查询：任务刷新 / 战果结算两套边界的剩余时间
js/ui/     dom / feedback    DOM 辅助、Toast 与确认弹窗
           nav / router      导航与 hash 路由
           theme             主题切换
           components        跨页面复用组件（含首页卡片注册表与网格列数计算）
           pages/*           9 个页面
js/main.js                 入口
vendor/                    第三方本地依赖
docs/                      需求与设计文档（改前须确认）
```

---

## 关键业务规则

### 两套时间边界不得混用

这是全项目最容易搞错的地方：

| 边界 | 用途 | 规则 |
| --- | --- | --- |
| **任务刷新边界** | 判定任务是否刷新 | 每日 / 每周一 / 每月 1 日 / 每季度首月 1 日 **04:00** |
| **战果归属边界** | 战果归属哪个月、剩余周期、所需日均、预测终点 | 出击与 EO 截至 **本月末日 21:00**；任务战果截至 **本月末日 13:00** |

剩余周期、所需日均、预测 **一律按战果归属边界**，不是任务刷新边界。

### 其它易错点

- **出击战果**：本月末日 21:00 ～ 23:00 获得的计入 **次月**
- **EO 有效窗口**：上月末日 23:00 ～ 本月末日 21:00；末日 21:00 ～ 23:00 获得的无效
- **季常任务**：季度第三月（2 / 5 / 8 / 11 月）末日 13:00 ～ 23:00 完成的 **直接失效**，不计入次月
- **继承战果**：仅继承上月，**每年 12 月末清零**（次年 1 月为 0）
- `DailyRecord` **只存当日出击战果**，绝不写入 EO / EX / 活动 / 继承 / 规划池 / 任何统计值
- 任务完成状态存于 `TaskRecord`（按 PeriodId），**不得在任务模板上存「当前是否完成」**
- `Archive` 仅作结果快照，**不参与统计计算**

> 完整的计算规则见 [`docs/04_calculation.md`](docs/04_calculation.md)，术语以 [`docs/05_glossary.md`](docs/05_glossary.md) 为准。

---

## 开发

### 约定

- **修改 `docs/` 前必须先经确认**（见 [`docs/ai_prompt.md`](docs/ai_prompt.md)）
- 一次只完成一个功能；改动尽量最小
- 新增页面必须做三件事：
  1. `index.html` 里按依赖顺序加 `<script>`
  2. `js/ui/router.js` 的 `PLACEHOLDERS` 里删掉对应项
  3. 页面自己注册 `KC.pages.xxx = { mount, unmount }`
- 新增 JS 文件用 IIFE 包裹：`(function (KC) { ... })(window.KC = window.KC || {});`
- 新增样式 **必须用 CSS 变量**，不要写死颜色，否则深色主题会漏

### 自测

项目是「经典脚本 + `window.KC`」，因此所有模块都能在 Node 里直接加载，不需要浏览器。

```bash
# 1) 全量语法检查
for f in $(find js -name '*.js' | sort); do node --check "$f" || echo "FAIL $f"; done
```

```js
// 2) 在 Node 中加载模块做断言（把 window 指向 global 即可）
global.window = global;
['js/core/utils.js', 'js/core/periods.js', /* …按 index.html 顺序… */]
  .forEach(f => new Function(require('fs').readFileSync(f, 'utf8'))());
// 之后即可直接调用 KC.periods / KC.calc.* 等纯函数
```

```js
// 3) 需要 IndexedDB 的数据层测试：用内存实现（npm i fake-indexeddb）
const { indexedDB, IDBKeyRange } = require('fake-indexeddb');
global.indexedDB = indexedDB;
global.IDBKeyRange = IDBKeyRange;
global.window = global;
```

```js
// 4) 整合冒烟：按 index.html 的真实脚本顺序加载全部脚本
//    能挡住「漏加 script 标签」这类问题
```

### 提交前建议

```bash
# 克隆可运行性验证：把提交内容导出到临时目录，再在干净副本上跑冒烟测试
git archive HEAD | tar -x -C /tmp/kc-check
```

---

## 版本

当前基线：**`v0.2.0`** —— 9 个导航页全部实现，并接入 poi 数据。

开发历史：

* `v0.1.0`（`bc0e93b`）—— 8 个导航页全部实现。
* 其后陆续新增：战果记录补录、首页卡片布局、周期查询页、归档分页与筛选、
  月度比较可选数据项、归档覆盖保护、定期导出提醒、任务进度节点、
  战果记录页双录入模式（列表 / 日历）。
* `v0.2.0` —— 接入 poi 战果插件数据：每日建议值与一键填充、战果线对比图、
  EO 完成状态批量同步、快照管理。

---

## 许可

本项目采用 **MIT License**，详见 [`LICENSE`](LICENSE)。

```
Copyright (c) 2026 Victorique
```

第三方依赖 [`vendor/chart.umd.min.js`](vendor/chart.umd.min.js) 为 Chart.js 4.5.1，同样以 MIT License 分发。
