import type { 事件名,
  CardDef, 阵地, Support, SupportMap, ResolveStep, Condition, Value,
  TargetSpec, Selector, TriggeredAbility, ActivatedAbility, ModeSpec, StaticAbility, RecipientRef, ReplacementSpec,
  指示物定义, 筛选, 规则限制, 自身限制, 费用修正,
  筛选属性, 筛选条件, Ability, 关键词能力 , 玩家动作, 玩家指向 } from './types.js';
import { 阵地顺序 } from './types.js';
import type { GameState, Obj, PlayerState, StackItem, TempEffect, Zone } from './state.js';
import { 势力支持度, 造对象, 相对阵地, 相邻阵地, 斜对阵地, 盖时间印记, 盖时间印记翻面, 盖章,
  写面, 写横置, 写阵地, 写区域, 写操控者, 写整备, 写伤害, 写附属在, 写佩带在, 写时间印记,
  加标记, 写标记表, 清标记, 改标记数量, 改标记, 写记忆, 清记忆,
  战场加, 战场删, 写战场, 加连续效应, 写连续效应, 加临时效应, 写临时效应, 加事件记录, 写事件记录,
  堆叠加, 堆叠弹出, 堆叠取第, 清检视, 登记检视表 } from './state.js';
import { 计算特征, 计算到层, 当前上限层, type 特征 as 特征类型, 符合选择器, 符合筛选, 无双名称, 关键词数值, 解析能力, 能解析, 记事件, 有效控制器 } from './continuous.js';

export const 起始体力 = 30;
export const 手牌上限 = 7;

export function 手牌上限为(g: GameState, p: number): number {
  let n = 手牌上限;
  for (const o of g.战场) {
    if (o.面 !== '明置') continue;
    const 能 = 有效控制器(g, o);
    for (const ab of o.def.能力?.能力 ?? []) {

      if (!('手牌上限修正' in ab) || !ab.手牌上限修正) continue;
      for (const m of ab.手牌上限修正) if ((m.适用 === '你') === (能 === p)) n += m.手牌上限;
    }
  }
  return Math.max(0, n);
}

export interface 候选 { obj: Obj | null; 玩家: number | null; 堆叠项?: number }

export function 取实体(t: 目标 | undefined | null): Obj | null {
  if (t === undefined || t === null || typeof t === 'number') return null;
  return '堆叠项' in t ? null : t;
}

export function 取堆叠项(t: 目标 | undefined | null): number | undefined {
  return t && typeof t === 'object' && '堆叠项' in t ? t.堆叠项 : undefined;
}

export type 目标 = Obj | number | { 堆叠项: number };

export type 攻击对象 =
  | { 种类: '玩家'; 玩家: number }
  | { 种类: '阵地'; 玩家: number; 阵地: 阵地 };

export type Action =
  | { 种类: '打领土'; card: Obj; 面: '明置' | '暗置' }

  | { 种类: '转移'; card: Obj; 到: 阵地; 路径?: '转移' | '许可' }

  | { 种类: '施放'; card: Obj; 目标: 目标[]; 阵地?: 阵地; 模式号?: number; X?: number; 支付源?: number[] ; 额外牺牲?: number[] }
  | { 种类: '发起战斗'; card: Obj; 目标: 攻击对象;  支付源?: number[] }

  | { 种类: '启动能力'; card: Obj; 能力索引: number; 目标?: 目标[]; 支付源?: number[]; 模式号?: number; 费用弃牌?: number[]; 费用牺牲?: number[]; 费用弃牌数?: number; 费用牺牲数?: number; 费用X?: boolean; 宣告X?: number }
  | { 种类: '宣告'; 模式?: number; 目标: { 目标名: string; 类型: '实体' | '玩家'; uid?: number; 玩家?: number }[] }

  | { 种类: '决定'; 接受: boolean; 弃牌?: number[]; 选?: (number | string)[]; 先手?: number; 张数?: number }
  | { 种类: '让过' };

export type 策略 = (g: GameState, p: number, opts: 时机选项) => Action | null;
export interface 时机选项 { 允许打领土: boolean; 允许通常时机: boolean }

export function 记录(g: GameState, s: string): void { g.log.push('[T' + g.turn + '] ' + s); }

export function 洗牌<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]!; a[i] = a[j]!; a[j] = t;
  }
  return a;
}

export function 新对局(牌组: CardDef[][], 随机: () => number, 选项?: { 自动开局?: boolean; 起手牌数?: number }): GameState {
  const 起手 = 选项?.起手牌数 ?? 起手牌数_默认;
  const g: GameState = {
    players: [], 战场: [], active: 0, stack: [], pending: [], tempEffects: [], 连续效应: [],
    守望: [],
    turn: 0, log: [], nextUid: 1, nextStackId: 1, nextPendingId: 1, nextStamp: 1, 当前步骤: '', 战斗中: false, over: false, winner: null, 事件记录: [],
    放逐区: [], 可见登记: [], 先手玩家: 0, 开局: null, 随机源: 随机,
  };
  牌组.forEach((list, i) => {
    const p: PlayerState = {
      index: i, name: i === 0 ? '甲' : '乙',
      体力: 起始体力, lifeMax: 起始体力,
      library: [], hand: [], graveyard: [],
      阵地: { 左边路: null, 左侧翼: null, 中路: null, 右侧翼: null, 右边路: null },
      landsPlayedThisTurn: 0, drewFromEmptyLibrary: false, 跳过: {}, 标记: {}, 统帅区: [], 限制: [],
    };
    g.players.push(p);

    for (const def of 洗牌(list, 随机)) p.library.push(造对象(g, def, i, '牌库'));
  });
  记录(g, '对局开始：双方体力 ' + 起始体力);

  const 人数 = 牌组.length;
  g.开局 = {
    起手牌数: 起手,
    调度张数: Array.from({ length: 人数 }, () => null as number | null),
    已宣告: Array.from({ length: 人数 }, () => false),
    已执行: Array.from({ length: 人数 }, () => false),
  };
  if (选项?.自动开局 !== false) {
    决定先手(g, 随机() < 0.5 ? 0 : 1);
    开局直接完成(g);
  }
  return g;
}

const 起手牌数_默认 = 7;

export function 决定先手(g: GameState, 先手玩家: number): void {
  const o = g.开局;
  if (!o) return;
  g.先手玩家 = 先手玩家;
  g.active = 先手玩家;
  记录(g, '103.1：' + g.players[先手玩家]!.name + ' 成为先手');
  if (!o.已宣告.some((x) => x) && g.players.every((pl) => pl.hand.length === 0)) {

    for (const pl of g.players) 抓牌(g, pl.index, o.起手牌数, true);
    记录(g, '103.4：双方各抓 ' + o.起手牌数 + ' 张起手牌');
  }
}

export function 宣告调度(g: GameState, p: number, n: number): boolean {
  const o = g.开局;
  if (!o || o.已宣告[p]) return false;
  const pl = g.players[p]!;
  const 下限 = Math.max(0, o.起手牌数 - pl.hand.length);
  if (!Number.isInteger(n) || n < 下限 || n > pl.hand.length) return false;
  o.调度张数[p] = n;
  o.已宣告[p] = true;
  记录(g, pl.name + ' 宣告调度 ' + n + ' 张');
  return true;
}

export function 执行调度(g: GameState, p: number, uids: number[]): boolean {
  const o = g.开局;
  if (!o || o.已执行[p]) return false;
  const pl = g.players[p]!;
  const n = o.调度张数[p] ?? 0;
  if (n === 0) { o.已执行[p] = true; return true; }
  if (uids.length !== n) return false;
  const 暂放: Obj[] = [];
  for (const uid of uids) {
    const c = pl.hand.find((x) => x.uid === uid);
    if (!c) return false;
    暂放.push(c);
  }

  for (const c of 暂放) 移到区域(g, c, '放逐区');
  抓牌(g, p, o.起手牌数 - pl.hand.length, true);
  for (const c of 暂放) 移到区域(g, c, '牌库');
  pl.library = 洗牌(pl.library, g.随机源);
  记录(g, pl.name + ' 调度 ' + n + ' 张，抓回 ' + o.起手牌数 + ' 张后洗回牌库');
  o.已执行[p] = true;
  return true;
}

function 检视区域(g: GameState, 看的人: number, 玩家们: number[],
  哪个区域: '手牌' | '牌库顶' | '牌库' | '墓地' | '放逐区' | '战场',
  只看顶几张?: number): { 牌: Obj[]; 谁们的: string[] } {

  清检视(g);
  const 牌: Obj[] = [];
  const 谁们的: string[] = [];
  for (const p of 玩家们) {
    const pl = g.players[p]!;
    const 堆 = 哪个区域 === '手牌' ? pl.hand
      : 哪个区域 === '牌库' ? (只看顶几张 === undefined ? pl.library : pl.library.slice(-只看顶几张))
      : 哪个区域 === '牌库顶' ? (pl.library.length ? [pl.library[pl.library.length - 1]!] : [])
      : 哪个区域 === '墓地' ? pl.graveyard
      : 哪个区域 === '放逐区' ? g.放逐区
      : g.战场;
    for (const c of 堆) 登记检视(g, 看的人, c);
    牌.push(...堆);
    谁们的.push(pl.name + ' 的' + (哪个区域 === '牌库顶' ? '牌库顶' : 哪个区域));
  }
  if (牌.length) 记录(g, g.players[看的人]!.name + ' 检视 ' + 谁们的.join('、') + '（仅他可见，日志不记牌名）');
  return { 牌, 谁们的 };
}

export function 登记检视(g: GameState, 玩家: number, o: Obj): void {
  登记检视表(g, 玩家, o.uid);
}

export function 后手决定顶牌去向(g: GameState, 保留: boolean): boolean {
  const o = g.开局;
  if (!o) return false;
  const 后 = (g.先手玩家 + 1) % g.players.length;
  const pl = g.players[后]!;
  const 顶 = pl.library[pl.library.length - 1];
  if (顶 && !保留) { pl.library.pop(); pl.library.unshift(顶); }
  记录(g, '103.6：' + pl.name + (保留 ? ' 将牌库顶牌留在牌库顶' : ' 将牌库顶牌置于牌库底'));
  return true;
}

export function 开局直接完成(g: GameState): void {
  const o = g.开局;
  if (!o) return;
  if (g.players.every((pl) => pl.hand.length === 0)) {
    for (const pl of g.players) 抓牌(g, pl.index, o.起手牌数, true);
  }
  for (const pl of g.players) { o.调度张数[pl.index] = 0; o.已宣告[pl.index] = true; o.已执行[pl.index] = true; }
  g.开局 = null;
}

export function 抓牌(g: GameState, p: number, n: number, 起始: boolean = false): void {
  const pl = g.players[p]!;
  let 实抓 = 0;
  for (let i = 0; i < n; i++) {
    if (pl.library.length === 0) {

      pl.drewFromEmptyLibrary = true;
      if (!起始) 记录(g, pl.name + ' 试图从空牌库抓牌');
      break;
    }
    const card = pl.library[pl.library.length - 1]!;
    移到区域(g, card, '手牌');
    实抓++;
  }
  if (!起始 && 实抓 > 0) {
    记录(g, pl.name + ' 抓 ' + 实抓 + ' 张牌');

    记事件(g, '抓牌', { 受方: p, 数量: 实抓 });
    排队事件触发(g, '抓牌', p);
  }
}

export function 关键词特征(g: GameState, o: Obj, 名称: string): 筛选 | undefined {
  for (const k of 有效特征(g, o).关键词) if (k.名称 === 名称) return k.特征;
  return undefined;
}

export function 有带特征的关键词(g: GameState, o: Obj, 名称: string): boolean {
  return 有效特征(g, o).关键词.some((k) => k.名称 === 名称);
}

export function 抵抗挡得住目标(g: GameState, o: Obj, 来源: Obj | null): boolean {
  if (!有带特征的关键词(g, o, '抵抗')) return false;
  const 特 = 关键词特征(g, o, '抵抗');
  if (!特) return true;
  if (!来源) return false;
  return 符合筛选(g, 来源, 特, 有效特征(g, 来源));
}

export function 抵抗挡住伤害(g: GameState, o: Obj, 来源: Obj | null): boolean {
  return 抵抗挡得住目标(g, o, 来源);
}

export function 有词(g: GameState, o: Obj, 名称: string): boolean {

  const f = 有效特征(g, o);
  if (f.失去所有能力) return false;

      return f.关键词.some((k) => k.名称 === 名称);
}

export function 词值(g: GameState, o: Obj, 名称: string): number {

  for (const k of 有效特征(g, o).关键词) {
    if (k.名称 === 名称) return k.数值 ?? 0;
  }
  return 0;
}

export function 带词(g: GameState, o: Obj, 名称: string): boolean {
  return 词值(g, o, 名称) > 0 || 有词(g, o, 名称);
}

export function 有效特征(g: GameState, o: Obj): 特征类型 {

  return 计算到层(g, o, 当前上限层(), (c) => 判断(g, 有效控制器(g, o), c as Condition, o));
}

export function 灵值(g: GameState, o: Obj): number {
  if (o.区域 !== '战场') return o.def.灵值 ?? 0;
  return o.标记.filter((m) => m.类型 === '灵值').reduce((s, m) => s + m.数量, 0);
}

export function 武力(g: GameState, o: Obj): number {
  let v = 有效特征(g, o).武力;

  if (o.阵地) {
    const 对面 = g.players[1 - 有效控制器(g, o)]?.阵地[相对阵地(o.阵地)!];
    if (对面 && 对面 !== o) v -= 词值(g, 对面, '压制');
  }
  return v;
}

export function 体力上限(g: GameState, o: Obj): number { return 有效特征(g, o).体力上限; }

export function 是类别(g: GameState, o: Obj, 类别: string): boolean {
  return 有效特征(g, o).类别.includes(类别 as never);
}

export function 有必须发起战斗(g: GameState, o: Obj): boolean {
  if (o.面 === '暗置') return false;
  return ((o.def.能力?.能力 ?? []) as StaticAbility[]).some((ab) => ab.必须发起战斗 === true);
}
export function 有自身限制(g: GameState, o: Obj, 哪种: 自身限制): boolean {
  if (o.面 === '暗置') return false;
  return ((o.def.能力?.能力 ?? []) as StaticAbility[]).some((ab) => (ab.自身限制 ?? []).includes(哪种));
}
export function 有限制(g: GameState, p: number, 禁止: 规则限制['禁止']): boolean {

  for (const o of g.战场) {
    if (有效控制器(g, o) !== p) continue;
    if (!有规则叙述(g, o)) continue;

    const 全部 = ((o.def.能力?.能力 ?? []) as StaticAbility[]).flatMap((ab) => ab.规则限制 ?? []);
    for (const r of 全部) {
      if (r.禁止 === 禁止 && (r.适用 !== '你' || o.操控者 === p)) return true;
    }
  }
  return false;
}

export function 有规则叙述(g: GameState, o: Obj): boolean {
  if (o.区域 !== '战场') return true;
  if (o.面 === '暗置') return false;
  return !有效特征(g, o).失去所有能力;
}

export function 排队面触发(g: GameState, o: Obj, 面: '明置' | '暗置', 施动者: number, 变化前: 特征类型): void {

  void 施动者;
  排队单位事件触发(g, 面, o, { 触发受方: o, 特征覆盖: 变化前 });
}

export function 设面(g: GameState, o: Obj, 面: '明置' | '暗置', 施动者?: number): boolean {
  if (o.面 === 面) return false;

  const 变化前 = 有效特征(g, o);
  const 谁 = 施动者 ?? 有效控制器(g, o);
  写面(g, o, 面);
  记录(g, o.def.全名 + ' 被' + 面);
  记事件(g, 面, { 受方: o.uid });
  排队面触发(g, o, 面, 谁, 变化前);
  return true;
}

export function 满足势力需求(g: GameState, p: number, req: { 符号: SupportMap; 混色?: { a: Support; b: Support }[] } | undefined): boolean {
  if (!req) return true;
  const sup = 势力支持度(g, p);
  const need: SupportMap = {};
  for (const [k, v] of Object.entries(req.符号)) need[k as Support] = v as number;
  const 混色 = req.混色 ?? [];

  const rec = (i: number): boolean => {
    if (i === 混色.length) {
      for (const k of Object.keys(need)) if ((sup[k as Support] ?? 0) < (need[k as Support] ?? 0)) return false;
      return true;
    }
    const h = 混色[i]!;
    for (const k of [h.a, h.b]) {
      need[k] = (need[k] ?? 0) + 1;
      const ok = rec(i + 1);
      need[k] = (need[k] ?? 0) - 1;
      if (ok) return true;
    }
    return false;
  };
  return rec(0);
}

interface 费用来源 { obj: Obj; 提供: number; 牺牲: boolean }

function 收集费用来源(g: GameState, p: number): 费用来源[] {
  const out: 费用来源[] = [];
  for (const o of g.战场) {
    if (有效控制器(g, o) !== p) continue;
    if (!是类别(g, o, '领土') || o.tapped || o.区域 !== '战场') continue;

    out.push({ obj: o, 提供: 1, 牺牲: false });

    for (const ab of (o.def.能力?.能力 ?? []) as ActivatedAbility[]) {
      if (ab.种类 === '启动式' && ab.是费用能力 && ab.提供 && ab.费用.横置) {
        out.push({ obj: o, 提供: ab.提供, 牺牲: !!ab.费用.牺牲自身 });
      }
    }
  }
  return out;
}

export function 支付数字费用(g: GameState, p: number, 点数: number, 指定?: number[]): boolean {
  if (点数 <= 0) return true;
  const 来源 = 收集费用来源(g, p);
  if (指定) {

    const 挑: 费用来源[] = [];
    const 见过 = new Set<number>();
    for (const uid of 指定) {
      if (见过.has(uid)) continue;
      见过.add(uid);
      const s2 = 来源.find((x) => x.obj.uid === uid);
      if (s2) 挑.push(s2);
    }
    const 够 = 挑.reduce((n, s) => n + s.提供, 0);
    if (够 < 点数) {
      记录(g, '支付失败：挑了 ' + 挑.length + ' 个来源，只能提供 ' + 够 + '，需要 ' + 点数 + '（118.3 必须全额支付）');
      return false;
    }

    const 用: 费用来源[] = []; let acc = 0;
    for (const s of 挑) { if (acc >= 点数) break; 用.push(s); acc += s.提供; }
    for (const s of 用) { 写横置(g, s.obj, true); if (s.牺牲) 牺牲(g, s.obj); }
    return true;
  }

  记录(g, '支付失败：这张牌要付 ' + 点数 + ' 点数字费用，请先挑要启动的领土（304.8）');
  return false;
}

export function 可支付来源(g: GameState, p: number): { uid: number; 名称: string; 提供: number; 牺牲: boolean }[] {
  return 收集费用来源(g, p).map((s) => ({ uid: s.obj.uid, 名称: s.obj.def.全名, 提供: s.提供, 牺牲: s.牺牲 }));
}

export function 可支付上限(g: GameState, p: number): number {
  let n = 0;
  while (n < 40 && 可支付数字费用(g, p, n + 1)) n++;
  return n;
}

export function 可支付数字费用(g: GameState, p: number, 点数: number): boolean {
  if (点数 <= 0) return true;
  const 来源 = 收集费用来源(g, p);
  let acc = 0;
  for (const s of 来源) if (!s.牺牲) acc += s.提供;
  if (acc >= 点数) return true;
  for (const s of 来源) if (s.牺牲) acc += s.提供;
  return acc >= 点数;
}

export function 牺牲(g: GameState, o: Obj): void {

  置入墓地(g, o);
  记录(g, 牺牲名(o) + ' 被牺牲');
}

function 牺牲名(o: Obj): string { return o.def.全名; }

export function 处于通常时机(g: GameState, p: number): boolean {
  return p === g.active
    && g.当前步骤 === '行动阶段'
    && !g.战斗中
    && g.stack.length === 0;
}

export function 授予动作(g: GameState, o: Obj, 动作: string) {
  return 有效特征(g, o).授予动作.find((x) => x.动作 === 动作);
}

function 我的空阵地(g: GameState, o: Obj): 阵地[] {
  if (o.区域 !== '战场' || !o.阵地) return [];

  const pl = g.players[有效控制器(g, o)]!;
  return [...阵地顺序].filter((s) => !pl.阵地[s]);
}

export function 转移关键词目标(g: GameState, o: Obj): 阵地[] {
  if (o.区域 !== '战场' || !o.阵地) return [];
  return 相邻阵地(o.阵地).filter((s) => 我的空阵地(g, o).includes(s));
}

export function 许可目标(g: GameState, o: Obj): 阵地[] {
  const 授 = 授予动作(g, o, '移动');

  return (授?.参数 as { 目的地?: string } | undefined)?.目的地 === '相邻空阵地'
    ? 相邻阵地(o.阵地!).filter((s) => 我的空阵地(g, o).includes(s))
    : 我的空阵地(g, o);
}

export function 转移目标(g: GameState, o: Obj): 阵地[] {
  return [...new Set([
    ...(有词(g, o, '转移') ? 转移关键词目标(g, o) : []),
    ...(授予动作(g, o, '移动') ? 许可目标(g, o) : []),
  ])];
}

function 本回合用过的能力(o: Obj, 回合: number): number[] {
  const m = o.记忆['本回合已用能力'] as { 回合: number; 索引: number[] } | undefined;
  return m && m.回合 === 回合 ? m.索引 : [];
}

export function 能转移(g: GameState, p: number, o: Obj): boolean {
  if (p !== g.active) return false;

  if (有效控制器(g, o) !== p) return false;
  if (!有词(g, o, '转移')) return false;
  if (o.sick) return false;
  if (o.记忆['本回合已转移'] === g.turn) return false;
  if (!处于通常时机(g, p)) return false;
  return 转移关键词目标(g, o).length > 0;
}

export function 能移动许可(g: GameState, p: number, o: Obj): boolean {
  if (p !== g.active) return false;
  if (有效控制器(g, o) !== p) return false;
  if (!授予动作(g, o, '移动')) return false;

  if (o.记忆['本回合已移动许可'] === g.turn) return false;
  if (!处于通常时机(g, p)) return false;
  return 许可目标(g, o).length > 0;
}

export function 能移动(g: GameState, p: number, o: Obj): boolean {
  return 能转移(g, p, o) || 能移动许可(g, p, o);
}

export function 转移(g: GameState, p: number, o: Obj, 到: 阵地, 路径: '转移' | '许可' = '转移'): void {

  const 可以 = 路径 === '许可' ? 能移动许可(g, p, o) : 能转移(g, p, o);
  const 目标表 = 路径 === '许可' ? 许可目标(g, o) : 转移关键词目标(g, o);
  if (!可以) { 记录(g, '移动：现在不能' + (路径 === '许可' ? '用这条许可' : '转移')); return; }
  if (!目标表.includes(到)) { 记录(g, '移动：' + 到 + ' 不是这条能力能去的空阵地'); return; }
  const pl = g.players[有效控制器(g, o)]!;
  pl.阵地[o.阵地!] = null;
  写阵地(g, o, 到);
  pl.阵地[到] = o;

  写记忆(g, o, 路径 === '许可' ? '本回合已移动许可' : '本回合已转移', g.turn);
  记录(g, o.def.全名 + (路径 === '许可' ? ' 移动（116.2c 许可）：' : ' 转移（702.16）：') + 到);
}

