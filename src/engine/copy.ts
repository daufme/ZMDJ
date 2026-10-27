import type { CardDef, 复制例外 } from './types.js';
import type { GameState, Obj, Zone } from './state.js';
import { 造对象, 写def, 写复制 } from './state.js';

/**
 * 708.2：复制时冻结源物件的可复制特征。
 *
 * 复制品使用自己的 `def` 快照，而不是实时读取源物件：
 * · 源后来被加 buff，复制品不会跟着变（708.2b）；
 * · 复制复制品时，克隆复制品当前的快照（708.3）；
 * · 普通持续效应不在 `def` 里，所以不会被复制（708.2）。
 */
export function 拍可复制特征(g: GameState, 源: Obj, 例外?: 复制例外, 原名?: CardDef): CardDef {
  // CardDef 是纯数据对象；深拷贝保证复制品之后不会被源的修改影响。
  let 快照 = JSON.parse(JSON.stringify(源.def)) as CardDef;
  // 709.2a：暗置实体没有牌面名称/势力/副类别/能力；复制它时得到的是暗置领土的可复制特征。
  if (源.面 === '暗置') {
    快照 = {
      ...快照, 称号: undefined, 名称: ['暗置领土'], 全名: '暗置领土',
      名称限定词: undefined, 修饰符: [],
      势力: null, 势力需求: { 符号: {} }, 势力支持: undefined,
      超类别: [], 类别: ['领土'], 副类别: [], 武力: undefined, 体力上限: undefined,
      灵值: undefined, 打出费用: 0, 额外费用: undefined, 横置进场: false,
      现行文字: '', 能力: null,
    };
  }
  if (例外?.修改) 快照 = { ...快照, ...(JSON.parse(JSON.stringify(例外.修改)) as Partial<CardDef>) };
  // 708.9b：「不复制某些特征」不是把这些特征清空，而是**保留被复制物件自己的那一部分值**。
  // 例：步骘「名称不变」以外的写法也可能是「不复制名称」；对已经在场的复制品再复制时，
  // 保留的是它**当前**的可复制特征（可能是上一个复制品的样子），不是最底下那张牌的印制信息。
  const 保留 = <K extends keyof CardDef>(键: K, 空值: CardDef[K]): CardDef[K] => {
    const 原 = 原名?.[键];
    return 原 === undefined ? 空值 : JSON.parse(JSON.stringify(原)) as CardDef[K];
  };
  const 不复制 = new Set(例外?.不复制 ?? []);
  if (不复制.has('能力')) 快照.能力 = 保留('能力', null);
  if (不复制.has('名称')) 快照.名称 = 保留('名称', []);
  if (不复制.has('称号')) 快照.称号 = 保留('称号', undefined);
  if (不复制.has('全名')) 快照.全名 = 保留('全名', '');
  if (不复制.has('名称限定词')) 快照.名称限定词 = 保留('名称限定词', undefined);
  if (不复制.has('修饰符')) 快照.修饰符 = 保留('修饰符', []);
  if (不复制.has('副类别')) 快照.副类别 = 保留('副类别', []);
  if (不复制.has('类别')) 快照.类别 = 保留('类别', []);
  if (不复制.has('超类别')) 快照.超类别 = 保留('超类别', []);
  if (不复制.has('势力')) 快照.势力 = 保留('势力', null);
  if (不复制.has('势力需求')) 快照.势力需求 = 保留('势力需求', { 符号: {} });
  if (不复制.has('势力支持')) 快照.势力支持 = 保留('势力支持', undefined);
  if (不复制.has('打出费用')) 快照.打出费用 = 保留('打出费用', 0);
  if (不复制.has('灵值')) 快照.灵值 = 保留('灵值', undefined);
  if (不复制.has('现行文字')) 快照.现行文字 = 保留('现行文字', '');
  if (不复制.has('武力')) 快照.武力 = 保留('武力', undefined);
  if (不复制.has('体力上限')) 快照.体力上限 = 保留('体力上限', undefined);
  if (例外?.名称不变 && 原名) {
    快照.名称 = 原名.名称; 快照.称号 = 原名.称号; 快照.全名 = 原名.全名;
    快照.名称限定词 = 原名.名称限定词; 快照.修饰符 = 原名.修饰符;
  }
  // 708.9d：复制过程若不复制 / 保留 / 修改武力或体力上限，源物件的「特征定义能力」
  // 就**不能跟着复制** —— 否则它会在层7a 把刚刚写好的印制值重新定义掉。
  const 改武力 = 不复制.has('武力') || (例外?.修改 !== undefined && '武力' in 例外.修改);
  const 改体力 = 不复制.has('体力上限') || (例外?.修改 !== undefined && '体力上限' in 例外.修改);
  if (改武力 || 改体力) 去掉定义特征能力(快照, 改武力, 改体力);
  if (例外?.额外能力?.length) {
    const 旧 = (快照.能力?.能力 ?? []) as unknown[];
    快照.能力 = { ...(快照.能力 ?? {}), 能力: [...旧, ...(例外.额外能力 as unknown[])] } as CardDef['能力'];
  }
  return 快照;
}

