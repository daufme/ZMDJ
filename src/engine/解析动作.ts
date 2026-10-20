/**
 * **线格式动作 → 引擎 Action**。
 *
 * 客户端发来的是**线格式**：物件用 uid 引用、字段全是不可信的 JSON。
 * 引擎要的是**内部格式**：物件已经解析成 Obj、字段有类型。
 *
 * ⚠ 这层转换原来写在 `server.ts` 的 `应用()` 里（8 个分支各写一遍），于是
 *   「决定」那条**漏搬了 `先手` / `张数`** —— 点「甲先手」服务端把它丢了、
 *   引擎只好随机，表现成「点甲先手结果乙先手」。而漏字段是**静默**的。
 *
 * ⚠ 它**放在 engine/ 而不是 server.ts**，有两个原因：
 *   ① 它管的就是「外部输入 → 引擎动作」这条边界，是引擎的事；
 *   ② **`server.ts` 一被 import 就开 HTTP 服务器**，放在那里就没法单元测试
 *      （导入即启动 → node:test 报「test 结束后仍有异步活动」）。
 *
 * 防线有两道：
 *   ① **编译期**：每个变体一张字段表，`satisfies 全字段表<'决定'>` ——
 *      类型加了字段而表里没加，**编译就不过**；
 *   ② **运行期**：`src/test/线动作.test.ts` 直接喂 JSON 断言解析结果。
 *
 * 有了这两道，解析逻辑就**不再靠人记得** —— 加字段忘了搬，编译先拦住。
 */
import type { Obj, GameState } from './state.js';
import { 实际打出费用, 可用启动式能力, 可支付来源 } from './engine.js';
import { 牌面费用值, 支付费用, 费用点数形状, 取费用行为 } from './费用.js';
import type { Action, 目标, 攻击对象 } from './engine.js';
import type { 阵地, 费用行为 } from './types.js';

/**
 * **uid → 任何区域里的实体** —— 手牌 / 牌库 / 墓地 / 放逐区 / 战场 / 堆叠上的牌都找。
 *
 * ⚠ 为什么单独有一个：`找实体`（engine.ts）**只找战场与堆叠**，那是给触发/堆叠来源用的；
 *   而「目标」可以是别的区域里的牌 —— 108 祖茂 / 139 回天术 / 118 英魂附体 都从**墓地**里选目标。
 *   以前这里只查了 战场上 和 堆叠，于是墓地里的目标一确认就报「目标已不存在」。
 */
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

/** 客户端发来的动作：字段一律不可信 */
export type 线动作 = { 种类?: unknown } & Record<string, unknown>;

/**
 * **一个 Action 变体的完整字段表**（含 `种类`）。
 * `satisfies 全字段表<'决定'>` 会强制表里**覆盖该变体的每一个字段** ——
 * 这就是防「漏搬字段」的那道编译期闸门。
 */
type 全字段表<K extends Action['种类']> = Record<keyof Extract<Action, { 种类: K }>, () => unknown>;

type 解析结果 = { ok: true; 动作: Action } | { ok: false; 错误: string };

// uid 列表字段（弃牌 / 支付源 / 额外牺牲 / 费用弃牌 / 费用牺牲）——
//   ⚠ **同样是原样透传** ✓：数字就是数字 ✓，不需要这里再「解析」一遍 ✗
//   （以前是 map(Number) ✓ —— 那才是「把 '左边路' 变成 NaN」的元凶 ✗）。
const 数字数组 = (v: unknown): number[] | undefined =>
  Array.isArray(v) ? (v as number[]) : undefined;
// ⚠ **「选」不能走 数字数组** ✗ —— 它的键有两种：
//   · 数字 = 物件的 uid（选牌那种 ✓）
//   · 字符串 = 阵地名 / 选项键 / 触发键（**征召选阵地就是 '左边路'** ✓）
//   旧写法 `v.map(Number)` 把 '左边路' 变成 **NaN** ✓ → 引擎记「甲 选了 NaN」、
//   「征召：选的阵地不合法」→ 指示物永远进不了场（就是你抓到的 19 号请求 ✓：
//     界面发的是 {"决定","接受":true,"选":["左边路"]} ✓ 完全正确 ✓，是这里被我转坏的 ✓）。
const 选择数组 = (v: unknown): (number | string)[] | undefined =>
  Array.isArray(v) ? (v as (number | string)[]) : undefined;   // 原样透传 ✓ 不校验元素类型 ✓
const 数字 = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
const 零或一 = (v: unknown): number | undefined => (v === 0 || v === 1 ? v : undefined);
const 是数组 = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/**
 * ⚠ **从「槽」来的值一律是数组** ✓ —— 单值字段（`阵地` / `到` / `先手` / `张数` / `接受` / `攻击对象`…）
 *   在这里按**字段**收窄：取首 ✓。
 *
 * 这样收发层不必声明「这一槽要几个」，客户端也不必猜形状 ✗ ——
 *   「按名额猜形状」正是「单选的决定发了标量 → 引擎静默丢掉选择 → 日志『X 选了（没有）』」的成因 ✓。
 * ⚠ 列表字段（`选` / `弃牌` / `支付源` / `额外牺牲` / `费用弃牌` / `费用牺牲`）**不走取首** ✗
 *   —— 一个元素的列表取首就变成标量了 ✓。
 */
