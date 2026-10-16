export type Faction = '魏' | '蜀' | '吴' | '群' | '汉' | '晋' | '神';

export type Support = '蓝' | '红' | '绿' | '黑' | '紫';
export type SupportMap = Partial<Record<Support, number>>;

export type CardType = '单位' | '化身' | '锦囊' | '领土' | '统帅' | '元神' | '战器' | '阵略';

export type Supertype = '边境' | '基本' | '军势' | '瞬发' | '通常' | '无双';

export type 稀有度 = '普通' | '非凡' | '稀有' | '传世' | '异画';

export interface FactionRequirement {
  符号: SupportMap;

  混色?: { a: Support; b: Support }[];
}

export interface Cost {

  通用?: number | 'X';
  条件需求?: FactionRequirement;

  横置?: boolean;

  体力?: number;

  自身体力?: number;

  牺牲自身?: boolean;

    弃牌?: { 数量: number | 'X'; 筛选?: 筛选条件[] };

  牺牲?: { 数量: number; 筛选?: 筛选条件[] };

  暗置进场?: boolean;

  是费用能力?: boolean;
}

export type 阵地 = '左边路' | '左侧翼' | '中路' | '右侧翼' | '右边路';

export const 阵地顺序: readonly 阵地[] = ['左边路', '左侧翼', '中路', '右侧翼', '右边路'];

export type 阵地关系 = '相对' | '相邻' | '斜对';

export type SelectKind =
  | '物件' | '实体' | '单位' | '元神' | '化身'
  | '锦囊' | '领土' | '战器' | '阵略'
  | '令符' | '牌' | '玩家' | '对手';

export type 事件名 =
  | '进战场' | '离开战场' | '死去'

  | '步骤开始' | '阶段开始'

  | '宣告攻击'
  | '受到伤害' | '造成伤害'
  | '成为横置' | '重置'
  | '明置' | '暗置'
  | '打出牌'
  | '移动'
  | '被指定为目标' | '抓牌' | '弃牌' | '牺牲' | '放逐'

  | '回复体力';

export interface 历史条件 {
  事件: 事件名;

  角色?: '来源' | '受方';

  时段?: '本回合' | '上回合' | '本步骤' | '这盘游戏';

  数量?: { 比较: 筛选比较; 值: number };
}

export type 玩家动作 =
  | '打出牌'
  | '发起战斗'
  | '启动能力'
  | '抓牌'
  | '弃牌'
  | '使用费用能力';

export interface Selector {
  区域?: '战场' | '堆叠' | '手牌' | '牌库' | '墓地' | '放逐区' | '统帅区';
  种类?: SelectKind;

  关系?: { anchor: '自身'; 关系: 阵地关系 };

  操控者?: '你' | '对手' | '任意' | { 目标: string }

    | { ref: '触发受方' };

  面?: '明置' | '暗置';

  已横置?: boolean;

  相对阵地为空?: boolean;

  自身?: boolean;

  除?: '自身';

  含堆叠能力?: boolean;

  所附属?: boolean;

  所佩带?: boolean;

  非种类?: SelectKind;

  筛选?: 筛选条件[];

  历史?: 历史条件[];
}

export interface TargetSpec {
  目标名: string;

  数量: { 最小: number; 最大: number };
  选择?: Selector;

  任一?: Selector[];
}

export type Value =

  | 'X'
  | number
  | { player: '你'; stat: '体力' | '体力上限' | '手牌数' }

  | { 自身: '武力' | '体力上限' | '伤害' }

    | { 乘以: Value; 系数: number }

  | { 数: Selector }

  | { 记忆: string }

export type Condition =

  | { 操作: '本回合发生过'; 事件: 事件名; 谁的?: '你' | '对手'; 筛选?: 筛选 }
  | { 操作: '<=' | '<' | '>=' | '>' | '=' | '!='; left: Value; right: Value }
  | { 操作: '与'; 参数: Condition[] }
  | { 操作: '或'; 参数: Condition[] }
  | { 操作: '非'; 参数: Condition }

  | { 操作: '附属在'; 目标: string }

    | { 操作: '回合是'; 谁的: '你' | '对手' }