export function 能打出领土(g: GameState, p: number, o: Obj, 面: '明置' | '暗置' = '明置'): boolean {
  const pl = g.players[p]!;
  if (p !== g.active) return false;
  if (o.区域 !== '手牌') return false;
  if (pl.landsPlayedThisTurn >= 1) return false;
  if (!处于通常时机(g, p)) return false;

  if (面 === '明置' && 有限制(g, p, '打出明置领土')) return false;
  if (面 === '明置') return o.def.类别.includes('领土');
  return true;
}

export function 能施放(g: GameState, p: number, o: Obj): { ok: boolean; reason?: string } {
  const 通常时机 = 处于通常时机(g, p);
  if (o.区域 !== '手牌') return { ok: false, reason: '不在手牌' };

  if (玩家被禁(g, p, '打出牌', o)) return { ok: false, reason: '本回合不能打出这张牌（613.10）' };
  if (o.def.类别.includes('领土')) return { ok: false, reason: '领土走特殊动作' };

  const 有许可 = (视同: '伏击'): boolean => {
    for (const x of g.战场) {
      if (x.面 === '暗置' || 有效控制器(g, x) !== p) continue;
      for (const ab of (x.def.能力?.能力 ?? []) as StaticAbility[]) {
        if (ab.种类 !== '静止式' || !ab.打出许可) continue;
        for (const r of ab.打出许可) {
          if (r.视同 !== 视同) continue;
          if (r.筛选 && !符合筛选(g, { def: o.def } as Obj, r.筛选, 有效特征(g, { def: o.def } as Obj))) continue;
          return true;
        }
      }
    }
    return false;
  };
  const 瞬发 = ((o.def.类别 ?? []).includes('锦囊') && (o.def.超类别 ?? []).includes('瞬发'))
    || 有词(g, o, '伏击') || 有许可('伏击');
  if (!瞬发 && !通常时机) return { ok: false, reason: '需要通常时机' };
  if (!满足势力需求(g, p, o.def.势力需求)) return { ok: false, reason: '势力需求不足' };
  return { ok: true };
}

export function 打出领土(g: GameState, p: number, o: Obj, 面: '明置' | '暗置'): void {
  const pl = g.players[p]!;

  if (!pl.hand.includes(o)) { 记录(g, '⚠ 打出领土：这张牌不在 ' + pl.name + ' 的手牌里，忽略'); return; }
  pl.landsPlayedThisTurn++;

  写面(g, o, 面);

  if (是类别(g, o, '单位')) {
    const 空 = 阵地顺序.filter((s2) => !g.players[p]!.阵地[s2]);
    if (空.length) { 记录(g, '301.11：' + o.def.全名 + ' 需要选择阵地（此处由调用方保证已选）'); }
    进战场(g, o, p, 空[0] ?? null);
  } else 进战场(g, o, p, null);
  记录(g, pl.name + ' 打出领土 ' + o.def.全名 + '（' + 面 + '）');
}

export function 施放(g: GameState, p: number, o: Obj, 目标: 目标[], 阵地?: 阵地, 模式号?: number, X?: number, 支付源?: number[], 额外牺牲?: number[]): void {
  const pl = g.players[p]!;

  const 宣告X = o.def.打出费用 === 'X' ? Math.max(0, Math.floor(X ?? 0)) : 0;

  const 总费用 = o.def.打出费用 === 'X' ? 宣告X : 实际打出费用(g, p, o.def);
  if (!支付数字费用(g, p, 总费用, 支付源)) { 记录(g, '支付失败：' + o.def.全名); return; }

  let 牺牲的: Obj | undefined;
  if (o.def.额外费用?.牺牲) {
    const 选 = (额外牺牲 ?? []).map((uid) => g.战场.find((x) => x.uid === uid))
      .filter((x): x is Obj => !!x && 有效控制器(g, x) === p && (!o.def.额外费用!.牺牲!.筛选 || 符合筛选(g, x, o.def.额外费用!.牺牲!.筛选)));
    if (选.length < o.def.额外费用.牺牲.数量) { 记录(g, o.def.全名 + '：额外费用（牺牲）付不出，打出失败'); return; }
    const 祭品 = 选[0]!;
    牺牲的 = 祭品;
    牺牲(g, 祭品);
    记录(g, g.players[p]!.name + ' 为 ' + o.def.全名 + ' 额外牺牲了 ' + 祭品.def.全名 + '（打出费用，602.1d）');
  }

  const 目标槽: Record<string, 目标> = {};
  (o.def.能力?.目标 ?? []).forEach((spec, i) => {
    const t = 目标[i];
    if (t !== undefined) 目标槽[spec.目标名] = t;
  });
  const item: StackItem = {
    id: g.nextStackId++, 种类: '令符', 标签: o.def.全名, 操控者: p,
    来源: null, card: o, 目标, 目标槽, chosenSlot: 阵地, chosenMode: 模式号,
    宣告X,
    额外牺牲: 牺牲的,
    steps: o.def.能力?.牌效应 ?? [],
  };
  堆叠加(g, item);

  从当前区域摘除(g, o);
  写区域(g, o, '堆叠');

  记事件(g, '打出牌', { 受方: o.uid, 数量: p, 来源: o.uid });

  for (const t2 of 目标) if (typeof t2 !== 'number' && 'uid' in t2) 记事件(g, '被指定为目标', { 受方: t2.uid, 来源: o.uid });
  排队被指定为目标触发(g, 目标, o);

  排队事件触发(g, '打出牌', p, o);
  记录(g, pl.name + ' 打出 ' + o.def.全名 + '（费用 ' + 总费用 + (o.def.打出费用 === 'X' ? '，X=' + 宣告X : '') + '）' +
    (目标.length ? '，目标：' + 目标.map((t) => 目标名(g, t)).join('、') : '') +
    (阵地 ? '，阵地：' + 阵地 : ''));
}

function 目标名(g: GameState, t: 目标): string {
  if (typeof t === 'number') return g.players[t]!.name;
  if ('堆叠项' in t) { const it = g.stack.find((x) => x.id === t.堆叠项); return it ? it.标签 : '（已不在堆叠的能力）'; }
  return t.def.全名;
}

function 目标对象(t: 目标): Obj | null { return 取实体(t); }

export function 能填满所有槽(g: GameState, 操控者: number, 规格: TargetSpec[], 锚?: Obj | null): boolean {
  const 需要: 候选[][] = [];
  for (const sp of 规格) {
    const c = 候选目标(g, 操控者, sp, 锚 ?? null);

    for (let i = 0; i < sp.数量.最小; i++) 需要.push(c);
  }
  if (需要.length === 0) return true;
  const 键 = (x: 候选): string => (x.obj ? 'o' + x.obj.uid : x.堆叠项 !== undefined ? 's' + x.堆叠项 : 'p' + x.玩家);
  const 配 = new Map<string, number>();
  const 试 = (槽: number, 见过: Set<string>): boolean => {
    for (const x of 需要[槽]!) {
      const k = 键(x);
      if (见过.has(k)) continue;
      见过.add(k);
      const 现 = 配.get(k);
      if (现 === undefined || 试(现, 见过)) { 配.set(k, 槽); return true; }
    }
    return false;
  };
  for (let 槽 = 0; 槽 < 需要.length; 槽++) if (!试(槽, new Set())) return false;
  return true;
}

const 候选缓存 = new WeakMap<GameState, { 版本: number; 表: WeakMap<object, Map<string, 候选[]>> }>();
function 候选缓存槽(g: GameState) {
  const 版本 = g.状态版本 ?? 0;
  let c = 候选缓存.get(g);
  if (!c || c.版本 !== 版本) { c = { 版本, 表: new WeakMap() }; 候选缓存.set(g, c); }
  return c;
}
export function 候选目标(g: GameState, 操控者: number, spec: TargetSpec, 锚: Obj | null, 是目标 = true,

  触发受方?: Obj | number,

  记忆源?: Obj): 候选[] {

  const 键选 = spec.任一 ? undefined : spec.选择;
  if (!键选) return 候选目标内(g, 操控者, spec, 锚, 是目标, 触发受方, 记忆源);
  const c = 候选缓存槽(g);
  let 按键 = c.表.get(键选);
  if (!按键) { 按键 = new Map(); c.表.set(键选, 按键); }
  const k = 操控者 + '|' + (锚?.uid ?? -1) + '|' + (是目标 ? 1 : 0) + '|'
    + (typeof 触发受方 === 'number' ? 'n' + 触发受方 : 触发受方 ? 'o' + 触发受方.uid : '-')
    + '|' + (记忆源?.uid ?? -1);
  const 有 = 按键.get(k);
  if (有) return 有;
  const 值 = 候选目标内(g, 操控者, spec, 锚, 是目标, 触发受方, 记忆源);
  按键.set(k, 值);
  return 值;
}
function 候选目标内(g: GameState, 操控者: number, spec: TargetSpec, 锚: Obj | null, 是目标 = true,
  触发受方?: Obj | number,
  记忆源?: Obj): 候选[] {

  const out: 候选[] = [];
  const list: Selector[] = spec.任一 ?? (spec.选择 ? [spec.选择] : []);
  for (const sel of list) {
    if (sel.种类 === '玩家' || sel.种类 === '对手') {
      for (const pl of g.players) {
        if (sel.种类 === '对手' && pl.index === 操控者) continue;
        if (sel.操控者 === '你' && pl.index !== 操控者) continue;
        if (sel.操控者 === '对手' && pl.index === 操控者) continue;
        out.push({ obj: null, 玩家: pl.index });
      }
      continue;
    }
    if (sel.区域 === '堆叠') {
      for (const it of g.stack) {

        if (!it.card || it.种类 !== '令符') {
          if (sel.含堆叠能力 && it.种类 !== '令符') out.push({ obj: null, 玩家: null, 堆叠项: it.id });
          continue;
        }

        if (sel.种类 && sel.种类 !== '令符' && sel.种类 !== '牌' && !属于类别(g, it.card, sel.种类)) continue;
        if (sel.非种类 && 属于类别(g, it.card, sel.非种类)) continue;
        out.push({ obj: it.card, 玩家: null });
      }
      continue;
    }

    if (sel.区域 && sel.区域 !== '战场') {
      const 池: Obj[] =
        sel.区域 === '墓地' ? g.players.flatMap((pl) => pl.graveyard)
        : sel.区域 === '手牌' ? g.players.flatMap((pl) => pl.hand)
        : sel.区域 === '牌库' ? g.players.flatMap((pl) => pl.library)
        : sel.区域 === '放逐区' ? g.放逐区
        : [];
      for (const o of 池) {
        if (!符合选择器(g, o, sel, 锚 ?? null, 操控者, 有效特征(g, o), 触发受方, 记忆源)) continue;
        out.push({ obj: o, 玩家: null });
      }
      continue;
    }
    for (const o of g.战场) {

    if (是目标 && 有词(g, o, '洞察') && 有效控制器(g, o) !== 操控者) continue;

      if (是目标 && 抵抗挡得住目标(g, o, 锚 ?? null)) continue;

      {
        const 附 = 锚 ? 关键词特征(g, 锚, '附属') : undefined;
        if (附 && !符合筛选(g, o, 附, 有效特征(g, o))) continue;
      }
      if (!符合选择器(g, o, sel, 锚 ?? null, 操控者, 有效特征(g, o), 触发受方, 记忆源)) continue;

      out.push({ obj: o, 玩家: null });
    }
  }
  return out;
}

function 属于类别(g: GameState, o: Obj, 种类: string): boolean {
  if (种类 === '实体') return true;
  if (种类 === '物件') return true;
  if (种类 === '令符') return false;
  return 是类别(g, o, 种类);
}

function 目标仍合法(g: GameState, item: StackItem): boolean {
  if (item.目标.length === 0) return true;
  for (const t of item.目标) {
    if (typeof t === 'number') { if (!g.players[t]) return false; continue; }

    if ('堆叠项' in t) { if (!g.stack.some((x) => x.id === t.堆叠项)) return false; continue; }

    if (t.区域 !== '战场' && t.区域 !== '堆叠') {
      if (t.区域 === '墓地' && !g.players.some((pl) => pl.graveyard.includes(t))) return false;
      if (t.区域 === '手牌' && !g.players.some((pl) => pl.hand.includes(t))) return false;
      if (t.区域 === '牌库' && !g.players.some((pl) => pl.library.includes(t))) return false;
      if (t.区域 === '放逐区' && !g.放逐区.includes(t)) return false;

      if (t.区域 === '暂存') return false;
    }
  }
  return true;
}

export interface 进场替代 { 横置?: boolean }

export function 附属(g: GameState, 数术: Obj, 目标: number): void {
  if (数术.附属在 === 目标) return;
  const 改附 = 数术.区域 === '战场' && 数术.附属在 !== undefined;
  写附属在(g, 数术, 目标);
  if (改附) { 盖时间印记(g, 数术); 记录(g, '613.7e：' + 数术.def.全名 + ' 改附 → 新的时间印记'); }
  const 实体 = 目标 > 1 ? g.战场.find((x) => x.uid === 目标) : undefined;
  记录(g, '306.4b：' + 数术.def.全名 + ' 附属于 ' + (实体 ? 实体.def.全名 : '玩家' + 目标));
}

function 进场本体(g: GameState, o: Obj, 操控者: number, 阵地: 阵地 | null, 替代?: 进场替代): void {
  const pl = g.players[操控者]!;
  const 是单位0 = 是类别(g, o, '单位');

  if (是单位0 && 阵地) {
    const 挡 = pl.阵地[阵地];
    if (挡 && 有词(g, 挡, '坚阵')) {
      记录(g, '702.80g：' + 挡.def.全名 + ' 具有坚阵，' + o.def.全名 + ' 不会进入战场');
      if (o.是指示物) 记录(g, '  （指示物：从未被征召）');
      else { 移到区域(g, o, '放逐区'); 记录(g, '  （是牌 → 放逐）'); }
      return;
    }
  }

  从当前区域摘除(g, o);
  写操控者(g, o, 操控者);
  写区域(g, o, '战场');
  盖时间印记(g, o);
  战场加(g, o);
  const 是单位 = 是类别(g, o, '单位');

  写整备(g, o, 是单位);
  if (是单位 && 阵地) {

    const 原 = pl.阵地[阵地];
    if (原) {
      记录(g, '替任（301.9）：' + o.def.全名 + ' 替任 ' + 原.def.全名 + '（后者被放逐）');
      放逐(g, 原);
    }
    清出阵地(g, o);
  写阵地(g, o, 阵地); pl.阵地[阵地] = o;
  } else {
    写阵地(g, o, null);
  }

  if (是类别(g, o, '化身') && (o.def.灵值 ?? 0) > 0) {
    加标记(g, o, { 类型: '灵值', 数量: o.def.灵值!, 时间印记: g.nextStamp++ });
  }

  if ((o.def.横置进场 || 替代?.横置) && o.面 === '明置') {
    写横置(g, o, true);
    排队单位事件触发(g, '成为横置', o);
    记录(g, o.def.全名 + ' 横置进场（614）');
  }
}

function 迎击检查(g: GameState, o: Obj, 操控者: number, 阵地: 阵地 | null): void {
  if (!是类别(g, o, '单位') || !阵地) return;
  const 敌 = (操控者 + 1) % g.players.length;
  const 守 = g.players[敌]!.阵地[相对阵地(阵地)!];
  if (守 && 守 !== o) 排队关键词触发(g, 守, '进入相对阵地', o);
}

export function 进战场(g: GameState, o: Obj, 操控者: number, 阵地: 阵地 | null, 替代?: 进场替代): void {
  进场本体(g, o, 操控者, 阵地, 替代);
  记事件(g, '进战场', { 受方: o.uid });
  排队进战场触发(g, o);
  迎击检查(g, o, 操控者, 阵地);
}

export function 批量进战场(g: GameState, 项: { 对象: Obj; 操控者: number; 阵地: 阵地 | null; 替代?: 进场替代 }[]): Obj[] {
  for (const x of 项) 进场本体(g, x.对象, x.操控者, x.阵地, x.替代);
  for (const x of 项) {
    记事件(g, '进战场', { 受方: x.对象.uid });
    排队进战场触发(g, x.对象);
  }
  for (const x of 项) 迎击检查(g, x.对象, x.操控者, x.阵地);
  return 项.map((x) => x.对象);
}

export function 放逐(g: GameState, o: Obj): void {
  移到区域(g, o, '放逐区');
}

function 给看<T extends object>(面板: T, 看?: { 键: number | string; 名称: string }[]):
T & { 查看: { 键: number | string; 名称: string }[] } {
  const 列 = 看 ?? ((面板 as { 候选?: { 键: number | string; 名称: string }[] }).候选 ?? []);
  return { ...面板, 查看: 列.map((c) => ({ 键: c.键, 名称: c.名称 })) };
}

export function 征召(g: GameState, p: number, def: CardDef, 数量: number, 阵地?: (阵地 | null)[], 关键词?: string[]): Obj[] {

  const 项: { 对象: Obj; 操控者: number; 阵地: 阵地 | null }[] = [];
  const 名 = def.全名;

  const 定义: CardDef = 关键词 && 关键词.length
    ? { ...def, 能力: { ...(def.能力 ?? {}), 能力: [...((def.能力 as { 能力?: unknown[] } | null)?.能力 ?? []), ...关键词.map((名) => ({ 名称: 名 }))] } as never }
    : def;
  for (let i = 0; i < 数量; i++) {
    const t = 造对象(g, 定义, p, '战场');
    t.是指示物 = true;
    let 槽: 阵地 | null = 阵地?.[i] ?? null;
    if (def.类别.includes('单位')) {
      if (!槽 || g.players[p]!.阵地[槽]) {
        槽 = 阵地顺序.find((s2) => !g.players[p]!.阵地[s2]) ?? null;
        if (!槽) { 记录(g, '112.6：没有空阵地，' + 名 + ' 不能进场'); continue; }
      }
    } else 槽 = null;
    项.push({ 对象: t, 操控者: p, 阵地: 槽 });
  }

  const 出 = 批量进战场(g, 项);
  for (const t of 出) 记录(g, '征召：' + 名 + '（' + (def.武力 ?? 0) + '/' + (def.体力上限 ?? 0) + '）进场（同时 ✓）');
  return 出;
}

function 离场清理(g: GameState, o: Obj): void {
  写标记表(g, o, []);
  写伤害(g, o, 0);
  清记忆(g, o);
  写整备(g, o, false);

  写横置(g, o, false);

  写附属在(g, o, undefined);
  写佩带在(g, o, undefined);

  写面(g, o, '明置');
}

export type Native实现 = (g: GameState, item: StackItem, 步骤: { 操作: '原生'; 模块: string }) => void;
const native模块表 = new Map<string, Native实现>();

export function 注册native(名: string, 实现: Native实现): void { native模块表.set(名, 实现); }

export function 实际打出费用(g: GameState, p: number, def: CardDef): number {
  const 基 = def.打出费用 === 'X' ? 0 : (def.打出费用 ?? 0);
  let 总 = 基;
  {

    const 试一条 = (r: 费用修正, 控: number): void => {
      const 受 = r.适用 === '对手' ? (1 - 控) : 控;
      if (受 !== p) return;

      if (r.筛选 && !符合筛选(g, { def } as Obj, r.筛选, 有效特征(g, { def } as Obj))) return;

      if (r.条件 && !判断(g, 受, r.条件, { def } as Obj)) return;
      总 += typeof r.打出费用 === 'number' ? r.打出费用 : 取值(g, 受, r.打出费用, { def } as Obj);
    };
    for (const o of g.战场) {
      if (o.面 === '暗置') continue;
      for (const ab0 of (o.def.能力?.能力 ?? []) as StaticAbility[]) {
        if (ab0.种类 !== '静止式' || !ab0.费用修正) continue;
        for (const r of ab0.费用修正) 试一条(r, 有效控制器(g, o));
      }
    }

    for (const ab0 of (def.能力?.能力 ?? []) as StaticAbility[]) {
      if (ab0.种类 !== '静止式' || !ab0.费用修正) continue;
      for (const r of ab0.费用修正) 试一条(r, p);
    }
  }
  return Math.max(0, 总);
}

export function 阵地所有者(g: GameState, o: Obj): number | null {
  if (!o.阵地) return null;
  for (const pl of g.players) if (pl.阵地[o.阵地] === o) return pl.index;
  return null;
}

function 清出阵地(g: GameState, o: Obj): void {
  if (!o.阵地) return;
  for (const pl of g.players) if (pl.阵地[o.阵地] === o) pl.阵地[o.阵地] = null;
}

export function 获得操控权时移动(g: GameState, o: Obj, 新操控者: number): void {
  if (o.区域 !== '战场' || !是类别(g, o, '单位')) return;
  const 空 = 第一个空阵地(g, 新操控者);

  清出阵地(g, o);
  if (空) {
    写阵地(g, o, 空); g.players[新操控者]!.阵地[空] = o;
    记录(g, '301.8：' + o.def.全名 + ' 移到 ' + g.players[新操控者]!.name + ' 的 ' + 空);
  } else {
    写阵地(g, o, null);
    记录(g, '301.8：' + g.players[新操控者]!.name + ' 没有空阵地，' + o.def.全名 + ' 被移出阵地');
  }
}

export function 同步操控权与阵地(g: GameState): void {
  for (const o of g.战场.slice()) {
    if (o.区域 !== '战场' || !是类别(g, o, '单位')) continue;
    if (!o.阵地) continue;
    const 控 = 有效控制器(g, o);
    const 阵主 = 阵地所有者(g, o);
    if (阵主 === 控) continue;
    记录(g, '301.8：' + o.def.全名 + ' 的操控权与阵地不一致（阵地属于 ' +
      (阵主 === null ? '无人' : g.players[阵主]!.name) + '，操控者是 ' + g.players[控]!.name + '），按 301.8 搬一次');
    获得操控权时移动(g, o, 控);
  }
}

export function 玩家被禁(g: GameState, p: number, 动作: 玩家动作, 对象?: Obj): boolean {
  return (g.players[p]!.限制 ?? []).some((r) =>
    r.禁止 === 动作 && g.turn <= r.到期

    && (r.筛选 === undefined || (对象 !== undefined && 符合筛选(g, 对象, r.筛选, 有效特征(g, 对象)))));
}

export function 玩家限制清单(g: GameState, p: number): { 禁止: 玩家动作; 筛选?: 筛选; 到期: number }[] {
  return (g.players[p]!.限制 ?? []).filter((r) => g.turn <= r.到期);
}

注册native('再起', (g, item) => {
  const 牌 = item.来源 ?? item.card;
  if (!牌 || 牌.区域 !== '墓地') { 记录(g, '再起：这张牌不在墓地，什么也不发生'); return; }
  const 槽 = 阵地顺序.find((s) => !g.players[牌.操控者]!.阵地[s]) ?? null;
  进战场(g, 牌, 牌.操控者, 槽);
  写整备(g, 牌, false);
  写记忆(g, 牌, '结束时放逐', true);
  记录(g, '再起（702.69b）：' + 牌.def.全名 + ' 从墓地移回战场' + (槽 ? '（' + 槽 + '）' : '') + '，获得神速，下个结束步骤开始时放逐');
});

注册native('佩带', (g, item, 步骤) => {
  const 装 = item.来源 ?? item.card;
  const 目标 = 取实体(item.目标槽?.['t']);
  if (!装 || !目标) { 记录(g, '佩带：来源或目标不对，什么也不发生'); return; }
  if (!是类别(g, 目标, '单位')) { 记录(g, '佩带：目标不是单位（305.5）'); return; }
  写佩带在(g, 装, 目标.uid);
  记录(g, 装.def.全名 + ' 佩带在 ' + 目标.def.全名 + ' 上（702.7b）');
});

