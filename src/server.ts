import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GameState, Obj } from './engine/state.js';
import { 势力支持度 } from './engine/state.js';
import { 阵地顺序, type 阵地 } from './engine/types.js';
import {
  新对局, 整局G, type 请求, type Action, type 目标, type 攻击对象,
} from './engine/engine.js';
import { 列出合法动作 } from './engine/options.js';
import { 解析动作, type 线动作 } from './engine/解析动作.js';
import { 可用启动式能力, 处于通常时机, 实际打出费用, 有效特征, 是类别, 决定先手, 宣告调度, 执行调度, 后手决定顶牌去向, 自动宣告, 记录, 可支付来源 } from './engine/engine.js';
import { 有效控制器 } from './engine/continuous.js';
import { 覆盖度 } from './engine/keywords.js';
import { 默认牌组, 缺牌替代 } from './data/decks.js';
import { 系列配置 } from './data/系列配置.js';
import { 卡号, 卡图 } from './engine/types.js';
import type {CardDef} from './engine/types.js';
import { 需求_动作, 需求_决定, 合并同族动作, type 需求 } from './收发需求.js';

async function 装载卡池(): Promise<CardDef[]> {
  const 表 = new Map<string, CardDef>();
  const 报告: string[] = [];
  for (const [名, 项] of Object.entries(系列配置)) {
    if (!项.启用) { 报告.push(名 + '（关）'); continue; }
    const m = (await import('./data/' + 名 + '.js')) as Record<string, unknown>;
    const 数组 = m[名 + '卡'];
    if (!Array.isArray(数组)) throw new Error('系列「' + 名 + '」：' + 名 + '.ts 里没有导出 ' + 名 + '卡');
    for (const c of 数组 as CardDef[]) { const k = 卡号(c); if (!表.has(k)) 表.set(k, c); }
    报告.push(名 + ' ' + 数组.length + ' 张');
  }
  console.log('卡池：' + 报告.join('，') + ' → 去重后 ' + 表.size + ' 张');
  return [...表.values()];
}
const 卡池: CardDef[] = await 装载卡池();
const 卡池索引 = new Map(卡池.map((c) => [卡号(c), c]));

{
  const k = 卡号(缺牌替代);
  if (卡池索引.has(k)) throw new Error('缺牌替代 的卡号 ' + k + ' 和真牌「' + 卡池索引.get(k)!.全名 + '」撞号了');
  卡池索引.set(k, 缺牌替代);
}

let v = 20250101;

const rnd = (): number => { v = (v * 1103515245 + 12345) % 2147483648; return v / 2147483648; };

interface 座位 {
  令牌: string;
  名字: string;

  最后见到: number;
}
interface 房间 {
  号: string;
  甲: CardDef[]; 乙: CardDef[];
  g: GameState;
  it: Generator<请求, void, Action | null>;
  当前: 请求 | null;
  AI代理: [boolean, boolean];
  上次日志长?: number;
  本次日志?: string[];

  无限制组牌: boolean;
  入座: [座位 | null, 座位 | null];

  热座?: boolean;
  创建时间: number;

  已开始: boolean;

  废弃: boolean;

  准备: [boolean, boolean];

  最后活动: number;
}

const 掉线阈值 = 90_000;

function 在线(s: 座位 | null): boolean {
  if (!s) return false;
  for (const p of 推送表) if (p.令牌 !== null && p.令牌 === s.令牌) return true;
  return Date.now() - s.最后见到 < 掉线阈值;
}
const 房间表 = new Map<string, 房间>();

const 令牌表 = new Map<string, { 房: 房间; 座位: number }>();
const 房间码字母 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function 新房间码(): string {
  for (let 试 = 0; 试 < 200; 试++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += 房间码字母[Math.floor(Math.random() * 房间码字母.length)];
    if (!房间表.has(s)) return s;
  }
  return 'R' + Date.now().toString(36).toUpperCase().slice(-4);
}

function 取房间(号?: string, 选项?: { 热座?: boolean }): 房间 {
  const 码 = (号 || '').toUpperCase().trim();
  if (码 && 房间表.has(码)) return 房间表.get(码)!;
  const 房: 房间 = {
    号: 码 || 新房间码(),
    甲: 默认牌组, 乙: 默认牌组,

    热座: 选项?.热座 === true ? true : undefined,
    g: null!, it: null!, 当前: null,
    AI代理: [false, false], 无限制组牌: false, 准备: [false, false], 入座: [null, null], 创建时间: Date.now(),
    已开始: false, 废弃: false, 最后活动: Date.now(),
  };
  房间表.set(房.号, 房);

  房.g = 新对局([房.甲, 房.乙], rnd, { 自动开局: false });
  推送大厅();
  return 房;
}

function 按令牌(令牌: unknown): 房间 | null {
  const t = typeof 令牌 === 'string' ? 令牌 : '';
  return (t ? 令牌表.get(t)?.房 : null) ?? null;
}

function 视图座位(座: { 座位: number } | null): number | null {
  if (!座) return null;
  return 座.座位 < 0 ? null : 座.座位;
}

function 找座位(令牌: unknown): { 房: 房间; 座位: number } | null {
  const t = typeof 令牌 === 'string' ? 令牌 : '';
  const 记 = t ? (令牌表.get(t) ?? null) : null;

  if (记) {
    const 座 = 记.房.入座.find((s) => s?.令牌 === t);
    if (座) { 座.最后见到 = Date.now(); 记!.房.最后活动 = Date.now(); }
  }
  return 记;
}

