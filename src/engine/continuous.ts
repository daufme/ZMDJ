import type { CardType, Faction, Supertype, 筛选, 筛选条件, 筛选属性, 层修改, Selector, StaticAbility, Ability, 关键词能力, 关键词能力条目, 事件名, 历史条件, 筛选比较 } from './types.js';
import type { GameState, Obj } from './state.js';
import { 相对阵地, 相邻阵地, 斜对阵地, 加事件记录, 写事件记录, 盖章 } from './state.js';
import type { 阵地 } from './types.js';

function 层值(v: unknown, 来源: Obj | null): number {
  if (typeof v === 'number') return v;
  if (!v || typeof v !== 'object') return 0;
  const o = v as Record<string, unknown>;
  if ('记忆' in o) return Number(来源?.记忆[String(o['记忆'])] ?? 0);

  if ('乘以' in o) return 层值(o['乘以'], 来源) * Number(o['系数'] ?? 0);

  if ('自身' in o) {
    if (!来源) return 0;
    const 什么 = String(o['自身']);
    if (什么 === '伤害') return 来源.damage;

    const 取数 = (x: unknown): number => (typeof x === 'number' ? x : 0);
    return 什么 === '体力上限' ? 取数(来源.def.体力上限) : 取数(来源.def.武力);
  }
  return 0;
}

export interface 特征 {
  名称: string;
  超类别: Supertype[];
  类别: CardType[];
  副类别: string[];
  势力: Faction[] | null;
  武力: number;
  体力上限: number;

  关键词: 关键词能力条目[];

  不能重置: boolean;
  失去所有能力: boolean;
  暗置: boolean;

  授予动作: { 动作: string; 参数?: Record<string, string | number | boolean> }[];
}

interface 候选效应 {
  时间印记: number;

  指定?: Obj;

  指定uid?: number;

  受锁定?: number[];
  来源: Obj | null;
  控制器: number;
  范围?: Selector;
  筛选?: 筛选;
  层: 层修改;
  是特征定义: boolean;
  条件?: unknown;
}

const 关键词标记表 = new Set(['洞察', '重整', '破竹', '强进', '隐匿', '斩获', '致命', '转移']);

function 基础特征(o: Obj): 特征 {
  if (o.面 === '暗置') {
    return {
      名称: '暗置领土', 超类别: [], 类别: ['领土'], 副类别: [],
      势力: null, 武力: 0, 体力上限: 0, 关键词: [], 失去所有能力: false, 不能重置: false, 暗置: true, 授予动作: [],
    };
  }
  const d = o.def;
  return {
    名称: d.名称[0] ?? d.全名,
    超类别: (d.超类别 ?? []).slice(),
    类别: (d.类别 ?? []).slice(),
    副类别: (d.副类别 ?? []).slice(),
    势力: d.势力 ? d.势力.slice() : null,
    武力: typeof d.武力 === 'number' ? d.武力 : 0,
    体力上限: typeof d.体力上限 === 'number' ? d.体力上限 : 0,

    关键词: ((d.能力?.能力 ?? []) as { 名称?: string; 数值?: number; 特征?: 筛选 }[])
      .filter((ab) => ab.名称 !== undefined && 能解析(ab.名称))

      .map((ab) => ({ 名称: ab.名称!, ...(ab.数值 !== undefined ? { 数值: ab.数值 } : {}), ...(ab.特征 !== undefined ? { 特征: ab.特征 } : {}), 印制: true })),
    失去所有能力: false,
    不能重置: false,
    暗置: false,
    授予动作: [],
  };
}