function 从当前区域摘除(g: GameState, o: Obj): void {
  switch (o.区域) {
    case '战场': {

      const b = g.战场.indexOf(o); if (b >= 0) 战场删(g, o);

      if (o.阵地) { g.players[有效控制器(g, o)]!.阵地[o.阵地] = null; 写阵地(g, o, null); }
      break;
    }
    case '手牌': { const i = g.players[o.owner]!.hand.indexOf(o); if (i >= 0) g.players[o.owner]!.hand.splice(i, 1); break; }
    case '牌库': { const i = g.players[o.owner]!.library.indexOf(o); if (i >= 0) g.players[o.owner]!.library.splice(i, 1); break; }
    case '墓地': { const i = g.players[o.owner]!.graveyard.indexOf(o); if (i >= 0) g.players[o.owner]!.graveyard.splice(i, 1); break; }
    case '放逐区': { const i = g.放逐区.indexOf(o); if (i >= 0) g.放逐区.splice(i, 1); break; }
    case '堆叠': break;
    case '暂存': break;
  }
}

function 放进区域(g: GameState, o: Obj, 区: Zone): void {
  const pl = g.players[o.owner]!;
  switch (区) {
    case '手牌': pl.hand.push(o); break;
    case '牌库': pl.library.push(o); break;
    case '墓地': pl.graveyard.push(o); break;
    case '放逐区': g.放逐区.push(o); break;
    case '战场': 战场加(g, o); break;
    case '堆叠': break;
    case '暂存': break;
  }
}

export function 移到区域(g: GameState, o: Obj, 目的地: Zone): void {
  if (o.区域 === 目的地) return;

  const 曾是战场 = o.区域 === '战场';
  从当前区域摘除(g, o);
  离场清理(g, o);
  写时间印记(g, o, g.nextStamp++);
  写区域(g, o, 目的地);
  放进区域(g, o, 目的地);
  if (曾是战场 && 目的地 !== '战场') { 记事件(g, '移动', { 受方: o.uid }); 排队移动触发(g, o); }
}

export function 置入墓地(g: GameState, o: Obj): void {
  const 曾在战场 = o.区域 === '战场';
  const 旧阵地 = o.阵地;
  移到区域(g, o, '墓地');
  const pl = g.players[o.owner]!;

  记事件(g, 曾在战场 ? '死去' : '离开战场', { 受方: o.uid });
  if (曾在战场) 排队死去触发(g, o, 旧阵地);

  if (曾在战场 && 是类别(g, o, '单位')) 排队其他单位死去触发(g, o);
}

export function 排队其他单位死去触发(g: GameState, 死者: Obj): void {
  for (const o of [...g.战场]) {
    if (o === 死者 || !有规则叙述(g, o)) continue;
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    abs.forEach((ab, i) => {
      if (ab.种类 !== '触发式' || ab.触发.事件 !== '死去' || ab.触发.主体 !== '其他单位') return;

      if (ab.触发.主体归属 === '你' && 有效控制器(g, 死者) !== 有效控制器(g, o)) return;
      if (ab.触发.主体归属 === '对手' && 有效控制器(g, 死者) === 有效控制器(g, o)) return;
      if (ab.触发.主体筛选 && !符合筛选(g, 死者, ab.触发.主体筛选)) return;
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '其他单位死去触发'), 允许离场: true, 触发受方: 死者 });
    });
  }
}

export function 排队死去触发(g: GameState, o: Obj, 位置?: 阵地 | null): void {

    排队单位事件触发(g, '死去', o, { 允许离场: true, 死者位置: 位置 ?? null, 触发受方: o });
    if (false) {
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    abs.forEach((ab, i) => {

      if (ab.种类 === '触发式' && ab.触发.事件 === '死去' && (ab.触发.主体 ?? '自身') === '自身') {
        g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '死去触发'), 允许离场: true, 触发受方: o, 死者位置: 位置 });
      }
    });
  }

  for (const x of [...g.战场]) {
    if (x === o || !有规则叙述(g, x)) continue;
    const abs = (x.def.能力?.能力 ?? []) as TriggeredAbility[];
    abs.forEach((i, k) => {
      const ab = abs[k]!;
      if (ab.种类 !== '触发式' || ab.触发.事件 !== '死去') return;
      const 主体 = ab.触发.主体 ?? '自身';
      if (主体 !== '所佩带' && 主体 !== '所附属') return;

      const 挂 = 主体 === '所佩带' ? x.佩带在 : x.附属在;
      if (挂 !== o.uid) return;
      g.pending.push({ 来源: x, abilityIndex: k, 标签: 触发标签(x, 主体 + '死去触发'), 允许离场: true, 触发受方: o, 死者位置: 位置 });
    });
  }
}

export function 排队进战场触发(g: GameState, o: Obj): void {
  扫守望(g, '进战场', o);

  排队单位事件触发(g, '进战场', o);
}

export function 排队被指定为目标触发(g: GameState, 受方们: 目标[], 来源obj: Obj | null): void {
  if (!来源obj) return;

  for (const t of 受方们) {
    if (typeof t === 'number' || !('uid' in t)) continue;
    const 物件 = g.战场.find((x) => x.uid === (t as { uid: number }).uid);
    if (物件) 排队单位事件触发(g, '被指定为目标', 物件, { 触发受方: 物件 }, 来源obj);
  }
}

export function 排队回复体力触发(g: GameState, 受方: number | Obj): void {

  if (typeof 受方 === 'number') {
    for (const o of [...g.战场]) {
      if (!有规则叙述(g, o)) continue;
      const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
      abs.forEach((ab, i) => {
        if (ab.种类 !== '触发式' || ab.触发.事件 !== '回复体力') return;
        if (ab.触发.受方 === '实体') return;
        g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '回复体力触发'), 触发受方: 受方 });
      });
    }
    return;
  }
  排队单位事件触发(g, '回复体力', 受方, { 触发受方: 受方, 受方类型: '实体' });
}

export function 排队造成伤害触发(g: GameState, 源: Obj, 受方: number | Obj | undefined, 量: number): void {
  const 对玩家 = typeof 受方 === 'number';
  for (const o of [...g.战场]) {
    if (!有规则叙述(g, o)) continue;
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    abs.forEach((ab, i) => {
      if (ab.种类 !== '触发式' || ab.触发.事件 !== '造成伤害') return;
      const 主体 = ab.触发.主体 ?? '自身';

      if (主体 === '所佩带' && o.佩带在 !== 源.uid) return;
      if (主体 === '所附属' && o.附属在 !== 源.uid) return;
      if (主体 === '自身' && o !== 源) return;

      if (ab.触发.受方 !== undefined && ab.触发.受方 !== (对玩家 ? '玩家' : '实体')) return;
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '造成伤害触发'), 触发量: 量, 触发受方: 受方 });
    });
  }
}

export function 排队玩家受到伤害触发(g: GameState, 玩家: number, 量: number): void {
  for (const o of [...g.战场]) {
    if (!有规则叙述(g, o)) continue;
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    abs.forEach((ab, i) => {
      if (ab.种类 !== '触发式' || ab.触发.事件 !== '受到伤害') return;
      if (ab.触发.受方 !== '玩家') return;
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '玩家受到伤害触发'), 触发量: 量, 触发受方: 玩家 });
    });
  }
}

export function 排队受到伤害触发(g: GameState, o: Obj, 量: number, 受方?: number | Obj): void {

  排队单位事件触发(g, '受到伤害', o, { 触发量: 量, 触发受方: 受方, 受方类型: '实体' });
}

export const 事件派发: Record<事件名, { 派发在哪: string; 未实现?: true; 派发?: (g: GameState, 受体: Obj) => void }> = {
  进战场: { 派发在哪: '排队进战场触发 → 排队单位事件触发（通用广播 ✓，扫全场）', 派发: (g, o) => 排队进战场触发(g, o) },
  成为横置: { 派发在哪: '排队单位事件触发（通用广播 ✓）engine.ts:1151', 派发: (g, o) => 排队单位事件触发(g, '成为横置', o) },
  死去: { 派发在哪: '排队死去触发 engine.ts:1462 ＋ 排队其他单位死去触发 :1464', 派发: (g, o) => { 排队其他单位死去触发(g, o); 排队死去触发(g, o); } },
  离开战场: { 派发在哪: '移动流程里 记事件 ／ 排队移动触发 engine.ts:1447' },
  被指定为目标: { 派发在哪: '排队被指定为目标触发 engine.ts:906 / 3947' },
  受到伤害: { 派发在哪: '伤害流程 排队受到伤害触发 :2742 / 排队玩家受到伤害触发 :2729' },
  造成伤害: { 派发在哪: '伤害流程 排队造成伤害触发 engine.ts:2690' },
  回复体力: { 派发在哪: '排队回复体力触发 engine.ts:2833 / 2838' },
  移动: { 派发在哪: '排队移动触发 engine.ts:1447 / 3453 / 3492' },
  明置: { 派发在哪: '排队面触发 engine.ts:520' },
  暗置: { 派发在哪: '排队面触发 engine.ts:520' },
  宣告攻击: { 派发在哪: '排队宣告攻击触发 engine.ts:4301' },
  步骤开始: { 派发在哪: '排队步骤触发 engine.ts:4050 / 4056 / 4063 ＋ 扫守望 :1747' },
  阶段开始: { 派发在哪: '（回合流程：目前卡数据没用）' },
  打出牌: { 派发在哪: '排队事件触发 engine.ts:908' },
  抓牌: { 派发在哪: '排队事件触发 engine.ts:298' },
  重置: { 派发在哪: '排队关键词触发 engine.ts:1160 / 1756' },
  弃牌: { 派发在哪: '（卡数据没用）' },
  牺牲: { 派发在哪: '（卡数据没用）' },
  放逐: { 派发在哪: '（卡数据没用）' },
};

function 触发标签(o: Obj, 后缀: string): string {
  return o.def.全名 + (o.阵地 ? '（' + o.阵地 + '）' : '') + ' 的' + 后缀;
}

function 排队单位事件触发(g: GameState, 事件: '成为横置' | '进战场' | '移动' | '受到伤害' | '宣告攻击' | '回复体力' | '被指定为目标' | '死去' | '明置' | '暗置', 受体: Obj,
  额外?: { 触发量?: number; 触发受方?: number | Obj; 允许离场?: boolean; 死者位置?: 阵地 | null;

    受方类型?: '玩家' | '实体';

    特征覆盖?: unknown },

  来源?: Obj | null): void {
  const 触发名 = 事件 + '触发';

  const 候选: Obj[] = [...g.战场];
  if (!候选.includes(受体)) 候选.push(受体);
  for (const o of 候选) {
    if (!有规则叙述(g, o)) continue;
    const 自己 = o === 受体;
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    abs.forEach((ab, i) => {
      if (ab.种类 !== '触发式' || ab.触发.事件 !== 事件) return;
      const 主体 = ab.触发.主体 ?? '自身';

      if (额外?.受方类型 && ab.触发.受方 && ab.触发.受方 !== 额外.受方类型) return;
      if (自己 ? 主体 !== '自身' : 主体 !== '其他单位') return;
      if (!自己) {
        if (ab.触发.主体归属 === '你' && 有效控制器(g, 受体) !== 有效控制器(g, o)) return;
        if (ab.触发.主体归属 === '对手' && 有效控制器(g, 受体) === 有效控制器(g, o)) return;
        const 筛 = 额外?.特征覆盖 ?? 有效特征(g, 受体);
        if (ab.触发.主体筛选 && !符合筛选(g, 受体, ab.触发.主体筛选, 筛 as never)) return;

        if (ab.触发.筛选 && !符合筛选(g, 受体, ab.触发.筛选, 筛 as never)) return;

        if (ab.触发.筛选来源 && (!来源 || !符合筛选(g, 来源, ab.触发.筛选来源, 有效特征(g, 来源)))) return;
      }
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, 触发名), 允许离场: true, 触发受方: 受体, ...(额外 ?? {}) });
    });
  }
}

export function 排队事件触发(g: GameState, 事件: '抓牌' | '打出牌' | '成为横置', 受方: number,

  事件牌?: Obj): void {
  for (const o of [...g.战场]) {
    if (!有规则叙述(g, o)) continue;
    if (有效控制器(g, o) !== 受方) continue;
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    abs.forEach((ab, i) => {
      if (ab.种类 !== '触发式') return;
      if (ab.触发.事件 !== 事件) return;

      const 判牌 = (条件?: unknown): boolean => !条件 || (!!事件牌 && 符合筛选(g, 事件牌, 条件 as never));
      if (!判牌(ab.触发.筛选来源)) return;
      if (!判牌(ab.触发.筛选)) return;
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, 事件 + '触发'), 触发受方: 受方 });
    });
  }
}

export function 排队移动触发(g: GameState, 单位: Obj): void {

  排队单位事件触发(g, '移动', 单位);
}

function 扫守望(g: GameState, 事件: '进战场' | '步骤开始', 受体?: Obj, 步骤?: string): void {
  for (const w of [...g.守望]) {
    if (w.事件 !== 事件) continue;
    if (事件 === '步骤开始' && w.步骤 !== undefined && w.步骤 !== 步骤) continue;
    if (受体 && w.操控者 !== undefined && 有效控制器(g, 受体) !== w.操控者) continue;
    g.pending.push({
      来源: (w.来源 ?? null) as Obj,
      abilityIndex: -1, 能力: w.能力, 标签: w.标签, 允许离场: true,
      触发受方: 受体,
    });
    if (w.时长 === '下一次') g.守望 = g.守望.filter((x) => x !== w);
  }
}

export function 排队步骤触发(g: GameState, 步骤: string): void {
  扫守望(g, '步骤开始', undefined, 步骤);

  if (步骤 === '结束步骤') {

    const 我控 = g.战场.filter((o) => 有效控制器(g, o) === g.active);
    for (const o of [...我控]) {
      if (o.记忆['结束时放逐']) { 记录(g, '再起：' + o.def.全名 + ' 被放逐（702.69b）'); 放逐(g, o); }
    }
    for (const o of 我控) 排队关键词触发(g, o, '结束步骤');
  }
  for (const o of g.战场) {
    {
      const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
  if (!有规则叙述(g, o)) continue;
      abs.forEach((ab, i) => {
        if (ab.种类 !== '触发式') return;
        if (ab.触发.事件 !== '步骤开始' || ab.触发.步骤 !== 步骤) return;
        const who = ab.触发.谁的回合 ?? '你';
        if (who === '你' && 有效控制器(g, o) !== g.active) return;
        g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, 步骤 + '触发') });
      });
    }
  }
}

export function 把待触发放进堆叠_AI替玩家宣告(g: GameState): void {
  const it = 把待触发放进堆叠G(g, { 允许打领土: false, 允许通常时机: false }, '');
  let r = it.next();
  while (!r.done) r = it.next(自动宣告(g, r.value.决定));
}

export function 自动宣告(g: GameState, 决定?: 请求['决定']): Action | null {

  if (决定 && 决定.类型 === '搜寻') {
    return { 种类: '决定', 接受: true, 选: 决定.候选.slice(0, 决定.数量).map((c) => c.uid) };
  }

  if (决定 && 决定.类型 === '弃牌') {
    return { 种类: '决定', 接受: true, 弃牌: g.players[g.active]!.hand.slice(-决定.需弃).map((c) => c.uid) };
  }

  if (决定 && 决定.类型 === '选') {
    const 要 = Math.max(1, 决定.数量?.最小 ?? 1);
    const 键 = (决定.候选 ?? []).slice(0, 要).map((c) => c.键);
    return { 种类: '决定', 接受: true, 选: 键 };
  }
  if (!决定 || 决定.类型 !== '宣告') return null;
  const 挑目标 = (规格: 规格[]) => 规格.map((sp) => {
    const c = sp.候选.find((x) => x.敌) ?? sp.候选[0]!;
    return { 目标名: sp.目标名, 类型: c.类型, uid: c.uid, 玩家: c.玩家 };
  });
  if (决定.模式候选 && 决定.模式候选.length > 0) {
    const m = 决定.模式候选[0]!;
    return { 种类: '宣告', 模式: m.索引, 目标: 挑目标(m.规格) };
  }
  return { 种类: '宣告', 目标: 挑目标(决定.规格 ?? []) };
}

function 造触发式堆叠项(
  g: GameState, src: Obj, ab: TriggeredAbility, 标签: string,
  触发量?: number,
  选择?: { 模式?: number; 目标?: { 目标名: string; 类型: '实体' | '玩家'; uid?: number; 玩家?: number }[] },
  预选?: { 目标: (Obj | number)[]; 目标槽: Record<string, Obj | number> },
  触发受方?: number | Obj,
): StackItem | null {
  const 目标: 目标[] = [];
  const 目标槽: Record<string, 目标> = {};

  let chosenMode: number | undefined;
  let 目标清单: TargetSpec[] = ab.目标 ?? [];
  if (ab.模式) {
    const ms = ab.模式;
    const 已选 = (src.记忆[ms.记忆?.记忆键 ?? ''] as number[] | undefined) ?? [];

    let m: number | null = null;
    if (选择 && typeof 选择.模式 === 'number') {
      const 候 = ms.选项[选择.模式];
      if (候 && (!ms.记忆?.禁止重复 || !已选.includes(选择.模式))
        && (候.目标 ?? []).every((s) => 候选目标(g, 有效控制器(g, src), s, src).length > 0)) m = 选择.模式;
    }
    if (m === null) {
      for (let i = 0; i < ms.选项.length; i++) {
        if (ms.记忆?.禁止重复 && 已选.includes(i)) continue;
        if ((ms.选项[i]!.目标 ?? []).every((s) => 候选目标(g, 有效控制器(g, src), s, src).length > 0)) { m = i; break; }
      }
    }
    if (m === null) return null;
    chosenMode = m;
    目标清单 = ms.选项[m]!.目标 ?? [];
    const 键 = ms.记忆?.记忆键;
    if (键) 写记忆(g, src, 键, [...已选, m]);
  }

  if (预选) {
    for (const spec of 目标清单) {
      const v = 预选.目标槽[spec.目标名];
      if (v !== undefined) { 目标.push(v); 目标槽[spec.目标名] = v; }
    }
    const steps = ab.模式 ? ab.模式.选项[chosenMode!]!.效应 : ab.效应;
    return { id: g.nextStackId++, 种类: '触发式', 标签, 操控者: src.操控者,
      来源: src, card: null, 目标, 目标槽, chosenMode, 可选: ab.可选, steps, 触发量, 触发受方 };
  }

  const stepsT = ab.模式 ? ab.模式.选项[chosenMode!]!.效应 : ab.效应;
  return {
    id: g.nextStackId++, 种类: '触发式', 标签, 操控者: src.操控者,
    来源: src, card: null, 目标: [], 目标槽: {}, 待定目标: 预选 ? undefined : 目标清单,
    chosenMode, 可选: ab.可选, steps: stepsT, 触发量, 触发受方,
  };
}

function 找实体(g: GameState, uid: number): Obj | null {
  for (const o of g.战场) if (o.uid === uid) return o;
  for (const it of g.stack) if (it.card && it.card.uid === uid) return it.card;
  return null;
}

function 组装宣告决定(g: GameState, src: Obj, ab: TriggeredAbility, 标签: string): 宣告决定 | null {
  const 触发时 = ab.目标时点 === '触发时';

  if (!ab.模式) return 触发时 && (ab.目标 ?? []).length ? { 类型: '宣告', 标签, 来源uid: src.uid, 可选: ab.可选, 规格: 建规格(g, src, ab.目标!) } : null;
  const ms = ab.模式;
  const 已选 = (src.记忆[ms.记忆?.记忆键 ?? ''] as number[] | undefined) ?? [];
  const 我 = 有效控制器(g, src);
  const 模式候选: { 索引: number; 标签: string; 规格: 规格[] }[] = [];
  ms.选项.forEach((o, i) => {
    if (ms.记忆?.禁止重复 && 已选.includes(i)) return;

    if (!(o.目标 ?? []).every((sp) => 候选目标(g, 我, sp, src).length > 0)) return;

    模式候选.push({ 索引: i, 标签: o.标签, 规格: 触发时 ? 建规格(g, src, o.目标 ?? []) : [] });
  });
  if (模式候选.length === 0) return null;
  return { 类型: '宣告', 标签: 标签, 来源uid: src.uid, 可选: ab.可选, 模式候选 };
}

function 建规格(g: GameState, src: Obj, specs: TargetSpec[]): 规格[] {
  const 我 = 有效控制器(g, src);
  return specs.map((sp) => ({
    目标名: sp.目标名, 数量: sp.数量,

    候选: 候选目标(g, 我, sp, src).map((c) => (c.obj
      ? { 类型: '实体' as const, uid: c.obj.uid, 名称: c.obj.def.全名, 敌: 有效控制器(g, c.obj) !== 我 }
      : { 类型: '玩家' as const, 玩家: c.玩家!, 名称: g.players[c.玩家!]!.name, 敌: c.玩家 !== 我 })),
  }));
}

export function* 把待触发放进堆叠G(g: GameState, opts: 时机选项, 步骤: string): Generator<请求, void, Action | null> {

  if (g.pending.length >= 2) {
    for (const t of g.pending) if (t.id === undefined) t.id = g.nextPendingId++;
    const 谁的 = (t: (typeof g.pending)[number]): number | null => {
      const ab = t.能力 ?? ((t.来源.def.能力?.能力 ?? []) as TriggeredAbility[])[t.abilityIndex];
      return ab && (t.来源.区域 === '战场' || t.允许离场) ? 有效控制器(g, t.来源) : null;
    };

    const APNAP = (t: (typeof g.pending)[number]): number => {
      const 控 = 谁的(t);
      return 控 === null ? g.players.length : (控 - g.active + g.players.length) % g.players.length;
    };
    g.pending = [...g.pending].sort((a, b) => APNAP(a) - APNAP(b));
    const 头 = 谁的(g.pending[0]!);
    if (头 !== null) {
      const 同 = g.pending.filter((t) => 谁的(t) === 头);
      if (同.length >= 2) {
        const 答 = yield {
          玩家: 头, 时机: opts, 步骤,
          决定: { 类型: '选', 选什么: '触发', 玩家: 头,
            标签: '同时触发（603.3b）：决定放进堆叠的顺序 —— 最后点的最先结算',
            候选: 同.map((t) => ({ 键: t.id!, 名称: t.标签 })),
            数量: { 最小: 同.length, 最大: 同.length } },
        };
        const 序 = ((答 as { 选?: number[] } | null)?.选 ?? []).filter((x): x is number => typeof x === 'number');
        if (序.length === 同.length) {

          const 排好 = [...同].sort((a, b) => 序.indexOf(a.id!) - 序.indexOf(b.id!));
          g.pending = [...排好, ...g.pending.filter((t) => 谁的(t) !== 头)];
          记录(g, '同时触发：' + g.players[头]!.name + ' 决定的顺序 —— ' + 排好.map((t) => t.标签).join(' → '));
        } else {
          记录(g, '同时触发的顺序没答全（' + 序.length + '/' + 同.length + '），按原顺序放进堆叠');
        }
      }
    }
  }
  while (g.pending.length > 0) {
    if (g.over) return;
    const t = g.pending[0]!;
    const ab = t.能力 ?? ((t.来源.def.能力?.能力 ?? []) as TriggeredAbility[])[t.abilityIndex];
    if (!ab || (t.来源.区域 !== '战场' && !t.允许离场)) { g.pending.shift(); continue; }
    const 有模式 = !!ab.模式;
    const 决定 = t.预选 ? null : 组装宣告决定(g, t.来源, ab, t.标签);
    if (!决定) {
      g.pending.shift();

      if (有模式 && !t.预选) { 记录(g, t.标签 + '：没有可选模式，从堆叠移除（603.3f）'); continue; }
      const it = 造触发式堆叠项(g, t.来源, ab, t.标签, t.触发量, undefined, t.预选, t.触发受方);

      if (it) it.死者位置 = t.死者位置;
      if (it) 堆叠加(g, it);
      continue;
    }
    const 答 = yield { 玩家: t.来源.操控者, 时机: opts, 步骤, 决定 };
    g.pending.shift();
    if (!答 || 答.种类 !== '宣告') { 记录(g, t.标签 + '：未宣告，能力从堆叠移除'); continue; }

    const 预选 = ab.目标时点 === '触发时' ? (() => {
      const 目标: (Obj | number)[] = [];
      const 目标槽: Record<string, Obj | number> = {};
      for (const t2 of (答.目标 ?? [])) {
        const v = t2.类型 === '玩家' ? t2.玩家! : 找实体(g, t2.uid!);
        if (v === undefined || v === null) continue;
        目标.push(v as Obj | number); 目标槽[t2.目标名] = v as Obj | number;
      }
      return { 目标, 目标槽 };
    })() : undefined;
    const it = 造触发式堆叠项(g, t.来源, ab, t.标签, t.触发量, { 模式: 答.模式 }, 预选);

      if (it) it.死者位置 = t.死者位置;
    if (it) 堆叠加(g, it);
  }
}

