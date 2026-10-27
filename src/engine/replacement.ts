import type { ReplacementSpec } from './types.js';
import type { GameState, Obj } from './state.js';
import { 有效控制器 } from './continuous.js';

/** 616.1 的替代效应类别。数字越小越先选择。 */
export type 替代类别 = 1 | 2 | 3 | 4 | 5;

/** 一条已经判定为适用的替代性效应。 */
export interface 替代事件 {
  /** 616.1 关注的事件类型。 */
  类型: string;
  /** 受影响的物件或玩家。 */
  受方: Obj | number;
  /** 614.5：每个替代效应对每个事件只应用一次。 */
  已用: Set<string>;
}

export interface 替代项 {
  键: string;
  规格: ReplacementSpec;
  来源: Obj | null;
  控制器: number;
  说明: string;
  可选?: boolean;
  时间印记: number;
}

/** 616.1a~e 分类。 */
export function 替代阶段(r: ReplacementSpec): 替代类别 {
  if (r.自身替代) return 1;       // 616.1a
  if (r.改操控者) return 2;       // 616.1b
  if (r.作为复制) return 3;       // 616.1c
  if (r.暗置进场) return 4;       // 616.1d
  return 5;                       // 616.1e
}

/** 616.1：只保留当前最高优先级类别中的候选。 */
export function 当前类别候选<T extends { 规格: ReplacementSpec }>(候选: T[]): T[] {
  if (!候选.length) return 候选;
  const 最低 = Math.min(...候选.map((x) => 替代阶段(x.规格)));
  return 候选.filter((x) => 替代阶段(x.规格) === 最低);
}

/** 616.1：受影响的物件由其操控者作选择；玩家由该玩家自己作选择。 */
export function 替代选择者(g: GameState, 受方: Obj | number): number {
  return typeof 受方 === 'number' ? 受方 : 有效控制器(g, 受方);
}

/** 组合键：来源实例 + 能力/效应索引；用于 614.5 的「每个事件只一次」。 */
export function 替代键(来源: Obj | null, 前缀: string, i: number, j: number): string {
  return (来源 ? 来源.iid : '持续') + '#' + 前缀 + i + '#' + j;
}

/** 这条效应在这个事件里是否已经用过。 */
export function 已用过(事件: 替代事件, 键: string): boolean {
  return 事件.已用.has(键);
}
