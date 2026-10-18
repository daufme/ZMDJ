/**
 * 引擎核心：回合流程、优先权、堆叠、支付、结算、状态动作、胜负
 * 本版范围：非战斗部分（回合流程 / 领土 / 单位进场与阵地 / 锦囊 / 触发式能力 / 状态动作 / 胜负）
 * 战斗流程另一步实现。
 */
import type { 事件名,
  CardDef, 阵地, Support, SupportMap, ResolveStep, Condition, Value,
  TargetSpec, Selector, TriggeredAbility, ActivatedAbility, ModeSpec, StaticAbility, RecipientRef, ReplacementSpec,
  指示物定义, 筛选, 规则限制, 自身限制, 费用修正,
  筛选属性, 筛选条件, Ability, 关键词能力 , 玩家动作, 玩家指向, Trigger } from './types.js';
import { 阵地顺序 } from './types.js';
import type { GameState, Obj, PlayerState, StackItem, TempEffect, Zone } from './state.js';
import { 势力支持度, 造对象, 相对阵地, 相邻阵地, 斜对阵地, 盖时间印记, 盖时间印记翻面, 盖章,
  写面, 写横置, 写阵地, 写区域, 写操控者, 写整备, 写伤害, 写附属在, 写佩带在, 写时间印记,
  加标记, 写标记表, 清标记, 改标记数量, 改标记, 写记忆, 清记忆,
  战场加, 战场删, 写战场, 加连续效应, 写连续效应, 加临时效应, 写临时效应, 加事件记录, 写事件记录,
  堆叠加, 堆叠弹出, 堆叠取第, 清检视, 登记检视表 } from './state.js';
import { 计算特征, 计算到层, 当前上限层, type 特征 as 特征类型, 符合选择器, 符合筛选, 无双名称, 关键词数值, 解析能力, 能解析, 记事件, 有效控制器 } from './continuous.js';
import { 费用点数值, 牌面费用值, 取费用行为, 支付费用 } from './费用.js';

export const 起始体力 = 30;
export const 手牌上限 = 7;

/**
 * **514.1 的弃牌步骤用的手牌上限** —— 基础 7，再叠加场上所有
 * 「手牌上限修正」（604 改变规则的持续性效应，例如 038 臧霸）。
 */
export function 手牌上限为(g: GameState, p: number): number {
  let n = 手牌上限;
  for (const o of g.战场) {
    if (o.面 !== '明置') continue;
    const 能 = 有效控制器(g, o);
    for (const ab of o.def.能力?.能力 ?? []) {
      // Ability 是联合类型 —— 用 in 收窄
      if (!('手牌上限修正' in ab) || !ab.手牌上限修正) continue;
      for (const m of ab.手牌上限修正) if ((m.适用 === '你') === (能 === p)) n += m.手牌上限;
    }
  }
  return Math.max(0, n);
}


/**
 * 一个可选目标。三种形态互斥：`obj`（牌）/ `玩家`（下标）/ `堆叠项`（能力的 StackItem.id）。
 * ⚠ 客户端只认 `uid` —— 能力的 uid 用**负数**（`-StackItem.id`），这样它既不撞实体的正 uid，
 *   也不撞玩家的 0/1。改动只在「列候选」和「收目标」两处，中间层可以原样传递。
 */
export interface 候选 { obj: Obj | null; 玩家: number | null; 堆叠项?: number }

/** 目标里「牌/实体」那一半 —— 玩家下标和堆叠项都返回 null */
export function 取实体(t: 目标 | undefined | null): Obj | null {
  if (t === undefined || t === null || typeof t === 'number') return null;
  return '堆叠项' in t ? null : t;
}
/** 目标里「堆叠项 id」那一半 —— 别的都返回 undefined */
export function 取堆叠项(t: 目标 | undefined | null): number | undefined {
  return t && typeof t === 'object' && '堆叠项' in t ? t.堆叠项 : undefined;
}

/**
 * 目标可以是三种东西：
 *   `Obj` —— 牌/实体（战场上的、堆叠上的令符、墓地里的…）
 *   `number` —— **玩家下标**（0/1）
 *   `{ 堆叠项: id }` —— **堆叠上的能力**（114.9：能力不是令符，没有牌可以指，只能按 StackItem.id 指）
 *
 * ⚠ 定义在这里而不是 types.ts —— 它要用 `Obj`（在 state.ts），放 types 会成环。
 *   state.ts 的 StackItem 需要它时**写内联联合**（见那边的注释）。
 */
export type 目标 = Obj | number | { 堆叠项: number };

/** 508.2e 的合法攻击对象 */
export type 攻击对象 =
  | { 种类: '玩家'; 玩家: number }
  | { 种类: '阵地'; 玩家: number; 阵地: 阵地 };

export type Action =
  | { 种类: '打领土'; card: Obj; 面: '明置' | '暗置' }
  /** 702.16 转移：特殊动作，把单位移到相邻空阵地 */
  | { 种类: '转移'; card: Obj; 到: 阵地; 路径?: '转移' | '许可' }
  /** 108.3a：费用带 {X} 时，X 由操控者在打出时选择并宣告 */
  | { 种类: '施放'; card: Obj; 目标: 目标[]; 阵地?: 阵地; 模式号?: number; X?: number; 支付源?: number[] ; 额外牺牲?: number[] }
  | { 种类: '发起战斗'; card: Obj; 目标: 攻击对象; /** 120 长江天险：进攻方自己选的支付源 ✓ */ 支付源?: number[] }
  // 602.1d：「→」前的弃牌/牺牲也是启动费用 —— 由玩家挑（和施放的支付源同一套槽）
  | { 种类: '启动能力'; card: Obj; 能力索引: number; 费用步进?: { 偏移: number; 步进: number }; 目标?: 目标[]; 支付源?: number[]; 模式号?: number; 费用弃牌?: number[]; 费用牺牲?: number[]; 费用弃牌数?: number; 费用牺牲数?: number; 费用X?: boolean; 宣告X?: number }   // 108.3a：费用里带 {X} 时，启动的玩家宣告的 X
  | { 种类: '宣告'; 模式?: number; 目标: { 目标名: string; 类型: '实体' | '玩家'; uid?: number; 玩家?: number }[] }
  // 弃牌/搜寻/开局：要选的牌 uid（选）；开局还用它带 先手 / 张数
  // ⚠ `选` 不只是 uid —— 选项类（'接受'）、阵地名（'左边路'）都是字符串（见 应用选择）
  | { 种类: '决定'; 接受: boolean; 弃牌?: number[]; 选?: (number | string)[]; 先手?: number; 张数?: number }
  | { 种类: '让过' };

/** 策略：给定局面返回一个动作，或 null 表示让过 */
export type 策略 = (g: GameState, p: number, opts: 时机选项) => Action | null;
export interface 时机选项 { 允许打领土: boolean; 允许通常时机: boolean }

// ── 基础工具 ─────────────────────────────────────────────────────
export function 记录(g: GameState, s: string): void { g.log.push('[T' + g.turn + '] ' + s); }

/** Fisher-Yates 洗牌。**返回新数组**，不改传进来的那个（调用方常常还要留着原顺序） */

export function 洗牌<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const t = a[i]!; a[i] = a[j]!; a[j] = t;
  }
  return a;
}

/**
 * 开一局。
 * 默认按 103 走完整开局流程（决定先手 → 洗牌 → 各抓七张 → 调度 → 后手看牌库顶）；
 * 传 { 自动开局: true } 则直接完成开局（AI / 批量对局用）。
 */
export function 新对局(牌组: CardDef[][], 随机: () => number, 选项?: { 自动开局?: boolean; 起手牌数?: number }): GameState {
  const 起手 = 选项?.起手牌数 ?? 起手牌数_默认;
  const g: GameState = {
    players: [], 战场: [], active: 0, stack: [], pending: [], tempEffects: [], 连续效应: [],
    守望: [],                 // 603.7：延迟触发能力的登记处（进战场 / 步骤开始时扫）
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
    // 103.2：各自洗牌，成为牌库
    for (const def of 洗牌(list, 随机)) p.library.push(造对象(g, def, i, '牌库'));
  });
  记录(g, '对局开始：双方体力 ' + 起始体力);
  // 两条路径都要有开局状态：决定先手 依赖它才会发手牌
  const 人数 = 牌组.length;
  g.开局 = {
    起手牌数: 起手,
    调度张数: Array.from({ length: 人数 }, () => null as number | null),
    已宣告: Array.from({ length: 人数 }, () => false),
    已执行: Array.from({ length: 人数 }, () => false),
  };
  if (选项?.自动开局 !== false) {      // 默认自动开局；界面传 false 才走 103 完整流程
    决定先手(g, 随机() < 0.5 ? 0 : 1);
    开局直接完成(g);
  }
  return g;
}

const 起手牌数_默认 = 7;

// ── 103 开局流程 ────────────────────────────────────────────────
//   ⚠ 这四个函数**只管改数据**，不管顺序 —— 谁先谁后由 开局流程G 的循环说了算。
//     以前它们各自查 `o.阶段`、各自推进 `o.待宣告` / `o.待选牌`，于是
//     「现在轮到谁」在状态里和请求里各有一份，查漏一处就静默什么都不做。

/** 103.1 / 103.4：定先手，然后每位玩家各抓七张。可以重复调用（发牌只发一次） */
export function 决定先手(g: GameState, 先手玩家: number): void {
  const o = g.开局;
  if (!o) return;
  g.先手玩家 = 先手玩家;
  g.active = 先手玩家;
  记录(g, '103.1：' + g.players[先手玩家]!.name + ' 成为先手');
  if (!o.已宣告.some((x) => x) && g.players.every((pl) => pl.hand.length === 0)) {
    // 103.4：每位玩家各抓七张（只在还没发牌时发）
    for (const pl of g.players) 抓牌(g, pl.index, o.起手牌数, true);
    记录(g, '103.4：双方各抓 ' + o.起手牌数 + ' 张起手牌');
  }
}

/** 103.4 前半：记「p 宣告调度 n 张」。**不负责推进顺序** */
export function 宣告调度(g: GameState, p: number, n: number): boolean {
  const o = g.开局;
  if (!o || o.已宣告[p]) return false;
  const pl = g.players[p]!;
  const 下限 = Math.max(0, o.起手牌数 - pl.hand.length);   // 103.4：起手不足七张时必须至少补足差额
  if (!Number.isInteger(n) || n < 下限 || n > pl.hand.length) return false;
  o.调度张数[p] = n;
  o.已宣告[p] = true;
  记录(g, pl.name + ' 宣告调度 ' + n + ' 张');
  return true;
}

/**
 * 103.4 后半：执行调度 —— 选出等同于宣告张数的手牌放到一边，
 * 抓回起手牌数，之后把这些牌洗入牌库（406.1：放一边时暂放在放逐区）。
 * **不负责推进顺序**。
 */
export function 执行调度(g: GameState, p: number, uids: number[]): boolean {
  const o = g.开局;
  if (!o || o.已执行[p]) return false;
  const pl = g.players[p]!;
  const n = o.调度张数[p] ?? 0;
  if (n === 0) { o.已执行[p] = true; return true; }          // 没宣告就没什么可执行
  if (uids.length !== n) return false;                       // 必须正好是宣告的张数
  const 暂放: Obj[] = [];
  for (const uid of uids) {
    const c = pl.hand.find((x) => x.uid === uid);
    if (!c) return false;
    暂放.push(c);
  }
  // 103.5：要调度的牌先放到一边（放逐区当暂存），抓回等量后再洗回牌库
  for (const c of 暂放) 移到区域(g, c, '放逐区');
  抓牌(g, p, o.起手牌数 - pl.hand.length, true);
  for (const c of 暂放) 移到区域(g, c, '牌库');
  pl.library = 洗牌(pl.library, g.随机源);                    // 洗入牌库
  记录(g, pl.name + ' 调度 ' + n + ' 张，抓回 ' + o.起手牌数 + ' 张后洗回牌库');
  o.已执行[p] = true;
  return true;
}

/**
 * **701.17a 的「检视」本体** —— 把某个（些）玩家某个区域里的牌**看一遍**。
 *
 * ⚠ 规则把两者的关系写得很死：
 *   「在一个区域中**搜寻**一张牌是指：**检视**在该区域中的**所有牌**，
 *     并找到一张符合所赋予描述的牌。」
 *   → **搜寻 = 检视 + 挑一张**，所以是**搜寻调用检视**。反过来（把检视写成
 *     「数量为 0 的搜寻」）是同一个关系的第二种写法，也会让「谁包含谁」看不出来。
 *
 * 做三件事：① 登记可见性（401/402，服务端按它发牌）② 写一条**不记牌名**的日志
 *   ③ 把那些牌交回去。
 * ⚠ 日志**不能写牌名** —— 日志是所有人可见的，检视就是靠「只有你看得见」才有意义。
 */
