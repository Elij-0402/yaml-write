# VARIATION ATELIER · 设计系统 MASTER（全局唯一真相源）

> Linear.app 视觉语言 · 暗色优先双主题 · 低饱和靛蓝单强调。
> 本文件由 UI/UX 重构（2026-06）确立；构建任何页面前先读本文件。
> 页面级偏差写入 `design-system/pages/<page>.md`（存在即覆盖 Master）。

## 1. 气质定位

- **极简、克制、简洁**：层级靠字号 / 字重 / 留白 / 发丝线，不靠色块与阴影。
- **暗色优先**：默认暗色（near-black 冷调画布），亮色完整校准；跟随系统 + 手动切换。
- **单一强调色**：低饱和靛蓝 `#5E6AD2`（Linear 同源）。只标「主行动 / 聚焦 / 正在发生」，绝不装饰。
- **键盘优先**：⌘K 命令面板全局可达；⌘, 设置；模态 Esc 可逃逸 + 焦点陷阱。
- **每屏一个主行动**：solid 靛蓝按钮每屏至多一个；其余动作 secondary / ghost。

## 2. 颜色 token（CSS 变量，`app/globals.css`）

`:root` = 暗色（默认）；`:root[data-theme='light']` = 亮色覆盖。组件**只用 token，禁止裸 hex**。

| Token | 暗色 | 亮色 | 用途 |
|---|---|---|---|
| `--bg` | `#0B0C0E` | `#FFFFFF` | 应用画布 |
| `--bg-subtle` | `#0E1012` | `#F9F9FB` | 侧栏 / 轨 / 输入底 |
| `--surface` | `#131519` | `#FFFFFF` | 卡片 |
| `--surface-2` | `#1A1D22` | `#F2F3F5` | hover / 选中底 |
| `--fg` | `#EDEEF2` | `#17181C` | 主文字 |
| `--fg-2` | `#9CA1AA` | `#5B5E66` | 次要文字 |
| `--fg-3` | `#646A76` | `#999DA6` | 三级 / 占位 / 计量 |
| `--border` | `#23262C` | `#E7E8EB` | 主发丝线 |
| `--border-2` | `#1A1C21` | `#F2F3F5` | 内部次级线 |
| `--accent` | `#5E6AD2` | `#5E6AD2` | 实心填充（按钮/点/进度/caret） |
| `--accent-hover` | `#6B76DD` | `#4E59C7` | 主按钮 hover |
| `--accent-fg` | `#FFFFFF` | `#FFFFFF` | 强调底上的文字 |
| `--accent-ink` | `#8B93EE` | `#4F58C4` | **强调色文字/图标**（对比达标变体） |
| `--accent-subtle` | `#1B1E33` | `#EEF0FB` | 强调弱底（激活/聚焦面） |
| `--danger` | `#F07178` | `#DC2626` | 真错误（功能性） |
| `--danger-subtle` | `#2A171A` | `#FEF1F1` | 错误弱底 |
| `--success` | `#4CC38A` | `#16A34A` | 完成态点缀 |
| `--success-subtle` | `#15271E` | `#EBF8F0` | 完成弱底 |
| `--scrim` | `rgba(5,6,8,.62)` | `rgba(20,21,26,.45)` | 模态遮罩（40–60% 区间） |
| `--surface-glass` | `rgba(19,21,25,.86)` | `rgba(255,255,255,.88)` | 浮层玻璃面（配 blur） |

**铁律**
- 彩色**文字/图标**一律 `--accent-ink` / `--danger` / `--success`（已按主题校准对比 ≥4.5:1）；`--accent` 仅作实心填充与边框。
- 遮罩一律 `--scrim`（旧 `bg-fg/45` 在暗色下会变白幕，禁用）。
- idle / 就绪状态用中性灰点；蓝色只给「正在发生」（提取脉冲、流式 caret）。
- 暗色阴影几乎不可见：层级靠 surface 明度阶 + 发丝线；`--shadow-pop` 仅浮层（弹窗/抽屉/面板）。

## 3. 字体与字阶

- `--sans`：Inter + 系统中文栈（UI 全部）；`--mono`：计量/编号/快捷键/eyebrow；`--serif`：仅成稿正文阅读（`.prose-reader`）。
- 字阶（紧凑 Linear 档）：**页标题 16/semibold** · 区块标题 14/medium · 正文 13.5–14 · 次要 13 · 说明 12 · 计量 mono 11 · eyebrow mono 11 大写。
- 标题 `letter-spacing:-0.011em`；正文行高 1.55–1.7；成稿阅读体 17px/1.9。
- 数字一律 `tabular-nums`。

## 4. 空间 / 圆角 / 密度

- 4px 节奏：组件内 4/8/12，区块 16/20/24，分区 32/40。
- 圆角：`--radius-sm` 6 / `--radius` 8 / `--radius-lg` 10。控件（按钮/输入）32px 高（sm 28 / lg 38）。
- 侧栏 224px；顶栏 48px；内容画布 max-w 按视图（列表 ~960px，文档 ~720px）。
- 列表行高 44–48px，hover `--surface-2`，删除/次操作 hover 才现形。

## 5. 动效

- 微交互 120–200ms `cubic-bezier(.16,1,.3,1)`（ease-out 入 / ease-in 出，出场更短）。
- 视图进入 `.view-enter`（4px 上浮 + 渐显 200ms）；浮层 150ms scale(.98→1)+fade。
- 仅 transform/opacity；全部尊重 `prefers-reduced-motion`。
- 唯一持续动效 = 流式 `.caret` 与提取中脉冲点（「正在发生」信号）。

## 6. 组件类（`@layer components`）

`.btn`(+`-primary/-secondary/-ghost/-danger/-sm/-lg/-icon`) · `.input` · `.card` · `.chip` · `.eyebrow` · `.field-label` · `.kbd` · `.glass` · `.prose-reader` · `.caret` · `.view-enter` · `.skeleton` · `.seg`/`.seg-item`（分段控件）。

- 主按钮：靛蓝实心 + 白字；danger 确认 = 实心红（仅破坏性确认弹窗）。
- 输入：`--bg-subtle` 底 + 发丝线；focus 1px 强调边 + 3px `--accent-subtle` 环。
- 浮层（弹窗/命令面板）：`.glass`（玻璃底 + blur）+ `--shadow-pop` + `--scrim` 遮罩。

## 7. 结构样式

- 外壳：左侧栏（品牌 / 搜索 ⌘K / 作品库 / 创作库 / 设置+模型点）+ 顶栏（面包屑 + 后台活动）+ 画布。
- 导航当前态 = 中性 raised 底（不是蓝）；计数 mono 右对齐。
- 库视图 = 行式列表（不是卡片网格）：状态点 + 名称 + mono 计量 + hover 操作。
- 工坊 = 顶部步进轨（1 配方 → 2 方向 → 3 设定 → 4 成稿）+ 单一下一步提示。
- 命令面板 ⌘K：跳转 / 打开作品 / 打开创作 / 新建 / 主题 / 设置。

## 8. 反模式（禁止）

emoji 当图标 · 裸 hex · 多强调色 / 渐变 / 大面积色块 · 卡片网格化库视图 · 厚阴影 · 装饰性动画 · `bg-fg/45` 遮罩 · 亮色值直接拿去暗色用（两主题分别校准） · 每屏多个实心主按钮。