function 人齐了(房: 房间): boolean { return !!房.入座[0] && !!房.入座[1] && 在线(房.入座[0]) && 在线(房.入座[1]); }

function 都准备好了(房: 房间): boolean {
  if (房.热座) return true;
  if (!人齐了(房)) return false;
  return !!(房.准备[0] && 房.准备[1]);
}

function 入座视图(房: 房间) {
  return 房.入座.map((s, i) => (s ? { 座位: i, 名字: s.名字, 在线: 在线(s) } : null));
}

const 图存在 = new Map<string, boolean>();

function 有卡图(c: CardDef): boolean {
  const 路 = 'web' + 卡图(c);
  let v = 图存在.get(路);
  if (v === undefined) { v = fs.existsSync(路); 图存在.set(路, v); }
  return v;
}

function 校验牌组(ids: string[], 无限制 = false): { 错误: string[]; 警告: string[] } {
  const 错误: string[] = [];
  const 警告: string[] = [];

  if (无限制) {
    for (const id of ids) if (!卡池索引.get(id)) 错误.push('未知卡牌：' + id);
    警告.push('无限制组牌（测试）：已跳过「同名≤3 张」与「主牌 50 张以上」（100.2a）');
    return { 错误, 警告 };
  }
  const 名计数 = new Map<string, number>();
  for (const id of ids) {
    const c = 卡池索引.get(id);
    if (!c) { 错误.push('未知卡牌：' + id); continue; }
    if ((c.超类别 ?? []).includes('基本')) continue;
    for (const nm of c.名称) 名计数.set(nm, (名计数.get(nm) ?? 0) + 1);
  }
  for (const [nm, n] of 名计数) if (n > 3) 错误.push('名称「' + nm + '」有 ' + n + ' 张，超过 3 张（100.2a）');

  if (ids.length < 50) 错误.push('构筑赛主牌必须 50 张以上（100.2a），当前 ' + ids.length + ' 张');
  return { 错误, 警告 };
}

function 池视图(房?: 房间) {
  return {
    卡池: 卡池.map((c) => ({
      id: 卡号(c), 系列: c.系列, 编号: c.编号, 名称: c.全名, 类别: c.类别, 副类别: c.副类别,
      费用: c.打出费用, 势力: c.势力, 支持: c.势力支持 ?? null,
      基本: (c.超类别 ?? []).includes('基本'), 武力: c.武力 ?? null, 体力上限: c.体力上限 ?? null,
      文字: c.现行文字,

      图: 有卡图(c) ? 卡图(c) : null,

      超类别: c.超类别 ?? [],
      需求: c.势力需求?.符号 ?? {},
      是单位: (c.类别 ?? []).includes('单位'),
    })),
    甲: (房?.甲 ?? []).map(卡号), 乙: (房?.乙 ?? []).map(卡号),

    无限制: !!房?.无限制组牌,
  };
}

const 推送表 = new Set<{ res: import('http').ServerResponse; 房: 房间 | null; 座位: number | null;

  令牌: string | null }>();

const 上次推送 = new WeakMap<房间, string>();

function 推送(房: 房间): void {
  if (!推送表.size) return;

  const gp = 房.g.players;
  const 指纹 = [房.g.turn, 房.g.over ? 1 : 0, 房.g.nextStamp, 房.g.nextUid, 房.g.nextStackId,
    房.g.log.length, 房.g.stack.length, 房.g.pending.length, 房.g.战场.length,
    gp.map((x) => x.体力 + ':' + x.hand.length + ':' + x.library.length + ':' + x.graveyard.length).join(','),
    gp.map((x) => Object.values(x.阵地).filter(Boolean).length).join(','),
  ].join('|');
  if (上次推送.get(房) === 指纹) return;
  上次推送.set(房, 指纹);
  const 按座 = new Map<number | null, string>();
  for (const c of [...推送表]) {
    if (c.房 !== 房) continue;
    if (!按座.has(c.座位)) 按座.set(c.座位, JSON.stringify(视图(房, c.座位)));
    try { c.res.write('data: ' + 按座.get(c.座位) + '\n\n'); } catch { 推送表.delete(c); }
  }
}

const 对局信息路径 = process.env.ZMDJ_DATA_LOG ?? '对局信息.jsonl';
let 数据出口 = (() => { try { return fs.openSync(对局信息路径, 'a'); } catch { return null; } })();

function 对局信息重开(房间号: string): void {
  try { if (数据出口 !== null) fs.closeSync(数据出口); } catch {}
  try { fs.writeFileSync(对局信息路径, ''); } catch {}
  数据出口 = (() => { try { return fs.openSync(对局信息路径, 'a'); } catch { return null; } })();
  事件序号 = 0; 当前段 = 0;
  写记录({ 类: '新局', 房间: 房间号 });
  写记录({ 类: '标记', 人读: '──── 新局 ' + 房间号 + ' ' + new Date().toLocaleString() + ' ────' });
}

const 人读出口 = (() => { try { return fs.openSync(process.env.ZMDJ_TEXT_LOG ?? '服务器.log', 'a'); } catch { return null; } })();
function 记人读日志(行: string): void {
  if (人读出口 === null) return;
  try { fs.writeSync(人读出口, 行 + '\n'); } catch {}
}
let 事件序号 = 0;
let 当前请求号 = 0;
let 应用中 = false;

