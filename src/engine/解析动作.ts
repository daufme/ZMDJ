import type { Obj, GameState } from './state.js';
import { 实际打出费用, 可用启动式能力, 可支付来源 } from './engine.js';
import type { Action, 目标, 攻击对象 } from './engine.js';
import type { 阵地 } from './types.js';

function 找任意区域物件(g: GameState, uid: number): Obj | null {
  const 场上 = g.战场.find((x) => x.uid === uid);
  if (场上) return 场上;
  const 栈 = g.stack.map((it) => it.card).find((x) => !!x && x.uid === uid);
  if (栈) return 栈;
  for (const pl of g.players) {
    const 中 = [...pl.hand, ...pl.graveyard, ...pl.library].find((x) => x.uid === uid);
    if (中) return 中;
  }
  return g.放逐区.find((x) => x.uid === uid) ?? null;
}

export type 线动作 = { 种类?: unknown } & Record<string, unknown>;

type 全字段表<K extends Action['种类']> = Record<keyof Extract<Action, { 种类: K }>, () => unknown>;

type 解析结果 = { ok: true; 动作: Action } | { ok: false; 错误: string };

const 数字数组 = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? (v as number[]) : undefined;

const 选择数组 = (v: unknown): (number | string)[] | undefined =>
  Array.isArray(v) ? (v as (number | string)[]) : undefined;
const 数字 = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const 零或一 = (v: unknown): number | undefined => (v === 0 || v === 1 ? v : undefined);
const 是数组 = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const 取首 = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const 数字1 = (v: unknown): number | undefined => 数字(取首(v));
const 零或一1 = (v: unknown): number | undefined => 零或一(取首(v));
const 是布尔 = (v: unknown): boolean => !!取首(v);

function 源提供(g: GameState, 座位: number, 源: number[]): number {
  const 表 = 可支付来源(g, 座位);
  return 源.reduce((n, uid) => n + (表.find((x) => x.uid === uid)?.提供 ?? 0), 0);
}

