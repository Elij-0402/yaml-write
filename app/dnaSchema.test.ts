import { describe, it, expect } from 'vitest';
import {
  parseChapterMapSummary,
  parseNovelDNACard,
  parseFusionDirection,
  parseFusionDirections,
  parseSceneEvaluateResponse,
  parseChatAssistantResponse,
} from './dnaSchema';

const validSummary = {
  worldviewUpdates: 'w',
  keyPlotTurns: 'k',
  characterDevelopments: 'c',
  styleObservations: 's',
};

const validDirection = {
  title: 't',
  concept: 'c',
  catalyst: 'cat',
  worldviewBlock: 'w',
  protagonistBlock: 'p',
  antagonistBlock: 'a',
  narrativeTone: 'n',
  transferNote: 'tn',
};

const validCard = {
  structureSkeleton: [{ function: 'f1', summary: 's1' }, { function: 'f2', summary: 's2' }],
  pacingSyuzhet: 'pacing',
  themeSkin: 'theme',
  proseStyle: 'prose',
};

describe('parseChapterMapSummary', () => {
  it('accepts a well-formed summary and returns the 4 fields', () => {
    expect(parseChapterMapSummary(validSummary)).toEqual(validSummary);
  });
  it('rejects a non-object', () => {
    expect(() => parseChapterMapSummary(null)).toThrow();
    expect(() => parseChapterMapSummary([validSummary])).toThrow();
    expect(() => parseChapterMapSummary('x')).toThrow();
  });
  it('rejects a missing/non-string field', () => {
    expect(() => parseChapterMapSummary({ ...validSummary, keyPlotTurns: undefined })).toThrow();
    expect(() => parseChapterMapSummary({ ...validSummary, styleObservations: 42 })).toThrow();
  });
});

describe('parseNovelDNACard', () => {
  it('accepts a 4-layer card with a typed structureSkeleton', () => {
    const card = parseNovelDNACard(validCard);
    expect(card.structureSkeleton).toHaveLength(2);
    expect(card.structureSkeleton[0]).toEqual({ function: 'f1', summary: 's1' });
    expect(card.pacingSyuzhet).toBe('pacing');
  });
  it('rejects an empty or non-array structureSkeleton', () => {
    expect(() => parseNovelDNACard({ ...validCard, structureSkeleton: [] })).toThrow();
    expect(() => parseNovelDNACard({ ...validCard, structureSkeleton: 'x' })).toThrow();
  });
  it('rejects a malformed beat', () => {
    expect(() => parseNovelDNACard({ ...validCard, structureSkeleton: [{ function: 'f' }] })).toThrow();
  });
  it('rejects a missing skin/prose string', () => {
    expect(() => parseNovelDNACard({ ...validCard, proseStyle: undefined })).toThrow();
  });
});

describe('parseFusionDirection', () => {
  it('accepts a full direction including optional transferNote', () => {
    expect(parseFusionDirection(validDirection, 'ctx')).toEqual(validDirection);
  });
  it('accepts a direction omitting transferNote', () => {
    const { transferNote: _omit, ...noNote } = validDirection;
    expect(parseFusionDirection(noNote, 'ctx')).toEqual(noNote);
  });
  it('rejects a missing core block', () => {
    const { worldviewBlock: _drop, ...missing } = validDirection;
    expect(() => parseFusionDirection(missing, 'ctx')).toThrow();
  });
  it('rejects a non-string transferNote when present', () => {
    expect(() => parseFusionDirection({ ...validDirection, transferNote: 5 }, 'ctx')).toThrow();
  });
});

describe('parseFusionDirections', () => {
  it('accepts a non-empty directions array and validates each element', () => {
    const out = parseFusionDirections({ directions: [validDirection, validDirection, validDirection] });
    expect(out.directions).toHaveLength(3);
  });
  it('rejects a missing/empty/non-array directions field', () => {
    expect(() => parseFusionDirections({})).toThrow();
    expect(() => parseFusionDirections({ directions: [] })).toThrow();
    expect(() => parseFusionDirections({ directions: 'x' })).toThrow();
  });
  it('propagates a malformed element', () => {
    expect(() => parseFusionDirections({ directions: [validDirection, { title: 'x' }] })).toThrow();
  });
});

