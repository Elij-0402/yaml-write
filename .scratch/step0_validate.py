# -*- coding: utf-8 -*-
"""
第 0 步真机验证驱动 —— 忠实复用后端真实 prompt + 真实 Pydantic schema。
key 从环境变量 DEEPSEEK_KEY 读，绝不写进文件。
跑：斗破(引擎) + DanMachi(皮) → DNA → cross 融合 3 方向 → 补洞 → 开篇。
切片说明：为适配 DeepSeek-chat 64K ctx，引擎书跨全书采样 4×10k 字拼接，皮书取前 36k 字。非全本。
"""
import os, sys, asyncio, json

sys.path.insert(0, "D:/project/yaml-write/api")
import schemas  # 后端真实 Pydantic 响应模型（response_model）
from openai import AsyncOpenAI
import instructor

KEY = os.environ["DEEPSEEK_KEY"]
BASE_URL = "https://api.deepseek.com/v1"
MODEL = "deepseek-chat"
TEMP = 0.7
OUT = "D:/project/yaml-write/.scratch/step0_result.md"

ENGINE_FILE = "C:/Users/zerui/Downloads/《斗破苍穹》小说全集txt版.txt"
SKIN_FILE = "C:/Users/zerui/Downloads/1508.txt"

# ============ 后端真实 prompt（逐字复制自 api/index.py）============
ANTI_SLOP_CONSTRAINT = (
    "【反 AI 套路硬约束】严禁出现陈词滥调与空洞煽情，包括但不限于："
    "“命运的齿轮”“那一刻”“逆天改命”“眼神变得坚定”“嘴角勾起一抹弧度”“仿佛整个世界都安静了”"
    "“空气仿佛凝固”“心中一紧”“缓缓睁开眼”“不知为何”等。"
    "禁止宏大空泛的抒情与解释性旁白；改用冰冷、具象、高信息密度的物理细节与克制白描，"
    "让冲突通过动作、环境与器物呈现，而非作者直接告知。文字要有颗粒度与刺痛感。"
)
FOUR_LAYER_DNA_GUIDE = (
    "请把这本小说拆解为「可移植引擎」与「可替换皮」，输出 4 层创作 DNA"
    "（换皮变题理论：迁移引擎、替换皮 → 形似神不似的新书）：\n"
    "① structureSkeleton（引擎·结构骨架）：可迁移的【功能节拍序列】（Propp 功能 / 角色功能）。"
    "每个节拍含 function（功能名，须题材中立，如「废柴受辱」「获得金手指」「打脸打压者」「强敌登场」「绝境翻盘」）"
    "与 summary（该节拍在本书的具体体现，一句话）。按故事推进顺序给出约 8–20 个关键节拍，"
    "只保留可被任意题材复用的【结构功能】，剥离具体题材名词。\n"
    "② pacingSyuzhet（引擎·编排节奏）：视角排布、悬念与信息差的铺陈方式、爽点/钩子的出现节奏与曲线（syuzhet 表层编排）。\n"
    "③ themeSkin（皮·题材）：题材类型、世界观底层运行规则与代价体系、核心意象与符号——这是【可替换】的那层皮。\n"
    "④ proseStyle（文笔）：语言颗粒度、白描/意象风格、句式与语调质感。\n"
    "铁律：引擎层（①②）必须题材中立、可干净迁移；皮层（③④）才承载具体题材。"
)

aclient = instructor.from_openai(AsyncOpenAI(api_key=KEY, base_url=BASE_URL, timeout=120, max_retries=0))
rawclient = AsyncOpenAI(api_key=KEY, base_url=BASE_URL, timeout=120, max_retries=0)

log_chunks = []
def out(s=""):
    print(s, flush=True)
    log_chunks.append(s)

async def structured(response_model, system_prompt, user_prompt, label):
    out(f"\n>>> 调用 {label} …")
    r = await aclient.chat.completions.create(
        model=MODEL, response_model=response_model, temperature=TEMP, max_retries=2,
        messages=[{"role": "system", "content": system_prompt},
                  {"role": "user", "content": user_prompt}],
    )
    out(f"<<< {label} 完成")
    return r

def read_book(path):
    with open(path, "r", encoding="gb18030", errors="ignore") as f:
        return f.read()

def sample_engine(text, n=4, win=10000):
    L = len(text)
    if L <= n * win:
        return text[: n * win]
    offs = [int(L * x) for x in (0.02, 0.30, 0.55, 0.80)]
    parts = [text[o:o + win] for o in offs]
    return "\n\n【……（采样跳段）……】\n\n".join(parts)