const 取首 = (v: unknown): unknown => (Array.isArray(v) ? v[0] : v);
const 数字1 = (v: unknown): number | undefined => 数字(取首(v));
const 零或一1 = (v: unknown): number | undefined => 零或一(取首(v));
const 是布尔 = (v: unknown): boolean => !!取首(v);

/**
 * **把线格式的动作解析成引擎 Action**（顺带做语义校验）。
 * 纯函数：只读 `房.g`，不产生副作用 —— 可以单独喂 JSON 断言结果。
 */
/**
 * **挑了这几个费用源 = 宣告了多少点**（108.3a：「挑几块地就是几」）✓
 * ⚠ 以前这个数由**客户端**算（`已付额`）✗ —— 现在边界这里算一次，
 *   于是收发层的模板里不必有 `X` 字段，客户端也不再持有任何数值规则 ✓。
 */
function 源提供(g: GameState, 座位: number, 源: number[]): number {
  const 表 = 可支付来源(g, 座位);
  return 源.reduce((n, uid) => n + (表.find((x) => x.uid === uid)?.提供 ?? 0), 0);
}

export function 解析动作(g: GameState, p: number, 体: 线动作): 解析结果 {
  const me = g.players[p]!;
  const 手上 = (uid: unknown) => me.hand.find((x) => x.uid === uid);
  const 场上 = (uid: unknown) => g.战场.find((x) => x.uid === uid);
  /** 按表造对象：表里没有的键**一个都不读**（这就是不再手写搬字段的地方） */
  const 造 = (表: Record<string, () => unknown>): Record<string, unknown> => {
    const 出: Record<string, unknown> = {};
    for (const k of Object.keys(表)) { const v = 表[k]!(); if (v !== undefined) 出[k] = v; }
    return 出;
  };

  switch (体.种类) {
    case '让过':
      return { ok: true, 动作: 造({ 种类: () => '让过' } satisfies 全字段表<'让过'>) as unknown as Action };

    case '决定': {
      // ⚠ 这里以前漏了 先手 / 张数 —— 现在表覆盖不全就编译不过
      const 表 = {
        种类: () => '决定',
        // ⚠ 这三个都是**单值字段**：槽来的值是数组 → 取首 ✓（见 取首 的说明）
        接受: () => 是布尔(体.接受),
        弃牌: () => 数字数组(体.弃牌),
        选: () => 选择数组(体.选),
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
        // 114.9：能力的 uid 是**负数**（-StackItem.id）—— 见 选项.ts 的 候选 注释
        if (t.类型 === '堆叠项' || (typeof t.uid === 'number' && t.uid < 0)) { 目标表.push({ 堆叠项: -(t.uid as number) }); continue; }
        // 目标不只在战场上 —— 「正被打出的牌」在**堆叠**上（无懈可击就取消它）
        // 目标可以在任何区域（墓地里选牌那种）—— 见 找任意区域物件 的注释
        const obj = 找任意区域物件(g, t.uid as number);
        if (!obj) return { ok: false, 错误: '目标已不存在' };
        目标表.push(obj);
      }
      // 118.2 / 118.3a：支付数字费用要玩家**自己**启动费用能力（挑地），服务端不再代劳。
      // 604：**实际费用**（含费用修正，例如【李典】在场时对手锦囊 +1）
      const 源 = 数字数组(体.支付源) ?? [];
      // 108.3a：费用带 {X} 的牌，X = **挑了几个费用源**（挑几块地就是几 ✓）——
      //   线上给了 X 就用它 ✓，没给就按支付源推导 ✓（客户端不再自己算 ✗）。
      const X = 牌面费用值(o.def.打出费用) === 'X' ? (数字1(体.X) ?? 源提供(g, p, 源)) : 数字1(体.X);
      const 需付 = 牌面费用值(o.def.打出费用) === 'X' ? (X ?? 0) : 实际打出费用(g, p, o.def);
      if (需付 > 0 && 源.length === 0) {
        return { ok: false, 错误: '这张牌要付 ' + 需付 + ' 点数字费用，请先挑要启动的领土（304.8）' };
      }
      const 表 = {
        种类: () => '施放', card: () => o, 目标: () => 目标表,
        阵地: () => 取首(体.阵地) as 阵地 | undefined,
        模式号: () => 数字1(体.模式号),
        X: () => X,
      // 601.2f：额外费用选择（每项 { 操作, uid }）—— 旧字段 额外牺牲 兼容成一条「牺牲」
      额外: () => {
        const 出: { 操作: string; uid?: number }[] = [];
        for (const x of 是数组(体.额外)) {
          if (!x || typeof x !== 'object') continue;
          const 操作 = String((x as { 操作?: unknown }).操作 ?? '');
          const uid = 数字1((x as { uid?: unknown }).uid);
          if (操作) 出.push({ 操作, ...(uid !== undefined ? { uid } : {}) });
        }
        for (const uid of 数字数组(体.额外牺牲) ?? []) 出.push({ 操作: '牺牲', uid });
        return 出.length ? 出 : undefined;
      },
      额外牺牲: () => 数字数组(体.额外牺牲),
        支付源: () => (源.length ? 源 : undefined),
      } satisfies 全字段表<'施放'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }

    case '宣告': {
      // ⚠ `模式` 也是**单值字段** ✓ —— 从槽来的是数组 → 取首 ✓
      //   （「客户端不翻译」以后宣告也走模板，模板里 `模式` 是 `$模式` → 数组 ✓；
      //     不改这里的话模式会被静默丢掉 ✗ —— 真跑冒烟抓到过 ✓）
      const 表 = { 种类: () => '宣告', 模式: () => 数字1(体.模式), 目标: () => 是数组(体.目标) } satisfies 全字段表<'宣告'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }

    case '启动能力': {
      const o = 场上(体.uid);
      if (!o) return { ok: false, 错误: '找不到该实体' };
      // 117.1a / 117.1b：{瞬发}的能力随时可用；{通常}的能力要求通常时机
      if (!可用启动式能力(g, p, o).includes(体.能力索引 as number)) {
        return { ok: false, 错误: '这个能力现在不能启动（时机、费用或限制不满足）' };
      }
      // 数字费用同样要**玩家自己挑地**（和施放一致，不再有自动支付）
      const ab = (o.def.能力?.能力 ?? [])[体.能力索引 as number] as { 费用?: 费用行为[] } | undefined;
      const 源 = 数字数组(体.支付源) ?? [];
      const 支付 = 支付费用(ab?.费用);
      // 108.3a：{X} 的能力同理 —— 宣告的 X = **挑了几个费用源** ✓（线上没给就推导 ✓）
      // ★ X 的正确算法：挑的点数 ÷ 步进（周瑜 {X}{X} → 步进 2：挑 4 点 = X=2，需付 4 ✓）
  //   以前 `?? 源提供(...)` 直接拿点数当 X ✗ → 2X 变成"挑 N 要付 2N"，永远凑不齐 ✗
  const 费步进 = 费用点数形状(取费用行为((ab as { 费用?: 费用行为[] } | undefined)?.费用, '支付')?.点数).步进;
  const 源头数 = 源提供(g, p, 源);
  const 宣告X = 数字1(体.宣告X) ?? (支付.宣告X ? Math.floor(源头数 / (费步进 > 1 ? 费步进 : 1)) : undefined);
      // ★ 费用点数可以是 Value（统一后）：数字 / 'X' / {乘以,系数} / 旧区间{最小,最大} —— 在这里求值
  const 算点 = (v: unknown): number => {
    if (typeof v === 'number') return v;
    if (v === 'X') return 宣告X ?? 0;
    if (v && typeof v === 'object') {
      const o2 = v as Record<string, unknown>;
      if ('乘以' in o2) return 算点(o2.乘以) * Number(o2.系数 ?? 1);
      if ('最小' in o2) return Number(o2.最小 ?? 0);
    }
    return 0;
  };
  const 需付 = 算点(支付.点数);
      if (需付 > 0 && 源.length === 0) {
        return { ok: false, 错误: '这个能力要付 ' + 需付 + ' 点数字费用，请先挑要启动的领土（304.8）' };
      }
      // ⚠ **目标必须搬过来** —— 多目标的启动式能力（129 貂蝉）靠它；
      //   不搬的话引擎只能自动挑，而自动挑对每个槽都选「第一个敌人」→ 两个槽撞成同一个。
      const 目标表: 目标[] = [];
      for (const t of 是数组(体.目标) as Record<string, unknown>[]) {
        if (t.类型 === '玩家') { 目标表.push(t.玩家 as number); continue; }
        if (t.类型 === '堆叠项' || (typeof t.uid === 'number' && t.uid < 0)) { 目标表.push({ 堆叠项: -(t.uid as number) }); continue; }
        // 目标可以在任何区域（墓地里选牌那种）—— 见 找任意区域物件 的注释
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
        费用横置: () => 数字数组(体.费用横置),
      宣告X: () => 宣告X,
  费用步进: () => (体.费用步进 as { 偏移: number; 步进: number } | undefined),
      } satisfies 全字段表<'启动能力'>;
      return { ok: true, 动作: 造(表) as unknown as Action };
    }

    case '发起战斗': {
      const u = 场上(体.uid);
      if (!u) return { ok: false, 错误: '找不到该单位' };
      // ⚠ 攻击对象从槽来（数组）→ 取首 ✓（`发` 里带的是原对象：{种类:'玩家',玩家} / {种类:'阵地',玩家,阵地}）
      const t = 取首(体.攻击对象) as Record<string, unknown> | undefined;
      if (!t) return { ok: false, 错误: '缺少攻击对象' };
      const 表 = {
        种类: () => '发起战斗', card: () => u,
        // 120 长江天险：进攻方自己选的支付源 ✓（引擎**不再替他付** ✗）
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

