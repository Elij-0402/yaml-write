import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, type Novel, type Chapter, type Character, type Relationship, type ChapterAnalysis } from '../app/db';
import { BookOpen, HelpCircle, Edit3, Check, Globe, GitCommit, Users, Heart, MessageSquare, Trash } from 'lucide-react';

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
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-auto lg:h-[calc(100vh-12rem)] overflow-y-auto lg:overflow-visible min-h-0 pr-1">
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

  const handleNovelChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setNovelId(e.target.value);
  };

  const handleChapterChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setChapterId(e.target.value);
  };

  const startEditing = (field: string, initialVal: string) => {
    setEditingField(field);
    setEditValue(initialVal);
  };

  const saveEdit = async () => {
    if (!chapter || !chapter.analysis) return;

    const analysis = { ...chapter.analysis };

    if (editingField === 'worldview') {
      analysis.worldview = editValue;
    } else if (editingField === 'plotSkeleton') {
      analysis.plotSkeleton = editValue;
    } else if (editingField === 'style') {
      analysis.style = editValue;
    } else if (editingField?.startsWith('char-')) {
      const parts = editingField.split('-');
      const charIdx = parseInt(parts[1]);
      const fieldName = parts[2]; // name, personality, appearance, coreConflict, chapters
      
      const char = analysis.characters[charIdx];
      if (char) {
        (char as any)[fieldName] = editValue;
      }
    } else if (editingField?.startsWith('rel-')) {
      const parts = editingField.split('-');
      const relIdx = parseInt(parts[1]);
      const fieldName = parts[2]; // roleA, roleB, description
      
      const rel = analysis.relationships[relIdx];
      if (rel) {
        (rel as any)[fieldName] = editValue;
      }
    }

    await db.chapters.update(chapter.id, { analysis });
    setEditingField(null);
  };

  // Add character
  const addCharacter = async () => {
    if (!chapter || !chapter.analysis) return;
    const analysis = { ...chapter.analysis };
    analysis.characters.push({
      name: '新角色',
      personality: '待描述性格',
      appearance: '待描述外貌',
      coreConflict: '内在冲突',
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
      roleA: '角色A',
      roleB: '角色B',
      description: '描述彼此关系'
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
    <div className="bg-zinc-900/20 border border-zinc-800/80 rounded-2xl p-6 flex flex-col shadow-xl min-h-[500px] lg:min-h-0 lg:h-full">
      {/* Selectors Header */}
      <div className="flex flex-col sm:flex-row gap-3 pb-5 border-b border-zinc-800">
        <div className="flex-1">
          <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block mb-1">对比栏 {side} - 选择小说</label>
          <select
            value={novelId}
            onChange={handleNovelChange}
            className="w-full px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-700"
          >
            <option value="">-- 选择小说 --</option>
            {novels.map((n) => (
              <option key={n.id} value={n.id}>{n.name}</option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <label className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block mb-1">选择已解析章节</label>
          <select
            value={chapterId}
            onChange={handleChapterChange}
            disabled={!novelId}
            className="w-full px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 text-sm text-zinc-200 focus:outline-none focus:ring-1 focus:ring-zinc-700 disabled:opacity-40"
          >
            <option value="">-- 选择章节 --</option>
            {chapters.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} {c.status === 'done' ? '(已解析)' : '(未解析)'}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto mt-5 space-y-6 pr-1">
        {!chapterId ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-20">
            <HelpCircle className="w-10 h-10 text-zinc-650 mb-3 animate-pulse" />
            <p className="text-sm font-semibold text-zinc-400">请先在上方选择小说与对应章节</p>
            <p className="text-xs text-zinc-600 mt-1 max-w-xs">通过并排对比不同的故事架构与角色关系，能帮助你碰撞出全新的融合火花。</p>
          </div>
        ) : chapter?.status !== 'done' ? (
          <div className="h-full flex flex-col items-center justify-center text-center py-20">
            <HelpCircle className="w-10 h-10 text-zinc-500 mb-3" />
            <p className="text-sm font-semibold text-zinc-400">该章节尚未成功解析</p>
            <p className="text-xs text-zinc-500 mt-2 max-w-xs leading-relaxed">
              请前往 <span className="text-zinc-300 underline font-semibold">导入与解析</span> 模块中，点击“开始解析”让大模型提取该章节的结构化特征。
            </p>
          </div>
        ) : (
          /* Render parsed cards - Editable */
          <div className="space-y-6">
            
            {/* 1. Worldview Setting */}
            <div className="p-4 rounded-xl bg-zinc-950/30 border border-zinc-800 hover:border-zinc-700 transition-all shadow-md group relative">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-zinc-300 flex items-center gap-1.5 uppercase tracking-wider">
                  <Globe className="w-3.5 h-3.5" />
                  世界观与背景设定
                </h4>
                {editingField !== 'worldview' && (
                  <button
                    onClick={() => startEditing('worldview', chapter.analysis?.worldview || '')}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-800 text-zinc-550 hover:text-zinc-300 transition-all"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              
              {editingField === 'worldview' ? (
                <div className="space-y-2">
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs text-white focus:outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setEditingField(null)} className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-lg text-xs">取消</button>
                    <button onClick={saveEdit} className="px-2.5 py-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded-lg text-xs flex items-center gap-1"><Check className="w-3 h-3" />保存</button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-zinc-350 leading-relaxed whitespace-pre-wrap">
                  {chapter.analysis?.worldview || '暂无世界观设定提取。'}
                </p>
              )}
            </div>

            {/* 2. Plot Skeleton */}
            <div className="p-4 rounded-xl bg-zinc-950/30 border border-zinc-800 hover:border-zinc-700 transition-all shadow-md group relative">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-zinc-300 flex items-center gap-1.5 uppercase tracking-wider">
                  <GitCommit className="w-3.5 h-3.5" />
                  核心故事剧情骨架
                </h4>
                {editingField !== 'plotSkeleton' && (
                  <button
                    onClick={() => startEditing('plotSkeleton', chapter.analysis?.plotSkeleton || '')}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-800 text-zinc-550 hover:text-zinc-300 transition-all"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              
              {editingField === 'plotSkeleton' ? (
                <div className="space-y-2">
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs text-white focus:outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setEditingField(null)} className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-lg text-xs">取消</button>
                    <button onClick={saveEdit} className="px-2.5 py-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded-lg text-xs flex items-center gap-1"><Check className="w-3 h-3" />保存</button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-zinc-350 leading-relaxed whitespace-pre-wrap">
                  {chapter.analysis?.plotSkeleton || '暂无剧情骨架提取。'}
                </p>
              )}
            </div>

            {/* 3. Style & Tone */}
            <div className="p-4 rounded-xl bg-zinc-950/30 border border-zinc-800 hover:border-zinc-700 transition-all shadow-md group relative">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-bold text-zinc-300 flex items-center gap-1.5 uppercase tracking-wider">
                  <MessageSquare className="w-3.5 h-3.5" />
                  语言叙事风格与基调
                </h4>
                {editingField !== 'style' && (
                  <button
                    onClick={() => startEditing('style', chapter.analysis?.style || '')}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-zinc-800 text-zinc-550 hover:text-zinc-300 transition-all"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              
              {editingField === 'style' ? (
                <div className="space-y-2">
                  <textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    rows={2}
                    className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-700 text-xs text-white focus:outline-none"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => setEditingField(null)} className="px-2.5 py-1 bg-zinc-800 hover:bg-zinc-700 text-zinc-400 rounded-lg text-xs">取消</button>
                    <button onClick={saveEdit} className="px-2.5 py-1 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded-lg text-xs flex items-center gap-1"><Check className="w-3 h-3" />保存</button>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-zinc-350 leading-relaxed">
                  {chapter.analysis?.style || '暂无叙事风格提取。'}
                </p>
              )}
            </div>

            {/* 4. Characters Cards */}
            <div className="space-y-3">
              <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                <h4 className="text-xs font-bold text-zinc-300 flex items-center gap-1.5 uppercase tracking-wider">
                  <Users className="w-3.5 h-3.5 text-zinc-450" />
                  出场角色设定列表
                </h4>
                <button
                  onClick={addCharacter}
                  className="py-1 px-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[10px] font-semibold border border-zinc-800 rounded transition-all"
                >
                  + 新增角色
                </button>
              </div>

              <div className="space-y-4">
                {chapter.analysis?.characters.map((char, charIdx) => (
                  <div key={charIdx} className="p-4 rounded-xl bg-zinc-900/40 border border-zinc-800 relative group/char hover:border-zinc-700 transition-all">
                    
                    <button
                      onClick={() => deleteCharacter(charIdx)}
                      className="absolute top-3 right-3 opacity-0 group-hover/char:opacity-100 p-1 text-zinc-550 hover:text-red-400 hover:bg-red-500/10 rounded transition-all"
                    >
                      <Trash className="w-3.5 h-3.5" />
                    </button>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                      {/* Name */}
                      <div className="sm:col-span-2">
                        <label className="text-[10px] text-zinc-550 font-bold block mb-1">姓名</label>
                        {editingField === `char-${charIdx}-name` ? (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              className="flex-1 px-2.5 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs text-white"
                            />
                            <button onClick={saveEdit} className="p-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded"><Check className="w-3.5 h-3.5" /></button>
                          </div>
                        ) : (
                          <span 
                            onClick={() => startEditing(`char-${charIdx}-name`, char.name)}
                            className="text-sm font-bold text-zinc-100 border-b border-dashed border-zinc-800 hover:border-zinc-400 cursor-pointer"
                          >
                            {char.name}
                          </span>
                        )}
                      </div>

                      {/* Personality */}
                      <div>
                        <label className="text-[10px] text-zinc-550 font-bold block mb-1">性格脾气</label>
                        {editingField === `char-${charIdx}-personality` ? (
                          <div className="flex gap-2">
                            <textarea
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              rows={2}
                              className="flex-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs text-white"
                            />
                            <button onClick={saveEdit} className="p-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded self-end"><Check className="w-3.5 h-3.5" /></button>
                          </div>
                        ) : (
                          <p 
                            onClick={() => startEditing(`char-${charIdx}-personality`, char.personality)}
                            className="text-xs text-zinc-350 border-b border-dashed border-zinc-900 hover:border-zinc-500 cursor-pointer min-h-[1.5rem] leading-relaxed"
                          >
                            {char.personality}
                          </p>
                        )}
                      </div>

                      {/* Appearance */}
                      <div>
                        <label className="text-[10px] text-zinc-550 font-bold block mb-1">外貌打扮</label>
                        {editingField === `char-${charIdx}-appearance` ? (
                          <div className="flex gap-2">
                            <textarea
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              rows={2}
                              className="flex-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs text-white"
                            />
                            <button onClick={saveEdit} className="p-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded self-end"><Check className="w-3.5 h-3.5" /></button>
                          </div>
                        ) : (
                          <p 
                            onClick={() => startEditing(`char-${charIdx}-appearance`, char.appearance)}
                            className="text-xs text-zinc-350 border-b border-dashed border-zinc-900 hover:border-zinc-500 cursor-pointer min-h-[1.5rem] leading-relaxed"
                          >
                            {char.appearance}
                          </p>
                        )}
                      </div>

                      {/* Conflict */}
                      <div>
                        <label className="text-[10px] text-zinc-550 font-bold block mb-1">核心矛盾冲突</label>
                        {editingField === `char-${charIdx}-coreConflict` ? (
                          <div className="flex gap-2">
                            <textarea
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              rows={2}
                              className="flex-1 px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs text-white"
                            />
                            <button onClick={saveEdit} className="p-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded self-end"><Check className="w-3.5 h-3.5" /></button>
                          </div>
                        ) : (
                          <p 
                            onClick={() => startEditing(`char-${charIdx}-coreConflict`, char.coreConflict)}
                            className="text-xs text-zinc-350 border-b border-dashed border-zinc-900 hover:border-zinc-500 cursor-pointer min-h-[1.5rem] leading-relaxed"
                          >
                            {char.coreConflict}
                          </p>
                        )}
                      </div>

                      {/* Chapters */}
                      <div>
                        <label className="text-[10px] text-zinc-550 font-bold block mb-1">主要出场章节</label>
                        {editingField === `char-${charIdx}-chapters` ? (
                          <div className="flex gap-2">
                            <input
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              className="flex-1 px-2.5 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs text-white"
                            />
                            <button onClick={saveEdit} className="p-1.5 bg-zinc-100 hover:bg-zinc-200 text-zinc-900 rounded"><Check className="w-3.5 h-3.5" /></button>
                          </div>
                        ) : (
                          <p 
                            onClick={() => startEditing(`char-${charIdx}-chapters`, char.chapters)}
                            className="text-xs text-zinc-350 border-b border-dashed border-zinc-900 hover:border-zinc-500 cursor-pointer min-h-[1.5rem] font-mono"
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
              <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
                <h4 className="text-xs font-bold text-zinc-300 flex items-center gap-1.5 uppercase tracking-wider">
                  <Heart className="w-3.5 h-3.5 text-zinc-450" />
                  人物角色关系网络
                </h4>
                <button
                  onClick={addRelationship}
                  className="py-1 px-2 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 text-[10px] font-semibold border border-zinc-800 rounded transition-all"
                >
                  + 新增关系
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {chapter.analysis?.relationships.map((rel, relIdx) => (
                  <div key={relIdx} className="p-3 rounded-xl bg-zinc-900/40 border border-zinc-800 relative group/rel hover:border-zinc-700 transition-all">
                    
                    <button
                      onClick={() => deleteRelationship(relIdx)}
                      className="absolute top-2 right-2 opacity-0 group-hover/rel:opacity-100 p-1 text-zinc-550 hover:text-red-400 hover:bg-red-500/10 rounded transition-all"
                    >
                      <Trash className="w-3.5 h-3.5" />
                    </button>

                    <div className="space-y-1.5">
                      <div className="flex items-center gap-1">
                        {/* Role A */}
                        {editingField === `rel-${relIdx}-roleA` ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveEdit}
                            autoFocus
                            className="w-20 px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-xs text-white"
                          />
                        ) : (
                          <span 
                            onClick={() => startEditing(`rel-${relIdx}-roleA`, rel.roleA)}
                            className="text-xs font-bold text-zinc-300 cursor-pointer border-b border-dashed border-zinc-900 hover:border-zinc-500"
                          >
                            {rel.roleA}
                          </span>
                        )}
                        
                        <span className="text-[10px] text-zinc-650 font-mono font-bold">⇄</span>

                        {/* Role B */}
                        {editingField === `rel-${relIdx}-roleB` ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveEdit}
                            autoFocus
                            className="w-20 px-1 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-xs text-white"
                          />
                        ) : (
                          <span 
                            onClick={() => startEditing(`rel-${relIdx}-roleB`, rel.roleB)}
                            className="text-xs font-bold text-zinc-300 cursor-pointer border-b border-dashed border-zinc-900 hover:border-zinc-500"
                          >
                            {rel.roleB}
                          </span>
                        )}
                      </div>

                      {/* Description */}
                      <div>
                        {editingField === `rel-${relIdx}-description` ? (
                          <input
                            type="text"
                            value={editValue}
                            onChange={(e) => setEditValue(e.target.value)}
                            onBlur={saveEdit}
                            autoFocus
                            className="w-full px-2 py-1 rounded bg-zinc-900 border border-zinc-700 text-xs text-white"
                          />
                        ) : (
                          <p 
                            onClick={() => startEditing(`rel-${relIdx}-description`, rel.description)}
                            className="text-xs text-zinc-350 leading-relaxed cursor-pointer border-b border-dashed border-zinc-900 hover:border-zinc-500 min-h-[1.25rem]"
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
