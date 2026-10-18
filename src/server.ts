/**
 * 对战服务器：支持 全本地 / 局域网 / 公网 三种连接方式。
 *
 * 启动：node dist/server.js
 * 配置：改「服务器配置.json」（没有就用默认值），或用环境变量 PORT / HOST 覆盖。
 *
 * 三种模式在**代码上没有区别**，区别全在网络层：
 *   全本地   监听「全部」也能用 127.0.0.1 连；客户端就是本机浏览器
 *   局域网   监听「全部」+ Windows 防火墙放行；客户端用启动时打印的内网地址
 *   公网     监听「全部」+ 路由器端口映射（或内网穿透）；**一定要设口令**
 * 客户端全程使用相对地址（/api/...），所以换地址不用改客户端。
 */
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
import { 默认牌组, 缺牌替代 } from './data/decks.js';   // 初阵甲/初阵乙 只在 decks.ts 里当素材，服务端只用默认牌组
import { 系列配置 } from './data/系列配置.js';
import { 卡号, 卡图 } from './engine/types.js';
import type {CardDef} from './engine/types.js';
import { 需求_动作, 需求_决定, 合并同族动作, type 需求 } from './收发需求.js';

/**
 * 按 系列配置 动态装载卡池。
 * 约定：**文件名 = 系列名**，文件里导出 `<系列名>卡` 这个 CardDef[]。
 * 所以加新系列不用改这里 —— 新建文件 + 在 系列配置 里加一行就行。
 */
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
// 缺牌替代**不进卡池**（它不该出现在组牌界面），但要在索引里 ——
//   否则默认牌组存档解析时（下面 map 卡池索引.get(id)）会被静默丢掉，牌组悄悄少几张。
// ⚠ 撞号守卫：卡号是「系列-编号」，两处手写字符串很容易撞（撞了会静默覆盖，
//   表现是「存了 A 牌，读回来是 B 牌」）。这里宁可当场炸掉也不要静默出错。
{
  const k = 卡号(缺牌替代);
  if (卡池索引.has(k)) throw new Error('缺牌替代 的卡号 ' + k + ' 和真牌「' + 卡池索引.get(k)!.全名 + '」撞号了');
  卡池索引.set(k, 缺牌替代);
}

let v = 20250101;
/** 线性同余伪随机 —— 洗牌用。**每个服务端进程固定**，所以同一局重放结果一致 */
const rnd = (): number => { v = (v * 1103515245 + 12345) % 2147483648; return v / 2147483648; };

/* ── 房间系统 ──────────────────────────────────────────────
   每个房间一局牌。房间码 4 位（去掉易混的 0/O/1/I）。
   令牌 → 房间+座位 的映射是全局的（令牌本来就是发给某个人的）。
   **所有用到对局状态的函数都显式收「房」参数** —— 不用全局变量模拟上下文，
   否则两个请求并发时（收JSON 是回调式的异步）会串局。 */
interface 座位 {
  令牌: string;
  名字: string;
  /** 最后一次收到这个座位的请求的时刻。客户端每 1.2 秒轮询 /api/state，那次轮询就是心跳 */
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
  本次日志?: string[];   // 这一步产生的日志行（等算完用时再写人读日志 ✓）   // 只把**新增**的对局日志打到服务端控制台 ✓
  /** 测试用：跳过 100.2a 的全部构筑限制（同名≤3、主牌 50 张以上） */
  无限制组牌: boolean;
  入座: [座位 | null, 座位 | null];
  /** 热座房间：私人调试用，不出现在房间列表，也不接受第二个人 */
  热座?: boolean;
  创建时间: number;
  /** 已经开过局（决定过先手）—— 中途离座会让这局作废，不能再让人接手 */
  已开始: boolean;
  /** 有人在对局中离座 → 这局作废，不再接受新人 */
  废弃: boolean;
  /**
   * **双方各自的「准备」**（联机的开局前一步）。
   * 两个座位都点了准备，才发牌、才走 103 的开局流程。
   * 热座房间不需要（一个人）
   */
  准备: [boolean, boolean];
  /** 最后一次有人动作 / 心跳的时刻，回收按它算 */
  最后活动: number;
}
/**
 * 超过这么久没动静、**而且 SSE 也没连着**才算掉线。
 * ⚠ 为什么放到 90 秒：客户端在**后台 / 最小化的标签页**里，浏览器会把定时器节流到
 *   大约 60 秒一次 —— 兜底轮询（8 秒一次）实际上停了。原来阈值是 15 秒，于是
 *   「两个浏览器最小化一个就显示掉线」。（SSE 不受这个节流影响，见 在线。）
 */
const 掉线阈值 = 90_000;
/**
 * 这个座位是不是「在场」。
 *
 * ⚠ **不能只看最后见到**：SSE 是一条真连接，浏览器不会因为标签页在后台就掐掉它，
 *   所以「SSE 还连着」= 这个人在。轮询只是兜底通道，它在后台会被节流到近乎停止，
 *   拿它当唯一在场证据就会误判掉线。
 */
function 在线(s: 座位 | null): boolean {
  if (!s) return false;
  for (const p of 推送表) if (p.令牌 !== null && p.令牌 === s.令牌) return true;   // SSE 还连着
  return Date.now() - s.最后见到 < 掉线阈值;
}
const 房间表 = new Map<string, 房间>();
/** 座位 = -1 表示**热座**：一个人控制两边、看全部信息（视图/应用收到 null 座位） */
const 令牌表 = new Map<string, { 房: 房间; 座位: number }>();
const 房间码字母 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * 生成一个没被占用的**房间码**（4 位）。字母表去掉了 `0/O/1/I` 这些看着像的，
 * 因为房间码是要**口头/手抄**传给对手的。
 * 撞了就重试，200 次还撞不出来说明房间表快满了（不太可能，纯粹是别死循环）。
 */
function 新房间码(): string {
  for (let 试 = 0; 试 < 200; 试++) {
    let s = '';
    for (let i = 0; i < 4; i++) s += 房间码字母[Math.floor(Math.random() * 房间码字母.length)];
    if (!房间表.has(s)) return s;
  }
  return 'R' + Date.now().toString(36).toUpperCase().slice(-4);
}

/** 建房或取房。`选项.热座` = **建房那一刻就带上** ✓（见下面那次 推送大厅 的原因 ✗） */
function 取房间(号?: string, 选项?: { 热座?: boolean }): 房间 {
  const 码 = (号 || '').toUpperCase().trim();
  if (码 && 房间表.has(码)) return 房间表.get(码)!;
  const 房: 房间 = {
    号: 码 || 新房间码(),
    甲: 默认牌组, 乙: 默认牌组,   // 双方同一副默认牌组
    // ⚠ **热座必须在建房时写上** ✓ —— 下面第 164 行那次 `推送大厅()` 会立刻广播房间列表 ✓，
    //   而列表是 `filter((x) => !x.热座)` ✓；以前调用方是"先建房、之后才 房.热座 = true" ✗ →
    //   第一次广播**把这间热座房泄露给大厅** ✓ → 界面上"显示一会儿再消失" ✓（2026-10 报的 ✓）。
    热座: 选项?.热座 === true ? true : undefined,
    g: null!, it: null!, 当前: null,
    AI代理: [false, false], 无限制组牌: false, 准备: [false, false], 入座: [null, null], 创建时间: Date.now(),
    已开始: false, 废弃: false, 最后活动: Date.now(),
  };
  房间表.set(房.号, 房);
  // ⚠ **只管建房，不发牌** —— 「发不发牌」由调用方决定，因为只有它知道是不是热座。
  //   以前这里写的是 `if (房.热座) 发牌并开局(...)`，但调用方（/api/入座 热座分支）
  //   是**先调这里、之后才 房.热座 = true** —— 判断永远为假，
  //   于是热座房只建了 g 没建 it，走完开局一推进就崩（症状：卡在「引擎处理中…」，
  //   点「新开一局」就好了，因为那条路会真的调 发牌并开局）。
  房.g = 新对局([房.甲, 房.乙], rnd, { 自动开局: false });
  推送大厅();      // ⚠ 必须在 房.g 建好之后 —— 房间列表要读 g.turn
  return 房;
}