export type 玩家指向 = '你' | number | RecipientRef;

export type RecipientRef =

  | { 选: Selector; 数量?: { 最小: number; 最大: number }; 标签?: string }
  | { ref: '自身' }

  | { ref: '操控者' }

  | { ref: '额外牺牲' }
  | { 目标: string }

  | {
      selectAll: Selector;

      个数?: number;
    }

  | { selectRelation: 阵地关系; 相对?: RecipientRef }

  | { 随机取: Selector; 个数?: number }

  | { ref: '触发受方' }

  | { 记忆: string }

  | { ref: '暂存' };

export interface DamageOp {
  操作: '伤害';
  来源: '自身' | { 目标: string } | { ref: '额外牺牲' };

  事件: { 受方: RecipientRef; 点数: number | 'X' | '触发事件量' | '来源武力' | { 武力: RecipientRef } }[];

  战斗伤害?: boolean;
}

export interface 指示物定义 {

  名称?: string;
  势力?: Faction[] | null;
  类别: CardType[];
  副类别?: string[];
  武力?: number;
  体力上限?: number;
  关键词?: string[];
}

type 步骤主体 =
  | DamageOp

  | { 操作: '抓牌'; 玩家?: '你' | number | RecipientRef; 数量: number | Value }

  | { 操作: '可选支付'; 费用: Cost; 若前一效应生效?: boolean }
  | { 操作: '取消'; to: { 目标: string } }
  | { 操作: '放逐'; to: RecipientRef }

| { 操作: '移动'; to?: { 目标: string } | RecipientRef; selectAll?: Selector; 去处: string

    玩家?: number | RecipientRef }

  | { 操作: '守望'; 事件: 事件名; 步骤?: string; 阶段?: string;

      操控者?: RecipientRef;

      时长?: '直到回合结束' | '下一次';
      能力: TriggeredAbility }
  | { 操作: '观星'; 数量: number | Value; 玩家?: number }
  | { 操作: '检视'; 来源: RecipientRef; viewer: '你';

      区域?: '手牌' | '牌库顶';

      数量?: number | '全部';
      筛选?: 筛选;

      去处?: '墓地' | '手牌' | '牌库顶' | '暂存';

      玩家?: number;

      可选?: boolean }
  | { 操作: '加成'; to: { 目标: string }; 武力: number; 体力上限: number; duration: string }

  | { 操作: '明置'; to: RecipientRef }
  | { 操作: '暗置'; to: RecipientRef }

  | { 操作: '翻面'; to: RecipientRef }

  | { 操作: '体力'; player: '你' | { 目标: string };
      模式号: '回复至上限' | '获得' | '失去'; 点数?: number }

  | { 操作: '防止'; 点数: number }

  | { 操作: '略过'; 目标: RecipientRef; 什么: '重置步骤' | '抓牌步骤' | '结束步骤' | '回合' }

  | { 操作: '重置'; 目标: RecipientRef }

