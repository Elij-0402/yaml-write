'use client';

// 划词重写浮动触角（Story 4.2 · AC1/AC2/AC5）。在 SceneEditor 选区附近浮现：
//   · 「按钮态」：实色靛蓝 + Sparkles 图标 +「划词重写」文案（DESIGN.md floating-rewrite-btn）；
//   · 点击后切到「输入态」：一行自由重写指令输入框（挂载即聚焦）+ 发送；可选快捷 chip 预填。
// 定位：绝对定位锚到选区上/下方（placeTrigger 纯函数判定 + 水平钳制，见 app/selectionRect.ts）；
// 量算自身尺寸（DOM 副作用）留在本组件，方位/钳制算术下沉到纯函数。键盘可达：Esc 取消、Enter 提交。

import { useLayoutEffect, useRef, useState } from 'react';
import { Sparkles, ArrowUp } from 'lucide-react';
import { placeTrigger, type SelectionRect } from '../app/selectionRect';

interface FloatingRewriteTriggerProps {
  /** 选区起点行矩形（容器相对，来自 SceneEditor 镜像量算）。 */
  rect: SelectionRect;
  /** 容器可用宽度（水平钳制上界）。 */
  containerWidth: number;
  /** 系统是否要求减弱动画（入场动画/光标）。 */
  reducedMotion: boolean;
  /** 提交自由重写指令（已 trim、非空才回调）。 */
  onSubmit: (instruction: string) => void;
  /** 取消（Esc / 关闭）：清空选区高亮与触角。 */
  onDismiss: () => void;
}

// 触角与选区的垂直间隙。
const GAP = 8;
// 快捷指令 chip（预填输入框，主路径仍是自由文本；对齐 Task 2「可附快捷 chip 预填」）。
const QUICK_CHIPS = ['更有画面感', '更短促', '更伤感'];

export default function FloatingRewriteTrigger({
  rect,
  containerWidth,
  reducedMotion,
  onSubmit,
  onDismiss,
}: FloatingRewriteTriggerProps) {
  const [mode, setMode] = useState<'button' | 'input'>('button');
  const [instruction, setInstruction] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number; placement: 'above' | 'below' } | null>(null);

  // 量算自身尺寸后用 placeTrigger 定位（按钮态/输入态尺寸不同，故依赖 mode 重算）。
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos(
      placeTrigger({
        anchorTop: rect.top,
        anchorLeft: rect.left,
        anchorHeight: rect.height,
        triggerWidth: width,
        triggerHeight: height,
        containerWidth,
        gap: GAP,
      })
    );
  }, [rect.top, rect.left, rect.height, containerWidth, mode]);

  // 切到输入态后自动聚焦输入框（对齐 EXPERIENCE.md「右侧输入框自动获取焦点」）。
  useLayoutEffect(() => {
    if (mode === 'input') inputRef.current?.focus();
  }, [mode]);

  const submit = () => {
    const value = instruction.trim();
    if (!value) return;
    onSubmit(value);
  };

  return (
    <div
      ref={rootRef}
      // 量算前先隐形渲染以取尺寸，避免在 (0,0) 闪现。
      className={`absolute z-20 ${pos && !reducedMotion ? 'pop-enter' : ''}`}
      style={{
        top: pos ? pos.top : 0,
        left: pos ? pos.left : 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      // 触角自身的指针/键盘交互不冒泡到编辑器（避免触发「点空白清选区」）。
      onMouseDown={(e) => e.stopPropagation()}
      role="group"
      aria-label="划词重写"
    >
      {mode === 'button' ? (
        <button
          type="button"
          className="floating-rewrite-btn"
          onClick={() => setMode('input')}
          onKeyDown={(e) => { if (e.key === 'Escape') onDismiss(); }}
        >
          <Sparkles size={13} />
          <span>划词重写</span>
        </button>
      ) : (
        <div className="flex w-[min(280px,80vw)] flex-col gap-1.5 rounded-md border border-line bg-surface p-2 shadow-pop">
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                else if (e.key === 'Escape') { e.preventDefault(); onDismiss(); }
              }}
              placeholder="想怎么改写这段？如「更伤感」「换个视角」"
              className="input h-7 flex-1 text-[13px]"
              aria-label="重写指令"
            />
            <button
              type="button"
              className="btn btn-primary btn-sm btn-icon shrink-0"
              onClick={submit}
              disabled={!instruction.trim()}
              title="提交重写"
              aria-label="提交重写"
            >
              <ArrowUp size={14} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1">
            {QUICK_CHIPS.map((chip) => (
              <button
                key={chip}
                type="button"
                className="chip transition-colors hover:text-fg"
                onClick={() => { setInstruction(chip); inputRef.current?.focus(); }}
              >
                {chip}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