function 收集候选(g: GameState): 候选效应[] {
  const out: 候选效应[] = [];

  for (const o of g.战场) {
    {

      if (o.面 === '暗置') continue;
      const abs = (o.def.能力?.能力 ?? []) as {
        种类?: string;
        连续?: { 范围?: Selector; 筛选?: 筛选; 层: 层修改; 条件?: unknown };
        自身加成?: { 每个其他同名: { 武力?: number; 体力上限?: number } };
      }[];

      if (((o.def.能力?.能力 ?? []) as { 名称?: string }[]).some((x) => x.名称 === '同袍') && o.阵地) {
        const 自己 = g.players[o.操控者]!;
        const 邻 = 相邻阵地(o.阵地).map((s) => 自己.阵地[s])
          .filter((x): x is Obj => !!x && x !== o);

        const 共通 = 邻.filter((x) => x.def.副类别.some((c) => o.def.副类别.includes(c)));
        const 借 = new Set<string>();
        for (const x of [o, ...共通]) {
          for (const y of (x.def.能力?.能力 ?? []) as { 名称?: string }[]) {
            if (y.名称 && y.名称 !== '同袍') 借.add(y.名称);
          }
        }
        if (借.size) {
          out.push({
            时间印记: o.时间印记, 来源: o, 控制器: o.操控者, 指定: o,
            层: { 获得关键词: [...借].map((名) => ({ 名称: 名 })) }, 是特征定义: false,
          });
        }
      }

      for (const ab of abs) {
        if (ab.种类 !== '静止式') continue;
        if (ab.连续) {
          out.push({
            时间印记: o.时间印记, 来源: o, 控制器: o.操控者,
            范围: ab.连续.范围, 筛选: ab.连续.筛选, 层: ab.连续.层,
            是特征定义: ab.连续.层.定义武力 !== undefined || ab.连续.层.定义体力 !== undefined,
            条件: ab.连续.条件,
          });
        }
        if (ab.自身加成) {

          const 我 = o.操控者;
          const 其他 = g.战场.filter((x) =>
            x !== o && x.操控者 === 我 && x.def.名称.some((n) => o.def.名称.includes(n))).length;
          out.push({
            时间印记: o.时间印记, 来源: o, 控制器: o.操控者,

            范围: { 区域: '战场', 种类: '单位', 自身: true },
            层: {
              定义武力: (typeof o.def.武力 === 'number' ? o.def.武力 : 0) + (ab.自身加成.每个其他同名.武力 ?? 0) * 其他,
              定义体力: (typeof o.def.体力上限 === 'number' ? o.def.体力上限 : 0) + (ab.自身加成.每个其他同名.体力上限 ?? 0) * 其他,
            },
            是特征定义: true,
          });
        }
      }

      const 关键词标记 = (o.标记 ?? []).filter((m) => 关键词标记表.has(m.类型));
      if (关键词标记.length) {
        out.push({
          时间印记: Math.min(...关键词标记.map((m) => m.时间印记)), 来源: o, 控制器: o.操控者,
          层: { 获得关键词: 关键词标记.map((m) => ({ 名称: m.类型 })) }, 是特征定义: false,
        });
      }

      for (const m of o.标记 ?? []) {
        if (m.类型 === '+1/+1') {
          out.push({ 时间印记: m.时间印记, 来源: null, 控制器: o.操控者, 指定: o,
            层: { 增减武力: m.数量, 增减体力: m.数量 }, 是特征定义: false });
        } else if (m.类型 === '-1/-1') {
          out.push({ 时间印记: m.时间印记, 来源: null, 控制器: o.操控者, 指定: o,
            层: { 增减武力: -m.数量, 增减体力: -m.数量 }, 是特征定义: false });
        }
      }
    }
  }

  for (const e of g.连续效应 ?? []) {

    if (!e.载荷.层) continue;
    out.push({
      时间印记: e.时间印记, 来源: e.来源, 控制器: e.控制器, 范围: e.范围,
      层: e.载荷.层, 是特征定义: false,
      指定: e.指定 === undefined ? undefined : 找实体(g, e.指定), 指定uid: e.指定,
      受锁定: e.受锁定, 条件: e.条件,
    });
  }

  for (const e of g.tempEffects ?? []) {
    if (e.种类 !== '加成') continue;
    out.push({ 时间印记: e.时间印记 ?? 0, 来源: null, 控制器: 0, 指定: e.target,
      层: { 增减武力: e.武力, 增减体力: e.体力上限 }, 是特征定义: false });
  }
  return out;
}

