import type { GameState } from './engine/state.js';
import { 攻击税 } from './engine/engine.js';
import type { 阵地 } from './engine/types.js';
import type { 合法动作 } from './engine/options.js';

type 候选项 = { 键: number | string; 名?: string; 发?: unknown; 量?: number; 区?: string; 可选?: boolean };

type 槽 = {
  名: string;
  归: string;
  需: { 最小: number; 最大: number };
  候选: 候选项[];
  条件?: { 玩家: number };
  呈现?: '按钮';

  可查看?: boolean;
};
export interface 需求 {

  查看?: 候选项[];
  标题: string;
  槽: 槽[];
  确认后发: Record<string, unknown>;

  放弃后发?: Record<string, unknown>;

  放弃名?: string;
}

const 区of = (g: GameState | undefined, uid: number): string | undefined => {
  if (!g || !Array.isArray(g.战场)) return undefined;
  for (const p of g.players) {
    if ((p.hand ?? []).some((c) => c.uid === uid)) return '手牌';
    if ((p.graveyard ?? []).some((c) => c.uid === uid)) return '墓地';
    if ((p.library ?? []).some((c) => c.uid === uid)) return '牌库';
  }
  if (g.战场.some((c) => c.uid === uid)) return '战场';
  if ((g.放逐区 ?? []).some((c) => c.uid === uid)) return '放逐区';
  if ((g.stack ?? []).some((s) => s.card && s.card.uid === uid)) return '堆叠';
  return undefined;
};

const 键候选项 = (xs: unknown[] | undefined, g?: GameState): 候选项[] => (xs || []).map((x) => {
  if (typeof x === 'number' || typeof x === 'string') {
    return typeof x === 'number' ? { 键: x, ...(区of(g, x) ? { 区: 区of(g, x)! } : {}) } : { 键: x };
  }
  const o = x as Record<string, unknown>;
  const 名 = typeof o.名称 === 'string' ? o.名称 : undefined;

  const 源区 = typeof o.区 === 'string' ? o.区 : undefined;

  const 源卡 = o.卡 as unknown;
  const 带名 = (c: 候选项): 候选项 => (名 ? { ...c, 名 } : c);
  const 带区 = (键: number | string): 候选项 => {
    const k = typeof 键 === 'number' ? 键 : (typeof o.uid === 'number' ? o.uid : undefined);
    const 区 = 源区 ?? (k !== undefined ? 区of(g, k) : undefined);
    return { 键, ...(区 ? { 区 } : {}), ...(源卡 !== undefined ? { 卡: 源卡 } : {}), ...(typeof o.可选 === 'boolean' ? { 可选: o.可选 } : {}) };
  };
  if (typeof o.uid === 'number') return 带名(带区(o.uid));
  if (typeof o.玩家 === 'number') return 带名({ 键: '玩家' + o.玩家 });
  if (typeof o.键 === 'string' || typeof o.键 === 'number') return 带名(带区(o.键 as number | string));
  if (typeof o.阵地 === 'string') return 带名({ 键: o.阵地 });
  if (名) return { 键: 名, 名 };
  return { 键: String(o.键 ?? '') };
});

const 目标候选项 = (xs: unknown[] | undefined, 目标名: string, g?: GameState): 候选项[] =>
  (xs || []).map((x) => {
    const c = (x || {}) as { 类型?: string; uid?: number; 玩家?: number; 名称?: string };
    const 名 = typeof c.名称 === 'string' ? c.名称 : undefined;
    if (c.类型 === '玩家' && typeof c.玩家 === 'number') {
      return { 键: '玩家' + c.玩家, ...(名 ? { 名 } : {}), 发: { 目标名, 类型: '玩家', 玩家: c.玩家 } };
    }
    if (typeof c.uid === 'number') {
      const 区 = 区of(g, c.uid);
      return { 键: c.uid, ...(名 ? { 名 } : {}), ...(区 ? { 区 } : {}), 发: { 目标名, 类型: c.类型 ?? '实体', uid: c.uid } };
    }
    return { 键: String(名 ?? ''), ...(名 ? { 名 } : {}), 发: { 目标名, 类型: c.类型, 名称: c.名称 } };
  });

const 支付候选项 = (xs: unknown[] | undefined): 候选项[] => (xs || []).map((x) => {
  const o = (x && typeof x === 'object') ? x as { uid?: number; 提供?: number } : undefined;
  if (o && typeof o.uid === 'number') {
    return { 键: o.uid, ...(typeof o.提供 === 'number' && o.提供 !== 1 ? { 量: o.提供 } : {}) };
  }
  return { 键: x as number | string };
});

