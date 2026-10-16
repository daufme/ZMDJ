import type { GameState } from './state.js';
import { 相对阵地 } from './state.js';
import type { 阵地 } from './types.js';
import { 阵地顺序 } from './types.js';
import { 解析能力, 有效控制器 } from './continuous.js';
import type { ActivatedAbility } from './types.js';
import {
  能打出领土, 能施放, 候选目标, 能转移, 能移动许可, 转移关键词目标, 许可目标, 转移目标, 可支付数字费用,能发起战斗, 合法攻击对象, 可用启动式能力, 处于通常时机,
  type 时机选项,
  可支付上限, 实际打出费用, 有词, 能填满所有槽,
} from './engine.js';

export interface 候选 {

  类型: '实体' | '玩家' | '堆叠项';
  uid?: number; 玩家?: number; 名称: string; 敌?: boolean;
}

export interface 合法动作 {
  种类: '打领土' | '施放' | '启动能力' | '发起战斗' | '让过' | '转移';
  uid?: number;
  能力索引?: number;

  模式号?: number;
  标签: string;

  面?: '明置' | '暗置';

  必须暗置?: boolean;
  需要阵地?: { 阵地: 阵地; 标签: string }[];

  到?: 阵地;

  路径?: '转移' | '许可';

 是X?: boolean;

 费用数?: number;

  额外牺牲数?: number;
  额外牺牲候选?: { uid: number; 名称: string }[];

 费用X?: boolean;
  目标规格?: { 目标名: string; 数量: { 最小: number; 最大: number }; 候选: 候选[] }[];

  费用弃牌数?: number;
  费用牺牲数?: number;
  费用弃牌?: { uid: number; 名称: string }[];
  费用牺牲?: { uid: number; 名称: string }[];
  攻击对象?: { 标签: string; 种类: '玩家' | '阵地'; 玩家: number; 阵地?: 阵地 }[];
}

