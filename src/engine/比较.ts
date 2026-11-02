import type { 筛选比较 } from './types.js';

export type 可比较值 = string | number | boolean;

/** 集合比较：单值视为单元素集合；是 = 有交，不是 = 无交。 */
export function 集合有交(有的: readonly 可比较值[], 值列: readonly 可比较值[]): boolean {
  if (值列.length === 0) return false;
  const 集 = new Set(有的);
  return 值列.some((v) => 集.has(v));
}

/**
 * 唯一的数组/单值比较器。
 * 左 = 实际值，右 = 期望值；两边单值都先当单元素集合。
 * `是` = 有交，`不是` = 无交；`包含/不含` 按字符串；数值比较只看右列第一个。
 */
export function 比较值(实际: unknown, 比较: 筛选比较 | undefined, 期望: unknown): boolean {
  const 左列 = (Array.isArray(实际) ? 实际 : [实际])
    .filter((x): x is 可比较值 => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
  const 右列 = (Array.isArray(期望) ? 期望 : [期望])
    .filter((x): x is 可比较值 => typeof x === 'string' || typeof x === 'number' || typeof x === 'boolean');
  switch (比较 ?? '是') {
    case '是': return 右列.length === 0 ? 左列.length > 0 : 集合有交(左列, 右列);
    case '不是': return !集合有交(左列, 右列);
    case '包含': return 右列.some((v) => 左列.some((x) => String(x).includes(String(v))));
    case '不含': return !右列.some((v) => 左列.some((x) => String(x).includes(String(v))));
    case '大于': return 左列.some((x) => typeof x === 'number' && typeof 右列[0] === 'number' && x > 右列[0]);
    case '小于': return 左列.some((x) => typeof x === 'number' && typeof 右列[0] === 'number' && x < 右列[0]);
    case '小于等于': return 左列.some((x) => typeof x === 'number' && typeof 右列[0] === 'number' && x <= 右列[0]);
    case '大于等于': return 左列.some((x) => typeof x === 'number' && typeof 右列[0] === 'number' && x >= 右列[0]);
    default: return false;
  }
}