/**
 * 按令牌找房间。**没有令牌就返回 null** —— 绝不兜底到某个共享房间：
 * 公网下两个人同时不带令牌打开就会落进同一局、互相看到手牌、互相能替对方操作。
 */
function 按令牌(令牌: unknown): 房间 | null {
  const t = typeof 令牌 === 'string' ? 令牌 : '';
  return (t ? 令牌表.get(t)?.房 : null) ?? null;
}
/** 视图用的座位：热座（-1）→ null（上帝视角） */
function 视图座位(座: { 座位: number } | null): number | null {
  if (!座) return null;
  return 座.座位 < 0 ? null : 座.座位;
}
/**
 * 令牌 → `{房, 座位}`。**同时是心跳**：任何带令牌的请求走到这里，都会刷新 `最后见到`。
 * ⚠ 「在不在线」不要只看这个时间戳，见 `在线()` —— 客户端在后台标签页里轮询会被节流。
 */
function 找座位(令牌: unknown): { 房: 房间; 座位: number } | null {
  const t = typeof 令牌 === 'string' ? 令牌 : '';
  const 记 = t ? (令牌表.get(t) ?? null) : null;
  // 心跳：任何带令牌的请求都算「这个人还在」（客户端 1.2 秒轮询一次 /api/state）
  if (记) {
    const 座 = 记.房.入座.find((s) => s?.令牌 === t);
    if (座) { 座.最后见到 = Date.now(); 记!.房.最后活动 = Date.now(); }
  }
  return 记;
}
/** 两位玩家都到齐才能开局（掉线的不算到齐，但他占着座位可以重连） */
function 人齐了(房: 房间): boolean { return !!房.入座[0] && !!房.入座[1] && 在线(房.入座[0]) && 在线(房.入座[1]); }
/**
 * **可以开局了吗**：热座一个人就算准备好；联机要人齐 **且双方都点了准备**。
 * 这是「两个人都进房间就直接进战场」和「等双方准备好了再开始」的分界。
 */
function 都准备好了(房: 房间): boolean {
  if (房.热座) return true;
  if (!人齐了(房)) return false;
  return !!(房.准备[0] && 房.准备[1]);
}
/** 大厅/页面上那份「谁坐在哪个位子上、在不在线」的名单（没人的位子是 null） */
function 入座视图(房: 房间) {
  return 房.入座.map((s, i) => (s ? { 座位: i, 名字: s.名字, 在线: 在线(s) } : null));
}

/** 卡图是否存在（只查一次，之后走缓存）—— 不存在就下发 null，界面用空白斜纹底 */
const 图存在 = new Map<string, boolean>();
/** 卡图在不在磁盘上。查一次就缓存 —— 每张牌每次推状态都 `existsSync` 会拖垮推送 */
function 有卡图(c: CardDef): boolean {
  const 路 = 'web' + 卡图(c);
  let v = 图存在.get(路);
  if (v === undefined) { v = fs.existsSync(路); 图存在.set(路, v); }
  return v;
}


/** 100.2a 同名≤3；206.4c 超类别「基本」的牌数量不受限制 */
function 校验牌组(ids: string[], 无限制 = false): { 错误: string[]; 警告: string[] } {
  const 错误: string[] = [];
  const 警告: string[] = [];
  // 测试用：跳过构筑规则，但仍然拦「未知卡牌」（那是数据问题，不是构筑规则）
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
  // 100.2a：构筑赛主牌必须 50 张以上（**硬下限**）。
  //   100.2b 的限制赛（35 张）和 100.3 的备牌**暂不实现**。
  if (ids.length < 50) 错误.push('构筑赛主牌必须 50 张以上（100.2a），当前 ' + ids.length + ' 张');
  return { 错误, 警告 };
}

/**
 * **卡池视图**：组牌界面要用的那份清单。给的是**印制的**费用/势力（不是某个对局里算完的），
 * 因为组牌发生在对局之前。
 * `房` 可选：带上时额外返回该房间的自定义规则（`无限制`），不带就是纯卡池。
 */
function 池视图(房?: 房间) {
  return {
    卡池: 卡池.map((c) => ({
      id: 卡号(c), 系列: c.系列, 编号: c.编号, 名称: c.全名, 类别: c.类别, 副类别: c.副类别,
      费用: c.打出费用, 势力: c.势力, 支持: c.势力支持 ?? null,
      基本: (c.超类别 ?? []).includes('基本'), 武力: c.武力 ?? null, 体力上限: c.体力上限 ?? null,
      文字: c.现行文字,
      // 卡图：组牌界面要显示牌面（有卡图才给，没有的下发 null，界面用空白斜纹底）
      图: 有卡图(c) ? 卡图(c) : null,
      // 组牌筛选要用的几个维度（客户端不必自己从别处推）
      超类别: c.超类别 ?? [],
      需求: c.势力需求?.符号 ?? {},
      是单位: (c.类别 ?? []).includes('单位'),
    })),
    甲: (房?.甲 ?? []).map(卡号), 乙: (房?.乙 ?? []).map(卡号),
    // 测试用开关的状态 —— 客户端要拿它渲染按钮
    无限制: !!房?.无限制组牌,
  };
}


/**
 * **SSE 推送表**：谁在听哪个房间的哪个座位。
 * ⚠ 必须带「座位」—— 视图是按座位生成的（对手手牌是隐藏的），推给两边的内容不一样。
 */
const 推送表 = new Set<{ res: import('http').ServerResponse; 房: 房间 | null; 座位: number | null;
  /** 连接时用的令牌 —— 「这个座位在不在场」靠它匹配（在线() 用它，见那里） */
  令牌: string | null }>();
// 房 = null 表示**大厅订阅**（还没入座的人）—— 他们只关心房间列表。

/** 每个房间最后一次推出去的指纹 —— 状态没变就不重复推（这样「多调一次推送」是无害的）*/
const 上次推送 = new WeakMap<房间, string>();