/** 708.9d：从复制快照里移除定义指定特征的特征定义能力。 */
function 去掉定义特征能力(def: CardDef, 武力: boolean, 体力: boolean): void {
  const 程序 = def.能力;
  if (!程序?.能力?.length) return;
  const 留: unknown[] = [];
  for (const ab of 程序.能力 as unknown as Record<string, unknown>[]) {
    if (ab['种类'] !== '静止式' || !Array.isArray(ab['效应'])) { 留.push(ab); continue; }
    const 旧 = ab['效应'] as Record<string, unknown>[];
    const 新: Record<string, unknown>[] = [];
    for (const e of 旧) {
      // 「每个其他同名」那条也是特征定义能力（604.3），它定义的是武力/体力，直接整条去掉。
      if (e['类别'] === '特征定义') continue;
      if (e['类别'] !== '物件持续' || !e['层'] || typeof e['层'] !== 'object') { 新.push(e); continue; }
      const 层 = { ...(e['层'] as Record<string, unknown>) };
      if (武力) delete 层['定义武力'];
      if (体力) delete 层['定义体力'];
      if (Object.keys(层).length === 0) continue;
      新.push({ ...e, 层 });
    }
    if (新.length) 留.push(新.length === 旧.length ? ab : { ...ab, 效应: 新 });
  }
  def.能力 = { ...程序, 能力: 留 as never };
}

/** 把 `o` 变成 `源` 的复制品。实体牌作为复制进场时必须保存原 def，离场恢复。 */
export function 应用复制(g: GameState, o: Obj, 源: Obj, 保存原def = true, 例外?: 复制例外): void {
  // 708.9b：例外要保留的是**这个物件当前**的那部分值；如果是复制品再复制，
  // 当前值来自上一个复制快照，而不是 `复制.原def` 里最底下的印制信息。
  const 当前def = o.def;
  const 原def = o.复制?.原def ?? (保存原def ? o.def : undefined);
  写def(g, o, 拍可复制特征(g, 源, 例外, 当前def));
  // 708.2 / 708.3：复制**不复制状态**。明置的复制品复制暗置物件时仍是明置，
  // 暗置实体复制明置物件时仍是暗置；它的特征由 709.2 的暗置状态暂时盖住，明置后才显现复制快照。
  写复制(g, o, { 源iid: 源.iid, ...(原def ? { 原def } : {}) });
}

/** 复制指示物：新建对象，使用源的可复制特征。 */
export function 造复制对象(g: GameState, 源: Obj, owner: number, 区域: Zone, 是指示物 = false, 例外?: 复制例外): Obj {
  const o = 造对象(g, 拍可复制特征(g, 源, 例外), owner, 区域);
  // 708.2 例：征召暗置领土的复制品时，指示物进场是**明置**的，只是复制到的特征为暗置领土。
  // 所以这里不能把源的 `面` 抄过来；新建指示物保持 `造对象` 的明置默认值。
  if (是指示物) (o as { 是指示物?: boolean }).是指示物 = true;
  写复制(g, o, { 源iid: 源.iid });
  return o;
}

/** 复制效果结束/实体离开战场：恢复原卡定义。复制指示物没有原 def。 */
export function 恢复复制(g: GameState, o: Obj): void {
  const 原 = o.复制?.原def;
  if (原) 写def(g, o, 原);
  写复制(g, o, undefined);
}
