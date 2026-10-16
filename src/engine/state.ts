import type { TargetSpec } from './types.js';
import type { CardType, Faction, 筛选, 层修改, CardDef, 阵地, SupportMap, Support, Selector, 事件名, 玩家动作, ReplacementSpec } from './types.js';

import { 有效控制器 } from './continuous.js';
import { 阵地顺序 } from './types.js';
export { 阵地顺序 };

export type Zone = '牌库' | '手牌' | '战场' | '墓地' | '堆叠' | '放逐区'

  | '暂存';

export const 阵地序号: Record<阵地, number> = {
  左边路: 0, 左侧翼: 1, 中路: 2, 右侧翼: 3, 右边路: 4,
};

const 镜像阵地: Record<阵地, 阵地> = {
  左边路: '右边路', 左侧翼: '右侧翼', 中路: '中路', 右侧翼: '左侧翼', 右边路: '左边路',
};
export function 相对阵地(s: 阵地 | null): 阵地 | null { return s == null ? null : 镜像阵地[s]; }

export function 相邻阵地(s: 阵地 | null): 阵地[] {
  if (s === null) return [];
  const i = 阵地序号[s];
  return [阵地顺序[i - 1], 阵地顺序[i + 1]].filter((x): x is 阵地 => x !== undefined);
}

export function 斜对阵地(s: 阵地 | null): 阵地[] {
  if (s === null) return [];
  const 对面 = 镜像阵地[s];
  const i = 阵地序号[对面];
  return [阵地顺序[i - 1], 阵地顺序[i + 1]].filter((x): x is 阵地 => x !== undefined);
}

export interface 开局状态 {
  起手牌数: number;

  调度张数: (number | null)[];
  已宣告: boolean[];
  已执行: boolean[];
}

export interface 连续载荷 {

  层?: 层修改;

  替代?: ReplacementSpec;
}

export interface 连续效应 {

  条件?: { 操作: string; 目标?: string };
  id: number;

  时间印记: number;
  来源: Obj | null;
  控制器: number;
  时长: '直到回合结束' | '直到游戏结束';

  范围?: Selector;
  载荷: 连续载荷;

  受锁定?: number[];

  指定?: number;
}

export interface Obj {
  uid: number;
  def: CardDef;

  owner: number;

  readonly 操控者: number;
  readonly 区域: Zone;
  readonly tapped: boolean;
  readonly 面: '明置' | '暗置';

  readonly damage: number;

  readonly 阵地: 阵地 | null;

  readonly sick: boolean;

  readonly 时间印记: number;

  readonly 标记: readonly { 类型: string; 数量: number; 时间印记: number }[];

  是指示物?: boolean;

  readonly 佩带在?: number;

  readonly 附属在?: number;

  readonly 记忆: Record<string, unknown>;
}

export interface PlayerState {
  index: number;
  name: string;
  体力: number;
  lifeMax: number;
  library: Obj[];
  hand: Obj[];
  graveyard: Obj[];

  阵地: Record<阵地, Obj | null>;

  限制: { 禁止: 玩家动作; 筛选?: 筛选; 到期: number }[];
  landsPlayedThisTurn: number;

  drewFromEmptyLibrary: boolean;

  跳过: Record<string, number>;

  标记: Record<string, number>;

  统帅区: Obj[];
}

export interface StackItem {

  待放战场?: Obj[];

  待放战场控?: number;
  id: number;
  种类: '令符' | '触发式' | '启动式';
  标签: string;
  操控者: number;
  来源: Obj | null;
  card: Obj | null;

  目标: (Obj | number | { 堆叠项: number })[];
  目标槽?: Record<string, Obj | number | { 堆叠项: number }>;

  本次选择?: (Obj | number | string)[];

  本次支付源?: number[];

  待定目标?: TargetSpec[];
  chosenSlot?: 阵地;

  宣告X?: number;

  触发受方?: number | Obj;

  额外牺牲?: Obj;

  能力名?: string;

  死者位置?: 阵地 | null;
  chosenMode?: number;

  观星已问顶?: boolean;
  观星已问底?: boolean;
  可选?: boolean;
  steps: import('./types.js').ResolveStep[];

  暂存?: Obj[];

  步骤游标?: number;

  已开始?: boolean;

    上一步生效?: boolean;
    待选择?:
      | {
          类型: '搜寻';
          标签: string;
          区域: string;
          数量: number;

          可放弃: boolean;

          候选: { uid: number; 名称: string }[];
          查看?: { uid: number; 名称: string }[];

          玩家?: number;
          去处?: string;
        }