function 无能力集合(g: GameState, 候选表: 候选效应[]): Set<number> {
  const s = new Set<number>();

  const 剥能力 = 候选表.filter((c) => c.层.失去所有能力);
  if (!剥能力.length) return s;
  for (const x of g.战场) {
    {
      const 基础 = 基础特征(x);
      for (const c of 剥能力) {
        if (c.来源 === x) continue;

        if (匹配(g, c, x, 基础)) { s.add(x.uid); break; }
      }
    }
  }
  return s;
}

export const 关键词解析表: Record<string, (n: number) => Ability> = {

  射击: (n) => ({
    种类: '启动式', 时机: '通常', 费用: { 横置: true },
    标签: '射击' + n + '：对目标斜对单位造成 ' + n + ' 点伤害',
    目标: [{ 目标名: 't', 数量: { 最小: 1, 最大: 1 }, 选择: { 区域: '战场', 种类: '单位', 关系: { anchor: '自身', 关系: '斜对' } } }],
    效应: [{ 操作: '伤害', 来源: '自身', 事件: [{ 受方: { 目标: 't' }, 点数: n }] }],
  } as unknown as Ability),

  佩带: (n) => ({
    种类: '启动式', 时机: '通常', 费用: { 通用: n },
    标签: '佩带' + n + '：佩带在由你操控的目标单位上',
    目标: [{ 目标名: 't', 数量: { 最小: 1, 最大: 1 }, 选择: { 区域: '战场', 种类: '单位', 操控者: '你' } }],
    效应: [{ 操作: '原生', 模块: '佩带' }],
  } as unknown as Ability),

  迎击: (n) => ({
    种类: '触发式', 触发: { 事件: '进入相对阵地' },
    效应: [{ 操作: '伤害', 来源: '自身', 事件: [{ 受方: { 目标: 't' }, 点数: n }] }],
  } as unknown as Ability),

  重整: () => ({
    种类: '触发式', 触发: { 事件: '步骤开始', 步骤: '结束步骤' },
    效应: [{ 操作: '重置', 目标: { ref: '自身' } }, { 操作: '回复', 目标: { ref: '自身' } }],
  } as unknown as Ability),

  伏击: (n) => ({ 种类: '静止式', 名称: '伏击', 数值: n }),
  神速: (n) => ({ 种类: '静止式', 名称: '神速', 数值: n }),
  致命: (n) => ({ 种类: '静止式', 名称: '致命', 数值: n }),
  洞察: (n) => ({ 种类: '静止式', 名称: '洞察', 数值: n }),
  据守: (n) => ({ 种类: '静止式', 名称: '据守', 数值: n }),
  斩获: (n) => ({ 种类: '静止式', 名称: '斩获', 数值: n }),
  坚韧: (n) => ({ 种类: '静止式', 名称: '坚韧', 数值: n }),
  坚阵: (n) => ({ 种类: '静止式', 名称: '坚阵', 数值: n }),
  不屈: (n) => ({ 种类: '静止式', 名称: '不屈', 数值: n }),
  暴击: (n) => ({ 种类: '静止式', 名称: '暴击', 数值: n }),
  压制: (n) => ({ 种类: '静止式', 名称: '压制', 数值: n }),
  转移: (n) => ({ 种类: '静止式', 名称: '转移', 数值: n }),

  抵抗: (n) => ({ 种类: '静止式', 名称: '抵抗', 数值: n }),

  附属: (n) => ({ 种类: '静止式', 名称: '附属', 数值: n }),

  再起: (n) => ({ 种类: '启动式', 时机: '通常', 费用: { 通用: n },
    标签: '再起' + n + '：将此牌从墓地移回战场', 效应: [{ 操作: '原生', 模块: '再起' }] }),
};