function 检视区域(g: GameState, 看的人: number, 玩家们: number[],
  哪个区域: '手牌' | '牌库顶' | '牌库' | '墓地' | '放逐区' | '战场',
  只看顶几张?: number): { 牌: Obj[]; 谁们的: string[] } {
  // ⚠ **一次检视 = 一份登记** ✓：先把这个人**上一次**的检视登记清掉 ✓（用户的定案：
  //   检视不是规则动作、没有时效 ✓ → 不建模"持续多久" ✗，而是"下一次用时先清空再放" ✓）。
  //   不清的后果就是老 bug：`可见登记` 只增不减 ✗ → 客户端那块检视容器一直堆着旧牌 ✓。
  清检视(g);   // 整个表从空开始填 ✓（按人清会留下另一个座位的 ✗）
  const 牌: Obj[] = [];
  const 谁们的: string[] = [];
  for (const p of 玩家们) {
    const pl = g.players[p]!;
    const 堆 = 哪个区域 === '手牌' ? pl.hand
      // ★ 取顶部牌**默认顶在前** ✓（库顶 = 数组末尾 1559，所以取完要 reverse 成"顶 → 底"）
      //   看整库（只看顶几张 === undefined）同样按"顶 → 底"返回 ✓
      : 哪个区域 === '牌库' ? (只看顶几张 === undefined ? [...pl.library].reverse() : pl.library.slice(-只看顶几张).reverse())
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
/**
 * 让某个玩家**检视**某张牌（登记可见性）。
 * 401/402：隐藏区的牌只有登记过的玩家看得到 —— 服务端发牌时按这个放行。
 */
export function 登记检视(g: GameState, 玩家: number, o: Obj): void {
  登记检视表(g, 玩家, o.uid);
}

/**
 * 103.6：**后手决定**其牌库顶牌的去向（留在牌库顶 / 置于牌库底）。
 * ⚠ 这里**不做检视** —— 检视是通用的 检视 操作（见 登记检视），103.6 只是「看过之后做个决定」。
 *   以前这个函数叫 后手看牌库顶、并把牌塞进 开局.顶牌 —— 那是**另一套可见性机制**，已删。
 */
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

/** 把开局流程直接走完（AI / 批量对局）：发牌 + 记「都宣告 0 张」，然后丢掉开局状态 */
export function 开局直接完成(g: GameState): void {
  const o = g.开局;
  if (!o) return;
  if (g.players.every((pl) => pl.hand.length === 0)) {
    for (const pl of g.players) 抓牌(g, pl.index, o.起手牌数, true);
  }
  for (const pl of g.players) { o.调度张数[pl.index] = 0; o.已宣告[pl.index] = true; o.已执行[pl.index] = true; }
  g.开局 = null;
}

/**
 * **104 抓牌**。`起始` = 起手牌（103.4）—— 起手牌不触发「当某玩家抓牌时」那类触发。
 * 牌库空还抓 = 704.5b 判负，所以它自己会检查，不靠调用方。
 */

export function 抓牌(g: GameState, p: number, n: number, 起始: boolean = false): void {
  const pl = g.players[p]!;
  let 实抓 = 0;
  for (let i = 0; i < n; i++) {
    if (pl.library.length === 0) {
      // 104.3c / 704.5b：抓不到牌则输掉
      pl.drewFromEmptyLibrary = true;
      if (!起始) 记录(g, pl.name + ' 试图从空牌库抓牌');
      break;
    }
    const card = pl.library[pl.library.length - 1]!;
    移到区域(g, card, '手牌');   // 400.7：从牌库顶拿到手上
    实抓++;
      // ★ 121.2：牌每次只能抓一张 → 抓 N 张 = N 次单独的抓牌动作（N 次「抓牌」事件 + N 次触发）
      //   （官例：无中生有抓两张 → 徐夫人触发 2 次）以前只在循环外记一次 ✗
      if (!起始) { 记事件(g, '抓牌', { 受方: p, 数量: 1 }); 排队事件触发(g, '抓牌', p); }
  }
  if (!起始 && 实抓 > 0) 记录(g, pl.name + ' 抓 ' + 实抓 + ' 张牌');
}

// ── 有效特征：全部走 613 的层系统 ────────────────────────────────
/** 613：算出这个物件的当前特征（含所有持续性效应与标记） */
// ── 关键词：引擎**按规则书的字面**查名字 ──
//    规则书写「受到具有**致命**能力之来源的伤害」（704.5e），引擎这里就问 '致命'。
//    名字由 702 章定义，卡面用 能力.能力 里的 { 种类:…, 名称:'致命' } 表达。

/** 704.5e「具有致命能力之来源」/ 702.46b「具有据守能力」/ 702.3b「具有洞察」… —— 有没有这个关键词 */
/**
/**
 * **带「特征」参数的关键词**：读出它的 特征 筛选（702.2 抵抗 / 702.5 附属）。
 * 「万物抵抗」（702.2d）写成**没有 特征**的抵抗 —— 对每个物件都成立（返回 undefined）。
 *
 * ⚠ 来源是 `特征.关键词`（和 `有词` / `词值` 同一个出处）—— 印制的和层6 授予的都在里面。
 *   以前这里直接扫 `o.def.能力`，那是同一事实的第二个出处，后果是**层6 授予的抵抗读不到**
 *   （154 讨贼先锋·皇甫嵩那种「把带筛选的抵抗授予别的单位」）。
 *   ⚠ 所以要 `g` —— 别拿掉（`有效特征` 需要它）。
 */
export function 关键词特征(g: GameState, o: Obj, 名称: string): 筛选 | undefined {
  for (const k of 有效特征(g, o).关键词) if (k.名称 === 名称) return k.特征;
  return undefined;
}
/** 这个实体有没有这条带特征的关键词（用来区分「写了特征」和「万物 XX」） */
export function 有带特征的关键词(g: GameState, o: Obj, 名称: string): boolean {
  return 有效特征(g, o).关键词.some((k) => k.名称 === 名称);
}

/**
 * **702.2b** 具有某<特征>抵抗的实体不能成为**具所述特性令符**之目标，或**来源为该特性的能力**之目标。
 * 来源的特性 = 那个令符（或能力来源物件）的牌面特征。没有 特征 的抵抗 = 702.2d「万物抵抗」。
 */
export function 抵抗挡得住目标(g: GameState, o: Obj, 来源: Obj | null): boolean {
  if (!有带特征的关键词(g, o, '抵抗')) return false;
  const 特 = 关键词特征(g, o, '抵抗');
  if (!特) return true;                       // 702.2d 万物抵抗
  if (!来源) return false;
  return 符合筛选(g, 来源, 特, 有效特征(g, 来源));
}
/**
 * **702.2c** 如果将对具有抵抗的实体造成的伤害，其**来源具有所述特性**，则此伤害会被**防止**。
 */
export function 抵抗挡住伤害(g: GameState, o: Obj, 来源: Obj | null): boolean {
  return 抵抗挡得住目标(g, o, 来源);
}

/**
 * 702.1d：这个物件**有没有**某个关键词能力。
 * ⚠ 数据只有**一个**来源：`特征.关键词`（印制的和层 6 授予的都在里面）。
 *   不要另外去扫 `o.def.能力` —— 那是同一事实的第二个出处，两边迟早不一致。
 */

export function 有词(g: GameState, o: Obj, 名称: string): boolean {
  // 702.1d：这个物件**有没有**某个关键词能力。
  //   ⚠ 只有**一个**来源：`特征.关键词` —— 牌面印制的（基础特征从 o.def.能力 里派生）
  //     和层6 授予的都在里面。以前这里还先扫一遍 o.def.能力，那是同一事实的第二个出处，
  //     已经跟着关键词系统一起收掉了。
  const f = 有效特征(g, o);
  if (f.失去所有能力) return false;
      // ⚠ 印制和层6 授予**同一种形状**（`{ 名称, 数值? }`），所以只看名称对不对得上。
      //   以前层6 写的是 `'坚韧2'` 这种字符串，这里得剥尾巴才能回答「有没有坚韧」——
      //   那正是「同一事实两种写法」的代价，已经统一掉了。
      //   （要**数值**时用 词值()，这里只回答「有没有」。）
      return f.关键词.some((k) => k.名称 === 名称);
}

/** 带数值的关键词（702.6「坚韧 N」这种写作「坚韧2」）—— 返回数值，没有则为 0 */
/**
 * **带数值的关键词的值**（702.6「坚韧 N」/ 702.10「射击 N」/ 702.13「迎击 N」…）。取不到就是 0。
 *
 * ⚠ **只有一个来源：`特征.关键词`**（和 `有词` 同一个出处）。
 *   牌面印制的由基础特征从 `o.def.能力` 派生进来（见 continuous.ts 的 基础特征），
 *   层6 授予的也进来 —— 两边**合并、不去重**。
 *
 * ⚠ 以前这里先扫一遍 `o.def.能力`，那是同一事实的第二个出处 —— 后果是
 *   **层6 授予的数值读不到**：【魏方阵兵团】的「只要是在对手的回合中便具有坚韧2」
 *   是授予出来的，于是 702.6 的防止永远拿到 0，坚韧形同虚设。
 *   `有词` 早就统一到单一出处了，`词值` 当时漏了。
 *
 * ⚠ 数值写在**名字的尾巴上**（`'坚韧2'`），所以比较前缀之后要把剩下的解析成数字；
 *   702.1d 那种「具有<基名>能力」的检查用 `有词`，它自己会剥掉尾巴。
 */
export function 词值(g: GameState, o: Obj, 名称: string): number {
  // 印制和层6 授予现在是**同一种形状**（`{ 名称, 数值? }`，见 关键词能力条目），
  //   所以这里只看名字对不对得上、数值有没有给。
  for (const k of 有效特征(g, o).关键词) {
    if (k.名称 === 名称) return k.数值 ?? 0;
  }
  return 0;
}

export function 带词(g: GameState, o: Obj, 名称: string): boolean {
  return 词值(g, o, 名称) > 0 || 有词(g, o, 名称);
}
/**
 * **算完 613 全部层之后的特征** —— 判断牌面特征一律用它，不要直接读 `o.def`。
 * 条件里的「你」按**有效操控者**算（被【降服】拿走的单位，它的「由你操控的…」要跟新主人）。
 */

export function 有效特征(g: GameState, o: Obj): 特征类型 {
  // 条件里的「你」= **有效操控者**（613.1b 层 2 之后的）—— 被【降服】拿走的单位，
  //   它的「由你操控的…」要按新的操控者算
  //
  // ⚠ **嵌套查询只折叠到「当前层」** ✓（`当前上限层()`，613 的层拓扑序 ✓）：
  //   正在算层 L 时，条件里问别的物件只允许看到 ≤ L 层 ✓。
  //   这既让层序是对的 ✓，又让环**有界** ✓（跨层严格递减 ✓；同层环由 `算特征中` 兜 ✓）。
  //   原来是"嵌套就不求值"✗（`算特征深度 === 1 ? 判断 : undefined`）——
  //   那等于**深层条件静默按「不拦」处理** ✗，规则结果是错的 ✓。
  return 计算到层(g, o, 当前上限层(), (c) => 判断(g, 有效控制器(g, o), c as Condition, o));
}
/** 302.5b/c：不在战场上时灵值等于印制值；在战场上时等于其上的灵值标记数量 */
export function 灵值(g: GameState, o: Obj): number {
  if (o.区域 !== '战场') return o.def.灵值 ?? 0;
  return o.标记.filter((m) => m.类型 === '灵值').reduce((s, m) => s + m.数量, 0);
}
/**
 * 战力。**702.32 压制 X**：「此单位的**相对单位** -X 武力」——
 * 所以要在算自己的武力时，去看**对面阵地那个单位**有没有压制。
 * TODO：严格说这是 613 层7c 的持续性效应，应该进 计算特征；现在挂在取值处，
 *       暂时够用（压制来源被消灭/暗置时行为也对，因为每次都重算）。
 */
export function 武力(g: GameState, o: Obj): number {
  let v = 有效特征(g, o).武力;
  // 702.32b 压制 X 是指：「此单位的**相对单位** -X 武力。」
  // 702.32b：压制看的是**相对单位** —— 阵地外单位没有相对阵地，自然吃不到压制
  if (o.阵地) {
    const 对面 = g.players[1 - 有效控制器(g, o)]?.阵地[相对阵地(o.阵地)!];
    if (对面 && 对面 !== o) v -= 词值(g, 对面, '压制');
  }
  return v;                                  // 允许为负：613.7c 可以有负武力；造成伤害时按 >0 判
}
/** 层 7 之后的体力上限（会算上 +N/+N、-N/-N 和设定值） */

export function 体力上限(g: GameState, o: Obj): number { return 有效特征(g, o).体力上限; }
/** 层4 生效后的牌类别判断 */
export function 是类别(g: GameState, o: Obj, 类别: string): boolean {
  return 有效特征(g, o).类别.includes(类别 as never);
}

/**
 * 604：这个玩家现在是否被某条「改变游戏规则的限制」挡住某个动作。
 * 限制来源必须在场上且有规则叙述（709.2a：暗置的实体不产生任何效应）。
 */
/**
 * **牌面写给「它自己」的行为限制**（静止式.自身限制）—— 「此单位不能发起战斗」这类。
 *   ⚠ 709.2a：暗置的实体不产生任何效应，所以只在明置时作数。
 *   ⚠ 只看**印制**的能力（这是印在牌上的静止式，不是层 6 授予的关键词）。
 */
/** 146 盲兵：「…若能发起战斗则必须发起战斗」—— 和 自身限制 相反的那一类静止式 */
export function 有必须发起战斗(g: GameState, o: Obj): boolean {
  if (o.面 === '暗置') return false;                       // 709.2a：暗置没有规则叙述
  return ((o.def.能力?.能力 ?? []) as StaticAbility[]).some((ab) => ab.必须发起战斗 === true);
}
export function 有自身限制(g: GameState, o: Obj, 哪种: 自身限制): boolean {
  if (o.面 === '暗置') return false;
  return ((o.def.能力?.能力 ?? []) as StaticAbility[]).some((ab) => (ab.自身限制 ?? []).includes(哪种));
}
export function 有限制(g: GameState, p: number, 禁止: 规则限制['禁止']): boolean {
  // 604：规则限制的来源是**这个玩家操控的**场上物件 —— 操控权可能被层 2 改过，用有效控制器
  for (const o of g.战场) {
    if (有效控制器(g, o) !== p) continue;
    if (!有规则叙述(g, o)) continue;
    // 604：规则限制是**静止式能力**，写在 能力.能力 里
    const 全部 = ((o.def.能力?.能力 ?? []) as StaticAbility[]).flatMap((ab) => ab.规则限制 ?? []);
    for (const r of 全部) {
      if (r.禁止 === 禁止 && (r.适用 !== '你' || o.操控者 === p)) return true;
    }
  }
  return false;
}

/**
 * 709.2a：暗置的实体**没有任何规则叙述**（所以它的触发式/启动式/静止式能力都不存在）。
 * 层6 的「失去所有能力」同理。
 * 所有「读 o.def.能力 拿能力」的地方都要先过这一关。
 */
export function 有规则叙述(g: GameState, o: Obj): boolean {
  if (o.区域 !== '战场') return true;          // 709.2a 只管战场上的实体
  if (o.面 === '暗置') return false;
  return !有效特征(g, o).失去所有能力;          // 层6
}

/**
 * **「当…明置/暗置时」的触发**（701.11）。受方 = 那个**面变了**的物件。
 *
 * 「**你**将一张基本领土暗置时」里的「你」= **做这个动作的玩家**（施动者），
 * 不是「那个物件的操控者」—— 两者可能不同（例如替对手暗置他的领土）。
 */
export function 排队面触发(g: GameState, o: Obj, 面: '明置' | '暗置', 施动者: number, 变化前: 特征类型): void {
  // ⚠ 走通用广播 ✓（以前自己扫一遍 ✗，只按「操控者===施动者」✗）。
  //   「当你将一张**基本领土**暗置时」判的是**变化之前**的特征 ✓（709.2a ✓）——所以传 特征覆盖 ✓。
  void 施动者;
  排队单位事件触发(g, 面, o, { 触发受方: o, 特征覆盖: 变化前 });
}
/**
 * 701.11：**明置 / 暗置的唯一入口**。
 *
 * ⚠ 所有让 `o.面` 改变的地方**都必须走这里**。为什么必须集中：
 *   · 603.2g：这类触发「只在这个事件真的发生时」触发 —— 面没变就不触发；
 *   · 701.11e / 701.27g：旧牌面把明置/暗置印成「翻面」「翻为面朝上/下」，
 *     于是同一个动作有好几个入口。以前那三个入口各自直接改 `o.面`，
 *     谁都不记事件、不排队 —— 「当…明置/暗置时」的能力**永远不会触发**。
 *
 * 返回 true = 面真的变了。
 */
export function 设面(g: GameState, o: Obj, 面: '明置' | '暗置', 施动者?: number): boolean {
  if (o.面 === 面) return false;               // 603.2g / 709.2b：没真的变 → 不触发
  // ⚠ **先把「变化前」的样子算出来**：明置/暗置的触发要按**动作发生那一刻**判。
  //   「当你将一张基本领土暗置时」—— 对象那时**还是**基本领土；
  //   暗置之后它才成为「暗置领土」（709.2a），名称/副类别/势力支持/超类别都没了。
  const 变化前 = 有效特征(g, o);
  const 谁 = 施动者 ?? 有效控制器(g, o);
  写面(g, o, 面);
  记录(g, o.def.全名 + ' 被' + 面);
  记事件(g, 面, { 受方: o.uid });
  排队面触发(g, o, 面, 谁, 变化前);
  return true;
}


/** 有没有这个关键词（含带数值的写法） */


// ── 107.4 势力需求 ───────────────────────────────────────────────
export function 满足势力需求(g: GameState, p: number, req: { 符号: SupportMap; 混色?: { a: Support; b: Support }[] } | undefined): boolean {
  if (!req) return true;
  const sup = 势力支持度(g, p);
  const need: SupportMap = {};
  for (const [k, v] of Object.entries(req.符号)) need[k as Support] = v as number;
  const 混色 = req.混色 ?? [];
  // 混合符号：对每种指派组合检查是否有解（107.1b / 107.4）
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

// ── 118 / 304.8 / 605 支付数字费用 ───────────────────────────────
interface 费用来源 { obj: Obj; 提供: number; 牺牲: boolean }

/** 这个玩家现在能拿来付钱的**费用来源**：304.8 的固有 {1} + 场上那些费用能力 */
function 收集费用来源(g: GameState, p: number): 费用来源[] {
  const out: 费用来源[] = [];
  for (const o of g.战场) {
    if (有效控制器(g, o) !== p) continue;
    if (!是类别(g, o, '领土') || o.tapped || o.区域 !== '战场') continue;
    // ⚠ 暗置领土**照样能提供费用** ——
    //   304.8 的「{付费}{横置}→提供{1}」是**规则赋予领土的固有能力**，不是卡面的「规则描述」；
    //   709.2a 抹掉的是「规则描述、名称、势力支持、副类别」，**没抹掉类别**，
    //   而 304.4b 说暗置打出的牌「进战场后是一个暗置的**领土**」—— 它仍是领土，所以仍然有 304.8。
    //   另：202.1b 只挡**势力支持**（「暗置领土不具有任何势力支持」），从没提费用 —— 两套资源。
    //   卡面印出来的费用能力才算「规则描述」（本函数里收集它的那个循环），那个暗置时确实没有。
    // 304.8 固有能力：{付费}{横置}->提供{1}
    out.push({ obj: o, 提供: 1, 牺牲: false });
    // 卡面印出的费用能力（例如山民流营：{付费}{横置}，牺牲此领土->提供{2}）
    for (const ab of (o.def.能力?.能力 ?? []) as ActivatedAbility[]) {
      // 605.4 / 304.8：「提供{N}」是费用行为列表里的一条，不是能力上的独立字段
      const 提 = 取费用行为(ab.费用, '提供');
      if (ab.种类 === '启动式' && ab.是费用能力 && 提 && 取费用行为(ab.费用, '横置')) {
        out.push({ obj: o, 提供: 提.点数, 牺牲: !!取费用行为(ab.费用, '牺牲自身') });
      }
    }
  }
  return out;
}

/** 118.3：费用必须全额支付，不能只付一部分 */
/**
 * 118.3a：支付数字费用是**通过启动费用能力**完成的（304.8：领土的「{付费}{横置}→提供{1}」）。
 * 118.2：支付费用的玩家**有机会启动费用能力** —— 也就是由他自己挑启动哪些，所以这里支持手动指定。
 * @param 指定 玩家挑的来源 uid（可以多给，只启动刚好够的那些）。不给则自动挑。
 */
export function 支付数字费用(g: GameState, p: number, 点数: number, 指定?: number[]): boolean {
  if (点数 <= 0) return true;
  const 来源 = 收集费用来源(g, p);
  if (指定) {
    // ⚠ **按 uid 去重** ✓ —— 同一块地只能在这里提供一次 ✓（否则 [A,A,A,A] 就能付 4 点 ✗）。
    //   注意：这只管「支付源」自己 ✓ —— 「费用牺牲」是**另一个参数** ✓，
    //   所以「同一块地既被牺牲、又拿来支付」照旧成立 ✓（两个槽允许重叠 ✓）。
    const 挑: 费用来源[] = [];
    const 见过 = new Set<number>();
    for (const uid of 指定) {
      if (见过.has(uid)) continue;              // ★ 同一块地只算一次 ✓
      见过.add(uid);
      const s2 = 来源.find((x) => x.obj.uid === uid);
      if (s2) 挑.push(s2);
    }
    const 够 = 挑.reduce((n, s) => n + s.提供, 0);
    if (够 < 点数) {
      记录(g, '支付失败：挑了 ' + 挑.length + ' 个来源，只能提供 ' + 够 + '，需要 ' + 点数 + '（118.3 必须全额支付）');
      return false;
    }
    // 只启动**刚好够**的那些，多挑的留着不横置
    const 用: 费用来源[] = []; let acc = 0;
    for (const s of 挑) { if (acc >= 点数) break; 用.push(s); acc += s.提供; }
    for (const s of 用) { 写横置(g, s.obj, true); if (s.牺牲) 牺牲(g, s.obj); }
    return true;
  }
  // 数字费用一律由玩家手动指定来源（118.3）—— **没有自动挑**。
  // 不给 指定 = 没挑地 = 付不出来。
  记录(g, '支付失败：这张牌要付 ' + 点数 + ' 点数字费用，请先挑要启动的领土（304.8）');
  return false;
}

/** 预判能否付得起（逻辑与 支付数字费用 一致，但不实际支付） */
/** 现在可以启动哪些费用能力（界面拿它让玩家挑地） */
export function 可支付来源(g: GameState, p: number): { uid: number; 名称: string; 提供: number; 牺牲: boolean }[] {
  return 收集费用来源(g, p).map((s) => ({ uid: s.obj.uid, 名称: s.obj.def.全名, 提供: s.提供, 牺牲: s.牺牲 }));
}

/** 现在最多能付多少数字费用（界面拿它当 X 的上限） */
export function 可支付上限(g: GameState, p: number): number {
  let n = 0;
  while (n < 40 && 可支付数字费用(g, p, n + 1)) n++;
  return n;
}

/** 118.2：这个玩家的**费用能力**（可启动的领土）够不够付 `点数` 点数字费用 */

export function 可支付数字费用(g: GameState, p: number, 点数: number): boolean {
  if (点数 <= 0) return true;
  const 来源 = 收集费用来源(g, p);
  let acc = 0;
  for (const s of 来源) if (!s.牺牲) acc += s.提供;
  if (acc >= 点数) return true;
  for (const s of 来源) if (s.牺牲) acc += s.提供;
  return acc >= 点数;
}

/** 701.19：**作为效应**把一个永久物送进墓地（和「消灭」不同，牺牲不产生伤害、不可防止） */

export function 牺牲(g: GameState, o: Obj): void {
  // 701.19 牺牲 = 作为效应把它送进墓地。⚠ 但「送进墓地」必须**走 置入墓地** ——
  //   700.4 的「死去」= 从战场进入墓地，**牺牲也算死去**。
  //   以前这里直接 移到区域(g, o, '墓地')，绕过了 记事件('死去') 与两条死去触发，
  //   于是「当它死去时…」永远不会响（131 后宫内侍「每位玩家各失去 3 点体力」、
  //   以及所有「当另一个单位死去时」的能力都因此静默失效）。
  置入墓地(g, o);
  记录(g, 牺牲名(o) + ' 被牺牲');
}
/** 日志里怎么称呼它。目前就是全名 —— 单独一个函数是为了以后要区分「带修饰符的名」时只改一处 */
function 牺牲名(o: Obj): string { return o.def.全名; }

/**
 * 117.1b：**通常时机** = 进攻玩家的回合中、处于行动阶段、不是在非战斗流程中、
 * 拥有优先权、且堆叠为空。
 *
 * 这是全引擎唯一的判定处 —— 各级「能不能做某个动作」都调它，
 * 调用方不再自己算这个条件（之前散在三处手算，抄错一次就是一个 bug）。
 */
export function 处于通常时机(g: GameState, p: number): boolean {
  return p === g.active
    && g.当前步骤 === '行动阶段'
    && !g.战斗中                                   // 117.1b：不是在非战斗流程中
    && g.stack.length === 0;
}

// ── 能施放 / 能打领土 ────────────────────────────────────────────
/**
 * 这个物件**被授予的某个特殊动作**（层6 的 授予动作）；没有就返回 undefined。
 * 引擎按 `动作` 名分派 —— 加同类新牌只加数据，不用加字段。
 */
export function 授予动作(g: GameState, o: Obj, 动作: string) {
  return 有效特征(g, o).授予动作.find((x) => x.动作 === 动作);
}

/** 你（有效操控者）的空阵地 */
function 我的空阵地(g: GameState, o: Obj): 阵地[] {
  if (o.区域 !== '战场' || !o.阵地) return [];
  // 613.1b：层 2 可能改过操控权 —— 阵地表要用**有效操控者**的
  const pl = g.players[有效控制器(g, o)]!;
  return [...阵地顺序].filter((s) => !pl.阵地[s]);
}
/** **702.16 转移关键词**能去的空阵地：只有**相邻**的（116.2d） */
export function 转移关键词目标(g: GameState, o: Obj): 阵地[] {
  if (o.区域 !== '战场' || !o.阵地) return [];
  return 相邻阵地(o.阵地).filter((s) => 我的空阵地(g, o).includes(s));
}
/** **效应授予的「移动」能去的空阵地：**你的任意**空阵地（116.2c，【急行军】的参数） */
export function 许可目标(g: GameState, o: Obj): 阵地[] {
  const 授 = 授予动作(g, o, '移动');
  // 参数说去哪：急行军是「任意空阵地」（116.2c）；125 白马阵那种是「相邻空阵地」
  return (授?.参数 as { 目的地?: string } | undefined)?.目的地 === '相邻空阵地'
    ? 相邻阵地(o.阵地!).filter((s) => 我的空阵地(g, o).includes(s))
    : 我的空阵地(g, o);
}
/** 两条路能去的**并集**（只用来判「有没有地方可去」，界面上一律分两条列） */
export function 转移目标(g: GameState, o: Obj): 阵地[] {
  return [...new Set([
    ...(有词(g, o, '转移') ? 转移关键词目标(g, o) : []),
    ...(授予动作(g, o, '移动') ? 许可目标(g, o) : []),
  ])];
}

/**
 * 「每回合一次」的限制读法 —— 存的是**回合号 + 索引**。
 * ⚠ 不用在回合开始时清空：换回合时回合号对不上，自然就是「本回合还没用过」。
 *   而且这样**对方回合**也正确地算作新的一回合（{瞬发}能力能在对方回合启动）。
 */
function 本回合用过的能力(o: Obj, 回合: number): number[] {
  const m = o.记忆['本回合已用能力'] as { 回合: number; 索引: number[] } | undefined;
  return m && m.回合 === 回合 ? m.索引 : [];
}

/**
 * **702.16「转移」关键词本身**能不能用。
 * ⚠ 这是**印在牌上的那个关键词能力**，不是效应授予的移动许可 —— 两者是两种不同的能力，
 *   规则也不同（见 能移动许可）。以前它们共用一条检查，于是「不整备」这条
 *   **关键词自己的**限制泄漏到了【急行军】上。
 */
export function 能转移(g: GameState, p: number, o: Obj): boolean {
  if (p !== g.active) return false;                          // 「其操控者回合」
  // 702.16b「其**操控者**回合」—— 操控者按 613.1b 层 2 之后算
  if (有效控制器(g, o) !== p) return false;
  if (!有词(g, o, '转移')) return false;
  if (o.sick) return false;                                  // 116.2d：「不整备时向相邻空阵地移动一次」
  if (o.记忆['本回合已转移'] === g.turn) return false;        // 702.16b：每回合一次
  if (!处于通常时机(g, p)) return false;                      // 「{通常}时机」
  return 转移关键词目标(g, o).length > 0;
}

/**
 * **效应授予的「移动」许可**（【急行军】）能不能用 —— 和 702.16 转移是**两种不同的能力**。
 * 卡面：「对每个由你操控的单位而言，本回合中，你可以于{通常}时机将之移动至你的一个空阵地一次。」
 * ⚠ 卡面**没有**「不处于整备状态」—— 整备的单位照样能用，所以这条检查只属于 702.16 转移关键词自己。
 * ⚠ 目的地也不同：许可是「你的一个空阵地」，关键词只有「相邻空阵地」（见 转移目标）。
 */
export function 能移动许可(g: GameState, p: number, o: Obj): boolean {
  if (p !== g.active) return false;
  if (有效控制器(g, o) !== p) return false;
  if (!授予动作(g, o, '移动')) return false;
  // ⚠ 次数**必须和转移分开记**：702.16b 的「每回合只能**通过转移能力**移动一次」
  //   是**转移能力自己的**属性（702.16c 也只说「多个转移能力不增加可转移次数」），
  //   管不到 116.2c 这条路。共用一个计数器会让「用过转移」白白吃掉急行军的移动。
  if (o.记忆['本回合已移动许可'] === g.turn) return false;
  if (!处于通常时机(g, p)) return false;
  return 许可目标(g, o).length > 0;
}

/** 两种「换个阵地」的能力**任一**可用（列合法动作、以及 转移() 的入口都用它） */
export function 能移动(g: GameState, p: number, o: Obj): boolean {
  return 能转移(g, p, o) || 能移动许可(g, p, o);
}

/**
 * **把单位挪到另一个阵地**（701.18 的一次移动）。两条路各自校验、各自记次数：
 *   · `'转移'` = 702.16 关键词（只有相邻空阵地，且要求不整备）
 *   · `'许可'` = 116.2c 效应授予的移动（【急行军】，你的任意空阵地）
 * ⚠ 次数**必须分开记**：702.16b 的「每回合只能通过转移能力移动一次」是转移能力自己的属性，
 *   管不到 116.2c 那条路。共用一个计数器会让「用过转移」白白吃掉急行军的移动。
 */

export function 转移(g: GameState, p: number, o: Obj, 到: 阵地, 路径: '转移' | '许可' = '转移'): void {
  // ⚠ 两条路**各自校验、各自记次数**（702.16b 的次数限制只属于转移能力本身）
  const 可以 = 路径 === '许可' ? 能移动许可(g, p, o) : 能转移(g, p, o);
  const 目标表 = 路径 === '许可' ? 许可目标(g, o) : 转移关键词目标(g, o);
  if (!可以) { 记录(g, '移动：现在不能' + (路径 === '许可' ? '用这条许可' : '转移')); return; }
  if (!目标表.includes(到)) { 记录(g, '移动：' + 到 + ' 不是这条能力能去的空阵地'); return; }
  const pl = g.players[有效控制器(g, o)]!;   // 同上：用有效操控者的阵地表
  pl.阵地[o.阵地!] = null;
  写阵地(g, o, 到);
  pl.阵地[到] = o;
  // 记**这条路**的次数 —— 两种能力各自每回合一次，互不影响（见 能移动许可 的说明）
  写记忆(g, o, 路径 === '许可' ? '本回合已移动许可' : '本回合已转移', g.turn);
  记录(g, o.def.全名 + (路径 === '许可' ? ' 移动（116.2c 许可）：' : ' 转移（702.16）：') + 到);
}

/**
 * 能否打出领土。
 * 304.4a 明置打出：只能是领土牌。
 * 304.4b 暗置打出：**任意一张牌**都可以（116.2b 特殊动作，进战场后是暗置领土）。
 * 304.2 / 116.2b：明置与暗置合计，每个自己的回合只能打一张。
 * 304.3：只能在自己的回合。
 */
export function 能打出领土(g: GameState, p: number, o: Obj, 面: '明置' | '暗置' = '明置'): boolean {
  const pl = g.players[p]!;
  if (p !== g.active) return false;                 // 304.3
  if (o.区域 !== '手牌') return false;
  if (pl.landsPlayedThisTurn >= 1) return false;    // 304.2
  if (!处于通常时机(g, p)) return false;             // 304.1：要通常时机（含 304.3 只能自己回合）
  // 604：【皇天后土】这类「你不能打出明置领土」只挡明置，不挡暗置（304.4b 仍可）
  if (面 === '明置' && 有限制(g, p, '打出明置领土')) return false;
  if (面 === '明置') return o.def.类别.includes('领土');
  return true;                                      // 304.4b：暗置不限牌的种类
}

/**
 * **601.2 能不能施放**：时机（117.1）、费用（118）、目标（602）、以及 613.10 的玩家限制。
 * 返回 `reason` 是为了界面能说清「为什么打不出去」，别只返回布尔。
 */

export function 能施放(g: GameState, p: number, o: Obj): { ok: boolean; reason?: string } {
  const 通常时机 = 处于通常时机(g, p);
  if (o.区域 !== '手牌') return { ok: false, reason: '不在手牌' };
  // 613.10 + 302.1：该玩家被禁止「打出非领土牌」（能施放 处理的就是非领土牌；领土走 能打出领土）
  if (玩家被禁(g, p, '打出牌', o)) return { ok: false, reason: '本回合不能打出这张牌（613.10）' };
  if (o.def.类别.includes('领土')) return { ok: false, reason: '领土走特殊动作' };
  // 303.1a/b + 301.1 + 305.1 + 306.1：**除瞬发锦囊外，所有牌都是通常时机**
  // 206.4e/f：「通常」「瞬发」是**锦囊专属**的超类别（卡面画图案，不是写字）
  //   ⚠ 限定 类别.includes('锦囊') 是为了让**数据写错时不会静默变成规则错误** ——
  //     单位/战器/阵略 要瞬发只有 702.4 伏击一条路，没有「超类别瞬发」这回事。
  // 083 吕蒙那种：战场上的永久物给的**打出许可**（「手上的吴势力单位牌视同具有伏击般打出」）
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

// ── 施放与打出 ───────────────────────────────────────────────────
export function 打出领土(g: GameState, p: number, o: Obj, 面: '明置' | '暗置'): void {
  const pl = g.players[p]!;
  // ⚠ indexOf 返回 -1 时 splice(-1,1) 会删掉手牌**最后一张** —— 必须挡住
  // ⚠ indexOf 返回 -1 时 splice(-1,1) 会删掉手牌**最后一张** —— 必须挡住
  if (!pl.hand.includes(o)) { 记录(g, '⚠ 打出领土：这张牌不在 ' + pl.name + ' 的手牌里，忽略'); return; }
  pl.landsPlayedThisTurn++;
  // 116.2b / 709.3：**面要在进战场之前定** ——
  //   「以暗置状态进入战场的物件，在其进入战场前便已是暗置的状态，因此该实体的
  //     进战场的触发式能力并不会触发，其静止式能力并不会生效」。
  //
  // ⚠⚠ **这里直接置状态，不走 设面、不记事件、不排队** —— 因为「打出暗置领土」
  //   **不是「暗置」这个动作**（701.11c/d 的动作是把一个东西**翻成**隐藏状态）。
  //   709.4：「以暗置状态打出的物件，在其**进入堆叠前**便已是暗置的状态」——
  //   也就是它是**以暗置状态被放进来**的，从来没有「被翻过去」这一步。
  //   证据（初阵释疑·陈群）：「印制类别为基本领土的暗置领土于**暗置状态下并不具有**
  //   基本领土的类别」—— 打出暗置领土时它**不是**基本领土，所以「当你暗置一个基本领土时」
  //   不该被它触发。以前这里调 设面（会记事件 + 排队），于是打一块地就触发陈群。
  写面(g, o, 面);
  // ⚠ 单位走 301.11（须选阵地 ✓）；横置由 进战场 里的 614 替代效应处理 ✓，与阵地无关 ✓
  if (是类别(g, o, '单位')) {
    const 空 = 阵地顺序.filter((s2) => !g.players[p]!.阵地[s2]);
    if (空.length) { 记录(g, '301.11：' + o.def.全名 + ' 需要选择阵地（此处由调用方保证已选）'); }
    进战场(g, o, p, 空[0] ?? null);
  } else 进战场(g, o, p, null);
  记录(g, pl.name + ' 打出领土 ' + o.def.全名 + '（' + 面 + '）');
}

/**
 * **601：真的打出去** —— 付费用（118.2，`支付源` 由调用方挑好）、进堆叠、记「打出牌」事件。
 * ⚠ 引擎**没有自动支付**：`支付源` 必须由调用方给出（界面让玩家点地，AI 自己挑）。
 */

export function 施放(g: GameState, p: number, o: Obj, 目标: 目标[], 阵地?: 阵地, 模式号?: number, X?: number, 支付源?: number[], 额外牺牲?: number[]): void {
  const pl = g.players[p]!;
  // 108.3a：费用带 X 时，X 由操控者在打出时选择并宣告；这里把它当费用来支付
  const 宣告X = 牌面费用值(o.def.打出费用) === 'X' ? Math.max(0, Math.floor(X ?? 0)) : 0;
  // 604：含 费用修正（【李典】那种加价）
  const 总费用 = 牌面费用值(o.def.打出费用) === 'X' ? 宣告X : 实际打出费用(g, p, o.def);
  if (!支付数字费用(g, p, 总费用, 支付源)) { 记录(g, '支付失败：' + o.def.全名); return; }
  // 打出时的**额外费用**（109 舍生取义）：牺牲一个由你操控的单位。602.1d 同一个道理，结算前付掉。
  let 牺牲的: Obj | undefined;
  const 额外牺牲费 = 取费用行为(o.def.额外费用, '牺牲');
  if (额外牺牲费) {
    const 选 = (额外牺牲 ?? []).map((uid) => g.战场.find((x) => x.uid === uid))
      .filter((x): x is Obj => !!x && 有效控制器(g, x) === p && (!额外牺牲费.筛选 || 符合筛选(g, x, 额外牺牲费.筛选)));
    if (选.length < 额外牺牲费.数量.最小) { 记录(g, o.def.全名 + '：额外费用（牺牲）付不出，打出失败'); return; }
    const 祭品 = 选[0]!;
    牺牲的 = 祭品;
    牺牲(g, 祭品);
    记录(g, g.players[p]!.name + ' 为 ' + o.def.全名 + ' 额外牺牲了 ' + 祭品.def.全名 + '（打出费用，602.1d）');
  }
  // （从手牌摘除由 进战场 → 从当前区域摘除 负责，这里不用手写 splice）
  const 目标槽: Record<string, 目标> = {};
  (o.def.能力?.目标 ?? []).forEach((spec, i) => {
    const t = 目标[i];
    if (t !== undefined) 目标槽[spec.目标名] = t;
  });
  const item: StackItem = {
    id: g.nextStackId++, 种类: '令符', 标签: o.def.全名, 操控者: p,
    来源: null, card: o, 目标, 目标槽, chosenSlot: 阵地, chosenMode: 模式号,
    宣告X,                                   // 108.3a：堆叠上的 X 等于宣告的数值
    额外牺牲: 牺牲的,                          // 601.2f：效应里的 { ref:'额外牺牲' } 读它
    steps: o.def.能力?.牌效应 ?? [],
  };
  堆叠加(g, item);
  // ⚠ 先从手牌摘掉（不能直接 区域='堆叠' —— 那样 从当前区域摘除 就认不出它在手牌了，
  //   牌会**同时留在手上和堆叠上**）
  从当前区域摘除(g, o);
  写区域(g, o, '堆叠');
  // 601：这是一次「打出一张牌」—— 记事件，供「每当你打出一张锦囊牌时」那类触发用。
  //   受方 = 那张牌的 uid；数量 = 玩家号（谁是打出者），触发式按 受方/数量 取。
  记事件(g, '打出牌', { 受方: o.uid, 数量: p, 来源: o.uid });
  // 048 关平「当关平成为锦囊令符或阵略令符的目标时」—— 同样是「只记了事件、没排队」的缺口
  for (const t2 of 目标) if (typeof t2 !== 'number' && 'uid' in t2) 记事件(g, '被指定为目标', { 受方: t2.uid, 来源: o.uid });
  排队被指定为目标触发(g, 目标, o);
  // ⚠ 原来只记事件没排队 —— 067 武侯符阵兵 的「每当你打出锦囊时」从没触发过
  排队事件触发(g, '打出牌', p, o);
  记录(g, pl.name + ' 打出 ' + o.def.全名 + '（费用 ' + 总费用 + (牌面费用值(o.def.打出费用) === 'X' ? '，X=' + 宣告X : '') + '）' +
    (目标.length ? '，目标：' + 目标.map((t) => 目标名(g, t)).join('、') : '') +
    (阵地 ? '，阵地：' + 阵地 : ''));
}

/** 目标在日志里的名字。玩家给名字，能力给它的标签，实体给全名 */
function 目标名(g: GameState, t: 目标): string {
  if (typeof t === 'number') return g.players[t]!.name;
  if ('堆叠项' in t) { const it = g.stack.find((x) => x.id === t.堆叠项); return it ? it.标签 : '（已不在堆叠的能力）'; }
  return t.def.全名;
}
/** 目标里的实体那一半（玩家/能力都没有实体）。取不到就是 null */
function 目标对象(t: 目标): Obj | null { return 取实体(t); }

// ── 目标候选 ─────────────────────────────────────────────────────
/** @param 锚 relation（相对/相邻/斜对）是相对谁算的 —— 通常是这个能力的来源 */
/**
 * **这些目标槽能不能同时填满** —— 每个槽要拿到自己 `数量.最小` 个，且**一个物件只能进一个槽**。
 *
 * ⚠ 必须**放在一起看**，不能各槽各查各的：129 貂蝉两个槽的筛选一样，
 *   场上只有一个非女性单位时，两个槽各自都「够」，但其实只能填一个 —— 于是能力被列成
 *   可启动/可施放，点了才卡住。
 *
 * 用最大二分匹配（Kuhn），**不用贪心**：条件嵌套时贪心会误判 ——
 *   甲的筛选更宽，先拿走了唯一的那个合法物件，乙就没得选；而正确分法是甲拿别的。
 */
export function 能填满所有槽(g: GameState, 操控者: number, 规格: TargetSpec[], 锚?: Obj | null): boolean {
  const 需要: 候选[][] = [];
  for (const sp of 规格) {
    const c = 候选目标(g, 操控者, sp, 锚 ?? null);
    // 一个槽要 最小 个 —— 展开成 最小 个同样的槽，交给匹配去分配
    for (let i = 0; i < sp.数量.最小; i++) 需要.push(c);
  }
  if (需要.length === 0) return true;
  const 键 = (x: 候选): string => (x.obj ? 'o' + x.obj.uid : x.堆叠项 !== undefined ? 's' + x.堆叠项 : 'p' + x.玩家);
  const 配 = new Map<string, number>();          // 物件 → 它被分给了哪个槽
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

// ⚠ **锚是必填** ✗ —— 它是选择器里 `除:'自身'` / `关系` / 「所佩带的」这些判据的参照物 ✓。
//   以前它可选 ✗ → 漏传不报错 ✓、语义静默变掉 ✗ ——【甘宁】能选自己就是这么来的 ✓
//   （建规格 漏传锚 ✓ → `o === 锚` 永远不成立 ✓ → 自己进了候选 ✓）。
//   改成必填之后，**漏传会在编译期报出来** ✓。拿不到锚的场合请显式传 null ✓。
const 候选缓存 = new WeakMap<GameState, { 版本: number; 表: WeakMap<object, Map<string, 候选[]>> }>();
function 候选缓存槽(g: GameState) {
  const 版本 = g.状态版本 ?? 0;
  let c = 候选缓存.get(g);
  if (!c || c.版本 !== 版本) { c = { 版本, 表: new WeakMap() }; 候选缓存.set(g, c); }
  return c;
}
export function 候选目标(g: GameState, 操控者: number, spec: TargetSpec, 锚: Obj | null, 是目标 = true,
  /** 「由**该玩家**操控的」要用的触发受方（161 高顺）；不传 = 那条选择器没人匹配 */
  触发受方?: Obj | number,
  /** 「武力小于**该单位**」那种筛选要读的「记住」值从哪来（074 一夫当关）—— 解析受方 会把记忆宿主传进来 */
  记忆源?: Obj): 候选[] {
  // ⚠ **按状态版本缓存**（环里的"扫全场"就是这里 ✓）
  //   调用方常常每次新建 spec（`{ 目标名:'_', 数量:…, 选择: v.数 }` ✗）→ 只能按里面的
  //   **单选择器**（`spec.选择`，来自卡数据、身份稳定 ✓）当键 ✓；多选择器（`spec.任一`）直接算 ✓。
  //   `候选目标` 只看 `spec.任一 ?? spec.选择` ✓（不看 数量 ✓）→ 按选择器当键是**等价**的 ✓。
  //   ⚠ 返回的数组是**共享只读**的 ✓（调用方只 `.map/.filter/.every/for-of` 读它 ✓，别原地改 ✗）。
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
/** 从选择器的 筛选 里取某属性的值（玩家 / 堆叠项 这类特殊选择器用 ✓） */
function 取条件(sel: Selector | undefined, 属性: string): string | undefined {
  const v = (sel?.筛选 ?? []).find((c) => (c as { 属性?: string }).属性 === 属性)?.值;
  return v === undefined ? undefined : String(v);
}

/**
 * **把「触发」展开成"一个触发分支一项"** ✓（`触发: { 任一: [ … ] }` ✓；单个 {} 原样 ✓）。
 * ⚠ 只在各处的 `abs.forEach(...)` 入口前调用 ✓ —— 判断逻辑一律不用改 ✗：
 *   每个分支拿到的是**只有那一条触发**的能力副本 ✓，原有 `ab.触发.事件/主体/…` 读法照旧 ✓。
 */
type 单触发能力 = TriggeredAbility & { 触发: Trigger };
function 展开能力触发(abs: TriggeredAbility[]): { ab: 单触发能力; i: number }[] {
  const out: { ab: 单触发能力; i: number }[] = [];
  abs.forEach((ab, i) => {
    const t = (ab as { 触发?: unknown }).触发;
    if (t && typeof t === 'object' && Array.isArray((t as { 任一?: unknown }).任一)) {
      for (const 项 of (t as { 任一: unknown[] }).任一) {
        out.push({ ab: { ...ab, 触发: 项 as Trigger } as 单触发能力, i });
      }
    } else out.push({ ab: ab as 单触发能力, i });
  });
  return out;
}
function 候选目标内(g: GameState, 操控者: number, spec: TargetSpec, 锚: Obj | null, 是目标 = true,
  触发受方?: Obj | number,
  记忆源?: Obj): 候选[] {
  // ⚠ `是目标 = false` 给**结算时的选择**用（叙述里没有【目标】字样，115.10a）——
  //   那种选择**不受** 702.2b 抵抗 / 702.3b 洞察限制（它们只管「不能成为目标」）。
  const out: 候选[] = [];
  const list: Selector[] = spec.任一 ?? (spec.选择 ? [spec.选择] : []);
  for (const sel of list) {
    if (取条件(sel, '种类') === '玩家' || 取条件(sel, '种类') === '对手') {
      for (const pl of g.players) {
        if (取条件(sel, '种类') === '对手' && pl.index === 操控者) continue;
        if (取条件(sel, '操控者') === '你' && pl.index !== 操控者) continue;
        if (取条件(sel, '操控者') === '对手' && pl.index === 操控者) continue;
        out.push({ obj: null, 玩家: pl.index });
      }
      continue;
    }
    if (取条件(sel, '区域') === '堆叠') {
      for (const it of g.stack) {
        // 114.9：能力不是令符（113.1）—— 默认不列，卡面写「或能力」时才列
        if (!it.card || it.种类 !== '令符') {
          if (!!取条件(sel, '含堆叠能力') && it.种类 !== '令符') out.push({ obj: null, 玩家: null, 堆叠项: it.id });
          continue;
        }
        // 之前漏了 种类 / 非种类 的判断（无懈可击写的是「非领土牌」）
        // ⚠「令符」「牌」是「在堆叠上」的**称呼**，不是 def.类别 里的值（冷箭的类别是「锦囊」），
        //   所以这两个值对堆叠项直接算通过；其它 种类 才去查牌面类别。
        if (取条件(sel, '种类') && 取条件(sel, '种类') !== '令符' && 取条件(sel, '种类') !== '牌' && !属于类别(g, it.card, 取条件(sel, '种类') ?? '')) continue;
        if (取条件(sel, '非种类') && 属于类别(g, it.card, 取条件(sel, '非种类') ?? '')) continue;
        out.push({ obj: it.card, 玩家: null });
      }
      continue;
    }
    // 401/402/404/406：**非战场区域**（墓地/手牌/牌库/放逐区）也能当目标来源。
    //   例：108 祖茂「将目标本回合进入你墓地的单位牌放进战场」、139 回天术「任一墓地中的单位牌」。
    if (取条件(sel, '区域') && 取条件(sel, '区域') !== '战场') {
      const 池: Obj[] =
        取条件(sel, '区域') === '墓地' ? g.players.flatMap((pl) => pl.graveyard)
        : 取条件(sel, '区域') === '手牌' ? g.players.flatMap((pl) => pl.hand)
        : 取条件(sel, '区域') === '牌库' ? g.players.flatMap((pl) => pl.library)
        : 取条件(sel, '区域') === '放逐区' ? g.放逐区
        : [];
      for (const o of 池) {
        if (!符合选择器(g, o, sel, 锚 ?? null, 操控者, 有效特征(g, o), 触发受方, 记忆源)) continue;
        out.push({ obj: o, 玩家: null });
      }
      continue;
    }
    for (const o of g.战场) {
      // 统一走 符合选择器（含 相对/相邻/斜对 关系）。
      //   702.3b 洞察是**目标**特有的限制，所以留在外面。
      // 702.3b：洞察 = 「不能成为对手的目标」—— 「对手」按**有效操控者**算
    if (是目标 && 有词(g, o, '洞察') && 有效控制器(g, o) !== 操控者) continue;
      // 702.2b：具有某<特征>抵抗的实体，不能成为具该特性之令符/能力的目标
      if (是目标 && 抵抗挡得住目标(g, o, 锚 ?? null)) continue;
      // 702.5a + 306.4a：数术的附属能力**限制它打出时的目标**
      {
        const 附 = 锚 ? 关键词特征(g, 锚, '附属') : undefined;
        if (附 && !符合筛选(g, o, 附, 有效特征(g, o))) continue;
      }
      if (!符合选择器(g, o, sel, 锚 ?? null, 操控者, 有效特征(g, o), 触发受方, 记忆源)) continue;
      // ⚠ 除:'self' 由 符合选择器 处理（它只排除**锚自己**）。
      //   这里原来无条件 continue，会把「除自身外」整组跳空 —— 导致 受锁定=[] 效应全失效。
      out.push({ obj: o, 玩家: null });
    }
  }
  return out;
}

/**
 * **`SelectKind` 的匹配**（402/403）—— 「种类:'实体'」这类词到底命中什么。
 *   `'实体'` / `'物件'` → 战场上的东西**都是**（403.3）
 *   `'令符'` → 战场上的**都不是**（令符只存在于堆叠上，113.1）
 *   其余 → 查算完 613 之后的 `类别`
 * ⚠ 用 `有效特征` 的类别，不读印制值 —— 层 4 改过类别的牌要按改后的算。
 */
function 属于类别(g: GameState, o: Obj, 种类: string): boolean {
  if (种类 === '实体') return true;                       // 战场上的物件都是实体（403.3）
  if (种类 === '物件') return true;
  if (种类 === '令符') return false;                      // 战场上的实体不是令符
  return 是类别(g, o, 种类);                              // 层4 生效后
}

/** 只含目标合法性检查（608.2b 用） */
function 目标仍合法(g: GameState, item: StackItem): boolean {
  if (item.目标.length === 0) return true;
  for (const t of item.目标) {
    if (typeof t === 'number') { if (!g.players[t]) return false; continue; }
    // 114.9：指向「堆叠上的能力」—— 它还在堆叠里才算合法
    if ('堆叠项' in t) { if (!g.stack.some((x) => x.id === t.堆叠项)) return false; continue; }
    // 非战场区域的目标（墓地/手牌/牌库/放逐区）：**还在原来那个区域**就仍然合法。
    //   ⚠ 原来是「不是战场/堆叠就非法」—— 那会让 108 祖茂 这类牌一打出就自我取消。
    if (t.区域 !== '战场' && t.区域 !== '堆叠') {
      if (t.区域 === '墓地' && !g.players.some((pl) => pl.graveyard.includes(t))) return false;
      if (t.区域 === '手牌' && !g.players.some((pl) => pl.hand.includes(t))) return false;
      if (t.区域 === '牌库' && !g.players.some((pl) => pl.library.includes(t))) return false;
      if (t.区域 === '放逐区' && !g.放逐区.includes(t)) return false;
      // ⚠ 「暂存」的牌**不在任何区域**（已被摘出、还没放回）—— 它不该算合法目标。
      //   不写这一条的话，上面那串 if 一个都不命中，会一路穿过去被当成合法。
      if (t.区域 === '暂存') return false;
    }
  }
  return true;
}

// ── 进战场 / 区域移动 ────────────────────────────────────────────
/**
 * **614 的一个替代性效应**：「以**横置**状态进场」。
 * 规则上它把「进场」这个事件替换成「横置着进场」，所以**属于 进战场 这个动作**。
 * 两个来源：
 *   ① 牌自己的固有属性 —— CardDef.横置进场（「这张牌须横置进场」），**对所有入场路径生效**
 *   ② 本次的效应指定 —— 例如【韩浩】「将之横置放进战场」
 */
export interface 进场替代 { 横置?: boolean }

/**
 * 把实体放进战场 —— **这是一个动作**。
 * 别处（打出领土 / 施放结算 / 搜寻后放置 / 再起 / 征召 / 移动）都用这个动作。
 *
 * 替代性效应（614）**在这个动作里检查并执行**，所以任何路径都自动正确 ——
 *   不需要在各个调用点各补一句「横置」。
 */
/**
 * **701.4 附属 —— 一个动作。** 把数术附属到某个物件或玩家上。
 *
 * 规则顺序（别再在别处手写 `写附属在(g, o, uid`）：
 *   ① 702.5a/c 的合法性由**打出的目标**把关（见 915 行那里读「附属」关键词的特征）——
 *      这个函数只管「附上去」这一步。
 *   ② 701.4b：本来就附在这个目标上 → **什么都不做**（不产生新物件、不刷新时间印记）。
 *   ③ 701.4a/c：从当前所在的区域放到目标之上；**已经在战场上**的数术改附别的对象 →
 *      它成为**新物件**（613.7e：获得新的时间印记）。
 *   ④ 反向（数术离场 / 失去附属）**不是这个动作的一部分** —— 离场清理里解除（306.4c），
 *      非法或未附属由 **704.5l 的状态动作**收。
 */
export function 附属(g: GameState, 数术: Obj, 目标: number): void {
  if (数术.附属在 === 目标) return;                       // 701.4b：无事可做
  const 改附 = 数术.区域 === '战场' && 数术.附属在 !== undefined;   // 701.4c：战场上改附 = 新物件
  写附属在(g, 数术, 目标);
  if (改附) { 盖时间印记(g, 数术); 记录(g, '613.7e：' + 数术.def.全名 + ' 改附 → 新的时间印记'); }
  const 实体 = 目标 > 1 ? g.战场.find((x) => x.uid === 目标) : undefined;
  记录(g, '306.4b：' + 数术.def.全名 + ' 附属于 ' + (实体 ? 实体.def.全名 : '玩家' + 目标));
}

/**
 * **进场本体**：只做放置（替任/坚阵/整备/写阵地/横置进场/迎击登记**之前**的一切）✓，
 *   **不记事件、不排队触发** ✗ —— 这两件事由调用方决定：
 *   · 单个进场 → `进战场` ✓（本体 + 记事件 + 排队触发 ✓）
 *   · **一次事件的批量进场** → `批量进战场` ✓（全部本体 → 再统一记事件/排队 ✓）
 */
function 进场本体(g: GameState, o: Obj, 操控者: number, 阵地: 阵地 | null, 替代?: 进场替代): void {
  const pl = g.players[操控者]!;
  const 是单位0 = 是类别(g, o, '单位');
  // 702.80g：一个物件将**替任**具有「坚阵」的单位时，前者**不会进入战场**：
  //   是牌/牌的复制品 → 放逐；是指示物 → 该指示物从未被征召。
  if (是单位0 && 阵地) {
    const 挡 = pl.阵地[阵地];
    if (挡 && 有词(g, 挡, '坚阵')) {
      记录(g, '702.80g：' + 挡.def.全名 + ' 具有坚阵，' + o.def.全名 + ' 不会进入战场');
      if (o.是指示物) 记录(g, '  （指示物：从未被征召）');
      else { 移到区域(g, o, '放逐区'); 记录(g, '  （是牌 → 放逐）'); }
      return;
    }
  }
  // 400.7：进战场要**自己从当前区域摘除**（调用方不用管）
  从当前区域摘除(g, o);
  写操控者(g, o, 操控者);
  写区域(g, o, '战场');
  盖时间印记(g, o);                    // 613.7d：进入区域获得新的时间印记
  战场加(g, o);
  const 是单位 = 是类别(g, o, '单位');
  // 301.6：整备是「单位」的状态；领土/阵略/战器进场不受整备影响，当回合即可使用
  写整备(g, o, 是单位);                     // 神速无视整备（702.11）
  if (是单位 && 阵地) {
    // 301.9 / 701.18a：要进的阵地上已有单位 → **替任**（放逐后者）
    // 701.18d：**先放逐原有单位，之后新单位进场**，这两个单位从未同时在场
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
  // ══ 301.13（**尚未实现，留位** ✗）════════════════════════════════════
  //  规则原文：「如果一个非单位实体获得了单位此牌类别，其操控者**可以**将之移动到他的一个空阵地。」
  //  现状：层4 的 `类别` 机制（types.ts:851）已经能算出「它现在是单位」✓，
  //    但**没有任何地方**在它获得单位类别的那一刻，给操控者这个**可选**动作 ✗。
  //  影响：目前**没有卡用到** ✓（数据里只有 副类别 变更 ✓）→ 潜在缺口 ✓，不是现错的 ✓。
  //  要做时的落点（记这里，省得再找 ✓）：
  //    · 触发点＝层4 让 <非单位实体> 变成含『单位』的类别之后（计算特征 之后 ✓）；
  //    · 形式＝**可选**动作（「可以」✓）→ 复用 待选择（选什么:'阵地' ✓ 候选＝自己的空阵地 ✓）；
  //    · 做时用 301.8/301.13 的移动（引擎已有 移到阵地 那条 ✓ 3449 一带 ✓）；
  //    · 没有空阵地 → **什么都不发生** ✓（301.13 只说「可以…移动」✓）。
  // 302.5b：化身进场时带有等同于其所印灵值数量的灵值标记
  if (是类别(g, o, '化身') && (o.def.灵值 ?? 0) > 0) {
    加标记(g, o, { 类型: '灵值', 数量: o.def.灵值!, 时间印记: g.nextStamp++ });
  }
  // 614：「以横置状态进场」—— 替代性效应在这里检查并执行（牌自己的属性 + 本次指定）
  if ((o.def.横置进场 || 替代?.横置) && o.面 === '明置') {
    写横置(g, o, true);
    排队单位事件触发(g, '成为横置', o);
    记录(g, o.def.全名 + ' 横置进场（614）');
  }
}

/** 702.13b 迎击：当一个单位进入某单位的相对阵地时，后者对前者造成 N 点伤害 */
function 迎击检查(g: GameState, o: Obj, 操控者: number, 阵地: 阵地 | null): void {
  if (!是类别(g, o, '单位') || !阵地) return;    // 没有阵地 → 没有「相对阵地」这件事 → 迎击自然不触发
  const 敌 = (操控者 + 1) % g.players.length;
  const 守 = g.players[敌]!.阵地[相对阵地(阵地)!];
  if (守 && 守 !== o) 排队关键词触发(g, 守, '进入相对阵地', o);
}

/** **单个物件进场**（放置 → 记事件 → 排队触发 → 迎击 ✓）—— 绝大多数地方的入口 ✓ */
export function 进战场(g: GameState, o: Obj, 操控者: number, 阵地: 阵地 | null, 替代?: 进场替代): void {
  进场本体(g, o, 操控者, 阵地, 替代);
  记事件(g, '进战场', { 受方: o.uid });
  排队进战场触发(g, o);
  迎击检查(g, o, 操控者, 阵地);
}

/**
 * ⚠ **一次事件的"批量进场"** ✓：**先把全部物件放好，再统一记事件 / 排队触发** ✓。
 *   为什么必须有它 ✗→✓：触发是排进 `g.pending` 的 ✓，而"同时"不体现在记录里 ✓，
 *   只体现在"这批触发**一起**入队、之后才结算" ✓ ——
 *   如果中途挂起（例如老的征召"一个一个问阵地" ✗），引擎会在两次进场**之间**结算 pending ✓
 *   → 玩家看到"第二个还没进场，第一个的触发就结算了" ✓（2026-10 报的 ✓ 603.3b/APNAP 的次序被破坏 ✓）。
 */
export function 批量进战场(g: GameState, 项: { 对象: Obj; 操控者: number; 阵地: 阵地 | null; 替代?: 进场替代 }[]): Obj[] {
  for (const x of 项) 进场本体(g, x.对象, x.操控者, x.阵地, x.替代);
  for (const x of 项) {
    记事件(g, '进战场', { 受方: x.对象.uid });
    排队进战场触发(g, x.对象);
  }
  for (const x of 项) 迎击检查(g, x.对象, x.操控者, x.阵地);
  return 项.map((x) => x.对象);
}

/** 701.20：移到放逐区（所有玩家共享的一个区域，见 `放进区域`） */

export function 放逐(g: GameState, o: Obj): void {
  移到区域(g, o, '放逐区');    // 400.7（放逐区由所有玩家共享，见 放进区域）
}

/**
 * 701.23 / 112 征召：创造指示物并放进战场。
 * 112.2 征召者是其拥有者，并在其操控下进场。
 * 112.3 指示物只具备该效应定义的特征（没有费用、势力需求、超类别、规则叙述）。
 * 112.4 未指定名称时，名称为「副类别 + 指示物」。
 * 112.6 单位指示物要分别选阵地，不能选同一个；没有空阵地就不能进场。
 */
/**
 * ⚠ **"给某人看这些牌"** —— 引擎里**唯一**一处产生 `查看` 的东西 ✓（规范 ✓：查看 = 服务器要这个人看的牌 ✓）。
 *
 * 为什么要它 ✗→✓：以前"看什么"是**每个操作各自**往待选面板里塞一个 `查看` 字段 ✗ ——
 *   搜寻 / 开局检视 / 摆放顺序 / 观星两问 / 展示 / 检视 … 一共抄了七八处 ✓，
 *   收发层再加一条"候选都在隐藏区"的猜测兜底 ✗ → **同一件事三套并存** ✓
 *   → 每加一个"要人看牌"的操作就要再补一处 ✓，漏一处就出 bug ✓（2026-10 那一串报告 ✓）。
 *
 * 用法 ✓：任何"要玩家看牌"的步骤都写成 `待选择 = 给看({ …面板… }, 要看的牌)` ✓：
 *   · **开局检视** = `给看(面板, [那张牌])` ✓（最普通的一次 ✓）；
 *   · **搜寻** = `给看(面板, 该区域全部)` ✓（面板的候选才是"能挑的" ✓）；
 *   · **展示** = `给看(面板)` ＋ `等双方确认: true` ✓；
 *   · **观星 / 摆放顺序** = `给看(面板)` ✓（候选就是给他看的那几张 ✓）。
 * 不传第二个参数时，`查看` 就取面板自己的候选 ✓。
 */
function 给看<T extends object>(面板: T, 看?: { 键: number | string; 名称: string }[]):
T & { 查看: { 键: number | string; 名称: string }[] } {
  const 列 = 看 ?? ((面板 as { 候选?: { 键: number | string; 名称: string }[] }).候选 ?? []);
  return { ...面板, 查看: 列.map((c) => ({ 键: c.键, 名称: c.名称 })) };
}

export function 征召(g: GameState, p: number, def: CardDef, 数量: number, 阵地?: (阵地 | null)[], 关键词?: string[]): Obj[] {
  // 701.23a：征召 = 把这个数量的、**具有该特征**的指示物放进战场 ✓。
  //   ⚠ 指示物本体是**录好的牌数据** ✓（src/data/指示物.ts ✓ 来自 token_YH.xml ✓）——
  //     以前这里拿「能力里的内联字面量」**现造** CardDef ✗（系列 TOKEN / 编号=名称 / 没图 ✓）。
  //   「该特征」= 本条能力授予的 关键词 ✓（例：136 黄巾之乱 让它带【神速】✓）。
  const 项: { 对象: Obj; 操控者: number; 阵地: 阵地 | null }[] = [];   // ← 批量进场的清单 ✓
  const 名 = def.全名;
  // 112.3：指示物的特征就是那张定义 —— 能力里授予的关键词要并进来（有词() 只看 特征.关键词 ✓）
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
  // ⚠ **一次事件进场** ✓（用户口径：多个单位是**同时**进场 ✓）——
  //   先全部放好 ✓，再统一记事件/排队触发 ✓ → 它们一起入队，由玩家按 603.3b 排序 ✓。
  const 出 = 批量进战场(g, 项);
  for (const t of 出) 记录(g, '征召：' + 名 + '（' + (def.武力 ?? 0) + '/' + (def.体力上限 ?? 0) + '）进场（同时 ✓）');
  return 出;
}
/** 122.2：物件从一个区域移动到另一个区域时，其上的标记不会被保留 */
function 离场清理(g: GameState, o: Obj): void {
  写标记表(g, o, []);
  写伤害(g, o, 0);
  清记忆(g, o);
  写整备(g, o, false);
  // 400.7：换区域 = **全新的物件**，对原物件没有任何记忆。
  //   111.5 的「横置/未横置」是**战场永久物**的状态 —— 牌到了手牌/牌库/墓地/放逐区
  //   就不是永久物了，没有横置这回事；下次再进战场也该是未横置的。
  //   ⚠ 不在这里清的话：横置的领土回手，再打出来还是横置的（打不出费用）。
  写横置(g, o, false);
  // 306.4c / 305.5：**附属 / 佩带关系随离场自然解除** ——
  //   不解除的话，靠「只要…附属于…」判定的持续性效应会在来源离场后继续生效
  写附属在(g, o, undefined);
  写佩带在(g, o, undefined);
  // ★ **反向**也要清 ✓：宿主离场时，挂在它身上的装备/数术的关系字段要跟着断 ✓
  //   （以前只清离场者自己 ✗ → 单位死了，战器的 佩带在 还指着死人 uid ✗ →
  //     engine.ts:4962「已佩带就不再给佩戴能力」永远成立 ✗ → 佩戴能力再也不出现 ✗（2026-10-18 报的倚天剑 ✓））
  // ★ 603.6f：触发看的是【离场那一刻】的关系 —— 先把挂着的物件快照到 o 上，再清关系 ✓
  const 离场挂载 = [...g.战场].filter((x) => x !== o && (x.佩带在 === o.uid || x.附属在 === o.uid));
  if (离场挂载.length) (o as unknown as { 离场挂载?: Obj[] }).离场挂载 = 离场挂载;
  for (const x of [...g.战场]) {
    if (x.佩带在 === o.uid) { 写佩带在(g, x, undefined); 记录(g, x.def.全名 + ' 的佩带关系解除（305.5：宿主离场）'); }
    if (x.附属在 === o.uid) { 写附属在(g, x, undefined); 记录(g, x.def.全名 + ' 的附属关系解除（306.4c：宿主离场）'); }
  }
  // **暗置也是战场永久物的状态**（和上面 横置 同一个道理）——
  //   709.2a：一张牌暗置后成为「暗置领土」，那是在**战场上**成立的事；
  //   400.2：其它区域里只有规则或效应**特定说明**才是暗置，而手牌/牌库本来就是隐藏区
  //   （「谁能看自己的手牌」由 402.3 管，和 面 无关）。
  //   ⚠ 不在这里清的话：暗置领土回手后仍然画卡背（【陈群】把暗置领土移回手上「还是背面」），
  //     而且服务端会继续不发牌面（图 = null）。
  写面(g, o, '明置');
}

/**
 * native 逃生舱的**注册表**。
 * 复杂到数据表达不了的牌，写一段 TS 挂在这里；**没注册就会抛错**，
 * 所以不存在「看着有实现、实际空过」的情况。
 */
export type Native实现 = (g: GameState, item: StackItem, 步骤: { 操作: '原生'; 模块: string }) => void;
const native模块表 = new Map<string, Native实现>();
/**
 * **复杂牌的逃生舱**：把一个用纯数据写不出来的效果注册成 TS 函数，卡面用 `{ 操作:'原生', 模块:名 }` 指过来。
 * ⚠ 每个注册点都要能一眼看出它属于哪张牌、为什么不能用数据表达 —— 否则很快会变成一堆查不到出处的函数。
 */

export function 注册native(名: string, 实现: Native实现): void { native模块表.set(名, 实现); }

/**
 * **604：算出这张牌的「实际打出费用」**（含全场静止式能力给的修正）。
 * 【李典】「对手打出每张锦囊牌或阵略牌的费用增加 1」——
 *   它不是「禁止」，是「加价」，所以不能用 规则限制 那套。
 */
export function 实际打出费用(g: GameState, p: number, def: CardDef): number {
  const 牌面 = 牌面费用值(def.打出费用);   // ★ 统一期取数：数字 / 'X' / 费用行为[] ✓
  const 基 = 牌面 === 'X' ? 0 : 牌面;
  let 总 = 基;
  {
    /** 一条 费用修正 是否/加多少 —— 受影响的玩家、筛选、条件、数值（可以是 Value）都在这里收敛 */
    const 试一条 = (r: 费用修正, 控: number): void => {
      const 受 = r.适用 === '对手' ? (1 - 控) : 控;
      if (受 !== p) return;
      // 筛的是「要打出的那张牌」—— 借 符合筛选 的 def 那一半（取属性 只读 o.def）
      if (r.筛选 && !符合筛选(g, { def } as Obj, r.筛选, 有效特征(g, { def } as Obj))) return;
      // 065：「你每回合中打出的**第一个**锦囊令符」—— 条件按受影响的玩家判
      if (r.条件 && !判断(g, 受, r.条件, { def } as Obj)) return;
      总 += typeof r.打出费用 === 'number' ? r.打出费用 : 取值(g, 受, r.打出费用, { def } as Obj);
    };
    for (const o of g.战场) {
      if (o.面 === '暗置') continue;                    // 709.2a：暗置没有规则叙述
      for (const ab0 of (o.def.能力?.能力 ?? []) as StaticAbility[]) {
        if (ab0.种类 !== '静止式' || !ab0.费用修正) continue;
        for (const r of ab0.费用修正) 试一条(r, 有效控制器(g, o));
      }
    }
    // ⚠ **这张牌自己身上**的减费也算（135 黄巾大军「你墓地中每有一张黄巾单位牌，此令符便减少{1}」）——
    //   它结算前在手上/堆叠上，不是战场永久物，上面那个循环扫不到它。
    for (const ab0 of (def.能力?.能力 ?? []) as StaticAbility[]) {
      if (ab0.种类 !== '静止式' || !ab0.费用修正) continue;
      for (const r of ab0.费用修正) 试一条(r, p);
    }
  }
  return Math.max(0, 总);
}

/** 这个物件现在**占着谁的**阵地（没阵地 → null）。不要用 o.操控者 推，两者会不一致。 */
export function 阵地所有者(g: GameState, o: Obj): number | null {
  if (!o.阵地) return null;
  for (const pl of g.players) if (pl.阵地[o.阵地] === o) return pl.index;
  return null;
}

/**
 * **把这个物件从所有玩家的阵地表里清掉。**
 *
 * ⚠ 不能用 `阵地所有者` 找到那一个再清 —— 它只返回**第一个命中**的玩家。
 *   只要有一次搬动漏清（或在清之前就放进了新表），残留就会永远留着，
 *   而战斗是**按阵地现查对手**的（见伤害步骤那段），于是挨打的会变成别人：
 *   表现就是「我打过去，自己这边没事、对面别的阵地上的单位没了」。
 *   所以搬动一律：**先清出所有表，再放进新表**。
 */
function 清出阵地(g: GameState, o: Obj): void {
  if (!o.阵地) return;
  for (const pl of g.players) if (pl.阵地[o.阵地] === o) pl.阵地[o.阵地] = null;
}

/**
 * **301.8**：获得一个**不由你操控之单位**的操控权时 ——
 *   有空阵地 → 移到你的一个空阵地上
 *   没有空阵地 → 将该单位**移出阵地**
 * 这是规则自动做的，不是效应的一部分（效应只说「你获得操控权」）。
 */
export function 获得操控权时移动(g: GameState, o: Obj, 新操控者: number): void {
  if (o.区域 !== '战场' || !是类别(g, o, '单位')) return;      // 只有单位占阵地（403.5b）
  const 空 = 第一个空阵地(g, 新操控者);
  // 从**它当前实际占着的那个阵地**清掉（问 阵地所有者，不用 o.操控者 推）
  清出阵地(g, o);
  if (空) {
    写阵地(g, o, 空); g.players[新操控者]!.阵地[空] = o;
    记录(g, '301.8：' + o.def.全名 + ' 移到 ' + g.players[新操控者]!.name + ' 的 ' + 空);
  } else {
    写阵地(g, o, null);
    记录(g, '301.8：' + g.players[新操控者]!.name + ' 没有空阵地，' + o.def.全名 + ' 被移出阵地');
  }
}

/**
 * **301.8 的反方向：失去操控权时也要搬。**
 *
 * 【降服】离场 → 附属没了 → 层 2 效应失效 → **操控权回到原主**。
 * 按 301.8，原主这算「**获得**一个不由他操控之单位的操控权」，**同样要把它搬到自己的空阵地**。
 * 所以两个方向其实是同一件事：**让「谁操控」和「阵地占在谁那儿」保持一致**。
 *
 * 操控权是**算出来的**（连续的），没有「失控」这个事件可挂 —— 所以在状态动作里对账：
 * 算出来的操控者和阵地所有者不一致，就按 301.8 搬一次。
 */
export function 同步操控权与阵地(g: GameState): void {
  for (const o of g.战场.slice()) {
    if (o.区域 !== '战场' || !是类别(g, o, '单位')) continue;
    if (!o.阵地) continue;                     // 阵地外的不用管（没地方可搬，UI 按操控者分半场）
    const 控 = 有效控制器(g, o);
    const 阵主 = 阵地所有者(g, o);
    if (阵主 === 控) continue;                 // 一致 → 没事
    记录(g, '301.8：' + o.def.全名 + ' 的操控权与阵地不一致（阵地属于 ' +
      (阵主 === null ? '无人' : g.players[阵主]!.name) + '，操控者是 ' + g.players[控]!.name + '），按 301.8 搬一次');
    获得操控权时移动(g, o, 控);
  }
}

/**
 * **613.10 作用于玩家的持续性限制**：查这个玩家现在能不能做这个**动作**。
 * 到期回合之后自动失效（「本回合」→ 到期 = 当前回合号）。
 *
 * ⚠ **限制带 `筛选` 时必须传「对象」** —— 「不能打出非领土牌」要拿那张牌来判类别，
 *   不给对象就无从判断，一律返回 false。**调用点请一律把对象传上**：
 *     if (玩家被禁(g, p, '打出牌', o)) ...      // 能施放 里
 *     if (玩家被禁(g, p, '发起战斗', u)) ...    // 能发起战斗 里
 *   只想看「有没有限制」（界面/调试）用 `玩家限制清单`。
 */
export function 玩家被禁(g: GameState, p: number, 动作: 玩家动作, 对象?: Obj): boolean {
  return (g.players[p]!.限制 ?? []).some((r) =>
    r.禁止 === 动作 && g.turn <= r.到期
    // 筛选是对**动作的对象**生效的（「非领土牌」筛的就是要打出的那张牌）
    && (r.筛选 === undefined || (对象 !== undefined && 符合筛选(g, 对象, r.筛选, 有效特征(g, 对象)))));
}

/** 这个玩家身上所有未到期的限制（界面/调试用；判定请用 `玩家被禁`） */
export function 玩家限制清单(g: GameState, p: number): { 禁止: 玩家动作; 筛选?: 筛选; 到期: number }[] {
  return (g.players[p]!.限制 ?? []).filter((r) => g.turn <= r.到期);
}

/**
 * 702.69b 再起：「将此牌从你的**墓地移回战场**，他获得**神速**能力直到回合结束。
 *   在**下一个结束步骤开始时**，将他**放逐**。」
 * 「神速」= 无视整备状态（702.11b）→ 直接 sick = false。
 * 延迟放逐用一个跨回合的 记忆 标记，在结束步骤开始时处理（见 排队步骤触发 附近）。
 */
注册native('再起', (g, item) => {
  const 牌 = item.来源 ?? item.card;
  if (!牌 || 牌.区域 !== '墓地') { 记录(g, '再起：这张牌不在墓地，什么也不发生'); return; }
  const 槽 = 阵地顺序.find((s) => !g.players[牌.操控者]!.阵地[s]) ?? null;
  进战场(g, 牌, 牌.操控者, 槽);
  写整备(g, 牌, false);                                  // 「获得神速能力直到回合结束」
  写记忆(g, 牌, '结束时放逐', true);                     // 「在下一个结束步骤开始时，将他放逐」
  记录(g, '再起（702.69b）：' + 牌.def.全名 + ' 从墓地移回战场' + (槽 ? '（' + 槽 + '）' : '') + '，获得神速，下个结束步骤开始时放逐');
});

/**
 * 702.7b 佩带：「将此装备佩带在由你操控的目标单位上。」
 * 305.5a：佩带后，那个单位叫「佩带此装备的单位」，装备叫「已被佩带在单位上」。
 * 305.5c：同时为单位的装备不能被佩带（有化剑能力才行）—— 现在没有这种牌，先不处理。
 */
注册native('佩带', (g, item, 步骤) => {
  const 装 = item.来源 ?? item.card;
  const 目标 = 取实体(item.目标槽?.['t']);
  if (!装 || !目标) { 记录(g, '佩带：来源或目标不对，什么也不发生'); return; }
  if (!是类别(g, 目标, '单位')) { 记录(g, '佩带：目标不是单位（305.5）'); return; }
  写佩带在(g, 装, 目标.uid);
  记录(g, 装.def.全名 + ' 佩带在 ' + 目标.def.全名 + ' 上（702.7b）');
});

/**
 * **400.7：区域改变的**唯一入口**。**
 *
 * **任何区域改变都必须走这里。** 手写「从旧数组 splice + 改 o.区域 + 进新数组 push」
 * 三件套漏任何一句就出 bug（物件同时在两个区域 / 区域 与数组不一致 / 122.2 的标记没清）。
 * 新加区域或新的移动方式只改这一处。
 */
function 从当前区域摘除(g: GameState, o: Obj): void {
  switch (o.区域) {
    case '战场': {
      // ⚠ 战场是**共享区域**（不按玩家分）——「在谁的数组里」这件事已经不存在了
      const b = g.战场.indexOf(o); if (b >= 0) 战场删(g, o);
      // 阵地挂在**有效操控者** 的空阵地（301.8 把它搬过去时用的是有效操控者）
      if (o.阵地) { g.players[有效控制器(g, o)]!.阵地[o.阵地] = null; 写阵地(g, o, null); }
      break;
    }
    case '手牌': { const i = g.players[o.owner]!.hand.indexOf(o); if (i >= 0) g.players[o.owner]!.hand.splice(i, 1); break; }
    case '牌库': { const i = g.players[o.owner]!.library.indexOf(o); if (i >= 0) g.players[o.owner]!.library.splice(i, 1); break; }
    case '墓地': { const i = g.players[o.owner]!.graveyard.indexOf(o); if (i >= 0) g.players[o.owner]!.graveyard.splice(i, 1); break; }
    case '放逐区': { const i = g.放逐区.indexOf(o); if (i >= 0) g.放逐区.splice(i, 1); break; }
    case '堆叠': break;   // 堆叠上的牌由 StackItem 管，不进玩家的区域数组
    case '暂存': break;   // 同上：暂存也不在任何区域数组里
  }
}

/** 把物件塞进某个区域的容器（`移到区域` 的后半步）。⚠ 它只管「放进去」，摘除和清理在另一半 */
function 放进区域(g: GameState, o: Obj, 区: Zone): void {
  const pl = g.players[o.owner]!;
  switch (区) {
    case '手牌': pl.hand.push(o); break;
    case '牌库': pl.library.push(o); break;      // 放在**牌库顶**（push 到末尾 = 顶）
    case '墓地': pl.graveyard.push(o); break;
    case '放逐区': g.放逐区.push(o); break;      // 400：放逐区由所有玩家共享
    case '战场': 战场加(g, o); break;
    case '堆叠': break;
    case '暂存': break;   // 暂存期间由 堆叠项.暂存 拿着，不在任何区域数组里
  }
}

/**
 * **把一个物件移到另一个区域**（400.7）。所有区域改变都该走这里。
 * 自动做三件事：从原区域摘干净 / 离场清理（122.2）/ 新时间印记（613.7d）。
 * ⚠ **不**触发任何「进入某区域」的触发 —— 那是调用方的事（例如 700.4「死去」只在进墓地时）。
 */
export function 移到区域(g: GameState, o: Obj, 目的地: Zone): void {
  if (o.区域 === 目的地) return;
  // 701.18：**离开战场**也是一次「移动」（回手/进墓地/放逐/洗入牌库…）
  const 曾是战场 = o.区域 === '战场';
  从当前区域摘除(g, o);
  离场清理(g, o);
  写时间印记(g, o, g.nextStamp++);      // 613.7d：进入一个区域时获得新的时间印记
  写区域(g, o, 目的地);
  放进区域(g, o, 目的地);
  if (曾是战场 && 目的地 !== '战场') { 记事件(g, '移动', { 受方: o.uid }); 排队移动触发(g, o); }
}

/**
 * 400.7：移到墓地。**从战场进墓地才算「死去」**（700.4）—— 令符结算进墓地不是死去，
 * 所以只有 `曾在战场` 才记「死去」并排队触发。
 */

export function 置入墓地(g: GameState, o: Obj): void {
  const 曾在战场 = o.区域 === '战场';
  const 旧阵地 = o.阵地;        // ⚠ 必须在 移到区域 之前取（它会清 o.阵地）
  移到区域(g, o, '墓地');      // 400.7：区域改变全部走这里（以前是手写三件套）
  const pl = g.players[o.owner]!;
  // 700.4：「死去」= 从战场进入墓地。**只有从战场进墓地才算**（令符结算进墓地不是死去）
  记事件(g, 曾在战场 ? '死去' : '离开战场', { 受方: o.uid });
  if (曾在战场) 排队死去触发(g, o, 旧阵地);
  // 「当另一个单位死去时」：扫全场（死的是**它自己**那条已经在上面排过了）
  if (曾在战场 && 是类别(g, o, '单位')) 排队其他死去触发(g, o);
}

/** 700.4：从战场进入墓地的触发。来源已在墓地，所以标 允许离场 */
/**
 * 「当**另一个**…死去时」（156 亡国哀民）—— 触发.主体 是**选择器**（不是字面量）。
 *   ⚠ 死者自己不会触发它（那是 排队死去触发 干的事），是**战场上别人**在看着它死。
 *   **「另一个」由数据里的 `除:'自身'` 表达** ✓ —— 主体 只要不是 `'自身'`，本来就是「另一个」：
 *   匹配时在这里补 `除:'自身'`（锚 = 触发器自己），**数据不写** ✓。
 *   「单位」= `种类:'单位'`、「由你操控的」= `操控者:'你'` —— 这些才在选择器里 ✓。
 */
export function 排队其他死去触发(g: GameState, 死者: Obj): void {
  const 死者特征 = 有效特征(g, 死者);        // 死者已在墓地，特征只算一次 ✓
  for (const o of [...g.战场]) {
    if (o === 死者 || !有规则叙述(g, o)) continue;
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    const 锚控制器 = 有效控制器(g, o);
    展开能力触发(abs).forEach(({ ab, i }) => {
      if (ab.种类 !== '触发式' || ab.触发.事件 !== '死去') return;
      const 主体 = ab.触发.主体;
      // 字面量是**关系**（自身 / 所附属 / 所佩带）—— 都不归这条路（「所佩带/所附属」反向扫场在下面）
      if (!主体 || typeof 主体 === 'string') return;
      // ★ 用**现成的**选择器匹配（和选目标/筛选同一套）✓：
      //   「另一个」由数据里的 `除:'自身'` 表达 `除:'自身'`（排除来源自己）✓ —— 数据不写 ✓；
      //   `操控者:'你'` = 和触发器**同一个操控者** ✓；
      //   `种类` / `筛选` 判死者的特征 ✓ —— 以前「关系 / 类别 / 归属 / 特征」是四个平行字段 ✗。
      if (!符合选择器(g, 死者, 主体, o, 锚控制器, 死者特征)) return;
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '其他死去触发'), 允许离场: true, 触发受方: 死者 });
    });
  }
}

export function 排队死去触发(g: GameState, o: Obj, 位置?: 阵地 | null): void {
    // ⚠ 「它自己的死去触发」走通用广播 ✓（扫全场、按卡面 主体 判 ✓）；
    //   「其他」由 排队其他死去触发 负责 ✓；「所佩带/所附属」下面那段保留 ✓。
    排队单位事件触发(g, '死去', o, { 允许离场: true, 死者位置: 位置 ?? null, 触发受方: o });
    if (false) {   // 旧的自身扫描（保留结构、不再执行 ✓）
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    展开能力触发(abs).forEach(({ ab, i }) => {
      // ⚠ 只有 主体 = '自身'（或没写）的才是「它自己的死去触发」。
      //   以前这里写的是 `!== '所佩带'` —— 于是「看着别人死去」的能力（156 亡国哀民）
      //   也被排了一次「它自己的死去触发」，界面上就多出一条（而且会双重结算）。
      //   「另一个」由 排队其他死去触发 扫场排（主体 是选择器）；「所佩带/所附属」由下面那段反向扫排。
      if (ab.种类 === '触发式' && ab.触发.事件 === '死去' && (ab.触发.主体 ?? '自身') === '自身') {
        g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '死去触发'), 允许离场: true, 触发受方: o, 死者位置: 位置 });
      }
    });
  }
  // 「当**佩带此装备的单位**死去时」（178 倚天剑）—— 能力挂在**装备/数术**上，
  //   而死的是它所佩带/附属的那个单位，所以要**反过来**扫场上的装备与数术。
    // ★ 603.6f：优先用【离场那一刻】的快照 ✓（关系字段此时已被 离场清理 清掉 ✗）
    const 快照 = (o as unknown as { 离场挂载?: Obj[] }).离场挂载;
    for (const x of (快照 ?? [...g.战场])) {
    if (x === o || !有规则叙述(g, x)) continue;
    const abs = (x.def.能力?.能力 ?? []) as TriggeredAbility[];
  展开能力触发(abs).forEach(({ ab, i: k }) => {

      if (ab.种类 !== '触发式' || ab.触发.事件 !== '死去') return;
      const 主体 = ab.触发.主体 ?? '自身';
      if (主体 !== '所佩带' && 主体 !== '所附属') return;
      // 关系存在**装备/数术**身上（佩带在 / 附属在 存的是那个**单位**的 uid），所以比的是 o.uid
      const 挂 = 主体 === '所佩带' ? x.佩带在 : x.附属在;
    if (!快照 && 挂 !== o.uid) return;   // 快照里已经只剩挂在它身上的物件 ✓
      g.pending.push({ 来源: x, abilityIndex: k, 标签: 触发标签(x, 主体 + '死去触发'), 允许离场: true, 触发受方: o, 死者位置: 位置 });
    });
  }
}

// ── 触发式能力 ───────────────────────────────────────────────────
export function 排队进战场触发(g: GameState, o: Obj): void {
  扫守望(g, '进战场', o);            // 603.7：延迟触发（138 谎报）在这条路上
  // ⚠ **走通用广播** ✓ —— 不再手写「只认自身」那一段 ✗（手写枚举就是漏掉
  //   「当另一个单位进场时」的原因 ✓：甘宁第二条形同不存在 ✓）。
  //   通用那条会自己判：自身 ✓ / 选择器（另一个 / 种类 / 操控者 / 筛选）✓。
  排队单位事件触发(g, '进战场', o);
}
/**
 * 「当一个物件**成为**某令符/能力的目标时」（048 关平那类）。
 * ⚠ 判的是**来源**（那个令符）—— 用 `触发.筛选来源`；`触发.筛选` 判的是受方（= 这个物件本身）。
 */
export function 排队被指定为目标触发(g: GameState, 受方们: 目标[], 来源obj: Obj | null): void {
  if (!来源obj) return;
  // ⚠ 走通用广播 ✓（以前自己扫一遍 ✗，而且不认 主体/筛选 ✗）。
  //   受体 = **被指定的那个物件**（卡面写「当此物成为目标时」✓）；来源单独传进去判 筛选来源 ✓。
  for (const t of 受方们) {
    if (typeof t === 'number' || !('uid' in t)) continue;
    const 物件 = g.战场.find((x) => x.uid === (t as { uid: number }).uid);
    if (物件) 排队单位事件触发(g, '被指定为目标', 物件, { 触发受方: 物件 }, 来源obj);
  }
}

/**
 * 「当某个玩家 / 某个单位**回复体力**时」（119.2）。
 * 受方是**玩家号**或**物件** —— 触发用 触发.受方 区分是哪一类
 * （058 仁者的大德那两条就是这个差别）。
 */
export function 排队回复体力触发(g: GameState, 受方: number | Obj): void {
  // 701/119.2：回复体力的触发。受方是**玩家**时不是「单位事件」✗ → 仍按玩家扫描 ✓；
  //   受方是**物件**时走通用广播 ✓（主体选择器 / 筛选 自动有 ✓）。
  if (typeof 受方 === 'number') {
    for (const o of [...g.战场]) {
      if (!有规则叙述(g, o)) continue;
      const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
      展开能力触发(abs).forEach(({ ab, i }) => {
        if (ab.种类 !== '触发式' || ab.触发.事件 !== '回复体力') return;
        if (ab.触发.受方 === '实体') return;
        g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '回复体力触发'), 触发受方: 受方 });
      });
    }
    return;
  }
  排队单位事件触发(g, '回复体力', 受方, { 触发受方: 受方, 受方类型: '实体' });
}
/**
 * 「每当<来源>对…造成伤害时」（033 徐晃「对**玩家**造成伤害」/ 702.14 斩获那类）。
 * ⚠ 判的是**来源**（谁造成的）—— 和 排队受到伤害触发 正好相反：
 *   那个遍历「被打的物件自己有没有受到伤害触发」，这个遍历全场、看谁的「造成伤害」触发成立。
 */