export function 列出合法动作(g: GameState, p: number, opts: 时机选项): 合法动作[] {
  const out: 合法动作[] = [];
  const me = g.players[p]!;

  const 通常时机 = opts.允许通常时机 && 处于通常时机(g, p);

  if (opts.允许打领土 && g.stack.length === 0) {
    for (const o of me.hand) {

      if (能打出领土(g, p, o, '明置')) {
        out.push({ 种类: '打领土', uid: o.uid, 面: '明置', 标签: '打出领土 ' + o.def.全名 });
      }

      if (能打出领土(g, p, o, '暗置')) {
        out.push({ 种类: '打领土', uid: o.uid, 面: '暗置', 标签: '暗置打出 ' + o.def.全名 + '（作为暗置领土）' });
      }
    }
  }

  if (g.stack.length === 0) {

    for (const u of g.战场) {
      if (有效控制器(g, u) !== p) continue;
      if (能转移(g, p, u)) {
        for (const 到 of 转移关键词目标(g, u)) {
          out.push({ 种类: '转移', uid: u.uid, 到, 路径: '转移', 标签: '转移 ' + u.def.全名 + ' → ' + 到 });
        }
      }
      if (能移动许可(g, p, u)) {
        for (const 到 of 许可目标(g, u)) {
          out.push({ 种类: '转移', uid: u.uid, 到, 路径: '许可', 标签: '移动 ' + u.def.全名 + ' → ' + 到 });
        }
      }
    }
  }

  for (const o of me.hand) {
    if (o.def.类别.includes('领土')) continue;
    if (!能施放(g, p, o).ok) continue;

    const 是X = o.def.打出费用 === 'X';

    if (!可支付数字费用(g, p, 是X ? 0 : 实际打出费用(g, p, o.def))) continue;
    const 目标规格: { 目标名: string; 数量: { 最小: number; 最大: number }; 候选: 候选[] }[] = [];
    let 可行 = true;

    if (!能填满所有槽(g, p, o.def.能力?.目标 ?? [])) 可行 = false;
    for (const spec of o.def.能力?.目标 ?? []) {

      const c = 候选目标(g, p, spec, o);
      if (c.length < spec.数量.最小) { 可行 = false; break; }
      目标规格.push({
        目标名: spec.目标名, 数量: spec.数量,
        候选: c.map((x) => x.obj
          ? { 类型: '实体' as const, uid: x.obj.uid, 名称: x.obj.def.全名 }
        : x.堆叠项 !== undefined ? { 类型: '堆叠项' as const, uid: -x.堆叠项, 名称: '（能力）' }
          : { 类型: '玩家' as const, 玩家: x.玩家!, 名称: g.players[x.玩家!]!.name }),
      });
    }
    if (!可行) continue;

    let 阵地表: { 阵地: 阵地; 标签: string }[] | undefined;
    if (o.def.类别.includes('单位')) {
      const 全部 = 阵地顺序.map((s) => ({
        阵地: s,
        标签: me.阵地[s] ? s + '（替任 ' + me.阵地[s]!.def.全名 + '）' : s + '（空）',
      }));

      const 逼 = 全部.filter(({ 阵地: s }) =>
        g.players.some((_, i) => {
          if (i === p) return false;
          const 叫 = g.players[i]!.阵地[s];
          if (!叫 || 有效控制器(g, 叫) !== i || !有词(g, 叫, '叫阵')) return false;
          const 该格 = 相对阵地(s)!;
          return !me.阵地[该格];
        }));
      阵地表 = 逼.length ? 逼 : 全部;
    }
    out.push({
      种类: '施放', uid: o.uid,
       标签: '施放 ' + o.def.全名 + '（费用 ' + (是X ? 'X' : 实际打出费用(g, p, o.def)) + '）',
      目标规格: 目标规格.length ? 目标规格 : undefined,
      需要阵地: 阵地表,

        是X,

        额外牺牲数: o.def.额外费用?.牺牲?.数量,
        额外牺牲候选: o.def.额外费用?.牺牲
          ? 候选目标(g, p, { 目标名: '_', 数量: { 最小: 1, 最大: 9 }, 选择: { 区域: '战场', 种类: '单位', 操控者: '你', 筛选: o.def.额外费用.牺牲.筛选 } }, null)
              .map((c) => ({ uid: c.obj!.uid, 名称: c.obj!.def.全名 }))
          : undefined,
       费用数: 是X ? 0 : 实际打出费用(g, p, o.def),
    });
  }

  for (const o of [...g.战场.filter((x) => 有效控制器(g, x) === p), ...me.graveyard]) {
    for (const i of 可用启动式能力(g, p, o)) {

      const ab0 = ((o.def.能力?.能力 ?? []) as ActivatedAbility[])[i];
      const ab = ab0 ? (解析能力(ab0) as unknown as ActivatedAbility) : undefined;

      type 一项 = { 模式号?: number; 目标: NonNullable<ActivatedAbility['目标']>; 标签?: string };
      const 各选项: 一项[] = ab?.模式
        ? (ab.模式.选项 as unknown as { 标签?: string; 目标?: NonNullable<ActivatedAbility['目标']> }[])
            .map((op, m) => ({ 模式号: m, 目标: op.目标 ?? [], 标签: op.标签 }))
        : [{ 模式号: undefined, 目标: ab?.目标 ?? [], 标签: ab?.标签 }];
      for (const 项 of 各选项) {
        const 规格: { 目标名: string; 数量: { 最小: number; 最大: number }; 候选: 候选[] }[] = [];

        if (!能填满所有槽(g, p, 项.目标, o)) continue;

        if (ab?.费用?.弃牌 && ab.费用.弃牌.数量 !== 'X' && g.players[p]!.hand.length < ab.费用.弃牌.数量) continue;
        const 可牺牲 = ab?.费用?.牺牲
          ? 候选目标(g, p, { 目标名: '_', 数量: { 最小: 1, 最大: 99 },
              选择: { 区域: '战场', 操控者: '你', 筛选: ab.费用.牺牲.筛选 } }, o)
              .map((x) => x.obj).filter((x): x is NonNullable<typeof x> => !!x)
          : [];
        if (ab?.费用?.牺牲 && 可牺牲.length < ab.费用.牺牲.数量) continue;
        for (const spec of 项.目标) {
          const c = 候选目标(g, p, spec, o);
          if (c.length < spec.数量.最小) continue;
          规格.push({ 目标名: spec.目标名, 数量: spec.数量,
            候选: c.map((x) => (x.obj ? { 类型: '实体' as const, uid: x.obj.uid, 名称: x.obj.def.全名, 敌: x.obj.操控者 !== p }
            : x.堆叠项 !== undefined ? { 类型: '堆叠项' as const, uid: -x.堆叠项, 名称: '（能力）', 敌: false }
                                    : { 类型: '玩家' as const, 玩家: x.玩家!, 名称: g.players[x.玩家!]!.name })) });
        }
        out.push({ 种类: '启动能力', uid: o.uid, 能力索引: i, 模式号: 项.模式号,
          目标规格: 规格.length ? 规格 : undefined,

          费用数: ab?.费用?.通用 === 'X' ? 0 : (ab?.费用?.通用 ?? 0),

          费用X: ab?.费用?.通用 === 'X' ? true : undefined,

          费用弃牌数: ab?.费用?.弃牌 ? (ab.费用.弃牌.数量 === 'X' ? undefined : ab.费用.弃牌.数量) : undefined,
          费用牺牲数: ab?.费用?.牺牲?.数量,
          费用弃牌: ab?.费用?.弃牌 ? g.players[p]!.hand.slice(0, 30).map((c) => ({ uid: c.uid, 名称: c.def.全名 })) : undefined,
          费用牺牲: ab?.费用?.牺牲 ? 可牺牲.map((x) => ({ uid: x.uid, 名称: x.def.全名 })) : undefined,
          标签: '启动 ' + o.def.全名 + (项.标签 ? '：' + 项.标签 : '')
            + ((ab?.费用?.通用 === 'X') ? '（付 X 费）' : ((ab?.费用?.通用 ?? 0) > 0 ? '（付 ' + ab!.费用!.通用 + ' 费）' : '')) });
      }
    }
  }
  for (const u of 通常时机 ? g.战场.filter((x) => 有效控制器(g, x) === p) : []) {
    if (!能发起战斗(g, p, u)) continue;
    out.push({
      种类: '发起战斗', uid: u.uid, 标签: '令 ' + u.def.全名 + ' 发起战斗',
      攻击对象: 合法攻击对象(g, p, u).map((t) => t.种类 === '玩家'
        ? { 标签: '攻击 ' + g.players[t.玩家]!.name, 种类: '玩家' as const, 玩家: t.玩家 }
        : { 标签: '攻击 ' + t.阵地, 种类: '阵地' as const, 玩家: t.玩家, 阵地: t.阵地 }),
    });
  }

  out.push({ 种类: '让过', 标签: '让过' });
  return out;
}
