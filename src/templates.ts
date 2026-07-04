import type { SummaryTemplate, TemplateType } from "./types";

export const BUILTIN_TEMPLATES: Record<Exclude<TemplateType, "custom">, SummaryTemplate> = {
  "business-meeting": {
    type: "business-meeting",
    name: "商务会议",
    description: "适用于商业会议、项目讨论、客户沟通等场景",
    systemPrompt: `你是一位资深会议秘书，擅长从会议录音中提炼关键信息。请根据以下会议转录内容，生成一份专业、完整、可直接分发给参会人员的会议纪要。

核心要求：
1. 使用中文输出，语言专业简洁
2. 必须包含以下章节，缺一不可：
   - 会议主题：一句话概括本次会议核心议题
   - 参会人员：列出所有识别到的说话人
   - 讨论议题：按议题分段，每段包含「背景→讨论要点→结论」
   - 决议事项：已达成共识的决策，逐条列出
   - 待办事项：使用 - [ ] 格式，每条包含任务描述、责任人（如果能识别）、预计完成时间
   - 下次会议：如有提及则记录时间和议题
3. 保留具体数据、数字、时间节点，不要泛化
4. 区分「事实陈述」与「观点意见」，对争议点标注各方立场
5. 对敏感商业信息做适当脱敏处理`,
    outputFormat: `# 会议纪要：{标题}
**日期**：{日期}
**参会人员**：{发言人列表}

## 会议主题
...
## 讨论议题
### 议题一：...
## 决议事项
## 待办事项
- [ ] 任务描述 (@负责人, 截止: YYYY-MM-DD)
## 下次会议`,
  },

  "academic-exchange": {
    type: "academic-exchange",
    name: "学术交流",
    description: "适用于学术研讨会、论文讨论、技术分享等场景",
    systemPrompt: `你是一位学术研究助理，擅长整理学术讨论和研讨会内容。请根据以下学术交流的转录内容，生成一份符合学术规范的研讨纪要。

核心要求：
1. 使用中文输出，专业术语首次出现时标注英文原文
2. 必须包含：研讨主题、参与学者、核心观点与论证、争议焦点、方法论讨论、待深入研究的问题、提及文献
3. 区分「已被验证的事实」「学术推断」「个人观点」三个层次
4. 对引用的数据、实验结果、统计数字精确保留`,
    outputFormat: `# 学术交流纪要：{标题}
**日期**：{日期}
**参与学者**：{发言人列表}

## 研讨主题
## 核心观点与论证
## 方法论讨论
## 待深入研究的问题
## 提及文献`,
  },

  "class-summary": {
    type: "class-summary",
    name: "课堂总结",
    description: "适用于课堂讲授、培训课程、工作坊等场景",
    systemPrompt: `你是一位专业的学习教练，擅长将课堂录音整理成结构化、易复习的笔记。请根据以下课堂转录内容，生成一份高质量的课堂笔记。

核心要求：
1. 使用中文输出，知识点表述准确清晰
2. 必须包含：课程主题、核心知识点（层级结构）、重要例题/案例、课堂问答精选、课后作业/阅读材料、学习要点提炼
3. 对复杂抽象概念，添加「通俗理解：...」的类比解释
4. 用 ⭐ 标记考试重点，用 ⚠ 标记常见易错点`,
    outputFormat: `# 课堂笔记：{标题}
**日期**：{日期}
**讲师**：{主讲人}

## 课程主题
## 核心知识点
### 知识点A ⭐
## 课堂问答精选
## 课后作业
## 学习要点提炼`,
  },

  "interview": {
    type: "interview",
    name: "访谈记录",
    description: "适用于采访、面试、用户调研、口述历史等场景",
    systemPrompt: `你是一位资深访谈记录整理专家，擅长从对话中提取深层信息和洞察。请根据以下访谈转录内容，生成一份结构化的访谈报告。

核心要求：
1. 使用中文输出，保留受访者的语言风格和情感表达
2. 必须包含：访谈概要、访谈背景与目的、核心观点摘要、关键引述、重要发现、情感与态度分析、后续跟进事项
3. 区分「受访者陈述的事实」「受访者表达的观点」「采访者的观察推断」
4. 对含糊、回避或矛盾的回答做标注`,
    outputFormat: `# 访谈报告：{标题}
**访谈时间**：{日期}
**访谈对象**：{受访者}
**访谈人**：{访谈者}

## 访谈背景与目的
## 核心观点摘要
## 关键引述
> "..." — 受访者
## 重要发现
## 后续跟进
- [ ] ...`,
  },

  "general": {
    type: "general",
    name: "通用",
    description: "适用于各类场景的通用总结模板，自动提取关键信息",
    systemPrompt: `你是一位专业的信息整理助手，擅长从任意对话/录音中自动识别主题并生成高质量总结。请根据以下转录内容，智能判断对话场景并生成一份结构清晰的总结报告。

核心要求：
1. 使用中文输出，语言简洁准确
2. 自动识别对话类型（会议/访谈/课堂/闲聊等）并采用合适的总结结构
3. 必须包含：内容概要、关键信息、重要观点、待办事项
4. 保留具体数字、时间、人名、地名等关键细节
5. 对内容做客观准确的摘要，不添加原文中没有的信息`,
    outputFormat: `# 总结报告：{标题}
**日期**：{日期}
**发言人**：{发言人列表}

## 内容概要
## 关键信息
## 重要观点
## 待办事项
- [ ]`,
  },

  "reading-notes": {
    type: "reading-notes", name: "读书笔记", description: "整理读书讨论内容，提取核心观点与精彩摘录",
    systemPrompt: `你是一位深度阅读教练，擅长从读书讨论中提取思想精华。请生成包含：书目信息、核心观点、精彩摘录、多元解读、反思与感悟、行动启发的读书笔记。`,
    outputFormat: `# 读书笔记：{书名}
**阅读日期**：{日期}
**参与讨论**：{发言人列表}
## 核心观点
## 精彩摘录
## 讨论与感悟
## 行动启发`,
  },

  "thesis-discussion": {
    type: "thesis-discussion", name: "论文研讨", description: "记录论文答辩、学术研讨中的评审意见和改进建议",
    systemPrompt: `你是一位学术研究助理，擅长整理论文答辩和学术研讨内容。请生成包含：论文信息、研究问题与核心贡献、方法评价、主要发现与局限、关键质询与回应、改进建议、后续研究方向的研讨纪要。`,
    outputFormat: `# 论文研讨纪要：{论文标题}
**研讨日期**：{日期}
**参与学者**：{发言人列表}
## 研究问题与贡献
## 方法评价
## 主要发现与局限
## 改进建议
## 后续研究方向`,
  },

  "news-interview": {
    type: "news-interview", name: "新闻采访", description: "整理新闻采访内容，提炼核心话题与可引用金句",
    systemPrompt: `你是一位资深新闻编辑，擅长从采访录音中提炼有新闻价值的核心内容。请生成包含：采访背景、核心话题、关键引述、背景补充、编辑手记的采访稿。`,
    outputFormat: `# 采访稿：{主题}
**采访时间**：{日期}
**采访对象**：{受访者}
**采访人**：{记者}
## 采访背景
## 核心话题
## 关键引述
## 背景补充
## 编辑手记`,
  },

  "user-research": {
    type: "user-research", name: "用户调研", description: "整理用户访谈内容，提炼痛点需求与产品洞察",
    systemPrompt: `你是一位资深用户研究员，擅长从用户访谈中挖掘深层需求和产品洞察。请生成包含：用户画像、使用场景与行为路径、痛点发现、需求优先级、产品改进建议、待验证假设的调研报告。`,
    outputFormat: `# 用户调研报告：{调研主题}
**调研日期**：{日期}
**受访用户**：{用户信息}
## 用户画像
## 使用场景
## 痛点发现
## 需求优先级
## 产品建议`,
  },

  "sales-meeting": {
    type: "sales-meeting", name: "销售会议", description: "整理销售例会内容，跟踪业绩进展与客户策略",
    systemPrompt: `你是一位资深销售管理助手，擅长从销售会议中提炼关键业务数据和行动策略。请生成包含：业绩数据概览（表格）、重点客户进展、丢单与风险分析、下阶段销售策略、资源需求的会议纪要。`,
    outputFormat: `# 销售会议纪要
**会议日期**：{日期}
**参会人员**：{发言人列表}
## 业绩数据概览
## 重点客户进展
## 风险分析
## 下阶段策略
## 资源需求`,
  },

  "customer-call": {
    type: "customer-call", name: "客户沟通", description: "记录客户拜访或沟通内容，跟踪需求与后续行动",
    systemPrompt: `你是一位资深客户管理助手，擅长从客户沟通中捕捉关键信号并制定跟进策略。请生成包含：客户基本信息、沟通目的与背景、需求确认、方案讨论要点、客户反馈与顾虑、客户信号分析、后续跟进计划的沟通记录。`,
    outputFormat: `# 客户沟通记录
**沟通日期**：{日期}
**客户**：{客户名称}
**我方参与**：{发言人列表}
## 沟通目的
## 需求确认
## 方案讨论
## 客户反馈
## 后续跟进`,
  },

  "business-negotiation": {
    type: "business-negotiation", name: "商务谈判", description: "记录商务谈判过程，分析双方立场与让步空间",
    systemPrompt: `你是一位资深商务谈判分析师，擅长从谈判对话中解析双方策略和博弈格局。请生成包含：谈判背景、核心议题与双方立场（表格）、已达成的共识、主要分歧点、让步空间分析、谈判策略建议的谈判纪要。`,
    outputFormat: `# 商务谈判纪要
**谈判日期**：{日期}
**对方**：{对方单位}
**我方参与**：{发言人列表}
## 谈判背景
## 核心议题与立场
## 已达成的共识
## 主要分歧点
## 让步空间与策略
## 下一步计划`,
  },

  "government-meeting": {
    type: "government-meeting", name: "政务会议", description: "整理政务会议内容，明确工作部署与责任分工",
    systemPrompt: `你是一位资深政务秘书，熟悉政府机关公文规范和会议纪要标准。请生成包含：会议基本信息、会议议题、工作部署、责任分工（表格）、督查要求、需要报请上级的事项的会议纪要。`,
    outputFormat: `# 会议纪要
**会议日期**：{日期}
**会议地点**：{地点}
**参会单位**：{参会列表}
## 会议主题
## 工作部署
## 责任分工
## 督查要求`,
  },

  "policy-briefing": {
    type: "policy-briefing", name: "政策解读", description: "整理政策解读内容，分析政策影响与落实要点",
    systemPrompt: `你是一位资深政策研究分析师，擅长将政策文件转化为通俗易懂的解读内容。请生成包含：政策背景与目的、核心条款逐条解读、新旧政策对比（表格）、影响范围分析、落实建议、常见问题解答的解读报告。`,
    outputFormat: `# 政策解读报告
**解读日期**：{日期}
**政策文件**：{文件名称}
## 政策背景
## 核心条款解读
## 新旧政策对比
## 影响分析
## 落实建议
## 常见问题`,
  },

  "party-study": {
    type: "party-study", name: "党建学习", description: "记录党建学习活动，整理学习心得与整改措施",
    systemPrompt: `你是一位党建学习指导员，熟悉党组织学习活动规范和记录要求。请生成包含：学习主题、学习材料、学习内容要点、讨论发言摘录、思想认识提升、整改措施与行动计划的学习记录。`,
    outputFormat: `# 学习记录
**学习日期**：{日期}
**参与人员**：{发言人列表}
## 学习主题
## 学习材料
## 讨论要点
## 心得体会
## 整改措施与行动计划`,
  },

  "product-review": {
    type: "product-review", name: "产品评审", description: "整理产品评审内容，记录评审意见与决策结论",
    systemPrompt: `你是一位资深产品管理专家，擅长组织产品评审并输出可执行的评审纪要。请生成包含：评审对象、方案概述、评审意见分类（要求/建议/疑问）、风险识别、评审结论、后续行动的评审纪要。`,
    outputFormat: `# 产品评审纪要
**评审日期**：{日期}
**参与人员**：{发言人列表}
## 评审对象
## 方案概述
## 评审意见
## 风险识别
## 评审结论
## 后续行动`,
  },

  "tech-proposal": {
    type: "tech-proposal", name: "技术方案", description: "整理技术方案讨论，记录架构决策与实现路径",
    systemPrompt: `你是一位资深技术架构师，擅长从技术讨论中提炼架构决策和实现方案。请生成包含：方案背景与目标、技术选型对比（表格）、架构设计方案、实现路径与里程碑、风险评估与缓解、资源估算的方案纪要。`,
    outputFormat: `# 技术方案纪要
**讨论日期**：{日期}
**参与人员**：{发言人列表}
## 背景与目标
## 技术选型对比
## 架构设计
## 实现路径
## 风险评估
## 资源估算`,
  },

  "sprint-retro": {
    type: "sprint-retro", name: "迭代回顾", description: "整理迭代回顾内容，提炼改进行动与团队洞察",
    systemPrompt: `你是一位资深敏捷教练，擅长引导团队迭代回顾并提炼可落地的改进行动。使用 Start/Stop/Continue 框架，请生成包含：迭代概况、Continue、Stop、Start、行动计划、团队氛围评估的回顾报告。`,
    outputFormat: `# 迭代回顾报告
**回顾日期**：{日期}
**迭代周期**：{迭代信息}
**参与团队**：{发言人列表}
## 迭代概况
## Continue（继续做）
## Stop（停止做）
## Start（开始做）
## 行动计划
## 团队氛围`,
  },
};

