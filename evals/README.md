# evals — yaml-write 评测地基

手动跑的质量度量。**不**并入 `npm test` / 默认 `unittest`(花钱、非确定)。

## 用法
    export DEEPSEEK_API_KEY=sk-xxx
    python -m evals run --stage all --size small --label baseline
    python -m evals compare baseline candidate
    python -m evals show baseline

离线单测(无网络):`python -m unittest discover evals`
