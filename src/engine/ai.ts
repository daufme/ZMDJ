/**
 * **默认 AI（单人/联机托管用）** —— 只吃「视图 + 当前请求」这种人读数据，不碰引擎内部状态。
 *
 * 约定：
 *   · 永远走和客户端同一条路：从 `合法动作` / `决定需求` 里挑，拼出线动作交给 `应用()`；
 *   · 不做规则判断（合法性由服务端/引擎负责）；
 *   · 选不出来就返回 null（调用方当作"这一步 AI 不动"）。
 */

export interface AI候选 {
  键: number | string;
  /** 确认时原样带回的对象（没有就用 键） */
  发?: unknown;
  量?: number;
  名?: string;
}

export interface AI槽 {
  名: string;
  归?: string;
  需: { 最小: number; 最大: number };
  候选: AI候选[];
  呈现?: string;
}

export interface AI需求 {
  标题?: string;
  槽: AI槽[];
  /** 确认时按模板拼出线动作：`$槽名` = 该槽选中的键/发对象数组；`@字段` = 从动作上取 */
  确认后发?: Record<string, unknown>;
  /** 凑不齐时的放弃分支（701.17b「未搜寻到」等） */
  放弃后发?: Record<string, unknown>;
  放弃名?: string;
}

export interface AI动作 {
  种类: string;
  uid?: number;
  面?: '明置' | '暗置';
  到?: string;
  路径?: '转移' | '许可';
  能力索引?: number;
  模式号?: number;
  费用数?: number;
  是X?: boolean;
  需求?: AI需求 | null;
  标签?: string;
}

/** 动作优先级：先地、再牌、再启动/移动/战斗；让过最后 */
const 种类序: Record<string, number> = { 打领土: 0, 打出: 1, 启动能力: 2, 转移: 3, 发起战斗: 4, 让过: 99 };

/**
 * 从这一帧的合法动作里挑一个。
 * · 有地先打地（明置优先）；
 * · 否则挑费用最低的牌；
 * · 都没有才让过。
 */
export function AI挑动作(动作们: AI动作[] | undefined): AI动作 | null {
  const 列 = (动作们 ?? []).filter((a) => a && a.种类 !== '让过');
  if (!列.length) return (动作们 ?? []).find((a) => a.种类 === '让过') ?? null;
  列.sort((a, b) => {
    const ka = 种类序[a.种类] ?? 50, kb = 种类序[b.种类] ?? 50;
    if (ka !== kb) return ka - kb;
    if (a.种类 === '打领土') return (a.面 === '明置' ? 0 : 1) - (b.面 === '明置' ? 0 : 1);
    return (a.费用数 ?? 0) - (b.费用数 ?? 0);
  });
  return 列[0]!;
}

/**
 * 按需求填一份线动作：
 * · 每个槽取前 `需.最小` 个候选（`发 ?? 键`）；
 * · 填不齐就返回 `放弃后发`（没有则 null）。
 */
export function AI填需求(需求: AI需求 | null | undefined, 上下文: Record<string, unknown> = {}): Record<string, unknown> | null {
  if (!需求) return null;
  const 选择: Record<string, unknown[]> = {};
  const 阵地偏好 = ['中路', '左侧翼', '右侧翼', '左边路', '右边路'];
  for (const z of 需求.槽 ?? []) {
    const 要 = Math.max(0, z.需?.最小 ?? 0);
    let 候 = [...(z.候选 ?? [])];
    // 「打出单位」的阵地槽：**优先空阵地**，不要一律塞第一格（第一格可能已有单位，会替任掉它）
    if ((z.归 ?? z.名) === '阵地' || z.名 === '阵地') {
      候.sort((a, b) => {
        const 空A = String(a.名 ?? '').includes('空') ? 0 : 1;
        const 空B = String(b.名 ?? '').includes('空') ? 0 : 1;
        if (空A !== 空B) return 空A - 空B;
        const iA = 阵地偏好.indexOf(String(a.键)), iB = 阵地偏好.indexOf(String(b.键));
        return (iA < 0 ? 99 : iA) - (iB < 0 ? 99 : iB);
      });
    }
    if (候.length < 要) return (需求.放弃后发 as Record<string, unknown> | undefined) ?? null;
    选择[z.归 ?? z.名] = 候.slice(0, 要).map((c) => (c.发 !== undefined ? c.发 : c.键));
  }
  const 解 = (v: unknown): unknown => {
    if (typeof v === 'string' && v.startsWith('$')) return 选择[v.slice(1)] ?? [];
    if (typeof v === 'string' && v.startsWith('@')) return 上下文[v.slice(1)];
    if (Array.isArray(v)) return v.map(解);
    if (v && typeof v === 'object') {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) o[k] = 解(x);
      return o;
    }
    return v;
  };
  const 模板 = 需求.确认后发;
  if (!模板) return null;
  return 解(模板) as Record<string, unknown>;
}