let 当前段 = 0;

function 新一段(): void { 当前段 = ++事件序号; }
function 写记录(事件: { 类: string; 人读?: string; [k: string]: unknown }): void {
  const { 人读, ...其余 } = 事件;
  const 号 = 当前段 || ++事件序号;
  if (当前段 === 0) 当前段 = 号;
  if (数据出口 !== null) {
    try { fs.writeSync(数据出口, JSON.stringify({ 时间: new Date().toISOString(), 编号: 号, ...其余 }) + '\n'); } catch {  }
  }
  if (人读 !== undefined && 人读出口 !== null) {
    const 用时 = 其余['用时'] ?? 其余['毫秒'];
    try { fs.writeSync(人读出口, String(号).padStart(6) + '  ' + String(用时 === undefined ? '-' : 用时 + 'ms').padStart(6) + '  ' + 人读 + '\n'); } catch {}
  }
}
const 慢阈值毫秒 = Number(process.env.ZMDJ_SLOW_MS ?? 120);
let 当前请求标签 = '';
function 计时<T>(标签: string, fn: () => T): T {
  const t0 = Date.now();
  try { return fn(); }
  finally {
    const 耗 = Date.now() - t0;
    if (耗 >= 慢阈值毫秒) console.log('[慢] ' + 耗 + 'ms　' + 标签 + (当前请求标签 ? '　（' + 当前请求标签 + '）' : ''));
    写记录({ 类: '耗时', 段: 标签, 毫秒: 耗, 慢: 耗 >= 慢阈值毫秒 });
  }
}

function 改房<T>(房: 房间, fn: () => T): T {
  try {
    const 结果 = 计时('改房', fn);

    const 全 = 房.g && 房.g.log;
    if (全) {
      const 从 = 房.上次日志长 ?? 0;
      for (let k = 从; k < 全.length; k++) { const 一条 = 全[k] ?? ''; console.log(一条); 写记录({ 类: '对局', 行: 一条 }); (房.本次日志 ??= []).push(一条); }
      房.上次日志长 = 全.length;
    }

    if (!应用中 && (房.本次日志 ?? []).length) {
      for (const 行 of 房.本次日志 ?? []) 写记录({ 类: '人读', 人读: 行 });
      房.本次日志 = [];
    }
    return 结果;
  } finally {
    推送(房);
  }
}

function 推送大厅(): void {
  if (!推送表.size) return;
  const 表 = JSON.stringify(房间列表视图());
  for (const cc of [...推送表]) {
    if (cc.房 !== null) continue;
    try { cc.res.write('data: ' + 表 + '\n\n'); } catch { 推送表.delete(cc); }
  }
}

function 房间列表视图() {
  return { 大厅: true, 房间: [...房间表.values()].filter((x) => !x.热座).map((x) => ({

    号: x.号, 入座: 入座视图(x), 人齐: 人齐了(x),
    回合: x.g ? x.g.turn : 0, 已开局: !!x.it,
  })) };
}

function 推进(房: 房间, 动作: Action | null): void {

  改房(房, () => 计时('推进', () => 推进内(房, 动作)));
}

function 推进内(房: 房间, 动作: Action | null): void {

  let r = 房.it.next(动作);
  let 守卫 = 0;
  while (!r.done && 守卫++ < 20000) {
    const req = r.value;

    const 有意义 = !!req.决定
      || 列出合法动作(房.g, req.玩家, req.时机).some((a) => a.种类 !== '让过')

      || (req.玩家 === 房.g.active && req.步骤 === '行动阶段' && 房.g.stack.length === 0);
    if (有意义) { 房.当前 = req; return; }

    记录(房.g, 房.g.players[req.玩家]!.name + ' 让过优先权（' + (req.步骤 || '—') + '，自动）');
    r = 房.it.next(null);
  }
  房.当前 = r.done ? null : r.value;
}

function 发牌并开局(房: 房间, seed: number): void {
  v = seed >>> 0;
  房.g = 新对局([房.甲, 房.乙], rnd, { 自动开局: false });

  if (!房.热座 && 房.g.开局 && 房.g.players.every((x) => x.hand.length === 0)) 决定先手(房.g, rnd() < 0.5 ? 0 : 1);
  房.it = 整局G(房.g);
  房.当前 = null;
  推进(房, null);
}

function 卡(房: 房间, o: Obj, 牌面可见 = false) {

  const f = 有效特征(房.g, o);
  const 暗 = o.面 === '暗置';
  const 露 = 暗 && 牌面可见;
  return {
    uid: o.uid,
    名称: 暗 && !露 ? f.名称 : o.def.全名,
    类别: f.类别, 副类别: f.副类别, 超类别: f.超类别,
    武力: 是类别(房.g, o, '单位') ? f.武力 : null,
    体力上限: 是类别(房.g, o, '单位') ? f.体力上限 : null,

    印制武力: typeof o.def.武力 === 'number' ? o.def.武力 : null,
    印制体力上限: typeof o.def.体力上限 === 'number' ? o.def.体力上限 : null,
    已受伤: o.damage,
    横置: o.tapped, 面: o.面, 整备: o.sick,
    关键词: f.关键词,
    图: (暗 && !露) || !有卡图(o.def) ? null : 卡图(o.def),
    文字: 暗 && !露 ? '（暗置：没有规则描述）' : o.def.现行文字,
    费用: o.def.打出费用,
    势力需求: o.def.势力需求.符号,
    势力: f.势力,
    拥有者: o.owner, 操控者: o.操控者,
    是单位: 是类别(房.g, o, '单位'),
    支持: 暗 ? null : (o.def.势力支持 ?? null),
    标记: o.标记.map((m) => m.类型 + '×' + m.数量),
  };
}

