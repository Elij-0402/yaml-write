import React, { useState, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel, type Chapter, type Character, type Relationship, type ChapterAnalysis } from '../app/db';
import { BookOpen, HelpCircle, Edit3, Check, Globe, GitCommit, Users, Heart, MessageSquare, Trash, Plus, X } from 'lucide-react';

export default function ContrastBoard() {
  const novels = useLiveQuery<Novel[]>(() => db.novels.reverse().toArray(), []) || [];
  
  // States for Left and Right selections
  const [leftNovelId, setLeftNovelId] = useState<string>('');
  const [leftChapterId, setLeftChapterId] = useState<string>('');
  const [rightNovelId, setRightNovelId] = useState<string>('');
  const [rightChapterId, setRightChapterId] = useState<string>('');

  // Fetch chapters for selected novels
  const leftChapters = useLiveQuery<Chapter[]>(() => {
    if (!leftNovelId) return [];
    return db.chapters.where('novelId').equals(leftNovelId).sortBy('chapterIndex');
  }, [leftNovelId]) || [];

  const rightChapters = useLiveQuery<Chapter[]>(() => {
    if (!rightNovelId) return [];
    return db.chapters.where('novelId').equals(rightNovelId).sortBy('chapterIndex');
  }, [rightNovelId]) || [];

  // Active loaded chapters
  const leftChapter = useLiveQuery<Chapter | undefined>(() => {
    if (!leftChapterId) return undefined;
    return db.chapters.get(leftChapterId);
  }, [leftChapterId]);

  const rightChapter = useLiveQuery<Chapter | undefined>(() => {
    if (!rightChapterId) return undefined;
    return db.chapters.get(rightChapterId);
  }, [rightChapterId]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-auto min-h-0 flex-1">
      {/* Left Column Comparison Panel */}
      <ComparisonColumn
        side="A"
        novels={novels}
        novelId={leftNovelId}
        setNovelId={(id) => { setLeftNovelId(id); setLeftChapterId(''); }}
        chapters={leftChapters}
        chapterId={leftChapterId}
        setChapterId={setLeftChapterId}
        chapter={leftChapter}
      />

      {/* Right Column Comparison Panel */}
      <ComparisonColumn
        side="B"
        novels={novels}
        novelId={rightNovelId}
        setNovelId={(id) => { setRightNovelId(id); setRightChapterId(''); }}
        chapters={rightChapters}
        chapterId={rightChapterId}
        setChapterId={setRightChapterId}
        chapter={rightChapter}
      />
    </div>
  );
}

interface ColumnProps {
  side: string;
  novels: Novel[];
  novelId: string;
  setNovelId: (id: string) => void;
  chapters: Chapter[];
  chapterId: string;
  setChapterId: (id: string) => void;
  chapter: Chapter | undefined;
}

