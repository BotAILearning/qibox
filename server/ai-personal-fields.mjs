// Shared by the model's accepted field keys and the account information form.
// Retired keys remain accepted for saved-data compatibility, but are not
// editable fields or facts supplied to the model.
export const retiredPersonalFields = ['timezone', 'boundaries'];
export const personalFieldAliases = { name: 'addressing', organization: 'occupation', plans: 'status', hometown: 'experiences', description: 'experiences' };
export const normalizePersonalField = key => personalFieldAliases[key] || key;
// Keep migrated rows separate so their original sharing and provenance survive.
export const personalFieldDefinitions = [
    ['addressing', '称呼', 'common', '姓名、昵称、希望别人怎样称呼自己'],
    ['city', '居住地', 'common', '常住城市及生活区域'],
    ['occupation', '职业', 'common', '工作内容、行业、单位；在读用户填写学校和专业'],
    ['schedule', '作息', 'common', '忙闲时间、休息习惯、方便联系的时间'],
    ['interests', '爱好', 'common', '兴趣、活动、关注的话题'],
    ['preferences', '生活习惯', 'common', '饮食、忌口、出行等稳定偏好'],
    ['status', '近况', 'common', '近期状态和已确定安排，请注明具体日期'],
    ['birthday', '生日', 'more', '注明公历或农历，年份选填'],
    ['relationships', '家庭', 'more', '愿意透露的婚恋、家人、孩子、宠物情况'],
    ['health', '健康', 'more', '愿意用于聊天的身体情况、运动习惯和活动限制'],
    ['experiences', '经历', 'more', '家乡、成长、求学、工作、居住和旅行经历'],
    ['other', '补充信息', 'more', '其他本人事实及重要纪念日；不要填写密码、验证码或密钥'],
  ].map(([key, label, group, hint]) => ({ key, label, group, hint, example: hint, rows: 3 }));
export const personalFields = personalFieldDefinitions.map(({ key, label }) => [key, label]);