| { 操作: '回复'; 目标: RecipientRef; 数量?: number | '触发事件量' | Value }

  | { 操作: '消灭'; 目标: RecipientRef | { selectAll: Selector } }

  | { 操作: '牺牲'; 目标: RecipientRef | { selectAll: Selector } }

  | { 操作: '选择牺牲'; 玩家: 玩家指向; 筛选?: 筛选;

      除自身?: boolean }

  | { 操作: '弃牌'; 玩家?: '你' | number | RecipientRef; 数量: number }

  | {
      操作: '展示';
      玩家?: '你' | number | RecipientRef;

      数量?: number;

      从?: RecipientRef;
    }

  | { 操作: '失去体力'; 目标: RecipientRef; 数量: number | Value; 若前一效应生效?: boolean }

  | {
      操作: '搜寻';

      玩家?: RecipientRef;

      从?: ('牌库' | '牌库顶' | '手牌' | '墓地' | '放逐区' | '战场')[];

      数量?: number;
      筛选?: 筛选;
      去处?: '手牌' | '战场' | '牌库顶' | '墓地' | '暂存';

    }

  | { 操作: '放置暂存'; 去处: '牌库顶' | '牌库底' | '手牌' | '战场' | '墓地'; 横置?: boolean; 从?: RecipientRef; 操控者?: '你' | '拥有者';

      顺序?: '玩家' }

  | { 操作: '洗牌'; 玩家?: '你' | number | RecipientRef }

  | { 操作: '翻牌库顶'; 玩家?: '你' | number | RecipientRef; 数量: number; 分流: { 筛选?: 筛选条件[]; 去处: '手牌' | '牌库顶' | '牌库底' | '墓地' | '放逐区' | '战场' | '暂存'; 横置?: boolean }[] }

  | {
      操作: '移到阵地'; to: RecipientRef;

      相对?: RecipientRef;

      空阵地?: '其操控者' | '对手';

      由谁选?: '你' | '对手';

      可选?: boolean;
    }

  | { 操作: '决斗'; 甲: RecipientRef; 乙: RecipientRef }

  | { 操作: '交换阵地'; 甲: RecipientRef; 乙: RecipientRef }

  | { 操作: '记住'; 键: string; 从: RecipientRef; 取: '武力' | '体力上限' | '打出费用' | '伤害' | '玩家号' }

  | { 操作: '累加'; 键: string; 值: number | Value }

  | { 操作: '横置'; to: RecipientRef }

  | { 操作: '磨牌'; 玩家?: '你' | number | RecipientRef; 数量: number }

  | { 操作: '征召'; 指示物: CardDef; 数量: number | Value; 关键词?: string[];

      阵地?: (阵地 | null | { 触发受方: true })[] }

  | { 操作: '放玩家标记'; 标记: string; 数量: number }
  | { 操作: '放置标记'; 目标: RecipientRef; 标记: string; 数量: number }

  | { 操作: '移去标记'; 目标: RecipientRef; 标记: string; 数量: number }
  | { 操作: '持续'; 目标: RecipientRef | { selectAll: Selector } | '自己'; 时长?: string;

      层?: 层修改;
      替代?: ReplacementSpec;
      条件?: Condition;
      若前一效应生效?: boolean;
      作用?: '自身' | '你操控' | '所有' }

  | { 操作: '限制玩家'; 玩家: { 目标: string } | number; 禁止: 玩家动作; 筛选?: 筛选; 时长?: '直到回合结束' }
  | { 操作: '原生'; 模块: string };

export type ResolveStep = 步骤主体 & {
  若前一效应生效?: boolean;

  条件?: Condition };

export interface Trigger {

  事件: 事件名;

  主体?: '自身' | '其他单位' | '所附属' | '所佩带';

  主体归属?: '你' | '对手';

  主体筛选?: 筛选;

  受方?: '玩家' | '实体';

  筛选来源?: 筛选;
  步骤?: '重置步骤' | '准备步骤' | '抓牌步骤' | '结束步骤' | '弃牌步骤';
  阶段?: '开始阶段' | '行动阶段' | '收官阶段';
  谁的回合?: '你' | '任意';

  筛选?: 筛选条件[];
}

export interface ModeSpec {
  选几项: number;

  宣告于: '进堆叠时';
  记忆?: { 记忆范围: '自身'; 记忆键: string; 禁止重复: true };
  选项: { 标签: string; 目标?: TargetSpec[]; 效应: ResolveStep[] }[];
}

export interface TriggeredAbility {
  种类: '触发式';

  目标时点?: '触发时';

  触发: Trigger;
  可选?: boolean;
  目标?: TargetSpec[];
  模式?: ModeSpec;
  效应: ResolveStep[];
}

export interface ActivatedAbility {
  种类: '启动式';

  标签?: string;

  时机?: '通常' | '瞬发';
  费用: Cost;

  是费用能力?: boolean;

  提供?: number;

  条件?: Condition;

  限制?: '每回合一次';
  目标?: TargetSpec[];

  模式?: ModeSpec;
  效应: ResolveStep[];
}

export interface ReplacementSpec {

