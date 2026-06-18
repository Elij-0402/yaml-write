'use client';

import React from 'react';

/** 模拟树节点的骨架屏条块，宽度递进递减以模拟层级缩进。 */
const NODE_WIDTHS = ['w-11/12', 'w-5/6', 'w-3/4', 'w-2/3', 'w-1/2'] as const;

export interface SkeletonTreeProps {
  /** 条块数量，默认 5 */
  count?: number;
}

export default function SkeletonTree({ count = 5 }: SkeletonTreeProps) {
  return (
    <div className="space-y-2.5 rounded-sm border border-line bg-panel p-3">
      {NODE_WIDTHS.slice(0, count).map((w, i) => (
        <div
          key={i}
          className={`h-3 rounded-sm bg-surface animate-pulse motion-reduce:animate-none ${w}`}
        />
      ))}
    </div>
  );
}