async def extract_dna(novel_name, content):
    system = ("你是一个顶级的小说架构大师与叙事学者。下面给出一本小说接近完整的正文（可能为节选/截断）。"
              "请整体把握全书后，" + FOUR_LAYER_DNA_GUIDE)
    user = f"小说名：{novel_name}\n\n【小说正文】\n{content}"
    return await structured(schemas.NovelDNACardResponse, system, user, f"extract_book_direct[{novel_name}]")

async def fuse(engine_card, engine_name, skin_card, skin_name):
    beats = "\n".join(f"- {b.function}：{b.summary}" for b in engine_card.structureSkeleton if b.function.strip()) or "（结构骨架为空）"
    skin_block = (f"题材来源：{skin_name}\n题材世界观与意象：{skin_card.themeSkin}\n参考文笔质感：{skin_card.proseStyle}")
    system = (
        "你是一位精通「换皮变题」的小说迁移大师（学理：Propp 功能不变·角色可替换；Riedl『story analogues』类推迁移）。"
        "任务：把【骨架引擎】的功能节拍序列，逐一类推迁移到【新题材皮】，产出 3 个『形似神不似』的换皮嫁接方向。\n"
        "硬规则：\n"
        "1. 保持引擎的功能节拍序列与编排节奏不变——同一套结构骨架与爽点曲线，只换皮、不换骨。\n"
        "2. 把每个功能节拍重新具象化为新题材里的等价事件（角色 / 道具 / 场景 / 机制换皮，功能不变），严禁照抄原书的题材名词。\n"
        "3. 3 个方向必须采用显著不同的嫁接思路（如：题材直译 / 反转母题 / 杂交第三元素），彼此在题材与机制上明显区分，禁止换名式雷同。\n"
        "4. 每个方向给出：title、concept（一句话核心冲突）、catalyst（催化变量及其质变）、"
        "worldviewBlock / protagonistBlock / antagonistBlock / narrativeTone（换皮后的新书具体设定四块）、"
        "transferNote（一句话溯源：保留了引擎的哪条结构、替换成了什么题材皮）。\n"
        "5. 设定四块要逻辑自洽、可支撑后续开篇正文；narrativeTone 贴合新题材重新生成文笔，不照搬原书。\n"
        + ANTI_SLOP_CONSTRAINT)
    user = (f"【骨架引擎（迁移不变量）】\n来源：{engine_name}\n结构功能节拍序列：\n{beats}\n"
            f"编排节奏：{engine_card.pacingSyuzhet}\n\n【新题材皮（替换目标）】\n{skin_block}\n\n请输出 3 个换皮嫁接方向。")
    return await structured(schemas.FusionDirectionsResponse, system, user, "generate_fusion_directions")

async def repair(direction, engine_card, skin_themeSkin):
    beats = "\n".join(f"- {b.function}：{b.summary}" for b in engine_card.structureSkeleton if b.function.strip())
    system = (
        "你是换皮迁移的『补洞质检官』。朴素的结构迁移常留下逻辑硬伤——新题材撑不起原结构的某些功能节拍。\n"
        "请逐一核对【引擎结构节拍】在【新书设定】下能否自洽成立：\n"
        "1. 定位撑不住的节拍（例：『吞噬异火升级』迁到美食题材后没有对应的升级机制）。\n"
        "2. 为每个断裂点补入让逻辑自洽的事件 / 设定 / 机制，并写进对应的设定块。\n"
        "3. 只做『补洞』式增补与微调：不要推翻方向、不要更换题材、不要删除既有合理设定。\n"
        "返回补洞后的四块设定，以及 gaps（你定位并补入的断裂点清单：beat / issue / patch）。"
        + ANTI_SLOP_CONSTRAINT)
    user = (f"【引擎结构功能节拍序列（必须都被新题材支撑）】\n{beats}\n\n【新题材皮】\n{skin_themeSkin}\n\n"
            f"【当前新书设定四块】\nworldviewBlock：{direction.worldviewBlock}\nprotagonistBlock：{direction.protagonistBlock}\n"
            f"antagonistBlock：{direction.antagonistBlock}\nnarrativeTone：{direction.narrativeTone}\n\n请补洞并返回完整的四块设定与 gaps 清单。")
    return await structured(schemas.RepairSettingGapsResponse, system, user, "repair_setting_gaps")