  说明?: string;
  替代: {

    事件: '伤害' | '造成伤害' | '抓牌' | '进战场' | '死去' | '横置' | '重置步骤' | '步骤' | '回合';

    受方?: '自身' | '你' | '任意' | RecipientRef;

    来源?: '自身' | '其他单位' | RecipientRef;
  };
  条件?: Condition;

  自身替代: boolean;

  防止?: number;

  限战斗伤害?: boolean;

    限射击?: boolean;

  数量?: { 运算: '加' | '减' | '乘' | '设为'; 值: number };

  略过?: boolean;

  应用?: ResolveStep[];
}

export interface 层修改 {

  操控权?: '你';

  类别?: CardType[];

  超类别?: Supertype[];

  副类别?: string[];

  增加副类别?: string[];

  势力?: Faction[];

  获得关键词?: 关键词能力条目[];

  授予动作?: { 动作: string; 参数?: Record<string, string | number | boolean> }[];

  不能重置?: boolean;

  失去所有能力?: boolean;

  定义武力?: number | 'X';
  定义体力?: number | 'X';

  设定武力?: number | 'X';
  设定体力?: number | 'X';

  增减武力?: number | Value;
  增减体力?: number | Value;

  交换武力体力?: boolean;
}

export type 筛选属性 =
  | '类别' | '副类别' | '势力' | '超类别'
  | '名称' | '全名' | '称号' | '无双名称'
  | '关键词'
  | '打出费用'
  | '伤害'
  | '灵值' | '武力' | '体力上限';

export type 筛选比较 = '是' | '不是' | '包含' | '不含' | '大于' | '小于' | '大于等于' | '小于等于';

export interface 筛选条件 {
  属性: 筛选属性;
  比较?: 筛选比较;

  值?: string | number | (string | number)[] | { 记忆: string };

  印制?: boolean;
}

export type 筛选 = 筛选条件[];

export interface 连续效应定义 {

  范围?: Selector;

  筛选?: 筛选;
  层: 层修改;

  条件?: Condition;
}

export interface StaticAbility {
  种类: '静止式';

  自身限制?: 自身限制[];

  必须发起战斗?: boolean;

  打出许可?: { 筛选?: 筛选; 视同: '伏击' }[];

  攻击税?: number;

  规则限制?: 规则限制[];

  费用修正?: 费用修正[];

  手牌上限修正?: { 手牌上限: number; 适用: '你' | '对手' }[];

  自身加成?: { 每个其他同名: { 武力?: number; 体力上限?: number } };

  连续?: 连续效应定义;
  替代效应?: ReplacementSpec;
}

export interface 费用修正 {

  打出费用: number | Value;

  条件?: Condition;

  适用: '你' | '对手';

  筛选?: 筛选;
}

export type 自身限制 = '发起战斗' | '攻击阵地';

export interface 规则限制 {

  禁止: '打出明置领土';

  适用: '你';
}

export interface 关键词能力条目 extends 关键词能力 {

  印制?: boolean;
}

export interface 关键词能力 {

  名称: string;

  数值?: number;

  特征?: 筛选;
}
export type Ability =
  | 关键词能力
  | TriggeredAbility
  | ActivatedAbility
  | StaticAbility;

export interface EffectProgram {

  目标?: TargetSpec[];

  牌效应?: ResolveStep[];
  能力?: Ability[];
}

export function 卡号(c: { 系列: string; 编号: string }): string {
  return c.系列.toUpperCase() + '-' + c.编号;
}

export function 卡图(c: { 系列: string; 编号: string }): string {
  return '/cards/' + c.系列 + '/' + 卡号(c) + '.jpg';
}

export interface CardDef {

  灵值?: number;

  系列: string;

  编号: string;
  全名: string;
  称号?: string;
  名称: string[];
  名称限定词?: string;
  修饰符: ('界' | '改')[];

  势力: Faction[] | null;

  打出费用: number | 'X';

  额外费用?: Cost;
  势力需求: FactionRequirement;
  超类别: Supertype[];
  类别: CardType[];
  副类别: string[];

  武力?: number | '*';
  体力上限?: number | '*';

  势力支持?: SupportMap;

  横置进场?: boolean;

  现行文字: string;

  稀有度: 稀有度;
  能力: EffectProgram | null;
}
