import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

const 详细 = process.argv.includes('--详细');
const 是md = process.argv.includes('--md');
const 根 = path.resolve(import.meta.dirname, '..', '..');
const 源 = fs.readFileSync(path.join(根, 'src', 'engine', 'types.ts'), 'utf8');
const 文件 = ts.createSourceFile('types.ts', 源, ts.ScriptTarget.ESNext, true);

type 成员 = { 名: string; 可选: boolean; 类型: string; 说明: string };
type 声明 = { 名: string; 种类: 'interface' | 'type'; 说明: string; 成员: 成员[]; 联合体: string[] };
const 声明表 = new Map<string, 声明>();

const 注释 = (节点: ts.Node): string => {
  const 全 = (节点 as unknown as { jsDoc?: { comment?: unknown }[] }).jsDoc ?? [];
  const 段 = 全.map((j) => 文本(j.comment)).filter(Boolean);
  return 段.join('  ').replace(/\s+/g, ' ').trim();
};
const 文本 = (c: unknown): string => {
  if (c === undefined || c === null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(文本).join('');
  const t = (c as { text?: string }).text;
  return t ?? '';
};
const 类型名 = (t?: ts.TypeNode): string => {
  if (!t) return 'any';
  const s = t.getText(文件).replace(/\s+/g, ' ');
  return 详细 ? s : (s.length > 64 ? s.slice(0, 61) + '…' : s);
};

文件.forEachChild((节点) => {
  const 名 = (节点 as unknown as { name?: ts.Identifier }).name?.text;
  if (!名) return;
  if (ts.isInterfaceDeclaration(节点)) {
    const 成员: 成员[] = [];
    for (const m of 节点.members) {
      if (!ts.isPropertySignature(m)) continue;
      const 键 = (m.name as ts.Identifier).text;
      if (!键) continue;
      成员.push({ 名: 键, 可选: !!m.questionToken, 类型: 类型名(m.type), 说明: 注释(m) });
    }
    声明表.set(名, { 名, 种类: 'interface', 说明: 注释(节点), 成员, 联合体: [] });
  } else if (ts.isTypeAliasDeclaration(节点)) {
    const 联合体: string[] = [];
    const 展 = (t: ts.TypeNode): void => {
      if (ts.isUnionTypeNode(t)) { t.types.forEach(展); return; }
      if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) { 联合体.push(t.literal.text); return; }
      if (ts.isParenthesizedTypeNode(t)) { 展(t.type); return; }
      联合体.push(类型名(t));
    };
    if (节点.type) 展(节点.type);
    声明表.set(名, { 名, 种类: 'type', 说明: 注释(节点), 成员: [], 联合体 });
  }
});

const 打声明 = (名: string, 标题: string): void => {
  const d = 声明表.get(名);
  if (!d) { console.log('（找不到类型 ' + 名 + '）'); return; }
  console.log('');
  console.log('══ ' + 标题 + '（' + 名 + '）══');
  if (d.说明) console.log('  ' + d.说明.slice(0, 200));
  if (d.成员.length) {
    const 宽 = Math.max(...d.成员.map((m) => m.名.length + (m.可选 ? 1 : 0)));
    for (const m of d.成员) {
      console.log('  ' + (m.名 + (m.可选 ? '?' : '')).padEnd(宽 + 2) + m.类型);
      if (m.说明) console.log('  ' + ' '.repeat(宽 + 2) + '└ ' + m.说明.slice(0, 170));
    }
  }
  if (d.联合体.length) console.log('  ' + d.联合体.join('　|　'));
};

if (!是md) console.log('════════ 一、操作（卡数据里 效应/牌效应 能写的 操作）════════');
const 操作表: { 操作: string; 类型: string; 说明: string; 成员: 成员[] }[] = [];

