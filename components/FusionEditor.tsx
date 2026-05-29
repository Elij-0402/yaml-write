import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Chapter, type Novel } from '../app/db';
import { Sparkles, PenTool, FileDown, Copy, Check, RotateCcw, HelpCircle, Loader2, ArrowRight, BookOpen, X } from 'lucide-react';
import { ensureLlmConfigReady, postWithLlmConfig, readApiErrorMessage } from '../app/llmClient';

interface CharacterBinding {
  sourceChar: string;
  targetChar: string;
  bindingType: 'merge' | 'clash' | 'mentor' | 'custom';
  customDesc?: string;
}

interface StreamEventPayload {
  text?: string;
  code?: string;
  message?: string;
}

interface ParsedSseEvent {
  event: string;
  payload: StreamEventPayload;
}

function parseSseBuffer(buffer: string): { events: ParsedSseEvent[]; rest: string } {
  const chunks = buffer.split('\n\n');
  const rest = chunks.pop() ?? '';
  const events: ParsedSseEvent[] = [];

  for (const rawChunk of chunks) {
    const lines = rawChunk.split('\n');
    let event = 'message';
    let dataLine = '';
    for (const line of lines) {
      if (line.startsWith('event:')) {
        event = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLine += line.slice(5).trim();
      }
    }
    if (!dataLine) continue;
    try {
      events.push({ event, payload: JSON.parse(dataLine) as StreamEventPayload });
    } catch {
      events.push({ event: 'error', payload: { code: 'invalid_stream_payload', message: '流式返回格式异常。' } });
    }
  }

  return { events, rest };
}