function 效果授予了(房: 房间, 座位: number, uid: number): boolean {
  return 房.g.可见登记.some((x) => x.玩家 === 座位 && x.uid === uid);
}

function 默认可见(房: 房间, o: Obj, 座位: number): boolean {
  if (o.面 === '暗置') return 有效控制器(房.g, o) === 座位;
  switch (区of(房, o)) {
    case '手牌': return 有效控制器(房.g, o) === 座位;
    case '牌库': return false;
    case undefined: return false;
    default: return true;
  }
}

export function 可见(房: 房间, o: Obj, 座位: number | null): boolean {
  if (座位 === null) return true;
  if (效果授予了(房, 座位, o.uid)) return true;
  return 默认可见(房, o, 座位);
}

const 双方确认 = new WeakMap<房间, number[]>();

function 在哪(房: 房间, uid: number):
{ 区: '手牌' | '牌库' | '墓地' | '战场' | '放逐区' | '堆叠'; 物件: Obj } | undefined {
  for (const p of 房.g.players) {
    const 表: ['手牌' | '牌库' | '墓地', Obj[]][] = [['手牌', p.hand], ['牌库', p.library], ['墓地', p.graveyard]];
    for (const [区, 列] of 表) {
      const o = 列.find((x) => x.uid === uid);
      if (o) return { 区, 物件: o };
    }
  }
  const 战 = 房.g.战场.find((x) => x.uid === uid);
  if (战) return { 区: '战场', 物件: 战 };
  const 逐 = 房.g.放逐区.find((x) => x.uid === uid);
  if (逐) return { 区: '放逐区', 物件: 逐 };
  const 堆 = 房.g.stack.map((s) => s.card).find((x): x is Obj => !!x && x.uid === uid);
  if (堆) return { 区: '堆叠', 物件: 堆 };

  const 持有: (Obj[] | undefined)[] = 房.g.stack.map((s) => (s as unknown as { 暂存?: Obj[] }).暂存);
  持有.push((房.it as unknown as { 暂存?: Obj[] } | null)?.暂存);
  for (const 列 of 持有) {
    const 暂 = 列?.find((x) => x.uid === uid);
    if (暂) return { 区: '牌库', 物件: 暂 };
  }
  return undefined;
}

function 区of(房: 房间, o: Obj): '手牌' | '牌库' | '墓地' | '战场' | '放逐区' | '堆叠' | undefined {
  return 在哪(房, o.uid)?.区;
}

function 找牌(房: 房间, uid: number): Obj | undefined {
  return 在哪(房, uid)?.物件;
}

function 挂牌面(房: 房间, 需: 需求 | null, 座位: number | null): 需求 | null {
  if (!需) return null;
  for (const 槽 of 需.槽 ?? []) {
    for (const c of 槽.候选 ?? []) {
      if (typeof c.键 !== 'number' || !c.名) continue;
      const o = 找牌(房, c.键);
      if (o) (c as { 卡?: unknown }).卡 = 卡(房, o, 可见(房, o, 座位));
    }
  }

  for (const c of 需.查看 ?? []) {
    if (typeof (c as { 键?: unknown }).键 !== 'number') continue;
    const o = 找牌(房, (c as { 键: number }).键);
    if (o) (c as { 卡?: unknown }).卡 = 卡(房, o, true);
  }
  return 需;
}