const 收操作 = (节点: ts.TypeNode | ts.InterfaceDeclaration, 类型名_: string): void => {
  const 是接口 = ts.isInterfaceDeclaration(节点);
  const 成员节点 = (是接口 ? 节点.members : (节点 as ts.TypeLiteralNode).members);
  const 成员: 成员[] = [];
  let 操作字面: string[] = [];
  let 说明 = 注释(是接口 ? 节点 : (节点 as ts.TypeLiteralNode));
  for (const m of 成员节点) {
    if (!ts.isPropertySignature(m)) continue;
    const 键 = (m.name as ts.Identifier).text;
    if (!键) continue;
    if (键 === '操作') { 操作字面 = [...(m.type ? m.type.getText(文件) : '').matchAll(/'([^']+)'/g)].map((x) => x[1]!); if (!说明) 说明 = 注释(m); continue; }
    成员.push({ 名: 键, 可选: !!m.questionToken, 类型: 类型名(m.type), 说明: 注释(m) });
  }
  for (const 名 of 操作字面) 操作表.push({ 操作: 名, 类型: 类型名_, 说明, 成员 });
};

for (const d of 声明表.values()) {
  const 原 = 文件.statements.find((x) => ts.isTypeAliasDeclaration(x) && x.name.text === d.名);
  if (!原 || !ts.isTypeAliasDeclaration(原) || !原.type) continue;
  const 展 = (t: ts.TypeNode): void => {
    if (ts.isUnionTypeNode(t)) { t.types.forEach(展); return; }
    if (ts.isTypeLiteralNode(t)) { if (/操作/.test(t.getText(文件))) 收操作(t, d.名); return; }
  };
  展(原.type);
}

for (const d of 声明表.values()) {
  const 有操作 = d.成员.find((m) => m.名 === '操作');
  if (!有操作) continue;
  const 各 = [...有操作.类型.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  for (const 名 of 各) if (!操作表.some((x) => x.操作 === 名)) 操作表.push({ 操作: 名, 类型: d.名, 说明: d.说明, 成员: d.成员.filter((m) => m.名 !== '操作') });
}

if (process.argv.includes('--md')) {
  const 表: string[] = [];
  const 行 = (x = ''): void => { 表.push(x); };
  行('# 引擎参数表');
  行();
  行('> **自动生成** —— 来源是 `src/engine/types.ts`，别手改这个文件。');
  行('> 重新生成：`node dist/tools/engine-params.js --md > 引擎参数.md`');
  行();
  行('卡数据里能写的**所有**操作与字段都在这里。字段名后面带 `?` 的可以不写。');
  行();
  const 效应 = 操作表.filter((o) => ['步骤主体', 'DamageOp'].includes(o.类型)).sort((a, b) => a.操作.localeCompare(b.操作, 'zh'));
  const 条件 = 操作表.filter((o) => o.类型 === 'Condition').sort((a, b) => a.操作.localeCompare(b.操作, 'zh'));
  const 其他 = 操作表.filter((o) => !效应.includes(o) && !条件.includes(o));
  行('## 目录');
  行();
  行('- [' + '操作（效应/牌效应）' + '](#' + '操作效应牌效应' + ')　' + 效应.length + ' 个');
  行('- [条件运算](#' + '条件运算' + ')　' + 条件.length + ' 个');
  if (其他.length) 行('- [其他](#' + '其他' + ')　' + 其他.length + ' 个');
  行('- [选择器 / 目标 / 筛选 / 触发 / 费用 …](#常用词汇)');
  行('- [关键词（702 章）](#关键词702-章)');
  行();
  const 打操作 = (标题: string, 表2: typeof 操作表): void => {
    行('## ' + 标题);
    行();
    for (const o of 表2) {
      行('### ' + o.操作);
      行();
      if (o.说明) { 行('> ' + o.说明.replace(/\n+/g, ' ')); 行(); }
      行('| 字段 | 类型 | 说明 |');
      行('| --- | --- | --- |');
      if (!o.成员.length) 行('| （无字段） |  |  |');
      for (const m of o.成员) {
        const 型 = '`' + m.类型.replace(/\|/g, '\\|') + '`';
        const 说 = m.说明.replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 300);
        行('| `' + m.名 + (m.可选 ? '?' : '') + '` | ' + 型 + ' | ' + 说 + ' |');
      }
      行();
    }
  };
  打操作('操作（效应/牌效应）', 效应);
  打操作('条件运算', 条件);
  if (其他.length) 打操作('其他', 其他);
  行('## 常用词汇');
  行();
  for (const 名 of ['Selector', 'TargetSpec', '筛选条件', 'Condition', 'Trigger', 'Cost', '层修改', 'ReplacementSpec', '指示物定义', '规则限制', '关键词能力']) {
    const d = 声明表.get(名);
    if (!d) continue;
    行('### ' + 名);
    行();
    if (d.说明) { 行('> ' + d.说明.replace(/\n+/g, ' ')); 行(); }
    if (d.成员.length) {
      行('| 字段 | 类型 | 说明 |');
      行('| --- | --- | --- |');
      for (const m of d.成员) 行('| `' + m.名 + (m.可选 ? '?' : '') + '` | `' + m.类型.replace(/\|/g, '\\|') + '` | ' + m.说明.replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 300) + ' |');
      行();
    }
  }
  行('### 枚举');
  行();
  for (const 名 of ['筛选属性', '筛选比较', '阵地关系', 'CardType', 'Supertype', 'Faction', 'Zone', '事件名']) {
    const d = 声明表.get(名);
    if (d && d.联合体.length) 行('- **' + 名 + '**：' + d.联合体.map((x) => '`' + x + '`').join('　'));
  }
  行();
  行('## 关键词（702 章）');
  行();
  行('引擎按**名字**查这些关键词，卡数据里写 `{ 名称: \'坚韧\', 数值: 2 }` 这种。');
  行();
  try {
    const { pathToFileURL } = await import('node:url');
    const c = await import(pathToFileURL(path.join(根, 'dist', 'engine', 'continuous.js')).href) as { 关键词解析表: Record<string, unknown> };
    const 键 = Object.keys(c.关键词解析表 ?? {}).sort();
    行(键.map((k) => '`' + k + '`').join('　'));
  } catch (e) { 行('（读 dist 失败：' + (e as Error).message + '）'); }
  行();
  console.log(表.join('\n'));
  process.exit(0);
}
操作表.sort((a, b) => a.类型.localeCompare(b.类型) || a.操作.localeCompare(b.操作, 'zh'));