function ComparisonColumn({ side, novels, novelId, setNovelId, chapters, chapterId, setChapterId, chapter }: ColumnProps) {
  const [editingField, setEditingField] = useState<string | null>(null); // e.g. 'worldview', 'plotSkeleton', 'style', 'char-0-name', 'rel-0-description'
  const [editValue, setEditValue] = useState<string>('');
  const blurTimeoutRef = useRef<number | null>(null);

  const handleNovelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setNovelId(e.target.value);
  };

  const handleChapterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setChapterId(e.target.value);
  };

  const startEditing = (field: string, initialVal: string) => {
    if (blurTimeoutRef.current) window.clearTimeout(blurTimeoutRef.current);
    setEditingField(field);
    setEditValue(initialVal);
  };

  const saveEdit = async (forcedValue?: string) => {
    if (!chapter || !chapter.analysis) return;
    const finalVal = typeof forcedValue === 'string' ? forcedValue : editValue;

    const analysis = { ...chapter.analysis };

    if (editingField === 'worldview') {
      analysis.worldview = finalVal;
    } else if (editingField === 'plotSkeleton') {
      analysis.plotSkeleton = finalVal;
    } else if (editingField === 'style') {
      analysis.style = finalVal;
    } else if (editingField?.startsWith('char-')) {
      const parts = editingField.split('-');
      const charIdx = parseInt(parts[1]);
      const fieldName = parts[2]; // name, personality, appearance, coreConflict, chapters
      
      const char = analysis.characters[charIdx];
      if (char) {
        (char as any)[fieldName] = finalVal;
      }
    } else if (editingField?.startsWith('rel-')) {
      const parts = editingField.split('-');
      const relIdx = parseInt(parts[1]);
      const fieldName = parts[2]; // roleA, roleB, description
      
      const rel = analysis.relationships[relIdx];
      if (rel) {
        (rel as any)[fieldName] = finalVal;
      }
    }

    await db.chapters.update(chapter.id, { analysis });
    setEditingField(null);
  };

  const handleBlur = () => {
    // Timeout gives buttons time to register click before blur triggers
    blurTimeoutRef.current = window.setTimeout(() => {
      void saveEdit();
    }, 150);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey && !editingField?.includes('worldview') && !editingField?.includes('plotSkeleton')) {
      e.preventDefault();
      void saveEdit();
    } else if (e.key === 'Escape') {
      setEditingField(null);
    }
  };

  // Add character
  const addCharacter = async () => {
    if (!chapter || !chapter.analysis) return;
    const analysis = { ...chapter.analysis };
    analysis.characters.push({
      name: '新角色',
      personality: '待描述性格',
      appearance: '待描述外貌',
      coreConflict: '内在冲突设定',
      chapters: String(chapter.chapterIndex)
    });
    await db.chapters.update(chapter.id, { analysis });
  };

  // Delete character
  const deleteCharacter = async (idx: number) => {
    if (!chapter || !chapter.analysis) return;
    const analysis = { ...chapter.analysis };
    analysis.characters.splice(idx, 1);
    await db.chapters.update(chapter.id, { analysis });
  };

  // Add relationship
  const addRelationship = async () => {
    if (!chapter || !chapter.analysis) return;
    const analysis = { ...chapter.analysis };
    analysis.relationships.push({
      roleA: '主角',
      roleB: '配角',
      description: '描述彼此的核心纽带'
    });
    await db.chapters.update(chapter.id, { analysis });
  };

  // Delete relationship
  const deleteRelationship = async (idx: number) => {
    if (!chapter || !chapter.analysis) return;
    const analysis = { ...chapter.analysis };
    analysis.relationships.splice(idx, 1);
    await db.chapters.update(chapter.id, { analysis });
  };

  return (
    <div className="linear-card p-6 rounded flex flex-col min-h-[500px] lg:min-h-0 lg:h-full bg-[#121214]/20 overflow-hidden">
      
      {/* Selectors Header */}
      <div className="flex flex-col sm:flex-row gap-4 pb-5 border-b border-zinc-900 shrink-0">
        <div className="flex-1">
          <label className="text-[10px] text-zinc-550 font-semibold uppercase tracking-widest font-mono block mb-1.5">对比栏 {side} · 选择小说</label>
          <select
            value={novelId}
            onChange={handleNovelChange}
            className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-zinc-700 transition-linear cursor-pointer"
          >
            <option value="" className="bg-[#121214] text-zinc-500">-- 选择对比小说 --</option>
            {novels.map((n) => (
              <option key={n.id} value={n.id} className="bg-[#121214] text-zinc-200">{n.name}</option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <label className="text-[10px] text-zinc-550 font-semibold uppercase tracking-widest font-mono block mb-1.5">选择已解析章节</label>
          <select
            value={chapterId}
            onChange={handleChapterChange}
            disabled={!novelId}
            className="w-full px-3 py-2 rounded bg-zinc-900 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-zinc-700 transition-linear cursor-pointer disabled:opacity-40"
          >
            <option value="" className="bg-[#121214] text-zinc-500">-- 选择对比章节 --</option>
            {chapters.map((c) => (
              <option key={c.id} value={c.id} className="bg-[#121214] text-zinc-200">
                {c.name} {c.status === 'done' ? '(已解析)' : '(未解析)'}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto mt-5 space-y-6 pr-1">
        {!chapterId ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-24">
            <div className="p-3 rounded bg-zinc-900/60 border border-zinc-850 text-zinc-500 mb-4 animate-pulse">
              <HelpCircle className="w-6 h-6 text-zinc-400" />
            </div>
            <p className="text-xs font-semibold text-zinc-450">对比栏 {side} 为空</p>
            <p className="text-[11px] text-zinc-600 mt-2 max-w-[280px] leading-relaxed">
              请在上方选择小说及其已成功解析的章节，您将可以并行审查两份大纲与角色体系。
            </p>
          </div>
        ) : chapter?.status !== 'done' ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-24">
            <div className="p-3 rounded bg-zinc-900/60 border border-zinc-850 text-zinc-500 mb-4">
              <HelpCircle className="w-6 h-6 text-zinc-400" />
            </div>
            <p className="text-xs font-semibold text-zinc-450">当前章节尚未结构化解析</p>
            <p className="text-[11px] text-zinc-550 mt-2 max-w-[280px] leading-relaxed">
              此章节正文已载入，但尚未完成结构分析。请前往 <span className="text-zinc-350 underline">导入与解析库</span> 并执行解析。
            </p>
          </div>
        ) : (
          /* Render parsed cards - Editable */
          <div className="space-y-6 pb-6 animate-fade-in font-sans">
            
            {/* 1. Worldview Setting */}
            <div className="p-4 rounded border border-zinc-850 bg-[#121214]/40 hover:border-zinc-800 transition-linear group relative">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-[10px] font-semibold text-zinc-400 flex items-center gap-2 uppercase tracking-widest font-mono">
                  <Globe className="w-3.5 h-3.5 text-zinc-500" />
                  世界观与背景设定
                </h4>
                {editingField !== 'worldview' && (
                  <button
                    onClick={() => startEditing('worldview', chapter.analysis?.worldview || '')}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-900 text-zinc-500 hover:text-zinc-300 transition-linear active-press"
                  >
                    <Edit3 className="w-3 h-3" />
                  </button>
                )}
              </div>
              
              {editingField === 'worldview' ? (
                <div className="space-y-2 animate-fade-in">
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    autoFocus
                    rows={5}
                    className="w-full px-3 py-2 rounded bg-zinc-950 border border-zinc-800 focus:border-zinc-700 text-xs text-zinc-200 focus:outline-none transition-linear leading-relaxed"
                  />
                  <div className="flex justify-end gap-2 shrink-0">
                    <button 
                      onClick={() => setEditingField(null)} 
                      className="px-2.5 py-1 bg-zinc-900 border border-zinc-800 text-zinc-400 rounded text-[10px] font-semibold active-press"
                    >
                      取消
                    </button>
                    <button 
                      onClick={() => void saveEdit()} 
                      className="px-2.5 py-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-950 rounded text-[10px] font-bold flex items-center gap-1 active-press"
                    >
                      <Check className="w-3 h-3" />保存
                    </button>
                  </div>
                </div>
              ) : (
                <div 
                  onClick={() => startEditing('worldview', chapter.analysis?.worldview || '')}
                  className="text-xs text-zinc-350 leading-relaxed whitespace-pre-wrap cursor-pointer hover:text-zinc-200 transition-linear p-2 rounded bg-zinc-950/10 border border-transparent hover:border-zinc-900"
                >
                  {chapter.analysis?.worldview || '暂无世界观设定。点击此处即可内联编辑...'}
                </div>
              )}
            </div>

            {/* 2. Plot Skeleton */}
            <div className="p-4 rounded border border-zinc-850 bg-[#121214]/40 hover:border-zinc-800 transition-linear group relative">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-[10px] font-semibold text-zinc-400 flex items-center gap-2 uppercase tracking-widest font-mono">
                  <GitCommit className="w-3.5 h-3.5 text-zinc-500" />
                  核心故事剧情骨架
                </h4>
                {editingField !== 'plotSkeleton' && (
                  <button
                    onClick={() => startEditing('plotSkeleton', chapter.analysis?.plotSkeleton || '')}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-900 text-zinc-500 hover:text-zinc-300 transition-linear active-press"
                  >
                    <Edit3 className="w-3 h-3" />
                  </button>
                )}
              </div>
              
              {editingField === 'plotSkeleton' ? (
                <div className="space-y-2 animate-fade-in">
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    autoFocus
                    rows={5}
                    className="w-full px-3 py-2 rounded bg-zinc-950 border border-zinc-800 focus:border-zinc-700 text-xs text-zinc-200 focus:outline-none transition-linear leading-relaxed"
                  />
                  <div className="flex justify-end gap-2 shrink-0">
                    <button 
                      onClick={() => setEditingField(null)} 
                      className="px-2.5 py-1 bg-zinc-900 border border-zinc-800 text-zinc-400 rounded text-[10px] font-semibold active-press"
                    >
                      取消
                    </button>
                    <button 
                      onClick={() => void saveEdit()} 
                      className="px-2.5 py-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-950 rounded text-[10px] font-bold flex items-center gap-1 active-press"
                    >
                      <Check className="w-3 h-3" />保存
                    </button>
                  </div>
                </div>
              ) : (
                <div 
                  onClick={() => startEditing('plotSkeleton', chapter.analysis?.plotSkeleton || '')}
                  className="text-xs text-zinc-350 leading-relaxed whitespace-pre-wrap cursor-pointer hover:text-zinc-200 transition-linear p-2 rounded bg-zinc-950/10 border border-transparent hover:border-zinc-900"
                >
                  {chapter.analysis?.plotSkeleton || '暂无剧情剧情架构。点击此处即可内联编辑...'}
                </div>
              )}
            </div>

            {/* 3. Style & Tone */}
            <div className="p-4 rounded border border-zinc-850 bg-[#121214]/40 hover:border-zinc-800 transition-linear group relative">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-[10px] font-semibold text-zinc-400 flex items-center gap-2 uppercase tracking-widest font-mono">
                  <MessageSquare className="w-3.5 h-3.5 text-zinc-500" />
                  语言叙事风格与基调
                </h4>
                {editingField !== 'style' && (
                  <button
                    onClick={() => startEditing('style', chapter.analysis?.style || '')}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-900 text-zinc-500 hover:text-zinc-300 transition-linear active-press"
                  >
                    <Edit3 className="w-3 h-3" />
                  </button>
                )}
              </div>
              
              {editingField === 'style' ? (
                <div className="space-y-2 animate-fade-in">
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    onBlur={handleBlur}
                    onKeyDown={handleKeyDown}
                    autoFocus
                    rows={3}
                    className="w-full px-3 py-2 rounded bg-zinc-950 border border-zinc-800 focus:border-zinc-700 text-xs text-zinc-200 focus:outline-none transition-linear leading-relaxed"
                  />
                  <div className="flex justify-end gap-2 shrink-0">
                    <button 
                      onClick={() => setEditingField(null)} 
                      className="px-2.5 py-1 bg-zinc-900 border border-zinc-800 text-zinc-400 rounded text-[10px] font-semibold active-press"
                    >
                      取消
                    </button>
                    <button 
                      onClick={() => void saveEdit()} 
                      className="px-2.5 py-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-950 rounded text-[10px] font-bold flex items-center gap-1 active-press"
                    >
                      <Check className="w-3 h-3" />保存
                    </button>
                  </div>
                </div>
              ) : (
                <div 
                  onClick={() => startEditing('style', chapter.analysis?.style || '')}
                  className="text-xs text-zinc-350 leading-relaxed cursor-pointer hover:text-zinc-200 transition-linear p-2 rounded bg-zinc-950/10 border border-transparent hover:border-zinc-900"
                >
                  {chapter.analysis?.style || '暂无特征提取。点击此处即可内联编辑...'}
                </div>
              )}
            </div>

            {/* 4. Characters Cards */}
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
                <h4 className="text-[10px] font-semibold text-zinc-400 flex items-center gap-2 uppercase tracking-widest font-mono">
                  <Users className="w-3.5 h-3.5 text-zinc-550" />
                  出场角色设定列表
                </h4>
                <button
                  onClick={addCharacter}
                  className="py-1 px-2.5 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 text-[10px] font-semibold rounded transition-linear active-press"
                >
                  + 新增角色
                </button>
              </div>

              <div className="space-y-3">
                {chapter.analysis?.characters.map((char, charIdx) => (
                  <div key={charIdx} className="p-4 rounded border border-zinc-850 bg-[#121214]/20 relative group/char hover:border-zinc-800 transition-linear">
                    
                    <button
                      onClick={() => deleteCharacter(charIdx)}
                      className="absolute top-3 right-3 opacity-0 group-hover/char:opacity-100 p-1 text-zinc-500 hover:text-rose-400 hover:bg-rose-950/20 rounded transition-linear active-press"
                      title="删除角色"
                    >
                      <Trash className="w-3.5 h-3.5" />
                    </button>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                      
                      {/* Name */}
                      <div className="sm:col-span-2 flex flex-col">
                        <label className="text-[9px] text-zinc-550 font-bold uppercase tracking-wider mb-1 font-mono">角色姓名</label>
                        {editingField === `char-${charIdx}-name` ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-zinc-750 transition-linear"
                          />
                        ) : (
                          <span 
                            onClick={() => startEditing(`char-${charIdx}-name`, char.name)}
                            className="text-xs font-bold text-zinc-200 border-b border-dashed border-transparent hover:border-zinc-700 cursor-pointer self-start transition-linear"
                          >
                            {char.name}
                          </span>
                        )}
                      </div>

                      {/* Personality */}
                      <div className="flex flex-col">
                        <label className="text-[9px] text-zinc-550 font-bold uppercase tracking-wider mb-1 font-mono">性格特征</label>
                        {editingField === `char-${charIdx}-personality` ? (
                          <textarea
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            rows={2}
                            className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-zinc-750 transition-linear"
                          />
                        ) : (
                          <p 
                            onClick={() => startEditing(`char-${charIdx}-personality`, char.personality)}
                            className="text-[11px] text-zinc-400 border-b border-dashed border-transparent hover:border-zinc-800 cursor-pointer min-h-[1.5rem] leading-relaxed transition-linear"
                          >
                            {char.personality}
                          </p>
                        )}
                      </div>

                      {/* Appearance */}
                      <div className="flex flex-col">
                        <label className="text-[9px] text-zinc-550 font-bold uppercase tracking-wider mb-1 font-mono">外貌描绘</label>
                        {editingField === `char-${charIdx}-appearance` ? (
                          <textarea
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            rows={2}
                            className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-zinc-750 transition-linear"
                          />
                        ) : (
                          <p 
                            onClick={() => startEditing(`char-${charIdx}-appearance`, char.appearance)}
                            className="text-[11px] text-zinc-400 border-b border-dashed border-transparent hover:border-zinc-800 cursor-pointer min-h-[1.5rem] leading-relaxed transition-linear"
                          >
                            {char.appearance}
                          </p>
                        )}
                      </div>

                      {/* Conflict */}
                      <div className="flex flex-col">
                        <label className="text-[9px] text-zinc-550 font-bold uppercase tracking-wider mb-1 font-mono">核心矛盾与信念</label>
                        {editingField === `char-${charIdx}-coreConflict` ? (
                          <textarea
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            rows={2}
                            className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-zinc-750 transition-linear"
                          />
                        ) : (
                          <p 
                            onClick={() => startEditing(`char-${charIdx}-coreConflict`, char.coreConflict)}
                            className="text-[11px] text-zinc-400 border-b border-dashed border-transparent hover:border-zinc-800 cursor-pointer min-h-[1.5rem] leading-relaxed transition-linear"
                          >
                            {char.coreConflict}
                          </p>
                        )}
                      </div>

                      {/* Chapters */}
                      <div className="flex flex-col">
                        <label className="text-[9px] text-zinc-550 font-bold uppercase tracking-wider mb-1 font-mono">出场频次章节</label>
                        {editingField === `char-${charIdx}-chapters` ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-zinc-750 transition-linear"
                          />
                        ) : (
                          <p 
                            onClick={() => startEditing(`char-${charIdx}-chapters`, char.chapters)}
                            className="text-[11px] text-zinc-400 border-b border-dashed border-transparent hover:border-zinc-800 cursor-pointer min-h-[1.5rem] font-mono transition-linear"
                          >
                            {char.chapters}
                          </p>
                        )}
                      </div>

                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* 5. Relationship Network */}
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-zinc-900 pb-2">
                <h4 className="text-[10px] font-semibold text-zinc-400 flex items-center gap-2 uppercase tracking-widest font-mono">
                  <Heart className="w-3.5 h-3.5 text-zinc-550" />
                  人物角色关系网络
                </h4>
                <button
                  onClick={addRelationship}
                  className="py-1 px-2.5 bg-zinc-900 border border-zinc-800 hover:bg-zinc-800 text-zinc-300 text-[10px] font-semibold rounded transition-linear active-press"
                >
                  + 新增关系
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {chapter.analysis?.relationships.map((rel, relIdx) => (
                  <div key={relIdx} className="p-3.5 rounded border border-zinc-850 bg-[#121214]/20 relative group/rel hover:border-zinc-800 transition-linear">
                    
                    <button
                      onClick={() => deleteRelationship(relIdx)}
                      className="absolute top-2 right-2 opacity-0 group-hover/rel:opacity-100 p-1 text-zinc-550 hover:text-rose-400 hover:bg-rose-950/20 rounded transition-linear active-press"
                      title="删除关系"
                    >
                      <Trash className="w-3.5 h-3.5" />
                    </button>

                    <div className="space-y-2">
                      <div className="flex items-center gap-1.5">
                        {/* Role A */}
                        {editingField === `rel-${relIdx}-roleA` ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            className="w-20 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none"
                          />
                        ) : (
                          <span 
                            onClick={() => startEditing(`rel-${relIdx}-roleA`, rel.roleA)}
                            className="text-xs font-bold text-zinc-350 cursor-pointer border-b border-dashed border-transparent hover:border-zinc-700 transition-linear"
                          >
                            {rel.roleA}
                          </span>
                        )}
                        
                        <span className="text-[10px] text-zinc-650 font-mono">⇄</span>

                        {/* Role B */}
                        {editingField === `rel-${relIdx}-roleB` ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            className="w-20 px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none"
                          />
                        ) : (
                          <span 
                            onClick={() => startEditing(`rel-${relIdx}-roleB`, rel.roleB)}
                            className="text-xs font-bold text-zinc-350 cursor-pointer border-b border-dashed border-transparent hover:border-zinc-700 transition-linear"
                          >
                            {rel.roleB}
                          </span>
                        )}
                      </div>

                      {/* Description */}
                      <div className="flex flex-col">
                        {editingField === `rel-${relIdx}-description` ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={handleBlur}
                            onKeyDown={handleKeyDown}
                            autoFocus
                            className="w-full px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 focus:outline-none focus:border-zinc-700 transition-linear"
                          />
                        ) : (
                          <p 
                            onClick={() => startEditing(`rel-${relIdx}-description`, rel.description)}
                            className="text-xs text-zinc-400 leading-relaxed cursor-pointer border-b border-dashed border-transparent hover:border-zinc-800 min-h-[1.25rem] transition-linear"
                          >
                            {rel.description}
                          </p>
                        )}
                      </div>

                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>
        )}
      </div>

    </div>
  );
}