describe('parseSceneEvaluateResponse', () => {
  const validEvaluateResponse = {
    sceneId: 'scene_001',
    attempt: 1,
    passed: false,
    failedGates: ['StyleLock'],
    evidence: 'evidence',
    actionableFeedback: 'feedback',
  };

  it('accepts a well-formed evaluate response', () => {
    expect(parseSceneEvaluateResponse(validEvaluateResponse)).toEqual(validEvaluateResponse);
  });

  it('rejects a non-object', () => {
    expect(() => parseSceneEvaluateResponse(null)).toThrow();
    expect(() => parseSceneEvaluateResponse('x')).toThrow();
  });

  it('rejects a missing/non-string or non-number field', () => {
    expect(() => parseSceneEvaluateResponse({ ...validEvaluateResponse, sceneId: 42 })).toThrow();
    expect(() => parseSceneEvaluateResponse({ ...validEvaluateResponse, attempt: '1' })).toThrow();
    expect(() => parseSceneEvaluateResponse({ ...validEvaluateResponse, passed: 'false' })).toThrow();
    expect(() => parseSceneEvaluateResponse({ ...validEvaluateResponse, evidence: undefined })).toThrow();
  });

  it('rejects a malformed failedGates field', () => {
    expect(() => parseSceneEvaluateResponse({ ...validEvaluateResponse, failedGates: 'StyleLock' })).toThrow();
    expect(() => parseSceneEvaluateResponse({ ...validEvaluateResponse, failedGates: [42] })).toThrow();
  });
});

describe('parseChatAssistantResponse', () => {
  const validResponse = {
    reply: '好的，已帮你修改了角色设定。',
    entityCardUpdates: [
      { action: 'upsert', cardId: 'card-1', type: 'character', name: '林鸣', summary: '冷酷性格', details: '' },
    ],
    volumeUpdates: [],
    chapterUpdates: [],
    sceneUpdates: [],
  };

  it('parses valid response', () => {
    const result = parseChatAssistantResponse(validResponse);
    expect(result.reply).toBe('好的，已帮你修改了角色设定。');
    expect(result.entityCardUpdates).toHaveLength(1);
    expect(result.entityCardUpdates[0].action).toBe('upsert');
    expect(result.entityCardUpdates[0].cardId).toBe('card-1');
  });

  it('accepts response with only reply and no updates', () => {
    const result = parseChatAssistantResponse({ reply: '你好！', entityCardUpdates: [], volumeUpdates: [], chapterUpdates: [], sceneUpdates: [] });
    expect(result.reply).toBe('你好！');
    expect(result.entityCardUpdates).toHaveLength(0);
  });

  it('throws on missing reply', () => {
    expect(() => parseChatAssistantResponse({ entityCardUpdates: [] })).toThrow();
  });

  it('throws on non-object input', () => {
    expect(() => parseChatAssistantResponse(null)).toThrow();
    expect(() => parseChatAssistantResponse('string')).toThrow();
  });

  it('throws on invalid action in entityCardUpdates', () => {
    expect(() => parseChatAssistantResponse({
      reply: 'ok',
      entityCardUpdates: [{ action: 'invalid', cardId: 'x', type: 'character', name: 'a', summary: '', details: '' }],
      volumeUpdates: [],
      chapterUpdates: [],
      sceneUpdates: [],
    })).toThrow();
  });

  it('defaults missing arrays to empty', () => {
    const result = parseChatAssistantResponse({ reply: 'test' });
    expect(result.entityCardUpdates).toHaveLength(0);
    expect(result.volumeUpdates).toHaveLength(0);
    expect(result.chapterUpdates).toHaveLength(0);
    expect(result.sceneUpdates).toHaveLength(0);
  });

  it('throws on upsert with empty name', () => {
    expect(() => parseChatAssistantResponse({
      reply: 'ok',
      entityCardUpdates: [{ action: 'upsert', cardId: '', type: 'character', name: '', summary: '', details: '' }],
      volumeUpdates: [],
      chapterUpdates: [],
      sceneUpdates: [],
    })).toThrow();
  });

  it('throws on volumeUpdate missing volume object', () => {
    expect(() => parseChatAssistantResponse({
      reply: 'ok',
      entityCardUpdates: [],
      volumeUpdates: [{ action: 'upsert' }],
      chapterUpdates: [],
      sceneUpdates: [],
    })).toThrow();
  });
});