export function 关键词基名(名称: string): string {
  return 名称.replace(/[\d*]+$/, '');
}

export function 能解析(名称: string): boolean {
  return 名称 in 关键词解析表 || 关键词基名(名称) in 关键词解析表;
}

export function 解析能力(ab: Ability): Ability {
  if ((ab as { 种类?: string }).种类) return ab;
  const k = ab as 关键词能力;

  const 基名 = 关键词基名(k.名称);
  const 尾巴 = k.数值 === undefined && 基名 !== k.名称 ? Number(k.名称.slice(基名.length)) : undefined;
  const 定 = 关键词解析表[k.名称] ?? 关键词解析表[基名];
  if (!定) return ab;
  if (尾巴 !== undefined && Number.isFinite(尾巴)) k.数值 = 尾巴;

  return { ...定(k.数值 ?? 0), 名称: k.名称, ...(k.数值 !== undefined ? { 数值: k.数值 } : {}), ...(k.特征 ? { 特征: k.特征 } : {}) } as Ability;
}

export function 关键词数值(g: GameState, o: Obj, 名: string): number {

  const abs = (o.def.能力?.能力 ?? []) as { 名称?: string; 数值?: number }[];
  const 印 = abs.find((ab) => ab.名称 === 名)?.数值;
  if (印 !== undefined) return 印;

  if (o.区域 !== '战场') return 0;
  for (const k of 计算特征(g, o).关键词) {
    if (k.名称 === 名) return k.数值 ?? 0;

    if (k.名称.startsWith(名)) { const n = Number(k.名称.slice(名.length)); if (Number.isFinite(n)) return n; }
  }
  return 0;
}

export function 记事件(g: GameState, 事件: 事件名, x: { 来源?: number; 受方?: number; 数量?: number }): void {
  加事件记录(g, { 回合: g.turn, 步骤: g.当前步骤, 事件, ...x });
}

export function 发生过(g: GameState, o: Obj, 条: 历史条件): boolean {
  return g.事件记录.some((e) =>
    e.事件 === 条.事件
    && (条.时段 === undefined || 条.时段 === '这盘游戏'
      || (条.时段 === '本回合' && e.回合 === g.turn)
      || (条.时段 === '上回合' && e.回合 === g.turn - 1)
      || (条.时段 === '本步骤' && e.回合 === g.turn && e.步骤 === g.当前步骤))

    && (条.角色 === '来源' ? e.来源 === o.uid
      : 条.角色 === '受方' ? e.受方 === o.uid
        : e.来源 === o.uid || e.受方 === o.uid)
    && (条.数量 === undefined || 数量比较(e.数量 ?? 0, 条.数量)),
  );
}

function 数量比较(实际: number, c: { 比较: 筛选比较; 值: number }): boolean {
  if (c.比较 === '大于') return 实际 > c.值;
  if (c.比较 === '小于') return 实际 < c.值;
  if (c.比较 === '小于等于') return 实际 <= c.值;
  if (c.比较 === '大于等于') return 实际 >= c.值;
  return 实际 === c.值;
}