export function 排队造成伤害触发(g: GameState, 源: Obj, 受方: number | Obj | undefined, 量: number): void {
  const 对玩家 = typeof 受方 === 'number';
  for (const o of [...g.战场]) {
    if (!有规则叙述(g, o)) continue;                 // 709.2a
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    展开能力触发(abs).forEach(({ ab, i }) => {
      if (ab.种类 !== '触发式' || ab.触发.事件 !== '造成伤害') return;
      const 主体 = ab.触发.主体 ?? '自身';
      // 305.5a / 306.4k：能力挂在**装备或数术**上，看的是「**所佩带/所附属**的那个单位」做的事
      if (主体 === '所佩带' && o.佩带在 !== 源.uid) return;
      if (主体 === '所附属' && o.附属在 !== 源.uid) return;
      if (主体 === '自身' && o !== 源) return;            // 「当徐晃造成伤害时」
      // 其余 = **选择器**（「当某个…造成伤害时」）：事件里的物件是**来源**，锚是能力所在的物件 ✓
      //   主体 不是 '自身' 就**本来就是「另一个」** → 数据里的 `除:'自身'` `除:'自身'` ✓（数据不写 ✓）
      if (typeof 主体 !== 'string'
        && !符合选择器(g, 源, 主体, o, 有效控制器(g, o), 有效特征(g, 源))) return;
      // 033 徐晃「对**玩家**造成伤害」—— 通用判据 触发.受方（原来是一个一次性的 对玩家 字段）
      if (ab.触发.受方 !== undefined && ab.触发.受方 !== (对玩家 ? '玩家' : '实体')) return;
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '造成伤害触发'), 触发量: 量, 触发受方: 受方 });
    });
  }
}

/** 603：某个物件受到伤害后，把它自己那些「当此物受到伤害时」的触发放进待触发队列 */

/**
 * 「当**任一玩家**受到伤害时」（603.2，152 嗜血蛮骑）—— **扫描全场**。
 *
 * ⚠ 和 排队受到伤害触发 是两件事：那个是「**被打的物件自己**有没有受到伤害触发」，
 *   这个是「战场上有没有人**看着玩家**挨打」。判据用 触发.受方 === '玩家'
 *   （和 058 仁者的大德「当任一玩家回复体力时」同一个字段）。
 */
export function 排队玩家受到伤害触发(g: GameState, 玩家: number, 量: number): void {
  for (const o of [...g.战场]) {
    if (!有规则叙述(g, o)) continue;                 // 709.2a
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    展开能力触发(abs).forEach(({ ab, i }) => {
      if (ab.种类 !== '触发式' || ab.触发.事件 !== '受到伤害') return;
      if (ab.触发.受方 !== '玩家') return;
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, '玩家受到伤害触发'), 触发量: 量, 触发受方: 玩家 });
    });
  }
}

export function 排队受到伤害触发(g: GameState, o: Obj, 量: number, 受方?: number | Obj): void {
  // ⚠ 以前**只看这一个物件的自身触发** ✗ —— 走通用广播之后，「当另一个单位受到伤害时」也认了 ✓
  排队单位事件触发(g, '受到伤害', o, { 触发量: 量, 触发受方: 受方, 受方类型: '实体' });
}
/** ⚠ **事件广播的唯一实现** ✓ —— 「某个单位身上发生了某事」时，扫全场，
 *  让**每个**永久物按自己的 `触发.主体`（关系 → 字面量；其余 → 选择器）决定要不要触发 ✓。
 *  事件那一边**不做任何主体判断** ✗（那正是「进战场」以前手写枚举、只认自身、漏掉
 *  「另一个单位进场」的根因 ✗ —— 现在两种事件共用这一条路 ✓）。
 *  `事件` 目录：成为横置 / 进战场 …（新增事件名往这里加 ✓）
 */
/** ── **事件派发总表** ─────────────────────────────────────────────
 *  规则：`事件名`（types.ts:108）里的**每一个**事件，都必须在下面这张表里出现 ✓。
 *    · 加实现 → 填 派发 ✓
 *    · 暂时没实现 → 显式写 `未实现: true` ✓（启动时会吼一声 ✓，**不会静默失效**✗）
 *  因为类型是 `Record<事件名, …>` ✓ —— **往联合里加名字而这里没加 → 编译错** ✓。
 *  这就是「所有事件都从一处走」的保证 ✓（以前是 16 个手写函数互相不知道 ✗）。
 */
