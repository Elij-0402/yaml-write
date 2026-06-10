"""命令行:run / compare / show / --dry-run。"""
import argparse
import asyncio
import json
import os

from evals.config import load_config
from evals.cases import load_cases
from evals.runner import run_case
from evals.report import save_report, to_markdown, diff_reports

ALL_STAGES = ["extract", "directions", "repair", "prose"]
REPORTS_DIR = os.path.join(os.path.dirname(__file__), "reports")


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="evals")
    sub = p.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("--stage", default="all", choices=ALL_STAGES + ["all"])
    r.add_argument("--size", default="small", choices=["small", "full"])
    r.add_argument("--votes", type=int, default=1)
    r.add_argument("--no-cache", action="store_true")
    r.add_argument("--dry-run", action="store_true")
    r.add_argument("--label", required=True)
    c = sub.add_parser("compare")
    c.add_argument("baseline")
    c.add_argument("candidate")
    s = sub.add_parser("show")
    s.add_argument("label")
    return p


def plan_calls(stages: list, case_counts: dict, votes: int) -> dict:
    gen = sum(case_counts.get(s, 0) for s in stages)
    judge = gen * max(1, votes)
    return {"generate": gen, "judge": judge}


def _stages_for(stage: str) -> list:
    return ALL_STAGES if stage == "all" else [stage]


def _load_json(label: str) -> dict:
    with open(os.path.join(REPORTS_DIR, f"{label}.json"), encoding="utf-8") as fh:
        return json.load(fh)


def cmd_run(args) -> None:
    stages = _stages_for(args.stage)
    case_counts = {s: len(load_cases(s)) for s in stages}
    if args.dry_run:
        plan = plan_calls(stages, case_counts, args.votes)
        print(f"[dry-run] stages={stages} cases={case_counts} "
              f"预计生成 {plan['generate']} 次 + judge {plan['judge']} 次调用")
        return
    cfg = load_config()
    os.makedirs(REPORTS_DIR, exist_ok=True)
    all_cases = [c for s in stages for c in load_cases(s)]

    async def _go():
        out = []
        for case in all_cases:
            print(f"... 跑 [{case.stage}] {case.name}")
            out.append(await run_case(case, cfg=cfg, use_cache=not args.no_cache, votes=args.votes))
        return out

    cases = asyncio.run(_go())
    report = {"label": args.label, "cases": cases}
    md, js = save_report(report, os.path.join(REPORTS_DIR, args.label))
    print(f"报告已写:{md}\n           {js}")


def cmd_compare(args) -> None:
    print(diff_reports(_load_json(args.baseline), _load_json(args.candidate)))


def cmd_show(args) -> None:
    print(to_markdown(_load_json(args.label)))


def main(argv=None) -> None:
    args = build_parser().parse_args(argv)
    {"run": cmd_run, "compare": cmd_compare, "show": cmd_show}[args.cmd](args)