export function 符合选择器(g: GameState, o: Obj, sel: Selector | undefined, 锚: Obj | null, 控制器: number, f: 特征, 触发受方?: Obj | number, 记忆源?: Obj): boolean {
  if (!sel) return true;
  if (sel.自身) return o === 锚;

  if (sel.所附属) return !!锚 && 锚.附属在 !== undefined && 锚.附属在 === o.uid;

  if (sel.所佩带) return !!锚 && 锚.佩带在 !== undefined && 锚.佩带在 === o.uid;
  if (sel.除 === '自身' && o === 锚) return false;

  if (!符合筛选(g, o, sel.筛选, f, undefined, 记忆源)) return false;
  if (sel.已横置 !== undefined && o.tapped !== sel.已横置) return false;
  if (sel.区域 && o.区域 !== sel.区域) return false;
  if (sel.面 && o.面 !== sel.面) return false;
  if (sel.操控者 && sel.操控者 !== '任意') {

    const 控 = 有效控制器(g, o);
    if (sel.操控者 === '你') { if (控 !== 控制器) return false; }
    else if (sel.操控者 === '对手') { if (控 === 控制器) return false; }

    else if (typeof sel.操控者 === 'object' && 'ref' in sel.操控者) {

      if (触发受方 === undefined) return false;
      const 该 = typeof 触发受方 === 'number' ? 触发受方 : 有效控制器(g, 触发受方);
      if (控 !== 该) return false;
    }
  }

  if (sel.历史 && !sel.历史.every((c) => 发生过(g, o, c))) return false;

  const 符合种类 = (k: string): boolean =>
    k === '实体' || k === '物件' ? true
    : k === '令符' ? false
    : (f.类别 as string[]).includes(k);
  if (sel.种类 && !符合种类(sel.种类)) return false;
  if (sel.非种类 && 符合种类(sel.非种类)) return false;

  if (sel.相对阵地为空 !== undefined) {
    const 对面 = o.阵地 ? g.players[1 - 有效控制器(g, o)]?.阵地[相对阵地(o.阵地)!] : null;
    if (sel.相对阵地为空 !== !对面) return false;
  }
  if (sel.关系) {
    if (!锚 || !锚.阵地) return false;
    const 锚阵地 = 锚.阵地;
    const 自己 = g.players[锚.操控者]!;
    const 敌 = g.players[(锚.操控者 + 1) % g.players.length]!;
    const 名 = sel.关系.关系;
    const 允许 = 名 === '相对' ? [敌.阵地[相对阵地(锚阵地)!]]
      : 名 === '相邻' ? 相邻阵地(锚阵地).map((x) => 自己.阵地[x])
        : 斜对阵地(锚阵地).map((x) => 敌.阵地[x]);
    if (!允许.includes(o)) return false;
  }
  return true;
}

const 算操控权中 = new Set<number>();

export function 有效控制器(g: GameState, o: Obj): number {
  if (o.区域 !== '战场') return o.操控者;

  if (算操控权中.has(o.uid)) return o.操控者;
  算操控权中.add(o.uid);
  try { return 算有效控制器(g, o); } finally { 算操控权中.delete(o.uid); }
}
function 算有效控制器(g: GameState, o: Obj): number {

  const s = 取快照(g);
  const 有 = s.操控者.get(o.uid);
  if (有 !== undefined) return 有;
  const f = 计算到层(g, o, 2);
  const 层2 = s.候选.filter((c) => c.层.操控权 !== undefined && 匹配(g, c, o, f));
  if (!层2.length) { s.操控者.set(o.uid, o.操控者); return o.操控者; }
  层2.sort((a, b) => a.时间印记 - b.时间印记);
  const 尾 = 层2[层2.length - 1]!;
  const 值 = 尾.层.操控权 === '你' ? 尾.控制器 : o.操控者;
  if (!s.构建中) s.操控者.set(o.uid, 值);
  return 值;
}

function 匹配(g: GameState, c: 候选效应, o: Obj, f: 特征, 判断?: 条件判断): boolean {

  if (c.条件 && !条件成立(g, o, c.条件, c.来源, 判断)) return false;
  if (c.受锁定 && !c.受锁定.includes(o.uid)) return false;

  if (c.指定uid !== undefined) return c.指定uid === o.uid;
  if (c.指定) return c.指定 === o;
  if (!符合选择器(g, o, c.范围, c.来源, c.控制器, f)) return false;
  if (!符合筛选(g, o, c.筛选, f)) return false;
  return true;
}

