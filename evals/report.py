"""报告生成与 A/B diff。markdown 给人看,json 给 compare 机读。"""
import json


def _avg(scores: list) -> float:
    return sum(s["score"] for s in scores) / len(scores) if scores else 0.0


def to_markdown(report: dict) -> str:
    lines = [f"# 评测报告:{report['label']}", ""]
    for case in report["cases"]:
        lines.append(f"## [{case['stage']}] {case['name']}")
        ck = case["checks"]
        lines.append(f"- 确定性检查:{'✅' if ck['passed'] else '❌ ' + '; '.join(ck['failures'])}")
        if case["scores"]:
            lines.append(f"- 均分:{_avg(case['scores']):.2f}")
            lines.append("")
            lines.append("| 维度 | 分 | 理由 |")
            lines.append("|---|---|---|")
            for s in case["scores"]:
                lines.append(f"| {s['dimension']} | {s['score']} | {s['reason']} |")
        lines.append("")
        lines.append("<details><summary>渲染 prompt</summary>\n\n```\n" + case["rendered_prompt"] + "\n```\n</details>")
        lines.append("")
    return "\n".join(lines)


def _index(report: dict) -> dict:
    out = {}
    for case in report["cases"]:
        for s in case["scores"]:
            out[(case["name"], s["dimension"])] = s["score"]
    return out


def diff_reports(baseline: dict, candidate: dict) -> str:
    bi, ci = _index(baseline), _index(candidate)
    keys = sorted(set(bi) | set(ci))
    lines = [f"# A/B 对比:{baseline['label']} → {candidate['label']}", "",
             "| case | 维度 | 基线 | 候选 | Δ |", "|---|---|---|---|---|"]
    for name, dim in keys:
        b = bi.get((name, dim))
        c = ci.get((name, dim))
        if b is None or c is None:
            delta = "n/a"
        else:
            d = c - b
            arrow = "↑" if d > 0 else ("↓" if d < 0 else "→")
            delta = f"{'+' if d > 0 else ''}{d}{arrow}"
        lines.append(f"| {name} | {dim} | {b if b is not None else '-'} | {c if c is not None else '-'} | {delta} |")
    return "\n".join(lines)


def save_report(report: dict, path_no_ext: str) -> tuple[str, str]:
    md_path, json_path = path_no_ext + ".md", path_no_ext + ".json"
    with open(json_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(to_markdown(report))
    return md_path, json_path