/** ── **事件派发总表**（唯一一张）──────────────────────────────────
 *  `事件名`（types.ts:108）里**每一个**事件都必须在这里出现 ✓ ——
 *    类型是 `Record<事件名, …>` ✓ → 往联合里加名字而这里没加，**编译就报** ✓（TS2741 ✓）。
 *
 *  「派发在哪」这一列是**实据**（file:line ✓）—— 这些事件各有自己的插入点：
 *    · 单位身上的事件（进战场 / 成为横置）走**通用广播** `排队单位事件触发` ✓
 *      （扫全场 ✓，让每个永久物按自己的 主体 选择器判 ✓ —— 不再手写枚举 ✗）
 *    · 玩家身上的事件（抓牌 / 打出牌）走 `排队事件触发` ✓
 *    · 伤害 / 回复 / 移动 / 面变化 / 宣告攻击 / 步骤 各有专门的入口 ✓（它们需要额外上下文：量/受方/施动者…）
 *
 *  ⚠ **未实现**那一列现在**是空的** ✓ —— 之前我错标了 13 个 ✗（其实都有派发 ✓），
 *    真正漏的只有「进战场」的**其他**分支 ✓（已修 ✓）。留这一列是为了以后有需要时**显式标注** ✓，
 *    而不是静默失效 ✗。
 */
export const 事件派发: Record<事件名, { 派发在哪: string; 未实现?: true; 派发?: (g: GameState, 受体: Obj) => void }> = {
  进战场: { 派发在哪: '排队进战场触发 → 排队单位事件触发（通用广播 ✓，扫全场）', 派发: (g, o) => 排队进战场触发(g, o) },
  成为横置: { 派发在哪: '排队单位事件触发（通用广播 ✓）engine.ts:1151', 派发: (g, o) => 排队单位事件触发(g, '成为横置', o) },
  死去: { 派发在哪: '排队死去触发 engine.ts:1462 ＋ 排队其他死去触发 :1464', 派发: (g, o) => { 排队其他死去触发(g, o); 排队死去触发(g, o); } },
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

/** `额外` = 这条事件特有的东西（受到伤害的「量」✓、宣告攻击的「受方」✓…）——
 *  统一由这里带进 pending ✓，各事件不必再自己写一遍扫描 ✗。 */
  /** ⚠ **触发标签只在这里拼** ✓ —— 以前 9 处各拼一份 ✗，于是同一个「打出牌触发」
 *  在「同时触发·决定顺序」那一屏里**两条一模一样**，玩家分不清哪条是哪张单位 ✓（2026-02 报的 ✓）。
 *  现在统一带上**所在阵地** ✓ —— 每个阵地最多一个单位 ✓，所以标签天然唯一 ✓；
 *  不在战场上（还没进场的牌 / 已离场）就不加括号 ✓。
 */
function 触发标签(o: Obj, 后缀: string): string {
  return o.def.全名 + (o.阵地 ? '（' + o.阵地 + '）' : '') + ' 的' + 后缀;
}

function 排队单位事件触发(g: GameState, 事件: '成为横置' | '进战场' | '移动' | '受到伤害' | '宣告攻击' | '回复体力' | '被指定为目标' | '死去' | '明置' | '暗置', 受体: Obj,
  额外?: { 触发量?: number; 触发受方?: number | Obj; 允许离场?: boolean; 死者位置?: 阵地 | null;
    /** 这条事件里的受方是**玩家**还是**实体** ✓（`触发.受方` 就是判它 ✓：058「玩家 / 单位」两条同事件触发 ✓） */
    受方类型?: '玩家' | '实体';
    /** 判 主体 选择器 / 触发.筛选 时用这份特征代替当前特征 ✓（明置/暗置：用**变化前**的特征 ✓ 709.2a） */
    特征覆盖?: unknown },
  /** 「事件里的那个来源」（打出牌的那张牌 / 点它的那个能力 ✓）—— 卡面写 触发.筛选来源 时判它 ✓ */
  来源?: Obj | null): void {
  const 触发名 = 事件 + '触发';   // 日志标签用 ✓
  // ⚠ **扫描范围要覆盖「事件受体自身」** ✓ —— 它可能**已经不在战场**了 ✗：
  //   「死去」（700.4）就是典型：`置入墓地()` 先 `移到区域(墓地)` ✓（engine.ts:1462 ✓），
  //     然后才广播「死去」✓ —— 这时死者已在墓地 ✓ → 只扫 `g.战场` 就**找不到它自己** ✗
  //     → 郭嘉（039 ✓ 触发:{事件:'死去',主体:'自身'}）那条「当郭嘉死去时…」永远不响 ✓（2026-02 报的 ✓）。
  //   所以候选 = 战场 ∪ {受体} ✓（受体已在战场时不重复 ✓）。「另一个」（选择器）仍只从战场里找 ✓。
  const 候选: Obj[] = [...g.战场];
  if (!候选.includes(受体)) 候选.push(受体);
  for (const o of 候选) {
    if (!有规则叙述(g, o)) continue;
    const 自己 = o === 受体;
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    展开能力触发(abs).forEach(({ ab, i }) => {
      if (ab.种类 !== '触发式' || ab.触发.事件 !== 事件) return;
      const 主体 = ab.触发.主体 ?? '自身';
      // ⚠ `触发.受方`（'玩家' / '实体'）：058「当任一玩家回复体力时」与「当一个单位回复体力时」
      //   是**同一个事件的两种受方** ✓ —— 不判它两条会一起排 ✗。
      if (额外?.受方类型 && ab.触发.受方 && ab.触发.受方 !== 额外.受方类型) return;
      // 判这件「主体」时的特征：明置/暗置用**变化前**的 ✓（709.2a）
      const 筛 = 额外?.特征覆盖 ?? 有效特征(g, 受体);
      if (typeof 主体 === 'string') {
        // 字面量 = **关系**：'自身' 看自己；'所附属'/'所佩带' 不归通用广播
        //   （它们由 排队死去触发 的反向扫场、排队造成伤害触发 单独处理 ✓）
        if (主体 !== '自身' || !自己) return;
      } else {
        // 其余一律是**选择器** ✓ —— 用**现成的** 符合选择器 判（和选目标/筛选同一套，不另写匹配 ✗）：
        //   锚 = 这个永久物（能力来源）→ 「另一个」由数据里的 `除:'自身'` 表达 `除:'自身'` 排除来源自己 ✓
        //   （主体 ≠ '自身' 本来就是「另一个」，**数据不写** ✓）；
        //   `操控者:'你'` = 和触发器**同一个操控者** ✓；
        //   `种类` / `筛选` 判受体特征 ✓。
        if (!符合选择器(g, 受体, 主体, o, 有效控制器(g, o), 筛 as 特征类型, 额外?.触发受方)) return;
        // ⚠ 还有 `触发.筛选`（同一个意思的另一种写法 ✓ 037 陈群的暗置触发用的就是它 ✗）——
        //   以前各派发自己读 ✗，通用广播只认主体的那套选择器 ✗ → 换过来就会漏筛 ✓。两个都读 ✓。
        if (ab.触发.筛选 && !符合筛选(g, 受体, ab.触发.筛选, 筛 as never)) return;
        // 「当某来源指定**另一个**单位为目标时」那种：来源要单独筛 ✓
        if (ab.触发.筛选来源 && (!来源 || !符合筛选(g, 来源, ab.触发.筛选来源, 有效特征(g, 来源)))) return;
      }
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, 触发名), 允许离场: true, 触发受方: 受体, ...(额外 ?? {}) });
    });
  }
}

/**
 * **按事件名给战场上的永久物排队触发**（603.2）。
 *
 * 适用于「主语是**你**（= 这个永久物的操控者）」的那一类事件：
 * 抓牌（121）/ 打出牌（601）/ 成为横置（701.26）…
 * 判定就是：**事件的受方 === 这个永久物的有效操控者**。
 *
 * ⚠ 之前给 `打出牌` 只加了 `记事件` 没加这个扫描 —— 067 武侯符阵兵 的触发因此从没发生过。
 */
export function 排队事件触发(g: GameState, 事件: '抓牌' | '打出牌' | '成为横置', 受方: number,
  /** 事件里的那个物件（打出牌 = 那张牌）——「当你打出**锦囊**令符时」靠 触发.筛选来源 筛它（065） */
  事件牌?: Obj): void {
  for (const o of [...g.战场]) {
    if (!有规则叙述(g, o)) continue;              // 709.2a：暗置的实体没有规则叙述
    if (有效控制器(g, o) !== 受方) continue;       // 「你抓一张牌」= 这个永久物的操控者抓的
    const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
    展开能力触发(abs).forEach(({ ab, i }) => {
      if (ab.种类 !== '触发式') return;
      if (ab.触发.事件 !== 事件) return;
      // ⚠ 两种写法都要读 ✓：065 用 `筛选来源` ✓，050/067 用 `触发.筛选`（同一个意思 ✗）。
      //   以前只读 筛选来源 ✗ → 050/067 的「锦囊」筛选被忽略 ✓ → 打出**任何**牌都会触发 ✗。
      const 判牌 = (条件?: unknown): boolean => !条件 || (!!事件牌 && 符合筛选(g, 事件牌, 条件 as never));
      if (!判牌(ab.触发.筛选来源)) return;
      if (!判牌(ab.触发.筛选)) return;
      g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, 事件 + '触发'), 触发受方: 受方 });
    });
  }
}

/**
 * **701.18「移动」的触发排队**。
 *
 * 两种卡面都覆盖：
 * · 「每当**侯成**移动时」—— `主体:'自身'`，只给**被移动的那个**排队（164）；
 * · 「每当一个**由你操控的单位**移动时」—— `主体:{ 种类:'单位', 操控者:'你' }`（124；
 *   「另一个」由数据里的 `除:'自身'` 表达 `除:'自身'` ✓，数据不写 ✓）。
 */
export function 排队移动触发(g: GameState, 单位: Obj): void {
  // ⚠ 以前是手写扫描 ✓，而且把「另一个」硬编码成「同操控者」✗（等于替卡面写死了 操控者:'你' ✓）。
  //   现在走通用广播 ✓：要不要看着别人、看着谁，由卡面 主体 里的选择器说了算 ✓。
  排队单位事件触发(g, '移动', 单位);
}
/**
 * 603：某个步骤开始时，把全场「当<某步骤>开始时」的触发放进待触发队列。
 * 步骤名就是 `g.当前步骤` 那一套（准备步骤 / 行动阶段 / 结束步骤…）。
 * ⚠ 有几条**引擎内部**的延时效应也挂在这里（702.37 重整、702.69b 再起的下个结束步骤放逐），
 *   它们不是牌的触发式能力 —— 加新的延时效应时照着这两条的写法挂，别另开一条流水线。
 */

/**
 * **扫守望者**（603.7 延迟触发）：事件发生了，把登记的延迟触发能力塞进待触发队列。
 *   `受体` = 事件的那个对象（进战场时是那个单位；步骤开始时不传）。
 *   ⚠ 操控者按 603.7d/e：**登记它的那个玩家**（守望.谁的），不是现在的操控者。
 */
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
  扫守望(g, '步骤开始', undefined, 步骤);   // 603.7：延迟触发（123 陈武「下一个结束步骤开始时」）
  // 702.37 重整：在你的结束步骤开始时，重置此单位并把体力回复至上限
  if (步骤 === '结束步骤') {
    // 702.69b 再起：「在下一个结束步骤开始时，将他放逐」
    // 「你操控的」= 有效控制器是当前回合玩家（战场不按玩家分，现算）
    const 我控 = g.战场.filter((o) => 有效控制器(g, o) === g.active);
    for (const o of [...我控]) {
      if (o.记忆['结束时放逐']) { 记录(g, '再起：' + o.def.全名 + ' 被放逐（702.69b）'); 放逐(g, o); }
    }
    for (const o of 我控) 排队关键词触发(g, o, '结束步骤');
  }
  for (const o of g.战场) {
    {
      const abs = (o.def.能力?.能力 ?? []) as TriggeredAbility[];
  if (!有规则叙述(g, o)) continue;   // 709.2a：暗置的实体没有规则叙述（这里是双层循环，必须 continue 不能 return）
      展开能力触发(abs).forEach(({ ab, i }) => {
        if (ab.种类 !== '触发式') return;
        if (ab.触发.事件 !== '步骤开始' || ab.触发.步骤 !== 步骤) return;
        const who = ab.触发.谁的回合 ?? '你';
        if (who === '你' && 有效控制器(g, o) !== g.active) return;   // 「你的回合」按有效操控者
        g.pending.push({ 来源: o, abilityIndex: i, 标签: 触发标签(o, 步骤 + '触发') });
      });
    }
  }
}

/** 603.3：把等待的触发式能力放进堆叠 */
/** 自动推进版（AI / 无界面场合）：模式与目标自动挑 */
/**
 * ⚠ **这个函数会用 AI 的默认宣告替玩家回答** —— 需要玩家自己选目标的触发式能力
 * （【后备虎骑】那种）会被**静默地自动选掉**，玩家根本不会被问。
 *
 * 服务器/界面用 **`把待触发放进堆叠G`**（生成器版），把「决定」发给玩家。
 * 名字里带 `_AI替玩家宣告` 就是为了让这件事在调用点看得见。
 */
export function 把待触发放进堆叠_AI替玩家宣告(g: GameState): void {
  const it = 把待触发放进堆叠G(g, { 允许打领土: false, 允许通常时机: false }, '');
  let r = it.next();
  while (!r.done) r = it.next(自动宣告(g, r.value.决定));
}

/** AI 用的默认宣告：第一个合法模式 + 优先敌方目标 */
export function 自动宣告(g: GameState, 决定?: 请求['决定']): Action | null {
  // 701.17 搜寻：AI 直接挑前 N 张候选
  if (决定 && 决定.类型 === '搜寻') {
    return { 种类: '决定', 接受: true, 选: 决定.候选.slice(0, 决定.数量).map((c) => c.uid) };
  }
  // 514 弃牌：AI 从手牌末尾挑（成本最低的近似）
  if (决定 && 决定.类型 === '弃牌') {
    return { 种类: '决定', 接受: true, 弃牌: g.players[g.active]!.hand.slice(-决定.需弃).map((c) => c.uid) };
  }
  // ⚠ **「选」这一类必须答**（选物件 / 选选项 / 选阵地…）—— 不答的话，
  //   应用选择 会写进一个空的「本次选择」，那一步看到「还没选」就又挂一次同一问，
  //   于是空转：日志里反复出现「甲 选了 （没有）」+ 双方让过，永远推不动。
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

/** 给一个触发式能力造出堆叠项（603.3）。`选择` 是 AI/客户端替玩家预先定好的模式与目标 */
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
    // 玩家指定的模式优先；否则自动挑第一个合法模式（AI / 无界面场合）
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
    if (m === null) return null;      // 同上：试探而已，日志由调用方记一次
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
  // ⚠ **目标不在这里选** —— 规则没规定时点，本引擎定为**结算时**（见 StackItem.待定目标）。
  //   这里只把规格挂上；候选要到结算那一刻才算（那时读到的才是当时的合法性）。
  const stepsT = ab.模式 ? ab.模式.选项[chosenMode!]!.效应 : ab.效应;
  return {
    id: g.nextStackId++, 种类: '触发式', 标签, 操控者: src.操控者,
    来源: src, card: null, 目标: [], 目标槽: {}, 待定目标: 预选 ? undefined : 目标清单,
    chosenMode, 可选: ab.可选, steps: stepsT, 触发量, 触发受方,
  };
}

/** uid → 实体。⚠ **只找战场和堆叠**（`取实体` 那一族找的是别处）—— 手牌/墓地/牌库里的牌它找不到 */
function 找实体(g: GameState, uid: number): Obj | null {
  for (const o of g.战场) if (o.uid === uid) return o;
  for (const it of g.stack) if (it.card && it.card.uid === uid) return it.card;
  return null;
}

/**
 * 组装「宣告」决定 —— **只问模式**（700.2b / 603.3c 明文：模式是能力的一部分、进堆叠时定）。
 * ⚠ **目标不在这里问** —— 规则没有规定时点，本引擎定为结算时，见 StackItem.待定目标。
 * 返回 null = 没有可宣告的模式（调用方按 603.3f 把它从堆叠移除）。**无模式的能力也返回 null**，
 *   但那表示「进堆叠时不用问任何东西」，调用方要分清这两种 null。
 */
function 组装宣告决定(g: GameState, src: Obj, ab: TriggeredAbility, 标签: string): 宣告决定 | null {
  const 触发时 = ab.目标时点 === '触发时';
  // 「若如此做」类：目标**触发时就选** —— 无模式但有目标时，这一问就是为它问的。
  if (!ab.模式) return 触发时 && (ab.目标 ?? []).length ? { 类型: '宣告', 标签, 来源uid: src.uid, 可选: ab.可选, 规格: 建规格(g, src, ab.目标!) } : null;
  const ms = ab.模式;
  const 已选 = (src.记忆[ms.记忆?.记忆键 ?? ''] as number[] | undefined) ?? [];
  const 我 = 有效控制器(g, src);
  const 模式候选: { 索引: number; 标签: string; 规格: 规格[] }[] = [];
  ms.选项.forEach((o, i) => {
    if (ms.记忆?.禁止重复 && 已选.includes(i)) return;
    // 700.2b / 603.3c：没有合法目标的模式不能被选（目标**合法与否**是状态属性，这里读一次）
    if (!(o.目标 ?? []).every((sp) => 候选目标(g, 我, sp, src).length > 0)) return;
    // 「若如此做」类：模式的目标**现在就问**；否则规格留到结算时再算（那时读到的才是当时的合法性）。
    模式候选.push({ 索引: i, 标签: o.标签, 规格: 触发时 ? 建规格(g, src, o.目标 ?? []) : [] });
  });
  if (模式候选.length === 0) return null;
  return { 类型: '宣告', 标签: 标签, 来源uid: src.uid, 可选: ab.可选, 模式候选 };
}

// ── 结算时的目标（规则没写时点，本引擎定为这里）────────────────
/** 目标规格 → 界面用的 规格（候选在**这一刻**算，所以是当时的合法性） */
function 建规格(g: GameState, src: Obj, specs: TargetSpec[]): 规格[] {
  const 我 = 有效控制器(g, src);
  return specs.map((sp) => ({
    目标名: sp.目标名, 数量: sp.数量,
    // ⚠ **必须把来源当锚传进来** ✗ —— 选择器的 `除:'自身'` 判据是 `o === 锚` ✓，
    //   不传锚就等于没排除自己 ✗ →【甘宁】的「另一个」单位会把自己也列进候选 ✓（实测记录 ✓）。
    候选: 候选目标(g, 我, sp, src).map((c) => (c.obj
      ? { 类型: '实体' as const, uid: c.obj.uid, 名称: c.obj.def.全名, 敌: 有效控制器(g, c.obj) !== 我 }
      : { 类型: '玩家' as const, 玩家: c.玩家!, 名称: g.players[c.玩家!]!.name, 敌: c.玩家 !== 我 })),
  }));
}

/** 生成器版：需要玩家选择时会 yield 一个「宣告」决定 */
export function* 把待触发放进堆叠G(g: GameState, opts: 时机选项, 步骤: string): Generator<请求, void, Action | null> {
  // ── 603.3b 的**第二步**（占位，未实现）────────────────────────────────
  // 规则原文：「首先…将他所操控的、**且不以另一个能力触发为触发条件的**触发式能力…放进堆叠。
  //           然后…将**其余**触发式能力…放进堆叠。」
  // 「以另一个能力触发为触发条件」＝ 触发条件本身是「某能力触发了」或「你如此做」（603.12 的自身触发，
  //   例：蛟龙潭「当你如此做时…」）—— 它们要排在第一批**之后**。
  // 判据将来长这样：触发.事件 里会有一种「某能力触发」/ 条目上带「因某个触发而生」的标记，
  //   现在**没有任何一张牌**用这种触发（引擎的触发事件表里也没有这个事件），所以这里先留空。
  // 真要做时：把 g.pending 里带该标记的挑出来，等第一批（不带标记的）全部处理完再处理。
  // ══ 603.3b：**同时触发的多条，由各自的操控者决定放进堆叠的顺序** ══
  // ⚠ 触发时能力**不在堆叠上**（只是 g.pending 里的待触发记录），所以这里按 待触发.id 指认，
  //   不能用 StackItem.id —— 那要等放进堆叠之后才有。
  //   规则（603.3）：谁被**后**放进堆叠，谁就在顶端，**先结算**。所以玩家给的次序 = 放进堆叠的次序。
  if (g.pending.length >= 2) {
    for (const t of g.pending) if (t.id === undefined) t.id = g.nextPendingId++;
    const 谁的 = (t: (typeof g.pending)[number]): number | null => {
      const ab = t.能力 ?? ((t.来源.def.能力?.能力 ?? []) as TriggeredAbility[])[t.abilityIndex];
      return ab && (t.来源.区域 === '战场' || t.允许离场) ? 有效控制器(g, t.来源) : null;
    };
    // 603.3b 的**次序**：每位玩家按照「**进攻玩家先做选择**」的顺序放（＝优先权那套 APNAP：
    //   进攻玩家 → 按回合顺序其他人）。所以先把队列按这个次序**稳定**排一遍，
    //   下面「问队头那个操控者」就自动是进攻玩家先问。
    //   规则 603.3 说放堆叠发生在「下一次有玩家得到优先权」**之前**，所以这是**放堆叠**的次序，
    //   不是「因为他有优先权」—— 两者只是用同一条 APNAP 原则。
    const APNAP = (t: (typeof g.pending)[number]): number => {
      const 控 = 谁的(t);
      return 控 === null ? g.players.length : (控 - g.active + g.players.length) % g.players.length;
    };
    g.pending = [...g.pending].sort((a, b) => APNAP(a) - APNAP(b));   // sort 是稳定的：同组内保持原序
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
          // 按玩家给的次序排（先给的先放进堆叠 → 更晚结算；最后给的在顶端 → 先结算）
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
      // ⚠ **两种 null 要分清**：有模式 = 模式全非法 → 603.3f 从堆叠移除；
      //   无模式 = 进堆叠时本来就不用问任何东西（目标留到结算）。
      if (有模式 && !t.预选) { 记录(g, t.标签 + '：没有可选模式，从堆叠移除（603.3f）'); continue; }
      const it = 造触发式堆叠项(g, t.来源, ab, t.标签, t.触发量, undefined, t.预选, t.触发受方);
      // 134：把「死者原先的阵地」一并带到堆叠项上（效应里读 item.死者位置）
      if (it) it.死者位置 = t.死者位置;
      if (it) 堆叠加(g, it);
      continue;
    }
    const 答 = yield { 玩家: t.来源.操控者, 时机: opts, 步骤, 决定 };
    g.pending.shift();
    if (!答 || 答.种类 !== '宣告') { 记录(g, t.标签 + '：未宣告，能力从堆叠移除'); continue; }
    // 「若如此做」类（`目标时点: '触发时'`）：目标已经在上面那一问里选好了，落成**预选** ——
    //   造触发式堆叠项 会把它写进 目标/目标槽，结算时就不再问。
    //   其余的（新标准「当你如此做时」）保持原样：目标留到结算。
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
      // 134：把「死者原先的阵地」一并带到堆叠项上（效应里读 item.死者位置）
      if (it) it.死者位置 = t.死者位置;
    if (it) 堆叠加(g, it);
  }
}

// ── 结算 ─────────────────────────────────────────────────────────
/**
 * 结算堆叠顶。**返回 false = 卡在等玩家选择上**（效应链挂起），调用方要 yield 决定。
 * 注意：挂起时**不能弹堆叠**（还要回来继续），所以改成结算完才 pop。
 */