function 视图(房: 房间, 座位: number | null = null) {

  const 卡v = (o: Obj) => 卡(房, o, 可见(房, o, 座位));
  const 看得见 = (i: number) => 座位 === null || 座位 === i;
  return {
    我的座位: 座位,
    入座: 入座视图(房),
    人齐: 人齐了(房), 废弃: 房.废弃, 已开始: 房.已开始,
    准备: 房.准备, 都准备: 都准备好了(房), 等准备: !房.热座 && !都准备好了(房),
    热座: 座位 === null,
    turn: 房.g.turn, active: 房.g.active, over: 房.g.over, winner: 房.g.winner, AI代理: 房.AI代理,
    先手玩家: 房.g.先手玩家,

    开局: 房.g.开局 ? {
      起手牌数: 房.g.开局.起手牌数,
      调度张数: 房.g.开局.调度张数,
      已宣告: 房.g.开局.已宣告, 已执行: 房.g.开局.已执行,

    } : null,
    players: 房.g.players.map((p) => ({
      index: p.index, 名字: p.name, 体力: p.体力, 体力上限: p.lifeMax,
      支持: 势力支持度(房.g, p.index),

      手牌: p.hand.filter((c) => 可见(房, c, 座位)).map((c) => 卡v(c)),
      手牌张数: p.hand.length,
      隐藏手牌: !看得见(p.index) && p.hand.every((c) => !可见(房, c, 座位)),
      阵地: Object.fromEntries(阵地顺序.map((s) => [s, p.阵地[s] ? 卡v(p.阵地[s]!) : null])),

      阵地外: 房.g.战场.filter((o) => !o.阵地 && 有效控制器(房.g, o) === p.index).map((c) => 卡v(c)),

      墓地: p.graveyard.map((c) => 卡v(c)),
      墓地对数: p.graveyard.length,

      牌库张数: p.library.length,
      本回合已打领土: p.landsPlayedThisTurn,
    })),

    放逐区: 房.g.放逐区.map((c) => 卡v(c)),
    放逐张数: 房.g.放逐区.length,

    可见登记: (() => {
      const out: ReturnType<typeof 卡>[] = [];
      for (const x of 房.g.可见登记) {
        if (!看得见(x.玩家)) continue;
        const o = 房.g.players.flatMap((pl) => [...pl.library, ...pl.hand, ...pl.graveyard])
          .concat(房.g.战场).concat(房.g.放逐区).find((c) => c.uid === x.uid);
        if (o) out.push(卡v(o));
      }
      return out;
    })(),
    stack: 房.g.stack.map((s) => ({

      栈id: s.id,
      标签: s.标签, 操控者: s.操控者,

      卡: s.card ? 卡v(s.card) : null,

      目标: s.目标.map((t) => typeof t === 'number' ? 房.g.players[t]!.name
        : ('堆叠项' in t ? (房.g.stack.find((x) => x.id === t.堆叠项)?.标签 ?? '（已不在堆叠）') : t.def.全名)),
    })),
    当前请求: 房.当前 ? {
      玩家: 房.当前.玩家, 步骤: 房.当前.步骤, 时机: 房.当前.时机,
      决定: !房.当前.决定 ? null : 房.当前.决定.类型 === '搜寻'

        ? { ...房.当前.决定, 候选: 房.当前.决定.候选.map((c) => {
            const o = 房.g.players.flatMap((x) => [...x.library, ...x.hand, ...x.graveyard]).concat(房.g.战场)
              .concat(房.g.放逐区).find((x) => x.uid === c.uid);
            return { ...c, 卡: o ? 卡v(o) : null };
          }) }
        : 房.当前.决定,
    } : null,

    决定需求: (() => {
      if (!(房.当前 && 房.当前.决定)) return null;
      const 需 = 挂牌面(房, 需求_决定(房.当前.决定 as unknown as Record<string, unknown>, 房.g, 房.当前.玩家), 座位);
      if (!需) return null;
      const 双方 = (房.当前.决定 as { 等双方确认?: boolean }).等双方确认 === true;
      const 该看 = 座位 === null || 双方 || 座位 === 房.当前.玩家;
      return 该看 ? 需 : { ...需, 查看: undefined };
    })(),

    可操作: (() => {
      if (座位 === null) return true;
      if (!房.当前) return false;
      const 双方 = (房.当前.决定 as { 等双方确认?: boolean } | undefined)?.等双方确认 === true;
      if (双方) return !(双方确认.get(房) ?? []).includes(座位);
      return 房.当前.玩家 === 座位;
    })(),
    合法动作: 房.当前 && !房.当前.决定
      ? 合并同族动作(列出合法动作(房.g, 房.当前.玩家, 房.当前.时机)).map((a) => ({
          ...a,

          需求: 挂牌面(房, 需求_动作(a as unknown as Record<string, unknown>, 房.当前!.玩家,
            可支付来源(房.g, 房.当前!.玩家) || [], 房.g), 座位),
        }))
      : [],

    可支付来源: 房.g.players.map((_, i) => 可支付来源(房.g, i)),

    双方确认: (() => {
      const d = 房.当前 && 房.当前.决定 as { 等双方确认?: boolean } | undefined;
      if (!d || d.等双方确认 !== true) return null;
      return { 需要: [0, 1], 已: [...(双方确认.get(房) ?? [])] };
    })(),
    log: 房.g.log.slice(-100),

    log总数: 房.g.log.length,
  };
}

function 应用(房: 房间, 体: 线动作, 座位: number | null = null): { ok: boolean; 错误?: string } {
  if (!房.当前) return { ok: false, 错误: '现在不需要任何人做决定' };
  const p = 房.当前.玩家;

  const 展示中 = !!(房.当前
    && (房.当前.决定 as { 等双方确认?: boolean } | undefined)?.等双方确认 === true);
  if (座位 !== null && p !== 座位 && !展示中) {
    return { ok: false, 错误: '现在轮到 ' + 房.g.players[p]!.name + ' 做决定，不是你' };
  }
  新一段();
    const 之前应用中 = 应用中; 应用中 = true;
  写记录({ 类: '收', 房间: 房.号 ?? '', 座位, 轮到: p, 体 });
  const 起 = Date.now();
  const r = 解析动作(房.g, p, 体);
  if (!r.ok) { 写记录({ 类: '收-拒绝', 错误: r.错误, 人读: '✗ ' + (r.错误 ?? '') }); 应用中 = 之前应用中; return { ok: false, 错误: r.错误 }; }

  {
    const d = 房.当前 && 房.当前.决定 as { 等双方确认?: boolean } | undefined;
    if (d && d.等双方确认 === true) {
      const 声明 = (体 as { 确认座位?: unknown }).确认座位;
      const 谁 = typeof 声明 === 'number' ? 声明 : (座位 ?? 房.当前!.玩家);
      const 新 = [...new Set([...(双方确认.get(房) ?? []), 谁])];
      const 齐 = [...new Set(新)];
      双方确认.set(房, 齐);
      if (齐.length < 2) { 推送(房); 应用中 = 之前应用中; return { ok: true }; }
      双方确认.set(房, []);
      记录(房.g, 房.g.players.map((x) => x.name).join(' / ') + ' 都确认了展示');
      推进(房, r.动作);
      应用中 = 之前应用中;
      return { ok: true };
    }
    if (双方确认.get(房)?.length) 双方确认.set(房, []);
  }
  if (r.动作.种类 === '让过') { 记录(房.g, 房.g.players[p]!.name + ' 让过优先权（' + 房.当前.步骤 + '）'); 推进(房, null); }
  else 推进(房, r.动作);
  const 用时 = Date.now() - 起;

  写记录({ 类: '本步', 毫秒: 用时, 动作: r.动作.种类, 日志数: (房.本次日志 ?? []).length });
  for (const 行 of (房.本次日志 ?? [])) 写记录({ 类: '人读', 用时, 人读: 行 });
  if (!(房.本次日志 ?? []).length) 写记录({ 类: '人读', 用时, 人读: '（这一步没有产生日志行）' });
  房.本次日志 = [];
  应用中 = 之前应用中;
  return { ok: true };
}