export type 条件判断 = (c: unknown) => boolean;

function 条件成立(g: GameState, o: Obj, 条件: unknown, 来源: Obj | null, 判断?: 条件判断): boolean {
  const c = 条件 as { 操作?: string; 目标?: string };

  if (c.操作 === '附属在') return 来源?.附属在 !== undefined && 来源.附属在 === Number(c.目标);
  return 判断 ? 判断(条件) : true;
}

export function 无双名称(o: Obj): string | null {
  if (!(o.def.超类别 ?? []).includes('无双')) return null;
  const n = o.def.全名;
  const i = n.indexOf('·');
  return i >= 0 ? n.slice(i + 1) : n;
}

function 取印制值(o: Obj, a: 筛选属性): (string | number)[] {
  const d = o.def;
  switch (a) {
    case '类别': return d.类别;
    case '副类别': return d.副类别 ?? [];
    case '势力': return d.势力 ?? [];
    case '超类别': return d.超类别 ?? [];
    case '打出费用': return [typeof d.打出费用 === 'number' ? d.打出费用 : 0];
    case '伤害': return [o.damage];
    case '名称': return d.名称;
    case '全名': return [d.全名];
    case '称号': return d.称号 ? [d.称号] : [];
    case '无双名称': { const w = 无双名称(o); return w === null ? [] : [w]; }
    case '灵值': return d.灵值 === undefined ? [] : [d.灵值];
    case '武力': return typeof d.武力 === 'number' ? [d.武力] : [];
    case '体力上限': return typeof d.体力上限 === 'number' ? [d.体力上限] : [];

    default: return [];
  }
}

function 取特征值(g: GameState | undefined, o: Obj, a: 筛选属性, f: 特征): (string | number)[] {
  const d = o.def;
  switch (a) {
    case '类别': return f.类别;
    case '副类别': return f.副类别;
    case '势力': return f.势力 ?? [];
    case '超类别': return f.超类别;
    case '打出费用': return [typeof d.打出费用 === 'number' ? d.打出费用 : 0];
    case '伤害': return [o.damage];

    case '关键词': return g ? Object.keys(关键词解析表).filter((k) => 具有关键词(g, o, k)) : [];
    case '名称': return [f.名称];
    case '全名': return [d.全名];
    case '称号': return d.称号 ? [d.称号] : [];

    case '无双名称': { const w = 无双名称(o); return w === null ? [] : [w]; }
    case '灵值': return d.灵值 === undefined ? [] : [d.灵值];
    case '武力': return [f.武力];
    case '体力上限': return [f.体力上限];
    default: return [];
  }
}

function 符合一个条件(g: GameState, o: Obj, c: 筛选条件, f: 特征, 记忆源?: Obj): boolean {
  const 有的 = c.印制 ? 取印制值(o, c.属性) : 取特征值(g, o, c.属性, f);

  const 解一 = (v: unknown): string | number => (v && typeof v === 'object' && '记忆' in v)
    ? Number(记忆源?.记忆[String((v as { 记忆: string }).记忆)] ?? 0) : (v as string | number);
  const 值列: (string | number)[] = (c.值 === undefined ? [] : (Array.isArray(c.值) ? c.值 : [c.值])).map(解一);
  switch (c.比较 ?? '是') {
    case '是': return 值列.length === 0 ? 有的.length > 0 : 值列.some((v) => 有的.includes(v));
    case '不是': return !值列.some((v) => 有的.includes(v));
    case '包含': return 值列.some((v) => 有的.some((x) => String(x).includes(String(v))));
    case '不含': return !值列.some((v) => 有的.some((x) => String(x).includes(String(v))));
    case '大于': return 有的.some((x) => typeof x === 'number' && typeof 值列[0] === 'number' && x > 值列[0]);
    case '小于': return 有的.some((x) => typeof x === 'number' && typeof 值列[0] === 'number' && x < 值列[0]);

    case '小于等于': return 有的.some((x) => typeof x === 'number' && typeof 值列[0] === 'number' && x <= 值列[0]);
    case '大于等于': return 有的.some((x) => typeof x === 'number' && typeof 值列[0] === 'number' && x >= 值列[0]);
    default: return false;
  }
}