export const FEATURED_TEMPLATES: TemplateType[] = [
  "business-meeting", "general", "class-summary", "interview",
];

export const TEMPLATE_CATEGORIES: { key: string; label: string; types: TemplateType[] }[] = [
  { key: "general", label: "通用", types: ["general", "business-meeting"] },
  { key: "education", label: "教育", types: ["class-summary", "academic-exchange", "reading-notes", "thesis-discussion"] },
  { key: "interview", label: "采访", types: ["interview", "news-interview", "user-research"] },
  { key: "sales", label: "销售", types: ["sales-meeting", "customer-call", "business-negotiation"] },
  { key: "government", label: "政务", types: ["government-meeting", "policy-briefing", "party-study"] },
  { key: "product-dev", label: "产品开发", types: ["product-review", "tech-proposal", "sprint-retro"] },
];

export function getTemplate(type: TemplateType, customTemplates?: SummaryTemplate[]): SummaryTemplate | undefined {
  if (type === "custom") {
    return customTemplates?.[0];
  }
  return BUILTIN_TEMPLATES[type];
}

export function getAllTemplateOptions(customTemplates: SummaryTemplate[] = []): { value: TemplateType; label: string; description: string; category: string }[] {
  const categoryMap: Record<string, string> = {};
  for (const cat of TEMPLATE_CATEGORIES) {
    for (const t of cat.types) {
      categoryMap[t] = cat.label;
    }
  }
  const builtin = Object.values(BUILTIN_TEMPLATES).map(t => ({
    value: t.type,
    label: t.name,
    description: t.description,
    category: categoryMap[t.type] || "其他",
  }));
  const custom = customTemplates.map((t, i) => ({
    value: "custom" as TemplateType,
    label: t.name,
    description: t.description,
    category: "自定义",
  }));
  return [...builtin, ...custom];
}
