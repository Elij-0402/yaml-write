'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { Send, Sparkles, User, Database } from 'lucide-react';
import { db } from '../app/db';
import { useAppStore } from '../app/store';
import { ensureLlmConfigReady, callStructured } from '../app/llmClient';
import { canUseLlm } from '../app/networkStatus';
import { parseChatAssistantResponse, type ChatMessage, type ChatAssistantResponse } from '../app/dnaSchema';
import type { EntityCard } from '../app/memorySchema';

const MAX_CHAT_MESSAGES = 30;

async function executeIntentUpdates(updates: ChatAssistantResponse, novelId: string): Promise<string[]> {
  const log: string[] = [];
  const now = Date.now();

  for (const upd of updates.entityCardUpdates) {
    if (upd.action === 'delete' && upd.cardId) {
      await db.entityCards.delete(upd.cardId);
      log.push(`删除设定卡片「${upd.name || upd.cardId}」`);
    } else if (upd.action === 'upsert') {
      const id = upd.cardId || crypto.randomUUID();
      const existing = upd.cardId ? await db.entityCards.get(upd.cardId) : undefined;
      const card: EntityCard = {
        id,
        novelId,
        type: upd.type || 'character',
        name: upd.name,
        summary: upd.summary || '',
        details: upd.details || '',
        activeState: existing?.activeState ?? 'idle',
        order: existing?.order ?? 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      await db.entityCards.put(card);
      log.push(`${upd.cardId ? '更新' : '新建'}设定卡片「${upd.name}」`);
    }
  }

  for (const upd of updates.volumeUpdates) {
    const vol = upd.volume;
    if (upd.action === 'delete' && vol.id) {
      await db.volumes.delete(vol.id);
      log.push(`删除卷「${vol.title || vol.id}」`);
    } else if (upd.action === 'upsert') {
      const id = vol.id || crypto.randomUUID();
      const existing = vol.id ? await db.volumes.get(vol.id) : undefined;
      await db.volumes.put({
        id,
        novelId,
        title: vol.title,
        order: vol.order || 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      log.push(`${vol.id ? '更新' : '新建'}卷「${vol.title}」`);
    }
  }

  for (const upd of updates.chapterUpdates) {
    const ch = upd.chapter;
    if (upd.action === 'delete' && ch.id) {
      await db.outlineChapters.delete(ch.id);
      log.push(`删除章「${ch.title || ch.id}」`);
    } else if (upd.action === 'upsert') {
      const id = ch.id || crypto.randomUUID();
      const existing = ch.id ? await db.outlineChapters.get(ch.id) : undefined;
      await db.outlineChapters.put({
        id,
        novelId,
        volumeId: ch.volumeId || '',
        title: ch.title,
        order: ch.order || 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      log.push(`${ch.id ? '更新' : '新建'}章「${ch.title}」`);
    }
  }

  for (const upd of updates.sceneUpdates) {
    const sc = upd.scene;
    if (upd.action === 'delete' && sc.id) {
      await db.scenes.delete(sc.id);
      log.push(`删除幕「${sc.title || sc.id}」`);
    } else if (upd.action === 'upsert') {
      const id = sc.id || crypto.randomUUID();
      const existing = sc.id ? await db.scenes.get(sc.id) : undefined;
      await db.scenes.put({
        id,
        novelId,
        chapterId: sc.chapterId || '',
        title: sc.title,
        synopsis: sc.synopsis || '',
        content: existing?.content ?? '',
        wordCount: existing?.wordCount ?? 0,
        order: sc.order || 0,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      });
      log.push(`${sc.id ? '更新' : '新建'}幕「${sc.title}」`);
    }
  }

  return log;
}

export default function AiAssistant() {
  const selectedNovelId = useAppStore((s) => s.selectedNovelId);
  const llmConfig = useAppStore((s) => s.llmConfig);
  const isOffline = useAppStore((s) => s.isOffline);
  const chatMessages = useAppStore((s) => s.chatMessages);
  const addChatMessage = useAppStore((s) => s.addChatMessage);

  const llmReadiness = ensureLlmConfigReady(llmConfig);

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const novelId = selectedNovelId || '';
  const disabled = !canUseLlm(llmReadiness.ok, isOffline) || !novelId;
  const messages = chatMessages[novelId] || [];

  const entityCards = useLiveQuery(
    () => (novelId ? db.entityCards.where('novelId').equals(novelId).toArray() : []),
    [novelId],
  ) ?? [];

  const volumes = useLiveQuery(
    () => (novelId ? db.volumes.where('novelId').equals(novelId).toArray() : []),
    [novelId],
  ) ?? [];

  const outlineChapters = useLiveQuery(
    () => (novelId ? db.outlineChapters.where('novelId').equals(novelId).toArray() : []),
    [novelId],
  ) ?? [];

  const scenes = useLiveQuery(
    () => (novelId ? db.scenes.where('novelId').equals(novelId).toArray() : []),
    [novelId],
  ) ?? [];

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages.length]);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || loading || disabled || !novelId) return;

    const userMsg: ChatMessage = { role: 'user', content: text };
    addChatMessage(novelId, userMsg);
    setInput('');
    setLoading(true);

    try {
      const cardContext = entityCards.map((c) => ({
        action: 'upsert' as const,
        cardId: c.id,
        type: c.type,
        name: c.name,
        summary: c.summary,
        details: c.details,
      }));

      const volumeContext = volumes.map((v) => ({
        id: v.id,
        title: v.title,
        order: v.order,
      }));

      const chapterContext = outlineChapters.map((ch) => ({
        id: ch.id,
        volumeId: ch.volumeId,
        title: ch.title,
        order: ch.order,
      }));

      const sceneContext = scenes.map((sc) => ({
        id: sc.id,
        chapterId: sc.chapterId,
        title: sc.title,
        synopsis: sc.synopsis,
        order: sc.order,
      }));

      const recentMessages = [...messages.slice(-(MAX_CHAT_MESSAGES - 1)), userMsg]
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      const result = await callStructured<ChatAssistantResponse>(
        '/api/py/chat-assistant',
        {
          messages: recentMessages,
          novelId,
          entityCards: cardContext,
          volumes: volumeContext,
          chapters: chapterContext,
          scenes: sceneContext,
        },
        { parse: parseChatAssistantResponse },
      );

      const assistantMsg: ChatMessage = { role: 'assistant', content: result.reply };
      addChatMessage(novelId, assistantMsg);

      const hasUpdates =
        result.entityCardUpdates.length > 0 ||
        result.volumeUpdates.length > 0 ||
        result.chapterUpdates.length > 0 ||
        result.sceneUpdates.length > 0;

      if (hasUpdates) {
        try {
          const changeLog = await executeIntentUpdates(result, novelId);
          if (changeLog.length > 0) {
            const systemMsg: ChatMessage = {
              role: 'system',
              content: changeLog.join('；'),
            };
            addChatMessage(novelId, systemMsg);
          }
        } catch (dbErr) {
          addChatMessage(novelId, { role: 'system', content: '数据库写入失败，请重试。' });
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : '请求失败，请重试。';
      addChatMessage(novelId, { role: 'system', content: `错误：${errMsg}` });
    } finally {
      setLoading(false);
    }
  }, [input, loading, disabled, novelId, entityCards, volumes, outlineChapters, scenes, messages, addChatMessage]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  return (
    <div className="flex h-full flex-col">
      {/* Message list */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto p-3 space-y-2"
        aria-live="polite"
        aria-busy={loading}
      >
        {messages.length === 0 && !loading && (
          <p className="text-[12px] text-fg-subtle text-center pt-8">
            在此向 AI 助手发送指令，修改设定卡片或大纲。
          </p>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {loading && (
          <div className="flex items-center gap-2 px-3 py-2">
            <Sparkles size={14} className="text-accent-ink animate-pulse" />
            <span className="text-[12px] text-fg-subtle">思考中…</span>
          </div>
        )}
      </div>

      {/* Input area */}
      <div className="shrink-0 border-t border-line p-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={textareaRef}
            className="input min-h-[36px] max-h-[120px] flex-1 resize-none text-[13px] leading-relaxed"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              isOffline
                ? '离线模式下大模型不可用'
                : !llmReadiness.ok
                  ? '请配置 API 密钥'
                  : !novelId
                    ? '请先选择一部作品'
                    : '输入指令… (Enter 发送)'
            }
            disabled={disabled}
            rows={1}
          />
          <button
            className={`btn btn-primary h-[36px] w-[36px] shrink-0 p-0 flex items-center justify-center ${
              loading ? 'animate-pulse' : ''
            }`}
            onClick={() => void sendMessage()}
            disabled={disabled || loading || !input.trim()}
            aria-label="发送"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function MessageBubble({ message }: { message: ChatMessage }) {
  if (message.role === 'system') {
    return (
      <div className="card border-l-2 border-l-accent px-3 py-2">
        <div className="flex items-center gap-1.5 mb-0.5">
          <Database size={12} className="text-accent-ink" />
          <span className="text-[11px] font-medium text-fg-subtle">系统</span>
        </div>
        <p className="text-[12.5px] leading-relaxed text-fg-muted whitespace-pre-wrap">
          {message.content}
        </p>
      </div>
    );
  }

  const isUser = message.role === 'user';
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed ${
          isUser
            ? 'bg-subtle text-fg'
            : 'bg-surface border border-line text-fg'
        }`}
      >
        <div className="flex items-center gap-1.5 mb-0.5">
          {isUser ? (
            <User size={12} className="text-fg-subtle" />
          ) : (
            <Sparkles size={12} className="text-accent-ink" />
          )}
          <span className="text-[11px] font-medium text-fg-subtle">
            {isUser ? '你' : 'AI'}
          </span>
        </div>
        <p className="whitespace-pre-wrap">{message.content}</p>
      </div>
    </div>
  );
}
