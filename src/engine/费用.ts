/**
 * **费用行为列表的读取工具**（602.1d）。
 *
 * 费用是 `费用行为[]`（见 types.ts）：一条行为一个 `操作`，顺序就是支付顺序。
 * 引擎各处只按 `操作` 取行为，不按下标、不猜位置 —— 以后往列表里插新行为不会挪动别的读取点。
 */
import type { 费用行为 } from './types.js';

/**
 * 取某一种费用行为。没有 = `undefined`（省略的费用 = 不用付）。
 * ⚠ 同一操作的多种参数用**一条行为**表达（例如弃牌带 筛选 / 宣告X）——
 *   所以「同类行为有多条」不是合法数据，取第一条即可。
 */
export function 取费用行为<K extends 费用行为['操作']>(
  费用: readonly 费用行为[] | undefined,
  操作: K,
): Extract<费用行为, { 操作: K }> | undefined {
  return 费用?.find((x): x is Extract<费用行为, { 操作: K }> => x.操作 === 操作);
}

/**
 * 108.4 / 108.3a 的数字费用：
 *   · `宣告X: true` → 下限 0，实际 X 由操控者另给（`宣告X`）；
 *   · 否则 = `点数.最小`（数据里固定费用的 最小/最大 同值）。
 */
export function 支付费用(费用: readonly 费用行为[] | undefined): { 宣告X: boolean; 点数: number } {
  const 支 = 取费用行为(费用, '支付');
  const p = 支?.点数;
  // 兼容期：数字 / Value（这里不解，按 0）/ 旧区间（取最小）
  const 点数 = typeof p === 'number' ? p : (p && typeof p === 'object' && '最小' in p ? (p as { 最小: number }).最小 : 0);
  return { 宣告X: 支?.宣告X === true, 点数 };
}

/**
 * **牌面打出费用 → 数字或 'X'** ✓（统一期的取数口）：`支付费用()` 只认费用行为列表，
 * 而牌面可能还是旧的 `数字` / `'X'` 写法 ✓。
 */
export function 牌面费用值(费用: number | 'X' | readonly 费用行为[] | undefined): number | 'X' {
  if (费用 === undefined) return 0;
  if (typeof 费用 === 'number' || 费用 === 'X') return 费用;
  // ★ 统一后的 费用行为[]：取 支付.点数 求值 ✓
  //   纯 'X' 仍原样返回 ✓（调用方要靠它判「要不要宣告 X」✓）
  //   {X+2} → 2 ✓（108.3g：带 X 的牌在堆叠以外，X 视同 0 ✓）；{X}{X} → 0 ✓
  const v = 取费用行为(费用, '支付')?.点数;
  if (v === 'X') return 'X';
  return 费用点数值(v, 0);
}
/**
 * **把「费用点数」求成数字** ✓（统一后点数可以是 数字 / 'X' / {乘以,系数} / 旧区间{最小,最大}）。
 *   108.3a：'X' = 宣告的 X；108.3i：同一物件所有 X 相等 → {X}{X} 写 { 乘以:'X', 系数:2 } 得到 2X ✓
 */
export function 费用点数值(点数: unknown, 宣告X?: number): number {
  if (typeof 点数 === 'number') return 点数;
  if (点数 === 'X') return 宣告X ?? 0;
  if (点数 && typeof 点数 === 'object') {
    const o = 点数 as Record<string, unknown>;
    if ('乘以' in o) return 费用点数值(o.乘以, 宣告X) * Number(o.系数 ?? 1);
    if ('加' in o) return 费用点数值(o.加, 宣告X) + Number(o.值 ?? 0);
    if ('最小' in o) return Number(o.最小 ?? 0);
  }
  return 0;
}
/**
 * **从「费用点数」推出可选量的形状** ✓：`{ 偏移, 步进 }`。
 *   `{乘以:'X',系数:k}` → 步进 k（只能付 k 的倍数 ✓）
 *   `{加:'X',值:a}`     → 偏移 a（至少 a ✓）
 *   `'X'`               → 步进 1、偏移 0（任意 X ✓）
 *   数字                 → 固定值（步进 1、偏移 = 该值 ✓）
 * ⚠ 目前只按**一层**拆（乘以 / 加 各自一层 ✓）；更复杂的以后再加操作词 ✓。
 */
export function 费用点数形状(点数: unknown): { 偏移: number; 步进: number } {
  if (typeof 点数 === 'number') return { 偏移: 点数, 步进: 1 };
  if (点数 && typeof 点数 === 'object') {
    const o = 点数 as Record<string, unknown>;
    if ('乘以' in o) return { 偏移: 0, 步进: Math.max(1, Number(o.系数 ?? 1)) };
    if ('加' in o) return { 偏移: Number(o.值 ?? 0), 步进: 1 };
  }
  return { 偏移: 0, 步进: 1 };
}