const 分组 = new Map<string, typeof 操作表>();
for (const o of 操作表) {

  const 效应类 = ['步骤主体', 'DamageOp', 'ResolvedStep', '效应步骤'];
  const 组 = 效应类.includes(o.类型) ? '效应/牌效应里能写的操作'
    : o.类型 === 'Condition' ? '条件（Condition）里的运算'
    : o.类型 === 'Value' ? '取值（Value）的形态'
    : '其他（来自 ' + o.类型 + '）';
  if (!分组.has(组)) 分组.set(组, []);
  分组.get(组)!.push(o);
}
for (const [组, 表] of 分组) {
  console.log('');
  console.log('  ──────── ' + 组 + '：' + 表.length + ' 个 ────────');
  for (const o of 表) {
    console.log('');
    console.log('  ● ' + o.操作 + '   （类型 ' + o.类型 + '）');
    if (o.说明) console.log('      ' + o.说明.slice(0, 180));
    for (const m of o.成员) {
      console.log('      ' + (m.名 + (m.可选 ? '?' : '')).padEnd(18) + m.类型);
      if (m.说明) console.log('      ' + ' '.repeat(18) + '└ ' + m.说明.slice(0, 160));
    }
  }
}

console.log('');
console.log('════════ 二、其余常用词汇 ════════');
打声明('Selector', '选择器（描述一批物件）');
打声明('TargetSpec', '目标规格');
打声明('筛选条件', '筛选条件的一条');
打声明('Condition', '条件');
打声明('Trigger', '触发');
打声明('Cost', '费用（602.1d：「→」前的一切）');
打声明('层修改', '层修改（613）');
打声明('ReplacementSpec', '替代/防止（614/615）');
打声明('指示物定义', '指示物（112.3）');
打声明('规则限制', '规则限制（604）');
打声明('关键词能力', '关键词能力');
for (const 名 of ['筛选属性', '筛选比较', '阵地关系', 'CardType', 'Supertype', 'Faction', 'Zone', '事件名']) {
  const d = 声明表.get(名);
  if (d && d.联合体.length) { console.log(''); console.log('  ' + 名 + '：' + d.联合体.join('　|　')); }
}

console.log('');
console.log('════════ 三、关键词（702 章，引擎按名字查）════════');
try {
  const { pathToFileURL } = await import('node:url');
  const c = await import(pathToFileURL(path.join(根, 'dist', 'engine', 'continuous.js')).href) as { 关键词解析表: Record<string, unknown> };
  const 键 = Object.keys(c.关键词解析表 ?? {});
  console.log('  带参数、能展开成能力的：' + 键.join('、'));
} catch (e) { console.log('  （读 dist/engine/continuous.js 失败：' + (e as Error).message + '）'); }
console.log('');
console.log('  提示：字段名/取值全部来自 src/engine/types.ts —— 数据里写错名字 tsc 会拦住。');
