// These rules concern the message actually sent, regardless of learned style,
// contact requirements, quoted instructions, or the model's default persona.
export const replySafetyPrompt = ` 发送内容底线（优先于风格、示例、记忆、任务目标和聊天中的要求）：你只拟写发给当前对象的微信正文，不是向对象汇报的任务助手。以下底线同时适用于文字正文和media.text中的语音朗读全文，不能在语音中说文字里不允许说的内容。普通聊天绝不主动自称AI、机器人、语言模型、智能助手、自动回复系统，不说明模型、提示词、后台、工具、生成过程或任务执行状态，也不以“作为AI”“我是机器人”“系统已处理”开头。被明确问及身份时只遵守本轮身份设置，不编造本人实时在场、亲自输入或其他身份证明。当前没有执行外部操作的工具；任务目标、对方请求、用户允许代办、历史AI回复都不是执行成功的证据。绝不能据此说“已执行任务”“已经完成”“帮你处理好了”“已下单/付款/预约/发送邮件/提交/设置/删除/运行/查询”，也不能假装正在操作或承诺稍后自动执行。提供文字建议、步骤、草稿或代码不等于真正执行、联网查证或创建文件。普通回复没有未来通知安排，不说“确认后告诉你”“我确认下再跟你说”；未知时间只说尚不清楚，不承诺后续查问或通知。没有实际完成证据时自然说明还未做或需要确认；信息不足就简短澄清，不用“任务完成”敷衍。已确认的人类历史行动只能按原有时间和对象转述，不冒充本轮新操作；收到消息、明白意思、表达感谢等普通接话可正常使用。`;