export function 结算堆叠顶(g: GameState): boolean {
  const item = g.stack[g.stack.length - 1];
  if (!item) return true;

  if (item.已开始 && item.本次选择 && item.种类 === '令符') {
    if (!结算令符(g, item)) return false;
    堆叠弹出(g); 收尾堆叠项(g, item); return true;
  }
  if (!item.已开始) {
    item.已开始 = true;

    if (!目标仍合法(g, item)) { 记录(g, item.标签 + ' 因目标全部非法而被规则取消'); 堆叠弹出(g); 收尾堆叠项(g, item); return true; }

    if (item.待定目标 && item.待定目标.length) {
      const 锚 = item.来源 ?? item.card ?? null;
      const 控 = 锚 && typeof 锚 !== 'number' ? 有效控制器(g, 锚) : item.操控者;

      if (item.目标.length === 0 && item.待定目标.length > 0) {
        let 挑得齐 = true;
        for (const sp of item.待定目标) {
          const 候 = 候选目标(g, 控, sp, 锚 as Obj | null, true, item.触发受方);
          if (候.length < sp.数量.最小) { 挑得齐 = false; break; }
          const 要 = Math.max(sp.数量.最小, Math.min(sp.数量.最大, 1));

          const 挑 = [...候].sort((a, b) => {
            const 敌 = (c: { obj?: unknown; 玩家?: number | null }): number => ((c.obj ? (c.obj as { 操控者: number }).操控者 !== 控 : c.玩家 !== 控) ? 1 : 0);
            return 敌(b) - 敌(a);
          }).slice(0, 要);
          for (const c of 挑) {
            const v = c.obj ?? c.玩家!;
            item.目标.push(v);
            (item.目标槽 ??= {})[sp.目标名] = c.obj ?? c.玩家!;
          }
        }

        if (挑得齐) item.待定目标 = undefined;
      }

      if (item.待定目标) {
        const 合法集 = new Set<unknown>();
        for (const sp of item.待定目标) for (const c of 候选目标(g, 控, sp, 锚 as Obj | null, true, item.触发受方)) 合法集.add(c.obj ?? c.玩家);
        const 前 = item.目标.length;
        item.目标 = item.目标.filter((t) => 合法集.has(t));
        if (item.目标.length !== 前) 记录(g, item.标签 + '：挑中的目标不合法（不在候选里），已剔除');

        for (const k of Object.keys(item.目标槽 ?? {})) if (!合法集.has(item.目标槽![k])) delete item.目标槽![k];
      }
      const 缺 = item.待定目标 !== undefined && item.待定目标.length > 0
        && item.待定目标.some((sp) => 候选目标(g, 控, sp, 锚 as Obj | null).length < sp.数量.最小);
      if (缺) { 记录(g, item.标签 + '：没有合法目标，从堆叠移除（603.3f），不结算'); 堆叠弹出(g); 收尾堆叠项(g, item); return true; }
    }
    if (item.种类 === '令符') {
      if (!结算令符(g, item)) return false;
      堆叠弹出(g); 收尾堆叠项(g, item); return true;
    }

  }
  if (!执行步骤(g, item)) return false;
  堆叠弹出(g);
  收尾堆叠项(g, item);
  return true;
}

function 找互动引用(值: unknown): { 选: Selector; 数量?: { 最小: number; 最大: number }; 标签?: string } | null {
  if (!值 || typeof 值 !== 'object') return null;
  for (const v of Object.values(值 as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    if ('选' in (v as object)) return v as never;
    const 内 = 找互动引用(v);
    if (内) return 内;
  }
  return null;
}

function 执行步骤(g: GameState, item: StackItem): boolean {
  item.步骤游标 ??= 0;

  if (item.待放战场 && item.待放战场.length) {
    const 待 = item.待放战场[0]!;
    const 控 = item.待放战场控 ?? item.操控者;
    let 阵地: 阵地 | null = (item.本次选择 && typeof item.本次选择[0] === 'string') ? item.本次选择[0] as 阵地 : null;
    if (阵地) item.本次选择 = undefined;
    if (!阵地) {
      const 空 = 阵地顺序.filter((s2) => !g.players[控]!.阵地[s2]);
      if (!空.length) {
        记录(g, '301.10：没有可用的阵地，' + 待.def.全名 + ' 留在当前区域');
        item.待放战场.shift();
        if (!item.待放战场.length) { item.待放战场 = undefined; item.待放战场控 = undefined; }
        return 执行步骤(g, item);
      }
      item.待选择 = { 类型: '选', 选什么: '阵地',
        标签: '301.11：为 ' + 待.def.全名 + ' 选择一个进战场的阵地（' + g.players[控]!.name + ' 的空阵地）',
        玩家: 控, 数量: { 最小: 1, 最大: 1 }, 候选: 空.map((x) => ({ 键: x, 名称: x })) };
      return false;
    }
    进战场(g, 待, 控, 阵地);
    记录(g, 待.def.全名 + ' 被放进战场（' + 阵地 + '）');
    item.待放战场.shift();
    if (!item.待放战场.length) { item.待放战场 = undefined; item.待放战场控 = undefined; }
  }
  while (item.步骤游标 < item.steps.length) {
    const 步骤 = item.steps[item.步骤游标]!;
    if (!item.本次选择) {
      const r = 找互动引用(步骤);
      if (r) {

        const 候选 = 候选目标(g, item.操控者, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: r.选 }, item.来源 ?? item.card, false)
          .map((c) => c.obj).filter((x): x is Obj => !!x);
        if (候选.length === 0) {
          记录(g, '选：没有可选的物件，这一步跳过');
          item.步骤游标++;
          continue;
        }
        item.待选择 = { 类型: '选', 选什么: '物件', 标签: r.标签 ?? '选择一个物件', 玩家: item.操控者,
          候选: 候选.map((c) => ({ 键: c.uid, 名称: c.def.全名 })),
          数量: r.数量 ?? { 最小: 1, 最大: 1 } };
        return false;
      }
    }

    if (步骤.条件 !== undefined && !判断(g, item.操控者, 步骤.条件, item.来源 ?? item.card ?? undefined, item)) {
      item.上一步生效 = false;
      item.步骤游标++;
      continue;
    }
    执行一步(g, item, 步骤);
    if (item.待选择) return false;
    item.步骤游标++;
  }
  return true;
}

export function 应用选择(g: GameState, item: StackItem, 答: Action | null): void {
  const d = item.待选择;
  item.待选择 = undefined;
  if (!d) return;

  const 选 = (答 && 答.种类 === '决定' && Array.isArray(答.选)) ? (答.选 as (number | string)[]) : [];
  const 步骤 = item.steps[item.步骤游标!] as { 去处?: string; 从?: string[]; 玩家?: number } | undefined;
  if (false) {

  } else if (d.类型 === '选') {

    const 找 = (键: number | string): Obj | number | string => {
      if (typeof 键 !== 'number') return 键;
      return g.战场.find((x) => x.uid === 键)
        ?? g.players.flatMap((p) => [...p.hand, ...p.library, ...p.graveyard]).find((x) => x.uid === 键)
        ?? (item.暂存 ?? []).find((x) => x.uid === 键)
        ?? g.放逐区.find((x) => x.uid === 键) ?? 键;
    };
    item.本次选择 = 选.map(找);

    const 源 = (答 as unknown as { 支付源?: number[] }).支付源;
    if (Array.isArray(源) && 源.length) item.本次支付源 = 源;
    记录(g, g.players[d.玩家]!.name + ' 选了 '
      + (item.本次选择.map((x) => (typeof x === 'number' ? String(x) : typeof x === 'string' ? x : x.def.全名)).join('、') || '（没有）'));
    return;
  } else if ((步骤 && 步骤.去处 !== undefined) || (d as { 去处?: string }).去处 !== undefined) 完成搜寻(g, item, d, 步骤 ?? {}, 选.filter((x): x is number => typeof x === 'number'));
  item.步骤游标 = (item.步骤游标 ?? 0) + 1;
}

function 完成搜寻(g: GameState, item: StackItem, d: Extract<NonNullable<StackItem['待选择']>, { 类型: '搜寻' }>, 步骤: { 去处?: string; 玩家?: number; 筛选?: unknown }, 选: number[]): void {
  const pl = g.players[步骤.玩家 ?? item.操控者]!;
  const 看的是谁 = (d as { 玩家?: number }).玩家 ?? 步骤.玩家 ?? item.操控者;
  const 区域表: Record<string, Obj[]> = { 牌库: pl.library, 手牌: pl.hand, 墓地: pl.graveyard, 放逐区: g.放逐区, 战场: [...g.战场] };

  const 全区域 = [...Object.values(区域表), ...g.players.flatMap((x) => [x.library, x.hand, x.graveyard])];

  const 定选 = d.可放弃 ? 选.slice(0, d.数量) : (() => {
    const 已 = 选.slice(0, d.数量);
    if (已.length >= d.数量) return 已;
    const 余 = d.候选.map((c) => c.uid).filter((u) => !已.includes(u));
    return 已.concat(余.slice(0, d.数量 - 已.length));
  })();
  const 可取 = new Set(d.候选.map((c) => c.uid));
  const 取: Obj[] = [];
  for (const uid of 定选) {
    if (!可取.has(uid)) {

      记录(g, '⚠ 内部异常：选择里出现了不在候选内的牌（uid ' + uid + '），已忽略');
      continue;
    }
    for (const 区 of 全区域) {
      const i = 区.findIndex((c) => c.uid === uid);
      if (i >= 0) { 取.push(区.splice(i, 1)[0]!); break; }
    }
  }
  if (取.length === 0) {

    记录(g, pl.name + ' 从' + d.区域 + '搜寻：没有找到任何牌' + (d.可放弃 ? '（701.17b：可以选择不找出来）' : ''));
    return;
  }
  for (const c of 取) {

    if (步骤.去处 === '暂存') { 移到区域(g, c, '暂存'); (item.暂存 ??= []).push(c); }
    else if (步骤.去处 === '牌库顶') 移到区域(g, c, '牌库');

    else if (步骤.去处 === '战场') {
      if (是类别(g, c, '单位')) { (item.待放战场 ??= []).push(c); item.待放战场控 = pl.index; }
      else 进战场(g, c, pl.index, null);
    }

    else if (步骤.去处 === '墓地') 置入墓地(g, c);
    else 移到区域(g, c, '手牌');
  }
  const 去向 = 步骤.去处 === '战场' ? '放进战场' : 步骤.去处 === '牌库顶' ? '置于牌库顶' : 步骤.去处 === '墓地' ? '置入墓地' : 步骤.去处 === '暂存' ? '（暂存待放）' : '置于手上';

  item.上一步生效 = true;

  记录(g, pl.name + ' 从' + d.区域 + '搜寻到 ' + 取.length + ' 张牌（未展示，' + 去向 + '）');
}

function 收尾堆叠项(g: GameState, item: StackItem): void {
  if (item.种类 === '令符' && item.card && item.card.区域 === '堆叠') {

    置入墓地(g, item.card);
  }
}

function 结算令符(g: GameState, item: StackItem): boolean {
  const o = item.card!;
  const p = item.操控者;
  记录(g, '结算：' + o.def.全名);
  if (o.def.类别.includes('单位')) {

    let 阵地 = item.chosenSlot ?? null;
    if (!阵地 && item.本次选择 && typeof item.本次选择[0] === 'string') {
      阵地 = item.本次选择[0] as 阵地;
      item.本次选择 = undefined;
    }
    if (!阵地) {
      const 空 = 阵地顺序.filter((s2) => !g.players[p]!.阵地[s2]);
      if (!空.length) {

        记录(g, '301.10：没有可用的阵地，' + o.def.全名 + ' 留在当前区域');
        置入墓地(g, o);
        return true;
      }
      item.待选择 = { 类型: '选', 选什么: '阵地',
        标签: '301.11：为 ' + o.def.全名 + ' 选择一个进战场的阵地（' + g.players[p]!.name + ' 的空阵地）',
        玩家: p, 数量: { 最小: 1, 最大: 1 }, 候选: 空.map((x) => ({ 键: x, 名称: x })) };
      return false;
    }
    if (阵地) 进战场(g, o, p, 阵地);
    else { 记录(g, '没有可用的阵地'); }
    return true;
  }

  if (o.def.类别.includes('阵略') || o.def.类别.includes('战器')) {

    const 首 = item.目标.find((x) => typeof x !== 'number') as Obj | undefined;
    const 玩家目标 = item.目标.find((x) => typeof x === 'number') as number | undefined;

    if (首) 附属(g, o, 首.uid); else if (玩家目标 !== undefined) 附属(g, o, 玩家目标);
    进战场(g, o, p, null);

    执行步骤(g, item);
    return !item.待选择;
  }

  写区域(g, o, '堆叠');
  执行步骤(g, item);
  return !item.待选择;
}

function 第一个空阵地(g: GameState, p: number): 阵地 | null {
  for (const s of 阵地顺序) if (!g.players[p]!.阵地[s]) return s;
  return null;
}

function 取值(g: GameState, 控制器: number, v: Value, o?: Obj, 记忆源?: Obj, 宣告X?: number): number {

  if (typeof v === 'number') return v;
  if (v === 'X') return 宣告X ?? 0;
  if (!v || typeof v !== 'object') return 0;

  if (typeof v !== 'number' && '乘以' in v) return 取值(g, 控制器, v.乘以, o, 记忆源, 宣告X) * v.系数;
  if (typeof v === 'number') return v;
  if ('player' in v) {
    const pl = g.players[控制器]!;
    if (v.stat === '体力') return pl.体力;
    if (v.stat === '体力上限') return pl.lifeMax;
    return pl.hand.length;
  }

  if ('自身' in v) {
    if (!o) return 0;
    if (v.自身 === '武力') return 武力(g, o);
    if (v.自身 === '体力上限') return 体力上限(g, o);
    return o.damage;
  }

  if ('数' in v) {
    const 候 = 候选目标(g, 控制器, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: v.数 }, o ?? null);

    const 谁 = v.数.操控者;
    if (谁 === undefined || 谁 === '任意') return 候.length;
    return 候.filter((c) => !!c.obj
      && (谁 === '你' ? c.obj.owner === 控制器 : c.obj.owner !== 控制器)).length;
  }

  if ('记忆' in v) return Number(记忆源?.记忆[v.记忆] ?? 0);
  return 0;
}

function 判断(g: GameState, 控制器: number, c: Condition, o?: Obj, item?: StackItem): boolean {
  if (c.操作 === '与') return c.参数.every((x) => 判断(g, 控制器, x, o, item));
  if (c.操作 === '或') return c.参数.some((x) => 判断(g, 控制器, x, o, item));
  if (c.操作 === '非') return !判断(g, 控制器, c.参数, o, item);

  if (c.操作 === '附属在') return o?.附属在 !== undefined && o.附属在 === Number(c.目标);

  if (c.操作 === '本回合发生过') {
    const 找物 = (uid: number): Obj | undefined =>
      g.战场.find((x) => x.uid === uid)

      ?? g.stack.map((s) => s.card).find((x): x is Obj => !!x && x.uid === uid)
      ?? g.players.flatMap((pl) => [...pl.hand, ...pl.library, ...pl.graveyard]).find((x) => x.uid === uid)
      ?? g.放逐区.find((x) => x.uid === uid);
    return g.事件记录.some((ev) => {
      if (ev.事件 !== c.事件 || ev.回合 !== g.turn) return false;
      if (c.谁的 === undefined && c.筛选 === undefined) return true;
      if (typeof ev.受方 !== 'number') return false;
      const o2 = 找物(ev.受方);
      if (!o2) return false;
      if (c.谁的 !== undefined) {
        const 控 = 有效控制器(g, o2);
        if (c.谁的 === '你' ? 控 !== 控制器 : 控 === 控制器) return false;
      }
      return !c.筛选 || 符合筛选(g, o2, c.筛选);
    });
  }

  if (c.操作 === '回合是') {
    const 是我 = g.active === 控制器;
    return c.谁的 === '你' ? 是我 : !是我;
  }
  const l = 取值(g, 控制器, c.left, o), r = 取值(g, 控制器, c.right, o);
  switch (c.操作) {
    case '<=': return l <= r; case '<': return l < r;
    case '>=': return l >= r; case '>': return l > r;
    case '=': return l === r; default: return l !== r;
  }
}

function 解析受方(g: GameState, item: StackItem, r: any): (Obj | number)[] {
  if (r.ref === '操控者') return [item.操控者];
  if (r.ref === '额外牺牲') return item.额外牺牲 ? [item.额外牺牲] : [];
  if (r.ref === '自身') return item.来源 ? [item.来源] : (item.card ? [item.card] : []);

  if (r.ref === '触发受方') return item.触发受方 === undefined ? [] : [item.触发受方];

  if (r.记忆 !== undefined) { const v = 读记忆(item, r.记忆); return v === undefined ? [] : [v as number | Obj]; }

  if (r.ref === '暂存') return [...(item.暂存 ?? [])];
  if (r.目标 !== undefined) {
    const t = item.目标槽?.[r.目标];

    if (t !== undefined && t !== null && !(typeof t === 'object' && '堆叠项' in t)) return [t];

    const 实体 = item.目标.map(取实体).find((x): x is Obj => !!x);
    return 实体 === undefined ? [] : [实体];
  }

  if (r.选 !== undefined) return (item.本次选择 ?? []).filter((x): x is Obj | number => typeof x !== 'string');
  if (r.selectRelation) {
    const src = item.来源 ?? item.card;
    if (!src || !src.阵地) return [];
    const src阵地 = src.阵地;
    const 我 = 有效控制器(g, src);
    const 自己 = g.players[我]!;
    const 敌 = g.players[(我 + 1) % g.players.length]!;
    if (r.selectRelation === '相对') { const x = 敌.阵地[相对阵地(src阵地)!]; return x ? [x] : []; }
    if (r.selectRelation === '相邻') return 相邻阵地(src阵地).map((s) => 自己.阵地[s]).filter((x): x is Obj => !!x);
    return 斜对阵地(src阵地).map((s) => 敌.阵地[s]).filter((x): x is Obj => !!x);
  }
  if (r.selectAll) {
    const 全 = 候选目标(g, item.操控者, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: r.selectAll }, item.来源 ?? item.card, undefined, undefined, 记忆宿主(item) ?? undefined)
      .map((c) => c.obj ?? c.玩家!).filter((x) => x !== undefined);
    return r.个数 === undefined ? 全 : 全.slice(0, r.个数);
  }
  if (r.随机取) {

    const 池 = 候选目标(g, item.操控者, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: r.随机取 }, item.来源 ?? item.card, undefined, undefined, 记忆宿主(item) ?? undefined)
      .map((c) => c.obj ?? c.玩家!).filter((x) => x !== undefined);
    const n = r.个数 ?? 1;
    if (池.length <= n) return 池;
    const 剩 = [...池], 抽: (Obj | number)[] = [];
    for (let i = 0; i < n; i++) 抽.push(...剩.splice(Math.floor(g.随机源() * 剩.length), 1));
    return 抽;
  }
  return [];
}

function 解析玩家们(g: GameState, item: StackItem, r: 玩家指向 | undefined): number[] {
  if (r === undefined || r === '你') return [item.操控者];
  if (typeof r === 'number') return [r];
  const 出 = 解析受方(g, item, r).filter((x): x is number => typeof x === 'number');
  return 出.length ? 出 : [item.操控者];
}

function 记忆宿主(item: StackItem | null | undefined): Obj | null { return item?.来源 ?? item?.card ?? null; }

function 读记忆(item: StackItem | null, 键: string): unknown {
  if (!item) return undefined;
  return 记忆宿主(item)?.记忆[键];
}

function 存记忆(g: GameState, item: StackItem, 键: string, 值: unknown): void {
  const 宿主 = 记忆宿主(item);
  if (宿主) 写记忆(g, 宿主, 键, 值);
}

interface 伤害条目 { 目标: Obj | number; 数量: number; 来源: Obj | null;  战斗伤害?: boolean; 射击伤害?: boolean }

interface 适用效应 {
  键: string;
  规格: ReplacementSpec;

  持有者: Obj | null;

  控制器: number;
  时间印记: number;
  说明: string;

  战斗伤害?: boolean;

  射击伤害?: boolean;
}

let 替代深度 = 0;

function 替代适用于伤害(g: GameState, r: ReplacementSpec, 受方判断: (o: Obj) => boolean, 来源对象: Obj | null, 控制器: number, 条目: 伤害条目): boolean {
  if (r.替代.事件 !== '伤害' && r.替代.事件 !== '造成伤害') return false;
  const 受 = r.替代.受方;
  if (受 === '自身') {
    if (typeof 条目.目标 === 'number' || !受方判断(条目.目标)) return false;
  } else if (受 === '你') {
    const 谁的 = typeof 条目.目标 === 'number' ? 条目.目标 : 有效控制器(g, 条目.目标);
    if (谁的 !== 控制器) return false;
  }
  if (r.替代.来源 === '自身' && (!来源对象 || 条目.来源 !== 来源对象)) return false;

  if (r.替代.来源 === '其他单位') {
    const 源 = 条目.来源;
    if (!源 || 源 === 来源对象 || 有效控制器(g, 源) !== 控制器) return false;
  }

  if (r.限战斗伤害 !== undefined && !!条目.战斗伤害 !== r.限战斗伤害) return false;

  if (r.限射击 && !条目.射击伤害) return false;
  if (r.条件 && !判断(g, 控制器, r.条件)) return false;
  return true;
}