const 上次响应摘要 = new Map<string, number>();
function 摘要(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
function 发JSON(res: http.ServerResponse, 数据: unknown, 码 = 200): void {
  const 体 = JSON.stringify(数据);

  {
    const k = 当前请求号 + ':' + 码;
    const d = 摘要(体) ^ 体.length;
    const 变 = 上次响应摘要.get(k) !== d;
    if (变) 上次响应摘要.set(k, d);
    新一段();
    写记录({ 类: '发', 码, 字节: 体.length, 摘要: d, 变化: 变, 数据: 变 ? 数据 : undefined });
  }
  res.writeHead(码, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(体);
}

function 收JSON(req: http.IncomingMessage, 回调: (体: any) => void): void {
  let 原始 = '';
  req.on('data', (c) => { 原始 += c; });
  req.on('end', () => { try { 回调(原始 ? JSON.parse(原始) : {}); } catch { 回调({}); } });
}

function 发文件(res: http.ServerResponse, 相对: string, 类型: string): void {
  const 根目录 = process.cwd();
  const 全 = path.resolve(根目录, 相对);

  if (!全.startsWith(根目录)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(全, (e, 数据) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('找不到 ' + 全); return; }
    res.writeHead(200, {
      'Content-Type': 类型,

      'Cache-Control': 类型.startsWith('text/html') ? 'no-store, must-revalidate' : 'max-age=3600',
    });
    res.end(数据);
  });
}

function 发页面(res: http.ServerResponse, 相对: string): void { 发文件(res, 相对, 'text/html; charset=utf-8'); }

interface 服务器配置 { 端口?: number; 监听?: '仅本机' | '全部'; 口令?: string }
const 配置: 服务器配置 = (() => {
  try { return JSON.parse(fs.readFileSync('服务器配置.json', 'utf8')) as 服务器配置; }
  catch { return {}; }
})();
const 端口 = Number(process.env.PORT ?? 配置.端口 ?? 8787);
const 主机 = process.env.HOST ?? (配置.监听 === '仅本机' ? '127.0.0.1' : '0.0.0.0');
const 口令 = process.env.口令 ?? 配置.口令 ?? '';

function 可用地址(): { 网卡: string; 地址: string }[] {
  const out = [{ 网卡: '本机', 地址: 'http://127.0.0.1:' + 端口 }];
  for (const [网卡, 列] of Object.entries(os.networkInterfaces())) {
    for (const a of 列 ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;
      if (/VMware|VirtualBox|Loopback|vEthernet|Hyper-V/i.test(网卡)) continue;
      out.push({ 网卡, 地址: 'http://' + a.address + ':' + 端口 });
    }
  }
  return out;
}

const 服务器 = http.createServer((req, res) => {

  const u = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');

  新一段();
  写记录({ 类: '收', 路由: u });
  if (req.method === 'GET' && (u === '/' || u === '/index.html')) return 发页面(res, 'web/index.html');
  if (req.method === 'GET' && u.startsWith('/cards/')) {

    const 路径 = u.split('?')[0]!;

    let 名: string;
    try { 名 = decodeURIComponent(路径.slice(7)); } catch { res.writeHead(400); return res.end('bad name'); }
    const 段 = 名.split('/');
    const 合法段 = (x: string) => !!x && x.length <= 64 && x !== '.' && x !== '..' && x.indexOf(String.fromCharCode(92)) < 0;
    if (段.length < 1 || 段.length > 2 || !段.every(合法段)) { res.writeHead(400); return res.end('bad name'); }
    return 发文件(res, 'web/cards/' + 名, /\.png$/i.test(名) ? 'image/png' : 'image/jpeg');
  }
  if (req.method === 'GET' && u === '/api/state') {
    const 令牌 = new URL(req.url ?? '/', 'http://x').searchParams.get('令牌');
    const 座 = 找座位(令牌);
    if (!座) return 发JSON(res, { 未入座: true, 我的座位: null, 入座: [null, null], 人齐: false, 热座: false, players: [] });
    return 发JSON(res, 视图(座.房, 视图座位(座)));
  }

  if (req.method === 'GET' && u === '/api/events') {
    const 令牌 = new URL(req.url ?? '/', 'http://x').searchParams.get('令牌');
    const 座 = 找座位(令牌);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');
    const 记 = 座 ? { res, 房: 座.房, 座位: 视图座位(座), 令牌 } : { res, 房: null, 座位: null, 令牌: null };
    推送表.add(记);
    const 心跳 = setInterval(() => { try { res.write(':ping\n\n'); } catch {  } }, 20000);
    req.on('close', () => { clearInterval(心跳); 推送表.delete(记); });
    if (座) 推送(座.房);
    else { try { res.write('data: ' + JSON.stringify(房间列表视图()) + '\n\n'); } catch {  } }
    return;
  }
  if (req.method === 'GET' && u === '/api/房间') {
    return 发JSON(res, {
      ok: true,
      房间: [...房间表.values()].filter((x) => !x.热座).map((x) => ({
        号: x.号, 入座: 入座视图(x), 人齐: 人齐了(x), 回合: x.g ? x.g.turn : 0, 已开局: !!x.it,
        开着的: Date.now() - x.创建时间 < 6 * 3600 * 1000,
      })),
    });
  }
  if (req.method === 'GET' && u === '/api/pool') {
    const 座 = 找座位(new URL(req.url ?? '/', 'http://x').searchParams.get('令牌'));
    return 发JSON(res, { ok: true, 池: 池视图(座?.房) });
  }
  if (req.method === 'POST' && u === '/api/入座') return 收JSON(req, (体) => {

    if (体.热座) {

      const 房 = 取房间(undefined, { 热座: true });
      发牌并开局(房, 20250101);
      const 名 = String(体.名字 ?? '').trim().slice(0, 12) || '调试者';
      const 新: 座位 = { 令牌: 'TK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(), 名字: 名, 最后见到: Date.now() };
      令牌表.set(新.令牌, { 房, 座位: -1 });
      房.入座[0] = 新;
      记录(房.g, 名 + ' 进入热座调试（房间 ' + 房.号 + '）');
      return 发JSON(res, { ok: true, 令牌: 新.令牌, 房间: 房.号, 座位: -1, 热座: true, 入座: 入座视图(房) });
    }

    const 旧座 = 找座位(体.令牌);
    if (旧座) return 发JSON(res, { ok: true, 令牌: 体.令牌, 房间: 旧座.房.号, 座位: 旧座.座位, 入座: 入座视图(旧座.房) });
    if (口令 && String(体.口令 ?? '') !== 口令) {
      return 发JSON(res, { ok: false, 错误: '口令不对', 需要口令: true }, 403);
    }
    const 房 = 取房间(typeof 体.房间 === 'string' ? 体.房间 : undefined);
    if (房.废弃) return 发JSON(res, { ok: false, 错误: '这一局已经结束（有玩家在对局中离开），请新建房间' }, 400);
    if (!房.it) 房.it = 整局G(房.g);
    const 空 = 房.入座.findIndex((s) => s === null);
    if (空 < 0) return 发JSON(res, { ok: false, 错误: '座位已满（本局最多两人）' }, 400);
    const 名字 = String(体.名字 ?? '').trim().slice(0, 12) || ('玩家' + (空 + 1));
    const 新: 座位 = { 令牌: 'TK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(), 名字, 最后见到: Date.now() };
    房.入座[空] = 新;
    令牌表.set(新.令牌, { 房, 座位: 空 });
    推送大厅();
    改房(房, () => { });
    房.g.players[空]!.name = 名字;
    记录(房.g, 名字 + ' 入座（座位 ' + 空 + '）');
    return 发JSON(res, { ok: true, 令牌: 新.令牌, 房间: 房.号, 座位: 空, 入座: 入座视图(房) });
  });
  if (req.method === 'POST' && u === '/api/离座') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌);
    if (!座) return 发JSON(res, { ok: false, 错误: '这个令牌没有对应的座位' }, 400);
    const 房 = 座.房;
    const 名字 = 房.入座[座.座位]?.名字 ?? '（已离开）';
    if (房.已开始) {

      房.废弃 = true;
      记录(房.g, 名字 + ' 在对局中离座 —— 本局作废（房间 ' + 房.号 + '）');
    } else {
      记录(房.g, 名字 + ' 离座（房间 ' + 房.号 + '）');
    }
    房.入座[座.座位] = null;
    房.最后活动 = Date.now();
    令牌表.delete(String(体.令牌));
    return 发JSON(res, { ok: true, 入座: 入座视图(房), 作废: 房.废弃 });
  });
  if (req.method === 'GET' && u === '/api/覆盖度') return 发JSON(res, { ok: true, 关键词: 覆盖度() });
  if (req.method === 'POST' && u === '/api/decks') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌); const 房 = 座 ? 座.房 : null;
    if (!房) return 发JSON(res, { ok: false, 错误: '还没入座（没有令牌或令牌已失效）—— 先在大厅点「组牌／换牌」或「单人热座」' }, 400);

    const 侧 = 体.侧 === '甲' || 体.侧 === '乙' ? (体.侧 as '甲' | '乙') : null;
    if (!侧) return 发JSON(res, { ok: false, 错误: '没说要保存哪一组（侧 必须是 甲 或 乙）' }, 400);

    const 可改 = 座 && 座.座位 < 0 ? ['甲', '乙'] : 座 && 座.座位 === 0 ? ['甲'] : ['乙'];
    if (!座 || !可改.includes(侧)) return 发JSON(res, { ok: false, 错误: '你只能改自己那一组' }, 403);
    const 牌 = Array.isArray(体.牌) ? (体.牌 as string[]) : [];
    if (typeof 体.无限制 === 'boolean') 房.无限制组牌 = 体.无限制;
    const 校 = 校验牌组(牌, 房.无限制组牌);
    if (校.错误.length) return 发JSON(res, { ok: false, 错误: 校.错误, 校验: 校, 池: 池视图(房) }, 400);

    const 新牌 = 牌.map((id) => 卡池索引.get(id)).filter((x): x is CardDef => !!x);
    if (侧 === '甲') 房.甲 = 新牌; else 房.乙 = 新牌;
    房.最后活动 = Date.now();
    记录(房.g, 侧 + '组已更新（' + 房.甲.length + ' / ' + 房.乙.length + ' 张）—— 点「新开一局」生效');
    改房(房, () => { });
    发JSON(res, { ok: true, 侧, 校验: 校, 状态: 视图(房, 视图座位(座)), 池: 池视图(房) });
  });
  if (req.method === 'POST' && u === '/api/new') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌); const 房 = 座 ? 座.房 : null;
    if (!房) return 发JSON(res, { ok: false, 错误: '还没入座（没有令牌或令牌已失效）' }, 400);

    对局信息重开(房.号 ?? '');
    发牌并开局(房, Number(体.seed ?? (Date.now() % 100000)));
    房.准备 = [!!房.热座, !!房.热座];
    发JSON(res, 视图(房, 视图座位(座))); });

  if (req.method === 'POST' && u === '/api/准备') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌);
    if (!座) return 发JSON(res, { ok: false, 错误: '还没入座' }, 400);
    const 房 = 座.房;
    if (座.座位 < 0) return 发JSON(res, { ok: false, 错误: '热座不需要准备' }, 400);
    房.准备[座.座位] = !!体.准备;
    if (!房.已开始 && 都准备好了(房)) {
      发牌并开局(房, Date.now() % 100000);
      房.已开始 = true;
      记录(房.g, '双方都已准备 —— 开始对局（先手随机决定）');

      if (房.g.开局 && 房.g.players.every((x) => x.hand.length === 0)) 决定先手(房.g, Math.random() < 0.5 ? 0 : 1);
    }
    改房(房, () => { });
    发JSON(res, { ok: true, 状态: 视图(房, 视图座位(座)) });
  });
  if (req.method === 'POST' && u === '/api/ai') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌); const 房 = 座 ? 座.房 : null;
    if (!房) return 发JSON(res, { ok: false, 错误: '还没入座（没有令牌或令牌已失效）' }, 400);
    if (体.动作 === '设置') {
      if (Array.isArray(体.代理)) {
        房.AI代理 = [!!体.代理[0], !!体.代理[1]];
      }
      改房(房, () => { });
      return 发JSON(res, { ok: true, 状态: 视图(房, 视图座位(座)) });
    }
    return 发JSON(res, { ok: true, 状态: 视图(房, 视图座位(座)) });
  });
  if (req.method === 'POST' && u === '/api/action') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌);
    if (!座) return 发JSON(res, { ok: false, 错误: '还没入座（没有令牌或令牌已失效）' }, 400);
    const 房 = 座.房;

    const r = 应用(房, 体, 视图座位(座));
    if (!r.ok) return 发JSON(res, { ok: false, 错误: r.错误, 状态: 视图(房, 视图座位(座)) }, 400);
    return 发JSON(res, { ok: true, 状态: 视图(房, 视图座位(座)) });
  });
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

