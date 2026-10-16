export interface 系列项 {

  启用: boolean;

  说明: string;

  年份?: string;
}

export const 系列配置: Record<string, 系列项> = {
  初阵: { 启用: true, 年份: '2014', 说明: '阵面对决·初阵（第一弹）' },
  怒焰: { 启用: true, 说明: '阵面对决·怒焰（黑水祭天 031）' },

  测试: { 启用: false, 说明: '自建测试卡（新兵/弓手/重甲兵/民夫/斥候/冷箭/急袭/前哨/铁壁/搜寻测试）' },
};