const 座位候选项 = (xs: number[] | undefined, g?: GameState): 候选项[] =>
  (xs || []).map((i) => ({ 键: i, 发: i, 名: (g?.players[i]?.name ?? String(i)) + ' 先手' }));

const 张数候选项 = (xs: number[] | undefined): 候选项[] =>
  (xs || []).map((k) => ({ 键: k, 发: k, 名: k === 0 ? '不调度' : k + ' 张' }));

const 名额 = (v: unknown, 缺省: number): { 最小: number; 最大: number } => {
  if (typeof v === 'number') return { 最小: v, 最大: v };
  const o = v as { 最小?: number; 最大?: number } | undefined;
  if (o && typeof o.最小 === 'number' && typeof o.最大 === 'number') return { 最小: o.最小, 最大: o.最大 };
  return { 最小: 缺省, 最大: 缺省 };
};

const 规格槽s = (规格: unknown, 条件: { 玩家: number }, g?: GameState): 槽[] =>
  ((规格 as { 目标名: string; 数量?: unknown; 候选?: unknown[] }[] | undefined) || []).map((sp) => ({
    名: sp.目标名,
    归: '目标',
    需: 名额(sp.数量, 1),
    候选: 目标候选项(sp.候选, sp.目标名, g),
    条件,
  }));

export function 需求_决定(d: Record<string, unknown>, g?: GameState, 座位 = 0): 需求 | null {
  const 类型 = String(d.类型 || '');
  const 标题 = String(d.标签 || '');
  const 谁 = typeof d.玩家 === 'number' ? d.玩家 : 座位;
  const 条件 = { 玩家: 谁 };

  if (类型 === '决定先手') {
    return { 标题,
      槽: [{ 名: '先手', 归: '先手', 需: { 最小: 1, 最大: 1 }, 呈现: '按钮',
        候选: 座位候选项(d.候选座位 as number[] | undefined, g) }],
      确认后发: { 种类: '决定', 接受: true, 先手: '$先手' },

      放弃后发: { 种类: '决定', 接受: true }, 放弃名: '随机' };
  }

  if (类型 === '调度宣告') {
    return { 标题,
      槽: [{ 名: '张数', 归: '张数', 需: { 最小: 1, 最大: 1 }, 呈现: '按钮',
        候选: 张数候选项(d.候选张数 as number[] | undefined) }],
      确认后发: { 种类: '决定', 接受: true, 张数: '$张数' } };
  }

  if (类型 === '调度执行') {
    const n = (d.张数 as number) || 0;
    const 手 = (d.手牌 as { uid: number; 名称?: string }[] | undefined) || [];
    return { 标题: 标题 || '调度：从手牌里挑 ' + n + ' 张放回牌库',
      槽: [{ 名: '选牌', 归: '选', 需: { 最小: n, 最大: n },
        候选: 手.map((c) => ({ 键: c.uid, ...(c.名称 ? { 名: c.名称 } : {}) })) }],
      确认后发: { 种类: '决定', 接受: true, 选: '$选' } };
  }

  if (类型 === '看牌库顶') {
    return { 标题: 标题 || '牌库顶牌：留在牌库顶，还是置于牌库底？',
      槽: [{ 名: '去向', 归: '接受', 需: { 最小: 1, 最大: 1 }, 呈现: '按钮',
        候选: [{ 键: '留在牌库顶', 名: '留在牌库顶', 发: true },
                { 键: '置于牌库底', 名: '置于牌库底', 发: false }] }],
      确认后发: { 种类: '决定', 接受: '$接受' } };
  }

  if (类型 === '可选触发') {
    return { 标题,
      槽: [{ 名: '是否发动', 归: '接受', 需: { 最小: 1, 最大: 1 }, 呈现: '按钮',
        候选: [{ 键: '发动', 名: '发动', 发: true }, { 键: '不发动', 名: '不发动', 发: false }] }],
      确认后发: { 种类: '决定', 接受: '$接受' } };
  }

  if (类型 === '弃牌') {
    const n = (d.需弃 as number) || 0;
    const 手 = g ? (g.players[谁]?.hand ?? []) : [];
    return { 标题: 标题 || '弃 ' + n + ' 张牌',
      槽: [{ 名: '弃牌', 归: '弃牌', 需: { 最小: n, 最大: n },
        候选: 手.map((c) => ({ 键: c.uid, 名: c.def?.全名 ?? String(c.uid) })) }],
      确认后发: { 种类: '决定', 接受: true, 弃牌: '$弃牌' } };
  }

  if (类型 === '搜寻') {
    const n = typeof d.数量 === 'number' ? d.数量 : 1;
    const 候选 = (d.候选 as { uid: number; 名称?: string; 可选?: boolean; 区?: string; 卡?: unknown }[] | undefined) || [];
    const 可放弃 = d.可放弃 === true;

    const 候选2 = 键候选项(候选, g);
    const 看 = 查看内容(d, 候选2, g);
    return { 标题,

      槽: [{ 名: '选', 归: '选', 需: { 最小: 可放弃 ? 0 : n, 最大: n },
        候选: 候选2 }],
      ...(看.length ? { 查看: 看 } : {}),
      确认后发: { 种类: '决定', 接受: true, 选: '$选' },
      ...(可放弃 ? { 放弃后发: { 种类: '决定', 接受: false }, 放弃名: '未搜寻到' } : {}) };
  }

  if (类型 === '宣告') {

    const 模式候选 = (d.模式候选 as { 索引: number; 标签?: string }[] | undefined) || [];
    if (模式候选.length) {
      return { 标题,

        槽: [{ 名: '模式', 归: '模式', 需: { 最小: 1, 最大: 1 }, 呈现: '按钮',
          候选: 模式候选.map((m) => ({ 键: String(m.索引), ...(m.标签 ? { 名: m.标签 } : {}), 发: m.索引 })) }],
        确认后发: { 种类: '宣告', 模式: '$模式' } };
    }
    return { 标题, 槽: 规格槽s(d.规格 as unknown, 条件, g),
      确认后发: { 种类: '宣告', 目标: '$目标' } };
  }

  if (类型 === '选') {

    const 呈现: '按钮' | undefined = d.选什么 === '选项' ? '按钮' : undefined;
    const 槽源 = Array.isArray(d.槽) && d.槽.length
      ? (d.槽 as { 名: string; 数量?: unknown; 候选?: unknown[] }[])
      : [{ 名: '选择', 数量: d.数量 ?? { 最小: 1, 最大: 1 }, 候选: d.候选 as unknown[] | undefined }];
    const 槽s: 槽[] = 槽源.map((z) => {
      const 候选2 = 键候选项(z.候选, g);
      return {
        名: z.名, 归: '选', 需: 名额(z.数量, 1), 候选: 候选2, 条件,
        ...(呈现 ? { 呈现 } : {}),

      };
    });

    const 查看 = 查看内容(d, 槽s.flatMap((z) => z.候选), g);
    if (!槽s.length || !(槽s.some((z) => z.候选.length) || 查看.length)) return null;
    return { 标题, 槽: 槽s,
      ...(查看.length ? { 查看 } : {}),
      确认后发: { 种类: '决定', 接受: true, 选: '$选' } };
  }
  return null;
}