/** 把最新状态推给这个房间里所有在听的人（各自按自己的座位生成视图） */
function 推送(房: 房间): void {
  if (!推送表.size) return;
  // 指纹只需要回答「有没有变」—— 用几个一变就动的计数拼一个，别再整份 `JSON.stringify(视图)`：
  //   那是 O(状态)，且随日志变长越来越贵；而推送很频繁（每个动作、AI 每步都要过这里）。
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

/**
 * **改房：所有会改变房间状态的操作都从这走** —— 跑完自动推送。
 *
 * ⚠ 以前是「每个端点自己记得调 推送(房)」，结果 `/api/准备` 和 `/api/开局` 都漏过，
 *   表现是「操作完对面半天没反应」（只能等 8 秒轮询）。
 *   配上 推送 的指纹去重之后，从这走**多推一次也不会多发**，所以统一入口是安全的。
 */
/** ── **卡顿诊断** ─────────────────────────────────────────────
 *  服务端是**单线程**的 ✓：任何一处同步的活儿（推进生成器、算候选、序列化大状态…）
 *  都会把**所有**客户端一起卡住 ✓（表现就是「界面突然变卡」✓）。
 *  所以这里量两个唯一入口的耗时 ✓，超过阈值就按行打出来 ✓（带是谁、什么动作 ✓），
 *  出问题后直接 grep `[慢]` 就能定位是哪一步 ✓。
 */
/** ── **通信/对局数据记录（JSONL）** ──────────────────────────────
 *  目的：出问题能**对号**排查 ✓ —— 每条事件都带
 *    时间（ISO ✓）/ 请求号（**贯穿整条链** ✓）/ 房间 / 座位 / 方向 / 内容 / 耗时 ✓
 *  不是给人读的文本 ✗（那一行行的对局日志界面里本来就能看 ✓）—— 这是给机器查的数据 ✓。
 *  用法：grep 请求号 / grep "慢":true / grep 类:"收" 就能把一次交互的全过程串起来 ✓。
 *  路径：环境变量 ZMDJ_DATA_LOG，默认 `对局数据.jsonl`（追加 ✓）。
 */
const 对局信息路径 = process.env.ZMDJ_DATA_LOG ?? '对局信息.jsonl';
let 数据出口 = (() => { try { return fs.openSync(对局信息路径, 'a'); } catch { return null; } })();
/** 新局时**覆盖**对局信息（测试阶段就一个文件 ✓）—— 同时写一行新局标记 ✓ */
function 对局信息重开(房间号: string): void {
  try { if (数据出口 !== null) fs.closeSync(数据出口); } catch {}
  try { fs.writeFileSync(对局信息路径, ''); } catch {}
  数据出口 = (() => { try { return fs.openSync(对局信息路径, 'a'); } catch { return null; } })();
  事件序号 = 0; 当前段 = 0;   // 新一局：编号从 1 重新开始 ✓
  写记录({ 类: '新局', 房间: 房间号 });
  写记录({ 类: '标记', 人读: '──── 新局 ' + 房间号 + ' ' + new Date().toLocaleString() + ' ────' });
}
/** 给人看的那一份：`<编号>  <用时>ms  <客户端日志那一行>` ✓ ——
 *  你在客户端看到某一行 → 在 服务器.log 里 grep 它 → 拿到编号 → 用编号去 对局信息.jsonl 查通信 ✓ */
// 格式：`<通信编号>  <用时>ms  <客户端日志那一行>` ✓
//   编号 = **那条收信**的编号 ✓（对局信息.jsonl 里同一个编号下就是这次交互的通信 ✓）
const 人读出口 = (() => { try { return fs.openSync(process.env.ZMDJ_TEXT_LOG ?? '服务器.log', 'a'); } catch { return null; } })();
function 记人读日志(行: string): void {
  if (人读出口 === null) return;
  try { fs.writeSync(人读出口, 行 + '\n'); } catch {}
}
let 事件序号 = 0;
let 当前请求号 = 0;
let 应用中 = false;   // 正在处理「动作」请求 —— 那时用时由它自己 flush ✓，改房别抢 ✓
/** ── **唯一写入口** ─────────────────────────────────────────
 *  规矩：**只有这里写文件** ✓、**编号只在这里迭代** ✓ —— 调用方只说「发生了什么」✓，
 *  不许自己算编号 ✗、不许自己开文件 ✗。
 *  编号语义：一次通信 = 一段 ✓（收一条 → 新段 ✓；回一条 → 新段 ✓）；
 *  同一段里产生的行（耗时/对局/人读日志）**共用一个编号** ✓ —— 这样 .log 和数据能对上 ✓。
 */
let 当前段 = 0;
/** 开新的一段（= 一条新通信）✓ —— 只由「请求进来」「回信出去」这两处调用 ✓ */
function 新一段(): void { 当前段 = ++事件序号; }
function 写记录(事件: { 类: string; 人读?: string; [k: string]: unknown }): void {
  const { 人读, ...其余 } = 事件;
  const 号 = 当前段 || ++事件序号;              // ← **编号在这里迭代** ✓
  if (当前段 === 0) 当前段 = 号;
  if (数据出口 !== null) {
    try { fs.writeSync(数据出口, JSON.stringify({ 时间: new Date().toISOString(), 编号: 号, ...其余 }) + '\n'); } catch { /* 记不上不影响对局 */ }
  }
  if (人读 !== undefined && 人读出口 !== null) {
    const 用时 = 其余['用时'] ?? 其余['毫秒'];
    try { fs.writeSync(人读出口, String(号).padStart(6) + '  ' + String(用时 === undefined ? '-' : 用时 + 'ms').padStart(6) + '  ' + 人读 + '\n'); } catch {}
  }
}
const 慢阈值毫秒 = Number(process.env.ZMDJ_SLOW_MS ?? 120);
let 当前请求标签 = '';                       // 由请求入口设，日志里带着它 ✓
function 计时<T>(标签: string, fn: () => T): T {
  const t0 = Date.now();
  try { return fn(); }
  finally {
    const 耗 = Date.now() - t0;
    if (耗 >= 慢阈值毫秒) console.log('[慢] ' + 耗 + 'ms　' + 标签 + (当前请求标签 ? '　（' + 当前请求标签 + '）' : ''));
    写记录({ 类: '耗时', 段: 标签, 毫秒: 耗, 慢: 耗 >= 慢阈值毫秒 });   // ← 卡顿排查靠这条 ✓
  }
}

function 改房<T>(房: 房间, fn: () => T): T {
  try {
    const 结果 = 计时('改房', fn);   // 量这一改：推进/算候选/序列化全在里面 ✓
    // ⚠ 打**新增**的对局日志 —— 必须在 return **之前**！
    //   我上一版把它插在 finally **之后** ✗ → 不可达代码 ✓ → 一行都没打 ✓（你看到的「server.log 没信息」✓）。
    const 全 = 房.g && 房.g.log;
    if (全) {
      const 从 = 房.上次日志长 ?? 0;
      for (let k = 从; k < 全.length; k++) { const 一条 = 全[k] ?? ''; console.log(一条); 写记录({ 类: '对局', 行: 一条 }); (房.本次日志 ??= []).push(一条); }
      房.上次日志长 = 全.length;
    }
    // ★ **非动作**请求（入座/发牌/组牌…）产生的日志行，就在这儿带编号写出 ✓
    //   （动作请求由 应用() 自己算完用时再写 ✓ —— 那时 应用中 = true ✓ 这里让位 ✓）
    if (!应用中 && (房.本次日志 ?? []).length) {
      for (const 行 of 房.本次日志 ?? []) 写记录({ 类: '人读', 人读: 行 });
      房.本次日志 = [];
    }
    return 结果;
  } finally {
    推送(房);
  }
}

/** 推给所有**大厅订阅**：房间列表变了（有人建房 / 有人入座 / 有人走）*/
function 推送大厅(): void {
  if (!推送表.size) return;
  const 表 = JSON.stringify(房间列表视图());
  for (const cc of [...推送表]) {
    if (cc.房 !== null) continue;              // 只发给大厅订阅
    try { cc.res.write('data: ' + 表 + '\n\n'); } catch { 推送表.delete(cc); }
  }
}
/** 房间列表（和 GET /api/房间 同一份，别写两遍）*/
function 房间列表视图() {
  return { 大厅: true, 房间: [...房间表.values()].filter((x) => !x.热座).map((x) => ({
    // ⚠ x.g 在建房和「发牌并开局」之间是 null —— 这里必须容错，否则建房就崩
    号: x.号, 入座: 入座视图(x), 人齐: 人齐了(x),
    回合: x.g ? x.g.turn : 0, 已开局: !!x.it,
  })) };
}

/**
 * **推进一步**：把玩家（或 AI）这个动作喂给开局/回合生成器，直到它再次要决定。
 * 推完必须广播新状态 —— 具体为什么放在 `finally` 里，见函数内的说明。
 */
function 推进(房: 房间, 动作: Action | null): void {
  // ⚠ **推送必须走 finally** —— 这个函数有三条出口（开局未完成 / 有意义就停 / 跑到 done），
  //   只在最后一条推的话，**最常见的「停下等玩家决定」那条永远不推**，
  //   对面就只能等轮询（体感：操作完半天没反应）。
  改房(房, () => 计时('推进', () => 推进内(房, 动作)));
}
/**
 * 生成器的驱动循环：一直 `next(动作)` 到它**要一个新决定**（或跑完）为止。
 * `守卫` 是防跑飞的护栏 —— 生成器只要有一处忘了 yield，这里就会空转到上限。
 * ⚠ 开局和回合**共用这一个生成器**（见 `开局流程G`），所以不存在「开局期间不推进」这种特殊状态。
 */

function 推进内(房: 房间, 动作: Action | null): void {
  // ⚠ 开局现在也在这条生成器里跑（见 开局流程G）—— **不再有「开局期间不推进」这条**。
  //   以前那样写的话，开局和回合是两套系统，「该谁动」也就有两份表示。
  let r = 房.it.next(动作);
  let 守卫 = 0;
  while (!r.done && 守卫++ < 20000) {
    const req = r.value;
    // 「自动让过，但轮到他做决定时停下」：没有有意义的动作就直接让过

    const 有意义 = !!req.决定   // 弃牌也行：那是要玩家做的选择
      || 列出合法动作(房.g, req.玩家, req.时机).some((a) => a.种类 !== '让过')
      // 进攻玩家在自己的行动阶段即使无事可做也停下来，
      // 让他自己点「让过」来结束这个阶段 —— 否则阶段会悄无声息地溜走，太突兀
      // 只有「堆叠为空」时才需要停下来问：那时候让过会结束本阶段。
      // 堆叠非空时继续让过会走向结算（117.4），不该把人拦住。
      || (req.玩家 === 房.g.active && req.步骤 === '行动阶段' && 房.g.stack.length === 0);
    if (有意义) { 房.当前 = req; return; }
    // 自动让过：双方都没什么可做的，引擎直接替他们让过 —— 记一条日志，让流程看得见
    记录(房.g, 房.g.players[req.玩家]!.name + ' 让过优先权（' + (req.步骤 || '—') + '，自动）');
    r = 房.it.next(null);
  }
  房.当前 = r.done ? null : r.value;
}



/** 两位玩家都到齐才能开局 */
/** 每一方是否由 AI 代理（热座测试用；两边都不开就纯手操） */

/**
 * 真的把牌发下去、开始 103 的开局流程。
 * ⚠ **联机时要等双方都「准备」**才调它（见 都准备好了()）。
 */
function 发牌并开局(房: 房间, seed: number): void {
  v = seed >>> 0;
  房.g = 新对局([房.甲, 房.乙], rnd, { 自动开局: false });
  // 103.1：**联机由服务端随机定先后手**（规则说「双方同意的方式」，联机里就是扔硬币）；
  //   热座要人来点，所以留着让 开局流程G yield 出去。两边都在生成器里。
  if (!房.热座 && 房.g.开局 && 房.g.players.every((x) => x.hand.length === 0)) 决定先手(房.g, rnd() < 0.5 ? 0 : 1);
  房.it = 整局G(房.g);
  房.当前 = null;
  推进(房, null);        // ★ 让生成器跑到第一个开局请求（或第一个回合请求）
}

/**
 * **一个物件给客户端的视图**。要点三条：
 *   · 特征一律用 `有效特征`（算完 613 全部层的），不读印制值；
 *   · **暗置的牌不下发牌面**（图 = null），对手不该看到它是什么；
 *   · 只有**看得见**的牌才带名字/类别这些信息 —— 手牌、牌库顶都靠调用方筛。
 */
/**
 * 一张牌的对局视图。
 * ⚠ `能看暗置`：**「可以看自己操控的暗置牌是什么」** ✓ —— 用户的口径是
 *   「**暗置牌还是那张牌** ✓，只是没权限的人看不到」✗→✓：
 *   所以这里**不搞第二份"真身"** ✗，而是像手牌/牌库那样 —— **有权限的人直接收到真牌面** ✓
 *   （名称/图/文字 ✓），没权限的人收到隐藏版 ✓（名称=暗置领土、无图、无规则叙述 ✓）。
 *   ⚠ 规则态字段（类别/武力/是单位…）**两种人都按 709.2 算** ✓（暗置实体就是"暗置领土" ✓）；
 *     客户端靠 `面:'暗置'` 决定**棋盘上画卡背** ✓、**悬停/点击的详情里显示真牌面** ✓。
 */
function 卡(房: 房间, o: Obj, 牌面可见 = false) {
  // 613：卡面展示的必须是「层系统算完之后」的特征，不能直接读印制值
  const f = 有效特征(房.g, o);
  const 暗 = o.面 === '暗置';
  const 露 = 暗 && 牌面可见;                       // 有权限：把这张牌的真牌面发出去 ✓
  return {
    uid: o.uid,
    名称: f.名称,   // 709.2a：暗置 = 「暗置领土」✓（f = 有效特征；谁都不该看到原牌名 ✗）
    类别: f.类别, 副类别: f.副类别, 超类别: f.超类别,
    武力: 是类别(房.g, o, '单位') ? f.武力 : null,
    体力上限: 是类别(房.g, o, '单位') ? f.体力上限 : null,
    // 印制值：卡面上印的数字。客户端拿它跟有效值相减，显示成「1+1/2+1」
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

/**
 * **可见性：全工程唯一的一处判断** ✓（效果优先 ∪ 规则默认 ✓）
 *
 * ⚠ 不能用 `switch(区域)` 一把决定 ✗ —— **效果可以给"某玩家能看某几张牌"**
 *   （检视对手牌库顶 / 看某人的手牌 / 展示…），这跟那张牌在**哪个区域**没关系 ✓，
 *   所以效果必须是**独立的一票** ✓；区域只是"**默认层**"的一个输入 ✓。
 * 判定顺序（以后要加"效果禁止"就插最前面 ✓）：**禁止 > 授予 > 默认** ✓。
 */
function 效果授予了(房: 房间, 座位: number, uid: number): boolean {
  return 房.g.可见登记.some((x) => x.玩家 === 座位 && x.uid === uid);
}
/** 规则默认：只回答"**没有效果时**，规则本身允许谁看" ✓ */
function 默认可见(房: 房间, o: Obj, 座位: number): boolean {
  if (o.面 === '暗置') return 有效控制器(房.g, o) === 座位;   // 「可以看自己操控的暗置牌是什么」✓（与区域无关 ✓）
  switch (区of(房, o)) {                                      // 区域只在这一层用得到 ✓
    case '手牌': return 有效控制器(房.g, o) === 座位;           // 私有区 ✓
    case '牌库': return false;                                 // 隐藏区：默认谁都看不到（含主人 ✓ 401.2）
    case undefined: return false;                              // 找不到它（已离场等）→ 不给 ✗（宁少勿多 ✓）
    default: return true;                                      // 战场/墓地/放逐区/堆叠… 公开 ✓
  }
}
/** 这张牌的牌面**对这个座位**可见吗？—— 所有下发牌面的地方都只问它 ✓
 *  （导出是给回归探针用 ✓ —— `_探可见.mjs` ✓；它只读 `房.g` ✓，喂个 `{g}` 就能量 ✓） */
export function 可见(房: 房间, o: Obj, 座位: number | null): boolean {
  if (座位 === null) return true;                    // 热座 / 上帝视角 ✓
  if (效果授予了(房, 座位, o.uid)) return true;       // ★ 效果说的算，与区域无关 ✓
  return 默认可见(房, o, 座位);
}
/**
 * ⚠ **需要"双方都确认"的步骤**（展示 ✓）：记哪个座位已经按过确认 ✓。
 *   用 WeakMap 而不是改 `房间` 接口 ✓（和 `上次推送` 一个路子 ✓）。
 *   · 联机：两台设备各按自己的 ✓（服务端按令牌得知是谁 ✓）；
 *   · 热座：**同一屏上两个按钮** ✓ —— 动作里带 `确认座位` 说明"替谁按的" ✓。
 */
const 双方确认 = new WeakMap<房间, number[]>();

/** 这个物件现在在哪个区域（只给"默认层"用 ✓） */
/**
 * ⚠ **物件在哪 / 物件是谁** —— **只有这一处**遍历区域 ✓（收口 ✓）：
 *   以前 `区of` 与 `找牌` 各写一遍 ✗（两处列表各漏各的 ✓ —— 暂存那次就是这么漏的 ✓）。
 *   含**堆叠**里的牌 ✓ 与**当前这一步的暂存位** ✓（`搜寻` 的去处 ✓，郭嘉/134 的牌在那儿 ✓）。
 */
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
  /**
   * ⚠ **暂存位**（`搜寻` / 检出来的牌先放这儿 ✓）—— 它是**每个堆叠物件各自**的字段（`item.暂存` ✓），
   *   所以要把**栈上每个物件**都找一遍 ✓ —— 只看 `房.it` 不够 ✗
   *   （挂起等玩家时，持有那张牌的未必是 `房.it` ✓）。
   *   2026-10 的两次报告（郭嘉 / 甄姬 展示的那张牌「查看」点开空白 ✓）都是这里找不到物件 ✓
   *   → 挂不上 `卡` ✓ → 而查看容器只画带 `卡` 的条目 ✓。
   */
  const 持有: (Obj[] | undefined)[] = 房.g.stack.map((s) => (s as unknown as { 暂存?: Obj[] }).暂存);
  持有.push((房.it as unknown as { 暂存?: Obj[] } | null)?.暂存);
  for (const 列 of 持有) {
    const 暂 = 列?.find((x) => x.uid === uid);
    if (暂) return { 区: '牌库', 物件: 暂 };      // ← 报它来的区域 ✓（暂存不是"区域" ✓ 不该自成一组 ✓）
  }
  return undefined;
}

/** 物件在哪个区域（界面按它分组 ✓） */
function 区of(房: 房间, o: Obj): '手牌' | '牌库' | '墓地' | '战场' | '放逐区' | '堆叠' | undefined {
  return 在哪(房, o.uid)?.区;
}

/** uid → 物件（找遍所有持有处 ✓） */
function 找牌(房: 房间, uid: number): Obj | undefined {
  return 在哪(房, uid)?.物件;
}

/**
 * ⚠ **给「看得见的牌」候选挂上牌面** ✓ —— 需求面板就能**直接画卡** ✓（而不是文字按钮 ✗）。
 *
 * 判据：候选**带了 `名`** = 服务端已经决定要展示它 ✓（观星 / 检视 / 搜寻找出来的牌都是这种 ✓）
 *   —— 名字既然发了，牌面就没有额外的信息泄露 ✗（图/文字本来就该跟名字一起给 ✓）。
 * 没名字的候选（背面 ✓）一律不动 ✓：面板照旧画「背面」✓。
 */
function 挂牌面(房: 房间, 需: 需求 | null, 座位: number | null): 需求 | null {
  if (!需) return null;
  for (const 槽 of 需.槽 ?? []) {
    for (const c of 槽.候选 ?? []) {
      if (typeof c.键 !== 'number' || !c.名) continue;
      const o = 找牌(房, c.键);
      if (o) (c as { 卡?: unknown }).卡 = 卡(房, o, 可见(房, o, 座位));
    }
  }
  /**
   * ⚠ **`查看` 里的牌一律直接挂牌面** ✓（用户口径 ✓）——
   *   它**本来就是"服务器要这个玩家看的牌"** ✓（引擎/收发层刚挑出来的 ✓），
   *   所以**不用再判"谁能看"** ✗：那套 `可见()` 是给**棋盘/区域**上那些牌用的 ✓
   *   （那里才需要问"这张暗置 / 隐藏区的牌该不该给他看" ✓）。
   * ⚠ 之前这里漏了整段 ✗ → `查看` 里只有 键/名/区、**没有 `卡`** ✓ →
   *   界面只收"带牌面"的条目 ✓ → 点开「查看」是一块**空白** ✗（2026-10 报的 ✓）。
   */
  for (const c of 需.查看 ?? []) {
    if (typeof (c as { 键?: unknown }).键 !== 'number') continue;
    const o = 找牌(房, (c as { 键: number }).键);
    if (o) (c as { 卡?: unknown }).卡 = 卡(房, o, true);      // ← 直接露牌面 ✓
  }
  return 需;
}

/**
 * **整个对局状态**，按座位裁剪。`座位 = null` 是上帝视角（热座）。
 * `看得见(i)` 决定这一份里包含哪些人的隐藏信息（手牌之类）——
 * ⚠ 这是**唯一**该做可见性判断的地方，别在别处再散一份。
 */
function 视图(房: 房间, 座位: number | null = null) {
  // ⚠ **暗置牌的「真身」只发给有效操控者** ✓（规则：「可以看自己操控的暗置牌是什么」）——
  //   判据只有这一处 ✓：漏一处是信息泄露 ✗，重复一处是规则不一致 ✗。
  // ⚠ 取牌一律问**唯一那处**可见性判断 ✓（暗置归操控者 ✓、效果授予 ✓、公开区 ✓ 全在里面 ✓）
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
    // 103 开局：**只放开局独有的数据** —— 「进行到哪一步」「轮到谁」都在 当前请求 里，
    //   「谁先手」在下面的 先手玩家。开局做完时这里是 null（不是「阶段: 完成」）。
    开局: 房.g.开局 ? {
      起手牌数: 房.g.开局.起手牌数,
      调度张数: 房.g.开局.调度张数,
      已宣告: 房.g.开局.已宣告, 已执行: 房.g.开局.已执行,
      // 401/402：隐藏区的牌只有**登记过的**玩家看得到 —— 可见性判断只在这一处。
      //   103.6 的「后手检视自己牌库顶」和 031 黑水祭天模式 1 都往 g.可见登记 里登记，
      //   所以这里一份就够，不需要每个检视效果各写一遍（漏一处就是信息泄露）。
    } : null,
    players: 房.g.players.map((p) => ({
      index: p.index, 名字: p.name, 体力: p.体力, 体力上限: p.lifeMax,
      支持: 势力支持度(房.g, p.index),
      // 401/402：手牌是私有区 —— **规则只写在 `可见()` 一处** ✓：
      //   对手那张表会自然过滤成空 ✓（以后有"看手牌"的效果也能直接放行 ✓，不用再改这里 ✓）
      手牌: p.hand.filter((c) => 可见(房, c, 座位)).map((c) => 卡v(c)),
      手牌张数: p.hand.length,
      隐藏手牌: !看得见(p.index) && p.hand.every((c) => !可见(房, c, 座位)),
      阵地: Object.fromEntries(阵地顺序.map((s) => [s, p.阵地[s] ? 卡v(p.阵地[s]!) : null])),
      // 战场是**共享区域** —— 分半场只是 UI：有阵地的按阵地分，
      //   没阵地的（阵略/领土/被 301.8 移出阵地的）按**操控者**归到它那一半
      阵地外: 房.g.战场.filter((o) => !o.阵地 && 有效控制器(房.g, o) === p.index).map((c) => 卡v(c)),
      // 404.2：墓地是公开区，随时可以检视
      墓地: p.graveyard.map((c) => 卡v(c)),
      墓地对数: p.graveyard.length,
      // 401 / 402：牌库是隐藏区，只给数量
      牌库张数: p.library.length,
      // 牌库**整摞**：牌库顶在前；能看的给正牌面（检视/观星 登记过的那几张），其余只给 uid（客户端画背面）
      牌库: [...p.library].reverse().map((c) => (可见(房, c, 座位) ? 卡v(c) : { uid: c.uid })),
      本回合已打领土: p.landsPlayedThisTurn,
    })),
    // 400：放逐区由所有玩家共享，明置且任何人都能检视（406.3）
    放逐区: 房.g.放逐区.map((c) => 卡v(c)),
    放逐张数: 房.g.放逐区.length,
    // 401/402：隐藏区的牌只有**登记过的**玩家看得到 —— 可见性判断只在这一处。
    //   103.6 的「后手检视自己牌库顶」和 031 黑水祭天模式 1 都往 g.可见登记 里登记，
    //   所以一份就够；每个检视效果各写一遍判断的话，漏一处就是信息泄露。
    可见登记: (() => {
      const out: ReturnType<typeof 卡>[] = [];
      for (const x of 房.g.可见登记) {
        if (!看得见(x.玩家)) continue;                  // 联机时只有登记的那个人拿得到
        const o = 房.g.players.flatMap((pl) => [...pl.library, ...pl.hand, ...pl.graveyard])
          .concat(房.g.战场).concat(房.g.放逐区).find((c) => c.uid === x.uid);
        if (o) out.push(卡v(o));
      }
      return out;
    })(),
    stack: 房.g.stack.map((s) => ({
      // ⚠ 客户端要 栈id：堆叠上的**能力**没有牌，只能按它指（114.9）——
      //   候选里的 uid 就是 -栈id
      栈id: s.id,
      标签: s.标签, 操控者: s.操控者,
      // 卡面数据：堆叠上的牌也要能点（无懈可击要选它当目标）
      卡: s.card ? 卡v(s.card) : null,
      // 114.9：目标也可能是**堆叠上的能力**（没有牌，按 StackItem.id 指）
      目标: s.目标.map((t) => typeof t === 'number' ? 房.g.players[t]!.name
        : ('堆叠项' in t ? (房.g.stack.find((x) => x.id === t.堆叠项)?.标签 ?? '（已不在堆叠）') : t.def.全名)),
    })),
    当前请求: 房.当前 ? {
      玩家: 房.当前.玩家, 步骤: 房.当前.步骤, 时机: 房.当前.时机,
      决定: !房.当前.决定 ? null : 房.当前.决定.类型 === '搜寻'
        // 701.17a：要让玩家「检视该区域的所有牌」再挑 —— 所以候选要带完整卡面
        ? { ...房.当前.决定, 候选: 房.当前.决定.候选.map((c) => {
            const o = 房.g.players.flatMap((x) => [...x.library, ...x.hand, ...x.graveyard]).concat(房.g.战场)
              .concat(房.g.放逐区).find((x) => x.uid === c.uid);
            return { ...c, 卡: o ? 卡v(o) : null };
          }) }
        : 房.当前.决定,
    } : null,
    // ⚠ **收发层的「选择需求」** ✓（契约 ✓）：引擎只算规则 ✓，「玩家现在要选什么」在这里打包 ✓。
    //   客户端的选择系统**直接读它** ✓（客户端的翻译层 C 已删 ✓）。
    //   ⚠ 要带 `房.g` 与座位 ✓ —— 「弃牌」这种决定的候选在引擎手里（手牌）✓，
    //     收发层不拿状态就发不出候选 ✗（以前客户端自己补 ✓）。
    // ⚠ **需求里的"查看内容"按座位裁剪** ✗→✓（用户口径 ✓）：
    //   要看的牌**只发给该看的人** ✓ —— 热座（座位 null ✓）都发 ✓；
    //   需要双方确认的步骤（展示 ✓）两边都发 ✓；其余**只发给这一步的玩家** ✓。
    //   ⚠ 以前整份需求发给所有座位 ✗ → 先手手里也有后手该看的牌 ✓
    //     （然后靠界面"轮不到你就不画"来藏 ✗ —— 那不成立 ✓；2026-10 报的"先手也能看到开局检视" ✓ 就是这个 ✓）。
    决定需求: (() => {
      if (!(房.当前 && 房.当前.决定)) return null;
      const 需 = 挂牌面(房, 需求_决定(房.当前.决定 as unknown as Record<string, unknown>, 房.g, 房.当前.玩家), 座位);
      if (!需) return null;
      const 双方 = (房.当前.决定 as { 等双方确认?: boolean }).等双方确认 === true;
      const 该看 = 座位 === null || 双方 || 座位 === 房.当前.玩家;
      return 该看 ? 需 : { ...需, 查看: undefined };      // ← 不给他看就不下发 ✓（JSON 会把 undefined 丢掉 ✓）
    })(),
    /**
     * ⚠ **谁该动，由服务端说** ✗→✓（用户口径 ✓）—— 客户端不再自己推断"轮不轮到我" ✗
     *   （那条推断以前还得分"展示要双方都动" ✓，就是补丁的来源之一 ✗）。
     */
    可操作: (() => {
      if (座位 === null) return true;                                      // 热座 / 上帝视角 ✓
      if (!房.当前) return false;
      const 双方 = (房.当前.决定 as { 等双方确认?: boolean } | undefined)?.等双方确认 === true;
      if (双方) return !(双方确认.get(房) ?? []).includes(座位);            // 展示：还没确认的那一方就能动 ✓
      return 房.当前.玩家 === 座位;                                        // 其余：只有这一步的玩家 ✓
    })(),
    合法动作: 房.当前 && !房.当前.决定
      ? 合并同族动作(列出合法动作(房.g, 房.当前.玩家, 房.当前.时机)).map((a) => ({
          ...a,
          // ⚠ 把 `可支付来源()` 的**原对象**交下去 ✓（带 `提供`）—— 收发层要靠它给「支付源」的候选配 `量` ✓
          //   （只给 uid 的话，「要付 2 点」就退化成「要挑 2 张地」✗）。
          需求: 挂牌面(房, 需求_动作(a as unknown as Record<string, unknown>, 房.当前!.玩家,
            可支付来源(房.g, 房.当前!.玩家) || [], 房.g), 座位),
        }))
      : [],
    // 118.2 / 304.8：支付数字费用时要让玩家自己挑启动哪几个费用能力（挑地）
    可支付来源: 房.g.players.map((_, i) => 可支付来源(房.g, i)),
    /**
     * ⚠ **需要双方确认的步骤**（展示 ✓）：报"谁已经确认了" ✓ ——
     *   联机时两边各看各的 ✓；热座时一屏上两个按钮（按过的标 ✓）✓；
     *   两个座位都齐了，服务端才把这次确认交给引擎 ✓（见 `应用` 里的闸门 ✓）。
     */
    双方确认: (() => {
      const d = 房.当前 && 房.当前.决定 as { 等双方确认?: boolean } | undefined;
      if (!d || d.等双方确认 !== true) return null;
      return { 需要: [0, 1], 已: [...(双方确认.get(房) ?? [])] };
    })(),
    log: 房.g.log.slice(-100),
    /**
     * ⚠ **日志的绝对行数** ✓ —— 客户端靠它算"这一窗的第一行是第几行" ✓。
     *   只给 `log`（末尾 100 行）是不够的 ✗：窗口满了以后长度**恒为 100** ✓，
     *   客户端拿"长度变没变"当"有没有新行"就会永远判成"没有" ✗
     *   （2026-10 报的："放完单位没有 log，做别的动作才一起冒出来" ✓ 就是这个 ✓）。
     */
    log总数: 房.g.log.length,
  };
}

// 线格式动作 → 引擎 Action 的解析在 engine/解析动作.ts（那里能单元测试 ——
//   ⚠ 不能放在这个文件里：server.ts 一被 import 就开 HTTP 服务器，导入即启动）。
function 应用(房: 房间, 体: 线动作, 座位: number | null = null): { ok: boolean; 错误?: string } {
  if (!房.当前) return { ok: false, 错误: '现在不需要任何人做决定' };
  const p = 房.当前.玩家;
  // 联机时只能替自己的座位动作；热座（座位 null）不限制
  /**
   * ⚠ **"轮不到你"这里的例外：展示这类"要双方确认"的步骤** ✗→✓
   *   展示的请求是发给**发起人**（甲）的 ✓，但它要**双方各自确认** ✓ ——
   *   乙一来就被这句挡掉 ✓ → 返回的正是「**现在轮到 甲 做决定，不是你**」✓
   *   = 用户报的"点确认后提示甲在做决定、无法确认" ✓（2026-10 ✓）。
   */
  const 展示中 = !!(房.当前
    && (房.当前.决定 as { 等双方确认?: boolean } | undefined)?.等双方确认 === true);
  if (座位 !== null && p !== 座位 && !展示中) {
    return { ok: false, 错误: '现在轮到 ' + 房.g.players[p]!.name + ' 做决定，不是你' };
  }
  新一段();   // ← 收这一条通信 = 新的一段 ✓
    const 之前应用中 = 应用中; 应用中 = true;
  写记录({ 类: '收', 房间: 房.号 ?? '', 座位, 轮到: p, 体 });
  const 起 = Date.now();
  const r = 解析动作(房.g, p, 体);
  if (!r.ok) { 写记录({ 类: '收-拒绝', 错误: r.错误, 人读: '✗ ' + (r.错误 ?? '') }); 应用中 = 之前应用中; return { ok: false, 错误: r.错误 }; }
  // ⚠ **展示这类步骤：双方都确认了才继续** ✓（同一套机制覆盖联机与热座 ✓）
  //   联机：各自按自己的确认 ✓（谁按的由令牌决定 ✓）；
  //   热座：一屏两个按钮 ✓（动作里带 `确认座位` ✓ 说明替哪个座位按的 ✓）。
  //   还差一个人时**不推进引擎** ✗，只推送一次界面 ✓（让对方看到"已确认/待确认" ✓）。
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
  // ★ 把这一步产生的对局日志，按「编号 + 用时 + 原文」写进服务器.log ✓
  写记录({ 类: '本步', 毫秒: 用时, 动作: r.动作.种类, 日志数: (房.本次日志 ?? []).length });
  for (const 行 of (房.本次日志 ?? [])) 写记录({ 类: '人读', 用时, 人读: 行 });
  if (!(房.本次日志 ?? []).length) 写记录({ 类: '人读', 用时, 人读: '（这一步没有产生日志行）' });
  房.本次日志 = [];
  应用中 = 之前应用中;
  return { ok: true };
}
/** 回一个 JSON。**唯一的出口** —— 不要别处 `res.writeHead` 再写 body，容易忘 charset */
const 上次响应摘要 = new Map<string, number>();
function 摘要(s: string): number { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
function 发JSON(res: http.ServerResponse, 数据: unknown, 码 = 200): void {
  const 体 = JSON.stringify(数据);
  // 记「发」：内容**变了**才记全文 ✓（轮询会重复发同一份状态 ✓ 全记会把文件刷爆 ✗）
  {
    const k = 当前请求号 + ':' + 码;
    const d = 摘要(体) ^ 体.length;
    const 变 = 上次响应摘要.get(k) !== d;
    if (变) 上次响应摘要.set(k, d);
    新一段();   // ← **发**这一条通信 = 新的一段 ✓
    写记录({ 类: '发', 码, 字节: 体.length, 摘要: d, 变化: 变, 数据: 变 ? 数据 : undefined });
  }
  res.writeHead(码, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(体);
}
/**
 * 收一个 JSON 请求体。**解析失败一律回调 `{}`，不抛** —— 客户端发坏数据不该把服务端打挂，
 * 让各接口自己去判字段缺不缺（缺了就当没发）。
 */
function 收JSON(req: http.IncomingMessage, 回调: (体: any) => void): void {
  let 原始 = '';
  req.on('data', (c) => { 原始 += c; });
  req.on('end', () => { try { 回调(原始 ? JSON.parse(原始) : {}); } catch { 回调({}); } });
}
/**
 * 发一个静态文件（卡图 / index.html）。有**目录穿越防护**：解析后的绝对路径必须落在工作目录内，
 * 否则 403 —— 不加这条，`/cards/../../../secret` 就能读到仓库外的东西。
 */
function 发文件(res: http.ServerResponse, 相对: string, 类型: string): void {
  const 根目录 = process.cwd();
  const 全 = path.resolve(根目录, 相对);
  // 防目录穿越：必须落在工作目录内
  if (!全.startsWith(根目录)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(全, (e, 数据) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('找不到 ' + 全); return; }
    res.writeHead(200, {
      'Content-Type': 类型,
      // ⚠ HTML 绝不能缓存：否则浏览器拿旧的 index.html 配新的服务端接口，
      //   表现就是「按钮点了没反应」（旧 JS 调已改名的接口）。卡图可以短缓存。
      'Cache-Control': 类型.startsWith('text/html') ? 'no-store, must-revalidate' : 'max-age=3600',
    });
    res.end(数据);
  });
}
/** 发 index.html。**每次请求都重读磁盘** —— 改前端只要刷页面，不用重启服务端 */
function 发页面(res: http.ServerResponse, 相对: string): void { 发文件(res, 相对, 'text/html; charset=utf-8'); }

/* ── 配置 ────────────────────────────────────────────────────
   服务器配置.json（可选）：
     { "端口": 8787, "监听": "全部" | "仅本机", "口令": "" }
   「全部」= 0.0.0.0，本机和局域网都能连（全本地模式用 127.0.0.1 一样连得上），
   所以这是能满足三种连接方式的默认值。环境变量 PORT / HOST 优先级更高。 */
interface 服务器配置 { 端口?: number; 监听?: '仅本机' | '全部'; 口令?: string }
const 配置: 服务器配置 = (() => {
  try { return JSON.parse(fs.readFileSync('服务器配置.json', 'utf8')) as 服务器配置; }
  catch { return {}; }
})();
const 端口 = Number(process.env.PORT ?? 配置.端口 ?? 8787);
const 主机 = process.env.HOST ?? (配置.监听 === '仅本机' ? '127.0.0.1' : '0.0.0.0');
const 口令 = process.env.口令 ?? 配置.口令 ?? '';

/** 这台机器上别人能用来连的地址（过滤掉虚拟网卡和链路本地地址） */
function 可用地址(): { 网卡: string; 地址: string }[] {
  const out = [{ 网卡: '本机', 地址: 'http://127.0.0.1:' + 端口 }];
  for (const [网卡, 列] of Object.entries(os.networkInterfaces())) {
    for (const a of 列 ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      if (a.address.startsWith('169.254.')) continue;                       // 链路本地
      if (/VMware|VirtualBox|Loopback|vEthernet|Hyper-V/i.test(网卡)) continue;  // 虚拟网卡
      out.push({ 网卡, 地址: 'http://' + a.address + ':' + 端口 });
    }
  }
  return out;
}


const 服务器 = http.createServer((req, res) => {
  // URL 可能是百分号编码的（例如 /api/开局），先解码再路由
  const u = decodeURIComponent((req.url ?? '/').split('?')[0] ?? '/');
  // ★ **每一条进来的请求**先占一个通信编号 ✓（编号 = 通信条数 ✓ 顺序递增 ✓）
  //   入座 / 轮询 / 动作 都算 ✓ —— 这样「入座发牌」那些日志行也落在它自己的编号下 ✓
  新一段();                        // ← 每一条进来的请求 = 新的一段 ✓
  写记录({ 类: '收', 路由: u });
  if (req.method === 'GET' && (u === '/' || u === '/index.html')) return 发页面(res, 'web/index.html');
  if (req.method === 'GET' && u.startsWith('/cards/')) {
    // ⚠ 忽略查询串 —— 卡图 URL 可能带 ?v=2 这类缓存版本号（用来绕开浏览器缓存）
    const 路径 = u.split('?')[0]!;
    // `/cards/<系列>/<系列>-<编号>.jpg`；卡背是 `/cards/背面.jpg`（不分系列，放顶层）
    // ⚠ 允许**一层**子目录（系列），每段都挡路径穿越
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
  // ── SSE：服务端主动推（客户端不用再 1.2 秒轮询）────────────────
  //   端1 动作 → 服务端 → ① 返回给端1 → ② **主动推给端2**（就是这条）
  if (req.method === 'GET' && u === '/api/events') {
    const 令牌 = new URL(req.url ?? '/', 'http://x').searchParams.get('令牌');
    const 座 = 找座位(令牌);
    // ⚠ **没入座也能连** —— 那是「大厅订阅」，只用来收房间列表。
    //   不这样的话，别人建了新房间你得等轮询（现在放宽到 8 秒）才看得到。
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':ok\n\n');
    const 记 = 座 ? { res, 房: 座.房, 座位: 视图座位(座), 令牌 } : { res, 房: null, 座位: null, 令牌: null };
    推送表.add(记);
    const 心跳 = setInterval(() => { try { res.write(':ping\n\n'); } catch { /* 断了 */ } }, 20000);
    req.on('close', () => { clearInterval(心跳); 推送表.delete(记); });
    if (座) 推送(座.房);              // 连上就先给一次当前状态
    else { try { res.write('data: ' + JSON.stringify(房间列表视图()) + '\n\n'); } catch { /* 断 */ } }
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
    // 单人热座：建一个私人房间，一个人控制两边、看全部信息
    if (体.热座) {
      // ⚠ **建房那一刻就标热座** ✓ —— 否则建房里的那次 `推送大厅()` 会把这间房广播出去 ✓
      //   （表现：房间列表里出现一会儿再消失 ✗ 2026-10 报的 ✓）。
      const 房 = 取房间(undefined, { 热座: true });
      发牌并开局(房, 20250101);              // 热座一个人，建完房就当他准备好了
      const 名 = String(体.名字 ?? '').trim().slice(0, 12) || '调试者';
      const 新: 座位 = { 令牌: 'TK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(), 名字: 名, 最后见到: Date.now() };
      令牌表.set(新.令牌, { 房, 座位: -1 });          // -1 = 上帝视角
      房.入座[0] = 新;
      记录(房.g, 名 + ' 进入热座调试（房间 ' + 房.号 + '）');
      return 发JSON(res, { ok: true, 令牌: 新.令牌, 房间: 房.号, 座位: -1, 热座: true, 入座: 入座视图(房) });
    }
    // 已持有令牌 → 直接回原座位
    const 旧座 = 找座位(体.令牌);
    if (旧座) return 发JSON(res, { ok: true, 令牌: 体.令牌, 房间: 旧座.房.号, 座位: 旧座.座位, 入座: 入座视图(旧座.房) });
    if (口令 && String(体.口令 ?? '') !== 口令) {
      return 发JSON(res, { ok: false, 错误: '口令不对', 需要口令: true }, 403);
    }
    const 房 = 取房间(typeof 体.房间 === 'string' ? 体.房间 : undefined);
    if (房.废弃) return 发JSON(res, { ok: false, 错误: '这一局已经结束（有玩家在对局中离开），请新建房间' }, 400);
    if (!房.it) 房.it = 整局G(房.g);        // 生成器在「双方准备」时才启动（发牌并开局 会建）
    const 空 = 房.入座.findIndex((s) => s === null);
    if (空 < 0) return 发JSON(res, { ok: false, 错误: '座位已满（本局最多两人）' }, 400);
    const 名字 = String(体.名字 ?? '').trim().slice(0, 12) || ('玩家' + (空 + 1));
    const 新: 座位 = { 令牌: 'TK' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase(), 名字, 最后见到: Date.now() };
    房.入座[空] = 新;
    令牌表.set(新.令牌, { 房, 座位: 空 });
    推送大厅();      // 有人入座 → 房间列表里的「谁在座」变了
    改房(房, () => { });        // 房间里的人立刻看到「对方进来了」（不用等轮询）
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
      // 对局中离座 → 这局作废。**绝不能让别人接手**：否则新人会继承前一个人的手牌和场面
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
  if (req.method === 'POST' && u === '/api/decks') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌); const 房 = 座 ? 座.房 : null;
    if (!房) return 发JSON(res, { ok: false, 错误: '还没入座（没有令牌或令牌已失效）—— 先在大厅点「组牌／换牌」或「单人热座」' }, 400);
    // **一次只保存一组**：{ 侧: '甲' | '乙', 牌: [卡号] }
    //   —— 组牌界面现在只显示一组，保存 = 保存**当前编辑的那一组**。
    const 侧 = 体.侧 === '甲' || 体.侧 === '乙' ? (体.侧 as '甲' | '乙') : null;
    if (!侧) return 发JSON(res, { ok: false, 错误: '没说要保存哪一组（侧 必须是 甲 或 乙）' }, 400);
    // ⚠ **权限必须显式判**：旧接口是靠「忽略对方那一侧」保安全的，
    //   换成单侧接口后如果只写不判，联机时就能覆盖对手的牌组。
    const 可改 = 座 && 座.座位 < 0 ? ['甲', '乙'] : 座 && 座.座位 === 0 ? ['甲'] : ['乙'];
    if (!座 || !可改.includes(侧)) return 发JSON(res, { ok: false, 错误: '你只能改自己那一组' }, 403);
    const 牌 = Array.isArray(体.牌) ? (体.牌 as string[]) : [];
    if (typeof 体.无限制 === 'boolean') 房.无限制组牌 = 体.无限制;
    const 校 = 校验牌组(牌, 房.无限制组牌);
    if (校.错误.length) return 发JSON(res, { ok: false, 错误: 校.错误, 校验: 校, 池: 池视图(房) }, 400);
        // 牌组**只存到房间上**，不重开当前对局 —— 下一次「新开一局」才应用
    const 新牌 = 牌.map((id) => 卡池索引.get(id)).filter((x): x is CardDef => !!x);
    if (侧 === '甲') 房.甲 = 新牌; else 房.乙 = 新牌;
    房.最后活动 = Date.now();
    记录(房.g, 侧 + '组已更新（' + 房.甲.length + ' / ' + 房.乙.length + ' 张）—— 点「新开一局」生效');
    改房(房, () => { });      // 牌组存到房间了 —— 对面的状态也该刷新
    发JSON(res, { ok: true, 侧, 校验: 校, 状态: 视图(房, 视图座位(座)), 池: 池视图(房) });
  });
  if (req.method === 'POST' && u === '/api/new') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌); const 房 = 座 ? 座.房 : null;
    if (!房) return 发JSON(res, { ok: false, 错误: '还没入座（没有令牌或令牌已失效）' }, 400);
    // ★ 测试阶段：**新局就覆盖对局信息** ✓（编号从 1 重新开始 ✓；服务器.log 里会有「新局」分隔行 ✓）
    对局信息重开(房.号 ?? '');
    发牌并开局(房, Number(体.seed ?? (Date.now() % 100000)));
    房.准备 = [!!房.热座, !!房.热座];      // 联机重开要重新准备
    发JSON(res, 视图(房, 视图座位(座))); });
  // 「准备」：联机开局前的一步。两边都点了才发牌、才走 103 流程。
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
      // **联机：随机决定先后手**（103.1 的「双方同意的方式」在联机里就是随机，
      //   不给界面选 —— 选先后手只在单人/热座里用）
      //   103.1 说先后手由「双方同意的方式」定 —— 联机里就是**随机**（扔硬币/骰子）
      if (房.g.开局 && 房.g.players.every((x) => x.hand.length === 0)) 决定先手(房.g, Math.random() < 0.5 ? 0 : 1);
    }
    改房(房, () => { });      // ⚠ 这个端点不经过 推进，走统一入口（否则对面看不到你准备了）
    发JSON(res, { ok: true, 状态: 视图(房, 视图座位(座)) });
  });
  if (req.method === 'POST' && u === '/api/ai') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌); const 房 = 座 ? 座.房 : null;
    if (!房) return 发JSON(res, { ok: false, 错误: '还没入座（没有令牌或令牌已失效）' }, 400);
    if (体.动作 === '设置') {
      if (Array.isArray(体.代理)) {
        房.AI代理 = [!!体.代理[0], !!体.代理[1]];
      }
      改房(房, () => { });      // 托管开关变了，对面也该看到
      return 发JSON(res, { ok: true, 状态: 视图(房, 视图座位(座)) });
    }
    return 发JSON(res, { ok: true, 状态: 视图(房, 视图座位(座)) });
  });
  if (req.method === 'POST' && u === '/api/action') return 收JSON(req, (体) => {
    const 座 = 找座位(体.令牌);
    if (!座) return 发JSON(res, { ok: false, 错误: '还没入座（没有令牌或令牌已失效）' }, 400);
    const 房 = 座.房;
    // 开局不再单独挡 —— 它和回合共用 房.当前（生成器 yield 出来的请求）
    const r = 应用(房, 体, 视图座位(座));
    if (!r.ok) return 发JSON(res, { ok: false, 错误: r.错误, 状态: 视图(房, 视图座位(座)) }, 400);
    return 发JSON(res, { ok: true, 状态: 视图(房, 视图座位(座)) });
  });
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('not found');
});

/**
 * 房间回收（60 秒扫一轮）：
 *  1. 两个座位都空了（都点了离座）      → 立即删
 *  2. 有人在对局中离座（废弃）且无人     → 2 分钟后删
 *  3. 全员掉线                          → 最后活动超 10 分钟后删（留重连机会）
 *  4. 兜底：任何房间最后活动超 60 分钟   → 删
 * 注意按「最后活动」算，不是「创建时间」—— 否则刚建的房删不掉、正在打的房被误删。
 */
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