      | {
          类型: '选';

          选什么: '物件' | '选项' | '阵地';
          标签: string; 玩家: number;

          候选: { 键: number | string; 名称: string; 区?: string }[];
          数量: { 最小: number; 最大: number };

          等双方确认?: boolean;

          查看?: { 键: number | string; 名称: string }[];
        }

      ;

  declined?: boolean;

  decided?: boolean;

  触发量?: number;
}

export interface TempEffect {

  时间印记?: number;
  种类: '加成';
  target: Obj;
  武力: number;
  体力上限: number;
  expires: '直到回合结束';
}

export interface GameState {

  readonly 战场: readonly Obj[];
  players: PlayerState[];
  active: number;

  readonly stack: readonly StackItem[];

  守望: {
    事件: import('./types.js').事件名;
    步骤?: string; 阶段?: string;

    操控者?: number;

    时长: '直到回合结束' | '下一次';

    谁的: number;

    能力: import('./types.js').TriggeredAbility;

    来源?: Obj | null;
    标签: string;
  }[];
  pending: {

    id?: number;
    来源: Obj; abilityIndex: number; 标签: string; 触发量?: number;

    触发受方?: number | Obj;

    能力?: import('./types.js').TriggeredAbility;

    允许离场?: boolean;

    死者位置?: 阵地 | null;

    预选?: { 目标: (Obj | number)[]; 目标槽: Record<string, Obj | number> };
  }[];
  readonly tempEffects: readonly TempEffect[];

  readonly 连续效应: readonly 连续效应[];
  turn: number;
  log: string[];
  nextUid: number;
  nextStackId: number;

  nextPendingId: number;
  nextStamp: number;

  当前步骤: string;

  战斗中: boolean;

  放逐区: Obj[];

  可见登记: readonly { 玩家: number; uid: number }[];

  待问?: {
    玩家: number;
    类型: '选';
    标签: string;

    候选: { 键: number; 名称?: string }[];
    数量: { 最小: number; 最大: number };

    回答?: number[];
  };

  先手玩家: number;

  开局: 开局状态 | null;

  随机源: () => number;

  readonly 事件记录: readonly { 回合: number; 步骤: string; 事件: 事件名; 来源?: number; 受方?: number; 数量?: number }[];

  状态版本?: number;
  over: boolean;
  winner: number | null;
}

type 可写<T> = { -readonly [K in keyof T]: T[K] };
const 写 = <T>(x: T): 可写<T> => x as 可写<T>;

const 表 = <T>(x: readonly T[]): T[] => x as T[];

export function 盖章(g: GameState): void { g.状态版本 = (g.状态版本 ?? 0) + 1; }

export function 写面(g: GameState, o: Obj, 面: Obj['面']): void { 写(o).面 = 面; 盖章(g); }
export function 写横置(g: GameState, o: Obj, 值: boolean): void { 写(o).tapped = 值; 盖章(g); }
export function 写阵地(g: GameState, o: Obj, 阵地: Obj['阵地']): void { 写(o).阵地 = 阵地; 盖章(g); }
export function 写区域(g: GameState, o: Obj, 区域: Obj['区域']): void { 写(o).区域 = 区域; 盖章(g); }
export function 写操控者(g: GameState, o: Obj, p: number): void { 写(o).操控者 = p; 盖章(g); }
export function 写整备(g: GameState, o: Obj, 值: boolean): void { 写(o).sick = 值; 盖章(g); }
export function 写伤害(g: GameState, o: Obj, 值: number): void { 写(o).damage = 值; 盖章(g); }
export function 写附属在(g: GameState, o: Obj, uid: number | undefined): void { 写(o).附属在 = uid; 盖章(g); }
export function 写佩带在(g: GameState, o: Obj, uid: number | undefined): void { 写(o).佩带在 = uid; 盖章(g); }
export function 写时间印记(g: GameState, o: Obj, n: number): void { 写(o).时间印记 = n; 盖章(g); }

export function 加标记(g: GameState, o: Obj, 标记: { 类型: string; 数量: number; 时间印记: number }): void {
  写(o).标记 = [...o.标记, 标记]; 盖章(g);
}
export function 写标记表(g: GameState, o: Obj, 表: readonly { 类型: string; 数量: number; 时间印记: number }[]): void {
  写(o).标记 = 表 as { 类型: string; 数量: number; 时间印记: number }[]; 盖章(g);
}
export function 清标记(g: GameState, o: Obj): void { 写(o).标记 = []; 盖章(g); }