function 收集伤害替代效应(g: GameState, 条目: 伤害条目): 适用效应[] {
  const out: 适用效应[] = [];

  for (const o of g.战场) {
    const abs = (o.def.能力?.能力 ?? []) as StaticAbility[];
    abs.forEach((ab, i) => {
      if (ab.种类 !== '静止式' || !ab.替代效应) return;

      const 受方判断 = ab.替代效应.替代.受方 === '任意' ? (() => true) : ((x: Obj | null) => x === o);
      if (!替代适用于伤害(g, ab.替代效应, 受方判断, o, 有效控制器(g, o), 条目)) return;
      out.push({
        键: o.uid + '#' + i, 规格: ab.替代效应, 持有者: o,
        控制器: 有效控制器(g, o), 时间印记: o.时间印记,
        说明: ab.替代效应.说明 ?? (o.def.全名 + ' 的替代性效应'),
      });
    });
  }

  for (const c of g.连续效应) {
    const 替 = c.载荷.替代;
    if (!替) continue;

    const 受方判断 = (o: Obj | null): boolean => {
      if (!o) return false;
      if (c.指定 !== undefined) return o.uid === c.指定;
      if (c.受锁定) return c.受锁定.includes(o.uid);
      if (c.范围) return 符合选择器(g, o, c.范围, c.来源, c.控制器, 有效特征(g, o));
      return o === c.来源;
    };
    if (!替代适用于伤害(g, 替, 受方判断, c.来源, c.控制器, 条目)) continue;
    out.push({
      键: '持续#' + c.id, 规格: 替, 持有者: c.来源,
      控制器: c.控制器, 时间印记: c.时间印记,
      说明: 替.说明 ?? '持续性的替代性效应',
    });
  }

  if (typeof 条目.目标 !== 'number') {
    const 坚 = 词值(g, 条目.目标, '坚韧');
    if (坚 > 0) {
      out.push({
        键: '坚韧#' + 条目.目标.uid, 持有者: 条目.目标,
        控制器: 有效控制器(g, 条目.目标), 时间印记: 条目.目标.时间印记,
        说明: 条目.目标.def.全名 + ' 的坚韧',
        规格: { 替代: { 事件: '伤害', 受方: '自身' }, 自身替代: false, 防止: 坚 },
      });
    }
  }
  return out.sort((x, y) => x.时间印记 - y.时间印记);
}

function 选择生效的(适用: 适用效应[]): 适用效应 {
  const 自我 = 适用.filter((x) => x.规格.自身替代);
  return 自我[0] ?? 适用[0]!;
}

function 按运算(前: number, 运: { 运算: string; 值: number }): number {
  if (运.运算 === '加') return 前 + 运.值;
  if (运.运算 === '减') return 前 - 运.值;
  if (运.运算 === '乘') return 前 * 运.值;
  return 运.值;
}

function 施加替代与防止(g: GameState, 条目: 伤害条目): number {
  if (替代深度 > 8) { 记录(g, '替代性效应递归过深，停止（护栏）'); return 条目.数量; }
  const 已用 = new Set<string>();
  let 数量 = 条目.数量;
  let 守卫 = 0;
  while (守卫++ < 16) {
    if (数量 <= 0) break;
    const 适用 = 收集伤害替代效应(g, { ...条目, 数量 }).filter((x) => !已用.has(x.键));
    if (适用.length === 0) break;
    const 选 = 选择生效的(适用);
    if (适用.length > 1) {
      记录(g, '616.1：' + 适用.map((x) => x.说明).join('、') + ' 都适用；先应用「' + 选.说明 + '」');
    }
    已用.add(选.键);
    const r = 选.规格;
    if (r.略过) {
      记录(g, 选.说明 + '：略过这个伤害事件');
      数量 = 0;
      continue;
    }
    const 旧防止 = r.应用?.find((x) => x.操作 === '防止');
    const 防值 = r.防止 ?? (旧防止 && 旧防止.操作 === '防止' ? 旧防止.点数 : undefined);
    if (防值 !== undefined) {
      const 实防 = Math.min(防值, 数量);
      数量 -= 实防;
      记录(g, 选.说明 + '：防止 ' + 实防 + ' 点伤害（剩 ' + 数量 + '）');
      continue;
    }
    if (r.数量) {
      const 前 = 数量;
      数量 = Math.max(0, 按运算(数量, r.数量));
      记录(g, 选.说明 + '：伤害 ' + 前 + ' → ' + 数量);
      continue;
    }
    if (r.应用 && r.应用.length) {
      记录(g, 选.说明 + '：改为其它事件（原事件从未发生）');
      替代深度++;
      try {
        const 假项: StackItem = {
          id: g.nextStackId++, 种类: '触发式', 标签: 选.说明,
          操控者: 选.控制器, 来源: 选.持有者, card: null,
          目标: [], 目标槽: {}, steps: r.应用,
        };
        for (const st of r.应用) 执行一步(g, 假项, st);
      } finally { 替代深度--; }
      数量 = 0;
      break;
    }
    记录(g, 选.说明 + '：没有可执行的改写，忽略');
  }
  return Math.max(0, 数量);
}

export function 伤害事件(
  g: GameState,
  来源: Obj | null,
  受方: { 目标: Obj | number; 数量: number; 来源?: Obj | null; 战斗伤害?: boolean; 不能被防止?: boolean; 射击伤害?: boolean }[],
): void {

  const 重定向后 = 受方.map((r) => {
    if (typeof r.目标 !== 'number' || !r.战斗伤害) return r;
    const 挡刀 = g.战场.find((x) => 有效控制器(g, x) === r.目标 && x.区域 === '战场' && 有词(g, x, '舍身'));
    if (!挡刀) return r;
    记录(g, '舍身（702.23b）：' + g.players[r.目标]!.name + ' 的 ' + 挡刀.def.全名 + ' 替他承受 ' + r.数量 + ' 点战斗伤害（不能被防止）');
    return { ...r, 目标: 挡刀 as Obj | number, 不能被防止: true };
  });
  const 有效 = 重定向后.filter((r) => r.目标 !== undefined && r.目标 !== null);
  if (有效.length === 0) { 记录(g, '伤害事件没有合法受方（已忽略）'); return; }
  if (有效.every((r) => r.数量 <= 0)) return;

  const 实际 = 有效.map((r) => {

    {
      const 源0 = r.来源 ?? 来源;
      if (typeof r.目标 !== 'number' && 源0 && 抵抗挡住伤害(g, r.目标, 源0)) {
        记录(g, '抵抗（702.2c）：' + r.目标.def.全名 + ' 不会被 ' + 源0.def.全名 + ' 造成伤害');
        return { ...r, 来源: 源0, 数量: 0 };
      }
    }
    const 源 = r.来源 ?? 来源;

    const 净 = 施加替代与防止(g, { 目标: r.目标, 数量: r.数量, 来源: 源, 战斗伤害: r.战斗伤害, 射击伤害: r.射击伤害 });
    if (净 > 0) {
      const 受 = typeof r.目标 === 'number' ? undefined : r.目标.uid;
      const 源uid = 源?.uid;
      记事件(g, '受到伤害', { 来源: 源uid, 受方: 受, 数量: 净 });
      if (源uid !== undefined) {
        记事件(g, '造成伤害', { 来源: 源uid, 受方: 受, 数量: 净 });
        if (源) 排队造成伤害触发(g, 源, r.目标, 净);
      }
    }
    return { ...r, 来源: 源, 数量: 净 };
  });
  const 描述 = 实际
    .map((r) => {
      const 源 = r.来源 ?? 来源;
      const 受 = typeof r.目标 === 'number' ? g.players[r.目标]!.name : r.目标.def.全名;
      return (源 ? 源.def.全名 : '（无来源）') + '->' + 受 + ' ' + r.数量;
    })
    .join('，');
  if (实际.every((r) => r.数量 <= 0)) {
    记录(g, '伤害全部被防止或替代，该伤害事件不发生（120.9）：' + 描述);
    检查状态动作(g);
    return;
  }
  记录(g, '伤害事件：' + 描述);
  for (const r of 实际) {
    if (r.数量 <= 0) continue;
    const 源 = r.来源 ?? 来源;
    const 有致命 = 源 ? 有词(g, 源, '致命') : false;
    if (typeof r.目标 === 'number') {
      const pl = g.players[r.目标]!;
      pl.体力 -= r.数量;

      if (源 && 带词(g, 源, '斩获')) {
        const 得主 = g.players[有效控制器(g, 源)]!;
        得主.体力 = Math.min(得主.体力 + r.数量, 得主.lifeMax);
        记录(g, '斩获：' + 得主.name + ' 回复 ' + r.数量 + ' 点体力（702.14b）');
      }

      const 天命 = pl.标记['天命'] ?? 0;
      if (天命 > 0) {
        const 移 = Math.min(天命, r.数量);
        pl.标记['天命'] = 天命 - 移;
        记录(g, pl.name + ' 移去 ' + 移 + ' 个天命标记（122.1d，剩 ' + pl.标记['天命'] + '）');
      }

      排队玩家受到伤害触发(g, r.目标, r.数量);
      continue;
    }

    if (是类别(g, r.目标, '化身')) {
      const 灵 = r.目标.标记.find((m) => m.类型 === '灵值');
      const 移 = Math.min(灵 ? 灵.数量 : 0, r.数量);
      if (灵) { 灵.数量 -= 移; if (灵.数量 <= 0) 写标记表(g, r.目标, r.目标.标记.filter((m) => m !== 灵)); }
      记录(g, r.目标.def.全名 + ' 移去 ' + 移 + ' 个灵值标记（302.6）');
      continue;
    }
    写伤害(g, r.目标, r.目标.damage + r.数量);
    if (有致命 && 是类别(g, r.目标, '单位')) 写记忆(g, r.目标, '致命伤害', true);
    排队受到伤害触发(g, r.目标, r.数量);
  }
  检查状态动作(g);
}

export function 排队关键词触发(g: GameState, o: Obj, 时机: '结束步骤' | '进入相对阵地', 进入者?: Obj): void {
  if (o.区域 !== '战场' || !有规则叙述(g, o)) return;
  const 名字们 = ((o.def.能力?.能力 ?? []) as { 名称?: string }[])
    .map((ab) => ab.名称).filter((x): x is string => !!x);
  for (const k of 名字们) {
    if (k === '重整' && 时机 === '结束步骤') {
      g.pending.push({
        来源: o, abilityIndex: -1, 标签: 触发标签(o, '重整'),
        能力: {
          种类: '触发式', 触发: { 事件: '步骤开始', 步骤: '结束步骤' },
          效应: [{ 操作: '重置', 目标: { ref: '自身' } }, { 操作: '回复', 目标: { ref: '自身' } }],
        },
      });
    }
    if (k === '迎击' && 时机 === '进入相对阵地' && 进入者) {
      const n = 词值(g, o, '迎击');
      if (n <= 0) continue;
      const spec = { 目标名: 't', 数量: { 最小: 1, 最大: 1 }, 选择: { 区域: '战场' as const, 种类: '单位' as const } };
      g.pending.push({
        来源: o, abilityIndex: -1, 标签: 触发标签(o, '迎击'),
        预选: { 目标: [进入者], 目标槽: { t: 进入者 } },
        能力: {
          种类: '触发式', 触发: { 事件: '进战场' },
          目标: [spec],
          效应: [{ 操作: '伤害', 来源: '自身', 事件: [{ 受方: { 目标: 't' }, 点数: n }] }],
        },
      });
    }
  }
}