async def write_opening(title, blocks):
    system = ("你是一位文字极具颗粒度的小说家。请根据给定的设定积木与当前分镜大纲创作小说正文。\n"
              + ANTI_SLOP_CONSTRAINT + "\n直接输出正文，不要任何前言、标题或解释。")
    user = (
        f"【角色设定与世界观积木】\n世界观：{blocks['worldviewBlock']}\n主角：{blocks['protagonistBlock']}\n"
        f"对手：{blocks['antagonistBlock']}\n叙事色调：{blocks['narrativeTone']}\n\n"
        f"【当前要写作的分镜】\n标题：{title} · 开篇\n"
        f"情节走向：小说开篇：用具象的画面、动作与器物自然带出世界观、主角处境与核心钩子；不写大纲、不解释设定、不空泛抒情。\n"
        f"张力：低开埋钩子，结尾留一个让人想读下一章的悬念\n画面意象：按世界观与叙事色调营造开篇画面与氛围\n\n"
        f"【前置分镜已写出的实际正文（供承上启下）】\n----- 前情回顾 -----\n（这是开篇第一个分镜，无前文。）\n-------------------\n"
        "请紧密承接前置分镜最后一句话的语气、环境与角色站位，继续创作当前分镜。"
        "严禁剧情断层或设定漂移。直接开始输出正文，不要重复前文。")
    out("\n>>> 调用 stream_scene_text（开篇，非流式收集）…")
    r = await rawclient.chat.completions.create(
        model=MODEL, temperature=TEMP, max_tokens=3200,
        messages=[{"role": "system", "content": system}, {"role": "user", "content": user}])
    out("<<< 开篇完成")
    return r.choices[0].message.content

async def main():
    out("# 第 0 步真机验证结果（DeepSeek-chat）\n")
    out(f"引擎书：斗破苍穹（跨全书采样 4×10k 字）｜皮书：DanMachi/在地下城…（前 36k 字）｜model={MODEL}\n")

    eng_text = sample_engine(read_book(ENGINE_FILE))
    skin_text = read_book(SKIN_FILE)[:36000]
    out(f"引擎切片字数：{len(eng_text)}｜皮切片字数：{len(skin_text)}")

    eng = await extract_dna("斗破苍穹", eng_text)
    out("\n## ① 引擎 DNA（斗破苍穹）")
    out("### 结构骨架 structureSkeleton")
    for i, b in enumerate(eng.structureSkeleton, 1):
        out(f"{i}. **{b.function}** — {b.summary}")
    out(f"\n### 编排节奏 pacingSyuzhet\n{eng.pacingSyuzhet}")
    out(f"\n### 题材皮 themeSkin（引擎书的，仅参考）\n{eng.themeSkin}")
    out(f"\n### 文笔 proseStyle\n{eng.proseStyle}")

    skin = await extract_dna("在地下城寻求邂逅", skin_text)
    out("\n## ② 皮 DNA（DanMachi）")
    out(f"### 题材皮 themeSkin\n{skin.themeSkin}")
    out(f"\n### 文笔 proseStyle\n{skin.proseStyle}")

    fus = await fuse(eng, "斗破苍穹", skin, "在地下城寻求邂逅")
    out("\n## ③ 融合 3 方向（斗破引擎 × DanMachi 皮，cross）")
    for i, d in enumerate(fus.directions, 1):
        out(f"\n### 方向 {i}：{d.title}")
        out(f"- **概念**：{d.concept}")
        out(f"- **催化变量**：{d.catalyst}")
        out(f"- **溯源 transferNote**：{d.transferNote}")
        out(f"- **世界观**：{d.worldviewBlock}")
        out(f"- **主角**：{d.protagonistBlock}")
        out(f"- **对手**：{d.antagonistBlock}")
        out(f"- **叙事色调**：{d.narrativeTone}")

    d0 = fus.directions[0]
    rep = await repair(d0, eng, skin.themeSkin)
    out(f"\n## ④ 补洞（方向 1：{d0.title}）")
    out("### 补的洞 gaps")
    for g in rep.gaps:
        out(f"- **{g.beat}**｜断裂：{g.issue}｜补丁：{g.patch}")
    blocks = {"worldviewBlock": rep.worldviewBlock, "protagonistBlock": rep.protagonistBlock,
              "antagonistBlock": rep.antagonistBlock, "narrativeTone": rep.narrativeTone}

    opening = await write_opening(d0.title, blocks)
    out(f"\n## ⑤ 开篇成稿（方向 1：{d0.title}）\n")
    out(opening or "（空）")

    with open(OUT, "w", encoding="utf-8") as f:
        f.write("\n".join(log_chunks))
    out(f"\n\n[已保存到 {OUT}]")

asyncio.run(main())
