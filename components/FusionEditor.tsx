import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, type Novel } from '../app/db';
import { useAppStore } from '../app/store';
import { Sparkles, PenTool, FileDown, Copy, Check, RotateCcw, HelpCircle, Loader2, ArrowRight, BookOpen } from 'lucide-react';

export default function FusionEditor() {
  const { llmConfig } = useAppStore();
  
  // States
  const [selectedChapterIds, setSelectedChapterIds] = useState<string[]>([]);
  const [fusionPrompt, setFusionPrompt] = useState<string>('');
  
  const [step, setStep] = useState<1 | 2 | 3>(1); // 1: Select & Prompt, 2: Edit Outline, 3: Generate Text
  const [outline, setOutline] = useState<string>('');
  const [novelText, setNovelText] = useState<string>('');
  
  const [generatingOutline, setGeneratingOutline] = useState<boolean>(false);
  const [generatingText, setGeneratingText] = useState<boolean>(false);
  
  const [copiedOutline, setCopiedOutline] = useState<boolean>(false);
  const [copiedText, setCopiedText] = useState<boolean>(false);

  // Live query novels and all done parsed chapters
  const novels = useLiveQuery(() => db.novels.toArray()) || [];
  const parsedChapters = useLiveQuery(() => db.chapters.where('status').equals('done').toArray()) || [];

  const handleToggleChapter = (id: string) => {
    setSelectedChapterIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleGenerateOutline = async () => {
    if (!llmConfig.apiKey) {
      alert('请先配置大模型 API Key！');
      return;
    }
    if (selectedChapterIds.length === 0) {
      alert('请选择至少一个已解析的章节作为融合样本！');
      return;
    }
    if (!fusionPrompt.trim()) {
      alert('请输入融合创意指令！');
      return;
    }

    setGeneratingOutline(true);
    setOutline('');
    setStep(2); // Auto proceed to step 2 outline view

    try {
      // Gather selected chapters' analysis from Dexie
      const selectedChaptersData = await Promise.all(
        selectedChapterIds.map(async (id) => {
          const chap = await db.chapters.get(id);
          return chap?.analysis || {};
        })
      );

      const response = await fetch('/api/py/generate-outline', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          selectedChapters: selectedChaptersData,
          fusionPrompt: fusionPrompt,
          apiKey: llmConfig.apiKey,
          baseUrl: llmConfig.baseUrl,
          model: llmConfig.model,
          temperature: llmConfig.temperature,
        }),
      });

      if (!response.ok) {
        throw new Error('启动大纲流式生成失败');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('未获取到流读取器');
      }

      const decoder = new TextDecoder('utf-8');
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: !done });
          setOutline((prev) => prev + chunk);
        }
      }
    } catch (err: any) {
      console.error(err);
      setOutline((prev) => prev + `\n\n[生成出错: ${err.message}]`);
    } finally {
      setGeneratingOutline(false);
    }
  };

  const handleGenerateText = async () => {
    if (!llmConfig.apiKey) {
      alert('请先配置大模型 API Key！');
      return;
    }
    if (!outline.trim()) {
      alert('融合大纲不能为空！');
      return;
    }

    setGeneratingText(true);
    setNovelText('');
    setStep(3); // Auto proceed to step 3 text view

    try {
      const response = await fetch('/api/py/generate-text', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          outline: outline,
          fusionPrompt: fusionPrompt,
          apiKey: llmConfig.apiKey,
          baseUrl: llmConfig.baseUrl,
          model: llmConfig.model,
          temperature: llmConfig.temperature,
        }),
      });

      if (!response.ok) {
        throw new Error('启动正文流式生成失败');
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('未获取到流读取器');
      }

      const decoder = new TextDecoder('utf-8');
      let done = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: !done });
          setNovelText((prev) => prev + chunk);
        }
      }
    } catch (err: any) {
      console.error(err);
      setNovelText((prev) => prev + `\n\n[生成出错: ${err.message}]`);
    } finally {
      setGeneratingText(false);
    }
  };

  const handleCopy = (text: string, isText: boolean) => {
    navigator.clipboard.writeText(text);
    if (isText) {
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    } else {
      setCopiedOutline(true);
      setTimeout(() => setCopiedOutline(false), 2000);
    }
  };

  const handleDownload = (text: string, filename: string) => {
    const element = document.createElement("a");
    const file = new Blob([text], {type: 'text/plain'});
    element.href = URL.createObjectURL(file);
    element.download = filename;
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-auto lg:h-[calc(100vh-12rem)] min-h-0">
      
      {/* Left Sidebar: Select Novel Chapters & Steps Progress */}
      <div className="lg:col-span-1 bg-zinc-900/20 border border-zinc-800/80 rounded-2xl p-4 flex flex-col shadow-xl min-h-0">
        <h3 className="text-sm font-bold text-zinc-400 mb-3 px-1 uppercase tracking-wider">融合创意控制台</h3>
        
        {/* Step Indicator */}
        <div className="space-y-2 mb-6">
          <button
            onClick={() => setStep(1)}
            className={`w-full p-3 rounded-xl border text-left transition-all flex items-center justify-between ${
              step === 1
                ? 'bg-zinc-800/60 border-zinc-700 text-zinc-100 shadow-sm'
                : 'bg-zinc-950/20 border-zinc-900/80 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <span className="text-xs font-bold">1. 选择素材与大纲生成</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setStep(2)}
            disabled={!outline}
            className={`w-full p-3 rounded-xl border text-left transition-all flex items-center justify-between disabled:opacity-40 disabled:cursor-not-allowed ${
              step === 2
                ? 'bg-zinc-800/60 border-zinc-700 text-zinc-100 shadow-sm'
                : 'bg-zinc-950/20 border-zinc-900/80 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <span className="text-xs font-bold">2. 大纲二次微调</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => setStep(3)}
            disabled={!novelText && !outline}
            className={`w-full p-3 rounded-xl border text-left transition-all flex items-center justify-between disabled:opacity-40 disabled:cursor-not-allowed ${
              step === 3
                ? 'bg-zinc-800/60 border-zinc-700 text-zinc-100 shadow-sm'
                : 'bg-zinc-950/20 border-zinc-900/80 text-zinc-500 hover:text-zinc-300'
            }`}
          >
            <span className="text-xs font-bold">3. 流式正文扩写</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Chapters selection grid */}
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col border-t border-zinc-800 pt-4">
          <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block mb-2 px-1">
            已解析的小说章节 ({parsedChapters.length})
          </label>
          
          {parsedChapters.length === 0 ? (
            <div className="text-center py-8 text-zinc-650 text-xs">
              没有已解析的章节。请先在解析库中进行章节的特征解析。
            </div>
          ) : (
            <div className="space-y-1.5 flex-1 overflow-y-auto pr-1">
              {parsedChapters.map((c) => {
                const isSelected = selectedChapterIds.includes(c.id);
                const novel = novels.find((n) => n.id === c.novelId);
                
                return (
                  <div
                    key={c.id}
                    onClick={() => handleToggleChapter(c.id)}
                    className={`p-2.5 rounded-lg border cursor-pointer transition-all flex items-center gap-2.5 min-w-0 ${
                      isSelected
                        ? 'bg-zinc-800/80 border-zinc-700 text-zinc-100'
                        : 'bg-zinc-950/20 border-zinc-900/80 hover:border-zinc-800 text-zinc-455 hover:text-zinc-300'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}} // toggled by parent div onClick
                      className="accent-zinc-500 flex-shrink-0"
                    />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate leading-tight">{c.name}</p>
                      <p className="text-[9px] text-zinc-500 mt-0.5 truncate leading-tight font-mono">
                        《{novel?.name || '未知小说'}》
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right Content View: Interactive step panels */}
      <div className="lg:col-span-3 bg-zinc-900/20 border border-zinc-800/80 rounded-2xl p-6 flex flex-col shadow-xl overflow-y-auto min-h-0">
        
        {/* Step 1: Input Prompts and Generate */}
        {step === 1 && (
          <div className="h-full flex flex-col gap-6">
            <div>
              <h2 className="text-lg font-bold text-zinc-200">第一步：输入融合指令并生成大纲</h2>
              <p className="text-xs text-zinc-500 mt-0.5">请选中左侧已解析的章节，随后输入您的创意指令。大模型将流式渲染融合大纲。</p>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-bold text-zinc-400 flex items-center gap-1.5">
                <BookOpen className="w-3.5 h-3.5 text-zinc-400" />
                创意融合要求指令
              </label>
              <textarea
                value={fusionPrompt}
                onChange={(e) => setFusionPrompt(e.target.value)}
                placeholder="例如：将科幻世界观的‘纳米虫末日’设定，融入到修真世界的‘天道崩塌’大劫中。左侧主角A拥有的科学常识，与右侧主角B的纯阳道体产生剧烈碰撞，让他们在一场遗迹探险中不得不进行联手..."
                rows={6}
                className="w-full px-4 py-3 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-700 transition-all leading-relaxed"
              />
            </div>

            <div className="p-4 rounded-xl bg-zinc-950/20 border border-zinc-800/80 flex items-start gap-3">
              <HelpCircle className="w-5 h-5 text-zinc-450 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-zinc-500 leading-relaxed">
                <p className="font-semibold text-zinc-350">大模型融合工作流</p>
                <p className="mt-1">
                  1. 系统将自动组合您所选的全部章节中的角色性格、世界观架构、人物纠葛。<br />
                  2. 融合大纲生成后，您可以在第二步中随意修改或重写大纲内容。<br />
                  3. 最终确认的大纲将指导第三步的高精正文流式输出。
                </p>
              </div>
            </div>

            <div className="mt-auto pt-4 flex justify-end">
              <button
                onClick={handleGenerateOutline}
                disabled={generatingOutline || selectedChapterIds.length === 0 || !fusionPrompt.trim()}
                className="py-3 px-6 rounded-xl bg-zinc-100 hover:bg-zinc-200 text-zinc-900 font-semibold text-sm shadow-sm transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {generatingOutline ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    大纲流式生成中...
                  </>
                ) : (
                  <>
                    <BookOpen className="w-4 h-4" />
                    流式生成融合新大纲
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Outline Edit View */}
        {step === 2 && (
          <div className="h-full flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
              <div>
                <h2 className="text-lg font-bold text-zinc-200">第二步：融合大纲与架构微调</h2>
                <p className="text-xs text-zinc-500 mt-0.5">您可以直接在此对 AI 生成的大纲进行微调，确保符合您的创作本心。</p>
              </div>
              
              <div className="flex gap-2">
                <button
                  onClick={() => handleCopy(outline, false)}
                  className="p-2 bg-zinc-950 border border-zinc-800 hover:border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-200 transition-all flex items-center gap-1.5 text-xs font-semibold"
                >
                  {copiedOutline ? <Check className="w-3.5 h-3.5 text-emerald-450" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedOutline ? '已复制' : '复制大纲'}
                </button>

                <button
                  onClick={() => setStep(1)}
                  className="p-2 bg-zinc-950 border border-zinc-800 hover:border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-200 transition-all flex items-center gap-1.5 text-xs font-semibold"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  重新填写要求
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-[300px] flex flex-col">
              {generatingOutline && !outline && (
                <div className="flex-1 flex flex-col items-center justify-center text-center">
                  <Loader2 className="w-8 h-8 text-zinc-400 animate-spin mb-3" />
                  <p className="text-sm font-semibold text-zinc-400">大纲正在流式连接与响应中...</p>
                </div>
              )}
              
              <textarea
                value={outline}
                onChange={(e) => setOutline(e.target.value)}
                placeholder="此处大纲正在流式生成或为空。请点击上一步生成大纲..."
                rows={18}
                className="w-full flex-1 p-4 rounded-xl bg-zinc-950/40 border border-zinc-800 text-zinc-200 font-mono text-sm leading-relaxed focus:outline-none focus:ring-1 focus:ring-zinc-700"
              />
            </div>

            <div className="flex justify-end pt-3">
              <button
                onClick={handleGenerateText}
                disabled={generatingText || !outline.trim() || generatingOutline}
                className="py-3 px-6 rounded-xl bg-zinc-800 hover:bg-zinc-750 text-zinc-100 font-semibold text-sm shadow-sm transition-all flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed border border-zinc-750"
              >
                {generatingText ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    正文扩写中...
                  </>
                ) : (
                  <>
                    <PenTool className="w-4 h-4" />
                    一键流式扩写小说正文
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Stream Novel Text view */}
        {step === 3 && (
          <div className="h-full flex flex-col gap-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
              <div>
                <h2 className="text-lg font-bold text-zinc-200">第三步：流式正文呈现</h2>
                <p className="text-xs text-zinc-500 mt-0.5">AI 白金作家正在根据微调大纲进行正文长篇扩写与润色。</p>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => handleCopy(novelText, true)}
                  disabled={!novelText}
                  className="p-2 bg-zinc-950 border border-zinc-800 hover:border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-200 transition-all flex items-center gap-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  {copiedText ? <Check className="w-3.5 h-3.5 text-emerald-450" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedText ? '已复制' : '复制正文'}
                </button>

                <button
                  onClick={() => handleDownload(novelText, "融合章节正文.txt")}
                  disabled={!novelText}
                  className="p-2 bg-zinc-950 border border-zinc-800 hover:border-zinc-700 rounded-lg text-zinc-400 hover:text-zinc-200 transition-all flex items-center gap-1.5 text-xs font-semibold disabled:opacity-50"
                >
                  <FileDown className="w-3.5 h-3.5" />
                  导出为 TXT
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-[350px] flex flex-col bg-zinc-950/40 border border-zinc-800 rounded-xl p-6">
              {generatingText && !novelText && (
                <div className="flex-1 flex flex-col items-center justify-center text-center">
                  <Loader2 className="w-8 h-8 text-zinc-450 animate-spin mb-3" />
                  <p className="text-sm font-semibold text-zinc-400">大模型开始着手构思、铺陈情节...</p>
                </div>
              )}

              <div className="flex-1 overflow-y-auto max-h-[500px] text-zinc-200 text-base leading-loose tracking-wide whitespace-pre-wrap font-serif px-2">
                {novelText || (
                  <div className="text-zinc-650 italic font-sans text-sm">尚未开始生成正文。请返回上一步确认大纲并点击扩写。</div>
                )}
              </div>
            </div>

            <div className="flex justify-between items-center pt-3">
              <button
                onClick={() => setStep(2)}
                className="py-2.5 px-4 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 rounded-lg text-xs font-semibold"
              >
                返回修改大纲
              </button>

              {generatingText && (
                <div className="text-xs text-zinc-400 animate-pulse font-mono flex items-center gap-1.5">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  小说正文正在流式逐字加载...
                </div>
              )}
            </div>
          </div>
        )}

      </div>

    </div>
  );
}