export type 并后动作 = 合法动作 & { 到候选?: 阵地[] };
export function 合并同族动作(动作s: 合法动作[]): 并后动作[] {
  const 出: 并后动作[] = [];
  const 位 = new Map<string, number>();
  for (const a of 动作s) {
    if (a.种类 !== '转移' || a.到 === undefined) { 出.push(a); continue; }
    const 键 = a.uid + '|' + (a.路径 ?? '转移');
    const 已 = 位.get(键);
    if (已 === undefined) {
      位.set(键, 出.length);
      const 名 = a.标签.split(' → ')[0];
      出.push({ ...a, 到候选: [a.到], 标签: 名 + '（点你要移到的空阵地）' });
    } else {
      出[已]!.到候选!.push(a.到);
    }
  }
  return 出;
}

function 查看内容(d: Record<string, unknown>, 候选2: 候选项[], g?: GameState): 候选项[] {
  const 自带 = (d.查看 as unknown[] | undefined)?.length ? 键候选项(d.查看 as unknown[], g) : undefined;
  if (自带?.length) return 自带;
  const 都是隐藏牌 = 候选2.length > 0 && 候选2.every((c) => c.区 === '牌库' || c.区 === '手牌');
  return 都是隐藏牌 ? 候选2 : [];
}

export function 需求_动作(a: Record<string, unknown>, 座位: number, 可支付: unknown[], g?: GameState): 需求 | null {
  const 标题 = String(a.标签 || '');
  const 种类 = String(a.种类 || '');
  const 条件 = { 玩家: 座位 };
  const 槽s: 槽[] = [];

  const 需要阵地 = (a.需要阵地 as { 阵地: string; 标签?: string }[] | undefined) || [];
  if (需要阵地.length) {
    槽s.push({ 名: '阵地', 归: '阵地', 需: { 最小: 1, 最大: 1 },
      候选: 需要阵地.map((x) => ({ 键: x.阵地 })), 条件 });
  }

  槽s.push(...规格槽s(a.目标规格, 条件));

  const 额外 = a.额外牺牲候选 as unknown[] | undefined;
  if (额外 && 额外.length) {
    const n = (a.额外牺牲数 as number) || 1;
    槽s.push({ 名: '额外牺牲', 归: '额外牺牲', 需: { 最小: n, 最大: n }, 候选: 键候选项(额外, g), 条件 });
  }

  const 弃牌数 = (a.费用弃牌数 as number) || 0;
  if (弃牌数 > 0) {
    槽s.push({ 名: '费用弃牌', 归: '费用弃牌', 需: { 最小: 弃牌数, 最大: 弃牌数 },
      候选: 键候选项(a.费用弃牌 as unknown[] | undefined, g), 条件 });
  }
  const 牺牲数 = (a.费用牺牲数 as number) || 0;
  if (牺牲数 > 0) {
    槽s.push({ 名: '费用牺牲', 归: '费用牺牲', 需: { 最小: 牺牲数, 最大: 牺牲数 },
      候选: 键候选项(a.费用牺牲 as unknown[] | undefined, g), 条件 });
  }

  const 是X费 = a.是X === true || a.费用X === true;
  const 费 = 是X费 ? 0 : ((a.费用数 as number) || 0);
  const 候选支付 = 支付候选项(可支付);
  if ((费 > 0 || 是X费) && 候选支付.length) {
    const 上限 = 候选支付.reduce((n, c) => n + (c.量 ?? 1), 0);
    槽s.push({ 名: '支付源', 归: '支付源', 需: { 最小: 费, 最大: 是X费 ? 上限 : 费 }, 候选: 候选支付, 条件 });
  }

  if (种类 === '让过') return { 标题, 槽: 槽s, 确认后发: { 种类: '让过' } };
  if (种类 === '打领土') return { 标题, 槽: 槽s, 确认后发: { 种类: '打领土', uid: '@uid', 面: '@面' } };
  if (种类 === '转移') {

    const 目的地 = (a.到候选 as unknown[] | undefined) ?? [a.到];
    槽s.push({ 名: '到', 归: '到', 需: { 最小: 1, 最大: 1 }, 候选: 键候选项(目的地, g), 条件 });
    return { 标题, 槽: 槽s, 确认后发: { 种类: '转移', uid: '@uid', 到: '$到', 路径: '@路径' } };
  }
  if (种类 === '发起战斗') {
    const 对象 = (a.攻击对象 as { 种类?: string; 玩家?: number; 阵地?: string }[] | undefined) || [];

    槽s.push({ 名: '攻击对象', 归: '攻击对象', 需: { 最小: 1, 最大: 1 },
      候选: 对象.map((t) => {
        if (t.种类 === '玩家') {
          return { 键: '玩家' + t.玩家, 名: g?.players[t.玩家 ?? -1]?.name ?? '对手', 发: t };
        }
        const 单位 = g?.players[t.玩家 ?? -1]?.阵地[(t.阵地 ?? '') as 阵地];
        return 单位
          ? { 键: 单位.uid, 名: 单位.def.全名, 发: t }
          : { 键: '阵地:' + t.玩家 + ':' + t.阵地, 发: t };
      }),
      条件 });

    const 对手号 = 对象.find((t) => t.种类 === '玩家')?.玩家 ?? -1;

    const 税 = (g && Array.isArray((g as GameState).战场) && 对手号 >= 0) ? 攻击税(g, 对手号) : 0;
    if (税 > 0) {
      const 候选支付 = 支付候选项(可支付);
      if (候选支付.length) {
        const 上限 = 候选支付.reduce((n, c) => n + (c.量 ?? 1), 0);
        槽s.push({ 名: '支付源', 归: '支付源', 需: { 最小: 0, 最大: Math.min(税, 上限) },
          候选: 候选支付, 条件 } as 槽);
      }
    }
    return { 标题: 标题 + (税 > 0 ? '　（要打那个玩家：先在这里选好支付 ' + 税 + ' 点的地；打阵地不用选）' : ''),
      槽: 槽s, 确认后发: { 种类: '发起战斗', uid: '@uid', 攻击对象: '$攻击对象', 支付源: '$支付源' } };
  }
  if (种类 === '施放') {
    return { 标题, 槽: 槽s,
      确认后发: { 种类: '施放', uid: '@uid', 目标: '$目标', 阵地: '$阵地', 支付源: '$支付源', 额外牺牲: '$额外牺牲' } };
  }
  if (种类 === '启动能力') {
    return { 标题, 槽: 槽s,
      确认后发: { 种类: '启动能力', uid: '@uid', 能力索引: '@能力索引', 模式号: '@模式号',
        目标: '$目标', 支付源: '$支付源', 费用弃牌: '$费用弃牌', 费用牺牲: '$费用牺牲' } };
  }

  if (!槽s.length) return null;
  return { 标题, 槽: 槽s, 确认后发: { 种类 } };
}