export function 改标记(g: GameState, 标记: { 数量?: number; 时间印记?: number }, 改: { 数量?: number; 时间印记?: number }): void {
  if (改.数量 !== undefined) 写(标记).数量 = 改.数量;
  if (改.时间印记 !== undefined) 写(标记).时间印记 = 改.时间印记;
  盖章(g);
}
export function 改标记数量(g: GameState, 标记: { 数量: number }, 数量: number): void {
  写(标记).数量 = 数量; 盖章(g);
}

export function 写记忆(g: GameState, o: Obj, 键: string, 值: unknown): void { 写(o).记忆[键] = 值; 盖章(g); }
export function 清记忆(g: GameState, o: Obj): void { 写(o).记忆 = {}; 盖章(g); }

export function 战场加(g: GameState, o: Obj): void { 表(g.战场).push(o); 盖章(g); }
export function 战场删(g: GameState, o: Obj): void {
  const i = g.战场.indexOf(o);
  if (i >= 0) { 表(g.战场).splice(i, 1); 盖章(g); }
}
export function 写战场(g: GameState, 表: readonly Obj[]): void { 写(g).战场 = 表 as Obj[]; 盖章(g); }
export function 加连续效应(g: GameState, e: 连续效应): void { 表(g.连续效应).push(e); 盖章(g); }
export function 写连续效应(g: GameState, 表: readonly 连续效应[]): void { 写(g).连续效应 = 表 as 连续效应[]; 盖章(g); }
export function 加临时效应(g: GameState, e: TempEffect): void { 表(g.tempEffects).push(e); 盖章(g); }
export function 写临时效应(g: GameState, 表: readonly TempEffect[]): void { 写(g).tempEffects = 表 as TempEffect[]; 盖章(g); }
export function 加事件记录(g: GameState, e: GameState['事件记录'][number]): void { 表(g.事件记录).push(e); 盖章(g); }
export function 写事件记录(g: GameState, 表: readonly GameState['事件记录'][number][]): void {
  写(g).事件记录 = 表 as GameState['事件记录'][number][]; 盖章(g);
}

export function 堆叠加(g: GameState, item: StackItem): void { 表(g.stack).push(item); 盖章(g); }
export function 堆叠弹出(g: GameState): StackItem | undefined { const x = 表(g.stack).pop(); 盖章(g); return x; }
export function 堆叠取第(g: GameState, i: number): StackItem | undefined {
  const [x] = 表(g.stack).splice(i, 1); 盖章(g); return x;
}

export function 清检视(g: GameState, 玩家?: number): void {
  写(g).可见登记 = (玩家 === undefined
    ? []
    : g.可见登记.filter((x) => x.玩家 !== 玩家)) as { 玩家: number; uid: number }[];
  盖章(g);
}
export function 登记检视表(g: GameState, 玩家: number, uid: number): void {
  if (!g.可见登记.some((x) => x.玩家 === 玩家 && x.uid === uid)) {
    表(g.可见登记).push({ 玩家, uid });
    盖章(g);
  }
}

export function 势力支持度(g: GameState, p: number): SupportMap {
  const out: SupportMap = {};

  for (const o of g.战场) {
    if (有效控制器(g, o) !== p) continue;

    if (!o.def.类别.includes('领土') || o.面 !== '明置') continue;
    for (const [k, v] of Object.entries(o.def.势力支持 ?? {})) {
      out[k as Support] = (out[k as Support] ?? 0) + (v as number);
    }
  }
  return out;
}

export function 造对象(g: GameState, def: CardDef, owner: number, 区域: Zone): Obj {
  return {
    uid: g.nextUid++, def, owner, 操控者: owner, 区域,
    tapped: false, 面: '明置', damage: 0, 阵地: null, sick: false, 记忆: {},
    时间印记: g.nextStamp++, 标记: [],
  };
}

export function 盖时间印记(g: GameState, o: Obj): void {
  写时间印记(g, o, g.nextStamp++);
}

export function 盖时间印记翻面(g: GameState, o: Obj): void {
  if (o.区域 === '战场') 写时间印记(g, o, g.nextStamp++);
}

export function 移出阵地(g: GameState, o: Obj): void {
  写阵地(g, o, null);
}
