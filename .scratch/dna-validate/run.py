#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DNA 工坊 · 端到端忠实验证 harness（重建自丢失的 .scratch/step0_validate.py）

第一性原理：产品价值 100% 在「书 → 开篇」这一次 LLM 转换里。本脚本就是测这唯一变量的赤裸仪器——
不重写任何提示词，而是直接在内存里启动真实 FastAPI app（api/index.py），用 TestClient 打真实接口，
跑的就是生产代码路径（真实 prompt + DeepSeek JSON 结构化 + 补洞 + 忠实复刻的开篇场景）。

路由（忠实复刻 dnaRouting.ts）：
  direct   （≤18万字）：整本/切片一次喂入 → extract-book-direct → DNA
  arc      （≤200万）：全书切 24k 弧窗，逐窗 extract-arc-map → extract-book-reduce 合并
  sampling （>200万）：全部弧窗里均匀采样 ≤48 窗（含首尾）→ 同上 reduce

可判信号：① 压缩（书→DNA）② 重组（换皮→3方向+补洞）③ 文笔（开篇）。
健壮性：每步即时存盘；核心步失败即止；补洞/开篇/单个弧窗失败可降级或跳过；结构化步对 flash 的随机 JSON 失误重试。

用法（key 走环境变量，绝不写进文件）：
  DEEPSEEK_API_KEY=sk-xxx python .scratch/dna-validate/run.py "book.txt" \
      --route sampling --windows 48 --skin "新题材" --model deepseek-v4-flash
  --route auto 按字数自动选路；--dry 只装填不调用。
