// Shared by the model's accepted field keys and the account information form.
// Retired keys remain accepted for saved-data compatibility, but are not
// editable fields or facts supplied to the model.
export const retiredPersonalFields = ['timezone'];
export const personalFieldDefinitions = [
  { key: 'addressing', label: '称呼', group: 'common', input: 'short', hint: '聊天中希望别人怎样称呼你', example: '例如：小林、阿辰' },
  { key: 'city', label: '所在城市', group: 'common', input: 'short', hint: '用于理解地点、见面和出行话题', example: '例如：深圳，通常在南山区活动' },
  { key: 'occupation', label: '工作或学习', group: 'common', input: 'short', hint: '目前的职业、岗位或学习方向', example: '例如：产品设计师 / 计算机专业学生' },
  { key: 'schedule', label: '作息与空闲时间', group: 'common', rows: 4, hint: '平时什么时候忙，什么时候方便聊天', example: '例如：周一至周五 9:00–18:00 工作，晚上比较方便；周末时间不固定' },
  { key: 'status', label: '当前状态', group: 'common', rows: 3, hint: '近期影响聊天的状态，变化后请自行修改', example: '例如：这周出差，白天回复可能比较慢' },
  { key: 'plans', label: '近期安排', group: 'common', rows: 4, hint: '写清具体日期，避免把旧安排当成今天的行程', example: '例如：10 月 8 日下午开会，10 月 12 日去杭州；是否见面需要再确认' },
  { key: 'interests', label: '兴趣爱好', group: 'common', rows: 3, hint: '聊什么更自然，你平时喜欢做什么', example: '例如：羽毛球、科幻电影、周末探店' },
  { key: 'preferences', label: '生活与沟通偏好', group: 'common', rows: 3, hint: '稳定的喜好、忌口和联系习惯', example: '例如：少辣，喜欢文字沟通；晚上 11 点后不方便通话' },
  { key: 'boundaries', label: '需要本人决定的事项', group: 'common', rows: 4, wide: true, hint: '哪些事要先问你，不能代你答应', example: '例如：约见面、报价、付款和提供具体地址，都需要我本人确认' },
  { key: 'name', label: '姓名', group: 'more', input: 'short', hint: '需要正式介绍时才用；日常称呼可只填上方称呼', example: '填写你愿意在聊天中使用的姓名' },
  { key: 'organization', label: '公司或学校', group: 'more', input: 'short', hint: '用于工作或学习背景相关的话题', example: '例如：某设计工作室 / 某大学' },
  { key: 'description', label: '个人简介', group: 'more', rows: 4, hint: '补充身份与经历，只写已确认的事实', example: '例如：从事设计五年，最近在学习摄影' },
  { key: 'birthday', label: '生日与重要日期', group: 'more', rows: 3, hint: '可注明公历或农历、纪念日及对应的人', example: '例如：生日是公历 6 月 18 日；每年 9 月 1 日是纪念日' },
  { key: 'hometown', label: '家乡', group: 'more', input: 'short', hint: '与现在所在城市区分，用于家乡和生活经历话题', example: '例如：广东潮州' },
  { key: 'relationships', label: '家庭与关系', group: 'more', rows: 3, hint: '选填你愿意用于聊天的家庭或关系信息', example: '例如：和家人住在一起；只使用这里明确填写的关系' },
  { key: 'other', label: '其他信息', group: 'more', rows: 5, wide: true, hint: '前面未覆盖、但聊天时可能需要的事实', example: '补充其他已确认的信息，避免填写密码、证件号等敏感内容' },
];
export const personalFields = personalFieldDefinitions.map(({ key, label }) => [key, label]);