function 执行一步(g: GameState, item: StackItem, 步骤: ResolveStep): void {

      const 需前一 = (步骤 as { 若前一效应生效?: boolean }).若前一效应生效;
      const 上一步 = item.上一步生效 === true;
  if (需前一 !== undefined && 需前一 !== 上一步) { item.上一步生效 = false; return; }
  item.上一步生效 = false;

  if ((步骤 as { 可选?: boolean }).可选 === true) {
    const 答 = item.本次选择;
    if (答 === undefined) {
      item.待选择 = { 类型: '选', 选什么: '选项', 玩家: item.操控者,
        标签: '你可以这样做：（这一步）', 数量: { 最小: 1, 最大: 1 },
        候选: [{ 键: '接受', 名称: '这样做' }, { 键: '放弃', 名称: '不这样做' }] };
      return;
    }
    item.本次选择 = undefined;
    const 不做 = !Array.isArray(答) || 答.length === 0 || 答[0] === '放弃';
    if (不做) return;
    item.上一步生效 = true;
  }
  switch (步骤.操作) {
    case '失去体力': {

      const 失量 = typeof 步骤.数量 === 'number' ? 步骤.数量 : 取值(g, item.操控者, 步骤.数量, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X);
      for (const t of 解析受方(g, item, 步骤.目标)) {
        if (typeof t === 'number') { const pl = g.players[t]!; pl.体力 -= 失量; 记录(g, pl.name + ' 失去 ' + 失量 + ' 点体力'); }
        else { 写伤害(g, t, t.damage + 失量); 记录(g, t.def.全名 + ' 失去 ' + 失量 + ' 点体力（已损失 ' + t.damage + '）'); }
      }
      break;
    }
    case '重置':
      for (const t of 解析受方(g, item, 步骤.目标)) if (typeof t !== 'number' && t.tapped) { 写横置(g, t, false); 记录(g, t.def.全名 + ' 被重置'); }
      break;
      case '回复': {

        const 量 = 步骤.数量 === '触发事件量' ? (item.触发量 ?? 0)
          : (typeof 步骤.数量 === 'object' && 步骤.数量 !== null) ? 取值(g, item.操控者, 步骤.数量 as Value, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X)
          : (步骤.数量 === 'X' ? 0 : 步骤.数量);
        for (const t2 of 解析受方(g, item, 步骤.目标)) {
          if (typeof t2 === 'number') {
            const pl = g.players[t2]!;
            if (量 === undefined) { pl.体力 = pl.lifeMax; 记录(g, pl.name + ' 的体力回复至上限'); }
            else if (量 > 0) { const 前 = pl.体力; pl.体力 = Math.min(pl.lifeMax, pl.体力 + 量); 记录(g, pl.name + ' 回复 ' + (pl.体力 - 前) + ' 点体力'); }

            记事件(g, '回复体力', { 受方: t2, 数量: 量 });
            排队回复体力触发(g, t2);
          } else if (量 === undefined && t2.damage > 0) {
            写伤害(g, t2, 0);
            记录(g, t2.def.全名 + ' 的已损失体力被回复');
            记事件(g, '回复体力', { 受方: t2.uid, 数量: undefined });
            排队回复体力触发(g, t2);
          }
        }
        break;
      }
    case '消灭': {
      for (const t of 解析受方(g, item, 步骤.目标)) {
        if (typeof t === 'number' || t.区域 !== '战场') continue;
        记录(g, t.def.全名 + ' 被消灭');
        置入墓地(g, t);
      }
      break;
    }
    case '选择牺牲': {

      const p = 解析玩家们(g, item, 步骤.玩家)[0];
      if (p === undefined) { 记录(g, '选择牺牲：找不到那个玩家'); break; }
      if (item.本次选择) {
        const t = item.本次选择[0];
        item.本次选择 = undefined;
        if (t !== undefined && typeof t !== 'number' && typeof t !== 'string') { 牺牲(g, t); item.上一步生效 = true; }
        break;
      }
      const 源 = item.来源 ?? item.card;
    const 可牺 = g.战场.filter((x) => 有效控制器(g, x) === p
      && (!步骤.除自身 || x !== 源)
      && (!步骤.筛选 || 符合筛选(g, x, 步骤.筛选, 有效特征(g, x))));

    if (可牺.length === 0) { 记录(g, g.players[p]!.name + ' 没有可牺牲的单位'); item.上一步生效 = false; break; }

      item.待选择 = { 类型: '选', 选什么: '物件', 标签: '选择一个单位牺牲', 玩家: p,
        候选: 可牺.map((c) => ({ 键: c.uid, 名称: c.def.全名 })), 数量: { 最小: 1, 最大: 1 } };
      return;
    }
    case '牺牲': {
      for (const t of 解析受方(g, item, 步骤.目标)) {
        if (typeof t === 'number' || t.区域 !== '战场') continue;
        牺牲(g, t);
      }
      break;
    }
    case '弃牌': {

      const 号 = 解析玩家们(g, item, 步骤.玩家)[0]!;
      const pl = g.players[号]!;
      if (item.本次选择) {
        for (const t of item.本次选择) if (t && typeof t !== 'number' && typeof t !== 'string') { 移到区域(g, t, '墓地'); 记录(g, pl.name + ' 弃掉 ' + t.def.全名); }
        item.本次选择 = undefined;
        break;
      }
      const 要弃 = Math.min(步骤.数量, pl.hand.length);
      if (要弃 === 0) { 记录(g, pl.name + ' 没有手牌可弃'); break; }

      item.待选择 = { 类型: '选', 选什么: '物件', 标签: '选 ' + 要弃 + ' 张手牌弃掉', 玩家: 号,
        候选: pl.hand.map((c) => ({ 键: c.uid, 名称: c.def.全名 })), 数量: { 最小: 要弃, 最大: 要弃 } };
      return;
    }
    case '展示': {

      if (item.本次选择 !== undefined) { item.本次选择 = undefined; break; }
      const 牌们: Obj[] = [];
      if (步骤.从) {

        牌们.push(...解析受方(g, item, 步骤.从).filter((x): x is Obj => typeof x !== 'number'));
        if (牌们.length) 记录(g, '展示：' + 牌们.map((c) => c.def.全名).join('、'));
      } else {
        for (const p of 解析玩家们(g, item, 步骤.玩家)) {
          const pl = g.players[p]!;
          const n = Math.min(步骤.数量 ?? 0, pl.library.length);
          const 顶 = pl.library.slice(-n).reverse();
          牌们.push(...顶);
          const 见 = 顶.map((c) => c.def.全名);
          记录(g, pl.name + ' 展示牌库顶 ' + n + ' 张：' + (见.join('、') || '（牌库空）'));
        }
      }
      if (牌们.length) {
        item.待选择 = { 类型: '选', 选什么: '物件', 玩家: item.操控者,
          标签: '展示：' + 牌们.map((c) => c.def.全名).join('、') + '（双方确认后继续）',
          数量: { 最小: 0, 最大: 0 },
          候选: 牌们.map((c) => ({ 键: c.uid, 名称: c.def.全名, 区: '牌库' })),
          等双方确认: true };
        return;
      }
      break;
    }
    case '搜寻': {

      const pl = g.players[(步骤.玩家 === undefined ? item.操控者 : (解析玩家们(g, item, 步骤.玩家)[0] ?? item.操控者))]!;
      const 区域 = 步骤.从 ?? ['牌库'];

      const 全部 = 区域.flatMap((z) => 检视区域(g, item.操控者, [pl.index], z as '手牌' | '牌库' | '牌库顶' | '墓地' | '放逐区' | '战场').牌);
      const 命中 = 全部.filter((c) => 符合筛选(g, c, 步骤.筛选, 有效特征(g, c)));
      const 要 = Math.min(步骤.数量 ?? 1, 命中.length);
      item.待选择 = {
        类型: '搜寻',
        标签: '从' + 区域.join('、') + '搜寻 ' + (步骤.数量 ?? 1) + ' 张（符合条件 ' + 命中.length + ' 张）',
        区域: 区域.join('、'),
        数量: 要,

        可放弃: 要 === 0 || 区域.some((z) => z === '牌库' || z === '牌库顶' || z === '手牌'),
        候选: 命中.map((c) => ({ uid: c.uid, 名称: c.def.全名 })),

        查看: 全部.map((c) => ({ uid: c.uid, 名称: c.def.全名 })),
        玩家: pl.index,
      };      return;
    }
    case '放置暂存': {

      if (步骤.从) {

        const 收 = (步骤.从 && typeof 步骤.从 === 'object' && '目标' in 步骤.从)
          ? (item.目标 ?? []).filter((x): x is Obj => !!x && typeof x !== 'number' && !('堆叠项' in x))
          : 解析受方(g, item, 步骤.从).filter((x): x is Obj => typeof x !== 'number');
        if (收.length) { for (const c of 收) 移到区域(g, c, '暂存'); item.暂存 = [...(item.暂存 ?? []), ...收]; }
      }
      const 列 = item.暂存 ?? [];
      if (列.length === 0) { 记录(g, '放置暂存：暂存位是空的'); break; }

      if (步骤.顺序 === '玩家' && item.本次选择 === undefined) {
        item.暂存 = 列;
        item.待选择 = { 类型: '选', 选什么: '物件', 玩家: item.操控者,
          标签: '以任意顺序放（先点的在上面/更靠底 ✓）：' + 列.map((c) => c.def.全名).join('、'),
          数量: { 最小: 列.length, 最大: 列.length },
          候选: 列.map((c) => ({ 键: c.uid, 名称: c.def.全名 })),

          查看: 列.map((c) => ({ 键: c.uid, 名称: c.def.全名 })) };
        return;
      }
      const 排 = (步骤.顺序 === '玩家' && Array.isArray(item.本次选择))
        ? 列.slice().sort((a, b) => item.本次选择!.indexOf(a.uid) - item.本次选择!.indexOf(b.uid))
        : 列;
      if (步骤.顺序 === '玩家') item.本次选择 = undefined;
      item.暂存 = undefined;

      for (let idx = 0; idx < 排.length; idx++) {
        const c = 排[idx]!;
        const 主人 = g.players[c.owner]!;
        if (步骤.去处 === '牌库顶') { 移到区域(g, c, '牌库'); 记录(g, c.def.全名 + ' 被置于 ' + 主人.name + ' 的牌库顶'); }

        else if (步骤.去处 === '牌库底') {
          移到区域(g, c, '牌库');
          const 库 = 主人.library; const i3 = 库.indexOf(c);
          if (i3 >= 0) { 库.splice(i3, 1); 库.unshift(c); }
          记录(g, c.def.全名 + ' 被置于 ' + 主人.name + ' 的牌库底');
        }
        else if (步骤.去处 === '手牌') { 移到区域(g, c, '手牌'); 记录(g, c.def.全名 + ' 被置于 ' + 主人.name + ' 的手上'); }
        else if (步骤.去处 === '墓地') { 置入墓地(g, c); 记录(g, c.def.全名 + ' 被置于墓地'); }

        else if (是类别(g, c, '单位')) {
          const 控 = 步骤.操控者 === '你' ? item.操控者 : c.owner;
          let 阵地 = (item.本次选择 && typeof item.本次选择[0] === 'string') ? item.本次选择[0] as 阵地 : null;
          if (阵地) item.本次选择 = undefined;
          if (!阵地) {
            const 空 = 阵地顺序.filter((s2) => !g.players[控]!.阵地[s2]);
            if (!空.length) { 记录(g, '301.10：没有可用的阵地，' + c.def.全名 + ' 留在当前区域'); continue; }

            item.暂存 = 排.slice(idx + 1);
            item.待选择 = { 类型: '选', 选什么: '阵地',
              标签: '301.11：为 ' + c.def.全名 + ' 选择一个进战场的阵地（' + g.players[控]!.name + ' 的空阵地）',
              玩家: 控, 数量: { 最小: 1, 最大: 1 }, 候选: 空.map((x) => ({ 键: x, 名称: x })) };
            return;
          }
          进战场(g, c, 控, 阵地, { 横置: 步骤.横置 });
          记录(g, c.def.全名 + ' 被放进战场' + (控 !== c.owner ? '（在 ' + g.players[控]!.name + ' 的操控下）' : '') + '（' + 阵地 + '）');

        }
        else {
          const 控 = 步骤.操控者 === '你' ? item.操控者 : c.owner;
          进战场(g, c, 控, null, { 横置: 步骤.横置 });
          记录(g, c.def.全名 + ' 被放进战场' + (控 !== c.owner ? '（在 ' + g.players[控]!.name + ' 的操控下）' : ''));
        }
      }
      item.暂存 = undefined;
      break;
    }
    case '限制玩家': {
      const p = typeof 步骤.玩家 === 'number' ? 步骤.玩家 : (item.目标槽?.[步骤.玩家.目标] as number | undefined);
      if (typeof p !== 'number') { 记录(g, '限制玩家：目标不是玩家，什么也不发生'); break; }

      const 到期 = 步骤.时长 === '直到回合结束' ? g.turn : g.turn + 9999;
      g.players[p]!.限制.push({ 禁止: 步骤.禁止, 筛选: 步骤.筛选, 到期 });
      记录(g, g.players[p]!.name + ' 被限制：不能' + 步骤.禁止
        + (步骤.筛选 ? '（限定：' + JSON.stringify(步骤.筛选) + '）' : '')
        + '（613.10，到第 ' + 到期 + ' 回合结束）');
      break;
    }
    case '洗牌': {
      for (const p of 解析玩家们(g, item, 步骤.玩家)) {
        const pl = g.players[p]!;
        pl.library = 洗牌(pl.library, g.随机源);
        记录(g, pl.name + ' 洗牌');
      }
      break;
    }
    case '磨牌': {
      for (const p of 解析玩家们(g, item, 步骤.玩家)) {
        const pl = g.players[p]!;
        const n = Math.min(步骤.数量, pl.library.length);
        for (let i = 0; i < n; i++) { const c = pl.library[pl.library.length - 1]!; 移到区域(g, c, '墓地'); }
        记录(g, pl.name + ' 将牌库顶 ' + n + ' 张置入墓地');
      }
      break;
    }
    case '征召': {

      const 个数 = typeof 步骤.数量 === 'number' ? 步骤.数量
        : 取值(g, item.操控者, 步骤.数量 as Value, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X);

      const 阵地表 = 步骤.阵地?.map((x) =>
        (x && typeof x === 'object' && '触发受方' in x) ? (item.死者位置 ?? null) : x);

      const 是否单位 = (步骤.指示物?.类别 ?? []).includes('单位');
      if (是否单位 && !步骤.阵地) {
        const 允许少征 = /至多/.test(JSON.stringify(步骤) + (item.标签 ?? ''));
        const 空 = 阵地顺序.filter((s2) => !g.players[item.操控者]!.阵地[s2]);
        const 标记 = item as unknown as { 征召已问?: boolean };
        if (!标记.征召已问) {

          const 可问 = Math.min(个数, 空.length);
          if (可问 <= 0) {
            记录(g, '112.6：没有可选的空阵地，其余指示物不能进场');
          } else {
            标记.征召已问 = true;
            item.待选择 = {
              类型: '选', 选什么: '阵地',
              标签: '为 ' + 可问 + ' 个指示物选阵地（' + g.players[item.操控者]!.name + ' 的空阵地，一次选完）'
                + (允许少征 ? '——也可以点「不选」不再征召' : ''),
              玩家: item.操控者,
              数量: 允许少征 ? { 最小: 0, 最大: 可问 } : { 最小: 可问, 最大: 可问 },
              候选: 空.map((x) => ({ 键: x, 名称: x })),
            };
            return;
          }
        } else {

          const 答案 = (item.本次选择 ?? []).filter((x): x is 阵地 => typeof x === 'string' && 空.includes(x as 阵地));
          item.本次选择 = undefined;
          if (!答案.length) 记录(g, '征召：没有指示物进场（个数 ' + 个数 + '）');
          else 征召(g, item.操控者, 步骤.指示物, 答案.length, 答案, 步骤.关键词);
          标记.征召已问 = undefined;
          break;
        }
      }

      征召(g, item.操控者, 步骤.指示物, 个数, 阵地表, 步骤.关键词);
      break;
    }
    case '放玩家标记': {
      const pl = g.players[item.操控者]!;
      pl.标记[步骤.标记] = (pl.标记[步骤.标记] ?? 0) + 步骤.数量;
      记录(g, pl.name + ' 得到 ' + 步骤.数量 + ' 个「' + 步骤.标记 + '」标记（共 ' + pl.标记[步骤.标记] + '）');
      break;
    }
    case '略过': {
      for (const t of 解析受方(g, item, 步骤.目标)) {
        const p = typeof t === 'number' ? t : 有效控制器(g, t);
        const pl = g.players[p]!;
        pl.跳过[步骤.什么] = (pl.跳过[步骤.什么] ?? 0) + 1;
        记录(g, pl.name + ' 将略过下一次' + 步骤.什么 + '（共 ' + pl.跳过[步骤.什么] + ' 次）');
      }
      break;
    }
    case '放置标记': {
      for (const t of 解析受方(g, item, 步骤.目标)) {
        if (typeof t === 'number') continue;
        const 戳 = g.nextStamp++;
        const 已 = t.标记.find((m) => m.类型 === 步骤.标记);
        if (已) { 改标记(g, 已, { 数量: 已.数量 + 步骤.数量, 时间印记: 戳 }); }
        else 加标记(g, t, { 类型: 步骤.标记, 数量: 步骤.数量, 时间印记: 戳 });
        记录(g, t.def.全名 + ' 得到 ' + 步骤.数量 + ' 个「' + 步骤.标记 + '」标记');
      }
      break;
    }
    case '移去标记': {
      for (const t of 解析受方(g, item, 步骤.目标)) {
        if (typeof t === 'number') continue;
        const 已 = t.标记.find((m) => m.类型 === 步骤.标记);
        if (!已) continue;
        已.数量 -= 步骤.数量;
        if (已.数量 <= 0) 写标记表(g, t, t.标记.filter((m) => m !== 已));
        记录(g, t.def.全名 + ' 移去 ' + 步骤.数量 + ' 个「' + 步骤.标记 + '」标记');
      }
      break;
    }
    case '持续': {

      let 条件 = 步骤.条件 as Condition | undefined;
      if (条件 && 条件.操作 === '附属在') {
        const t = 解析受方(g, item, { 目标: 条件.目标 })[0];
        条件 = { 操作: '附属在', 目标: String(typeof t === 'number' ? t : (t?.uid ?? '')) };
      }

      const 时长 = 步骤.时长 === '直到回合结束' ? '直到回合结束' : '直到游戏结束';
      let 指定: number | undefined;
      let 受锁定: number[] | undefined;

      let 范围: Selector | undefined;
      if (步骤.目标 === '自己') {
        指定 = (item.来源 ?? item.card)?.uid;
      } else if (typeof 步骤.目标 === 'object' && 'selectAll' in 步骤.目标) {
        范围 = 步骤.目标.selectAll;

        受锁定 = 候选目标(g, item.操控者, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: 范围 }, item.来源 ?? item.card)
          .map((c) => c.obj?.uid).filter((x): x is number => x !== undefined);
      } else {
        const t = 解析受方(g, item, 步骤.目标 as RecipientRef)[0];
        if (typeof t === 'number') { 记录(g, '持续性效应指向玩家，暂未实现'); break; }
        指定 = t?.uid;
      }

      if (!范围 && !指定) {
        const a = 步骤.作用 ?? '你操控';
        if (a === '你操控') 范围 = { 区域: '战场', 操控者: '你' };
        else if (a === '所有') 范围 = { 区域: '战场' };
      }

      if (步骤.层?.操控权 !== undefined) {
        const 受 = 指定 !== undefined
          ? [取实体(item.来源 ?? item.card), ...item.目标.map(取实体)].filter((x): x is Obj => !!x && x.uid === 指定)
          : (范围 ? 候选目标(g, item.操控者, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: 范围 }, item.来源 ?? item.card).map((c) => c.obj) : []);
        for (const t of 受) {
          if (!t || t.区域 !== '战场') continue;
          if (有效控制器(g, t) === item.操控者) continue;

          const 空 = 阵地顺序.filter((x) => !g.players[item.操控者]!.阵地[x]);
          const 原始 = item.本次选择 && item.本次选择.length ? item.本次选择[0] : undefined;
          const 答: 阵地 | null = typeof 原始 === 'string' && (阵地顺序 as readonly string[]).includes(原始)
            ? (原始 as 阵地) : null;
          if (答 === null) {
            if (空.length === 0) { 获得操控权时移动(g, t, item.操控者); continue; }
            清出阵地(g, t);
            item.本次选择 = undefined;

            item.待选择 = { 类型: '选', 选什么: '阵地',
              标签: '选择 ' + t.def.全名 + ' 移到哪个空阵地',
            玩家: item.操控者, 数量: { 最小: 1, 最大: 1 },
              候选: 空.map((x) => ({ 键: x as string, 名称: x as string })) };
            return;
          }
          item.本次选择 = undefined;
          if (!g.players[item.操控者]!.阵地[答]) {
            清出阵地(g, t);
            写阵地(g, t, 答); g.players[item.操控者]!.阵地[答] = t;
            记录(g, '301.8：' + t.def.全名 + ' 移到 ' + g.players[item.操控者]!.name + ' 的 ' + 答);
          } else {
            获得操控权时移动(g, t, item.操控者);
          }
        }
      }
      加连续效应(g, {
        id: g.nextStackId++, 时间印记: g.nextStamp++, 来源: item.来源 ?? item.card ?? null,
        控制器: item.操控者, 时长, 范围, 受锁定, 指定, 条件,

        载荷: { ...(步骤.层 ? { 层: 步骤.层 } : {}), ...(步骤.替代 ? { 替代: 步骤.替代 } : {}) },
      });
      记录(g, '持续效应（' + 时长 + '）：' + (item.card?.def.全名 ?? item.标签));
      break;
    }
    case '伤害': {

      const src = 步骤.来源 === '自身' ? (item.来源 ?? item.card)
        : (typeof 步骤.来源 === 'object' ? (解析受方(g, item, 步骤.来源)[0] as Obj | undefined) ?? null : null);

      const 受方: { 目标: Obj | number; 数量: number; 战斗伤害?: boolean; 射击伤害?: boolean }[] = [];
      for (const e2 of 步骤.事件) {

        const 算量 = (t: Obj | number): number => {
          const v = e2.点数;
          if (typeof v === 'number') return v;
          if (v === 'X') return item.宣告X ?? 0;
          if (v === '触发事件量') return item.触发量 ?? 0;
          if (v === '来源武力') return src && typeof src !== 'number' ? 武力(g, src) : 0;
          if (v && typeof v === 'object' && '武力' in v) {
            const r = 解析受方(g, item, (v as { 武力: RecipientRef }).武力).find((x): x is Obj => typeof x !== 'number');
            return r ? 武力(g, r) : 0;
          }
          return typeof t === 'number' ? 0 : 武力(g, t);
        };

        const se = e2.受方 as unknown as { selectRelation?: string; 相对?: unknown };
        if (se && typeof se === 'object' && se.selectRelation) {

          const 锚 = (se.相对 != null ? 解析受方(g, item, se.相对).find((x): x is Obj => typeof x !== 'number') : undefined)
            ?? (item.来源 ?? item.card ?? undefined);
          if (锚 && 锚.阵地) {
            const 控 = 有效控制器(g, 锚);
            const 自己 = g.players[控]!;
            const 敌 = g.players[(控 + 1) % g.players.length]!;
            const 邻 = se.selectRelation === '相邻';
            const 位: 阵地[] = se.selectRelation === '相对' ? [相对阵地(锚.阵地)!]
              : 邻 ? 相邻阵地(锚.阵地) : 斜对阵地(锚.阵地);
            for (const x of 位) {
              const t = 邻 ? 自己.阵地[x] : 敌.阵地[x];
              if (t) 受方.push({ 目标: t, 数量: 算量(t), 战斗伤害: 步骤.战斗伤害, 射击伤害: item.能力名 === '射击' });
            }
          } else 记录(g, '伤害：selectRelation 算不出锚点（来源没有阵地？），这条跳过');
          continue;
        }

        for (const t of 解析受方(g, item, e2.受方)) {
          受方.push({ 目标: t, 数量: 算量(t), 战斗伤害: 步骤.战斗伤害, 射击伤害: item.能力名 === '射击' });
        }
      }

      if (受方.length === 0) { 记录(g, '伤害：解析不到受方，跳过'); break; }
      伤害事件(g, src, 受方);
      break;
    }
    case '抓牌': {

      const n = typeof 步骤.数量 === 'number' ? 步骤.数量 : 取值(g, item.操控者, 步骤.数量, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X);

      for (const p of 解析玩家们(g, item, 步骤.玩家)) 抓牌(g, p, n);
      break;
    }
    case '可选支付': {

      const 费 = 步骤.费用.通用 === 'X' ? 0 : (步骤.费用.通用 ?? 0);
      const 谁 = item.操控者;
      if (费 <= 0) { item.上一步生效 = true; break; }
      if (!可支付数字费用(g, 谁, 费)) {
        item.上一步生效 = false;
        记录(g, g.players[谁]!.name + ' 付不起 ' + 费 + ' 点数字费用，跳过');
        break;
      }

      if (item.本次选择) {
        const 键 = item.本次选择[0];
        item.本次选择 = undefined;
        item.上一步生效 = 键 === '接受';
        if (item.上一步生效) {
          const 源 = item.本次支付源;
          item.本次支付源 = undefined;
          支付数字费用(g, 谁, 费, 源 && 源.length ? 源 : 可支付来源(g, 谁).map((x) => x.uid));
          记录(g, g.players[谁]!.name + ' 支付了 ' + 费 + ' 点数字费用');
        } else 记录(g, g.players[谁]!.name + ' 选择不支付');
        break;
      }
      item.待选择 = { 类型: '选', 选什么: '选项', 标签: '你可以支付 ' + 费 + ' 点数字费用', 玩家: 谁,
        候选: [{ 键: '接受', 名称: '支付 ' + 费 + ' 点' }, { 键: '不支付', 名称: '不支付' }],
        数量: { 最小: 1, 最大: 1 } };
      return;
    }
    case '取消': {

      const t = item.目标槽?.[步骤.to.目标];
      const 栈id = 取堆叠项(t);
      const idx = 栈id !== undefined
        ? g.stack.findIndex((x) => x.id === 栈id)
        : g.stack.findIndex((x) => x.card === 取实体(t));
      if (idx >= 0) {
        const rm = 堆叠取第(g, idx);
        记录(g, '取消 ' + (rm!.card ? rm!.card.def.全名 : rm!.标签));
        if (rm!.card) 置入墓地(g, rm!.card);
      } else 记录(g, '取消失败：目标不在堆叠');
      break;
    }
    case '放逐':
      for (const t of 解析受方(g, item, 步骤.to)) if (typeof t !== 'number') 放逐(g, t);
      break;
    case '移动': {

      item.上一步生效 = true;

      const 已洗入 = new Set<number>();

      const 谁的 = 步骤.玩家 !== undefined ? (解析玩家们(g, item, 步骤.玩家)[0] ?? item.操控者) : item.操控者;
      const 批量 = 步骤.selectAll
        ? 候选目标(g, 谁的, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: 步骤.selectAll }, item.来源 ?? item.card)
            .map((c) => c.obj).filter((x): x is Obj => !!x)

            .filter((x) => 步骤.玩家 === undefined || x.owner === 谁的)
        : null;

      if (!['手牌', '牌库', '牌库顶', '墓地', '放逐区'].includes(步骤.去处)) {
        记录(g, '⚠ 移动：未知的目的地「' + 步骤.去处 + '」—— 按「手牌」处理，请检查卡数据');
      }
      const 洗入 = 步骤.去处 === '牌库';
      const 目的区: Zone = (步骤.去处 === '牌库顶' || 洗入) ? '牌库'
        : 步骤.去处 === '墓地' ? '墓地'
        : 步骤.去处 === '放逐区' ? '放逐区'
        : '手牌';
      const 搬 = (t: Obj) => {
        const 曾战场 = t.区域 === '战场';
        移到区域(g, t, 目的区);
        记录(g, t.def.全名 + (目的区 === '手牌' ? ' 被移回其拥有者手上' : 目的区 === '牌库' ? ' 被置于其拥有者的牌库顶' : 目的区 === '墓地' ? ' 被置于其拥有者的墓地' : ' 被放逐'));

        if (曾战场) 记事件(g, '离开战场', { 受方: t.uid });

        if (洗入) 已洗入.add(t.owner);
      };
      if (批量) { for (const x of 批量) 搬(x); for (const p2 of 已洗入) 洗牌(g.players[p2]!.library, g.随机源); break; }

      const t = !步骤.to ? undefined
        : ('目标' in 步骤.to ? 取实体(item.目标槽?.[步骤.to.目标]) : (解析受方(g, item, 步骤.to)[0] as Obj | undefined));
      if (!t) { 记录(g, '移动：找不到目标'); break; }
      搬(t);
      for (const p3 of 已洗入) 洗牌(g.players[p3]!.library, g.随机源);
      break;
    }
    case '记住': {

      const 谁 = 解析受方(g, item, 步骤.从)[0];
      if (谁 === undefined) { 记录(g, '记住：解析不到受方'); break; }
      if (步骤.取 === '玩家号') { if (typeof 谁 === 'number') { 存记忆(g, item, 步骤.键, 谁); 记录(g, '记住 ' + g.players[谁]!.name); } }
      else if (typeof 谁 !== 'number') {
        const d = 谁.def;
        const n = 步骤.取 === '武力' ? 武力(g, 谁)
          : 步骤.取 === '体力上限' ? 体力上限(g, 谁)
          : 步骤.取 === '打出费用' ? (typeof d.打出费用 === 'number' ? d.打出费用 : 0)
          : 谁.damage;
        存记忆(g, item, 步骤.键, n);
        记录(g, '记住 ' + 谁.def.全名 + ' 的' + 步骤.取 + ' = ' + n);
      }
      break;
    }
    case '累加': {
      const 值 = typeof 步骤.值 === 'number' ? 步骤.值 : 取值(g, item.操控者, 步骤.值, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X);
      const 旧 = Number(读记忆(item, 步骤.键) ?? 0);
      存记忆(g, item, 步骤.键, 旧 + 值);
      记录(g, '累计 ' + 步骤.键 + ' = ' + (旧 + 值));
      break;
    }
    case '横置':

      for (const t2 of 解析受方(g, item, 步骤.to)) if (typeof t2 !== 'number' && !t2.tapped) { 写横置(g, t2, true); 记录(g, t2.def.全名 + ' 被横置'); 记事件(g, '成为横置', { 受方: t2.uid });  排队单位事件触发(g, '成为横置', t2); }
      break;
    case '翻牌库顶': for (const p of 解析玩家们(g, item, 步骤.玩家)) {

      const pl2 = g.players[p]!;
      const n2 = Math.min(步骤.数量, pl2.library.length);
      const 翻 = pl2.library.slice(-n2).reverse();
      for (const c of 翻) {

        const r = 步骤.分流.find((x) => !x.筛选 || 符合筛选(g, c, x.筛选, 有效特征(g, c))) ?? 步骤.分流[步骤.分流.length - 1]!;

        if (r.去处 === '暂存') { 移到区域(g, c, '暂存'); (item.暂存 ??= []).push(c); 记录(g, c.def.全名 + ' → 暂存（等下一步放）'); continue; }
        const 区: Zone = r.去处 === '墓地' ? '墓地'
          : r.去处 === '放逐区' ? '放逐区'
          : r.去处 === '战场' ? '战场'
          : (r.去处 === '牌库顶' || r.去处 === '牌库底') ? '牌库'
          : '手牌';
        移到区域(g, c, 区);

        if (r.去处 === '牌库底') { const 库 = pl2.library; const i3 = 库.indexOf(c); if (i3 >= 0) { 库.splice(i3, 1); 库.unshift(c); } }
        if (r.去处 === '战场' && r.横置) 写横置(g, c, true);
        排队单位事件触发(g, '成为横置', c);
        记录(g, c.def.全名 + ' → ' + r.去处);
      }
    } break;
    case '决斗': {

      const 解斗 = (r: RecipientRef) => 解析受方(g, item, r).find((x): x is Obj => typeof x !== 'number');
      const 甲 = 解斗(步骤.甲); const 乙 = 解斗(步骤.乙);

      const 可斗 = (o: Obj | undefined): o is Obj => !!o && o.区域 === '战场' && 是类别(g, o, '单位');
      if (!可斗(甲) || !可斗(乙)) { 记录(g, '决斗（701.10b）：有一方已不在战场上或不再是单位，不造成伤害'); break; }
      if (甲 === 乙) {

        const 双倍 = 武力(g, 甲) * 2;
        记录(g, 甲.def.全名 + ' 与自己决斗（701.10c）：受到 ' + 双倍 + ' 点伤害');
        伤害事件(g, item.来源 ?? item.card ?? null, [{ 目标: 甲, 数量: 双倍 }]);
        break;
      }
      记录(g, 甲.def.全名 + ' 与 ' + 乙.def.全名 + ' 决斗（701.10）');

      伤害事件(g, null, [
        { 目标: 甲, 数量: 武力(g, 乙) },
        { 目标: 乙, 数量: 武力(g, 甲) },
      ]);
      break;
    }
    case '移到阵地': {

      const 是单位 = (x: 目标 | undefined): x is Obj =>
        !!x && typeof x !== 'number' && !('堆叠项' in x) && 是类别(g, x as Obj, '单位');
      const 走们: Obj[] = (步骤.to && typeof 步骤.to === 'object' && '目标' in 步骤.to)
        ? (item.目标 ?? []).filter(是单位)
        : 解析受方(g, item, 步骤.to).filter(是单位);
      if (!走们.length) { 记录(g, '移到阵地：找不到单位'); break; }

      const 进度 = (item as unknown as { 移到进度?: number }).移到进度 ?? 0;
      const 走 = 走们[进度];
      if (!走) break;
      let 目的: 阵地 | null = null;
      let 新主号 = item.操控者;
      if (步骤.空阵地 !== undefined) {
        const 它主 = 有效控制器(g, 走);

        const 谁的 = 步骤.空阵地 === '对手' ? 1 - 它主 : 它主;
        const 空 = 阵地顺序.filter((s2) => !g.players[谁的]!.阵地[s2]);
        if (!空.length) { 记录(g, '移到阵地：' + g.players[谁的]!.name + ' 没有空阵地'); break; }

        if (!item.本次选择 || !item.本次选择.length) {
          item.待选择 = {
            类型: '选', 选什么: '阵地',
            标签: '选择 ' + 走.def.全名 + ' 移到哪个空阵地（' + g.players[谁的]!.name + '  的空阵地）',
            玩家: 步骤.由谁选 === '对手' ? 1 - item.操控者 : item.操控者,
            数量: 步骤.可选 ? { 最小: 0, 最大: 1 } : { 最小: 1, 最大: 1 },
            候选: 空.map((x) => ({ 键: x, 名称: x })),
          };
          return;
        }
        const 选 = item.本次选择[0];

        if (选 === undefined && 步骤.可选) { 记录(g, '移到阵地：' + g.players[步骤.由谁选 === '对手' ? 1 - item.操控者 : item.操控者]!.name + ' 没有选择阵地，不移动'); break; }
        item.本次选择 = undefined;
        目的 = typeof 选 === 'string' ? (选 as 阵地) : null;
        if (目的 === null || !空.includes(目的)) { 记录(g, '移到阵地：选的目的地不合法'); break; }
        新主号 = 谁的;
      } else {
        const 锚 = 解析受方(g, item, 步骤.相对!).find((x): x is Obj => typeof x !== 'number');
        if (!锚) { 记录(g, '移到阵地：找不到锚'); break; }
        if (!锚.阵地) { 记录(g, '移到阵地：' + 锚.def.全名 + ' 不在阵地上'); break; }
        目的 = 相对阵地(锚.阵地);
        if (目的 === null) { 记录(g, '移到阵地：算不出相对阵地'); break; }
      }
      if (走.阵地 === 目的) { 记录(g, 走.def.全名 + ' 已经在 ' + 目的); } else {

        const 旧阵 = 走.阵地;
        if (旧阵 !== null) {
          const 旧主 = g.players[阵地所有者(g, 走)!]!;
          旧主.阵地[旧阵] = null;
        }
        const 新主 = g.players[新主号]!;

        const 原 = 新主.阵地[目的];
        if (原) { 记录(g, '移动：' + 目的 + ' 上有 ' + 原.def.全名 + '，什么也不会发生（701.18c）'); break; }
        写阵地(g, 走, 目的);
        新主.阵地[目的] = 走;
        记录(g, 走.def.全名 + ' 移动到 ' + 目的);
        记事件(g, '移动', { 受方: 走.uid });
        排队移动触发(g, 走);
      }
      (item as unknown as { 移到进度?: number }).移到进度 = 进度 + 1;
      if (进度 + 1 < 走们.length) {

        const 下 = 走们[进度 + 1]!;
        const 它的主 = 有效控制器(g, 下);
        const 谁的下 = 步骤.空阵地 === '对手' ? 1 - 它的主 : 它的主;
        const 空的下 = 阵地顺序.filter((s2) => !g.players[谁的下]!.阵地[s2]);
        if (!空的下.length) { 记录(g, '移到阵地：' + g.players[谁的下]!.name + ' 没有空阵地，剩下不动'); break; }
        item.本次选择 = undefined;
        item.待选择 = {
          类型: '选', 选什么: '阵地',
          标签: '选择 ' + 下.def.全名 + ' 移到哪个空阵地（' + g.players[谁的下]!.name + ' 的空阵地）',
          玩家: 步骤.由谁选 === '对手' ? 1 - item.操控者 : item.操控者,
          数量: 步骤.可选 ? { 最小: 0, 最大: 1 } : { 最小: 1, 最大: 1 },
          候选: 空的下.map((x) => ({ 键: x, 名称: x })),
        };
        return;
      }
      break;
    }
    case '交换阵地': {

      const 甲 = 解析受方(g, item, 步骤.甲).find((x): x is Obj => typeof x !== 'number');
      const 乙 = 解析受方(g, item, 步骤.乙).find((x): x is Obj => typeof x !== 'number');
      if (!甲 || !乙 || !甲.阵地 || !乙.阵地) { 记录(g, '交换阵地：有一方没占阵地'); break; }
      const 甲阵 = 甲.阵地, 乙阵 = 乙.阵地;
      const 甲主 = g.players[阵地所有者(g, 甲)!]!;
      const 乙主 = g.players[阵地所有者(g, 乙)!]!;
      甲主.阵地[甲阵] = 乙;
      乙主.阵地[乙阵] = 甲;
      写阵地(g, 甲, 乙阵);
      写阵地(g, 乙, 甲阵);
      记录(g, 甲.def.全名 + ' 与 ' + 乙.def.全名 + ' 交换阵地（' + 甲阵 + ' ⇄ ' + 乙阵 + '）');
      记事件(g, '移动', { 受方: 甲.uid });
      记事件(g, '移动', { 受方: 乙.uid });
      排队移动触发(g, 甲);
      排队移动触发(g, 乙);
      break;
    }
    case '守望': {

      const 谁的 = item.操控者;
      let 限谁: number | undefined;
      if (步骤.操控者 !== undefined) {
        const 解 = 解析受方(g, item, 步骤.操控者).find((x) => typeof x === 'number');
        if (解 === undefined) { 记录(g, '守望：找不到那个玩家'); break; }
        限谁 = 解;
      }
      g.守望.push({
        事件: 步骤.事件, 步骤: 步骤.步骤, 阶段: 步骤.阶段, 操控者: 限谁,
        时长: 步骤.时长 ?? '直到回合结束', 谁的,
        能力: 步骤.能力, 来源: item.card ?? item.来源 ?? null,
        标签: (item.card ?? item.来源)?.def.全名 + ' 的延迟触发（' + 步骤.事件 + '）',
      });
      记录(g, '登记延迟触发（603.7）：' + 步骤.事件 + (限谁 !== undefined ? '（限 ' + g.players[限谁]!.name + ' 操控的）' : '')
        + '，' + (步骤.时长 === '下一次' ? '下一次' : '直到回合结束'));
      break;
    }

    case '观星': {

      const 谁 = 步骤.玩家 ?? item.操控者;
      const pl = g.players[谁]!;
      const X = typeof 步骤.数量 === 'number' ? 步骤.数量
        : 取值(g, item.操控者, 步骤.数量, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X);

      if (X <= 0) { 记录(g, g.players[谁]!.name + ' 观星 0：事件不发生（701.5b）'); break; }

      if (pl.library.length === 0) { 记录(g, g.players[谁]!.name + ' 观星 ' + X + '：牌库是空的，省略该动作（101.3）'); break; }
      const 看 = Math.min(X, pl.library.length);
      const 牌 = 检视区域(g, item.操控者, [谁], '牌库', 看).牌;
      const 记忆 = item as unknown as { 观星顶?: Obj[]; 观星底?: Obj[] };
      const 答 = (item.本次选择 ?? []).filter((x): x is Obj => typeof x === 'object' && x !== null && 'uid' in x);
      item.本次选择 = undefined;

      if (记忆.观星顶 === undefined) {
        if (item.待选择 === undefined && 答.length === 0) {  }

        if (item.观星已问顶) {
          记忆.观星顶 = 答;
        } else {
          item.观星已问顶 = true;
          item.待选择 = {
            类型: '选', 选什么: '物件',
            标签: '观星 ' + X + '：点你要**置于牌库顶**的牌（先点的在上面；不点的沉底）',
            玩家: item.操控者,
            数量: { 最小: 0, 最大: 牌.length },
            候选: 牌.map((c) => ({ 键: c.uid, 名称: c.def.全名 })),

            查看: 牌.map((c) => ({ 键: c.uid, 名称: c.def.全名 })),
          };
          return;
        }
      }

      const 余 = 牌.filter((c) => !记忆.观星顶!.includes(c));

      if (记忆.观星底 === undefined && 余.length > 0) {
        if (item.观星已问底) {
          记忆.观星底 = 答;
        } else {
          item.观星已问底 = true;
          item.待选择 = {
            类型: '选', 选什么: '物件',
            标签: '观星 ' + X + '：其余 ' + 余.length + ' 张按**置底的顺序**点（先点的在上面）',
            玩家: item.操控者,
            数量: { 最小: 0, 最大: 余.length },
            候选: 余.map((c) => ({ 键: c.uid, 名称: c.def.全名 })),
            查看: 余.map((c) => ({ 键: c.uid, 名称: c.def.全名 })),
          };
          return;
        }
      }

      const 底 = [...(记忆.观星底 ?? []),
        ...余.filter((c) => !(记忆.观星底 ?? []).includes(c))];

      for (const c of 牌) { const i2 = pl.library.indexOf(c); if (i2 >= 0) pl.library.splice(i2, 1); }
      for (const c of [...底].reverse()) pl.library.push(c);
      for (const c of [...记忆.观星顶!].reverse()) pl.library.push(c);
      记录(g, g.players[谁]!.name + ' 观星 ' + X + '：'
        + (记忆.观星顶!.length ? 记忆.观星顶!.map((c) => c.def.全名).join('、') + ' 置顶' : '没有置顶')
        + '，' + 底.length + ' 张置底');
      break;
    }
    case '检视': {

      const 看的人 = item.操控者;
      const 玩家们 = 解析玩家们(g, item, 步骤.来源);
      const 区域 = 步骤.区域 ?? '牌库顶';
      const { 牌, 谁们的 } = 检视区域(g, 看的人, 玩家们, 区域);
      if (!牌.length) { 记录(g, g.players[看的人]!.name + ' 检视：' + 谁们的.join('、') + ' 是空的'); break; }

      const 要看 = 步骤.数量 === '全部' ? 牌.length : (步骤.数量 ?? 0);
      item.待选择 = {
        类型: '搜寻',
        标签: '检视 ' + 谁们的.join('、')
          + (要看 > 0 ? '，选 ' + 要看 + ' 张' : '（仅你可见；看完点确认）'),
        区域,
        数量: 要看,

        可放弃: false,
        候选: 牌.map((c) => ({ uid: c.uid, 名称: c.def.全名,
          可选: 要看 > 0 && 符合筛选(g, c, 步骤.筛选, 有效特征(g, c)) })),
        玩家: 玩家们[玩家们.length - 1] ?? 看的人,
        去处: 步骤.去处,
      };
      return;
    }
      case '明置':

        for (const t2 of 解析受方(g, item, 步骤.to)) {
          if (typeof t2 === 'number') continue;
          设面(g, t2, '明置', item.操控者);
        }
        break;
      case '暗置':

        for (const t2 of 解析受方(g, item, 步骤.to)) {
          if (typeof t2 === 'number') continue;
          设面(g, t2, '暗置', item.操控者);
        }
        break;
      case '翻面':

        for (const t2 of 解析受方(g, item, 步骤.to)) {
          if (typeof t2 === 'number') continue;
          记录(g, '701.27c：' + t2.def.全名 + ' 不是双面牌，翻面什么都不发生');
        }
        break;
    case '体力': {
      const pl = g.players[item.操控者]!;
      if (步骤.模式号 === '回复至上限') pl.体力 = pl.lifeMax;
      else if (步骤.模式号 === '获得') pl.体力 += 步骤.点数 ?? 0;
      else pl.体力 -= 步骤.点数 ?? 0;
      break;
    }
    case '加成': {
      const t = 取实体(item.目标槽?.[步骤.to.目标]);
      if (t) 加临时效应(g, { 种类: '加成', target: t, 武力: 步骤.武力, 体力上限: 步骤.体力上限, expires: '直到回合结束' });
      break;
    }
    case '原生': {
      const 实现 = native模块表.get(步骤.模块);
      if (!实现) {

        throw new Error('native 效应「' + 步骤.模块 + '」没有注册实现（引擎不提供默认行为）');
      }
      实现(g, item, 步骤);
      break;
    }
  }
  检查状态动作(g);
}