export function 符合筛选(g: GameState, o: Obj, 条件表?: 筛选, f?: 特征, 判断?: 条件判断, 记忆源?: Obj): boolean {
  if (!条件表 || 条件表.length === 0) return true;
  const 特征 = f ?? 计算特征(g, o, 判断);
  return 条件表.every((c) => 符合一个条件(g, o, c, 特征, 记忆源));
}

const 算特征中 = new Set<number>();
let 算特征深度 = 0;

export function 计算特征(g: GameState, o: Obj, 判断?: 条件判断): 特征 {
  return 计算到层(g, o, 7, 判断);
}

const 层栈: number[] = [];
export function 当前上限层(): number { return 层栈.length ? 层栈[层栈.length - 1]! : 7; }

export function 计算到层(g: GameState, o: Obj, 上限层: number, 判断?: 条件判断): 特征 {
  if (算特征中.has(o.uid)) return 基础特征(o);
  const s = 取快照(g);
  const 用判断 = 判断 !== undefined;

  const 可缓存 = typeof o.uid === 'number';
  const 键 = o.uid + ':' + 上限层 + ':' + (用判断 ? 1 : 0);
  if (可缓存 && !s.构建中) {
    const 有 = s.特征.get(键);
    if (有) return 有;
  }
  算特征中.add(o.uid);
  算特征深度++;
  层栈.push(上限层);
  try {

    const 值 = 计算特征内(g, o, 判断, 上限层);
    if (可缓存 && !s.构建中) s.特征.set(键, 值);
    return 值;
  } finally { 层栈.pop(); 算特征中.delete(o.uid); 算特征深度--; }
}

type 层键 = '层4' | '层5' | '层6' | '层7a' | '层7b' | '层7c' | '层7d';
interface 快照 {
  版本: number;
  候选: 候选效应[];
  可用候选: 候选效应[];
  无能力: Set<number>;
  桶: Partial<Record<层键, 候选效应[]>>;
  特征: Map<string, 特征>;
  操控者: Map<number, number>;
  构建中: boolean;
}
const 快照表 = new WeakMap<GameState, 快照>();

function 取快照(g: GameState): 快照 {
  const 版本 = g.状态版本 ?? 0;
  const 旧 = 快照表.get(g);
  if (旧 && 旧.版本 === 版本) return 旧;
  const s: 快照 = { 版本, 候选: [], 可用候选: [], 无能力: new Set(), 桶: {}, 特征: new Map(), 操控者: new Map(), 构建中: true };
  快照表.set(g, s);
  s.候选 = 收集候选(g);
  s.无能力 = 无能力集合(g, s.候选);
  s.可用候选 = s.候选.filter((c) => !(c.来源 && s.无能力.has(c.来源.uid)));
  s.构建中 = false;
  return s;
}