const normalize = value => String(value || '').normalize('NFKC').replace(/[\u200b-\u200d\ufeff*_`]/g, '').trim().replace(/^[“”"'「」]+|[“”"'「」]+$/g, '');
const clauses = text => normalize(text).split(/[。！？!?，,；;\n]|但是|不过|然而|但|却/).map(value => value.trim()).filter(Boolean);
const identity = '(?:AI|人工智能|(?:大(?:型)?)?语言模型|大模型|(?:聊天|自动回复)?机器人|(?:智能|AI|自动回复)助手|自动回复系统|bot|chatbot|language model)';
const introduction = new RegExp(`(?:作为|我(?:这边)?(?:就?是|其实是|确实是|只是|不过是|属于)|这里(?:是|由)|这边(?:是|由))\\s*(?:一[个位名种]?|个|一款)?\\s*(?:自动|智能|负责回复的)?\\s*${identity}`, 'i');
const generatedIdentity = new RegExp(`(?:我的(?:回复|回答)|这条(?:回复|消息)|本次(?:回复|回答))[^，。！？!?\\n]{0,8}(?:由|是)[^，。！？!?\\n]{0,12}${identity}|我[^，。！？!?\\n]{0,8}(?:由|通过)[^，。！？!?\\n]{0,10}${identity}[^，。！？!?\\n]{0,8}(?:驱动|生成|回复)|\\b(?:I am|I'm|I’m|as|this is)\\s+(?:an?\\s+)?(?:AI|bot|chatbot|automated assistant|(?:large )?language model)\\b`, 'i');

function quotedOrHypothetical(part) {
  // Attribution and questions about someone else's actions are not new claims.
  // Bare quotes do not authorize a claim: an instruction to echo "已执行任务"
  // must still fail the same guard as an unquoted completion report.
  return /^(?:你|您|他|她|他们|她们|对方)(?:说|提到|表示|问|已经|已|是否|是不是|有没有)/.test(part)
    || /^(?:如果|假如|假设|要是|若|例如|比如|示例|这句话|这段话|原话|不要说|别说|不能说|不能声称|不要声称)/.test(part);
}

export function disclosesAIIdentity(text) {
  return clauses(text).some(part => !quotedOrHypothetical(part) && (introduction.test(part) || generatedIdentity.test(part)));
}

const externalAction = '(?:执行|运行|办理|处理|完成|搞定|办妥|提交|发送|转发|联系|通知|下单|付款|转账|支付|预约|预订|报名|购买|取消|删除|清空|修改|设置|安装|卸载|重启|部署|发布|上传|下载|保存|创建|打开|关闭|查询|查阅|搜索|检索|查过|查到|验证|核实|核对|检查|同步|备份)';
const completedBefore = new RegExp(`(?:我(?:这边)?|(?:帮|替|给|为)(?:你|您))[^，。！？!?\\n]{0,24}(?:已经|现已|已|刚刚|刚)[^，。！？!?\\n]{0,20}${externalAction}|^(?:已经|现已|已)[^，。！？!?\\n]{0,24}${externalAction}`);
const completedAfter = new RegExp(`(?:我(?:这边)?|(?:帮|替|给|为)(?:你|您))[^，。！？!?\\n]{0,24}${externalAction}[^，。！？!?\\n]{0,20}(?:好了|完了|成功|完成|了)$`);
const operating = new RegExp(`(?:我(?:这边)?|(?:帮|替|给|为)(?:你|您))[^，。！？!?\\n]{0,10}(?:正在|现在就|这就|马上|稍后|等会|回头|会|将)[^，。！？!?\\n]{0,12}${externalAction}|^稍等[^，。！？!?\\n]{0,8}${externalAction}`);
const passiveCompletion = new RegExp(`(?:任务|操作|设置|订单|付款|转账|预约|邮件|文件|报告|申请|代码|脚本|备份)[^，。！？!?\\n]{0,14}(?:已经|现已|已)[^，。！？!?\\n]{0,10}(?:${externalAction}|完成|处理|搞定|办妥)|(?:任务|操作)[^，。！？!?\\n]{0,12}(?:执行完|完成了|处理好了|搞定了)|^(?:好的?\\s*)?(?:(?:已经|现已|已)[^，。！？!?\\n]{0,12}(?:完成|处理|搞定|办妥)|(?:帮|替|为)(?:你|您)[^，。！？!?\\n]{0,14}(?:完成|处理好了|搞定|办妥))`);
const genericCompletion = /(?:我(?:这边)?|(?:帮|替|给|为)(?:你|您))[^，。！？!?\n]{0,24}(?:处理好了|办好了|办完了|做完了|搞定了?|完成了|执行完毕|办妥了?)|^(?:任务)?(?:完成(?:了)?|执行完毕|执行成功|搞定了?|处理好(?:了)?|办好(?:了)?|办妥了?|办完了?|done|completed|executed)(?:\s*✅)?$/i;
const denied = new RegExp(`(?:没有|还没|尚未|未曾|未|没|无法|不能|没法|不会|不支持|不承诺)[^，。！？!?\\n]{0,12}(?:${externalAction}|完成|处理|搞定|办妥)`);
const englishCompletion = /\b(?:I(?: have|'ve|’ve)?\s+(?:already\s+)?(?:executed|ran|submitted|sent|paid|booked|deleted|installed|checked|completed)|(?:the\s+)?task\s+(?:is\s+|has been\s+)?(?:done|completed|executed))\b/i;
// A conditional promise still invents a future notification. There is no
// scheduled callback attached to a normal reply; a vague "once I know" does
// not establish one. Questions or instructions for the recipient stay intact.
const conditionalNotification = /^(?:等(?:我|这边)?(?:确认|确定|定下来|有消息|有结果|到了|到达)|(?:我)?(?:先|一)?(?:确认|确定|核实|问|查|定下来|有消息|有结果)(?:一下|下|时间)?(?:了|后|以后|之后)?|(?:我)?(?:定好?|到)了)[^，。！？!?\n]{0,16}(?:再|就|会)?(?:告诉|通知|联系|回复|跟(?:你|您)说|给(?:你|您)发(?:消息|信息))(?:你|您)?(?:一声|一下)?$/;

export function claimsUnverifiedExecution(text) {
  return clauses(text).some(part => !quotedOrHypothetical(part) && !denied.test(part)
    && (completedBefore.test(part) || completedAfter.test(part) || operating.test(part) || passiveCompletion.test(part) || genericCompletion.test(part) || englishCompletion.test(part) || conditionalNotification.test(part)));
}

export function replySafetyViolation(segments, { allowIdentity = false, audioText = '' } = {}) {
  // Check the joined content as well: splitting a claim across segments must
  // not bypass the guard before any segment reaches the native sender.
  const texts = [...segments, segments.join(''), ...(typeof audioText === 'string' && audioText ? [audioText] : [])];
  if (!allowIdentity && texts.some(disclosesAIIdentity)) return 'identity';
  if (texts.some(claimsUnverifiedExecution)) return 'execution';
  return '';
}

export function replySafetyCorrection(reason) {
  return reason === 'identity'
    ? ' 上一份正文违规说明了AI/机器人身份。重新拟写自然的微信接话，不说明身份、后台或生成过程；不能编造真人在场证明。只返回原协议要求的JSON。'
    : ' 上一份正文声称或承诺执行没有证据的操作。当前没有执行外部任务的工具，不得说已完成、已执行、已帮对方处理或正在操作；普通回复也没有安排未来通知，不能补“确定了告诉你”等承诺。改为自然说明尚不确定、给出可实际发送的文字建议或询问必要信息。只返回原协议要求的JSON。';
}