"""
import argparse
import json
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
YAML_WRITE = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, YAML_WRITE)
os.chdir(YAML_WRITE)

from starlette.testclient import TestClient  # noqa: E402
from api.index import app  # noqa: E402


class StepError(Exception):
    """单步调用失败（非 200）；核心步抛出即止，可降级步捕获后继续。"""


API_KEY = os.environ.get("DEEPSEEK_API_KEY", "").strip()
BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com").strip()

SMALL_MAX_CHARS = 180_000      # ≤ → direct（同 dnaRouting.ts）
ARC_MAX_CHARS = 2_000_000      # ≤ → arc；> → sampling
ARC_WINDOW_BUDGET = 24_000     # 单弧窗字数预算
SAMPLE_WINDOW_CAP = 48         # 饱和采样窗口上限

_WATERMARK = re.compile(
    r"(www\.|https?://|\.com|\.net|\.org|轻小说文库|文库|下载|本书来自|本书由|更新最快|最快更新|"
    r"手机阅读|电子书|首发|未完待续，|请记住本站|加入书签)",
    re.I,
)


def load_book(path):
    raw, used = None, None
    for enc in ("gb18030", "utf-8", "utf-16"):
        try:
            with open(path, encoding=enc) as f:
                raw = f.read()
            used = enc
            break
        except (UnicodeError, LookupError):
            continue
    if raw is None:
        raise SystemExit(f"[致命] 无法解码文件：{path}")
    lines = []
    for ln in raw.splitlines():
        s = ln.strip()
        if not s:
            continue
        if len(s) < 42 and _WATERMARK.search(s):
            continue
        lines.append(s)
    cleaned = "\n".join(lines)
    return cleaned, used, len(cleaned)


def route_by_size(n):
    if n <= SMALL_MAX_CHARS:
        return "direct"
    if n <= ARC_MAX_CHARS:
        return "arc"
    return "sampling"


def build_char_windows(text, budget=ARC_WINDOW_BUDGET):
    # 近似 buildArcWindows：无章节信息时按字数预算把全书切成连续 ~budget 字窗。
    return [text[i:i + budget] for i in range(0, len(text), budget)]


def sample_indices(n, cap):
    # 忠实复刻 dnaRouting.ts selectSampledWindows：含首尾 + 等距步长。
    if cap <= 0:
        return []
    if n <= cap:
        return list(range(n))
    if cap == 1:
        return [0]
    picked = {0, n - 1}
    inner = cap - 2
    if inner > 0:
        stride = (n - 1) / (inner + 1)
        for k in range(1, inner + 1):
            picked.add(round(k * stride))
    return sorted(picked)


def post(client, path, body, label, timeout=300, retries=1):
    last = None
    for attempt in range(retries + 1):
        tag = label if attempt == 0 else f"{label} · 重试{attempt}"
        print(f"\n>>> {tag} ...", flush=True)
        t0 = time.time()
        r = client.post(path, json=body, timeout=timeout)
        dt = time.time() - t0
        if r.status_code == 200:
            print(f"    完成（{dt:.1f}s）")
            return r.json()
        last = f"HTTP {r.status_code}：{r.text[:300]}"
        print(f"!!! {tag} 失败 {last}")
    raise StepError(f"{label} — {last}")


def stream_post(client, path, body, label, timeout=300):
    print(f"\n>>> {label}（流式）...", flush=True)
    t0 = time.time()
    r = client.post(path, json=body, timeout=timeout)
    if r.status_code != 200:
        raise StepError(f"{label} — HTTP {r.status_code}：{r.text[:300]}")
    chunks, err = [], None
    for frame in r.text.split("\n\n"):
        ev = data = None
        for line in frame.splitlines():
            if line.startswith("event:"):
                ev = line[6:].strip()
            elif line.startswith("data:"):
                data = line[5:].strip()
        if ev == "delta" and data:
            try:
                chunks.append(json.loads(data).get("text", ""))
            except json.JSONDecodeError:
                pass
        elif ev == "error" and data:
            err = data
    print(f"    完成（{time.time() - t0:.1f}s）")
    if err:
        raise StepError(f"{label} — 流式错误帧：{err}")
    return "".join(chunks)


def extract_sampling(client, name, text, creds, cap, route_label):
    wins = build_char_windows(text)
    idxs = sample_indices(len(wins), cap) if route_label == "sampling" else list(range(len(wins)))
    print(f"\n[{route_label}] 全书 {len(text):,} 字 → {len(wins)} 个 {ARC_WINDOW_BUDGET//1000}k 弧窗 → 实测 {len(idxs)} 窗（含首尾）")
    summaries, failed = [], 0
    for j, i in enumerate(idxs, 1):
        title = f"区间 {i + 1}/{len(wins)}（约第 {i * ARC_WINDOW_BUDGET // 1000}–{(i + 1) * ARC_WINDOW_BUDGET // 1000} 千字）"
        try:
            s = post(client, "/api/py/extract-arc-map",
                     {"title": title, "content": wins[i], **creds},
                     f"弧窗 map {j}/{len(idxs)}", retries=1)
            summaries.append({k: s.get(k, "") for k in
                              ("worldviewUpdates", "keyPlotTurns", "characterDevelopments", "styleObservations")})
        except StepError as e:
            failed += 1
            print(f"  [skip] 弧窗 {j} 失败：{str(e)[:120]}")
    print(f"\n弧窗 map 完成：成功 {len(summaries)} / 失败 {failed}（flash 失败率 {failed/max(1,len(idxs))*100:.0f}%）")
    if len(summaries) < 2:
        raise StepError(f"弧窗 map 成功数不足（{len(summaries)}），无法 reduce")
    dna = post(client, "/api/py/extract-book-reduce",
               {"novelName": name, "mapSummaries": summaries, **creds},
               "extract-book-reduce（合并 → 4 层 DNA）", retries=2)
    stats = {"totalWindows": len(wins), "sampled": len(idxs), "mapOk": len(summaries), "mapFailed": failed}
    return dna, stats


def print_dna(dna):
    print("\n" + "=" * 28 + " 4 层 DNA " + "=" * 28)
    print("【① 结构骨架（引擎·可迁移）】")
    for i, b in enumerate(dna.get("structureSkeleton", []), 1):
        print(f"  {i:2}. {b.get('function','')} —— {b.get('summary','')}")
    print(f"\n【② 编排节奏】\n  {dna.get('pacingSyuzhet','')}")
    print(f"\n【③ 题材皮】\n  {dna.get('themeSkin','')}")
    print(f"\n【④ 文笔】\n  {dna.get('proseStyle','')}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("book")
    ap.add_argument("--route", choices=["auto", "direct", "arc", "sampling"], default="auto")
    ap.add_argument("--chars", type=int, default=60000, help="direct 路由喂入字数上限")
    ap.add_argument("--windows", type=int, default=SAMPLE_WINDOW_CAP, help="sampling 路由采样窗口上限")
    ap.add_argument("--skin", default="深海高压：人类迁入万米海沟城市，靠改造身体承受水压，氧气与资源配额决定阶层与生死")
    ap.add_argument("--model", default="deepseek-v4-flash")
    ap.add_argument("--name", default="")
    ap.add_argument("--dry", action="store_true")
    args = ap.parse_args()

    cleaned, enc, total = load_book(args.book)
    name = args.name or re.sub(r"\.(txt|TXT)$", "", os.path.basename(args.book))
    route = route_by_size(total) if args.route == "auto" else args.route

    print("=" * 70)
    print(f"书名：{name} | 解码：{enc} | 清洗后总字数：{total:,}")
    print(f"路由：{route}（auto 判定={route_by_size(total)}） | 模型：{args.model} | base_url：{BASE_URL}")
    if route == "direct":
        print(f"direct 喂入：{min(total, args.chars):,} 字")
    else:
        nwin = len(build_char_windows(cleaned))
        ns = len(sample_indices(nwin, args.windows)) if route == "sampling" else nwin
        print(f"{route} 弧窗：{nwin} 个 → 实测 {ns} 窗")
    print(f"新题材皮：{args.skin}")
    print("=" * 70)

    if args.dry:
        print("\n[--dry] 装填成功，未调用 API。")
        return
    if not API_KEY:
        raise SystemExit("[致命] 缺少环境变量 DEEPSEEK_API_KEY")

    creds = {"apiKey": API_KEY, "baseUrl": BASE_URL, "model": args.model, "temperature": 0.7}
    out = os.path.join(HERE, f"result-{re.sub(r'[^- 一-龥A-Za-z0-9]', '_', name)}-{route}.json")
    report = {"book": name, "route": route, "model": args.model, "totalChars": total, "skin": args.skin}

    def save():
        with open(out, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)

    with TestClient(app) as client:
        # 产出 DNA（按路由）
        try:
            if route in ("arc", "sampling"):
                dna, stats = extract_sampling(client, name, cleaned, creds, args.windows, route)
                report["sampleStats"] = stats
            else:
                content = cleaned[:args.chars]
                report["feedChars"] = len(content)
                dna = post(client, "/api/py/extract-book-direct",
                           {"novelName": name, "content": content, **creds},
                           "extract-book-direct（压缩：书 → DNA）")
        except StepError as e:
            report["fatalError"] = str(e); save()
            raise SystemExit(f"[致命] 产出 DNA 失败：{e}")
        report["dna"] = dna; save()
        print_dna(dna)

        # ② 换皮 → 3 方向
        try:
            fusion = post(client, "/api/py/generate-fusion-directions", {
                "engineCard": {"novelName": name,
                               "structureSkeleton": dna["structureSkeleton"],
                               "pacingSyuzhet": dna.get("pacingSyuzhet", "")},
                "skinSource": {"novelName": "", "themeSkin": "", "proseStyle": "", "userBrief": args.skin},
                "mode": "self", **creds,
            }, "generate-fusion-directions（重组：换皮 → 3 方向）")
        except StepError as e:
            report["fatalError"] = str(e); save()
            raise SystemExit(f"[致命] 换皮失败：{e}")
        report["directions"] = fusion["directions"]; save()
        print("\n" + "=" * 28 + " 三个换皮方向 " + "=" * 28)
        for i, d in enumerate(fusion["directions"], 1):
            print(f"\n— 方向 {i}：{d.get('title','')} —")
            print(f"  概念：{d.get('concept','')}")
            print(f"  🧬 溯源：{d.get('transferNote','')}")
            print(f"  世界观：{d.get('worldviewBlock','')}")
            print(f"  主角：{d.get('protagonistBlock','')}")
            print(f"  对手：{d.get('antagonistBlock','')}")

        # 选方向 1 → 补洞（可降级）
        d0 = fusion["directions"][0]
        base_blocks = {k: d0.get(k, "") for k in
                       ("worldviewBlock", "protagonistBlock", "antagonistBlock", "narrativeTone")}
        blocks = dict(base_blocks)
        try:
            repaired = post(client, "/api/py/repair-setting-gaps", {
                **base_blocks, "structureSkeleton": dna["structureSkeleton"],
                "themeSkin": args.skin or "", **creds,
            }, "repair-setting-gaps（补洞：方向 1）", retries=2)
            report["repair"] = repaired
            blocks = {k: (repaired.get(k) or base_blocks[k]) for k in base_blocks}
            print("\n" + "=" * 28 + " 补洞（方向 1） " + "=" * 28)
            for g in repaired.get("gaps", []):
                print(f"  ⚠ {g.get('beat','')}：{g.get('issue','')}\n     补 → {g.get('patch','')}")
        except StepError as e:
            report["repairError"] = str(e)
            print(f"\n[!] 补洞失败，降级用方向 1 原始设定块继续 —— {str(e)[:120]}")
        save()

        # ④ 开篇正文（可降级）
        title = d0.get("title", "新作")
        try:
            opening = stream_post(client, "/api/py/stream-scene-text", {
                "selectedDirection": {"title": title, **blocks},
                "currentScene": {
                    "sceneNumber": 1,
                    "sceneTitle": f"{title or '新作'} · 开篇",
                    "plotOutline": "小说开篇：用具象的画面、动作与器物自然带出世界观、主角处境与核心钩子；不写大纲、不解释设定、不空泛抒情。",
                    "tensionLevel": "低开埋钩子，结尾留一个让人想读下一章的悬念",
                    "visualCues": "按世界观与叙事色调营造开篇画面与氛围",
                },
                "precedingTexts": {}, **creds,
            }, "stream-scene-text（开篇正文）")
            report["opening"] = opening
            print("\n" + "=" * 24 + f" 开篇正文：{title} " + "=" * 24 + "\n")
            print(opening)
        except StepError as e:
            report["openingError"] = str(e)
            print(f"\n[!] 开篇失败 —— {str(e)[:120]}")
        save()

    print(f"\n[已存档 → {out}]")


if __name__ == "__main__":
    main()