export function 结算堆叠顶(g: GameState): boolean {
  const item = g.stack[g.stack.length - 1];
  if (!item) return true;
  // ⚠ **有「刚答完的选择」等着 → 令符的效应必须重跑** ✗ —— 否则一旦挂起过（301.11 选阵地 ✓），
  //   第二遍进来时 `已开始` 已经是 true ✓ → 下面那段整个被跳过 ✗ → 答案没人用 ✓
  //   （实测：选了阵地、`兵.阵地` 仍是 null ✓）。
  if (item.已开始 && item.本次选择 && item.种类 === '令符') {
    if (!结算令符(g, item)) return false;
    堆叠弹出(g); 收尾堆叠项(g, item); return true;
  }
  if (!item.已开始) {
    item.已开始 = true;
    // 608.2b：每个「目标」对应的目标均非法 -> 被规则取消
    if (!目标仍合法(g, item)) { 记录(g, item.标签 + ' 因目标全部非法而被规则取消'); 堆叠弹出(g); 收尾堆叠项(g, item); return true; }
    // ⚠ 触发式能力的目标是**结算时**才选的（规则书没规定时点，本引擎定的）。
    //   直接调本函数（测试 / AI）时没有人先问过，所以这里补一次判定：
    //   必需的目标一个都挑不出来 → 按 603.3f 的精神取消、不结算。
    if (item.待定目标 && item.待定目标.length) {
      const 锚 = item.来源 ?? item.card ?? null;
      const 控 = 锚 && typeof 锚 !== 'number' ? 有效控制器(g, 锚) : item.操控者;
      // ⚠ **没人问过目标时，这里替玩家挑** —— 直接调用（测试 / AI 驱动）就是这种情况。
      //   不挑的话，有目标的能力会**空着目标结算**：效应什么都不做，但日志看起来像正常结算
      //   （161 高顺的验证就踩了这个，只能拆成「验候选」+「手填目标验效应」两半）。
      //   口径和 自动宣告 一致：每个槽优先挑敌方的，其次第一个候选。
      if (item.目标.length === 0 && item.待定目标.length > 0) {
        let 挑得齐 = true;
        for (const sp of item.待定目标) {
          const 候 = 候选目标(g, 控, sp, 锚 as Obj | null, true, item.触发受方);
          if (候.length < sp.数量.最小) { 挑得齐 = false; break; }
          const 要 = Math.max(sp.数量.最小, Math.min(sp.数量.最大, 1));
          // 优先敌方（和 自动宣告 的 建规格 同一口径：物件的操控者 / 玩家的座位号）
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
        // ⚠ **挑不齐就别清**：留给下面那句「没有合法目标 → 603.3f 取消」
        //   （黑水祭天那条测试就是靠它：堆叠上没有令符时能力该被取消、不抓牌）
        if (挑得齐) item.待定目标 = undefined;
      }
      // ⚠ **校验玩家挑中的目标在不在候选里** ✗ —— 以前只查「候选够不够数量」✓，
      //   不查「那个目标合不合法」✗ → 客户端把非法对象传进来（例：甘宁把自己当『另一个』单位 ✓）
      //   就会照做 ✓（【甘宁】自换位就是这么来的 ✓）。
      if (item.待定目标) {
        const 合法集 = new Set<unknown>();
        for (const sp of item.待定目标) for (const c of 候选目标(g, 控, sp, 锚 as Obj | null, true, item.触发受方)) 合法集.add(c.obj ?? c.玩家);
        const 前 = item.目标.length;
        item.目标 = item.目标.filter((t) => 合法集.has(t));
        if (item.目标.length !== 前) 记录(g, item.标签 + '：挑中的目标不合法（不在候选里），已剔除');
        // 目标槽里也清掉不合法的（效应按 目标槽 取值 ✓）
        for (const k of Object.keys(item.目标槽 ?? {})) if (!合法集.has(item.目标槽![k])) delete item.目标槽![k];
      }
      const 缺 = item.待定目标 !== undefined && item.待定目标.length > 0
        && item.待定目标.some((sp) => 候选目标(g, 控, sp, 锚 as Obj | null).length < sp.数量.最小);
      if (缺) { 记录(g, item.标签 + '：没有合法目标，从堆叠移除（603.3f），不结算'); 堆叠弹出(g); 收尾堆叠项(g, item); return true; }
    }
    if (item.种类 === '令符') {
      if (!结算令符(g, item)) return false;      // 挂在选择上（搜寻等）→ 不弹堆叠
      堆叠弹出(g); 收尾堆叠项(g, item); return true;
    }
    // 循环里已经记过就不再记（直接调本函数时没经过循环，这里补上）
  }
  if (!执行步骤(g, item)) return false;            // 挂在选择上
  堆叠弹出(g);
  收尾堆叠项(g, item);
  return true;
}

/** 这一步里有没有「还没满足的选」引用（有就把那个引用拿出来） */
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

/**
 * 按游标执行效应链。返回 false = 挂起等玩家选择。
 *
 * ⚠ 「选」的挂起**不推进游标**：答复存进 `本次选择`，让**同一步重跑**一遍，
 *   由那个操作自己把选中的东西用掉。所以选不需要槽、也不是独立的一步。
 */
function 执行步骤(g: GameState, item: StackItem): boolean {
  item.步骤游标 ??= 0;
  // ⚠ **301.11：等着落位的单位**（由 完成搜寻 记进来 ✓ —— 它是同步函数 ✗ 发不了问）
  //   在这里处理 ✓：本函数能挂起（设 待选择 + return false ✓），答完本步重跑 ✓ 就能用掉答案 ✓。
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
        // 候选走 候选目标(…, false)：**关掉抵抗/洞察**，它们只管「不能成为目标」
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
    // 公共的「条件」（064 桃园结义那种「若本回合曾有…」）：不成立就整步跳过，
    //   并把 上一步生效 置 false —— 后面的「若前一效应生效」照常能接。
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

/** 玩家答完「搜寻」之后，把选择落实到牌上，并把游标推进一格 */
export function 应用选择(g: GameState, item: StackItem, 答: Action | null): void {
  const d = item.待选择;
  item.待选择 = undefined;
  if (!d) return;
  // ⚠ **不要 .map(Number)** —— 键可能是字符串（'接受' 这类选项）。只把数字当 uid 用。
  const 选 = (答 && 答.种类 === '决定' && Array.isArray(答.选)) ? (答.选 as (number | string)[]) : [];
    // ⚠ 可选门的答案单独存 ✓（标签含"你可以这样做"= 门）→ 不污染 op 的 本次选择 ✓
    if (d.类型 === '选' && typeof d.标签 === 'string' && d.标签.includes('你可以这样做')) {
      (item as unknown as { 本次门?: (number | string)[] }).本次门 = 选;
      return;
    }
  const 步骤 = item.steps[item.步骤游标!] as { 去处?: string; 从?: string[]; 玩家?: number } | undefined;
  if (false) {

  } else if (d.类型 === '选') {
    // 答复交给**本步**用：存进 本次选择，游标**不推进** —— 让同一步重跑一遍把它用掉。
    // 键可能是数字（物件 uid）也可能是字符串（'接受' 这类选项）—— 数字才去找物件，其余原样留着。
    const 找 = (键: number | string): Obj | number | string => {
      if (typeof 键 !== 'number') return 键;
      return g.战场.find((x) => x.uid === 键)
        ?? g.players.flatMap((p) => [...p.hand, ...p.library, ...p.graveyard]).find((x) => x.uid === 键)
        ?? (item.暂存 ?? []).find((x) => x.uid === 键)      // 搜寻摘进暂存、还没放回去的牌
        ?? g.放逐区.find((x) => x.uid === 键) ?? 键;
    };
    item.本次选择 = 选.map(找);
    // 挑领土付钱那种会在答复里带 支付源，本步要用 → 先存着
    const 源 = (答 as unknown as { 支付源?: number[] }).支付源;
    if (Array.isArray(源) && 源.length) item.本次支付源 = 源;
    记录(g, g.players[d.玩家]!.name + ' 选了 '
      + (item.本次选择.map((x) => (typeof x === 'number' ? String(x) : typeof x === 'string' ? x : x.def.全名)).join('、') || '（没有）'));
    return;                                   // ⚠ 不推进游标
  } else if ((步骤 && 步骤.去处 !== undefined) || (d as { 去处?: string }).去处 !== undefined) 完成搜寻(g, item, d, 步骤 ?? {}, 选.filter((x): x is number => typeof x === 'number'));
  item.步骤游标 = (item.步骤游标 ?? 0) + 1;
}

/** 把 搜寻 选中的牌从原区域移出并放到 去处 */
function 完成搜寻(g: GameState, item: StackItem, d: Extract<NonNullable<StackItem['待选择']>, { 类型: '搜寻' }>, 步骤: { 去处?: string; 玩家?: number; 筛选?: unknown }, 选: number[]): void {
  const pl = g.players[步骤.玩家 ?? item.操控者]!;
  const 看的是谁 = (d as { 玩家?: number }).玩家 ?? 步骤.玩家 ?? item.操控者;
  const 区域表: Record<string, Obj[]> = { 牌库: pl.library, 手牌: pl.hand, 墓地: pl.graveyard, 放逐区: g.放逐区, 战场: [...g.战场] };
  // 063 孙乾 是「**每位玩家**的牌库顶」——候选可能来自不同玩家，所以按 uid 在**所有人**的区域里找
  const 全区域 = [...Object.values(区域表), ...g.players.flatMap((x) => [x.library, x.hand, x.graveyard])];
  // 063 孙乾 是「**每位玩家**的牌库顶」——候选可能来自不同玩家，所以按 uid 在**所有人**的区域里找
  // 701.17d：在公开区域搜寻一定数量时**必须找出足量**；这里对不足的自动补齐（隐藏区域才允许放弃）
  const 定选 = d.可放弃 ? 选.slice(0, d.数量) : (() => {
    const 已 = 选.slice(0, d.数量);
    if (已.length >= d.数量) return 已;
    const 余 = d.候选.map((c) => c.uid).filter((u) => !已.includes(u));
    return 已.concat(余.slice(0, d.数量 - 已.length));
  })();
  const 可取 = new Set(d.候选.map((c) => c.uid));   // ⚠ 候选里**都是能挑的** ✓（要选什么就发什么 ✓），不再有逐张标记 ✗
  const 取: Obj[] = [];
  for (const uid of 定选) {
    if (!可取.has(uid)) {
      // ⚠ **不再默默丢掉** ✗→✓（用户口径：默默兜底 = 出了问题没人知道 ✓）。
      //   正常路径根本走不到这里（界面与 AI 都只该挑"能挑的"✓）；
      //   走到这里就是**内部出错** ✓ → 大声记一笔 ✓（乱发的包在接口层另外防 ✓，不靠这里 ✓）。
      记录(g, '⚠ 内部异常：选择里出现了不在候选内的牌（uid ' + uid + '），已忽略');
      continue;
    }
    for (const 区 of 全区域) {
      const i = 区.findIndex((c) => c.uid === uid);
      if (i >= 0) { 取.push(区.splice(i, 1)[0]!); break; }
    }
  }
  if (取.length === 0) {
    // 701.17b：隐藏区域可以选择不找出来；701.17c：标准未定义时也是「找不到」但搜寻照样发生
    记录(g, pl.name + ' 从' + d.区域 + '搜寻：没有找到任何牌' + (d.可放弃 ? '（701.17b：可以选择不找出来）' : ''));
    return;
  }
  for (const c of 取) {
    // 400.7：全部走 移到区域 / 进战场（它们各自负责摘旧区域）
    // ⚠ 走 移到区域 而不是只 push —— 要把它的 区域 改成 '暂存'，否则后面 放置暂存 调
    //   移到区域(…, '牌库') 会撞上「已经在该区域」的早退分支，牌就丢了（039 郭嘉）。
    if (步骤.去处 === '暂存') { 移到区域(g, c, '暂存'); (item.暂存 ??= []).push(c); }
    else if (步骤.去处 === '牌库顶') 移到区域(g, c, '牌库');
    // 111.2：默认操控者是「操控它进战场的玩家」= 执行这次搜寻/放置的玩家（牌可能来自对手）
    // ⚠ **301.11 缺口（留位 ✗）**：这里也是「把单位牌放进战场」✓，本该问阵地 ✓，
    //   但本函数（完成搜寻）是**同步函数** ✗ —— 发问要挂起（设 item.待选择 + 让本步重跑 ✓），
    //   而它的调用方（应用选择）答完会**推进游标** ✗ → 答了也用不上 ✓。
    //   正确做法：把 去处:'战场' 的落位**挪进 执行步骤 的一步**里 ✓（和 放置暂存 2970 同一处 ✓，
    //   那处**已经**按 301.11 问了 ✓）。改造前，这里对单位仍然**不问**（现状 ✗）。
    // ⚠ **301.11**：单位要**先选阵地** ✓ —— 本函数同步 ✗ 发不了问，所以只记「待放」✓，
    //   由 执行步骤 顶部接手（那里能挂起 ✓）；非单位按 403.1 落在阵地以外 ✓ 不问 ✓。
    else if (步骤.去处 === '战场') {
      if (是类别(g, c, '单位')) { (item.待放战场 ??= []).push(c); item.待放战场控 = pl.index; }
      else 进战场(g, c, pl.index, null);
    }
    // 400.3：进**拥有者**的墓地（149 清查「该玩家弃置该牌」/ 158 华歆「置入其拥有者的墓地」）
    else if (步骤.去处 === '墓地') 置入墓地(g, c);
    else 移到区域(g, c, '手牌');
  }
  const 去向 = 步骤.去处 === '战场' ? '放进战场' : 步骤.去处 === '牌库顶' ? '置于牌库顶' : 步骤.去处 === '墓地' ? '置入墓地' : 步骤.去处 === '暂存' ? '（暂存待放）' : '置于手上';
  // 701.17e：没写「展示」就不把牌名写进日志（日志是所有人可见的）
  // 「若如此做」的判据：**真的把牌放过去了**才算这一步生效（063 孙乾靠它分岔）
  item.上一步生效 = true;
  // ⚠ 搜寻本身**不报牌名** ✓（它是私密找牌 ✓）—— 牌面写了「展示」的由**另一条 展示 操作**去做 ✓。
  记录(g, pl.name + ' 从' + d.区域 + '搜寻到 ' + 取.length + ' 张牌（未展示，' + 去向 + '）');
}

/**
 * 一个堆叠项结算完之后的收尾：令符没留在战场就进墓地（608.2），再清掉它的状态。
 * ⚠ 这是**唯一**的堆叠项回收点 —— 别在结算的各个分支里自己 `splice` 掉堆叠。
 */
function 收尾堆叠项(g: GameState, item: StackItem): void {
  if (item.种类 === '令符' && item.card && item.card.区域 === '堆叠') {
    // 未能留在战场的令符进墓地
    置入墓地(g, item.card);
  }
}

/** 返回 false = 效应链挂在等玩家选择上（例如 701.17 搜寻），此时**不能弹堆叠** */
function 结算令符(g: GameState, item: StackItem): boolean {
  const o = item.card!;
  const p = item.操控者;
  记录(g, '结算：' + o.def.全名);
  if (o.def.类别.includes('单位')) {
    // ⚠ **301.2 + 301.11 只有一条规则**：把单位牌放进战场时，阵地必须先有 ✓ ——
    //   301.1「打出时选定『打出阵地』」✓ → 这里用它 ✓；**没有就不许替玩家挑** ✗
    //   （以前的 `?? 第一个空阵地` 是引擎自造的行为 ✗：301.2 说放**打出阵地** ✓，
    //     301.10 说阵地不合法则留在当前区域 ✓ —— 都没有「随便挑一个」这条 ✓）。
    //   缺阵地时按 301.11 挂起问玩家 ✓（答完本步重跑 → 用掉 本次选择 ✓）。
    let 阵地 = item.chosenSlot ?? null;
    if (!阵地 && item.本次选择 && typeof item.本次选择[0] === 'string') {
      阵地 = item.本次选择[0] as 阵地;
      item.本次选择 = undefined;
    }
    if (!阵地) {
      const 空 = 阵地顺序.filter((s2) => !g.players[p]!.阵地[s2]);
      if (!空.length) {
        // 301.10：没有合法阵地 → 留在当前区域；当前区域是堆叠 → 置于拥有者墓地 ✓
        记录(g, '301.10：没有可用的阵地，' + o.def.全名 + ' 留在当前区域');
        置入墓地(g, o);
        return true;
      }
      item.待选择 = { 类型: '选', 选什么: '阵地',
        标签: '301.11：为 ' + o.def.全名 + ' 选择一个进战场的阵地（' + g.players[p]!.name + ' 的空阵地）',
        玩家: p, 数量: { 最小: 1, 最大: 1 }, 候选: 空.map((x) => ({ 键: x, 名称: x })) };
      return false;        // 挂起等玩家选 ✓
    }
    if (阵地) 进战场(g, o, p, 阵地);
    else { 记录(g, '没有可用的阵地'); }
    return true;
  }
  // 306.2：阵略结算 → 在其操控下放置进战场（**不占阵地**，403.5b）
  // 305.2：战器同理
  // 牌面写的效应（牌效应 那串 操作）也要执行
  if (o.def.类别.includes('阵略') || o.def.类别.includes('战器')) {
    // 306.4b：数术/阵略进场时**附属于**它打出时指定的目标
    const 首 = item.目标.find((x) => typeof x !== 'number') as Obj | undefined;
    const 玩家目标 = item.目标.find((x) => typeof x === 'number') as number | undefined;
    // 306.4b：按 701.4 的「附属」动作附上去（别在这里手写字段）
    if (首) 附属(g, o, 首.uid); else if (玩家目标 !== undefined) 附属(g, o, 玩家目标);
    进战场(g, o, p, null);
    // （日志由 附属() 统一记，这里不再重复）
    执行步骤(g, item);
    return !item.待选择;
  }
  // 锦囊
  写区域(g, o, '堆叠');
  执行步骤(g, item);
  return !item.待选择;      // 挂起了就交给调用方去 yield 决定
}

/** 按 `阵地顺序` 找第一个空阵地（301.8 移过来、新单位进场都用它） */
function 第一个空阵地(g: GameState, p: number): 阵地 | null {
  for (const s of 阵地顺序) if (!g.players[p]!.阵地[s]) return s;
  return null;
}


/**
 * **`Value` → 数字**（108.4 的动态数值）。`{ 数: 选择器 }` 会**真的去数**符合条件的物件，
 * 所以它会调 `候选目标` → `有词` → `计算特征` —— 这条链可能绕回正在算的地方，
 * 见 `continuous.ts` 里那段递归保护的说明。
 * `记忆源` 是「触发事件量」这类要读谁的问题：读触发来源的记忆，不是当前效应的。
 */
function 取值(g: GameState, 控制器: number, v: Value, o?: Obj, 记忆源?: Obj, 宣告X?: number): number {
  // 108.3a：费用里带 {X} 的牌/能力，效应里的 'X' 就是宣告的那个数（调用方从 item.宣告X 传进来）
  // ⚠ **先判数字** —— 这一步以前被「不是对象就 0」挡在后面，于是条件里的字面量（`>= 2` 的 2）
  //   全被判成 0，整个比较恒真：028/029 那种「只要…就 +N」的层会**无条件生效**。
  if (typeof v === 'number') return v;
  if (v === 'X') return 宣告X ?? 0;          // 108.3a：费用里带 {X} 的牌/能力
  if (!v || typeof v !== 'object') return 0;
  // 「乘以系数」（107 黄盖「每已损失 1 点体力，便 +2 武力」）—— 递归求内层再乘
  if (typeof v !== 'number' && '乘以' in v) return 取值(g, 控制器, v.乘以, o, 记忆源, 宣告X) * v.系数;
  if (typeof v !== 'number' && '加' in v) return 取值(g, 控制器, v.加, o, 记忆源, 宣告X) + v.值;
  if (typeof v === 'number') return v;
  if ('player' in v) {
    const pl = g.players[控制器]!;
    if (v.stat === '体力') return pl.体力;
    if (v.stat === '体力上限') return pl.lifeMax;
    return pl.hand.length;
  }
  // 「这个物件自己的」属性 —— 只有判定点知道是哪个物件时才算得出来
  if ('自身' in v) {
    if (!o) return 0;
    if (v.自身 === '武力') return 武力(g, o);
    if (v.自身 === '体力上限') return 体力上限(g, o);
    return o.damage;                       // 「已受伤」= 已失去的体力（120.5）—— **不是标记** ✓
  }
  // 「符合条件的物件有几个」（例如「三个或更多【魏领土】」）
  if ('数' in v) {
    const 候 = 候选目标(g, 控制器, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: v.数 }, o ?? null);
    // 「**你**墓地里的」那种（135 黄巾大军）：非战场区域的候选本来跨所有玩家，写了 操控者 就按**拥有者**收窄。
    //   战场上的候选本来就按有效操控者筛过了，这一步对它们是空操作。
    const 谁 = 取条件(v.数, '操控者');
    if (谁 === undefined || 谁 === '任意') return 候.length;
    return 候.filter((c) => !!c.obj
      && (谁 === '你' ? c.obj.owner === 控制器 : c.obj.owner !== 控制器)).length;
  }
  // 「记住」下来的数（效应之间的变量）
  if ('记忆' in v) return Number(记忆源?.记忆[v.记忆] ?? 0);
  return 0;
}
/**
 * **`Condition` → 真假**（「只要…」「若…」）。与/或/非在这里递归，具体的比较在 `符合一个条件` 那一族。
 * 传进来的 `控制器` 就是条件里「你」的含义 —— 调用方必须给**有效操控者**，别给印制值。
 */
function 判断(g: GameState, 控制器: number, c: Condition, o?: Obj, item?: StackItem): boolean {
  if (c.操作 === '与') return c.参数.every((x) => 判断(g, 控制器, x, o, item));
  if (c.操作 === '或') return c.参数.some((x) => 判断(g, 控制器, x, o, item));
  if (c.操作 === '非') return !判断(g, 控制器, c.参数, o, item);
  // 306.4b：这个物件是否附属于「目标」槽里的那个东西
  // 306.4b：这个物件是否附属于某个实体。
  // ⚠ c.目标 在 持续 操作 结算时已经**解析成 uid 字符串**了（见那里的注释）
  if (c.操作 === '附属在') return o?.附属在 !== undefined && o.附属在 === Number(c.目标);
  // 「若本回合曾有…」（064 桃园结义）—— 查事件记录：事件名 + 本回合 + 受方的操控者/特征
  if (c.操作 === '本回合发生过') {
    const 找物 = (uid: number): Obj | undefined =>
      g.战场.find((x) => x.uid === uid)
      // ⚠ **堆叠也要找** ✗→✓：`打出牌` 事件的受方就是那张牌 ✓，而它此刻正躺在**堆叠**上 ✓
      //   （`写区域(g, o, '堆叠')` 在记事件之前 ✓）。漏了这里 → 找物 返回 undefined
      //   → 「本回合发生过 打出牌 锦囊」**永远为假** ✗ →【天监智囊】的「第一个锦囊 −2」
      //   会在**整回合每一张**锦囊上都生效 ✓（2026-10 报的：连续两张【看破】【无懈可击】都免费 ✗）。
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
  // 「于对手的回合中」这类 —— 比较的是**当前回合玩家**和这个条件的判定者
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

/**
 * 解析一个「受方」（效应的作用对象）。
 * ⚠ 只返回**牌/实体和玩家** —— 堆叠上的能力当不了效应的受方（那是「目标」，不是「受方」）。
 */
function 解析受方(g: GameState, item: StackItem, r: any): (Obj | number)[] {
  if (r.ref === '操控者') return [item.操控者];
  if (r.ref === '额外牺牲') return item.额外牺牲 ? [item.额外牺牲] : [];
  if (r.ref === '自身') return item.来源 ? [item.来源] : (item.card ? [item.card] : []);
  // 「该玩家」/「该单位」= 触发这件事的那个受方
  if (r.ref === '触发受方') return item.触发受方 === undefined ? [] : [item.触发受方];
  // 「记住」下来的受方（玩家号或物件）
  if (r.记忆 !== undefined) { const v = 读记忆(item, r.记忆); return v === undefined ? [] : [v as number | Obj]; }
  // 效应链暂存位里的牌（「搜寻 …… 该牌 ……」）
  if (r.ref === '暂存') return [...(item.暂存 ?? [])];
  if (r.目标 !== undefined) {
    const t = item.目标槽?.[r.目标];
    // 指向「堆叠上的能力」的目标当不了受方 —— 直接当没有
    if (t !== undefined && t !== null && !(typeof t === 'object' && '堆叠项' in t)) return [t];
    // 兜底：老数据没有槽映射时，退化成取第一个实体目标
    const 实体 = item.目标.map(取实体).find((x): x is Obj => !!x);
    return 实体 === undefined ? [] : [实体];
  }
  // 玩家**在这一步**挑的东西（用完即弃，见 StackItem.本次选择）——
  //   它不是目标：不受 702.2b 抵抗 / 702.3b 洞察 限制（那两条只管「不能成为目标」）。
  //   选项选（'接受' 这类字符串）不会走到这里 —— 引用形态只用来取物件。
  if (r.选 !== undefined) return (item.本次选择 ?? []).filter((x): x is Obj | number => typeof x !== 'string');
  if (r.selectRelation) {
    const src = item.来源 ?? item.card;
    if (!src || !src.阵地) return [];          // 来源没阵地 → 取不到相对/相邻/斜对 → 没有受方
    const src阵地 = src.阵地;
    const 我 = 有效控制器(g, src);          // 「自己/敌方阵地」按有效操控者
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
    // 145 雷击：从符合条件的一批里**随机**抽 N 个（用 g.随机源，和洗牌同源）
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

/**
 * **把「哪个玩家」解析成一串玩家号**。
 * · 省略 / `'你'` → 这个能力的操控者（单个）；
 * · 数字 → 那个玩家；
 * · `RecipientRef` → 解析受方里的**玩家**那一部分（物件会被丢掉）；
 *   `{ selectAll: { 种类:'玩家' } }` 因此能给出**全部玩家**（「每位玩家各一次」）。
 * ⚠ 永远返回非空数组（最差是 [item.操控者]），调用方直接 for-of 即可。
 */
function 解析玩家们(g: GameState, item: StackItem, r: 玩家指向 | undefined): number[] {
  if (r === undefined || r === '你') return [item.操控者];
  if (typeof r === 'number') return [r];
  const 出 = 解析受方(g, item, r).filter((x): x is number => typeof x === 'number');
  return 出.length ? 出 : [item.操控者];
}

/**
 * **效应的「变量」** —— 存在**来源（或令符本身）的 `记忆`** 里。
 * 存来源上的原因：159 下毒那种「进战场时选一位玩家，**之后每回合**都对他生效」要跨回合活着。
 */
function 记忆宿主(item: StackItem | null | undefined): Obj | null { return item?.来源 ?? item?.card ?? null; }
/** 读效应暂存的记忆。⚠ 记忆挂在**宿主**上（见 `记忆宿主`），不是挂在堆叠项上 —— 堆叠项结算完就没了 */
function 读记忆(item: StackItem | null, 键: string): unknown {
  if (!item) return undefined;
  return 记忆宿主(item)?.记忆[键];
}
/** 写效应暂存的记忆。宿主找不到就什么都不做（效应来源已经离场） */
function 存记忆(g: GameState, item: StackItem, 键: string, 值: unknown): void {
  const 宿主 = 记忆宿主(item);
  if (宿主) 写记忆(g, 宿主, 键, 值);
}

/** 120.4：一个伤害事件，多个受方 */
/** 一条正在被处理的伤害 */
interface 伤害条目 { 目标: Obj | number; 数量: number; 来源: Obj | null; /** 509.4：是不是战斗伤害（086 大雾要判它） */ 战斗伤害?: boolean; 射击伤害?: boolean }   // 射击伤害见 702.10c（106 蒋钦）

/** 一条适用的替代性/防止性效应 */
interface 适用效应 {
  键: string;
  规格: ReplacementSpec;
  /**
   * 效应的**来源实体**。⚠ 可以是 null —— 持续性效应的来源可能已经离开战场
   * （611.2a：甘夫人被移回手牌后，那个「直到回合结束」的加成照样在）。
   * 需要「这是谁的效应」时一律用下面的 控制器，不要用 持有者.操控者。
   */
  持有者: Obj | null;
  /** 这条效应**归谁** —— 来源离场后仍然有效，所以必须单独记一份 */
  控制器: number;
  时间印记: number;
  说明: string;
  /** 509.4：这是不是战斗伤害（086 大雾「防止所有**战斗伤害**」要判它） */
  战斗伤害?: boolean;
  /** 这次伤害是不是**射击能力**造成的（702.10c）—— 106 蒋钦的替代要看它 */
  射击伤害?: boolean;
}

/** 递归深度护栏：614.6 的新事件可能再次被替代 */
let 替代深度 = 0;

/**
 * 一条替代性规格**是否适用于**这个伤害条目。
 * ⚠ 判据只写在这里**一份** —— 常驻的静止式（源在场）和有限期的持续效应（载荷是替代）
 *   是同一类东西的两个来源，条件判断不该各写一遍。
 *
 * ⚠⚠ **受方与来源是两个不同的物件**，不能混用一个参数：
 *   · `受方: '自身'` 指**这个效应所附着的对象**，可能是一个也可能是**一批**：
 *       - 046 奋迅（持续 + 目标）→ 那一个目标单位；
 *       - 041 主将的鼓舞（持续 + selectAll）→ **范围内每一个**由你操控的单位。
 *   · `来源: '自身'`（609.7）指**效应的来源** —— 奋迅那条是那张锦囊本身。
 *   静止式能力两者恰好是同一个物件，持续效应则常常不是（这就是 046 的关键）。
 */
function 替代适用于伤害(g: GameState, r: ReplacementSpec, 受方判断: (o: Obj) => boolean, 来源对象: Obj | null, 控制器: number, 条目: 伤害条目): boolean {
  if (r.替代.事件 !== '伤害' && r.替代.事件 !== '造成伤害') return false;
  const 受 = r.替代.受方;
  if (受 === '自身') {
    if (typeof 条目.目标 === 'number' || !受方判断(条目.目标)) return false;
  } else if (受 === '你') {
    const 谁的 = typeof 条目.目标 === 'number' ? 条目.目标 : 有效控制器(g, 条目.目标);
    if (谁的 !== 控制器) return false;
  }
  if (r.替代.来源 === '自身' && (!来源对象 || 条目.来源 !== 来源对象)) return false;   // 609.7
  // 「某个由你操控之**其他单位**的射击能力」（106 蒋钦）——
  //   其他 = 数据里的 `除:'自身'`的 `除:'自身'`（锚 = 效应来源 = 蒋钦自己；**数据不写** ✓）、
  //   单位 = 种类:'单位'、由你操控 = 操控者:'你' —— 全在选择器里，用**现成的** 符合选择器 判 ✓。
  // ⚠ 这是 `替代.来源`（替换式里「伤害是谁造成的」），**另一套字段** —— 别和 `触发.主体` 混；
  //   两处用的是**同一套选择器词汇** ✓（「另一个」都由数据里的 `除:'自身'` 表达 ✓）。
  if (r.替代.来源 !== undefined && typeof r.替代.来源 !== 'string') {
    const 源 = 条目.来源;
    if (!源 || !符合选择器(g, 源, r.替代.来源, 来源对象, 控制器, 有效特征(g, 源))) return false;
  }
  // 086 大雾：只挡**战斗伤害**（条目上的标记，见 509.4）
  if (r.限战斗伤害 !== undefined && !!条目.战斗伤害 !== r.限战斗伤害) return false;
  // 702.10c：射击伤害 = 以**射击能力**造成的伤害（106 蒋钦）—— 标记来自 StackItem.能力名
  if (r.限射击 && !条目.射击伤害) return false;
  if (r.条件 && !判断(g, 控制器, r.条件)) return false;
  return true;
}

/**
 * 614 / 615：收集所有对这条伤害适用的替代性与防止性效应。
 * 排序用 613.7a 的时间印记（静止式能力用它所在物件的印记）。
 */
function 收集伤害替代效应(g: GameState, 条目: 伤害条目): 适用效应[] {
  const out: 适用效应[] = [];
  // 来源①：战场上的**静止式能力**（常驻 —— 源在场就有效）
  for (const o of g.战场) {
    const abs = (o.def.能力?.能力 ?? []) as StaticAbility[];
    abs.forEach((ab, i) => {
      if (ab.种类 !== '静止式' || !ab.替代效应) return;
      // 静止式：受方对象和来源对象都是它自己
      // 受方：默认「它自己」（'自身'）；写了 '任意' 就不限制（106 蒋钦那种「别人打谁都加 1」）
      const 受方判断 = ab.替代效应.替代.受方 === '任意' ? (() => true) : ((x: Obj | null) => x === o);
      if (!替代适用于伤害(g, ab.替代效应, 受方判断, o, 有效控制器(g, o), 条目)) return;
      out.push({
        键: o.uid + '#' + i, 规格: ab.替代效应, 持有者: o,
        控制器: 有效控制器(g, o), 时间印记: o.时间印记,
        说明: ab.替代效应.说明 ?? (o.def.全名 + ' 的替代性效应'),
      });
    });
  }
  // 来源②：**有限期**的替代效应（持续 op 压进 g.连续效应 的那些）。
  //   ⚠ 和来源①是**同一类东西** —— 都是持续性效应，只是一个「源在场就有效」、
  //     一个「持续到回合结束/游戏结束」。判据共用 替代适用于伤害，不写第二套。
  //     041 主将的鼓舞 / 046 奋迅 就靠这条。
  for (const c of g.连续效应) {
    const 替 = c.载荷.替代;
    if (!替) continue;                             // 这条持续效应只有「层」那一半
    // 持续效应：**受方对象**是它附着的那个物件（持续 op 带目标时就是那个目标 —— 046 奋迅），
    //   **来源对象**是效应的来源（那张锦囊）。两者常常不是同一个。
    // **受方判断**：这条持续效应作用到哪些物件。三种写法，从具体到一般：
    //   · 指定了某个对象（持续 op 带目标，如 046 奋迅）→ 就是那一个；
    //   · 锁定了物件组（611.2c，效应开始时锁定）→ 在那个组里；
    //   · 只给了范围（selectAll，如 041 主将的鼓舞）→ 现算选择器。
    //   ⚠ 以前这里只处理了「指定」那一种，所以 041 那种**一批**的防止完全不生效。
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
  // 702.6 坚韧 N：如果某来源将对此单位造成伤害，则防止其中的 N 点
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

/**
 * 616.1：从适用效应里挑一个先生效。
 * 616.1a 有自我替代性效应时必须先选它们之一；616.1e 其余情况任选一个。
 */
function 选择生效的(适用: 适用效应[]): 适用效应 {
  const 自我 = 适用.filter((x) => x.规格.自身替代);
  return 自我[0] ?? 适用[0]!;
}

/** 614.1e：按运算改写数量 */
function 按运算(前: number, 运: { 运算: string; 值: number }): number {
  if (运.运算 === '加') return 前 + 运.值;
  if (运.运算 === '减') return 前 - 运.值;
  if (运.运算 === '乘') return 前 * 运.值;
  return 运.值;
}

/**
 * 614 + 615 + 616：把一条伤害通过替代性与防止性效应处理到底。
 * 返回改写后的数量；0 表示这个伤害事件根本不发生（120.9）。
 * 616.1f：选中的效应生效后，对剩余仍适用的效应重复此过程。
 */
function 施加替代与防止(g: GameState, 条目: 伤害条目): number {
  if (替代深度 > 8) { 记录(g, '替代性效应递归过深，停止（护栏）'); return 条目.数量; }
  const 已用 = new Set<string>();          // 614.5：每个效应对每个事件只有一次机会
  let 数量 = 条目.数量;
  let 守卫 = 0;
  while (守卫++ < 16) {
    if (数量 <= 0) break;                  // 614.7a：0 点伤害从未造成，增加/转移类效应无事件可替代
    const 适用 = 收集伤害替代效应(g, { ...条目, 数量 }).filter((x) => !已用.has(x.键));
    if (适用.length === 0) break;
    const 选 = 选择生效的(适用);
    if (适用.length > 1) {
      记录(g, '616.1：' + 适用.map((x) => x.说明).join('、') + ' 都适用；先应用「' + 选.说明 + '」');
    }
    已用.add(选.键);
    const r = 选.规格;
    if (r.略过) {                          // 614.1b
      记录(g, 选.说明 + '：略过这个伤害事件');
      数量 = 0;
      continue;
    }
    const 旧防止 = r.应用?.find((x) => x.操作 === '防止');
    const 防值 = r.防止 ?? (旧防止 && 旧防止.操作 === '防止' ? 旧防止.点数 : undefined);
    if (防值 !== undefined) {              // 615
      const 实防 = Math.min(防值, 数量);
      数量 -= 实防;
      记录(g, 选.说明 + '：防止 ' + 实防 + ' 点伤害（剩 ' + 数量 + '）');
      continue;
    }
    if (r.数量) {                          // 614.1e
      const 前 = 数量;
      数量 = Math.max(0, 按运算(数量, r.数量));
      记录(g, 选.说明 + '：伤害 ' + 前 + ' → ' + 数量);
      continue;
    }
    if (r.应用 && r.应用.length) {       // 614.1a / 614.6：换成另一件事
      记录(g, 选.说明 + '：改为其它事件（原事件从未发生）');
      替代深度++;
      try {
        const 假项: StackItem = {
          id: g.nextStackId++, 种类: '触发式', 标签: 选.说明,
          操控者: 选.控制器, 来源: 选.持有者, card: null,   // 来源可能已离场 → 用 控制器
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

/**
 * **119 伤害事件** —— 全场唯一的伤害入口。它按顺序做四件事：
 *   ① 702.23b 舍身重定向；② 记「受到伤害」「造成伤害」事件并排队触发；
 *   ③ 逐个受方走 614/615 的**替代与防止**管线（`施加替代与防止`）；
 *   ④ 把**算完之后**的数量落到实处（玩家扣体力 / 单位加 damage / 化身移灵值）。
 *
 * ⚠ 数量必须是**管线算完之后**的那个：全部被防止时按 120.9 整个事件不发生，
 *   既不记账也不触发。直接改 `r.目标.damage` 会绕过防止与触发。
 */

export function 伤害事件(
  g: GameState,
  来源: Obj | null,
  受方: { 目标: Obj | number; 数量: number; 来源?: Obj | null; 战斗伤害?: boolean; 不能被防止?: boolean; 射击伤害?: boolean }[],
): void {
  // 702.23b 舍身：「如果某来源将**对你**将造成**战斗伤害**，你可以改为该来源对**此实体**造成伤害，
  //   且该伤害**不能被防止**。」—— 这里自动替玩家挨（对玩家总是有利；「你可以」的选择留给将来的界面）
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
  // 614 / 615 / 616：逐个受方走替代与防止管线
  const 实际 = 有效.map((r) => {
    // 702.2c：受方具有某「<特征>抵抗」、而这次伤害的**来源具有该特性** → 伤害被**防止**。
    //   120.9：被完全防止的伤害**没有发生** —— 所以要在记事件之前拦，不能等管线算完再改 0。
    {
      const 源0 = r.来源 ?? 来源;
      if (typeof r.目标 !== 'number' && 源0 && 抵抗挡住伤害(g, r.目标, 源0)) {
        记录(g, '抵抗（702.2c）：' + r.目标.def.全名 + ' 不会被 ' + 源0.def.全名 + ' 造成伤害');
        return { ...r, 来源: 源0, 数量: 0 };
      }
    }
    const 源 = r.来源 ?? 来源;
    // 120.9：**先走 614/615 的替代与防止管线**，算完之后才决定这次伤害事件是否发生 ✓
    //   ⚠ 以前两处 `记事件` 写在**管线之前**（用管线前的数量 ✗）→ 被完全防止的伤害照样记账、照样触发 ✗
    //     【敕令流放】要的正是「本回合造成过伤害的单位」✓ —— 打【小乔】（防止自己受到的所有伤害 ✓）
    //     的单位**不该**被算进去 ✓（被防止 = 没发生 ✓）。
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
      // 702.14b 斩获：此来源对玩家造成的伤害，使其操控者回复等量体力
      if (源 && 带词(g, 源, '斩获')) {
        const 得主 = g.players[有效控制器(g, 源)]!;   // 「此来源的操控者」按有效操控者
        得主.体力 = Math.min(得主.体力 + r.数量, 得主.lifeMax);
        记录(g, '斩获：' + 得主.name + ' 回复 ' + r.数量 + ' 点体力（702.14b）');
      }
      // 122.1d：玩家受到的伤害会导致其移去等量的天命标记
      const 天命 = pl.标记['天命'] ?? 0;
      if (天命 > 0) {
        const 移 = Math.min(天命, r.数量);
        pl.标记['天命'] = 天命 - 移;
        记录(g, pl.name + ' 移去 ' + 移 + ' 个天命标记（122.1d，剩 ' + pl.标记['天命'] + '）');
      }
      // 152 嗜血蛮骑「当**任一玩家**受到伤害时」—— 玩家这条以前**根本没有排队调用**
      排队玩家受到伤害触发(g, r.目标, r.数量);
      continue;
    }
    // 302.6：对化身造成的伤害会导致该化身移去等量的灵值标记
    if (是类别(g, r.目标, '化身')) {
      const 灵 = r.目标.标记.find((m) => m.类型 === '灵值');
      const 移 = Math.min(灵 ? 灵.数量 : 0, r.数量);
      if (灵) { 灵.数量 -= 移; if (灵.数量 <= 0) 写标记表(g, r.目标, r.目标.标记.filter((m) => m !== 灵)); }
      记录(g, r.目标.def.全名 + ' 移去 ' + 移 + ' 个灵值标记（302.6）');
      continue;
    }
    写伤害(g, r.目标, r.目标.damage + r.数量);
    if (有致命 && 是类别(g, r.目标, '单位')) 写记忆(g, r.目标, '致命伤害', true);   // 704.5e
    排队受到伤害触发(g, r.目标, r.数量);
  }
  检查状态动作(g);
}

/**
 * 关键词 → 触发式能力（702.12 突击 / 702.13 迎击 / 702.37 重整…）
 * 卡面只写关键词的名字，触发和效应由引擎这里按 702 章生成。
 *
 * 名字从 能力.能力 里读（那个能力的 名称 字段）。
 */
export function 排队关键词触发(g: GameState, o: Obj, 时机: '结束步骤' | '进入相对阵地', 进入者?: Obj): void {
  if (o.区域 !== '战场' || !有规则叙述(g, o)) return;
  const 名字们 = ((o.def.能力?.能力 ?? []) as { 名称?: string }[])
    .map((ab) => ab.名称).filter((x): x is string => !!x);
  for (const k of 名字们) {
    if (k === '重整' && 时机 === '结束步骤') {          // 702.37b
      g.pending.push({
        来源: o, abilityIndex: -1, 标签: 触发标签(o, '重整'),
        能力: {
          种类: '触发式', 触发: { 事件: '步骤开始', 步骤: '结束步骤' },
          效应: [{ 操作: '重置', 目标: { ref: '自身' } }, { 操作: '回复', 目标: { ref: '自身' } }],
        },
      });
    }
    if (k === '迎击' && 时机 === '进入相对阵地' && 进入者) {   // 702.13b
      const n = 词值(g, o, '迎击');
      if (n <= 0) continue;
      const spec = { 目标名: 't', 数量: { 最小: 1, 最大: 1 }, 选择: { 筛选: [{ 属性: '区域', 值: '战场' }, { 属性: '种类', 值: '单位' }] as unknown as Selector['筛选'] } };
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

/** 搜寻用的简单筛选：类别 / 副类别 / 势力（用印制信息，不看持续性效应） */
/**
 * 初阵释疑【无双/无双名称】：
 * 「无双实体的名称中包含其无双名称。无双名称通常出现在牌名中"·"的后面，
 *   若一个无双实体的牌名中没有间隔号，则其牌名便是其无双名称。」
 * 非无双实体**没有**无双名称（返回 null），所以不参与「无双名称不是」这类判断。
 */





export function 执行一步(g: GameState, item: StackItem, 步骤: ResolveStep): void {   // 导出：给 '_探支付门.mjs' 做单步测试 ✓
  // 「若如此做」——只有**前一条效应真的生效了**才执行这一条（047 甘夫人 / 130 峨嵋祭酒）。
  //   每条效应开始时先把标志清成 false，由真正做了事的操作置回 true。
  //   ⚠ 这个字段只在需要的操作上声明（持续 / 失去体力），所以这里窄化读
      // 「若如此做」= true→只在**生效**时执行；**false→只在「未如此做」时执行**（063 孙乾）；
      //   不写 = 不判。⚠ 以前只认 true，写成 false 会被当成「不用判」而**无条件执行** ——
      //   于是「若你未如此做，则…」变成「无论如何都做」。
      const 需前一 = (步骤 as { 若前一效应生效?: boolean }).若前一效应生效;
      const 上一步 = item.上一步生效 === true;
  if (需前一 !== undefined && 需前一 !== 上一步) { item.上一步生效 = false; return; }
  item.上一步生效 = false;
  /**
   * ⚠ **「你可以……」= 某一步可选** ✓（063 孙乾"你可以将这些牌各置入其拥有者的墓地"✓）。
   *
   * 引擎原本只有两种粒度 ✗：**能力级**的"这个触发用不用"（`顶.可选` ✓）和**个别操作**自己判的可选 ✓；
   * "效应链里**中间某一步**可选"没有通用门 ✗ → 那种牌只能写成"无条件做" ✗（于是"若你未如此做，
   * 则…"成了死代码 ✗）。这里在**每一步执行前**补一道门 ✓：
   *   · 还没问 → 发一个「要 / 不要」的**选项**面板 ✓（复用现成的选项渲染 ✓）；
   *   · 选"不要" → **跳过这一步** ✓（`上一步生效` 保持 false ✓ → 后面 `若前一效应生效:false` 接上 ✓）；
   *   · 选"要" → 照常执行 ✓，并先记 `上一步生效 = true` ✓（"若如此做"分支靠它 ✓）。
   */
  if ((步骤 as { 可选?: boolean }).可选 === true) {
    // ⚠ **门要记住"这一步答过了"** ✗→✓（2026-10「确认后又回来」）
    //   以前门每次重进都再问一次 ✓，而 op 的答案（支付源）会被门吞掉/或门反复问 ✓。
    //   标记按 **步骤游标** 记 ✓：换一步就是新门 ✓。
    const 门标 = item as unknown as { 门答于?: number; 本次门?: (number | string)[] };
    if (门标.门答于 !== item.步骤游标) {
      const 答 = 门标.本次门;
      if (答 === undefined) {
        item.待选择 = { 类型: '选', 选什么: '选项', 玩家: item.操控者,
          标签: '你可以这样做：（这一步）', 数量: { 最小: 1, 最大: 1 },
          候选: [{ 键: '接受', 名称: '这样做' }, { 键: '放弃', 名称: '不这样做' }] };
        return;
      }
      门标.本次门 = undefined;
      门标.门答于 = item.步骤游标;
      const 不做 = !Array.isArray(答) || 答.length === 0 || 答[0] === '放弃';
      if (不做) return;
      item.上一步生效 = true;
    }
  }
  switch (步骤.操作) {
    case '失去体力': {
      // 119：失去体力**不是伤害** —— 不走伤害事件，所以 615 防止、702.6e 坚韧都管不了它
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
        /**
         * 119.2：给玩家回 N 点体力 ✓；给**物件**时：
         *   · 写了 `数量` → **减少 N 点伤害**（= 回复 N 点 ✓）
         *   · 没写 `数量` → **清空全部伤害**（回满 ✓，老语义 ✓）
         * ⚠ 2026-10 修 ✗→✓：以前物件**只在"没写数量"时**才处理 ✗，写了 `数量: 1` 就被**整个忽略** ✗
         *   →【刘备】"你和每个由你操控的单位各回复 1 点" 只让**玩家**回了 ✓、单位一个没回 ✓。
         */
        const 量 = 步骤.数量 === '触发事件量' ? (item.触发量 ?? 0)
          : (typeof 步骤.数量 === 'object' && 步骤.数量 !== null) ? 取值(g, item.操控者, 步骤.数量 as Value, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X)
          : (步骤.数量 === 'X' ? 0 : 步骤.数量);   // 「回复 X 点」现在没有卡用，按 0
        for (const t2 of 解析受方(g, item, 步骤.目标)) {
          if (typeof t2 === 'number') {
            const pl = g.players[t2]!;
            const 前 = pl.体力;
            if (量 === undefined) pl.体力 = pl.lifeMax;
            else if (量 > 0) pl.体力 = Math.min(pl.lifeMax, pl.体力 + 量);
            const 实 = pl.体力 - 前;
            /**
             * ⚠ **实际回了 0 点就不算"回复"** ✗→✓（2026-10 报的"玩家 log 会回复 0 点"）：
             *   体力已满时「回复 1 点」实际回 0 ✓ → **不记日志、不记事件、不排队触发** ✓
             *   （否则 058 仁者的大德那种"当任一玩家回复体力时"会被**白触发** ✗）。
             *   单位那半边本来就是"只有真减了伤害才算" ✓，这里把它对齐 ✓。
             */
            if (实 > 0) {
              记录(g, pl.name + ' 回复 ' + 实 + ' 点体力');
              记事件(g, '回复体力', { 受方: t2, 数量: 实 });
              排队回复体力触发(g, t2);
            }
          } else {
            // 物件：写了数量就"回复 N 点"（减 N 点伤害 ✓），没写就回满 ✓
            const 原伤害 = t2.damage;
            const 减 = 量 === undefined ? 原伤害 : Math.min(原伤害, Math.max(0, 量));
            if (减 > 0) {
              写伤害(g, t2, 原伤害 - 减);
              记录(g, t2.def.全名 + ' 回复 ' + 减 + ' 点体力（已损失 ' + (原伤害 - 减) + '）');
              记事件(g, '回复体力', { 受方: t2.uid, 数量: 减 });
              排队回复体力触发(g, t2);
            }
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
      // 132 宦官的毒策：「**目标玩家**牺牲一个单位」—— 由**那个玩家**从自己的单位里挑一个。
      //   ⚠ 走通用的「为这一步选」：挂起 → 答复进 本次选择 → 本步重跑 → 在这里用掉。
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
      // 「若你无法如此做」（157 吕布）：没牺牲成 → 上一步**没生效**，后面的步骤才走 若前一效应生效:false
    if (可牺.length === 0) { 记录(g, g.players[p]!.name + ' 没有可牺牲的单位'); item.上一步生效 = false; break; }
      // ⚠ **只有一个也照问** —— 就算只有一个选择也保留选择动作。
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
      // 玩家 可以是「你」/ 玩家号 / 目标玩家 / 每位玩家
      const 号 = 解析玩家们(g, item, 步骤.玩家)[0]!;
      const pl = g.players[号]!;
      if (item.本次选择) {
        for (const t of item.本次选择) if (t && typeof t !== 'number' && typeof t !== 'string') { 移到区域(g, t, '墓地'); 记录(g, pl.name + ' 弃掉 ' + t.def.全名); }
        item.本次选择 = undefined;
        break;
      }
      const 要弃 = Math.min(步骤.数量, pl.hand.length);
      if (要弃 === 0) { 记录(g, pl.name + ' 没有手牌可弃'); break; }
      // ⚠ 弃哪几张**由该玩家自己选** —— 以前是直接从手牌末尾拿（写死的「简化」，等于没选）。
      item.待选择 = { 类型: '选', 选什么: '物件', 标签: '选 ' + 要弃 + ' 张手牌弃掉', 玩家: 号,
        候选: pl.hand.map((c) => ({ 键: c.uid, 名称: c.def.全名 })), 数量: { 最小: 要弃, 最大: 要弃 } };
      return;
    }
    case '展示': {
      // ⚠ 701.11：**展示** = 让所有人看到牌面 ✓，而且（用户口径）**双方确认后**才继续 ✓。
      //   实现就是"**发一个检视面板**" ✓：候选 = 这几张牌 ✓（服务端 `挂牌面` 会把牌面挂上 ✓），
      //   `等双方确认` 让**服务端闸门**收两个座位的确认 ✓ —— 两个都齐了才回喂**一次** ✓
      //   → 所以这里**不用加相位记号** ✗，判"问过没有"用现成的 `本次选择` 就够 ✓。
      //   ⚠ 判据必须写 `!== undefined` ✗→✓：展示的答案**永远是空数组** `[]` ✓（零选 ✓），
      //   用真值判断会把它当成"还没问" → **无限重问** ✗（回天术那类坑 ✓）。
      if (item.本次选择 !== undefined) { item.本次选择 = undefined; break; }
      const 牌们: Obj[] = [];
      if (步骤.从) {
        // ⚠ **展示"指定的那些牌"** ✓（「搜寻一张牌，**展示**并洗牌后置于…」那种 ✓，
        //   此时那张牌在**暂存位** ✓）—— 只写日志 + 摊面板 ✓，**不改变任何区域** ✓。
        牌们.push(...解析受方(g, item, 步骤.从).filter((x): x is Obj => typeof x !== 'number'));
        if (牌们.length) 记录(g, '展示：' + 牌们.map((c) => c.def.全名).join('、'));
      } else {
        for (const p of 解析玩家们(g, item, 步骤.玩家)) {
          const pl = g.players[p]!;
          const n = Math.min(步骤.数量 ?? 0, pl.library.length);
          const 顶 = pl.library.slice(-n).reverse();       // 牌库顶 → 往下 ✓
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
      // ⚠ 玩家可以是**引用**（「目标玩家的牌库顶」✓）—— 与 检视 同口径 ✓（701.17a：搜寻先检视 ✓）
      const pl = g.players[(步骤.玩家 === undefined ? item.操控者 : (解析玩家们(g, item, 步骤.玩家)[0] ?? item.操控者))]!;
      const 区域 = 步骤.从 ?? ['牌库'];
      // 701.17a：搜寻 = **检视该区域里的所有牌**再找一张 —— 这里就是**调用检视**：
      //   由它登记可见性（搜寻的人必须看得见这些牌，否则界面上点不了）并写日志。
      //   候选是**全部牌**，每张标「可选」；不符合条件的也要能看见（只是点不了）；
      //   即使一张都不符合（701.17c），也要挂起让玩家把牌库看完再确认，不能静默跳过。
      const 全部 = 区域.flatMap((z) => 检视区域(g, item.操控者, [pl.index], z as '手牌' | '牌库' | '牌库顶' | '墓地' | '放逐区' | '战场').牌);
      const 命中 = 全部.filter((c) => 符合筛选(g, c, 步骤.筛选, 有效特征(g, c)));
      const 要 = Math.min(步骤.数量 ?? 1, 命中.length);
      item.待选择 = {
        类型: '搜寻',
        标签: '从' + 区域.join('、') + '搜寻 ' + (步骤.数量 ?? 1) + ' 张（符合条件 ' + 命中.length + ' 张）',
        区域: 区域.join('、'),
        数量: 要,
        // 701.17b：隐藏区域可以「未搜寻到」；一张都不符合时也只能确认（无事发生）
        可放弃: 要 === 0 || 区域.some((z) => z === '牌库' || z === '牌库顶' || z === '手牌'),   // 牌库顶也是隐藏区 ✓
        候选: 命中.map((c) => ({ uid: c.uid, 名称: c.def.全名 })),
        // ⚠ **查看内容 = 这次让你看的那些** ✓（服务器给的、只读 ✓，**不是候选** ✗）——
        //   701.17a：搜寻先「检视该区域」✓；701.17c：一张都不符合也要**看完再确认** ✓ → 所以这里是**全部** ✓。
        查看: 全部.map((c) => ({ uid: c.uid, 名称: c.def.全名 })),
        玩家: pl.index,
      };      return;                       // 挂起：等玩家选完再继续（由 应用选择 接着做）
    }
    case '放置暂存': {
      // 「从」给定时**先把那些物件收进暂存位** —— 给「把目标的牌放进战场」这类用
      //   （放置暂存 本来只吃 item.暂存，而暂存位只有 搜寻 能填，所以那种牌以前放不进去）。
      if (步骤.从) {
        // ⚠ 「从」写 { 目标: 名字 } 时要取**全部**同名目标（和 移到阵地 同一个坑）：
        //   目标槽[名字] 只存一个，多目标在 item.目标 上是一整列（128 张宝「至多两张」）。
        const 收 = (步骤.从 && typeof 步骤.从 === 'object' && '目标' in 步骤.从)
          ? (item.目标 ?? []).filter((x): x is Obj => !!x && typeof x !== 'number' && !('堆叠项' in x))
          : 解析受方(g, item, 步骤.从).filter((x): x is Obj => typeof x !== 'number');
        if (收.length) { for (const c of 收) 移到区域(g, c, '暂存'); item.暂存 = [...(item.暂存 ?? []), ...收]; }
      }
      const 列 = item.暂存 ?? [];
      if (列.length === 0) { 记录(g, '放置暂存：暂存位是空的'); break; }
      // ⚠ **以任意顺序放**（049 广纳良策"其余以任意顺序置于牌库底"✓）：先问顺序 ✓。
      //   零选以外的答案就是玩家排好的那一列 ✓（先点的先放 ✓，和观星同一个路子 ✓）；
      //   答完本步**重跑** → 下面的 `排` 按玩家给的名次排 ✓（没答时 `本次选择` 是 undefined ✓）。
      if (步骤.顺序 === '玩家' && item.本次选择 === undefined) {
        item.暂存 = 列;                                   // 挂起时把整列存回去 ✓（重跑还要用 ✓）
        item.待选择 = { 类型: '选', 选什么: '物件', 玩家: item.操控者,
          标签: '以任意顺序放（先点的在上面/更靠底 ✓）：' + 列.map((c) => c.def.全名).join('、'),
          数量: { 最小: 列.length, 最大: 列.length },
          候选: 列.map((c) => ({ 键: c.uid, 名称: c.def.全名 })),
          // ⚠ **这些牌就是这一步"要给玩家看的"** ✓（规范：查看内容由产生它的那一步明确给出 ✓）——
          //   它们是**暂存位**里的牌 ✓，`区` 查不出来 ✓ → 收发层那条"候选都在隐藏区"的兜底判不出来 ✗
          //   → 界面上就**没有「查看」按钮** ✓（2026-10 报的"广纳良策后续放置没有查看" ✓）。
          //   所以这里显式给 `查看` ✓（和 搜寻/开局检视 同一条路 ✓）。
          查看: 列.map((c) => ({ 键: c.uid, 名称: c.def.全名 })) };
        return;
      }
      const 排 = (步骤.顺序 === '玩家' && Array.isArray(item.本次选择))
        ? 列.slice().sort((a, b) => item.本次选择!.indexOf(a.uid) - item.本次选择!.indexOf(b.uid))
        : 列;
      if (步骤.顺序 === '玩家') item.本次选择 = undefined;   // 用掉了 ✓
      item.暂存 = undefined;
      // ⚠ **遍历的是拷贝、按下标走** ✗ —— 边遍历边 splice 会**跳过**下一个元素 ✓
      //   （实测：两张只问了一次 ✓，第二张被跳过去、既没问也没进场 ✗）。
      for (let idx = 0; idx < 排.length; idx++) {
        const c = 排[idx]!;
        const 主人 = g.players[c.owner]!;
        if (步骤.去处 === '牌库顶') { 移到区域(g, c, '牌库'); 记录(g, c.def.全名 + ' 被置于 ' + 主人.name + ' 的牌库顶'); }
        // ⚠ **牌库底**：`移到区域('牌库')` 是 push 到末尾（= 顶 ✗）→ 要挪到最前面 ✓
        //   （和 翻牌库顶 里 `去处:'牌库底'` 同一套处理 ✓；"其余以任意顺序置于牌库底"用它 ✓）
        else if (步骤.去处 === '牌库底') {
          移到区域(g, c, '牌库');
          const 库 = 主人.library; const i3 = 库.indexOf(c);
          if (i3 >= 0) { 库.splice(i3, 1); 库.unshift(c); }
          记录(g, c.def.全名 + ' 被置于 ' + 主人.name + ' 的牌库底');
        }
        else if (步骤.去处 === '手牌') { 移到区域(g, c, '手牌'); 记录(g, c.def.全名 + ' 被置于 ' + 主人.name + ' 的手上'); }
        else if (步骤.去处 === '墓地') { 置入墓地(g, c); 记录(g, c.def.全名 + ' 被置于墓地'); }
        // 操控者：默认 610.3c（**移回**战场 → 拥有者操控）；
        //   写了 操控者:'你' 就按 111.2 由**这个能力的操控者**让它进场（139 回天术）。
        // ⚠ **301.11：把单位牌放进战场时必须选阵地** ✓（139 回天术「从墓地放进战场」就在这里）
        //   阵地没给 → 挂起问玩家 ✓（复用 112.6 那套待选择 ✓，答完本步重跑用掉 ✓）
        else if (是类别(g, c, '单位')) {
          const 控 = 步骤.操控者 === '你' ? item.操控者 : c.owner;
          let 阵地 = (item.本次选择 && typeof item.本次选择[0] === 'string') ? item.本次选择[0] as 阵地 : null;
          if (阵地) item.本次选择 = undefined;
          if (!阵地) {
            const 空 = 阵地顺序.filter((s2) => !g.players[控]!.阵地[s2]);
            if (!空.length) { 记录(g, '301.10：没有可用的阵地，' + c.def.全名 + ' 留在当前区域'); continue; }
            // ⚠ **挂起时要把「当前这张」排除在暂存之外** ✗→✓
            //   答完阵地、本步会**重跑** ✓（「选」不推进游标 ✓）：若暂存里还留着当前这张 ✓
            //   重跑时又轮到它 ✓ → **一直问下去** ✓（139 回天术 的实测就是这样 ✓）。
            //   所以存**它之后**的剩余 ✓；当前这张由上面那段 `进战场` 用掉答案 ✓。
            item.暂存 = 排.slice(idx + 1);
            item.待选择 = { 类型: '选', 选什么: '阵地',
              标签: '301.11：为 ' + c.def.全名 + ' 选择一个进战场的阵地（' + g.players[控]!.name + ' 的空阵地）',
              玩家: 控, 数量: { 最小: 1, 最大: 1 }, 候选: 空.map((x) => ({ 键: x, 名称: x })) };
            return;                            // 挂起（执行步骤 见到待选择就返回 false ✓）
          }
          进战场(g, c, 控, 阵地, { 横置: 步骤.横置 });
          记录(g, c.def.全名 + ' 被放进战场' + (控 !== c.owner ? '（在 ' + g.players[控]!.name + ' 的操控下）' : '') + '（' + 阵地 + '）');
          // 放好了：**什么都不用做** ✓ —— 挂起时已经把「当前这张」排除在 `item.暂存` 之外 ✓
          //   （按下标走 ✓，重跑时自然处理后面的 ✓）
        }
        else {
          const 控 = 步骤.操控者 === '你' ? item.操控者 : c.owner;
          进战场(g, c, 控, null, { 横置: 步骤.横置 });
          记录(g, c.def.全名 + ' 被放进战场' + (控 !== c.owner ? '（在 ' + g.players[控]!.name + ' 的操控下）' : ''));
        }
      }
      item.暂存 = undefined;        // 全部处理完 ✓（中途挂起时上面已经把剩余存回去了 ✓）
      break;
    }
    case '限制玩家': {
      const p = typeof 步骤.玩家 === 'number' ? 步骤.玩家 : (item.目标槽?.[步骤.玩家.目标] as number | undefined);
      if (typeof p !== 'number') { 记录(g, '限制玩家：目标不是玩家，什么也不发生'); break; }
      // 613.10 的玩家级持续性效应 —— 同样按 611.2a：没写时长 = 直到游戏结束
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
      // 数量可以是固定数字，也可以是按场面/记忆算的 Value
      const 个数 = typeof 步骤.数量 === 'number' ? 步骤.数量
        : 取值(g, item.操控者, 步骤.数量 as Value, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X);
      // 阵地 里的每一项可以是具体阵地名、null，或者 `{ 触发受方: true }`
      //   —— 后者 =「**前者原先的位置**」（134 黄铜传道者：指示物放在死者的阵地）。
      const 阵地表 = 步骤.阵地?.map((x) =>
        (x && typeof x === 'object' && '触发受方' in x) ? (item.死者位置 ?? null) : x);
      // 112.6 / 701.23c-d：征召**单位**指示物时，**你须为每一个选择一个阵地**，
      //   不能选两个相同的阵地；所有阵地都被选完后，其余指示物不能进场。
      //   ⚠ 卡数据**写了**阵地的（134「死者原先的位置」）是特例，照旧不问 ✓。
      //   没写的：一个一个问 —— 用掉上一次答案 → 问这一次 → 挂起（每次只能问一个 ✓）。
      //   ⚠ 卡面写「**至多** X 个」的（136 黄巾之乱）必须能**提前停** ✗ ——
      //     所以数量给 {0,1}（可以答「不选了」✓），玩家停手或没空阵地就按已选的征召 ✓。
      const 是否单位 = (步骤.指示物?.类别 ?? []).includes('单位');
      if (是否单位 && !步骤.阵地) {
        const 允许少征 = /至多/.test(JSON.stringify(步骤) + (item.标签 ?? ''));   // 卡面写了「至多」就得能少选
        const 空 = 阵地顺序.filter((s2) => !g.players[item.操控者]!.阵地[s2]);
        const 标记 = item as unknown as { 征召已问?: boolean };
        if (!标记.征召已问) {
          // ① 一次把要选的阵地**全问完** ✓（用户口径：超过一个时不要一个一个问 ✗）
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
            return;                     // 挂起；答完本步重跑，回到下面 ② 用掉答案 ✓
          }
        } else {
          // ② 用掉答案（**一次拿到多个** ✓，点击顺序就是放置顺序 ✓）
          const 答案 = (item.本次选择 ?? []).filter((x): x is 阵地 => typeof x === 'string' && 空.includes(x as 阵地));
          item.本次选择 = undefined;
          if (!答案.length) 记录(g, '征召：没有指示物进场（个数 ' + 个数 + '）');
          else 征召(g, item.操控者, 步骤.指示物, 答案.length, 答案, 步骤.关键词);
          标记.征召已问 = undefined;
          break;
        }
      }
      // 不是单位指示物、或者卡数据**自己写了**阵地（134「死者原先的位置」）→ 照旧一次征召 ✓
      征召(g, item.操控者, 步骤.指示物, 个数, 阵地表, 步骤.关键词);
      break;
    }
    case '放玩家标记': {
      const pl = g.players[item.操控者]!;
      pl.标记[步骤.标记] = (pl.标记[步骤.标记] ?? 0) + 步骤.数量;
      记录(g, pl.name + ' 得到 ' + 步骤.数量 + ' 个「' + 步骤.标记 + '」标记（共 ' + pl.标记[步骤.标记] + '）');
      break;
    }
    case '略过': {                                  // 614.1b / 614.8a
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
        const 戳 = g.nextStamp++;                              // 613.7c
        const 已 = t.标记.find((m) => m.类型 === 步骤.标记);
        if (已) { 改标记(g, 已, { 数量: 已.数量 + 步骤.数量, 时间印记: 戳 }); }   // 613.7c：同类标记一起刷新印记
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
      // 611.2b 的「只要……」条件。**在这里把目标解析成 uid** ——
      //   这样条件判断不需要 StackItem（连续效应会活得比这个 item 久）
      let 条件 = 步骤.条件 as Condition | undefined;
      if (条件 && 条件.操作 === '附属在') {
        const t = 解析受方(g, item, { 目标: 条件.目标 })[0];
        条件 = { 操作: '附属在', 目标: String(typeof t === 'number' ? t : (t?.uid ?? '')) };
      }
      // 611.2a：**没有列出时间段 → 生效直到游戏结束**
      const 时长 = 步骤.时长 === '直到回合结束' ? '直到回合结束' : '直到游戏结束';
      let 指定: number | undefined;
      let 受锁定: number[] | undefined;
      // 范围统一用 Selector（和 611.3 那条路一致），不再有单独的 作用 枚举
      let 范围: Selector | undefined;
      if (步骤.目标 === '自己') {
        指定 = (item.来源 ?? item.card)?.uid;
      } else if (typeof 步骤.目标 === 'object' && 'selectAll' in 步骤.目标) {
        范围 = 步骤.目标.selectAll;
        // 611.2c：由**结算**产生的、影响特征的持续性效应，在开始时锁定物件组
        //   （这正是不用 611.3 那条路的原因 —— 那条不锁定，611.3a）
        受锁定 = 候选目标(g, item.操控者, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: 范围 }, item.来源 ?? item.card)
          .map((c) => c.obj?.uid).filter((x): x is number => x !== undefined);
      } else {
        const t = 解析受方(g, item, 步骤.目标 as RecipientRef)[0];
        if (typeof t === 'number') { 记录(g, '持续性效应指向玩家，暂未实现'); break; }
        指定 = t?.uid;
      }
      // 没给 selectAll 时，退回 步骤.作用 那三个粗糙范围
      if (!范围 && !指定) {
        const a = 步骤.作用 ?? '你操控';
        if (a === '你操控') 范围 = { 筛选: [{ 属性: '区域', 值: '战场' }, { 属性: '操控者', 值: '你' }] };
        else if (a === '所有') 范围 = { 筛选: [{ 属性: '区域', 值: '战场' }] };
      }
      // 613.1b 层 2：**改变操控权**的效应生效时，按 301.8 把单位移过来（立刻响应，不等状态动作）。
      // 反方向（效应失效、操控权回原主）由 检查状态动作 → 同步操控权与阵地 兜底。
      if (步骤.层?.操控权 !== undefined) {
        const 受 = 指定 !== undefined
          ? [取实体(item.来源 ?? item.card), ...item.目标.map(取实体)].filter((x): x is Obj => !!x && x.uid === 指定)
          : (范围 ? 候选目标(g, item.操控者, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: 范围 }, item.来源 ?? item.card).map((c) => c.obj) : []);
        for (const t of 受) {
          if (!t || t.区域 !== '战场') continue;
          if (有效控制器(g, t) === item.操控者) continue;   // 已经是你操控的 → 301.8 无事可做
          // 301.8：搬阵地是「操控权变更」这个行为的一部分，而且**由新操控者自己选**空阵地。
          //   ⚠ 这里问不了玩家（同步代码），所以**登记成待选择** —— 和搜寻/选择牺牲同一条路：
          //     执行步骤 见到待选择就返回 false，结算循环把它 yield 给玩家；
          //     答完 应用选择 把答案写进 本次选择（游标**不推进**）→ 这一步重跑，从那里取答案。
          const 空 = 阵地顺序.filter((x) => !g.players[item.操控者]!.阵地[x]);
          const 原始 = item.本次选择 && item.本次选择.length ? item.本次选择[0] : undefined;
          const 答: 阵地 | null = typeof 原始 === 'string' && (阵地顺序 as readonly string[]).includes(原始)
            ? (原始 as 阵地) : null;
          if (答 === null) {
            if (空.length === 0) { 获得操控权时移动(g, t, item.操控者); continue; }   // 没有空阵地 → 失去阵地
            清出阵地(g, t);                    // 先离开旧格：此刻它没有阵地，也不会留下两份登记
            item.本次选择 = undefined;         // 清掉旧答案，重跑时才知道「还没选」
            // 走**统一【选】**的「阵地」那一类：客户端把它变成场上可点的空格子（和施放选阵地同一套），
            //   不用在操作条上排按钮。
            item.待选择 = { 类型: '选', 选什么: '阵地',
              标签: '选择 ' + t.def.全名 + ' 移到哪个空阵地',
            玩家: item.操控者, 数量: { 最小: 1, 最大: 1 },
              候选: 空.map((x) => ({ 键: x as string, 名称: x as string })) };
            return;                            // ← 挂起，交给调用方去 yield
          }
          item.本次选择 = undefined;           // 用掉就清，别留给下一步
          if (!g.players[item.操控者]!.阵地[答]) {
            清出阵地(g, t);
            写阵地(g, t, 答); g.players[item.操控者]!.阵地[答] = t;
            记录(g, '301.8：' + t.def.全名 + ' 移到 ' + g.players[item.操控者]!.name + ' 的 ' + 答);
          } else {
            获得操控权时移动(g, t, item.操控者);   // 选中的格已被占 → 退回「有空就搬、没有就失去阵地」
          }
        }
      }
      加连续效应(g, {
        id: g.nextStackId++, 时间印记: g.nextStamp++, 来源: item.来源 ?? item.card ?? null,
        控制器: item.操控者, 时长, 范围, 受锁定, 指定, 条件,
        // 载荷**两样都能带**（613.6）：给了哪样就带哪样，互不排斥
        载荷: { ...(步骤.层 ? { 层: 步骤.层 } : {}), ...(步骤.替代 ? { 替代: 步骤.替代 } : {}) },
      });
      记录(g, '持续效应（' + 时长 + '）：' + (item.card?.def.全名 ?? item.标签));
      break;
    }
    case '伤害': {
      // 来源既可以是「自身」（能力/锦囊本身），也可以是**一个已选目标**（056「由目标单位造成伤害」）
      const src = 步骤.来源 === '自身' ? (item.来源 ?? item.card)
        : (typeof 步骤.来源 === 'object' ? (解析受方(g, item, 步骤.来源)[0] as Obj | undefined) ?? null : null);
      // 一个效应条目可能解析出多个受方（例如「相对单位和斜对单位」），要全部展开
      const 受方: { 目标: Obj | number; 数量: number; 战斗伤害?: boolean; 射击伤害?: boolean }[] = [];
      for (const e2 of 步骤.事件) {
        /** 这一条打多少点。五种写法在这里一次收敛（以前 `'来源武力'` 和对象形式都没实现）。 */
        const 算量 = (t: Obj | number): number => {
          const v = e2.点数;
          if (typeof v === 'number') return v;
          if (v === 'X') return item.宣告X ?? 0;                 // 108.3a
          if (v === '触发事件量') return item.触发量 ?? 0;
          if (v === '来源武力') return src && typeof src !== 'number' ? 武力(g, src) : 0;
          if (v && typeof v === 'object' && '武力' in v) {       // { 武力: 引用 } —— 决斗那族
            const r = 解析受方(g, item, (v as { 武力: RecipientRef }).武力).find((x): x is Obj => typeof x !== 'number');
            return r ? 武力(g, r) : 0;
          }
          return typeof t === 'number' ? 0 : 武力(g, t);         // 没写点数 = 按受方自己（旧行为）
        };
        // ⚠ `selectRelation`（按阵地关系选一批）**引擎原先根本不认** —— 只认另一个拼法 `sel.关系`，
        //   两边对不上，于是写了它的牌受方解析成空、**伤害静默不发生**（056 猛将一击就是这样）。
        const se = e2.受方 as unknown as { selectRelation?: string; 相对?: unknown };
        if (se && typeof se === 'object' && se.selectRelation) {
          // 锚点：不写就是效应来源；写了就解析那个引用（056 是「打手」这个目标）
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
        // 一个效应条目可能解析出多个受方（例如「相对单位和斜对单位」），要全部展开
        for (const t of 解析受方(g, item, e2.受方)) {
          受方.push({ 目标: t, 数量: 算量(t), 战斗伤害: 步骤.战斗伤害, 射击伤害: item.能力名 === '射击' });
        }
      }
      
      if (受方.length === 0) { 记录(g, '伤害：解析不到受方，跳过'); break; }
      伤害事件(g, src, 受方);
      break;
    }
    case '抓牌': {
      // 个数 可以是固定数字，也可以是按场面算的 Value（「每有一个…便抓一张」）
      const n = typeof 步骤.数量 === 'number' ? 步骤.数量 : 取值(g, item.操控者, 步骤.数量, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X);
      // 「每位玩家各抓一张牌」= player 解析出多个玩家（176 南华老仙 / 063 孙乾）
      for (const p of 解析玩家们(g, item, 步骤.玩家)) 抓牌(g, p, n);
      break;
    }
/**
 * **把"这一步选出来的东西"归一成 uid 列表** ✓ —— 唯一的读法 ✓。
 * ⚠ `应用选择` 会把数字键换成**物件对象**（engine.ts:2316-2330）✗，所以调用方不能只认数字 ✗
 *   （2026-10：黄月英的支付只认 number → 永远 0 个来源 ✗）。
 */
function 取uid列表(值: unknown): number[] {
  if (!Array.isArray(值)) return [];
  return 值
    .map((x) => (typeof x === 'number' ? x : (x && typeof x === 'object' && 'uid' in x ? (x as { uid: number }).uid : undefined)))
    .filter((x): x is number => typeof x === 'number');
}

/**
 * **「付 N 点数字费用」那一问的待选择** ✓ —— 唯一的构造处 ✓。
 * 形状固定：`选什么:'支付源'` ✓（收发层就据此产出**支付源槽** ✓：`归:'支付源'` + 需按点数 + 候选带 `提供` ✓），
 * 客户端零改动就是"支付 0/N + 点领土" ✓。以后任何"你可以支付{N}"的牌都调这里 ✓。
 */
function 付数字费待选择(g: GameState, 玩家: number, 费: number) {
  return {
    类型: '选' as const, 选什么: '支付源' as const,
    标签: '支付 ' + 费 + ' 点数字费用：选你的领土（可多选）',
    玩家, 数量: { 最小: 费, 最大: 费 },   // ★ 按**点数**（不是张数）—— 收发层的支付源槽按它算 支付 n/N ✓
    可取消: true,                        // ★ 链上的步骤：允许中止（取消 = 不回调 → 链断 ✓）
    候选: 可支付来源(g, 玩家).map((x) => ({ 键: x.uid, 名称: x.名称, 提供: x.提供 })),
  };
}
    /**
     * **支付 {N}** ✓ —— 唯一的"付钱"操作（费用就是这个操作 ✓）。
     *   「要不要付」由**步骤可选门**（`步骤.可选` ✓）问，门有自己的答案槽 `本次门` ✓，
     *   本 op 只认 `本次选择`（= 这一步选出来的支付源 ✓）→ 两者**不会**抢同一个字段 ✓。
     *   付不起 / 付不满 → 本步不成立（`上一步生效=false` ✓）→ 后面 `若前一效应生效` 自然跳过 ✓
     *   （黄月英：打锦囊 → 可选支付 1 点 → 付了才抓牌 ✓）。
     */
    case '支付': {
      const 数 = (步骤 as unknown as { 点数?: { 最小?: number; 最大?: number } }).点数;
      const 费 = 数?.最小 ?? 0;   // 支付行为的参数：点数（上下限同值 = 恰好付这么多 ✓）
      const 谁 = item.操控者;
      if (费 <= 0) { item.上一步生效 = true; break; }
      if (!可支付数字费用(g, 谁, 费)) {
        item.上一步生效 = false;
        记录(g, g.players[谁]!.name + ' 付不起 ' + 费 + ' 点，这一步跳过');
        break;
      }
      const 已 = 取uid列表(item.本次选择);
      if (!已.length) { item.待选择 = 付数字费待选择(g, 谁, 费); return; }
      item.本次选择 = undefined;
      if (!支付数字费用(g, 谁, 费, 已)) {
        item.上一步生效 = false;
        记录(g, g.players[谁]!.name + ' 支付的领土不足 ' + 费 + ' 点，跳过');
        break;
      }
      item.上一步生效 = true;
      记录(g, g.players[谁]!.name + ' 支付了 ' + 费 + ' 点');
      break;
    }
    case '取消': {
      // 701.16a：取消 = 把目标**移出堆叠**并置入其拥有者的墓地。
      //   目标可能是**令符**（113.1，有牌）或**能力**（114.9，没有牌，按堆叠项 id 指）。
      const t = item.目标槽?.[步骤.to.目标];
      const 栈id = 取堆叠项(t);
      const idx = 栈id !== undefined
        ? g.stack.findIndex((x) => x.id === 栈id)
        : g.stack.findIndex((x) => x.card === 取实体(t));
      if (idx >= 0) {
        const rm = 堆叠取第(g, idx);
        记录(g, '取消 ' + (rm!.card ? rm!.card.def.全名 : rm!.标签));
        if (rm!.card) 置入墓地(g, rm!.card);      // 令符 → 拥有者的墓地；能力没有牌，只是离开堆叠
      } else 记录(g, '取消失败：目标不在堆叠');
      break;
    }
    case '放逐':
      for (const t of 解析受方(g, item, 步骤.to)) if (typeof t !== 'number') 放逐(g, t);
      break;
    case '移动': {
      // 「若如此做」：这条移动找到了受方就算生效（047 甘夫人移回手牌那类）
      item.上一步生效 = true;
      // 400.7：把一个或多个物件换个区域。
      //   **单个目标**用 步骤.to；**批量**（「将所有单位移回其拥有者手上」）用 步骤.selectAll。
      const 已洗入 = new Set<number>();
      // 「**目标玩家**的墓地」那种：批量候选算在**他**身上，不是效应操控者身上
      const 谁的 = 步骤.玩家 !== undefined ? (解析玩家们(g, item, 步骤.玩家)[0] ?? item.操控者) : item.操控者;
      const 批量 = 步骤.selectAll
        ? 候选目标(g, 谁的, { 目标名: '_', 数量: { 最小: 1, 最大: 1 }, 选择: 步骤.selectAll }, item.来源 ?? item.card)
            .map((c) => c.obj).filter((x): x is Obj => !!x)
            // 「**目标玩家**的墓地」要按**拥有者**收窄 —— 非战场区域的候选本来就是跨所有玩家的
            //   （063 孙乾那种「每个玩家的墓地」正需要那个宽度），所以在这里按 玩家 过滤。
            .filter((x) => 步骤.玩家 === undefined || x.owner === 谁的)
        : null;
      // '牌库' = **洗入**（随机位置，之后要洗）；'牌库顶' = 放最上面
      // ⚠ 认不出的目的地**不能静默当「手牌」** —— 卡数据里写错一个字符串，
      //   表现就是「移到牌库顶」变成「移回手上」，而且日志里一点痕迹都没有。
      //   【黑水祭天】模式 3 就是这么错的（写的是 '拥有者的牌库顶'）。
      if (!['手牌', '牌库', '牌库顶', '墓地', '放逐区'].includes(步骤.去处)) {
        记录(g, '⚠ 移动：未知的目的地「' + 步骤.去处 + '」—— 按「手牌」处理，请检查卡数据');
      }
      const 洗入 = 步骤.去处 === '牌库';
      const 目的区: Zone = (步骤.去处 === '牌库顶' || 洗入) ? '牌库'
        : 步骤.去处 === '墓地' ? '墓地'
        : 步骤.去处 === '放逐区' ? '放逐区'
        : '手牌';                       // 默认「移回其拥有者手上」（400.3：进拥有者那边）
      const 搬 = (t: Obj) => {
        const 曾战场 = t.区域 === '战场';
        移到区域(g, t, 目的区);
        记录(g, t.def.全名 + (目的区 === '手牌' ? ' 被移回其拥有者手上' : 目的区 === '牌库' ? ' 被置于其拥有者的牌库顶' : 目的区 === '墓地' ? ' 被置于其拥有者的墓地' : ' 被放逐'));
        // 701.18c：移动**不是死去**（700.4 只认「从战场进墓地」），所以只记「离开战场」
        if (曾战场) 记事件(g, '离开战场', { 受方: t.uid });
        // 701.20「洗入牌库」：先进去，再整体洗 —— 位置随机化由洗牌统一负责
        if (洗入) 已洗入.add(t.owner);
      };
      if (批量) { for (const x of 批量) 搬(x); for (const p2 of 已洗入) 洗牌(g.players[p2]!.library, g.随机源); break; }
      // to 可以是 { 目标: '槽名' }（按目标槽取），也可以是 RecipientRef（{ref:'自身'} 等）
      const t = !步骤.to ? undefined
        : ('目标' in 步骤.to ? 取实体(item.目标槽?.[步骤.to.目标]) : (解析受方(g, item, 步骤.to)[0] as Obj | undefined));
      if (!t) { 记录(g, '移动：找不到目标'); break; }
      搬(t);
      for (const p3 of 已洗入) 洗牌(g.players[p3]!.library, g.随机源);
      break;
    }
    case '记住': {
      // 「记住」一个东西 —— 数字属性或一个玩家号（效应之间的变量）
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
      // 701.26：把一个实体改成横置。已横置的再横置没有任何作用（112.5）。
      for (const t2 of 解析受方(g, item, 步骤.to)) if (typeof t2 !== 'number' && !t2.tapped) { 写横置(g, t2, true); 记录(g, t2.def.全名 + ' 被横置'); 记事件(g, '成为横置', { 受方: t2.uid });  排队单位事件触发(g, '成为横置', t2); }
      break;
    case '翻牌库顶': for (const p of 解析玩家们(g, item, 步骤.玩家)) {
      // 401.2 牌库是隐藏区：先「展示」让双方看到翻了什么，再按 分流 逐张送走。
      // ⚠ 「展示」与「分去处」在规则上是**两件事** ✓（牌数据里各写各的 ✓）——
      //   这里只做"翻+分" ✓；摊面板/双方确认是**展示那个 op** 的事 ✓（别在这里绑 ✗）。
      const pl2 = g.players[p]!;
      const n2 = Math.min(步骤.数量, pl2.library.length);
      const 翻 = pl2.library.slice(-n2).reverse();          // 顶在末尾 → 反转成从上到下
      for (const c of 翻) {
        // 按顺序找第一条命中的分流规则（没写 筛选 的当兜底）
        const r = 步骤.分流.find((x) => !x.筛选 || 符合筛选(g, c, x.筛选, 有效特征(g, c))) ?? 步骤.分流[步骤.分流.length - 1]!;
        // ⚠ `去处:'暂存'` = **先摘出来、不落位** ✓（"其余……"那种要玩家定顺序的效果 ✓：
        //   后面用 `放置暂存` 那一步把它放到该去的地方 ✓ —— 两件事各写一条操作 ✓）。
        if (r.去处 === '暂存') { 移到区域(g, c, '暂存'); (item.暂存 ??= []).push(c); 记录(g, c.def.全名 + ' → 暂存（等下一步放）'); continue; }
        const 区: Zone = r.去处 === '墓地' ? '墓地'
          : r.去处 === '放逐区' ? '放逐区'
          : r.去处 === '战场' ? '战场'
          : (r.去处 === '牌库顶' || r.去处 === '牌库底') ? '牌库'
          : '手牌';
        移到区域(g, c, 区);
        // 牌库底：放进区域 是 push 到末尾（= 顶），所以要挪到最前
        if (r.去处 === '牌库底') { const 库 = pl2.library; const i3 = 库.indexOf(c); if (i3 >= 0) { 库.splice(i3, 1); 库.unshift(c); } }
        if (r.去处 === '战场' && r.横置) 写横置(g, c, true);
        排队单位事件触发(g, '成为横置', c);
        记录(g, c.def.全名 + ' → ' + r.去处);
      }
    } break;
    case '决斗': {
      // 701.10：两个单位互殴。**语义在这里只有一份**（卡片数据不再手写两条 伤害 事件）。
      const 解斗 = (r: RecipientRef) => 解析受方(g, item, r).find((x): x is Obj => typeof x !== 'number');
      const 甲 = 解斗(步骤.甲); const 乙 = 解斗(步骤.乙);
      // 701.10b：任一方已不在战场 / 不再是单位 → 没有决斗，也没有伤害
      const 可斗 = (o: Obj | undefined): o is Obj => !!o && o.区域 === '战场' && 是类别(g, o, '单位');
      if (!可斗(甲) || !可斗(乙)) { 记录(g, '决斗（701.10b）：有一方已不在战场上或不再是单位，不造成伤害'); break; }
      if (甲 === 乙) {
        // 701.10c：与本身决斗 = 对自己造成**两倍**武力
        const 双倍 = 武力(g, 甲) * 2;
        记录(g, 甲.def.全名 + ' 与自己决斗（701.10c）：受到 ' + 双倍 + ' 点伤害');
        伤害事件(g, item.来源 ?? item.card ?? null, [{ 目标: 甲, 数量: 双倍 }]);
        break;
      }
      记录(g, 甲.def.全名 + ' 与 ' + 乙.def.全名 + ' 决斗（701.10）');
      // 701.10d：非战斗伤害。来源是那张令符/能力（不是这两个单位），传 null 表示没有来源物件。
      伤害事件(g, null, [
        { 目标: 甲, 数量: 武力(g, 乙) },   // 甲挨**乙**的武力
        { 目标: 乙, 数量: 武力(g, 甲) },   // 乙挨**甲**的武力
      ]);
      break;
    }
    case '移到阵地': {
      // 301.7：把单位挪到另一个阵地。301.9：目标阵地被占 → 替任（放逐原单位）。
      // 目的地两种写法（见 types）：
      //   · `相对`  —— 算出来的（某个单位的相对阵地）；
      //   · `阵地`  —— **由玩家挑**一个空阵地（087 调虎离山）；解析出多个单位时**依次**各问一次。
      // ⚠ 「至多两个目标」要拿到**全部**：目标槽[名字] 只存一个（那是给「该目标」这类单数引用用的），
      //   多目标在 item.目标 上是**一整列**。所以 to 写 { 目标: 名字 } 时直接读那一列。
      const 是单位 = (x: 目标 | undefined): x is Obj =>
        !!x && typeof x !== 'number' && !('堆叠项' in x) && 是类别(g, x as Obj, '单位');
      const 走们: Obj[] = (步骤.to && typeof 步骤.to === 'object' && '目标' in 步骤.to)
        ? (item.目标 ?? []).filter(是单位)
        : 解析受方(g, item, 步骤.to).filter(是单位);
      if (!走们.length) { 记录(g, '移到阵地：找不到单位'); break; }
      // 「依次」靠**挂起重跑同一步**来循环：进度存在 item 上，全部走完才推进游标。
      const 进度 = (item as unknown as { 移到进度?: number }).移到进度 ?? 0;
      const 走 = 走们[进度];
      if (!走) break;
      let 目的: 阵地 | null = null;
      let 新主号 = item.操控者;
      if (步骤.空阵地 !== undefined) {
        const 它主 = 有效控制器(g, 走);
        // '其操控者' = 那个单位自己的操控者（阵地所有者 一直就在算这个）
        const 谁的 = 步骤.空阵地 === '对手' ? 1 - 它主 : 它主;
        const 空 = 阵地顺序.filter((s2) => !g.players[谁的]!.阵地[s2]);
        if (!空.length) { 记录(g, '移到阵地：' + g.players[谁的]!.name + ' 没有空阵地'); break; }
        // ⚠ 空数组**不算答案**（那是「还没问」）—— 用长度判，别用真值判
        if (!item.本次选择 || !item.本次选择.length) {
          item.待选择 = {
            类型: '选', 选什么: '阵地',
            标签: '选择 ' + 走.def.全名 + ' 移到哪个空阵地（' + g.players[谁的]!.name + '  的空阵地）',
            玩家: 步骤.由谁选 === '对手' ? 1 - item.操控者 : item.操控者,
            数量: 步骤.可选 ? { 最小: 0, 最大: 1 } : { 最小: 1, 最大: 1 },
            候选: 空.map((x) => ({ 键: x, 名称: x })),
          };
          return;                       // 挂起：由 应用选择 把答案写进 本次选择，本步重跑
        }
        const 选 = item.本次选择[0];
        // 「你可以…」那一问答了「不选」→ 这一步什么都不发生（151 塞外蛮族）
        if (选 === undefined && 步骤.可选) { 记录(g, '移到阵地：' + g.players[步骤.由谁选 === '对手' ? 1 - item.操控者 : item.操控者]!.name + ' 没有选择阵地，不移动'); break; }
        item.本次选择 = undefined;
        目的 = typeof 选 === 'string' ? (选 as 阵地) : null;
        if (目的 === null || !空.includes(目的)) { 记录(g, '移到阵地：选的目的地不合法'); break; }
        新主号 = 谁的;                   // 空阵地是**谁**的，就由谁占（087：其操控者）
      } else {
        const 锚 = 解析受方(g, item, 步骤.相对!).find((x): x is Obj => typeof x !== 'number');
        if (!锚) { 记录(g, '移到阵地：找不到锚'); break; }
        if (!锚.阵地) { 记录(g, '移到阵地：' + 锚.def.全名 + ' 不在阵地上'); break; }
        目的 = 相对阵地(锚.阵地);
        if (目的 === null) { 记录(g, '移到阵地：算不出相对阵地'); break; }
      }
      if (走.阵地 === 目的) { 记录(g, 走.def.全名 + ' 已经在 ' + 目的); } else {
        // 摘掉自己原来的阵地
        const 旧阵 = 走.阵地;
        if (旧阵 !== null) {
          const 旧主 = g.players[阵地所有者(g, 走)!]!;
          旧主.阵地[旧阵] = null;
        }
        const 新主 = g.players[新主号]!;
        // ⚠ **701.18c**：替任只在单位**进战场**时发生 —— 「如果一个单位将移动到一个其上有
        //   单位的阵地，则**什么也不会发生**」。所以这里不做替任，直接不移动。
        //   （301.9 管的是「将在某阵地**进战场**」；701.22c 也明说「离开战场后再进场」不是移动。）
        const 原 = 新主.阵地[目的];
        if (原) {
        // ★ 释疑（066 张飞）：「如果该单位的相对阵地**有单位**，则**取消此能力**」✓
        //   701.16a 取消 = 把能力移出堆叠并置入墓地 → **整条效应链都不再执行** ✗
        //   （以前只记 701.18c「什么也不会发生」✗ 且只 break 这一步 ✗ → 后面若还有效应会照跑 ✗）
        记录(g, '取消此能力：' + 目的 + ' 上有 ' + 原.def.全名 + '（相对阵地不空，701.16a / 066 释疑）');
        item.步骤游标 = item.steps.length;   // 中止整条链 ✓
        return;
      }
        写阵地(g, 走, 目的);
        新主.阵地[目的] = 走;
        记录(g, 走.def.全名 + ' 移动到 ' + 目的);
        记事件(g, '移动', { 受方: 走.uid });          // 701.18
        排队移动触发(g, 走);
      }
      (item as unknown as { 移到进度?: number }).移到进度 = 进度 + 1;
      if (进度 + 1 < 走们.length) {
        // 「**依次**移动至多两个」：还有下一个 —— 把答案清掉、**直接问它的目的地**，
        //   并让本步重跑（挂起 → 游标不推进）。⚠ 不要挂一个「空问题」来循环：
        //   空问题回来的是**空数组**，会被误当成「答案是空的」→ 判成目的地不合法。
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
      // 099 / 110：两个单位占的阵地互换
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
      // 603.7 延迟触发能力：现在只登记，事件发生时由 扫守望 触发。
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
      // ── 701.5a：观星 X 是指「**检视**你牌库顶的 X 张牌，将其中任意数量的牌以**任意顺序**
      //    置于你的牌库顶，其余则以任意顺序置于你的牌库底」。
      //    ⚠ 描述里**就写着「检视」** —— 和 搜寻 一样，实现是**调用检视**（检视区域），
      //      不是另写一套「看牌」。
      //
      //    放置顺序：两步都问「点选顺序」，**先点的在上面**（面板上按点击先后排）。
      //      第一步问「哪些置顶」，第二步问「其余按什么顺序置底」。
      //    相位记在 item 上（待选择是「挂起 → 重跑同一步」，所以同一步会进来好几次）。
      const 谁 = 步骤.玩家 ?? item.操控者;
      const pl = g.players[谁]!;
      const X = typeof 步骤.数量 === 'number' ? 步骤.数量
        : 取值(g, item.操控者, 步骤.数量, item.来源 ?? undefined, 记忆宿主(item) ?? undefined, item.宣告X);
      // 701.5b：观星 0 → **事件不发生**（因观星而触发的能力也不会触发）。
      if (X <= 0) { 记录(g, g.players[谁]!.name + ' 观星 0：事件不发生（701.5b）'); break; }
      // 101.3：没有牌可以检视 → **省略该动作**（不挂起、不问）。
      if (pl.library.length === 0) { 记录(g, g.players[谁]!.name + ' 观星 ' + X + '：牌库是空的，省略该动作（101.3）'); break; }
      const 看 = Math.min(X, pl.library.length);
      const 牌 = 检视区域(g, item.操控者, [谁], '牌库', 看).牌;
      const 记忆 = item as unknown as { 观星顶?: Obj[]; 观星底?: Obj[] };
      const 答 = (item.本次选择 ?? []).filter((x): x is Obj => typeof x === 'object' && x !== null && 'uid' in x);
      item.本次选择 = undefined;
      // ── 第一问：哪些置顶（点选顺序 = 从顶到底）
      if (记忆.观星顶 === undefined) {
        if (item.待选择 === undefined && 答.length === 0) { /* 还没问过 */ }
        // 已经答过一次（哪怕是空选）→ 落定
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
            // ⚠ **这两问的牌都是"要给玩家看的"** ✓（规范：看什么由产生它的那一步说 ✓，收发层不猜 ✗）
            查看: 牌.map((c) => ({ 键: c.uid, 名称: c.def.全名 })),
          };
          return;
        }
      }
      // ── 第二问：其余按什么顺序沉底（点选顺序 = 底块的从上到下）
      const 余 = 牌.filter((c) => !记忆.观星顶!.includes(c));
      /**
       * ⚠ **只要还有余牌，就一定要问** ✗→✓（用户口径 ✓）：
       *   原来这里是 `余.length > 1` ✗ —— 只剩 1 张时**静默置底** ✓，
       *   玩家看不到"它被放到哪了、也没点确认" ✗（2026-10 报的 ✓）。
       *   规则上"其余则以任意顺序置于牌库底"也是**一次要玩家做的选择** ✓ →
       *   统一成"有内容就问" ✓（1 张时这一问就是"看一眼 + 确认" ✓，下限 0 ✓ 直接确认也行 ✓）。
       */
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
      // ⚠ 底块必须**放回全部余牌**：第二问的下限是 0（可以一张都不点），
      //   但「其余则以任意顺序置于你的牌库底」说的是**所有**其余的牌 —— 不补齐的话
      //   没点到的那些会从牌库里**消失**（我第一版就是这样，日志还写着「0 张置底」）。
      const 底 = [...(记忆.观星底 ?? []),
        ...余.filter((c) => !(记忆.观星底 ?? []).includes(c))];
      // ── 落定：库 = [其余剩下的…] + [底块（从下到上 push）] + [顶块（从下到上 push）]
      for (const c of 牌) { const i2 = pl.library.indexOf(c); if (i2 >= 0) pl.library.splice(i2, 1); }
  // ⚠ **牌库底 = 下标 0**（顶 = 末尾 ✓，见 抓牌 用 library[length-1] ✓）—— 以前这里用 push ✗
  //   → 被"置底"的牌其实**推到了牌库顶** ✗ → 下一次观星又看到它们 ✗（2026-10-18 报的：无懈可击置底了又回来 ✓）
  for (const c of [...底].reverse()) pl.library.unshift(c);
      for (const c of [...记忆.观星顶!].reverse()) pl.library.push(c);
      记录(g, g.players[谁]!.name + ' 观星 ' + X + '：'
        + (记忆.观星顶!.length ? 记忆.观星顶!.map((c) => c.def.全名).join('、') + ' 置顶' : '没有置顶')
        + '，' + 底.length + ' 张置底');
      break;
    }
    case '检视': {
      // 「检视 <某玩家> 的牌库顶/手牌」—— 看的人是**这个能力的操控者**（viewer:'你'）。
      //   本体在 检视区域()（登记可见性 + 不记牌名的日志）。
      //   只看的写法：数量 0、每张都「不可选」。
      //   看完还要**选一张**的（149 清查 / 158 华歆 / 063 孙乾）写 数量/筛选/去处，
      //   收尾交给现成的 完成搜寻（应用选择 看到 去处 就会走它）。
      const 看的人 = item.操控者;
      const 玩家们 = 解析玩家们(g, item, 步骤.来源);
      const 区域 = 步骤.区域 ?? '牌库顶';
      const { 牌, 谁们的 } = 检视区域(g, 看的人, 玩家们, 区域);
      if (!牌.length) { 记录(g, g.players[看的人]!.name + ' 检视：' + 谁们的.join('、') + ' 是空的'); break; }
      // 「全部」= 候选里每一张（063 孙乾「将这些牌各置入其拥有者的墓地」）
      const 要看 = 步骤.数量 === '全部' ? 牌.length : (步骤.数量 ?? 0);
      item.待选择 = {
        类型: '搜寻',                      // 和搜寻共用同一个挂起与面板（都是「看一批牌再挑」）
        标签: '检视 ' + 谁们的.join('、')
          + (要看 > 0 ? '，选 ' + 要看 + ' 张' : '（仅你可见；看完点确认）'),
        区域,
        数量: 要看,
        // ⚠ **检视没有「可放弃」这个参数** ✓（701.17b 的「未搜寻到」是**搜寻**算出来的 ✓）。
        //   界面那层仍需要这个字段 ✓ → 纯检视**恒 false** ✓，不给数据留口子 ✗。
        可放弃: false,
        候选: 牌.map((c) => ({ uid: c.uid, 名称: c.def.全名,
          可选: 要看 > 0 && 符合筛选(g, c, 步骤.筛选, 有效特征(g, c)) })),
        玩家: 玩家们[玩家们.length - 1] ?? 看的人,
        去处: 步骤.去处,
      };
      return;                             // 挂起：由 应用选择 接着做（没写 去处 就不会移动任何牌）
    }
      case '明置':
        // 701.11a/b：让它保持展示牌面信息的状态
        for (const t2 of 解析受方(g, item, 步骤.to)) {
          if (typeof t2 === 'number') continue;
          设面(g, t2, '明置', item.操控者);
        }
        break;
      case '暗置':
        // 701.11c/d：让它保持隐藏牌面信息的状态（701.29a 偷窃就是暗置放逐区的牌）
        for (const t2 of 解析受方(g, item, 步骤.to)) {
          if (typeof t2 === 'number') continue;
          设面(g, t2, '暗置', item.操控者);
        }
        break;
      case '翻面':
        // 701.27：把它**翻到另一面牌面朝上**。
        //   ⚠ 701.27a：只有**双面牌**代表的实体才能翻面；
        //     701.27c：要求不是双面牌的实体翻面 → **什么都不发生**。
        //   ⚠ 701.27b：翻面与明置/暗置是**完全不同的动作** ——
        //     以前这里做的是「切换明置/暗置」，那是**旧词**（701.11e / 701.27g 已勘误），
        //     也是错的：会把「翻面」当成明置/暗置，还顺手触发了明置的触发。
        //   初阵没有双面牌，所以现在这里是空操作 —— 留着是为了规则完整。
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
        // 绝不允许静默通过：没注册就当场炸，而不是记一行日志当没事发生
        throw new Error('native 效应「' + 步骤.模块 + '」没有注册实现（引擎不提供默认行为）');
      }
      实现(g, item, 步骤);
      break;
    }
  }
  检查状态动作(g);
}

// ── 704 状态动作 ─────────────────────────────────────────────────
export function 检查状态动作(g: GameState): boolean {
  同步操控权与阵地(g);
  // 301.8 的对账。**两个方向都靠它**：
  //   · 「变成你操控」（613.1b 层 2 那条路已经会立刻搬一次，这里只是兜底）
  //   · 「操控权回到原主」—— 降服离场、附属没了，层 2 效应失效，**没有任何事件可挂**，
  //     只能在这里对账。少了它，单位会留在原操控者的阵地上，位置和操控权就分家了。
  // ⚠ 它现在**影响不了战斗** —— 伤害步骤用的是宣告攻击时**锁定的那个对象**（509.4），
  //   不再按 (玩家, 阵地) 现查，所以中途搬阵地不会让挨打的变成别人。
  //   （降服自己的单位不会触发：操控权本来就是自己，账是对的。）
  let 发生 = false;
  for (;;) {
    let 本轮 = false;
    for (const pl of g.players) {
      // 704.5a
      if (pl.体力 <= 0) { 结束对局(g, 1 - pl.index, pl.name + ' 的体力为 0 或更少（704.5a）'); return true; }
      // 704.5b
      if (pl.drewFromEmptyLibrary) { 结束对局(g, 1 - pl.index, pl.name + ' 试图从空牌库抓牌（704.5b）'); return true; }
    }
    {
      for (const o of g.战场.slice()) {
        const 是单位 = 是类别(g, o, '单位');       // 层4 生效后的类别
        // 704.5c
        if (是单位 && 体力上限(g, o) <= 0) { 记录(g, o.def.全名 + ' 体力上限为 0（704.5c）'); 置入墓地(g, o); 本轮 = true; continue; }
        // 704.5e：受到具有致命能力之来源的伤害
        if (是单位 && o.记忆['致命伤害'] && !带词(g, o, '不屈')) { 记录(g, o.def.全名 + ' 受到致命伤害被消灭（704.5e）'); 置入墓地(g, o); 本轮 = true; continue; }
        if (是单位 && o.记忆['致命伤害'] && 带词(g, o, '不屈')) 写记忆(g, o, '致命伤害', false);   // 702.38b：忽略致命伤害的状态动作
        // 704.5d
        if (是单位 && o.damage >= 体力上限(g, o) && 带词(g, o, '不屈')) {
          // 702.38b：具有不屈的实体不会被致死伤害消灭
        } else if (是单位 && o.damage >= 体力上限(g, o)) {
          记录(g, o.def.全名 + ' 受到致死伤害被消灭（704.5d）');
          置入墓地(g, o); 本轮 = true; continue;
        }
        // 704.5f：化身的灵值为 0
        if (是类别(g, o, '化身') && 灵值(g, o) <= 0) { 记录(g, o.def.全名 + ' 的灵值为 0（704.5f）'); 置入墓地(g, o); 本轮 = true; continue; }
        // 704.5l：数术阵略**附属在不合法的物件**上、或**未附属于**任何物件或玩家 → 置入墓地。
        //   也管「所附属的那个单位离场了」——306.4c 说附属关系随离场解除，那之后就归这条收。
        //   只对**有「附属」能力**的数术判（黑水祭天那种阵略没有附属能力，不受这条管）。
        if (关键词特征(g, o, '附属') !== undefined) {
          const 在 = o.附属在;
          const 合法 = 在 !== undefined && (在 <= 1 || g.战场.some((x) => x.uid === 在));
          if (!合法) { 记录(g, o.def.全名 + ' 未附属于任何合法对象（704.5l）'); 置入墓地(g, o); 本轮 = true; continue; }
        }
        // 704.5g：失去单位类别 → 移去其已损失的所有体力
        if (!是单位 && o.damage > 0) { 写伤害(g, o, 0); 记录(g, o.def.全名 + ' 不再是单位，移去已损失的体力（704.5g）'); 本轮 = true; }
        // 704.5n：+1/+1 与 -1/-1 标记相互抵消
        const 正 = o.标记.find((m) => m.类型 === '+1/+1');
        const 负 = o.标记.find((m) => m.类型 === '-1/-1');
        if (正 && 负) {
          const n = Math.min(正.数量, 负.数量);
          正.数量 -= n; 负.数量 -= n;
          写标记表(g, o, o.标记.filter((m) => m.数量 > 0));
          记录(g, o.def.全名 + ' 上 ' + n + ' 对 +1/+1 与 -1/-1 标记相互抵消（704.5n）');
          本轮 = true;
        }
        // 704.5h
        if (!是单位 && o.阵地) { g.players[有效控制器(g, o)]!.阵地[o.阵地] = null; 写阵地(g, o, null); 记录(g, o.def.全名 + ' 非单位实体被移出阵地（704.5h）'); 本轮 = true; }
      }
      // 704.5i 无双规则 + 206.4d「具有超类别「无双」的**实体**」
      // 206.4d 说的是「**实体**」，不是「单位」（无双领土也算）
      // 「一位玩家同时操控两个或更多…」—— 战场不按玩家分，按**有效控制器**分组
      // 战场共享 → 要按**有效控制器**分组才能问「一位玩家操控了几个」
      for (const pl of g.players) {
        const 无双 = g.战场.filter((o) => 有效控制器(g, o) === pl.index && (有效特征(g, o).超类别 ?? []).includes('无双'));   // 709.2a：暗置没有超类别 ✓（读 def 会把暗置的【无双】算进来 ✗）
        const seen = new Map<string, Obj[]>();
        for (const o of 无双) {
          // ⚠ 特征.名称 是**字符串**（不是数组 ✗）—— 以前这里 for...of 会逐**字符**遍历 ✓
    //   → 名字里都有的「·」被当成同一个名字 ✗ → 两张不同名的无双单位也被判同名放逐 ✗（2026-10-18 报的）
    for (const nm of [有效特征(g, o).名称]) {
            const arr = seen.get(nm) ?? []; arr.push(o); seen.set(nm, arr);
          }
        }
        for (const [nm, arr] of seen) {
          const uniq = [...new Set(arr)];
          if (uniq.length >= 2) {
            // 704.5i：「该玩家**选择**它们中的一个，其余的将被放逐」—— 真的问玩家。
            //   问不出去的原因以前是「同步检查里没有 待选择」；现在有引擎级的 g.待问。
            const 候选 = uniq.map((o) => ({ 键: o.uid, 名称: 有效特征(g, o).名称 }));
            const 已问过 = g.待问 && g.待问.候选.length === 候选.length
              && g.待问.候选.every((c) => uniq.some((o) => o.uid === c.键));
            if (已问过) {
              const 留 = new Set(g.待问!.回答 ?? []);
              const 保留 = uniq.find((o) => 留.has(o.uid)) ?? uniq[0]!;
              for (const o of uniq) if (o !== 保留) { 放逐(g, o); 记录(g, '无双规则：' + 有效特征(g, o).名称 + ' 被放逐（704.5i，与「' + nm + '」同名）'); 本轮 = true; }
              g.待问 = undefined;
            } else if (!g.待问) {
              g.待问 = { 玩家: pl.index, 类型: '选',
                标签: '无双规则（704.5i）：' + pl.name + ' 操控 ' + uniq.length + ' 个同名的「' + nm + '」，选一个保留（其余的放逐）',
                候选, 数量: { 最小: 1, 最大: 1 } };
              return 发生;                       // 停下来 —— 外层协程会把这个问题 yield 给玩家
            }
          }
        }
      }
    }
    // 704.5j 化身规则：同名的化身只留一个 —— 和 704.5i 一样，**是玩家选**，不是留第一个
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
    // 112.8 / 704.5k：指示物在战场以外的区域会消失
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

/** 结束对局（104.4 抓空牌库 / 704.5 体力归零 / 达到回合上限）。胜者传 null 就是平手 */
function 结束对局(g: GameState, 胜者: number | null, 原因: string): void {
  g.over = true; g.winner = 胜者;
  记录(g, '对局结束：' + (胜者 === null ? '平手' : g.players[胜者]!.name + ' 获胜') + ' —— ' + 原因);
}

// ── 执行动作（生成器：战斗会插入优先权窗口）────────────────────
function* 执行动作G(g: GameState, p: number, act: Action): Generator<请求, void, Action | null> {
  if (act.种类 === '打领土') 打出领土(g, p, act.card, act.面);
  else if (act.种类 === '转移') 转移(g, p, act.card, act.到, act.路径 ?? '转移');
  else if (act.种类 === '施放') 施放(g, p, act.card, act.目标, act.阵地, act.模式号, act.X, act.支付源, act.额外牺牲);
  else if (act.种类 === '启动能力') 启动能力(g, p, act.card, act.能力索引, act.目标, act.支付源, act.模式号, act.费用弃牌, act.费用牺牲, act.宣告X);
else if (act.种类 === '发起战斗') {
      // 120 长江天险：「除非其操控者支付{2}，否则该单位不能攻击你」——
      //   ⚠ **付不付是进攻方的选择** ✗→✓：以前引擎「替他付」✗，把「改打阵地 / 留着这 2 点」
      //   这个策略取舍直接抹掉了 ✓。现在：支付源由**宣告时**随动作一起给（需求里的可选槽 ✓，
      //   引擎的 `可支付来源` 只当候选 ✓）；不付 → 打不了那个玩家 ✓（但照样可以打他的阵地 ✓）。
      /**
       * **宣告攻击时：每个"要求额外动作"的能力各来一步** ✓ —— **线性链** ✓：
       *   每条问一次「支付 / 取消」→ 取消（没有回调）→ **整条链到此为止**（= 不宣告攻击 ✓）；
       *   全部付完 → 才走后面的 `执行战斗流程G`（= 宣告攻击）✓。
       * ⚠ 每一步的候选都按**当刻场面**算 ✓（前一步付掉的地已横置 → 下一步用不了 ✓）。
       * ⚠ 不新增字段、不分支：就是"这一步没返回 → 后面不做"（和所有操作一样 ✓）。
       */
      if (act.目标.种类 === '玩家') {
        for (const 条 of 攻击额外需求列表(g, act.目标.玩家)) {
          if (条.点 <= 0) continue;
          // ⚠ 用**新形状**（点数）—— 旧 费用:{通用} 被 支付 op 忽略 ✗ → 费=0 → 攻击税白送 ✗（子代理点名的那处 ✓）
          const 步 = { 操作: '支付', 点数: { 最小: 条.点, 最大: 条.点 } } as unknown as ResolveStep;
          const 子 = { 操控者: p, 步骤游标: 0, steps: [步],
            待选择: undefined as never, 上一步生效: false, 已开始: true, 种类: '令符', id: 0,
            标签: '攻击额外需求：' + 条.点名 } as unknown as StackItem;
          for (;;) {
            执行一步(g, 子, 步);
            if (!子.待选择) break;
            const 答 = yield { 玩家: p, 时机: {} as never, 步骤: '宣告攻击', 决定: 子.待选择 } as 请求;
            if (!答 || (答 as { 接受?: boolean }).接受 === false) return;   // ★ 取消（不接受/没有回调）→ 后面的（含宣告）都不做 ✓
            应用选择(g, 子, 答);
          }
          if (!子.上一步生效) return;               // 付不满/被拒 → 同样到此为止 ✓
          记录(g, g.players[p]!.name + ' 为攻击 ' + g.players[act.目标.玩家]!.name + ' 支付了 ' + 条.点 + ' 点（' + 条.点名 + '）');
        }
      }
      yield* 执行战斗流程G(g, p, act.card, act.目标);
    }
}

// ── 优先权循环（生成器版）────────────────────────────────────────
export interface 规格候选 { 类型: '实体' | '玩家'; uid?: number; 玩家?: number; 名称: string; 敌?: boolean }
export interface 规格 { 目标名: string; 数量: { 最小: number; 最大: number }; 候选: 规格候选[] }
export interface 宣告决定 {
  类型: '宣告';
  标签: string;
  来源uid: number;
  /**
   * 603.5：这条能力是「你可以…」（可选的）。⚠ 它**照样进堆叠**、选择在**结算时**作，
   * 所以选目标那一步要提示玩家「后面还会问一次用不用」—— 现在选目标不等于必须发动。
   */
  可选?: boolean;
  /** 有模式时：先选模式，再选该模式的目标 */
  模式候选?: { 索引: number; 标签: string; 规格: 规格[] }[];
  /** 无模式时的目标规格 */
  规格?: 规格[];
}

export interface 请求 {
  玩家: number;
  时机: 时机选项;
  步骤: string;
  /** 需要玩家做一个「选择」而不是「动作」 */
  决定?:
    | { 类型: '可选触发'; 标签: string; 栈id: number }
    | 宣告决定
    /** 701.17 搜寻：从某个区域挑牌。701.17a 要求先「检视该区域的所有牌」，所以要给全量候选 */
    | { 类型: '搜寻'; 标签: string; 区域: string; 数量: number; 可放弃: boolean; 候选: { uid: number; 名称: string; 可选: boolean }[] }
    /** 514 弃牌步骤：手牌超过上限，由该玩家选弃哪几张（117.3a：不给优先权，但弃牌是玩家选的） */
    | { 类型: '弃牌'; 需弃: number; 标签: string }
    /**
     * 103 开局的四步 —— **和上面四个平级**，不再是一个笼统的 \`'开局'\` 再拿 \`步骤\` 二次分派。
     *
     * 把握的原则：**\`决定.类型\` 回答「现在要做什么决定」**，一个类型对应客户端一个面板。
     * 以前开局只有一个类型 \`'开局'\`，逼得客户端写一个总入口 + 内部再 if 四次，
     * 而且 \`候选\` 这个字段在「决定先手」里是**座位号**、在「调度宣告」里是**张数**，
     * 同名不同义 —— 现在各自一个名字。
     */
    | { 类型: '决定先手'; 标签: string; 候选座位: number[] }
    | { 类型: '调度宣告'; 标签: string; 候选张数: number[] }
    | { 类型: '调度执行'; 标签: string; 张数: number; 手牌: { uid: number; 名称: string; 可选: boolean }[] }
    | { 类型: '看牌库顶'; 标签: string }
    // ⚠ 统一【选】：待选择原样发给玩家（选物件 / 选选项 / 选阵地…），AI 也必须答 ——
    //   不答的话那一步看到「还没选」会再挂一次同一问，空转（日志里反复「X 选了 （没有）」）。
    | { 类型: '选'; 选什么: '物件' | '选项' | '阵地' | '触发'; 标签?: string; 玩家: number;
        数量?: { 最小: number; 最大: number }; 候选?: { 键: number | string; 名称: string }[];
        /** ⚠ **这次让你看的牌**（只读 ✓，服务器给的 ✓，**不是候选** ✗）—— 如开局检视 ✓ */
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
    // **同步的状态检查里要玩家选**（704.5i 无双规则那种）—— 检查把问题放进 g.待问 并停下，
    //   由**这一层**（生成器）问出去：挂起 → 玩家答 → 写回回答 → 再跑一次检查（这次它消费答案）。
    //   「问」不该是堆叠项的属性（item.待选择 只有结算生成器能用），它就是引擎级的一等设施。
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
        // 「结算：」排在下面两问**之前** —— 要不要发动、结算时选目标，都属于这次结算。
        // ⚠ 判据用 item 自己的 已开始，**不新增标记**：它在 结算堆叠顶 真正开始跑效应时才置上，
        //   两问都还没置；而两问之间不会回到这里（发动了就直接往下走，见下面那条 continue）。
        // ⚠ **令符不在这里记** —— `结算令符()` 自己会记「结算：<牌名>」✓（engine.ts:2246 ✓）。
        //   两处都记就会出现同一张牌两行「结算：」✗（令符的 标签 和 全名 是同一个字符串 ✓ 肉眼看着就是重复 ✓）。
        if (!顶.已开始 && 顶.种类 !== '令符') 记录(g, '结算：' + 顶.标签);
        // 「你可以……」：结算时由操控者决定做不做（603 / 608）
        if (顶.可选 && !顶.decided) {
          const 答 = yield {
            玩家: 顶.操控者, 时机: opts, 步骤,
            决定: { 类型: '可选触发', 标签: 顶.标签, 栈id: 顶.id },
          };
          顶.decided = true;
          if (!答 || 答.种类 !== '决定' || !答.接受) 顶.declined = true;
          // ⚠ **只有「不发动」才回到循环顶部**（那一项不用再问目标）。发动了就往下走 ——
          //   回头的话「结算：」会被再记一次，玩家还会莫名多拿一次优先权。
          if (顶.declined) { 连续让过 = n; p = g.active; continue; }
        }

        // ⚠ **目标在这里选** —— 规则书没有规定触发式能力的目标在何时指定
        //   （603.3d 只是 603.3 那一节的叙述；603.3f 说的是模式、603.4 说的是条件）。
        //   本引擎定为**结算时**，而且在「你可以」那一问**之后**：先决定要不要做，再挑对象。
        if (顶.待定目标 && 顶.待定目标.length && 顶.来源) {
          // 必需的目标一个都挑不出来 → 能力取消、什么都不做（603.3f 的精神，只是移到结算这一刻）。
          //   ⚠ 这条必须在**问之前**判：候选为空时不该把问题发出去（问了也答不了）。
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
          // 115.9：「以…为目标」的历史条件/触发在**这一刻**发生（048 关平要用）
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
          // 效应链挂在等玩家选择上（例如 701.17 搜寻）—— 由该效应链的操控者选
          const 顶 = g.stack[g.stack.length - 1]!;
          // ⚠ 问**谁**：搜寻是效应链的操控者选；「选择牺牲」（132 宦毒的毒策）是**那个玩家**自己选
          // ⚠ 问**谁**：「选」可能是别人在选（132 宦毒的毒策是**目标玩家**自己挑），
          //   类型里带 玩家 就用它，其余的默认是效应链的操控者。
          //   ⚠ 只有**选**那个变体的 玩家 表示「谁来选」（132 宦毒的毒策是目标玩家自己挑）；
          //     搜寻/检视的 玩家 表示「看**谁**的区域」，两者的含义不同，别混（见 state.ts 的注释）。
          const 问谁 = 顶.待选择 && 顶.待选择.类型 === '选' ? 顶.待选择.玩家 : 顶.操控者;
          const 答 = yield { 玩家: 问谁, 时机: opts, 步骤, 决定: 顶.待选择 as never };
          应用选择(g, 顶, 答);
          // ⚠ **不要**在这里清零 `连续让过`（也别动 p）—— 608：一个能力**结算期间没有人获得优先权**。
          //   这里只是「结算当中的一问」（选目标/搜寻/观星…），答完要**接着结算**，
          //   不是重新开一轮优先权。清零会回到循环顶部问一圈让过 ——
          //   日志里就变成「结算：X」夹着「甲让过/乙让过」，而那时双方本来都不该有优先权。
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
      连续让过 = 0;                       // 117.4：有人执行了动作，连续让过重新计
      检查状态动作(g);
      // 117.3c：玩家在打出令符/启动能力/执行特殊动作时拥有优先权，之后**该玩家**得到优先权
      // 117.3b：结算之后得到优先权的是**进攻玩家** —— 战斗流程整段跑完属于这一类
      if (act.种类 === '发起战斗') p = g.active;
    } else {
      // 146 盲兵：「每回合若能发起战斗则必须发起战斗」—— 宣告攻击步骤里不能空过。
      //   ⚠ 兜底：同一个玩家被拒 8 次才放行 —— 只为防「完全不会进攻的策略」把对局挂死。
      // 505.4 / 506.2：注明「若能发起战斗则至少发起一次战斗」的单位，
      //   **在其行动阶段（堆叠为空、{通常}时机）里，只要能合法发起战斗，就不能让过优先权**。
      //   ⚠ 以前这里只判 `步骤 === '宣告攻击步骤'` —— 于是**行动阶段**点一次让过就把阶段过去了，
      //     规则根本没生效（盲兵在阵地上也照样能过）。
      const 必须打 = (步骤 === '行动阶段' || 步骤 === '宣告攻击步骤') && g.stack.length === 0
        ? g.战场.filter((u) => 有效控制器(g, u) === p && 有必须发起战斗(g, u) && 能发起战斗(g, p, u))
        : [];
      // 505.4 / 506.2：**没有兜底** —— 只要能合法发起战斗，就不能让过优先权。（规则就是规则）
      if (必须打.length > 0) {
        记录(g, '必须发起战斗（146）：' + g.players[p]!.name + ' 的 ' + 必须打.map((u) => u.def.全名).join('、') + ' 还能进攻，不能空过');
        continue;                       // 优先权仍在这个玩家手上
      }
      连续让过++;
      p = (p + 1) % n;                    // 117.3d：让过之后，下一位玩家得到优先权
    }
  }
}

/** 策略驱动的驱动方式（AI 用）：可选触发一律接受 */
export function 优先权循环(g: GameState, 策略表: 策略[], opts: 时机选项): void {
  const it = 优先权循环G(g, opts, '');
  let r = it.next();
  while (!r.done) {
    const req = r.value;
    if (req.决定) {
      r = it.next(自动宣告(g, req.决定) ?? { 种类: '决定', 接受: true });   // ⚠ 所有决定类型都走 自动宣告（它认识 选/搜寻/弃牌/宣告）
      continue;
    }
    r = it.next(策略表[req.玩家]!(g, req.玩家, req.时机));
  }
}

// ── 回合流程（500–513，生成器版）────────────────────────────────
export function* 进行回合G(g: GameState): Generator<请求, void, Action | null> {
  const p = g.active;
  g.turn++;
  const 该玩家 = g.players[p]!;
  该玩家.landsPlayedThisTurn = 0;
  // 事件记录清理：只留 本回合 + 上回合（「这盘游戏」类要留的话见 docs/02）
  写事件记录(g, g.事件记录.filter((e) => e.回合 >= g.turn - 1));
  if ((该玩家.跳过['重置步骤'] ?? 0) > 0) {          // 614.1b：重置步骤被略过
    该玩家.跳过['重置步骤'] = 该玩家.跳过['重置步骤']! - 1;
    记录(g, 该玩家.name + ' 的重置步骤被略过（还剩 ' + 该玩家.跳过['重置步骤'] + ' 次）');
  } else {
    for (const o of g.战场) {
    if (有效控制器(g, o) !== p) continue;                       // 只有**你操控的**重置
    // 034 一蹶不振：「所附属之单位于其操控者的重置步骤中**不能重置**」
    //   ⚠ 只挡重置步骤 —— 别的效应（如 082 徐庶的重置）照样能重置它。
    if (有效特征(g, o).不能重置) continue;
    写横置(g, o, false); 写整备(g, o, false);
  }
  }
  记录(g, '—— ' + g.players[p]!.name + ' 的第 ' + g.turn + ' 回合 ——');
  // 704.5q / 122.1d：准备步骤里有九个或更多天命标记的玩家赢得此盘
  for (const q of g.players) {
    if ((q.标记['天命'] ?? 0) >= 9) { 结束对局(g, q.index, q.name + ' 有九个天命标记（704.5q）'); return; }
  }
  排队步骤触发(g, '准备步骤');
  g.当前步骤 = '准备步骤';
  yield* 优先权循环G(g, { 允许打领土: false, 允许通常时机: false }, '准备步骤');
  if (g.over) return;
  // 103.7a：双人游戏中先手略过其第一个回合的抓牌步骤
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
  // 514 弃牌步骤：手牌超过上限就要弃，**弃哪几张由该玩家选**
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
      const 弃 = pl.hand[pl.hand.length - 1]!;          // 没给选择就兜底，避免卡死
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
  // 711：本回合结束的持续性效应失效
  写连续效应(g, g.连续效应.filter((e) => e.时长 !== '直到回合结束'));
  // 603.7：本回合登记的延迟触发也在这时清掉（'下一次' 的触发时就自己删了）
  g.守望 = g.守望.filter((w) => w.时长 !== '直到回合结束');
  检查状态动作(g);
}

/**
 * **跑完一个回合** —— 把 `进行回合G` 那个生成器一路推到底。
 * 生成器要求「下一步该谁做什么」时，由 `策略表[玩家]` 给答案；返回 null 就是让过。
 * 无界面跑整局（`cli.ts`）和测试里的整局冒烟都走它。
 */

export function 进行回合(g: GameState, 策略表: 策略[]): void {
  const it = 进行回合G(g);
  let r = it.next();
  while (!r.done) {
    const req = r.value;
    if (req.决定) {
      r = it.next(自动宣告(g, req.决定) ?? { 种类: '决定', 接受: true });   // ⚠ 所有决定类型都走 自动宣告（它认识 选/搜寻/弃牌/宣告）
      continue;
    }
    r = it.next(策略表[req.玩家]!(g, req.玩家, req.时机));
  }
}

/**
 * 103 开局流程 —— **和回合循环用同一套驱动**：yield 一个请求，等应答，继续。
 *
 * ⚠ 以前开局是**另一套平行系统**：服务端 `/api/开局` 手工分发四个引擎函数，
 *   客户端自己按阶段推算「该谁操作」，而回合那套的「谁在动」是 `请求.玩家` 说了算。
 *   两套并存的后果：「该谁」判断漏过三次（调度宣告/调度执行/后手看牌库顶）、
 *   推送绕过了 `推进()` 漏过两次、`房.it` 可能是 null、`房.开局还在进行` 手工同步会不同步。
 *   放进生成器之后这些从结构上都不存在了 —— **开局只是回合循环前面的一段**。
 */
function* 开局流程G(g: GameState): Generator<请求, void, Action | null> {
  const o = g.开局;
  if (!o) return;
  const 无时机: 时机选项 = { 允许打领土: false, 允许通常时机: false };
  const 人数 = g.players.length;

  // 103.1 决定先手。**联机由服务端在发牌时就随机定了** —— 那时手牌已经发过，
  //   这一段自然跳过；只有热座（要人来点）才会 yield 出去。
  //   ⚠ 判据从「o.阶段 === '决定先手'」换成「手牌发过了没有」—— 阶段那个字段已经删了。
  if (g.players.every((pl) => pl.hand.length === 0)) {
    const 候选座位 = Array.from({ length: 人数 }, (_, i) => i);
    const a = yield { 玩家: 0, 时机: 无时机, 步骤: '决定先手',
      决定: { 类型: '决定先手', 标签: '决定先后手', 候选座位 } };
    const 先 = a && a.种类 === '决定' && typeof a.先手 === 'number' && 候选座位.includes(a.先手)
      ? a.先手 : Math.floor(g.随机源() * 人数);
    决定先手(g, 先);
  }

  // 由先手开始依次 —— **顺序就是这个数组**，不再存进状态、也不用函数去推进它
  const 顺序 = Array.from({ length: 人数 }, (_, i) => (g.先手玩家 + i) % 人数);

  // 103.4 前半：依次宣告调度张数
  for (const p of 顺序) {
    const pl = g.players[p]!;
    const 下限 = Math.max(0, o.起手牌数 - pl.hand.length);      // 103.4：不足七张时必须补足差额
    const 候选: number[] = [];
    for (let k = 下限; k <= pl.hand.length; k++) 候选.push(k);
    const a = yield { 玩家: p, 时机: 无时机, 步骤: '调度宣告',
      决定: { 类型: '调度宣告', 标签: '要调度几张？', 候选张数: 候选 } };
    const n = a && a.种类 === '决定' && typeof a.张数 === 'number' && 候选.includes(a.张数) ? a.张数 : 下限;
    if (!宣告调度(g, p, n)) { 记录(g, '⚠ 调度宣告无效，按 ' + 下限 + ' 张处理'); 宣告调度(g, p, 下限); }
  }

  // 103.4 后半：**宣告了才执行** —— 顺序同样在这个循环里
  for (const p of 顺序) {
    const n = o.调度张数[p] ?? 0;
    if (n <= 0) continue;
    const pl = g.players[p]!;
    const a = yield { 玩家: p, 时机: 无时机, 步骤: '调度执行',
      决定: { 类型: '调度执行', 标签: '选出 ' + n + ' 张放回牌库', 张数: n,
              手牌: pl.hand.map((x) => ({ uid: x.uid, 名称: x.def.全名, 可选: true })) } };
    // ⚠ `a.选` 现在可能是字符串（选项类），调度只认 uid —— 收窄成数字再交下去。
    const 选 = (a && a.种类 === '决定' && Array.isArray(a.选) ? a.选 : pl.hand.slice(0, n).map((x) => x.uid))
      .filter((x): x is number => typeof x === 'number');
    if (!执行调度(g, p, 选)) {
      记录(g, '⚠ 调度执行无效，自动选前 ' + n + ' 张');
      执行调度(g, p, pl.hand.slice(0, n).map((x) => x.uid));
    }
  }

  // 103.6 后手检视自己的牌库顶
  {
    const 后 = (g.先手玩家 + 1) % 人数;
    const lib = g.players[后]!.library;
    const 顶 = lib[lib.length - 1];
    // ⚠ **103.6 的检视就走【检视】这个操作** ✓（701.17）—— 用**和它同一个挂起形状** ✓：
    //   类型:'搜寻' + 标签以「检视」开头 ✓ —— 客户端那条现成的「检视/搜寻」面板就会把牌显示出来 ✓。
    //   以前自己造了个 `类型:'看牌库顶'` 的决定 ✗ → 牌没界面显示 ✓ → 客户端只好再写一个识别条件 ✗
    //   （同一个操作的两套显示 ✓，我已经被这么坑过好几次 ✓）。
    if (顶) {
      // ⚠ **一次检视 = 一份登记** ✓（和 检视区域 同一个口径 ✓）：这里也是"新的一次检视" ✓
      //   → 必须先清掉这个人上一次的登记 ✓，否则它会一直留在界面的「检视」里 ✗
      //   （2026-10 报的：观星 3 张，界面上却写着「检视（4 张）」✓ —— 多出来的那张就是这里 ✗）。
      清检视(g);   // 同上：一次检视 = 一份登记 ✓
      登记检视(g, 后, 顶);
      yield { 玩家: 后, 时机: 无时机, 步骤: '后手看牌库顶',
        决定: { 类型: '选', 选什么: '物件', 玩家: 后, 标签: '检视 ' + g.players[后]!.name + ' 的牌库顶（仅你可见；看完点确认）',
          数量: { 最小: 0, 最大: 0 },   // ⚠ 只看不选（需 0/0 ✓）—— 这里**不再借搜寻的形状** ✓（014 那条 701.17b 的注释随之作废 ✓）
          //   检视只是看，没有「找不到」这回事 ✓（数量 0 已让确认在什么都没选时也能按 ✓）。
          //   ⚠ 按规范：那张牌是**查看内容**（只读 ✓），**不是候选** ✗ —— 用 `给看()` 说 ✓
          //   （引擎里产生 `查看` 只有这一处 ✓；这里是最普通的一次"给某人看一张牌" ✓）。
          查看: 给看({}, [{ 键: 顶.uid, 名称: 顶.def.全名 }]).查看 } };

    }
    // 看完之后才是 103.6 的**决定**（留顶/置底 ✓）—— 那是另一件事 ✓（所以是第二个请求 ✓）
    const a = yield { 玩家: 后, 时机: 无时机, 步骤: '后手决定顶牌去向',
      决定: { 类型: '看牌库顶', 标签: '103.6：牌库顶牌留在牌库顶，还是置于牌库底？' } };
    后手决定顶牌去向(g, !(a && a.种类 === '决定' && a.接受 === false));
  }

  // **开局做完了 —— 把这块状态整个丢掉**。「完成」不是一个状态，是「没有开局这回事」。
  //   客户端判断「对局中」也从 `s.开局.阶段 === '完成'` 变成 `!s.开局`。
  g.开局 = null;
}

export function* 整局G(g: GameState): Generator<请求, void, Action | null> {
  // 103 开局：**和回合循环接在一起**，不再是一套平行系统
  yield* 开局流程G(g);
  g.active = g.先手玩家;
  let 守卫 = 0;
  while (!g.over && 守卫++ < 300) {
    yield* 进行回合G(g);
    if (g.over) break;
    g.active = (g.active + 1) % g.players.length;
  }
}

// ── 506–510 战斗流程（生成器：每步之间给优先权）──────────────────
function 同一攻击对象(a: 攻击对象, b: 攻击对象): boolean {
  if (a.种类 !== b.种类) return false;
  if (a.玩家 !== b.玩家) return false;
  if (a.种类 === '阵地' && b.种类 === '阵地') return a.阵地 === b.阵地;
  return true;
}
/** 攻击对象在日志里的说法：「某玩家」或「相对阵地 X」 */
function 攻击对象描述(g: GameState, t: 攻击对象): string {
  return t.种类 === '玩家' ? g.players[t.玩家]!.name : ('相对阵地 ' + t.阵地);
}

/** 507.1a：未横置、不处于整备状态、可以攻击、且至少有一个合法攻击对象 */
export function 能发起战斗(g: GameState, p: number, u: Obj): boolean {
  if (g.over) return false;
  if (!u.def.类别.includes('单位')) return false;
  // 613.1b：操控权可能是层 2 改出来的
  if (有效控制器(g, u) !== p || u.区域 !== '战场' || !u.阵地) return false;
  if (玩家被禁(g, p, '发起战斗', u)) return false;   // 613.10 + 506.1：该玩家本回合不能发起战斗
  if (u.tapped) return false;
  if (u.sick && !有词(g, u, '神速')) return false;
  if (带词(g, u, '据守')) return false;              // 702.46b：具有据守的单位不能发起战斗
  if (有自身限制(g, u, '发起战斗')) return false;      // 169 防栅「不能发起战斗」
  return 合法攻击对象(g, p, u).length > 0;
}

/** 508.2e 的攻击对象合法性 */
/**
 * **攻击这个玩家要先付的通用费用** ✓ —— 读的是通用的「额外需求」✓（不是某张牌的专用字段 ✗）。
 * 120 长江天险 = `{ 动作:'发起战斗', 对象:'玩家', 费用:{ 通用:2 } }` ✓；多个取**最高** ✓。
 * ⚠ 以前字段叫 `攻击税` ✗（一张牌一个概念 ✗），2026-10 收成通用字段 ✓。
 */
/**
 * 额外需求 是否作用于「这类动作 / 这类对象」✓ —— 唯一的匹配处 ✓。
 * 对象 缺省 = 该动作的任何对象 ✓。以后加「单位/领土」的适用范围，改这里就够 ✓。
 */
/** `额外需求.做` 里**支付**的点数之和 ✓（费用只是"支付"这一种操作 ✓） */
function 额外需求里的支付点数(r: { 做?: Record<string, unknown>[] } | undefined): number {
  let 点 = 0;
  for (const 步 of r?.做 ?? []) {
    if (!步 || 步.操作 !== '支付') continue;
    const 数 = (步.点数 ?? {}) as { 最小?: number; 最大?: number };
    点 += 数.最小 ?? 0;
  }
  return 点;
}
function 额外需求命中(r: { 动作: string; 对象?: string } | undefined, 动作: string, 对象: string): boolean {
  if (!r) return false;
  if (r.动作 !== 动作) return false;
  if (r.对象 !== undefined && r.对象 !== 对象) return false;
  return true;
}
/**
 * **攻击这个玩家之前"必须先做的事"**（`额外需求.先做` ✓）—— 收集处 ✓。
 * 现在全项目**还没有牌用到它** ✓（只有长江天险的费用型 ✓），但入口先立在这里 ✓：
 * 以后哪张牌写 `先做:{ 操作:'横置', … }`，只在这里收集 + 在「发起战斗」需求/执行里走**同一个** `执行一步` ✓，
 * 不要再为新的要求种类发明字段 ✗。
 */
export function 攻击额外要求(g: GameState, 目标玩家: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (let i = 0; i < g.players.length; i++) {
    const pl = g.players[i]!;
    for (const o of [...g.战场, ...pl.graveyard]) {
      if (有效控制器(g, o) !== 目标玩家 && i !== 目标玩家) continue;
      for (const ab of ((o.def.能力?.能力 ?? []) as unknown as StaticAbility[])) {
        if (ab.种类 !== '静止式') continue;
        if (!额外需求命中(ab.额外需求, '发起战斗', '玩家')) continue;
        for (const 步 of ab.额外需求?.做 ?? []) if (!步 || 步.操作 !== '支付') out.push(步);
      }
    }
  }
  return out;
}
/**
 * **攻击这个玩家的"额外要求"清单** ✓ —— **按能力实例各一条** ✓（界面据此**逐步**选择 ✓）。
 * 每条：`{ 来源, 点名, 点, 可选 }` ✓（`可选` 缺省 = 强制：不付 → **取消这次攻击** ✓；
 *   可选：付了 → 记"已支付"，不付 → 只丢它的效果 ✓，攻击照常 ✓ —— 118.7b）。
 * ⚠ 以前的 `攻击额外费用()` 把多条**合成一个数字** ✗ → 界面只能一次选完 ✗（分步做不到 ✗）。
 */
export function 攻击额外需求列表(g: GameState, 目标玩家: number): { 来源: number; 点名: string; 点: number }[] {
  const out: { 来源: number; 点名: string; 点: number }[] = [];
  for (const o of g.战场) {
    if (o.面 === '暗置' || 有效控制器(g, o) !== 目标玩家) continue;
    for (const ab of (o.def.能力?.能力 ?? []) as StaticAbility[]) {
      if (ab.种类 !== '静止式' || !额外需求命中(ab.额外需求, '发起战斗', '玩家')) continue;
      out.push({ 来源: o.uid, 点名: o.def.全名, 点: 额外需求里的支付点数(ab.额外需求) });
    }
  }
  return out;
}
export function 攻击额外费用(g: GameState, 目标玩家: number): number {
  let 税 = 0;
  for (const o of g.战场) {
    if (o.面 === '暗置' || 有效控制器(g, o) !== 目标玩家) continue;
    for (const ab of (o.def.能力?.能力 ?? []) as StaticAbility[]) {
      // ★ 唯一处理点 ✓：额外需求 里和「攻击玩家」有关的，取最大费用 ✓
      // ★ 规则依据：118.1（费用用来**阻止**另一个动作）+ 118.7/118.7a（可以有**多个**额外费用，必须**同时支付**）
      //   ⇒ **每张各自收**：两张长江天险 = 2+2 = 4 ✓（以前用 Math.max ✗ 两张也只收 2 ✗）
      if (ab.种类 === '静止式' && 额外需求命中(ab.额外需求, '发起战斗', '玩家')) 税 += 额外需求里的支付点数(ab.额外需求);
    }
  }
  return 税;
}

export function 合法攻击对象(g: GameState, p: number, u: Obj): 攻击对象[] {
  if (!u.阵地) return [];                      // 阵地外单位不能发起战斗（没有相对阵地可攻击）
  const 敌 = (p + 1) % g.players.length;
  const 相对 = 相对阵地(u.阵地)!;
  const 挡 = g.players[敌]!.阵地[相对];
  const out: 攻击对象[] = [];
  // 166 冲车「不能攻击阵地」—— 那它就只能打玩家；对方阵地有未横置单位时它没有合法对象
  const 可攻阵地 = !有自身限制(g, u, '攻击阵地');
  /**
   * ⚠ **这里不再判"付得起税"** ✗→✓（2026-10-17 查清）：
   *   那个门是"税由引擎在结算时自动付"时代的产物 ✗。现在**攻击前的需求**强制先付
   *   （`收发需求` 里支付源槽 `需 = 税..税` ✓），而 `执行动作` 也是**先付钱再跑战斗流程** ✓
   *   → 等走到这里时**钱已经付了**（领土已横置 ✓）→ 再判"付得起"必然 false ✗
   *   → `能发起战斗` 的"至少一个合法攻击对象"失败 ✗ → **507.1a 中止 + 钱白扣** ✗✓
   *   （记录：`乙 为攻击 甲 支付了 2 点` 紧跟 `青州探马 不满足发起战斗的条件，战斗中止（507.1a）` ✓）
   *   "付不起就不给这个选项"由 `列出合法动作`/需求的 `需` 负责 ✓，不在这里重复 ✗。
   */
  const 可打玩家 = (): void => { out.push({ 种类: '玩家', 玩家: 敌 }); };
  if (!挡) 可打玩家();
  else if (挡.tapped) { if (可攻阵地) out.push({ 种类: '阵地', 玩家: 敌, 阵地: 相对 }); 可打玩家(); }
  else if (可攻阵地) out.push({ 种类: '阵地', 玩家: 敌, 阵地: 相对 });
  return out;
}

/** 508：某单位宣告攻击后，把它自己那些「当此单位宣告攻击时」的触发放进待触发队列 */
export function 排队宣告攻击触发(g: GameState, u: Obj, 受方?: number | Obj): void {
  // ⚠ 同上：以前只看 u 自己 ✗；现在全场广播 ✓（「当另一个单位宣告攻击时」也认 ✓）
  排队单位事件触发(g, '宣告攻击', u, { 触发受方: 受方 });
}
export function* 执行战斗流程G(g: GameState, p: number, u: Obj, 期望目标: 攻击对象): Generator<请求, void, Action | null> {
  // 117.1b：战斗流程中不是通常时机（打领土/起通常能力/再发起战斗都不行）
  g.战斗中 = true;
  try {
  // 507 战斗准备步骤
  if (!能发起战斗(g, p, u)) { 记录(g, u.def.全名 + ' 不满足发起战斗的条件，战斗中止（507.1a）'); return; }
  记录(g, '—— 战斗流程：' + u.def.全名 + '（507 战斗准备步骤）——');
  yield* 优先权循环G(g, 战斗时机, '战斗准备步骤');     // 507.2 进攻玩家得到优先权
  if (g.over) return;
  if (u.区域 !== '战场' || !u.阵地) { 记录(g, '507.3：进攻单位离开阵地，战斗流程中止'); return; }
  // 508 宣告攻击步骤
  if (!能发起战斗(g, p, u)) { 记录(g, '508.1：不再满足条件，本次战斗流程中止，该单位本回合不能再次发起战斗'); return; }
  const 合法 = 合法攻击对象(g, p, u);
  if (!合法.some((x) => 同一攻击对象(x, 期望目标))) {
    记录(g, '508.2f：没有合法的攻击对象，战斗流程中止，该单位本回合不能再次发起战斗');
    return;
  }
  写横置(g, u, true);                                     // 508.2h
  排队单位事件触发(g, '成为横置', u);
  记录(g, u.def.全名 + ' 宣告攻击 ' + 攻击对象描述(g, 期望目标) + '（508.2g 攻击对象已锁定）');
   // 508.2l：触发要带上**攻击对象**，条件是「攻击的是谁」那类要靠它（066 万人敌·张飞）。
   //   打玩家 → 玩家号；打阵地 → **站在那个阵地上的单位**（509.4 保证它存在），
   //   这样 `{ 操作:'触发受方是', 是:'实体' }` 正好等价于「攻击的是相对阵地」。
   const 攻击受方 = 期望目标.种类 === '玩家'
     ? 期望目标.玩家
     : (g.players[期望目标.玩家]!.阵地[期望目标.阵地] ?? undefined);
   排队宣告攻击触发(g, u, 攻击受方);                                // 508.2l
  yield* 优先权循环G(g, 战斗时机, '宣告攻击步骤');        // 508.3
  if (g.over) return;
  // 509 结算伤害步骤
  // 702.78 暴击：此单位按**武力的两倍**分配**战斗伤害**（非战斗伤害不受影响）
  const 战力 = (x: Obj) => { const p = 武力(g, x); return 带词(g, x, '暴击') ? p * 2 : p; };   // 702.78b
  if (期望目标.种类 === '玩家') {
    const 力 = 战力(u);
    if (力 > 0) 伤害事件(g, u, [{ 目标: 期望目标.玩家, 数量: 力, 战斗伤害: true }]);   // 509.3（120.4：这是战斗伤害）
    else 记录(g, u.def.全名 + ' 武力为 0，不造成伤害（509.2）');
  } else {
    // ⚠ **用宣告攻击时锁定的那个对象**，不要按 (玩家, 阵地) 现查 ——
    //   现查等于「战斗结果取决于结算那一刻谁站在那个格子上」：任何在这之间发生的
    //   阵地变动（301.8 的搬动、别的效应）都会让挨打的变成别人。
    //   508.2g 锁的是**对象**，509.4 只关心它还在不在战场上。
    const 挡 = (攻击受方 !== undefined && typeof 攻击受方 !== 'number' && 攻击受方.区域 === '战场')
      ? 攻击受方 : null;
    if (!挡) 记录(g, '结算伤害时阵地上已无单位，双方都不造成战斗伤害（509.4）');
    else {
      const 攻 = 战力(u), 防 = 战力(挡);
      const 受方: { 目标: Obj | number; 数量: number; 来源?: Obj | null; 战斗伤害?: boolean }[] = [];
      let 攻剩 = 攻;
      // 702.8b 破竹：「首先将伤害分配给该阵地上的单位。一旦该阵地上的单位已被分配了
      //   **足以被消灭的伤害**，则可以将**剩余的伤害在该单位和防御玩家之间分配**。
      //   当检索单位是否分配了足以被消灭的伤害时，**需考虑单位上已有的伤害**。」
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
      if (受方.length) 伤害事件(g, u, 受方);            // 509.4：一个伤害事件、两个受方
      else 记录(g, '双方武力均为 0，不造成战斗伤害（509.2）');
    }
  }
  if (g.over) return;
  yield* 优先权循环G(g, 战斗时机, '结算伤害步骤');        // 509.6
  if (g.over) return;
  yield* 优先权循环G(g, 战斗时机, '战斗结束步骤');        // 510.1
  记录(g, '战斗流程结束，回到行动阶段（510.3）');
  } finally { g.战斗中 = false; }
}

/** 自动推进（AI / 无界面场合）：可选触发一律接受 */
export function 执行战斗流程(g: GameState, p: number, u: Obj, 目标: 攻击对象): void {
  const it = 执行战斗流程G(g, p, u, 目标);
  let r = it.next();
  while (!r.done) {
    const d = r.value.决定;
    r = it.next(d ? (d.类型 === '宣告' ? 自动宣告(g, d) : { 种类: '决定', 接受: true }) : { 种类: '让过' });
  }
}

// ── 602 启动式能力 ───────────────────────────────────────────────
/**
 * 这个物件当前**实际具有的能力列表** —— 702.1：关键词就是能力，所以两条来源合起来就是全部：
 *   ① 牌面印制的（`o.def.能力`，逐条 解析能力() 展开关键词）
 *   ② 层6 授予的关键词（`有效特征.关键词` 里 `印制: false` 的，逐条展开）
 *
 * ⚠ **逐份展开、不去重** —— 一个自己印着射击2 又挨着【吕范】的单位，
 *   在这里就是**两个**射击2，各自可以被单独启动（702.6d 那一批规则）。
 * ⚠ 「失去所有能力」（层6）时只剩牌面部分（那时牌面能力也没了，靠 有规则叙述 挡）。
 */
export function 有效能力列表(g: GameState, o: Obj): Ability[] {
  const 印 = ((o.def.能力?.能力 ?? []) as Ability[]).map(解析能力);
  if (o.区域 !== '战场') return 印;                 // 层6 只在战场上生效
  const f = 有效特征(g, o);
  if (f.失去所有能力) return 印;
  const 授 = f.关键词.filter((k) => !k.印制 && 能解析(k.名称))
    .map((k) => 解析能力({ 名称: k.名称, ...(k.数值 !== undefined ? { 数值: k.数值 } : {}) } as 关键词能力 as Ability));
  return [...印, ...授];
}

/** 当前有哪些启动式能力可以启动（费用、时机、限制、启动条件都要过） */
export function 可用启动式能力(g: GameState, p: number, o: Obj): number[] {
  if (!有规则叙述(g, o)) return [];               // 709.2a / 层6
  const 通常时机 = 处于通常时机(g, p);
  if (g.over || 有效控制器(g, o) !== p) return [];
  // 702.69a 再起「于具有再起能力的牌**在墓地中时**生效」—— 所以合法区域不止战场
  const 合法区域 = o.区域 === '战场' || (o.区域 === '墓地' && 有词(g, o, '再起'));
  if (!合法区域) return [];
  const 已用 = 本回合用过的能力(o, g.turn);
  const out: number[] = [];
  有效能力列表(g, o).forEach((ab0, i) => {
    // 关键词能力先按 702 章展开（射击 → {通常}{横置}→…）
    const ab = ab0 as unknown as ActivatedAbility;
    if (ab.种类 !== '启动式' || ab.是费用能力) return;   // 费用能力由支付流程处理
    if (ab.限制 === '每回合一次' && 已用.includes(i)) return;
    if (ab.时机 !== '瞬发' && !通常时机) return;
    if (取费用行为(ab.费用, '横置') && (o.tapped || (o.sick && !有词(g, o, '神速')))) return;
    const 支付 = 支付费用(ab.费用);
    const 通用数 = 支付.宣告X ? 0 : 支付.点数;   // 带 X 的能力最小可付 0
    if (通用数 && !可支付数字费用(g, p, 通用数)) return;
    // 只要求「付得起」：体力不足不能付（118.3）
    const 体力费 = 取费用行为(ab.费用, '体力');
    if (体力费 && g.players[p]!.体力 < 体力费.点数) return;
    if (ab.条件 && !判断(g, p, ab.条件)) return;
    // 702.7b 佩带：「此能力**只可以于此装备未佩带时**启动」
    if ((ab as { 名称?: string }).名称 === '佩带' && o.佩带在 !== undefined) return;
    out.push(i);
  });
  return out;
}

/** 启动一个启动式能力：先选目标（601.1），再付全额费用（118.3），然后进堆叠 */
export function 启动能力(g: GameState, p: number, o: Obj, 索引: number, 目标已选?: 目标[], 支付源?: number[], 模式号?: number, 费用弃牌?: number[], 费用牺牲?: number[], 宣告X?: number): boolean {
  // ⚠ 索引指的是 有效能力列表 的下标 —— 牌面印的在前，层6 授予的关键词在后（逐份）。
  //   这样「两个独立的射击2」就是两个不同的下标，各自启动、各自结算。
  const ab = 有效能力列表(g, o)[索引] as unknown as ActivatedAbility | undefined;
  if (!ab || ab.种类 !== '启动式') return false;
  const 目标: 目标[] = [];
  const 目标槽: Record<string, 目标> = {};
  // 700.2b：模式在进堆叠时就定了 —— 有模式就取那一个选项的目标与效应
  //   （徐庶 082「横置或重置另一个目标单位」：能力本身是空的，全在选项里）
  const 模式项 = ab.模式 && 模式号 !== undefined ? ab.模式.选项[模式号] : undefined;
  const 规格表 = 模式项?.目标 ?? ab.目标 ?? [];
  for (let i = 0; i < 规格表.length; i++) {
    const spec = 规格表[i]!;
    // ⚠ 玩家选好的目标**照用**。
    //   以前这里一律自动挑 —— 每个槽各自偏好「第一个敌人」，**多目标的启动式能力**
    //   （129 貂蝉「两个非女性单位决斗」）两个槽的候选集一样，于是必然撞成同一个目标。
    //   单目标时凑巧对，所以一直没暴露。
    const 给了 = 目标已选 ? 目标已选[i] : undefined;
    if (给了 !== undefined) { 目标.push(给了); 目标槽[spec.目标名] = 给了; continue; }
    // 没给（服务端兜底 / AI）才自动挑。必须传「锚」= 能力来源 —— relation 是相对**它**算的。
    const 候选 = 候选目标(g, p, spec, o);
    if (候选.length < spec.数量.最小) { 记录(g, o.def.全名 + '：目标不足，启动失败'); return false; }
    const 敌 = 候选.find((c) => (c.obj ? c.obj.操控者 !== p : c.玩家 !== p));
    const 取 = 敌 ?? 候选[0]!;
    目标.push(取.obj ?? 取.玩家!);
    目标槽[spec.目标名] = 取.obj ?? 取.玩家!;
  }
  // 付费用（费用必须全额）
  // 108.3a：费用里带 {X} 的启动式能力 —— X 由启动的玩家宣告（085 周瑜 / 105 孙权）
    const 支付 = 支付费用(ab.费用);
  // ★ 费用点数要**求值**（108.3a/108.3i）：周瑜 {X}{X} = 费用点数 {乘以:'X',系数:2} = 2X ✓
  //   以前写成 `宣告X ? 宣告X : 支付.点数` ✗ → 周瑜只收 X（能付 3）✗
  const 通用数 = 费用点数值(取费用行为(ab.费用, '支付')?.点数, 宣告X);
  if (通用数 && !支付数字费用(g, p, 通用数, 支付源)) { 记录(g, '数字费用支付失败'); return false; }
  const 体力费 = 取费用行为(ab.费用, '体力');
  if (体力费) g.players[p]!.体力 -= 体力费.点数;
  // ⚠ **单位自己的体力**：给**来源单位** o 记伤害标记 ✓（和 `失去体力` 那一步同款 ✓）——不是玩家 ✓
  const 自身体力费 = 取费用行为(ab.费用, '自身体力');
  if (自身体力费) {
    写伤害(g, o, o.damage + 自身体力费.点数);
    记录(g, o.def.全名 + ' 失去 ' + 自身体力费.点数 + ' 点体力（启动费用）');
  }
  if (取费用行为(ab.费用, '横置')) 写横置(g, o, true);
  排队单位事件触发(g, '成为横置', o);
  // 602.1d：「→」前的「弃一张牌」「牺牲一个单位」都是**启动费用** —— 进堆叠之前付掉。
  //   候选由玩家选（界面上的槽），这里只校验够不够、并真的执行。
  const 弃牌费 = 取费用行为(ab.费用, '弃牌');
  if (弃牌费) {
    const 要弃 = 弃牌费.宣告X ? (宣告X ?? 0) : 弃牌费.数量.最小;
    const 选 = (费用弃牌 ?? []).filter((uid) => g.players[p]!.hand.some((c) => c.uid === uid));
    if (选.length < 要弃) { 记录(g, o.def.全名 + '：弃牌费用付不出（需要 ' + 要弃 + ' 张）'); return false; }
    for (const uid of 选.slice(0, 要弃)) {
      const c = g.players[p]!.hand.find((x) => x.uid === uid)!;
      记录(g, g.players[p]!.name + ' 弃掉 ' + c.def.全名 + '（启动费用，602.1d）');
      置入墓地(g, c);
    }
  }
  const 牺牲费 = 取费用行为(ab.费用, '牺牲');
  if (牺牲费) {
    const 选 = (费用牺牲 ?? []).map((uid) => g.战场.find((x) => x.uid === uid)).filter((x): x is Obj => !!x && 有效控制器(g, x) === p);
    if (选.length < 牺牲费.数量.最小) { 记录(g, o.def.全名 + '：牺牲费用付不出（需要 ' + 牺牲费.数量.最小 + ' 个）'); return false; }
    for (const x of 选.slice(0, 牺牲费.数量.最小)) 牺牲(g, x);
  }
  // 费用：启动这个能力时把**来源**暗置（701.11c）。走统一入口，好触发「当…暗置时」。
  if (取费用行为(ab.费用, '暗置进场')) 设面(g, o, '暗置', p);
  const 牺牲自己 = 取费用行为(ab.费用, '牺牲自身');
  if (ab.限制 === '每回合一次') {
    const 已用 = 本回合用过的能力(o, g.turn);
    写记忆(g, o, '本回合已用能力', { 回合: g.turn, 索引: [...已用, 索引] });
  }
  记录(g, g.players[p]!.name + ' 启动 ' + o.def.全名 + ' 的能力' + (ab.标签 ? '：' + ab.标签 : ''));
  // 108.3a / 601.2f：把额外费用牺牲掉的那个单位记在堆叠项上 —— 效应里的 { ref:'额外牺牲' } 读它
  堆叠加(g, {
    id: g.nextStackId++, 种类: '启动式',
    标签: o.def.全名 + (ab.标签 ? '：' + ab.标签 : ' 的能力'),
    操控者: p, 来源: o, card: null, 目标, 目标槽, steps: 模式项?.效应 ?? ab.效应,
    宣告X: 支付.宣告X ? (宣告X ?? 0) : undefined,   // 108.3a：效应里的 'X' 读它
    能力名: (ab.标签 ?? '').startsWith('射击') ? '射击' : undefined,   // 702.10c：射击伤害的判据（106）
  });
  if (牺牲自己) 牺牲(g, o);
  return true;
}