function 计算特征内(g: GameState, o: Obj, 判断?: 条件判断, 上限层 = 7): 特征 {
  const f = 基础特征(o);
  const s = 取快照(g);
  const 候选表 = s.候选;

  const 在战场 = o.区域 === '战场';

  const 无能力 = s.无能力;
  const 失去能力 = 无能力.has(o.uid);
  const 候选 = s.可用候选;
  f.失去所有能力 = 失去能力 || f.失去所有能力;

  const 桶 = (键: 层键, 谓: (c: 候选效应) => boolean): 候选效应[] => (s.桶[键] ??= 候选.filter(谓));
  void 候选表;
  const 适用 = (键: 层键, 谓: (c: 候选效应) => boolean): 候选效应[] =>
    桶(键, 谓).filter((c) => (在战场 || c.是特征定义) && 匹配(g, c, o, f, 判断))
      .sort((a, b) => a.时间印记 - b.时间印记);

  if (上限层 >= 4) for (const c of 适用('层4', (x) => x.层.类别 !== undefined || x.层.副类别 !== undefined || x.层.超类别 !== undefined || x.层.增加副类别 !== undefined)) {
    if (c.层.类别) f.类别 = c.层.类别.slice();
    if (c.层.超类别) f.超类别 = c.层.超类别.slice();
    if (c.层.副类别) f.副类别 = c.层.副类别.slice();

      if (c.层.增加副类别?.length) f.副类别 = [...new Set([...f.副类别, ...c.层.增加副类别])];
  }

  if (上限层 >= 5) for (const c of 适用('层5', (x) => x.层.势力 !== undefined)) f.势力 = c.层.势力!.slice();

  const 层6 = (上限层 >= 6 ? 适用('层6', (x) => x.层.获得关键词 !== undefined || x.层.失去所有能力 !== undefined
    || x.层.授予动作 !== undefined || x.层.不能重置 !== undefined) : []);
  层6.sort((a, b) => Number(b.是特征定义) - Number(a.是特征定义) || a.时间印记 - b.时间印记);
  for (const c of 层6) {
    if (c.层.失去所有能力) { f.失去所有能力 = true; }

    if (c.层.不能重置) { f.不能重置 = true; }

    if (c.层.获得关键词) {

      f.关键词 = [...f.关键词, ...c.层.获得关键词.map((k) => ({ ...k, 印制: false }))];
    }

    if (c.层.授予动作) {
      for (const a of c.层.授予动作) {
        f.授予动作 = [...f.授予动作.filter((x) => x.动作 !== a.动作), a];
      }
    }
  }
  if (上限层 < 7) return f;

  for (const c of 适用('层7a', (x) => x.层.定义武力 !== undefined || x.层.定义体力 !== undefined)) {
    if (c.层.定义武力 !== undefined) f.武力 = typeof c.层.定义武力 === 'number' ? c.层.定义武力 : 0;
    if (c.层.定义体力 !== undefined) f.体力上限 = typeof c.层.定义体力 === 'number' ? c.层.定义体力 : 0;
  }

  for (const c of 适用('层7b', (x) => x.层.设定武力 !== undefined || x.层.设定体力 !== undefined)) {
    if (c.层.设定武力 !== undefined) f.武力 = typeof c.层.设定武力 === 'number' ? c.层.设定武力 : 0;
    if (c.层.设定体力 !== undefined) f.体力上限 = typeof c.层.设定体力 === 'number' ? c.层.设定体力 : 0;
  }

  for (const c of 适用('层7c', (x) => x.层.增减武力 !== undefined || x.层.增减体力 !== undefined)) {

    f.武力 += 层值(c.层.增减武力 ?? 0, c.来源);
    f.体力上限 += 层值(c.层.增减体力 ?? 0, c.来源);
  }

  for (const c of 适用('层7d', (x) => x.层.交换武力体力 === true)) {
    const t = f.武力; f.武力 = f.体力上限; f.体力上限 = t;
  }
  f.武力 = Math.max(0, f.武力);
  f.体力上限 = Math.max(0, f.体力上限);
  return f;
}

function 找实体(g: GameState, uid: number): Obj | undefined {
  for (const o of g.战场) if (o.uid === uid) return o;
  return undefined;
}

export function 属于类别(g: GameState, o: Obj, 类别: CardType, 判断?: 条件判断): boolean {
  return 计算特征(g, o, 判断).类别.includes(类别);
}

export function 具有关键词(g: GameState, o: Obj, 关键词: string, 判断?: 条件判断): boolean {
  return 计算特征(g, o, 判断).关键词.some((k) => k.名称 === 关键词);
}
