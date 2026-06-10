# 创作 DNA 工坊 · VARIATION ATELIER

一个中文小说「创意 DNA 与换皮变题」工具：把任意小说拆解为可迁移的**引擎**（结构骨架 + 编排节奏）与可替换的**皮**（题材 + 文笔），再把引擎嫁接到新题材上，流式生成一章全新的开篇。定位是**起书 / 立项副驾**（终点 = 一个打磨好的开篇），而非整本写作工厂。

## 它怎么工作

上传 `.txt` → 浏览器内切分章节 → 按体量自动路由的提取器把全书蒸馏成一张 **4 层引擎/皮 DNA 卡** → 选一本书当**骨架（引擎）**、可选另一本当**题材（皮）**（或口述题材）→ 工坊把骨架的结构节拍迁移到新题材、产出 3 个融合方向 → 选一条，自动补齐设定逻辑缺口并微调四块设定 → **流式生成一章连续开篇**。

界面为 Linear 风格的极简双主题（暗色优先，跟随系统、可在设置中手动切换）；`⌘/Ctrl + K` 呼出命令面板，可快速跳转作品/创作、新建创作与切换主题。

所有数据存在浏览器本地（IndexedDB + LocalStorage），无服务端数据库；模型 API Key 走 BYOK，绝不落服务端。

## 快速开始

在本目录（`yaml-write/`）下：

```bash
npm install
npm run dev          # 并发起 Next.js (:3000) + FastAPI/uvicorn (:8000)
```

打开 http://localhost:3000 ，在「设置」里填入任一 OpenAI 兼容服务商的 API Key（默认 DeepSeek）即可解锁全流程。

其它命令：

```bash
npm run build        # 生产构建（含全量类型检查）
npx tsc --noEmit     # 仅类型检查（快）
npm test             # vitest 纯逻辑单测
python -m unittest discover -s api   # 后端 Python 单测
```

## 架构与约定

混合 Next.js（全 client component）+ FastAPI，经 `next.config.js` rewrites 同源代理（无 CORS 层）。完整的架构、数据契约、Dexie 版本与开发铁律见 **[CLAUDE.md](CLAUDE.md)** —— 本仓库的权威说明源。

技术栈：Next.js 14 · React 18 · Zustand(persist) · Dexie / IndexedDB · Tailwind · FastAPI · instructor + Pydantic · OpenAI SDK（多 provider BYOK）。