export function 解析动作(g: GameState, p: number, 体: 线动作): 解析结果 {
  const me = g.players[p]!;
  const 手上 = (uid: unknown) => me.hand.find((x) => x.uid === uid);
  const 场上 = (uid: unknown) => g.战场.find((x) => x.uid === uid);

  const 造 = (表: Record<string, () => unknown>): Record<string, unknown> => {
    const 出: Record<string, unknown> = {};
    for (const k of Object.keys(表)) { const v = 表[k]!(); if (v !== undefined) 出[k] = v; }
    return 出;
  };

  switch (体.种类) {
    case '让过':
      return { ok: true, 动作: 造({ 种类: () => '让过' } satisfies 全字段表<'让过'>) as unknown as Action };

    case '决定': {

      const 表 = {
        种类: () => '决定',

        接受: () => 是布尔(体.接受),
        弃牌: () => 数字数组(体.弃牌),
        选: () => 选择数组(体.选),
        先手: () => 零或一1(体.先手),
        张数: () => 数字1(体.张数),
      } satisfies 全字段表<'决定'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }

    case '打领土': {
      const o = 手上(体.uid);
      if (!o) return { ok: false, 错误: '手牌里没有这张牌' };
      const 表 = { 种类: () => '打领土', card: () => o, 面: () => (体.面 === '暗置' ? '暗置' : '明置') } satisfies 全字段表<'打领土'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }

    case '转移': {
      const u = 场上(体.uid);
      if (!u) return { ok: false, 错误: '找不到这个单位' };
      const 表 = { 种类: () => '转移', card: () => u, 到: () => 取首(体.到) as 阵地, 路径: () => 体.路径 } satisfies 全字段表<'转移'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }

    case '施放': {
      const o = 手上(体.uid);
      if (!o) return { ok: false, 错误: '手牌里没有这张牌' };
      const 目标表: 目标[] = [];
      for (const t of 是数组(体.目标) as Record<string, unknown>[]) {
        if (t.类型 === '玩家') { 目标表.push(t.玩家 as number); continue; }

        if (t.类型 === '堆叠项' || (typeof t.uid === 'number' && t.uid < 0)) { 目标表.push({ 堆叠项: -(t.uid as number) }); continue; }

        const obj = 找任意区域物件(g, t.uid as number);
        if (!obj) return { ok: false, 错误: '目标已不存在' };
        目标表.push(obj);
      }

      const 源 = 数字数组(体.支付源) ?? [];

      const X = o.def.打出费用 === 'X' ? (数字1(体.X) ?? 源提供(g, p, 源)) : 数字1(体.X);
      const 需付 = o.def.打出费用 === 'X' ? (X ?? 0) : 实际打出费用(g, p, o.def);
      if (需付 > 0 && 源.length === 0) {
        return { ok: false, 错误: '这张牌要付 ' + 需付 + ' 点数字费用，请先挑要启动的领土（304.8）' };
      }
      const 表 = {
        种类: () => '施放', card: () => o, 目标: () => 目标表,
        阵地: () => 取首(体.阵地) as 阵地 | undefined,
        模式号: () => 数字1(体.模式号),
        X: () => X,
      额外牺牲: () => 数字数组(体.额外牺牲),
        支付源: () => (源.length ? 源 : undefined),
      } satisfies 全字段表<'施放'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }

    case '宣告': {

      const 表 = { 种类: () => '宣告', 模式: () => 数字1(体.模式), 目标: () => 是数组(体.目标) } satisfies 全字段表<'宣告'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }

    case '启动能力': {
      const o = 场上(体.uid);
      if (!o) return { ok: false, 错误: '找不到该实体' };

      if (!可用启动式能力(g, p, o).includes(体.能力索引 as number)) {
        return { ok: false, 错误: '这个能力现在不能启动（时机、费用或限制不满足）' };
      }

      const ab = (o.def.能力?.能力 ?? [])[体.能力索引 as number] as { 费用?: { 通用?: number | 'X' } } | undefined;
      const 源 = 数字数组(体.支付源) ?? [];

      const 宣告X = 数字1(体.宣告X) ?? (ab?.费用?.通用 === 'X' ? 源提供(g, p, 源) : undefined);
      const 需付 = ab?.费用?.通用 === 'X' ? 0 : (ab?.费用?.通用 ?? 0);
      if (需付 > 0 && 源.length === 0) {
        return { ok: false, 错误: '这个能力要付 ' + 需付 + ' 点数字费用，请先挑要启动的领土（304.8）' };
      }

      const 目标表: 目标[] = [];
      for (const t of 是数组(体.目标) as Record<string, unknown>[]) {
        if (t.类型 === '玩家') { 目标表.push(t.玩家 as number); continue; }
        if (t.类型 === '堆叠项' || (typeof t.uid === 'number' && t.uid < 0)) { 目标表.push({ 堆叠项: -(t.uid as number) }); continue; }

        const obj = 找任意区域物件(g, t.uid as number);
        if (!obj) return { ok: false, 错误: '目标已不存在' };
        目标表.push(obj);
      }
      const 表 = {
        种类: () => '启动能力', card: () => o,
        能力索引: () => 数字1(体.能力索引) as number,
        目标: () => (目标表.length ? 目标表 : undefined),
        支付源: () => (源.length ? 源 : undefined),
        模式号: () => 数字1(体.模式号),
        费用弃牌: () => 数字数组(体.费用弃牌),
        费用牺牲: () => 数字数组(体.费用牺牲),
        费用弃牌数: () => 数字1(体.费用弃牌数),
        费用牺牲数: () => 数字1(体.费用牺牲数),
      费用X: () => !!体.费用X,
      宣告X: () => 宣告X,
      } satisfies 全字段表<'启动能力'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }

    case '发起战斗': {
      const u = 场上(体.uid);
      if (!u) return { ok: false, 错误: '找不到该单位' };

      const t = 取首(体.攻击对象) as Record<string, unknown> | undefined;
      if (!t) return { ok: false, 错误: '缺少攻击对象' };
      const 表 = {
        种类: () => '发起战斗', card: () => u,

        支付源: () => 数字数组(体.支付源),
        目标: (): 攻击对象 => (t.种类 === '玩家'
          ? { 种类: '玩家', 玩家: t.玩家 as number }
          : { 种类: '阵地', 玩家: t.玩家 as number, 阵地: t.阵地 as 阵地 }),
      } satisfies 全字段表<'发起战斗'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }
  }
  return { ok: false, 错误: '未知动作' };
}