setInterval(() => {
  const 现在 = Date.now();
  for (const [号, 房] of 房间表) {
    const 都空了 = !房.入座[0] && !房.入座[1];
    const 都掉线 = 房.入座.every((s) => !在线(s));
    const 闲 = 现在 - 房.最后活动;
    const 该删 = (都空了 && 闲 > 0) || (房.废弃 && 都掉线 && 闲 > 2 * 60_000) || (都掉线 && 闲 > 10 * 60_000) || 闲 > 60 * 60_000;
    if (!该删) continue;
    房间表.delete(号);
    for (const [t, 记] of 令牌表) if (记.房 === 房) 令牌表.delete(t);
  }
}, 60_000).unref();

服务器.listen(端口, 主机, () => {
  console.log('');
  console.log('  阵面对决 · 对战服务器已启动');
  console.log('');
  for (const a of 可用地址()) {
    console.log('   ' + a.网卡.padEnd(10) + a.地址 + (a.网卡 === '本机' ? '' : '   ← 把这行发给对方'));
  }
  console.log('');
  if (主机 === '127.0.0.1') console.log('   只监听本机（配置里把「监听」改成「全部」才能让局域网连）');
  else console.log('   已监听全部网卡。局域网连不上时：检查 Windows 防火墙是否放行了 node。');
  if (口令) console.log('   已设置口令：入座时需要输入。');
  else if (主机 !== '127.0.0.1') console.log('   未设口令 —— 局域网/公网使用建议在「服务器配置.json」里设一个。');
  console.log('');
});