export function 检查状态动作(g: GameState): boolean {
  同步操控权与阵地(g);

  let 发生 = false;
  for (;;) {
    let 本轮 = false;
    for (const pl of g.players) {

      if (pl.体力 <= 0) { 结束对局(g, 1 - pl.index, pl.name + ' 的体力为 0 或更少（704.5a）'); return true; }

      if (pl.drewFromEmptyLibrary) { 结束对局(g, 1 - pl.index, pl.name + ' 试图从空牌库抓牌（704.5b）'); return true; }
    }
    {
      for (const o of g.战场.slice()) {
        const 是单位 = 是类别(g, o, '单位');

        if (是单位 && 体力上限(g, o) <= 0) { 记录(g, o.def.全名 + ' 体力上限为 0（704.5c）'); 置入墓地(g, o); 本轮 = true; continue; }

        if (是单位 && o.记忆['致命伤害'] && !带词(g, o, '不屈')) { 记录(g, o.def.全名 + ' 受到致命伤害被消灭（704.5e）'); 置入墓地(g, o); 本轮 = true; continue; }
        if (是单位 && o.记忆['致命伤害'] && 带词(g, o, '不屈')) 写记忆(g, o, '致命伤害', false);

        if (是单位 && o.damage >= 体力上限(g, o) && 带词(g, o, '不屈')) {

        } else if (是单位 && o.damage >= 体力上限(g, o)) {
          记录(g, o.def.全名 + ' 受到致死伤害被消灭（704.5d）');
          置入墓地(g, o); 本轮 = true; continue;
        }

        if (是类别(g, o, '化身') && 灵值(g, o) <= 0) { 记录(g, o.def.全名 + ' 的灵值为 0（704.5f）'); 置入墓地(g, o); 本轮 = true; continue; }

        if (关键词特征(g, o, '附属') !== undefined) {
          const 在 = o.附属在;
          const 合法 = 在 !== undefined && (在 <= 1 || g.战场.some((x) => x.uid === 在));
          if (!合法) { 记录(g, o.def.全名 + ' 未附属于任何合法对象（704.5l）'); 置入墓地(g, o); 本轮 = true; continue; }
        }

        if (!是单位 && o.damage > 0) { 写伤害(g, o, 0); 记录(g, o.def.全名 + ' 不再是单位，移去已损失的体力（704.5g）'); 本轮 = true; }

        const 正 = o.标记.find((m) => m.类型 === '+1/+1');
        const 负 = o.标记.find((m) => m.类型 === '-1/-1');
        if (正 && 负) {
          const n = Math.min(正.数量, 负.数量);
          正.数量 -= n; 负.数量 -= n;
          写标记表(g, o, o.标记.filter((m) => m.数量 > 0));
          记录(g, o.def.全名 + ' 上 ' + n + ' 对 +1/+1 与 -1/-1 标记相互抵消（704.5n）');
          本轮 = true;
        }

        if (!是单位 && o.阵地) { g.players[有效控制器(g, o)]!.阵地[o.阵地] = null; 写阵地(g, o, null); 记录(g, o.def.全名 + ' 非单位实体被移出阵地（704.5h）'); 本轮 = true; }
      }

      for (const pl of g.players) {
        const 无双 = g.战场.filter((o) => 有效控制器(g, o) === pl.index && (o.def.超类别 ?? []).includes('无双'));
        const seen = new Map<string, Obj[]>();
        for (const o of 无双) {
          for (const nm of o.def.名称) {
            const arr = seen.get(nm) ?? []; arr.push(o); seen.set(nm, arr);
          }
        }
        for (const [nm, arr] of seen) {
          const uniq = [...new Set(arr)];
          if (uniq.length >= 2) {

            const 候选 = uniq.map((o) => ({ 键: o.uid, 名称: o.def.全名 }));
            const 已问过 = g.待问 && g.待问.候选.length === 候选.length
              && g.待问.候选.every((c) => uniq.some((o) => o.uid === c.键));
            if (已问过) {
              const 留 = new Set(g.待问!.回答 ?? []);
              const 保留 = uniq.find((o) => 留.has(o.uid)) ?? uniq[0]!;
              for (const o of uniq) if (o !== 保留) { 放逐(g, o); 记录(g, '无双规则：' + o.def.全名 + ' 被放逐（704.5i，与「' + nm + '」同名）'); 本轮 = true; }
              g.待问 = undefined;
            } else if (!g.待问) {
              g.待问 = { 玩家: pl.index, 类型: '选',
                标签: '无双规则（704.5i）：' + pl.name + ' 操控 ' + uniq.length + ' 个同名的「' + nm + '」，选一个保留（其余的放逐）',
                候选, 数量: { 最小: 1, 最大: 1 } };
              return 发生;
            }
          }
        }
      }
    }

    for (const pl of g.players) {
      const 化身 = g.战场.filter((o) => 有效控制器(g, o) === pl.index && o.def.类别.includes('化身'));
      const 组 = new Map<string, Obj[]>();
      for (const o of 化身) 组.set(o.def.全名, [...(组.get(o.def.全名) ?? []), o]);
      for (const [全名, 列] of 组) {
        if (列.length < 2) continue;
        const 候选 = 列.map((o) => ({ 键: o.uid, 名称: o.def.全名 }));
        const 已问过 = g.待问 && g.待问.候选.length === 候选.length
          && g.待问.候选.every((c) => 列.some((o) => o.uid === c.键));
        if (已问过) {
          const 留 = new Set(g.待问!.回答 ?? []);
          const 保留 = 列.find((o) => 留.has(o.uid)) ?? 列[0]!;
          for (const o of 列) if (o !== 保留) { 放逐(g, o); 记录(g, '化身规则：' + o.def.全名 + ' 被放逐（704.5j，同名）'); 本轮 = true; }
          g.待问 = undefined;
        } else if (!g.待问) {
          g.待问 = { 玩家: pl.index, 类型: '选',
            标签: '化身规则（704.5j）：' + pl.name + ' 操控 ' + 列.length + ' 个同名的「' + 全名 + '」，选一个保留（其余的放逐）',
            候选, 数量: { 最小: 1, 最大: 1 } };
          return 发生;
        }
      }
    }

    for (const q of g.players) {
      const 各区: [string, Obj[]][] = [['墓地', q.graveyard], ['牌库', q.library], ['手牌', q.hand], ['放逐区', g.放逐区]];
      for (const [区名, 区] of 各区) {
        for (let i = 区.length - 1; i >= 0; i--) {
          if (区[i]!.是指示物) { 记录(g, 区[i]!.def.全名 + ' 在' + 区名 + '中消失（112.8）'); 区.splice(i, 1); 本轮 = true; }
        }
      }
    }
    if (g.over) return true;
    if (!本轮) break;
    发生 = true;
  }
  return 发生;
}

function 结束对局(g: GameState, 胜者: number | null, 原因: string): void {
  g.over = true; g.winner = 胜者;
  记录(g, '对局结束：' + (胜者 === null ? '平手' : g.players[胜者]!.name + ' 获胜') + ' —— ' + 原因);
}

function* 执行动作G(g: GameState, p: number, act: Action): Generator<请求, void, Action | null> {
  if (act.种类 === '打领土') 打出领土(g, p, act.card, act.面);
  else if (act.种类 === '转移') 转移(g, p, act.card, act.到, act.路径 ?? '转移');
  else if (act.种类 === '施放') 施放(g, p, act.card, act.目标, act.阵地, act.模式号, act.X, act.支付源, act.额外牺牲);
  else if (act.种类 === '启动能力') 启动能力(g, p, act.card, act.能力索引, act.目标, act.支付源, act.模式号, act.费用弃牌, act.费用牺牲, act.宣告X);
else if (act.种类 === '发起战斗') {

      const 税 = act.目标.种类 === '玩家' ? 攻击税(g, act.目标.玩家) : 0;
      if (税 > 0 && !支付数字费用(g, p, 税, act.支付源 ?? [])) {
        记录(g, '攻击税（120 长江天险）：' + g.players[p]!.name + ' 没有为这次攻击支付 ' + 税 + ' 点 → 本次战斗中止');
        记录(g, '（要打那个玩家：先在「支付源」里选好地再宣告攻击；或者改打对方的阵地）');
        return;
      }
      if (税 > 0) 记录(g, g.players[p]!.name + ' 为攻击 ' + g.players[act.目标.玩家]!.name + ' 支付了 ' + 税 + ' 点（120 长江天险）');
      yield* 执行战斗流程G(g, p, act.card, act.目标);
    }
}

export interface 规格候选 { 类型: '实体' | '玩家'; uid?: number; 玩家?: number; 名称: string; 敌?: boolean }
export interface 规格 { 目标名: string; 数量: { 最小: number; 最大: number }; 候选: 规格候选[] }
export interface 宣告决定 {
  类型: '宣告';
  标签: string;
  来源uid: number;

  可选?: boolean;

  模式候选?: { 索引: number; 标签: string; 规格: 规格[] }[];

  规格?: 规格[];
}

export interface 请求 {
  玩家: number;
  时机: 时机选项;
  步骤: string;

  决定?:
    | { 类型: '可选触发'; 标签: string; 栈id: number }
    | 宣告决定

    | { 类型: '搜寻'; 标签: string; 区域: string; 数量: number; 可放弃: boolean; 候选: { uid: number; 名称: string; 可选: boolean }[] }

    | { 类型: '弃牌'; 需弃: number; 标签: string }

    | { 类型: '决定先手'; 标签: string; 候选座位: number[] }
    | { 类型: '调度宣告'; 标签: string; 候选张数: number[] }
    | { 类型: '调度执行'; 标签: string; 张数: number; 手牌: { uid: number; 名称: string; 可选: boolean }[] }
    | { 类型: '看牌库顶'; 标签: string }

    | { 类型: '选'; 选什么: '物件' | '选项' | '阵地' | '触发'; 标签?: string; 玩家: number;
        数量?: { 最小: number; 最大: number }; 候选?: { 键: number | string; 名称: string }[];

        查看?: { 键: number | string; 名称: string }[] };
}

const 战斗时机: 时机选项 = { 允许打领土: false, 允许通常时机: false };

export function* 优先权循环G(g: GameState, opts: 时机选项, 步骤: string): Generator<请求, void, Action | null> {
  let 连续让过 = 0;
  let p = g.active;
  let 守卫 = 0;
  while (!g.over) {
    if (守卫++ > 8000) { 记录(g, '守卫触发：强制结束步骤'); break; }
    yield* 把待触发放进堆叠G(g, opts, 步骤);

    for (;;) {
      检查状态动作(g);
      if (!g.待问 || g.over) break;
      const 问 = g.待问;
      const 答 = yield { 玩家: 问.玩家, 时机: opts, 步骤, 决定: 问 as never };
      问.回答 = (答 as { 选?: number[] } | null)?.选 ?? [];
    }
    const n = g.players.length;
    if (连续让过 >= n) {
      if (g.stack.length > 0) {
        const 顶 = g.stack[g.stack.length - 1]!;

        if (!顶.已开始 && 顶.种类 !== '令符') 记录(g, '结算：' + 顶.标签);

        if (顶.可选 && !顶.decided) {
          const 答 = yield {
            玩家: 顶.操控者, 时机: opts, 步骤,
            决定: { 类型: '可选触发', 标签: 顶.标签, 栈id: 顶.id },
          };
          顶.decided = true;
          if (!答 || 答.种类 !== '决定' || !答.接受) 顶.declined = true;

          if (顶.declined) { 连续让过 = n; p = g.active; continue; }
        }

        if (顶.待定目标 && 顶.待定目标.length && 顶.来源) {

          const 缺目标 = 顶.待定目标.some((sp: TargetSpec) =>
            候选目标(g, 有效控制器(g, 顶.来源!), sp, 顶.来源).length < sp.数量.最小);
          if (缺目标) {
            堆叠弹出(g);
            记录(g, 顶.标签 + '：没有合法目标，从堆叠移除（603.3f），不结算');
            连续让过 = n; p = g.active; continue;
          }
          const 规格表 = 建规格(g, 顶.来源, 顶.待定目标);
          const 答 = yield { 玩家: 顶.操控者, 时机: opts, 步骤,
            决定: { 类型: '宣告', 标签: 顶.标签, 来源uid: 顶.来源.uid, 可选: 顶.可选, 规格: 规格表 } };
          if (!答 || 答.种类 !== '宣告') {
            堆叠弹出(g);
            记录(g, 顶.标签 + '：未选目标，从堆叠移除');
            连续让过 = n; p = g.active; continue;
          }
          const 列表: 目标[] = [];
          const 槽: Record<string, 目标> = {};
          for (const sp of 顶.待定目标) {
            const 给 = (答.目标 ?? []).find((t) => t.目标名 === sp.目标名);
            if (!给) continue;
            const 物件 = 给.类型 === '玩家' ? 给.玩家! : 找实体(g, 给.uid!);
            if (物件 === undefined || 物件 === null) continue;
            列表.push(物件); 槽[sp.目标名] = 物件;
          }
          顶.目标 = 列表; 顶.目标槽 = 槽; 顶.待定目标 = undefined;

          for (const t2 of 列表) if (typeof t2 !== 'number' && 'uid' in t2) 记事件(g, '被指定为目标', { 受方: t2.uid, 来源: 顶.来源.uid });
          排队被指定为目标触发(g, 列表, 顶.来源);
          连续让过 = n; p = g.active; continue;
        }
        if (顶.declined) {
          堆叠弹出(g);
          记录(g, 顶.标签 + '：操控者选择不使用');
          连续让过 = n;
          p = g.active;
          continue;
        }
        if (!结算堆叠顶(g)) {

          const 顶 = g.stack[g.stack.length - 1]!;

          const 问谁 = 顶.待选择 && 顶.待选择.类型 === '选' ? 顶.待选择.玩家 : 顶.操控者;
          const 答 = yield { 玩家: 问谁, 时机: opts, 步骤, 决定: 顶.待选择 as never };
          应用选择(g, 顶, 答);

          continue;
        }
        连续让过 = 0;
        p = g.active;
        continue;
      }
      if (g.pending.length === 0) return;
      连续让过 = 0;
      continue;
    }
    const act = yield { 玩家: p, 时机: opts, 步骤 };
    if (act && act.种类 !== '让过' && act.种类 !== '决定') {
      yield* 执行动作G(g, p, act);
      连续让过 = 0;
      检查状态动作(g);

      if (act.种类 === '发起战斗') p = g.active;
    } else {

      const 必须打 = (步骤 === '行动阶段' || 步骤 === '宣告攻击步骤') && g.stack.length === 0
        ? g.战场.filter((u) => 有效控制器(g, u) === p && 有必须发起战斗(g, u) && 能发起战斗(g, p, u))
        : [];

      if (必须打.length > 0) {
        记录(g, '必须发起战斗（146）：' + g.players[p]!.name + ' 的 ' + 必须打.map((u) => u.def.全名).join('、') + ' 还能进攻，不能空过');
        continue;
      }
      连续让过++;
      p = (p + 1) % n;
    }
  }
}

