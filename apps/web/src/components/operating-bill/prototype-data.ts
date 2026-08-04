export interface SubjectBillRow {
  name: string;
  providers: string[];
  tokens: string;
  quota: string;
  cost: string;
  activity: string;
  note: string;
}

export interface ValueItem {
  id: number;
  item: string;
  subject: string;
  value: string;
  evidence: string;
  owner: string;
  status: "已确认" | "待确认";
}

export const employeeRows: SubjectBillRow[] = [
  {
    name: "张伟",
    providers: ["DeepSeek", "Kimi"],
    tokens: "18.6M",
    quota: "6.4M",
    cost: "412.80",
    activity: "22 天",
    note: "智能客服 V2、知识库升级",
  },
  {
    name: "李娜",
    providers: ["智谱", "DeepSeek"],
    tokens: "12.3M",
    quota: "31.2M",
    cost: "286.40",
    activity: "19 天",
    note: "销售助手",
  },
  {
    name: "王强",
    providers: ["DeepSeek"],
    tokens: "9.8M",
    quota: "—",
    cost: "198.60",
    activity: "17 天",
    note: "数据中台重构",
  },
  {
    name: "赵敏",
    providers: ["Kimi", "智谱"],
    tokens: "7.1M",
    quota: "18.9M",
    cost: "164.20",
    activity: "14 天",
    note: "投标材料生成",
  },
  {
    name: "其他 12 人",
    providers: ["DeepSeek", "智谱", "Kimi"],
    tokens: "26.4M",
    quota: "48.6M",
    cost: "738.00",
    activity: "—",
    note: "6 个项目",
  },
];

export const projectRows: SubjectBillRow[] = [
  {
    name: "智能客服 V2",
    providers: ["DeepSeek", "智谱"],
    tokens: "25.8M",
    quota: "36.1M",
    cost: "628.40",
    activity: "8 人",
    note: "已确认价值 ¥100,000",
  },
  {
    name: "销售助手",
    providers: ["智谱", "Kimi"],
    tokens: "17.4M",
    quota: "28.6M",
    cost: "421.20",
    activity: "5 人",
    note: "待业务确认",
  },
  {
    name: "数据中台重构",
    providers: ["DeepSeek"],
    tokens: "14.2M",
    quota: "—",
    cost: "326.60",
    activity: "4 人",
    note: "交付周期缩短 35%",
  },
  {
    name: "投标材料生成",
    providers: ["Kimi"],
    tokens: "8.6M",
    quota: "22.7M",
    cost: "188.80",
    activity: "3 人",
    note: "2 人日 → 3 小时",
  },
  {
    name: "未归属项目",
    providers: ["DeepSeek", "智谱"],
    tokens: "7.8M",
    quota: "17.7M",
    cost: "235.00",
    activity: "4 人",
    note: "需在结账前补充归属",
  },
];

export const initialValueItems: ValueItem[] = [
  {
    id: 1,
    item: "智能客服 V2 按期上线",
    subject: "智能客服 V2",
    value: "¥100,000",
    evidence: "项目验收单、客户回款记录",
    owner: "陈总",
    status: "已确认",
  },
  {
    id: 2,
    item: "知识库更新周期缩短",
    subject: "知识库升级",
    value: "5 天 → 1 天",
    evidence: "7 月迭代记录",
    owner: "张伟",
    status: "已确认",
  },
  {
    id: 3,
    item: "投标材料初稿提效",
    subject: "投标材料生成",
    value: "2 人日 → 3 小时",
    evidence: "工时记录、投标文档",
    owner: "刘总",
    status: "待确认",
  },
];

export const planRows = [
  {
    name: "智谱 GLM Coding Plan",
    owner: "研发一组",
    used: "800M / 800M",
    utilization: 100,
    cost: "500.00",
    status: "提前耗尽",
    detail: "7 月 24 日耗尽，提前 7 天",
  },
  {
    name: "Kimi Coding Plan",
    owner: "产品研发组",
    used: "328M / 800M",
    utilization: 41,
    cost: "300.00",
    status: "未用满",
    detail: "闲置权益折算约 ¥177",
  },
  {
    name: "DeepSeek 团队套餐",
    owner: "算法组",
    used: "500M / 500M",
    utilization: 100,
    cost: "240.00",
    status: "已用满",
    detail: "账期最后 2 天用满",
  },
  {
    name: "Claude Team 席位",
    owner: "市场部",
    used: "0 / 1 席",
    utilization: 0,
    cost: "199.00",
    status: "无人使用",
    detail: "整月无有效调用",
  },
];