export default function FusionEditor() {
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
  
  // 角色拉线深度绑定状态
  const [characterBindings, setCharacterBindings] = useState<CharacterBinding[]>([]);

  // Live query novels and all done parsed chapters
  const novels = useLiveQuery(() => db.novels.toArray()) || [];
  const parsedChapters = useLiveQuery(() => db.chapters.where('status').equals('done').toArray()) || [];

  // 从选中章节中提取全部已分析出的角色列表
  const availableCharacters = React.useMemo(() => {
    const chars: { name: string; chapterName: string; novelId: string; novelName: string }[] = [];
    selectedChapterIds.forEach((id) => {
      const chap = parsedChapters.find((c) => c.id === id);
      if (chap && chap.analysis?.characters) {
        const novel = novels.find((n) => n.id === chap.novelId);
        chap.analysis.characters.forEach((char) => {
          if (!chars.some((c) => c.name === char.name)) {
            chars.push({
              name: char.name,
              chapterName: chap.name,
              novelId: chap.novelId,
              novelName: novel?.name || '未知小说',
            });
          }
        });
      }
    });
    return chars;
  }, [selectedChapterIds, parsedChapters, novels]);

  // 当选择章节变更、角色池变动时，静默清洗掉无效的拉线配对规则
  React.useEffect(() => {
    setCharacterBindings((prev) =>
      prev.filter(
        (b) =>
          availableCharacters.some((c) => c.name === b.sourceChar) &&
          availableCharacters.some((c) => c.name === b.targetChar)
      )
    );
  }, [availableCharacters]);

  const handleToggleChapter = (id: string) => {
    setSelectedChapterIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleGenerateOutline = async () => {
    const readiness = ensureLlmConfigReady();
    if (!readiness.ok) {
      alert(readiness.message || '请先完成大模型配置。');
      window.dispatchEvent(new Event('open-settings-panel'));
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

      const response = await postWithLlmConfig('/api/py/generate-outline', {
          selectedChapters: selectedChaptersData,
          fusionPrompt,
          characterBindings,
      });

      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response));
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('未获取到流读取器');
      }

      const decoder = new TextDecoder('utf-8');
      let done = false;
      let buffer = '';
      let gotDoneEvent = false;
      let receivedDelta = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: !done });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;

        for (const event of parsed.events) {
          if (event.event === 'delta' && event.payload.text) {
            receivedDelta = true;
            setOutline((prev) => prev + event.payload.text!);
          } else if (event.event === 'error') {
            throw new Error(event.payload.message || '流式生成失败');
          } else if (event.event === 'done') {
            gotDoneEvent = true;
          }
        }
      }

      if (!gotDoneEvent && !receivedDelta) {
        throw new Error('生成提前结束，请重试。');
      }
    } catch (err: any) {
      console.error(err);
      setOutline((prev) => prev + `\n\n[生成出错: ${err.message}]`);
    } finally {
      setGeneratingOutline(false);
    }
  };

  const handleGenerateText = async () => {
    const readiness = ensureLlmConfigReady();
    if (!readiness.ok) {
      alert(readiness.message || '请先完成大模型配置。');
      window.dispatchEvent(new Event('open-settings-panel'));
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
      const response = await postWithLlmConfig('/api/py/generate-text', {
        outline,
        fusionPrompt,
      });

      if (!response.ok) {
        throw new Error(await readApiErrorMessage(response));
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('未获取到流读取器');
      }

      const decoder = new TextDecoder('utf-8');
      let done = false;
      let buffer = '';
      let gotDoneEvent = false;
      let receivedDelta = false;

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (!value) continue;

        buffer += decoder.decode(value, { stream: !done });
        const parsed = parseSseBuffer(buffer);
        buffer = parsed.rest;

        for (const event of parsed.events) {
          if (event.event === 'delta' && event.payload.text) {
            receivedDelta = true;
            setNovelText((prev) => prev + event.payload.text!);
          } else if (event.event === 'error') {
            throw new Error(event.payload.message || '流式生成失败');
          } else if (event.event === 'done') {
            gotDoneEvent = true;
          }
        }
      }

      if (!gotDoneEvent && !receivedDelta) {
        throw new Error('生成提前结束，请重试。');
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
    <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 h-auto min-h-0 flex-1">
      
      {/* Left Sidebar: Select Novel Chapters & Steps Progress */}
      <div className="lg:col-span-1 linear-card p-4 rounded flex flex-col bg-[#08080a]/60">
        <h3 className="text-[10px] font-semibold text-zinc-550 mb-4 px-1 uppercase tracking-widest font-mono">创意工坊导航</h3>
        
        {/* Step Indicator */}
        <div className="flex flex-col gap-1 mb-5">
          <button
            onClick={() => setStep(1)}
            className={`w-full py-2.5 px-3 rounded text-left transition-linear active-press text-xs flex items-center justify-between font-semibold ${
              step === 1
                ? 'bg-[#121214] border border-zinc-800 text-zinc-100'
                : 'bg-transparent border border-transparent text-zinc-450 hover:text-zinc-200'
            }`}
          >
            <span>1. 设定指令与章节</span>
            <ArrowRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          </button>

          <button
            onClick={() => setStep(2)}
            disabled={!outline}
            className={`w-full py-2.5 px-3 rounded text-left transition-linear active-press text-xs flex items-center justify-between font-semibold disabled:opacity-30 disabled:cursor-not-allowed ${
              step === 2
                ? 'bg-[#121214] border border-zinc-800 text-zinc-100'
                : 'bg-transparent border border-transparent text-zinc-450 hover:text-zinc-200'
            }`}
          >
            <span>2. 调整融合大纲</span>
            <ArrowRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          </button>

          <button
            onClick={() => setStep(3)}
            disabled={!novelText && !outline}
            className={`w-full py-2.5 px-3 rounded text-left transition-linear active-press text-xs flex items-center justify-between font-semibold disabled:opacity-30 disabled:cursor-not-allowed ${
              step === 3
                ? 'bg-[#121214] border border-zinc-800 text-zinc-100'
                : 'bg-transparent border border-transparent text-zinc-450 hover:text-zinc-200'
            }`}
          >
            <span>3. 流式正文扩写</span>
            <ArrowRight className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
          </button>
        </div>

        {/* Chapters selection grid */}
        <div className="flex-1 overflow-y-auto min-h-0 flex flex-col border-t border-zinc-900 pt-4 font-sans">
          <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest block mb-3 px-1 font-mono">
            已解析章节选择 ({parsedChapters.length})
          </label>
          
          {parsedChapters.length === 0 ? (
            <div className="text-center py-12 text-zinc-650 text-xs font-medium">
              没有已解析的章节。请先在解析库中进行章节的特征解析。
            </div>
          ) : (
            <div className="space-y-1 flex-1 overflow-y-auto pr-1">
              {parsedChapters.map((c) => {
                const isSelected = selectedChapterIds.includes(c.id);
                const novel = novels.find((n) => n.id === c.novelId);
                
                return (
                  <div
                    key={c.id}
                    onClick={() => handleToggleChapter(c.id)}
                    className={`p-2 rounded cursor-pointer transition-linear flex items-center gap-2.5 min-w-0 active-press ${
                      isSelected
                        ? 'bg-zinc-900 border border-zinc-850 text-zinc-100'
                        : 'bg-transparent border border-transparent hover:bg-zinc-900/40 text-zinc-400 hover:text-zinc-200'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => {}} // toggled by parent div onClick
                      className="accent-amber-500 flex-shrink-0 cursor-pointer h-3 w-3 rounded"
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
      <div className="lg:col-span-3 linear-card p-6 rounded flex flex-col bg-[#121214]/10 overflow-hidden min-h-[500px] lg:min-h-0">
        
        {/* Step 1: Input Prompts and Generate */}
        {step === 1 && (
          <div className="h-full flex flex-col gap-6 animate-fade-in font-sans">
            <div>
              <h2 className="text-sm font-semibold text-zinc-200">第一步：输入融合指令并生成大纲</h2>
              <p className="text-xs text-zinc-500 mt-0.5">从左侧勾选您想要融会贯通的小说章节，然后在下方给出扩写、冲突融合的指令方向。</p>
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-semibold text-zinc-400 uppercase tracking-widest font-mono flex items-center gap-2">
                <BookOpen className="w-3.5 h-3.5 text-zinc-500" />
                创意要求指令
              </label>
              <textarea
                value={fusionPrompt}
                onChange={(e) => setFusionPrompt(e.target.value)}
                placeholder="例如：将科幻世界观的‘纳米虫末日’设定，融入到修真世界的‘天道崩塌’大劫中。左侧主角A拥有的科学常识，与右侧主角B的纯阳道体产生剧烈碰撞，让他们在一场遗迹探险中不得不进行联手..."
                rows={6}
                className="w-full px-4 py-3 rounded bg-zinc-950 border border-zinc-850 text-xs text-zinc-205 placeholder-zinc-650 focus:outline-none focus:border-zinc-700 transition-linear leading-relaxed font-sans"
              />
            </div>

            {/* 角色交互深度绑定面板 (可选) */}
            {selectedChapterIds.length > 0 && availableCharacters.length >= 2 && (
              <div className="p-4 rounded border border-zinc-850 bg-zinc-950/20 space-y-3">
                <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
                  <label className="text-[10px] font-semibold text-zinc-300 uppercase tracking-widest font-mono flex items-center gap-2">
                    👥 出场角色互动配对规则 (可选)
                  </label>
                  <button
                    onClick={() => {
                      if (availableCharacters.length < 2) return;
                      setCharacterBindings((prev) => [
                        ...prev,
                        {
                          sourceChar: availableCharacters[0].name,
                          targetChar: availableCharacters[1].name,
                          bindingType: 'merge',
                          customDesc: '',
                        },
                      ]);
                    }}
                    className="px-2 py-1 bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-[10px] font-semibold rounded transition-linear active-press"
                  >
                    + 新建互动
                  </button>
                </div>

                {characterBindings.length === 0 ? (
                  <p className="text-[10px] text-zinc-550 italic font-mono">暂无指定配对。大模型将按默认逻辑自然编排人物行为与冲突。</p>
                ) : (
                  <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                    {characterBindings.map((binding, idx) => (
                      <div key={idx} className="flex flex-col sm:flex-row gap-2 items-center bg-zinc-950/40 p-2.5 rounded border border-zinc-900 text-xs animate-fade-in">
                        {/* Source Character */}
                        <select
                          value={binding.sourceChar}
                          onChange={(e) => {
                            const val = e.target.value;
                            setCharacterBindings((prev) =>
                              prev.map((b, i) => (i === idx ? { ...b, sourceChar: val } : b))
                            );
                          }}
                          className="w-full sm:w-1/3 px-2 py-1.5 rounded bg-zinc-900 border border-zinc-850 text-xs text-zinc-300 focus:outline-none"
                        >
                          {availableCharacters.map((c) => (
                            <option key={c.name} value={c.name} className="bg-[#121214]">
                              {c.name} ({c.novelName})
                            </option>
                          ))}
                        </select>

                        <span className="text-[10px] text-zinc-600 font-bold font-mono">⇄</span>

                        {/* Target Character */}
                        <select
                          value={binding.targetChar}
                          onChange={(e) => {
                            const val = e.target.value;
                            setCharacterBindings((prev) =>
                              prev.map((b, i) => (i === idx ? { ...b, targetChar: val } : b))
                            );
                          }}
                          className="w-full sm:w-1/3 px-2 py-1.5 rounded bg-zinc-900 border border-zinc-850 text-xs text-zinc-300 focus:outline-none"
                        >
                          {availableCharacters
                              .filter((c) => c.name !== binding.sourceChar)
                              .map((c) => (
                                <option key={c.name} value={c.name} className="bg-[#121214]">
                                  {c.name} ({c.novelName})
                                </option>
                              ))}
                        </select>

                        {/* Relationship Binding Type */}
                        <select
                          value={binding.bindingType}
                          onChange={(e) => {
                            const val = e.target.value as any;
                            setCharacterBindings((prev) =>
                              prev.map((b, i) => (i === idx ? { ...b, bindingType: val } : b))
                            );
                          }}
                          className="w-full sm:w-1/4 px-2 py-1.5 rounded bg-zinc-900 border border-zinc-850 text-xs text-zinc-300 focus:outline-none font-medium"
                        >
                          <option value="merge" className="bg-[#121214]">🧬 灵魂融合 (Merge)</option>
                          <option value="clash" className="bg-[#121214]">⚔️ 宿命对决 (Clash)</option>
                          <option value="mentor" className="bg-[#121214]">🎓 名师指点 (Mentor)</option>
                          <option value="custom" className="bg-[#121214]">⚙️ 自定义关系规则</option>
                        </select>

                        {/* Delete button */}
                        <button
                          onClick={() => {
                            setCharacterBindings((prev) => prev.filter((_, i) => i !== idx));
                          }}
                          className="p-1 text-zinc-500 hover:text-rose-400 hover:bg-rose-950/20 rounded transition-linear active-press ml-auto shrink-0"
                          title="删除绑定"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>

                        {/* Custom description row */}
                        {binding.bindingType === 'custom' && (
                          <div className="w-full mt-1.5 sm:col-span-4 animate-fade-in">
                            <input
                              type="text"
                              placeholder="输入指定关系（如：仙凡同修的眷侣、双重人格的主次关系等）..."
                              value={binding.customDesc || ''}
                              onChange={(e) => {
                                const val = e.target.value;
                                setCharacterBindings((prev) =>
                                  prev.map((b, i) => (i === idx ? { ...b, customDesc: val } : b))
                                );
                              }}
                              className="w-full px-2.5 py-1.5 rounded bg-zinc-900 border border-zinc-850 text-xs text-zinc-200 placeholder-zinc-650 focus:outline-none focus:border-zinc-700 transition-linear"
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <div className="p-4 rounded border border-zinc-850 bg-zinc-950/20 flex items-start gap-3">
              <HelpCircle className="w-4 h-4 text-zinc-500 flex-shrink-0 mt-0.5" />
              <div className="text-[11px] text-zinc-500 leading-relaxed">
                <p className="font-semibold text-zinc-400">大模型融合生成机制</p>
                <p className="mt-1">
                  AI 写作助手将深度检索您选择的多个章节，融合不同的时空、逻辑和人物关系。在流式生成大纲后，您可以无缝对大纲进行编辑修正，随后触发完整的正文长篇润色扩写。
                </p>
              </div>
            </div>

            <div className="mt-auto pt-4 flex justify-end">
              <button
                onClick={handleGenerateOutline}
                disabled={generatingOutline || selectedChapterIds.length === 0 || !fusionPrompt.trim()}
                className="py-2.5 px-5 rounded bg-zinc-100 hover:bg-zinc-200 text-zinc-950 font-semibold text-xs transition-linear active-press flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {generatingOutline ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    大纲流式生成中...
                  </>
                ) : (
                  <>
                    <BookOpen className="w-3.5 h-3.5" />
                    开始生成融合新大纲
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Step 2: Outline Edit View */}
        {step === 2 && (
          <div className="h-full flex flex-col gap-4 animate-fade-in font-sans">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-4 shrink-0">
              <div>
                <h2 className="text-sm font-semibold text-zinc-200">第二步：大纲及故事架构调整</h2>
                <p className="text-xs text-zinc-500 mt-0.5">您可以直接在此处内联编辑、重写大纲内容，确保故事走向完全符合预期。</p>
              </div>
              
              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => handleCopy(outline, false)}
                  className="px-2.5 py-1.5 bg-zinc-950 border border-zinc-850 hover:border-zinc-700 rounded text-zinc-400 hover:text-zinc-200 transition-linear flex items-center gap-1.5 text-xs font-semibold active-press"
                >
                  {copiedOutline ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-500" />}
                  {copiedOutline ? '已复制' : '复制大纲'}
                </button>

                <button
                  onClick={() => setStep(1)}
                  className="px-2.5 py-1.5 bg-zinc-950 border border-zinc-850 hover:border-zinc-700 rounded text-zinc-400 hover:text-zinc-200 transition-linear flex items-center gap-1.5 text-xs font-semibold active-press"
                >
                  <RotateCcw className="w-3.5 h-3.5 text-zinc-500" />
                  上一步
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-[300px] flex flex-col">
              {generatingOutline && !outline && (
                <div className="flex-1 flex flex-col items-center justify-center text-center">
                  <Loader2 className="w-6 h-6 text-zinc-500 animate-spin mb-3" />
                  <p className="text-xs font-semibold text-zinc-550">正在连接大模型流式渲染大纲...</p>
                </div>
              )}
              
              <textarea
                value={outline}
                onChange={(e) => setOutline(e.target.value)}
                placeholder="此处大纲正在流式生成或为空。请点击上一步生成大纲..."
                className="w-full flex-1 p-4 rounded bg-zinc-950/60 border border-zinc-850 text-zinc-200 font-mono text-xs leading-relaxed focus:outline-none focus:border-zinc-700 transition-linear resize-none"
              />
            </div>

            <div className="flex justify-end pt-3 shrink-0">
              <button
                onClick={handleGenerateText}
                disabled={generatingText || !outline.trim() || generatingOutline}
                className="py-2.5 px-5 rounded bg-zinc-100 hover:bg-zinc-200 text-zinc-950 font-semibold text-xs transition-linear active-press flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {generatingText ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    流式正文扩写中...
                  </>
                ) : (
                  <>
                    <PenTool className="w-3.5 h-3.5 animate-pulse" />
                    确认并一键扩写正文
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Stream Novel Text view */}
        {step === 3 && (
          <div className="h-full flex flex-col gap-4 animate-fade-in font-sans">
            <div className="flex items-center justify-between border-b border-zinc-900 pb-4 shrink-0">
              <div>
                <h2 className="text-sm font-semibold text-zinc-200">第三步：大模型流式小说写作</h2>
                <p className="text-xs text-zinc-500 mt-0.5">大语言模型白金主笔已启动，正在结合融合大纲为您渲染故事正文。</p>
              </div>

              <div className="flex gap-2 shrink-0">
                <button
                  onClick={() => handleCopy(novelText, true)}
                  disabled={!novelText}
                  className="px-2.5 py-1.5 bg-zinc-950 border border-zinc-850 hover:border-zinc-700 rounded text-zinc-400 hover:text-zinc-200 transition-linear flex items-center gap-1.5 text-xs font-semibold active-press disabled:opacity-40"
                >
                  {copiedText ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5 text-zinc-500" />}
                  {copiedText ? '已复制' : '复制正文'}
                </button>

                <button
                  onClick={() => handleDownload(novelText, "融合章节正文.txt")}
                  disabled={!novelText}
                  className="px-2.5 py-1.5 bg-zinc-950 border border-zinc-850 hover:border-zinc-700 rounded text-zinc-400 hover:text-zinc-200 transition-linear flex items-center gap-1.5 text-xs font-semibold active-press disabled:opacity-40"
                >
                  <FileDown className="w-3.5 h-3.5 text-zinc-500" />
                  导出 TXT
                </button>
              </div>
            </div>

            <div className="flex-1 min-h-[350px] flex flex-col bg-zinc-950/40 border border-zinc-850 rounded p-6 overflow-hidden">
              {generatingText && !novelText && (
                <div className="flex-1 flex flex-col items-center justify-center text-center">
                  <Loader2 className="w-6 h-6 text-zinc-500 animate-spin mb-3" />
                  <p className="text-xs font-semibold text-zinc-550">AI 正在构思场景、刻画心理特征与铺设故事线，请稍等...</p>
                </div>
              )}

              <div className="flex-1 overflow-y-auto max-h-[500px] text-zinc-200 text-xs leading-loose tracking-wide whitespace-pre-wrap font-sans px-2">
                {novelText || (
                  <div className="text-zinc-650 italic text-center py-20 font-sans text-xs">大纲正文尚为空。请返回上一步确认并生成。</div>
                )}
              </div>
            </div>

            <div className="flex justify-between items-center pt-3 shrink-0">
              <button
                onClick={() => setStep(2)}
                className="py-2 px-3 rounded bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 transition-linear text-xs font-semibold active-press animate-fade-in"
              >
                返回修改大纲
              </button>

              {generatingText && (
                <div className="text-[10px] text-zinc-500 animate-pulse font-mono flex items-center gap-2">
                  <Loader2 className="w-3 h-3 animate-spin text-zinc-550 shrink-0" />
                  章节正文流式输出中...
                </div>
              )}
            </div>
          </div>
        )}

      </div>

    </div>
  );
}