export function 优先权循环(g: GameState, 策略表: 策略[], opts: 时机选项): void {
  const it = 优先权循环G(g, opts, '');
  let r = it.next();
  while (!r.done) {
    const req = r.value;
    if (req.决定) {
      r = it.next(自动宣告(g, req.决定) ?? { 种类: '决定', 接受: true });
      continue;
    }
    r = it.next(策略表[req.玩家]!(g, req.玩家, req.时机));
  }
}

export function* 进行回合G(g: GameState): Generator<请求, void, Action | null> {
  const p = g.active;
  g.turn++;
  const 该玩家 = g.players[p]!;
  该玩家.landsPlayedThisTurn = 0;

  写事件记录(g, g.事件记录.filter((e) => e.回合 >= g.turn - 1));
  if ((该玩家.跳过['重置步骤'] ?? 0) > 0) {
    该玩家.跳过['重置步骤'] = 该玩家.跳过['重置步骤']! - 1;
    记录(g, 该玩家.name + ' 的重置步骤被略过（还剩 ' + 该玩家.跳过['重置步骤'] + ' 次）');
  } else {
    for (const o of g.战场) {
    if (有效控制器(g, o) !== p) continue;

    if (有效特征(g, o).不能重置) continue;
    写横置(g, o, false); 写整备(g, o, false);
  }
  }
  记录(g, '—— ' + g.players[p]!.name + ' 的第 ' + g.turn + ' 回合 ——');

  for (const q of g.players) {
    if ((q.标记['天命'] ?? 0) >= 9) { 结束对局(g, q.index, q.name + ' 有九个天命标记（704.5q）'); return; }
  }
  排队步骤触发(g, '准备步骤');
  g.当前步骤 = '准备步骤';
  yield* 优先权循环G(g, { 允许打领土: false, 允许通常时机: false }, '准备步骤');
  if (g.over) return;

  if (!(g.turn === 1 && p === g.先手玩家)) { 抓牌(g, p, 1); 检查状态动作(g); }
  排队步骤触发(g, '抓牌步骤');
  g.当前步骤 = '抓牌步骤';
  yield* 优先权循环G(g, { 允许打领土: false, 允许通常时机: false }, '抓牌步骤');
  if (g.over) return;
  g.当前步骤 = '行动阶段';
  yield* 优先权循环G(g, { 允许打领土: true, 允许通常时机: true }, '行动阶段');
  if (g.over) return;
  排队步骤触发(g, '结束步骤');
  g.当前步骤 = '结束步骤';
  yield* 优先权循环G(g, { 允许打领土: false, 允许通常时机: false }, '结束步骤');
  if (g.over) return;

  const pl = g.players[p]!;
  g.当前步骤 = '弃牌步骤';
  const 上限 = 手牌上限为(g, pl.index);
  while (pl.hand.length > 上限) {
    const 需弃 = pl.hand.length - 上限;
    const 答 = yield {
      玩家: p, 时机: { 允许打领土: false, 允许通常时机: false }, 步骤: '弃牌步骤',
      决定: { 类型: '弃牌', 需弃, 标签: '手牌上限 ' + 上限 + '，请选 ' + 需弃 + ' 张弃掉' },
    };
    const 选 = (答 && 答.种类 === '决定' && Array.isArray(答.弃牌)) ? 答.弃牌 : [];
    const 有效 = 选.filter((uid) => pl.hand.some((c) => c.uid === uid)).slice(0, 需弃);
    if (有效.length === 0) {
      const 弃 = pl.hand[pl.hand.length - 1]!;
      移到区域(g, 弃, '墓地');
      记录(g, pl.name + ' 弃掉 ' + 弃.def.全名 + '（手牌上限 ' + 上限 + '，自动）');
      continue;
    }
    for (const uid of 有效) {
      const i = pl.hand.findIndex((c) => c.uid === uid);
      const 弃 = pl.hand[i]!;
      移到区域(g, 弃, '墓地');
      记录(g, pl.name + ' 弃掉 ' + 弃.def.全名 + '（手牌上限 ' + 上限 + '）');
    }
  }
  写临时效应(g, []);

  写连续效应(g, g.连续效应.filter((e) => e.时长 !== '直到回合结束'));

  g.守望 = g.守望.filter((w) => w.时长 !== '直到回合结束');
  检查状态动作(g);
}

export function 进行回合(g: GameState, 策略表: 策略[]): void {
  const it = 进行回合G(g);
  let r = it.next();
  while (!r.done) {
    const req = r.value;
    if (req.决定) {
      r = it.next(自动宣告(g, req.决定) ?? { 种类: '决定', 接受: true });
      continue;
    }
    r = it.next(策略表[req.玩家]!(g, req.玩家, req.时机));
  }
}

function* 开局流程G(g: GameState): Generator<请求, void, Action | null> {
  const o = g.开局;
  if (!o) return;
  const 无时机: 时机选项 = { 允许打领土: false, 允许通常时机: false };
  const 人数 = g.players.length;

  if (g.players.every((pl) => pl.hand.length === 0)) {
    const 候选座位 = Array.from({ length: 人数 }, (_, i) => i);
    const a = yield { 玩家: 0, 时机: 无时机, 步骤: '决定先手',
      决定: { 类型: '决定先手', 标签: '决定先后手', 候选座位 } };
    const 先 = a && a.种类 === '决定' && typeof a.先手 === 'number' && 候选座位.includes(a.先手)
      ? a.先手 : Math.floor(g.随机源() * 人数);
    决定先手(g, 先);
  }

  const 顺序 = Array.from({ length: 人数 }, (_, i) => (g.先手玩家 + i) % 人数);

  for (const p of 顺序) {
    const pl = g.players[p]!;
    const 下限 = Math.max(0, o.起手牌数 - pl.hand.length);
    const 候选: number[] = [];
    for (let k = 下限; k <= pl.hand.length; k++) 候选.push(k);
    const a = yield { 玩家: p, 时机: 无时机, 步骤: '调度宣告',
      决定: { 类型: '调度宣告', 标签: '要调度几张？', 候选张数: 候选 } };
    const n = a && a.种类 === '决定' && typeof a.张数 === 'number' && 候选.includes(a.张数) ? a.张数 : 下限;
    if (!宣告调度(g, p, n)) { 记录(g, '⚠ 调度宣告无效，按 ' + 下限 + ' 张处理'); 宣告调度(g, p, 下限); }
  }

  for (const p of 顺序) {
    const n = o.调度张数[p] ?? 0;
    if (n <= 0) continue;
    const pl = g.players[p]!;
    const a = yield { 玩家: p, 时机: 无时机, 步骤: '调度执行',
      决定: { 类型: '调度执行', 标签: '选出 ' + n + ' 张放回牌库', 张数: n,
              手牌: pl.hand.map((x) => ({ uid: x.uid, 名称: x.def.全名, 可选: true })) } };

    const 选 = (a && a.种类 === '决定' && Array.isArray(a.选) ? a.选 : pl.hand.slice(0, n).map((x) => x.uid))
      .filter((x): x is number => typeof x === 'number');
    if (!执行调度(g, p, 选)) {
      记录(g, '⚠ 调度执行无效，自动选前 ' + n + ' 张');
      执行调度(g, p, pl.hand.slice(0, n).map((x) => x.uid));
    }
  }

  {
    const 后 = (g.先手玩家 + 1) % 人数;
    const lib = g.players[后]!.library;
    const 顶 = lib[lib.length - 1];

    if (顶) {

      清检视(g);
      登记检视(g, 后, 顶);
      yield { 玩家: 后, 时机: 无时机, 步骤: '后手看牌库顶',
        决定: { 类型: '选', 选什么: '物件', 玩家: 后, 标签: '检视 ' + g.players[后]!.name + ' 的牌库顶（仅你可见；看完点确认）',
          数量: { 最小: 0, 最大: 0 },

          查看: 给看({}, [{ 键: 顶.uid, 名称: 顶.def.全名 }]).查看 } };

    }

    const a = yield { 玩家: 后, 时机: 无时机, 步骤: '后手决定顶牌去向',
      决定: { 类型: '看牌库顶', 标签: '103.6：牌库顶牌留在牌库顶，还是置于牌库底？' } };
    后手决定顶牌去向(g, !(a && a.种类 === '决定' && a.接受 === false));
  }

  g.开局 = null;
}

export function* 整局G(g: GameState): Generator<请求, void, Action | null> {

  yield* 开局流程G(g);
  g.active = g.先手玩家;
  let 守卫 = 0;
  while (!g.over && 守卫++ < 300) {
    yield* 进行回合G(g);
    if (g.over) break;
    g.active = (g.active + 1) % g.players.length;
  }
}

function 同一攻击对象(a: 攻击对象, b: 攻击对象): boolean {
  if (a.种类 !== b.种类) return false;
  if (a.玩家 !== b.玩家) return false;
  if (a.种类 === '阵地' && b.种类 === '阵地') return a.阵地 === b.阵地;
  return true;
}

function 攻击对象描述(g: GameState, t: 攻击对象): string {
  return t.种类 === '玩家' ? g.players[t.玩家]!.name : ('相对阵地 ' + t.阵地);
}

export function 能发起战斗(g: GameState, p: number, u: Obj): boolean {
  if (g.over) return false;
  if (!u.def.类别.includes('单位')) return false;

  if (有效控制器(g, u) !== p || u.区域 !== '战场' || !u.阵地) return false;
  if (玩家被禁(g, p, '发起战斗', u)) return false;
  if (u.tapped) return false;
  if (u.sick && !有词(g, u, '神速')) return false;
  if (带词(g, u, '据守')) return false;
  if (有自身限制(g, u, '发起战斗')) return false;
  return 合法攻击对象(g, p, u).length > 0;
}

export function 攻击税(g: GameState, 目标玩家: number): number {
  let 税 = 0;
  for (const o of g.战场) {
    if (o.面 === '暗置' || 有效控制器(g, o) !== 目标玩家) continue;
    for (const ab of (o.def.能力?.能力 ?? []) as StaticAbility[]) {
      if (ab.种类 === '静止式' && ab.攻击税) 税 = Math.max(税, ab.攻击税);
    }
  }
  return 税;
}

export function 合法攻击对象(g: GameState, p: number, u: Obj): 攻击对象[] {
  if (!u.阵地) return [];
  const 敌 = (p + 1) % g.players.length;
  const 相对 = 相对阵地(u.阵地)!;
  const 挡 = g.players[敌]!.阵地[相对];
  const out: 攻击对象[] = [];

  const 可攻阵地 = !有自身限制(g, u, '攻击阵地');

  const 税 = 攻击税(g, 敌);
  const 付得起税 = 税 === 0 || 可支付数字费用(g, p, 税);
  const 可打玩家 = (): void => { if (付得起税) out.push({ 种类: '玩家', 玩家: 敌 }); };
  if (!挡) 可打玩家();
  else if (挡.tapped) { if (可攻阵地) out.push({ 种类: '阵地', 玩家: 敌, 阵地: 相对 }); 可打玩家(); }
  else if (可攻阵地) out.push({ 种类: '阵地', 玩家: 敌, 阵地: 相对 });
  return out;
}

export function 排队宣告攻击触发(g: GameState, u: Obj, 受方?: number | Obj): void {

  排队单位事件触发(g, '宣告攻击', u, { 触发受方: 受方 });
}
export function* 执行战斗流程G(g: GameState, p: number, u: Obj, 期望目标: 攻击对象): Generator<请求, void, Action | null> {

  g.战斗中 = true;
  try {

  if (!能发起战斗(g, p, u)) { 记录(g, u.def.全名 + ' 不满足发起战斗的条件，战斗中止（507.1a）'); return; }
  记录(g, '—— 战斗流程：' + u.def.全名 + '（507 战斗准备步骤）——');
  yield* 优先权循环G(g, 战斗时机, '战斗准备步骤');
  if (g.over) return;
  if (u.区域 !== '战场' || !u.阵地) { 记录(g, '507.3：进攻单位离开阵地，战斗流程中止'); return; }

  if (!能发起战斗(g, p, u)) { 记录(g, '508.1：不再满足条件，本次战斗流程中止，该单位本回合不能再次发起战斗'); return; }
  const 合法 = 合法攻击对象(g, p, u);
  if (!合法.some((x) => 同一攻击对象(x, 期望目标))) {
    记录(g, '508.2f：没有合法的攻击对象，战斗流程中止，该单位本回合不能再次发起战斗');
    return;
  }
  写横置(g, u, true);
  排队单位事件触发(g, '成为横置', u);
  记录(g, u.def.全名 + ' 宣告攻击 ' + 攻击对象描述(g, 期望目标) + '（508.2g 攻击对象已锁定）');

   const 攻击受方 = 期望目标.种类 === '玩家'
     ? 期望目标.玩家
     : (g.players[期望目标.玩家]!.阵地[期望目标.阵地] ?? undefined);
   排队宣告攻击触发(g, u, 攻击受方);
  yield* 优先权循环G(g, 战斗时机, '宣告攻击步骤');
  if (g.over) return;

  const 战力 = (x: Obj) => { const p = 武力(g, x); return 带词(g, x, '暴击') ? p * 2 : p; };
  if (期望目标.种类 === '玩家') {
    const 力 = 战力(u);
    if (力 > 0) 伤害事件(g, u, [{ 目标: 期望目标.玩家, 数量: 力, 战斗伤害: true }]);
    else 记录(g, u.def.全名 + ' 武力为 0，不造成伤害（509.2）');
  } else {

    const 挡 = (攻击受方 !== undefined && typeof 攻击受方 !== 'number' && 攻击受方.区域 === '战场')
      ? 攻击受方 : null;
    if (!挡) 记录(g, '结算伤害时阵地上已无单位，双方都不造成战斗伤害（509.4）');
    else {
      const 攻 = 战力(u), 防 = 战力(挡);
      const 受方: { 目标: Obj | number; 数量: number; 来源?: Obj | null; 战斗伤害?: boolean }[] = [];
      let 攻剩 = 攻;

      if (攻 > 0 && 带词(g, u, '破竹')) {
        const 还需 = Math.max(0, 体力上限(g, 挡) - 挡.damage);
        const 给单位 = Math.min(攻, 还需);
        攻剩 = 攻 - 给单位;
        if (给单位 > 0) 受方.push({ 目标: 挡, 数量: 给单位, 来源: u, 战斗伤害: true });
        if (攻剩 > 0) {
          受方.push({ 目标: 期望目标.玩家, 数量: 攻剩, 来源: u, 战斗伤害: true });
          记录(g, '破竹（702.8b）：' + 攻 + ' 点中先给 ' + 挡.def.全名 + ' ' + 给单位 + ' 点，余 ' + 攻剩 + ' 点给玩家');
        }
      } else if (攻 > 0) {
        受方.push({ 目标: 挡, 数量: 攻, 来源: u, 战斗伤害: true });
      }
      if (防 > 0) 受方.push({ 目标: u, 数量: 防, 来源: 挡, 战斗伤害: true });
      if (受方.length) 伤害事件(g, u, 受方);
      else 记录(g, '双方武力均为 0，不造成战斗伤害（509.2）');
    }
  }
  if (g.over) return;
  yield* 优先权循环G(g, 战斗时机, '结算伤害步骤');
  if (g.over) return;
  yield* 优先权循环G(g, 战斗时机, '战斗结束步骤');
  记录(g, '战斗流程结束，回到行动阶段（510.3）');
  } finally { g.战斗中 = false; }
}

export function 执行战斗流程(g: GameState, p: number, u: Obj, 目标: 攻击对象): void {
  const it = 执行战斗流程G(g, p, u, 目标);
  let r = it.next();
  while (!r.done) {
    const d = r.value.决定;
    r = it.next(d ? (d.类型 === '宣告' ? 自动宣告(g, d) : { 种类: '决定', 接受: true }) : { 种类: '让过' });
  }
}

export function 有效能力列表(g: GameState, o: Obj): Ability[] {
  const 印 = ((o.def.能力?.能力 ?? []) as Ability[]).map(解析能力);
  if (o.区域 !== '战场') return 印;
  const f = 有效特征(g, o);
  if (f.失去所有能力) return 印;
  const 授 = f.关键词.filter((k) => !k.印制 && 能解析(k.名称))
    .map((k) => 解析能力({ 名称: k.名称, ...(k.数值 !== undefined ? { 数值: k.数值 } : {}) } as 关键词能力 as Ability));
  return [...印, ...授];
}

export function 可用启动式能力(g: GameState, p: number, o: Obj): number[] {
  if (!有规则叙述(g, o)) return [];
  const 通常时机 = 处于通常时机(g, p);
  if (g.over || 有效控制器(g, o) !== p) return [];

  const 合法区域 = o.区域 === '战场' || (o.区域 === '墓地' && 有词(g, o, '再起'));
  if (!合法区域) return [];
  const 已用 = 本回合用过的能力(o, g.turn);
  const out: number[] = [];
  有效能力列表(g, o).forEach((ab0, i) => {

    const ab = ab0 as unknown as ActivatedAbility;
    if (ab.种类 !== '启动式' || ab.是费用能力) return;
    if (ab.限制 === '每回合一次' && 已用.includes(i)) return;
    if (ab.时机 !== '瞬发' && !通常时机) return;
    if (ab.费用.横置 && (o.tapped || (o.sick && !有词(g, o, '神速')))) return;
    const 通用数 = ab.费用.通用 === 'X' ? 0 : (ab.费用.通用 ?? 0);
    if (通用数 && !可支付数字费用(g, p, 通用数)) return;

    if (ab.费用.体力 && g.players[p]!.体力 < ab.费用.体力) return;
    if (ab.条件 && !判断(g, p, ab.条件)) return;

    if ((ab as { 名称?: string }).名称 === '佩带' && o.佩带在 !== undefined) return;
    out.push(i);
  });
  return out;
}

export function 启动能力(g: GameState, p: number, o: Obj, 索引: number, 目标已选?: 目标[], 支付源?: number[], 模式号?: number, 费用弃牌?: number[], 费用牺牲?: number[], 宣告X?: number): boolean {

  const ab = 有效能力列表(g, o)[索引] as unknown as ActivatedAbility | undefined;
  if (!ab || ab.种类 !== '启动式') return false;
  const 目标: 目标[] = [];
  const 目标槽: Record<string, 目标> = {};

  const 模式项 = ab.模式 && 模式号 !== undefined ? ab.模式.选项[模式号] : undefined;
  const 规格表 = 模式项?.目标 ?? ab.目标 ?? [];
  for (let i = 0; i < 规格表.length; i++) {
    const spec = 规格表[i]!;

    const 给了 = 目标已选 ? 目标已选[i] : undefined;
    if (给了 !== undefined) { 目标.push(给了); 目标槽[spec.目标名] = 给了; continue; }

    const 候选 = 候选目标(g, p, spec, o);
    if (候选.length < spec.数量.最小) { 记录(g, o.def.全名 + '：目标不足，启动失败'); return false; }
    const 敌 = 候选.find((c) => (c.obj ? c.obj.操控者 !== p : c.玩家 !== p));
    const 取 = 敌 ?? 候选[0]!;
    目标.push(取.obj ?? 取.玩家!);
    目标槽[spec.目标名] = 取.obj ?? 取.玩家!;
  }

  const 通用数 = ab.费用.通用 === 'X' ? (宣告X ?? 0) : (ab.费用.通用 ?? 0);
  if (通用数 && !支付数字费用(g, p, 通用数, 支付源)) { 记录(g, '数字费用支付失败'); return false; }
  if (ab.费用.体力) g.players[p]!.体力 -= ab.费用.体力;

  if (ab.费用.自身体力) {
    写伤害(g, o, o.damage + ab.费用.自身体力);
    记录(g, o.def.全名 + ' 失去 ' + ab.费用.自身体力 + ' 点体力（启动费用）');
  }
  if (ab.费用.横置) 写横置(g, o, true);
  排队单位事件触发(g, '成为横置', o);

  if (ab.费用.弃牌) {
    const 要弃 = ab.费用.弃牌.数量 === 'X' ? (宣告X ?? 0) : ab.费用.弃牌.数量;
    const 选 = (费用弃牌 ?? []).filter((uid) => g.players[p]!.hand.some((c) => c.uid === uid));
    if (选.length < 要弃) { 记录(g, o.def.全名 + '：弃牌费用付不出（需要 ' + 要弃 + ' 张）'); return false; }
    for (const uid of 选.slice(0, 要弃)) {
      const c = g.players[p]!.hand.find((x) => x.uid === uid)!;
      记录(g, g.players[p]!.name + ' 弃掉 ' + c.def.全名 + '（启动费用，602.1d）');
      置入墓地(g, c);
    }
  }
  if (ab.费用.牺牲) {
    const 选 = (费用牺牲 ?? []).map((uid) => g.战场.find((x) => x.uid === uid)).filter((x): x is Obj => !!x && 有效控制器(g, x) === p);
    if (选.length < ab.费用.牺牲.数量) { 记录(g, o.def.全名 + '：牺牲费用付不出（需要 ' + ab.费用.牺牲.数量 + ' 个）'); return false; }
    for (const x of 选.slice(0, ab.费用.牺牲.数量)) 牺牲(g, x);
  }

  if (ab.费用.暗置进场) 设面(g, o, '暗置', p);
  const 牺牲自己 = ab.费用.牺牲自身;
  if (ab.限制 === '每回合一次') {
    const 已用 = 本回合用过的能力(o, g.turn);
    写记忆(g, o, '本回合已用能力', { 回合: g.turn, 索引: [...已用, 索引] });
  }
  记录(g, g.players[p]!.name + ' 启动 ' + o.def.全名 + ' 的能力' + (ab.标签 ? '：' + ab.标签 : ''));

  堆叠加(g, {
    id: g.nextStackId++, 种类: '启动式',
    标签: o.def.全名 + (ab.标签 ? '：' + ab.标签 : ' 的能力'),
    操控者: p, 来源: o, card: null, 目标, 目标槽, steps: 模式项?.效应 ?? ab.效应,
    宣告X: ab.费用.通用 === 'X' ? (宣告X ?? 0) : undefined,
    能力名: (ab.标签 ?? '').startsWith('射击') ? '射击' : undefined,
  });
  if (牺牲自己) 牺牲(g, o);
  return true;
}
