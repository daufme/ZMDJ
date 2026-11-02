import type { GameState, Obj, LKI, 触发事件 } from './state.js';
import type { Trigger, 字段类型 } from './types.js';
import { 取事件字段类型 } from './事件定义.js';

const 触发元字段 = new Set(['事件']);

function 物件身份(v: unknown): number | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const uid = (v as { uid?: unknown }).uid;
  return typeof uid === 'number' ? uid : undefined;
}

function 玩家值(g: GameState, 控制器: number, v: unknown): number | undefined {
  if (v === '你') return 控制器;
  if (v === '对手') return g.players.find((p) => p.index !== 控制器)?.index;
  return typeof v === 'number' ? v : undefined;
}

/** 用字段类型比较一个事件字段。 */
function 字段匹配(g: GameState, 类型: 字段类型, 实际: unknown, 期望: unknown, 来源: Obj | LKI, 事件: 触发事件, 控制器: number): boolean {
  if (实际 === undefined) return false;
  if (类型 === '玩家') {
    const 期 = 玩家值(g, 控制器, 期望);
    return typeof 实际 === 'number' && 期 !== undefined && 实际 === 期;
  }
  if (类型 === '物件') {
    const 期物 = 期望 === '自身' ? 来源
      : 期望 === '来源' ? (事件.伤害来源 ?? 事件.指定来源)
      : 期望;
    const 左 = 物件身份(实际);
    const 右 = 物件身份(期物);
    return 左 !== undefined && 右 !== undefined && 左 === 右;
  }
  if (类型 === '数值') return typeof 实际 === 'number' && 实际 === 期望;
  if (类型 === '布尔') return typeof 实际 === 'boolean' && 实际 === 期望;
  if (类型 === '字符串') return typeof 实际 === 'string' && 实际 === 期望;
  if (类型 === '字符串集合') {
    if (Array.isArray(实际)) return 实际.some((x) => x === 期望);
    return 实际 === 期望;
  }
  return false;
}

/** Trigger 匹配：事件名 + 其余键对 item.事件 逐字段。 */
export function 触发匹配(g: GameState, 触发: Trigger, 事件: 触发事件, 来源: Obj | LKI, 控制器: number): boolean {
  if (触发.事件 !== 事件.事件) return false;
  for (const [键, 期望] of Object.entries(触发)) {
    if (触发元字段.has(键)) continue;
    const 类型 = 取事件字段类型(触发.事件, 键);
    if (!类型) return false;
    if (!字段匹配(g, 类型, (事件 as Record<string, unknown>)[键], 期望, 来源, 事件, 控制器)) return false;
  }
  return true;
}
