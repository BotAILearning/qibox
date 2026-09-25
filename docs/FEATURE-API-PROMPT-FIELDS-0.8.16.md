# 栖盒 AI 功能、接口、提示词与字段清单

更新时间：2026-09-25

## 1. 基线与结论

- 源码产品版本：以 `package.json` 当前值为准；本次行为变更验收和新包信息在完成打包后补录。
- 更新时间：2026-09-25。
- 本文描述工作区当前实现与本轮确认规则；未完成真机验收/打包前，不代表设备已升级或已发布。

## 2. 功能清单

### 2.1 栖盒基础能力

| 功能 | 说明 | 主要实现 |
|---|---|---|
| 微信安装/导入 | 下载安装或导入匹配架构的官方 Linux 微信 deb；当前应用市场仅发布 `wechat` | `server/packages.mjs`, `server/catalog.mjs` |
| 多实例 | 添加、重命名、启动、停止、显示、登录、删除、保留数据后恢复 | `server/instances.mjs` |
| 启动设置 | 手动启动、持续备份、闲时备份；按北京时间调度 | `server/scheduler.mjs` |
| 远程桌面 | noVNC/RFB 桌面、键盘鼠标输入、前台接管和手动操作保护 | `server/desktop*.mjs`, `web/desktop*.mjs` |
| 剪贴板 | 文本、浏览器提供的图片和文件粘贴；服务端校验类型、大小和实例归属 | `server/clipboard.mjs`, `web/clipboard-files.mjs` |
| 文件选择/传输 | 微信原有文件入口接入本机文件选择；支持上传、取消、NAS 文件夹授权和导出 | `server/file-chooser.mjs`, `server/file-portal.py` |
| 平台适配 | fnOS 与 UGOS 使用不同网关/桌面传输路径；FPK/UPK 使用对应架构运行组件 | `server/platform.mjs`, `docs/MULTIPLATFORM.md` |

### 2.2 AI 辅助能力

| 功能 | 当前行为 | 关键数据 |
|---|---|---|
| 模型设置 | 预设模型、自定义地址、OpenAI Chat Completions/Anthropic Messages、模型列表发现、连通性测试、多模型分配 | `provider`, `models`, `assignments` |
| 自动回复 | 个人联系人按新消息轮询；可选全量/选定对象、智能判断、风格更新、多轮分段、延迟追问、人工接管等待 | `settings`, `profiles`, `replyStrategy` |
| 群聊回复 | 已验证的 `@我`、`@所有人`、实时触发；实时触发支持模型 `wait 1–30 秒` | `groupOptions`, `groupState` |
| 风格学习 | 单人、批量最多 10 人、粘贴聊天、仅学习风格或风格+记忆；默认风格可汇总并应用 | `style`, `learnedDefaultStyle` |
| 个人信息 Wiki | 从聊天提取事实；支持替换、合并、手动编辑、冲突候选、20 次历史回滚 | `memory.entries` |
| 主动聊天 | 新版任务支持联系人、目标、要求、单条/分段、立即/单次/每日/工作日/每周/自定义周期 | `proactiveTasks`, `proactiveRecords` |
| 聊天分析 | 单次分析一位联系人，可选日期范围；生成带统计和实际覆盖范围的分析报告并保存历史 | `analysis`, `analysisReports` |
| 运行记录 | 自动回复、主动聊天、未回复判断、错误记录、发送正文、消息定位、删除记录 | `activity`, `events`, `skipRecords` |
| 发送安全 | 发送前后核对账号、对象、聊天版本和数据库回执；不确定结果不自动重发 | `delivery`, `proactiveDelivery`, `sentMessages` |

## 3. 接口总览

### 3.1 通用接口

前端通过 `web/app.mjs` 统一请求。fnOS 前缀为 `/app/qibox`，UGOS 前缀为 `/api/qibox`；以下路径均为前缀后的路径。

| 方法 | 路径 | 请求字段 | 返回/用途 |
|---|---|---|---|
| GET | `/api/session` | 无 | `user`, `product`, `host`, `capabilities`, `csrf`, `consent` |
| GET | `/api/state` | 无 | 应用市场、已安装库、实例列表、保留数据 |
| POST | `/api/consent` | `accepted:boolean` | 保存隐私/使用确认 |
| POST | `/api/apps/:appId/install/upload` | 二进制 deb；`Content-Length` | 上传官方微信安装包 |
| POST | `/api/apps/:appId/install/download` | `allowUnverified:boolean` | 下载官方包，通常返回异步任务 |
| POST | `/api/apps/:appId/install/nas` | `path` | 从 NAS 文件选择器导入 |
| POST | `/api/apps/:appId/install/uninstall` | `deleteData:boolean`, 删除时 `confirmName="确认删除微信"` | 卸载程序，可选择保留/清除当前用户数据 |
| POST | `/api/instances` | `name`, `appId` | 创建实例 |
| POST | `/api/instances/:id/start` | 无 | 启动实例 |
| POST | `/api/instances/:id/stop` | 无 | 停止实例 |
| POST | `/api/instances/:id/rename` | `name` | 重命名 |
| POST | `/api/instances/:id/settings` | 启动/备份计划字段 | 保存实例启动设置 |
| POST | `/api/instances/:id/delete` | 删除/保留数据字段 | 删除实例 |
| POST | `/api/instances/:id/restore` | `name` | 恢复保留数据 |
| POST | `/api/instances/:id/login` | 无 | 打开微信登录页 |
| POST | `/api/instances/:id/recheck` | 无 | 重新核对登录状态 |
| POST | `/api/instances/:id/show` | 无 | 显示并前置微信窗口 |
| POST | `/api/instances/:id/desktop` | 无 | 返回桌面 ticket、密码和桌面路径 |
| POST | `/api/instances/:id/clipboard` | `text` 或 `files` | 写入实例剪贴板 |
| POST | `/api/instances/:id/files` | `action`、`client` 及对应文件字段 | 文件请求状态、认领、上传、导出、取消、完成 |

### 3.2 AI 状态接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/instances/:instanceId/ai` | 返回完整 AI `publicState()`；实例必须是 `wechat` |
| GET | `/api/instances/:instanceId/ai/reports/:reportId` | 返回一份完整聊天分析报告 |
| POST | `/api/instances/:instanceId/ai` | JSON `{action, id?, value?, scope?, ids?, mode?, filters?, command?}`；所有写操作均需 CSRF |

### 3.3 AI action 对照表

| action | 前端请求核心字段 | 后端用途 |
|---|---|---|
| `configure` | `value`, `scope` | 保存单模型配置 |
| `test` | `scope` | 测试当前已保存模型 |
| `models` | `value`, `scope` | 拉取模型列表，不保存配置 |
| `model-test` | `value` | 测试某个模型草稿/已保存模型 |
| `models-save` | `value.models`, `value.assignments` | 保存多模型及功能分配 |
| `verify-provider` | `value`, `scope` | 校验/确认模型配置 |
| `reveal-key` | `modelId` 或 `scope` | 当前用户显式查看已保存 API Key；普通状态不返回明文 |
| `scan` | 无 | 扫描当前微信联系人/群聊 |
| `calendar` | `value.contacts`，1–10 个 | 获取可用于日期筛选的聊天日期 |
| `learn` | 见学习字段 | 学习风格、记忆或默认风格 |
| `analyze` | 见分析字段 | 生成单联系人聊天分析报告 |
| `settings` | 见设置字段 | 保存 AI 总开关、回复/主动开关和等待参数 |
| `strategy` | `id?`, `mode?`, `value` | 保存主动策略或回复策略 |
| `reply-profile` | `value.contact`, `style`, `strategy`, 可选开关字段 | 保存对象风格、回复策略和启用状态 |
| `reply-options` | `value.contact`, `enabled`, `multiTurn`, `judgeReply`, `takeover?` | 保存个人联系人回复开关 |
| `group-options` | `value.contact`, `atMe`, `atAll`, `realtime`, 首次实时需 `confirmRealtime:true` | 保存群聊触发开关 |
| `profile` | `id`, `value.style`, `paused`, `delete?` | 手动编辑风格、暂停/恢复/删除对象档案 |
| `targets` | `ids`, `mode` | 设置回复或主动聊天对象 |
| `prepare-targets` | `value.contacts` | 预创建主动聊天对象档案 |
| `apply-reply-limit` | `value.kind`, `value.maxRounds` | 将 1–2000 的连续回复上限批量应用到人/群 |
| `save-default-style` | `value.summary` | 保存默认风格的编辑文本 |
| `clear-default-style` | 无 | 清除默认风格 |
| `apply-default-style` | 无 | 将默认风格应用到对象 |
| `cancel-default-style` | 无 | 撤销最近一次默认风格学习 |
| `commit-default-style` | `value.summary` | 保存并应用默认风格 |
| `memory` | `id`, `value.entries` 或 `restoreId` | 编辑对象 Wiki 记忆/恢复历史 |
| `contact-memory` | `value.contact`, `value.entries` | 按联系人编辑 Wiki |
| `memory-apply` | `id` | 用待确认学习结果替换当前记忆 |
| `memory-merge` | `id` | 与当前记忆合并，结果仍需确认 |
| `memory-discard` | `id` | 丢弃待确认记忆 |
| `schedule` | `value` | 兼容旧版主动计划；新版任务使用 `proactive-task` |
| `queue` | `command` 或 `{command,id,value}` | 兼容旧版主动队列 |
| `proactive-task` | 见主动任务字段 | 新版主动任务增删改、暂停、恢复、结束、重试 |
| `proactive-records` | `value.taskId?`, `limit`, `before?` | 主动任务执行记录分页 |
| `review` | `id`, `value.resolve`, `value.revision`, `value.openChat?` | 查看/核对不确定发送结果 |
| `open-conversation` | `id`, 可选 `value.fast` | 打开对象聊天 |
| `locate-conversation` | `id`, `value.messageId` | 打开并定位具体消息 |
| `activity` | 无 | 返回运行记录摘要 |
| `activity-records` | `ids`, `filters` | 获取自动回复正文和执行记录 |
| `delete-activity-record` | `value.source`, `value.id` | 删除一条记录，不删除微信原消息 |
| `mark-reply-needed` | `value.profileId`, `eventId`, `messageId` | 将历史跳过事件标为需要回复 |
| `activity-summary` | `id`, `value.range` | 按接管/天/周/月汇总对象活动 |
| `clear-activity-errors` | 无 | 清空当前账号错误记录 |
| `error-records` | `value.limit`, `value.before?` | 错误记录分页 |
| `analysis-use-chat` | 无 | 分析模型改用聊天共享模型 |
| `analysis-report-delete` | `id` 或 `value.id` | 删除分析报告历史 |
| `contact-remark` | `id`, `value.remark` | 写入并核验微信备注；能力不存在时拒绝 |
| `cancel` | 无 | 取消学习/分析等当前操作并暂停旧队列 |

## 4. 前后端状态字段

### 4.1 `publicState()` 顶层字段

`capabilities`, `settings`, `strategy`, `replyStrategy`, `replyRoundLimits`, `profiles`, `targets`, `replyTargets`, `proactiveTargets`, `proactiveTasks`, `proactiveRecords`, `proactiveRecordsPage`, `proactiveRequirements`, `account`, `activity`, `activityHistory`, `provider`, `models`, `assignments`, `analysis`, `queue`, `schedules`, `events`, `skipRecords`, `contacts`, `available`, `notice`, `waiting`, `operation`, `live`, `recentErrors`, `errorsPage`, `learnedDefaultStyle`, `defaultStyleUndoable`, `requirements`, `schema`。

### 4.2 模型字段

| 字段 | 说明/约束 |
|---|---|
| `baseUrl` | HTTP/HTTPS 模型服务地址；公网 HTTP 被拒绝；禁止 URL 用户名、密码、查询和云元数据地址 |
| `protocol` | `openai` 或 `anthropic` |
| `model` | 对话模型名，最多 160 字符 |
| `apiKey` | 仅写入时提交；加密保存；普通状态只返回 `hasKey` |
| `timeout` | 10–120 秒 |
| `consent` | 是否同意将选定聊天内容发送到模型服务 |
| `id`, `label` | 多模型列表标识和显示名 |
| `assignments.chat` | 自动回复/主动聊天模型 |
| `assignments.learningAnalysis` | 学习/聊天分析模型 |
| `tested` | 当前配置是否已测试通过 |

### 4.3 AI 设置字段

`enabled` 总开关；`reply` 自动回复开关；`proactive` 主动聊天开关；`replyScope`=`all|selected`；`judgeReply` 智能判断是否回复；`updateStyle` 每轮更新风格；`multiTurn` 多轮/分段；`acknowledgeAI` 是否如实承认 AI 身份；`replyDelay` 固定为 20 秒；`segmentDelayMin/Max` 固定为 15–60 秒随机分段间隔；`followUpDelayMin/Max` 固定为 45–120 秒随机追问等待；`takeover={enabled,minutes}` 人工回复后的自动接续等待，分钟 1–10080。上述时序数值由产品固定，用户不再设置。注意：这些字段在后端存在，但截至当前版本，相关前端表单没有接入实际页面；“系统设置”页面不等于“沟通设置”页面。

### 4.4 风格字段

模型学习输出必须且只能包含五个字符串字段：

`language` 语言习惯、`rhythm` 节奏、`interaction` 互动方式、`emotion` 情感表达、`role` 沟通角色。

保存时会合成为可编辑的 `style.summary`；兼容旧版结构化风格：`category`, `roles`, `formality`, `warmth`, `length`, `directness`, `emoji`, `humor`, `avoid`, `customTone`, `customAvoid`。其中 `category` 使用 `intimate/family/friends/work/business/education/service/community/new/custom/unknown`；`roles` 最多 4 个；`avoid` 最多 10 个。

### 4.5 策略字段

通用主动策略：`purpose` 目标、`content` 内容要求、`persona` 人设、`replyGoal` 回复目的、`facts` 已知信息、`boundaries` 限制、`sendMode`=`single|segments`、`styleSource`=`manual|learned|paste`、`styleProfileId` 已学习风格 ID、`maxRounds` 1–2000。

回复策略只持久化：`replyGoal`, `facts`, `boundaries`, `maxRounds`；对象专属策略优先于账号级策略。

### 4.6 联系人档案与消息字段

联系人：`id`, `label`, `nickname?`, `kind`=`person|group`, `lastChatAt`, `contactOrder`。

档案：`id`, `account`, `contact`, `label`, `kind`, `style`, `styleId`, `styleSource`, `replyStrategy`, `strategy`, `replyOptions`, `groupOptions`, `paused`, `pauseReason`, `rounds`, `learnedAt`, `replyConfiguredAt`, `memory`, `memoryHistory`, `pendingMemory`, `memoryMerge`, `delivery`, `proactiveDelivery`, `sentMessages`。

消息：`id`, `direction`=`self|other|system`, `text`, `timestamp` Unix 秒、`type`=`text|voice|image...`、`sender?`, `mentions?`, `aiGenerated?`, `transcriptionSource?`, `unresolved?`。AI 只把真实已发送的 `aiGenerated` 消息用于衔接和去重，不将其作为风格或个人事实样本。

### 4.7 Wiki 记忆字段

`memory.entries[]` 每项表示一条事实：`id`, `field`, `text`, `degree?`, `calendar?`, `from?`, `to?`, `recordedAt?`, `manual?`。

`field` 可为 `name`, `phone`, `birthday`, `date`, `school`, `household`, `residence`, `workplace`, `employer`, `shipping`, `other`；生日/日期的 `calendar` 为 `solar|lunar`；学校可填 `degree`；居住、工作、单位、收货地址可填 Unix 毫秒时间范围。最多 300 条，总摘要最多 12000 字符；历史最多保留 20 次。

### 4.8 聊天分析字段

请求：`contacts` 必须恰好 1 人；`request` 分析角度，最多 4000 字符；`mode`=`auto|truncate`；`from`, `to` 日期范围。

报告：`id`, `contact`, `label`, `status`=`complete|empty|error`, `report`, `requestedRange`, `actualRange`, `sourceRange`, `rangeCount`, `readableCount`, `analyzedCount`, `analyzedChars`, `totalChars`, `omittedMessages`, `partialMessages`, `skipped`, `truncated`, `truncatedReasons`, `metrics`, `createdAt`, `historyId`。

`metrics` 包含 `total`, `self`, `other`, `unknown`, `activeDays`, `hours={morning,afternoon,evening,night}`。分析输入最多 150000 个 Unicode 字符，超出时从最新消息向前保留并明确 `truncated`。

### 4.9 新版主动任务字段

创建/编辑请求：`command`=`create|edit|pause|resume|end|retry|delete`；`id?`; `revision?`; `requestId?`; `name`；`taskType`=`greeting|relationship|work|invitation|holiday|custom`；`sendMode`=`single|segments`；`goal`；`requirements`；`contacts`（最多 200 个个人联系人）；`schedule`。

`schedule`：即时执行为 `cycle=once`；重复任务支持 `daily`, `weekdays`, `weekly`, `custom`，`mode=fixed|random`，北京时间 `timezone=Asia/Shanghai`，固定时间 `time` 或随机窗口 `start/end`，每周 `weekdays`（0 为周日），自定义周期 `intervalDays` 1–365。

任务状态：`running`, `paused`, `failed`, `ended`；执行项状态：`pending`, `generating`, `sending`, `sent`, `skipped`, `failed`, `uncertain`, `reviewed`, `cancelled`。失败最多自动重试 3 次；`uncertain` 永不自动重发。

## 5. 提示词清单

### 5.1 学习类

| 提示词 | 输入重点 | 只允许的输出 |
|---|---|---|
| `learningPrompt` | `material`, `styleOwner`, `contact`, `kind` | `{"style":{"language","rhythm","interaction","emotion","role"}}` |
| `learningPromptFor('other')` | 同上，但学习对方口吻 | 同上，不能把本人风格当成对方风格 |
| `batchLearningPrompt` | `conversations[]`，每项有 `contact` 和独立聊天 | `profiles[]`，长度必须和输入完全一致；每项只有 `contact`、`style` |
| `learningWithMemoryPrompt` | `material`, `coverage`, `previousMemory` | `style` 五层 + `memory.entries[]` |
| `batchLearningWithMemoryPrompt` | 多联系人独立 `material` 和 `memoryCoverage` | 每项 `contact`、`style`、`memory` |
| `defaultLearningSummaryPrompt` | 多个已学习 `profiles` | 跨联系人通用 `style` 五层，不推断关系或事实 |

学习原则：只学习指定视角；不混淆联系人；不把昵称、关系分类、对方称呼或 AI 代发内容当作用户称呼习惯；样本不足写“样本不足”；只返回 JSON，不返回解释。

### 5.2 自动回复/主动聊天类

自动回复最终组合：`generationPrompt` + `chatMemoryPrompt` + 身份规则 + `conversationPrompt` + `addressingPrompt` + 当前策略/风格 + 必要时的 `groupPrompt` + `generationProtocol()`。

| 提示词 | 核心约束 |
|---|---|
| `generationPrompt` | 只能使用聊天、`strategy.facts` 和风格要求中的事实；不编造经历、日程、价格、天气、健康或承诺；`mode=reply` 回应最新来信，`mode=proactive` 围绕目标发起 |
| `conversationPrompt` | 消息按旧到新；`latestIncomingId`, `lastSelfId`, `incomingSinceLastSelf`, `pendingIncomingIds` 定位本轮；语音未转写则忽略，已由微信转写则按文字处理 |
| `addressingPrompt` | 默认不加称呼；只能依据当前对象的明确称呼证据；引用风格只能借鉴语气，不能带入姓名、关系和事实 |
| `proactivePrompt` | 目标和内容是意图，不是已发生事实；已确认安排按事实处理；不重复已发内容，不自行承诺媒体、电话、付款或会议 |
| `groupPrompt(trigger)` | 群聊模型动作仅 `send|skip`；模型不控制等待时间；实时消息60秒合并、不同回复轮至少间隔30秒等由系统执行；仅@他人不参与 |
| `generationProtocol()` | 普通动作仅 `send|skip`；个人联系人明确要求停止时独立返回 `{"stop":true}`；禁止模型wait；发送时 `text` 或 `segments` 二选一，最多3段 |
| `identityPrompt()` | `acknowledgeAI=true` 时仅被明确问到才承认 AI；否则以用户本人身份回答，不主动强调身份，不编造经历 |

自动回复 JSON 示例结构：

```json
{"action":"send","text":"非空文字","followUp":false}
```

多轮时可改为：

```json
{"action":"send","segments":["第一段","第二段"],"followUp":false}
```

跳过时只返回 `{"action":"skip"}`；个人联系人明确要求停止时只返回 `{"stop":true}`，不带 `action`。

### 5.3 记忆类

| 提示词 | 输出 |
|---|---|
| `memoryPrompt` | 增量输出 `memory.entries[]`；保留未涉及旧条目；区分本人/对方、提议/确认/完成；不得保存密码、密钥、推测、准备发送内容 |
| `memoryLearningPrompt` | 仅根据本次 `material` 生成待确认记忆；没有事实必须返回空 `entries` |
| `memoryMergePrompt` | 保留旧条目，按字段/日期历法/学历/时间范围判断同一事实；incoming 冲突优先，但不删除未涉及旧事实 |
| `chatMemoryPrompt` | 回复时可附带 `memoryUpdates[]`，每条必须有本轮已发生消息的 `evidence[]`；手动记忆不可覆盖 |

记忆提取的七个检查维度：人物卡、时间线、金句词典、共同记忆、情绪默契、重要日期、未来清单。不要求每类都有结果。

### 5.4 聊天分析类

`server/ai-analysis.mjs` 内置分析提示词：输入 `messages` 为 `[发言方, Unix秒, 文字]`，发言方 `s/o/?`；只使用程序给出的 `metrics` 和 `actualRange`；范围截断时明确说明实际覆盖；默认输出 4–6 个短章节、每章标题+正文、全文约 900 字以内；最终只能返回 `{"report":"报告正文"}`。

### 5.5 模型连接测试类

连通性测试提示词为：`连接测试。只返回 JSON 对象 {"ok":true}。`。只有模型返回合法 JSON 且 `ok=true` 才标记 `tested=true`。

## 6. 需要特别区分的实现边界

1. 当前源码、未提交改动、本地 FPK、应用中心安装态、NAS 真机行为是四个不同证据层级。
2. AI 读取聊天使用本地 `DataChatBridge → wechat-data.py → wechat-sqlite.py`；发送仍走微信原生桌面身份、草稿和数据库回执校验，不能把读取接口称为“直接接口发送”。
3. 聊天正文、模型 API Key 和发送正文按不同安全边界处理：Key/正文加密保存或仅在内存使用，普通 `publicState()` 不返回 Key 明文。
4. 群聊的模型 `pause/stop/handoff/transfer` 旧动作会归一为当前轮 `skip`，不会暂停整个群聊或转交本人。
5. `uncertain` 禁止自动重发；主动聊天不等待人工核验，向自动回复交棒。唯一匹配当前聊天正文/方向/时间时按真实消息处理；无法确定时以 `assumedPresent=true`、`deliveryConfidence=uncertain` 作为当前自动回复上下文，但不进入学习和记忆。
6. 新版主动任务会把旧队列/旧定时任务迁移为暂停状态，必须人工核对联系人、目标和执行周期后才能继续。

## 7. 源码索引

- 总路由与 action 分发：`server/index.mjs`
- AI 状态、设置、学习、回复、分析、记录：`server/ai-service.mjs`
- 字段校验：`server/ai-schema.mjs`
- 模型配置与模型调用：`server/ai-provider.mjs`
- 风格/回复/主动聊天提示词：`server/ai-prompts.mjs`
- Wiki 记忆提示词和合并逻辑：`server/ai-wiki.mjs`
- 聊天分析提示词和报告字段：`server/ai-analysis.mjs`
- 群聊触发与等待协议：`server/ai-group.mjs`
- 新版主动任务与执行记录：`server/ai-proactive.mjs`, `server/ai-proactive-schedule.mjs`
- AI 前端工作台：`web/ai-assistant.mjs` 及 `web/ai-*-view.mjs`

## 8. 私聊自动回复详细行为

### 8.1 启动前提

| 条件 | 必须满足的状态 | 不满足时 |
|---|---|---|
| AI 总开关 | `settings.enabled=true` | 不轮询、不生成 |
| 自动回复开关 | `settings.reply=true` | 只保留主动聊天，不处理普通来信 |
| 联系人范围 | `replyScope=all`，或联系人 `replyOptions.enabled=true` | 不选中的联系人不处理 |
| 模型 | 已配置、同意使用聊天内容、测试通过 | 等待模型配置，不发送 |
| 微信 | 实例运行、当前账号已登录、联系人检测可用 | 等待微信就绪 |
| 联系人档案 | 当前账号、当前联系人仍存在、风格/档案有效 | 跳过该联系人并记录错误 |
| 人工接管 | 不在人工等待窗口 | 窗口内不生成、不发送 |
| 联系人暂停 | `profile.paused=false` | 暂停期间不处理；新消息是否恢复取决于暂停原因 |

### 8.2 私聊输入消息字段

| 字段 | 限制 | 作用 |
|---|---|---|
| `id` | 必须唯一、不可为空 | 稳定识别消息，避免重复回复 |
| `direction` | `self`、`other`、`system` | 区分本人、对方和系统消息 |
| `text` | 必须为字符串；普通读取单条最多约 20000 字符 | 模型主要输入 |
| `timestamp` | 非负 Unix 秒整数 | 判断新旧消息、时间语境和接管窗口 |
| `type` | 可选：`voice`、`image` | 媒体能力分流 |
| `sender` | 群聊必须存在 | 标识实际发言成员 |
| `mentions` | 群聊必须包含 `verified/self/all/others` 五个布尔字段 | 判断是否 @我、@所有人或 @他人 |
| `aiGenerated` | 由服务端标记 | 可以用于衔接和去重，但不能作为风格/事实样本 |

### 8.3 私聊处理情况

| 情况 | 系统行为 | 模型允许的结果 |
|---|---|---|
| 对方发送一条普通文字 | 等待合并窗口结束后读取最新上下文 | `send` 或 `skip` |
| 对方连续发送多条 | 固定等待 `replyDelay=20` 秒合并为一次请求；前端不提供时序设置 | 针对合并后的本轮内容回复一次 |
| `judgeReply=true` | 模型自行判断是否值得回复 | `send` 或 `skip` |
| `judgeReply=false` | 普通来信原则上必须回复 | 模型返回 `skip` 时最多重试；仍 skip 则系统记录跳过，不会卡住后续新消息 |
| 对方明确提问 | 强制要求针对问题生成文字回复 | 不允许用 `skip` 逃避明确问题 |
| 对方明确要求停止联系 | 无论 `judgeReply` 开关如何，当前轮不发送并写入 `stopUntil=now+5分钟`；不永久暂停联系人 | 仅返回 `{"stop":true}`；窗口到期后新消息可恢复处理 |
| 对方只是问“你是不是 AI” | 按 `acknowledgeAI` 规则回答 | 不视为停止联系 |
| 对方发送未转写语音 | 忽略该语音，不回复“无法识别” | 如果本轮只有此类语音，`skip` |
| 微信已转写语音 | 使用 `transcriptionSource=wechat` 的文字 | 按普通文字处理 |
| 只有图片且图片无法读取 | 不猜测图片内容 | `skip` |
| 文字中提到无法读取的图片 | 继续处理可读文字，可说明无法查看图片 | 文字回复，不编造图片内容 |
| 对方要求发文件、打电话、发语音/视频 | 只能提供文字替代或说明限制 | 不得声称已经执行 |
| 模型正文承诺已发文件、已打电话、已发媒体 | 服务端能力拦截 | `skip`，不发送该正文 |
| 模型生成身份自我介绍 | 在不属于用户明确询问身份时拦截 | `skip`，不发送 |
| 用户本人手动回复 | 记录人工接管 | 按接管策略等待后续来信 |
| 达到 `maxRounds` | 暂停当前对象 | 记录 `limit`，等待本人处理 |

### 8.4 私聊模型输入核心结构

| 字段 | 说明 |
|---|---|
| `mode` | 固定为 `reply` |
| `kind` | 固定为 `person` |
| `messages` | 当前账号、当前联系人的最近消息，按时间从旧到新 |
| `conversation.latestIncomingId` | 最近一条对方消息 ID |
| `conversation.lastSelfId` | 最近一条本人消息 ID |
| `conversation.incomingSinceLastSelf` | 本人最近发言后，对方连续发送的消息 ID |
| `conversation.pendingIncomingIds` | 本轮尚未处理的来信 ID |
| `strategy` | 回复目的、事实、限制、回复上限 |
| `style` | 当前联系人风格或默认风格 |
| `memory` | 当前联系人 Wiki 记忆 |
| `judgeReply` | 是否允许模型自行判断跳过 |
| `multiTurn` | 是否允许返回 1–3 段消息 |
| `followUpAllowed` | 是否允许安排一次延迟追问 |
| `updateStyle` | 是否允许返回更新后的风格 |
| `capabilities` | 当前仅支持文字发送、可选图片读取，不支持文件/电话/媒体发送 |

### 8.5 私聊输出限制

| 输出字段 | 限制 |
|---|---|
| `action` | 普通回复为 `send` 或 `skip`；停止联系不是 action |
| `stop` | 独立反馈布尔值；明确停止联系只返回 `{"stop":true}`，不带任何 action 或正文 |
| `text` | 单条非空文字；每段最多 2999 字符 |
| `segments` | 仅 `multiTurn=true` 时可用；1–3 段；不能与 `text` 同时作为有效载体 |
| `followUp` | 必须为布尔值；只用于一次延迟追问，不代表分段 |
| `style` | 只有 `updateStyle=true` 时可返回 |
| `memoryUpdates` | 可选；每条必须引用本轮已发生消息 ID |
| 非发送动作 | 不允许携带 `text` 或 `segments` |

## 9. 群聊自动回复详细行为

### 9.1 群聊触发条件

| 触发类型 | 开关 | 必须条件 | 模型动作 |
|---|---|---|---|
| @我 | `groupOptions.atMe=true` | 对方消息、mentions 已验证、`mentions.self=true` | 普通回复必须 `send`；明确停止联系可 `stop=true` 并设置5分钟 `stopUntil`，不能 `wait` |
| @所有人 | `groupOptions.atAll=true` | 对方消息、mentions 已验证、`mentions.all=true` | `send`、`skip` 或 `wait` |
| 实时回复 | `groupOptions.realtime=true` | 对方消息、mentions 已验证、不是 @我/@所有人/仅 @他人 | `send`、`skip` 或 `wait` |
| 仅 @其他成员 | 任意 | `mentions.others=true` | 不参与处理 |
| 未验证的 @信息 | 任意 | `mentions.verified=false` | 不参与处理 |
| 普通群消息 | 仅 realtime 开启 | 无有效 @，且通过验证 | 按实时规则合并判断 |

如果一条消息同时满足多个触发条件，优先级为：`@我` > `@所有人` > `realtime`。

### 9.2 群聊时间与合并规则

| 规则 | 当前限制 |
|---|---|
| 同一成员连续短消息 | 通常等待 3 秒合并，最长等待 8 秒 |
| 普通实时消息 | 每 60 秒合并判断一次 |
| 不同实时回复轮次 | 至少间隔 30 秒 |
| 模型等待 | 模型无 wait 字段；合并、冷却和节流由系统内部执行 |
| 等待期间 | 保留消息，到期后重新读取并判断 |
| 回复数量 | 只受 `maxRounds` 约束，范围 1–2000 |
| 已取消限制 | 没有固定“10 分钟最多 5 条”或“同话题最多 3 轮”限制 |

### 9.3 群聊场景表

| 场景 | 处理结果 |
|---|---|
| @我且问题明确 | 优先生成针对问题的文字回复，不允许模型 wait |
| @我但模型判断无需回复 | 重试一次；仍无相关文字则明确报错，不按普通 `skip` 消费本轮。安全拦截按对应规则处理 |
| @所有人 | 模型判断是否参与；可发送、跳过或短暂等待 |
| 群友互聊 | realtime 模式下通常 `skip` |
| 只有表情、收到、刷屏 | 通常 `skip` |
| 话题已经结束 | `skip`，不强行追加追问 |
| 对方要求停止联系 | 只跳过当前轮；不会停止整个群聊自动回复 |
| 群聊返回 stop/pause/handoff/transfer/wait | 不再作为有效协议动作；只接受 send/skip |
| 群聊等待 | 系统内部合并与限流，不由模型返回等待时长 |
| 群聊发送结果不确定 | 记录审计事实，不自动重发，不要求进入个人核验流程 |
| 用户手动在群里发言 | 按人工接管等待策略处理；关闭接管时关闭群聊触发开关 |
| 达到群聊回复上限 | 当前群聊暂停，记录 `limit`，由用户恢复 |

### 9.4 群聊模型输入新增字段

| 字段 | 说明 |
|---|---|
| `kind` | 固定为 `group` |
| `trigger` | `atMe`、`atAll` 或 `realtime` |
| `groupState` | 近期动作、等待状态、手动接管、当前时间等 |
| `messages[].sender` | 发言成员身份 |
| `messages[].mentions.verified` | mentions 是否经过本地身份校验 |
| `messages[].mentions.self` | 是否 @当前账号 |
| `messages[].mentions.all` | 是否 @所有人 |
| `messages[].mentions.others` | 是否仅 @其他成员 |

## 10. 主动聊天详细行为

### 10.1 主动任务创建限制

| 字段 | 限制 |
|---|---|
| `command` | `create`、`edit`、`pause`、`resume`、`end`、`retry`、`delete` |
| `name` | 必填，最多 120 字符 |
| `taskType` | `greeting`、`relationship`、`work`、`invitation`、`holiday`、`custom` |
| `sendMode` | `single` 或 `segments` |
| `goal` | 必填，最多 6000 字符 |
| `requirements` | 可选，最多 6000 字符 |
| `contacts` | 新版主动任务只接受个人联系人，最多 200 人 |
| `schedule` | 必须是有效的新版周期结构 |
| `styleSource` | `manual`、`learned`、`paste`；后两者必须能找到已学习风格 |
| 任务数量 | 当前账号最多保留 200 个新版任务 |

### 10.2 主动任务时间情况

| 周期 | 字段 | 行为 |
|---|---|---|
| 立即/单次 | `cycle=once` | 创建后立即进入执行；完成后结束 |
| 每日 | `cycle=daily` | 每天按固定时间或随机时间段执行 |
| 工作日 | `cycle=weekdays` | 周一至周五执行 |
| 每周 | `cycle=weekly`, `weekdays` | 按指定星期执行，0 表示周日 |
| 自定义 | `cycle=custom`, `intervalDays` | 每 1–365 天执行一次 |
| 固定时间 | `mode=fixed`, `time` | 在指定 HH:mm 执行 |
| 随机时间 | `mode=random`, `start`, `end` | 在时间窗口内随机执行 |
| 时区 | `timezone` | 固定为 `Asia/Shanghai` |

### 10.3 主动聊天执行状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| 等待执行 | `pending` | 等待任务时间或上一个联系人完成 |
| 模型生成 | `generating` | 读取聊天并生成主动内容 |
| 发送中 | `sending` | 已进入原生发送流程，结果尚未确认 |
| 已发送 | `sent` | 获得消息 ID 和数据库回执 |
| 已跳过 | `skipped` | 时间窗口结束、模型判断不发送或内容被安全规则拦截 |
| 执行失败 | `failed` | 模型、读取、联系人或发送前检查失败 |
| 结果不确定 | `uncertain` | 已越过发送边界但没有可靠回执，禁止自动重发 |
| 已核对 | `reviewed` | 用户已检查结果，本次任务不再补发 |
| 已取消 | `cancelled` | 任务取消或对象被移除 |

### 10.4 主动聊天输入字段

| 字段 | 说明 |
|---|---|
| `mode` | 固定为 `proactive` |
| `continuation` | 主动发起阶段为 `false` |
| `followUp` | 固定为 `false` |
| `followUpAllowed` | 固定为 `false`，主动任务不安排自动追问 |
| `updateStyle` | 固定为 `false`，不通过主动消息学习风格 |
| `strategy.purpose` | 主动目标 |
| `strategy.content` | 内容要求 |
| `strategy.boundaries` | 限制 |
| `style` | 当前对象风格或指定学习风格 |
| `memory` | 当前对象 Wiki 记忆 |
| `conversation.recentSelfMessages` | 最近最多 8 条本人消息摘要 |
| `conversation.latestIncoming` | 最近一条对方消息 |
| `currentTime` | 当前北京时间 |
| `timezone` | `Asia/Shanghai` |
| `capabilities` | 只支持纯文字发送，不支持文件、电话和媒体发送 |

### 10.5 主动聊天内容限制

| 情况 | 处理 |
|---|---|
| 模型生成普通文字 | 发送前再次读取聊天并核对版本 |
| `sendMode=single` | 只能发送一条文字 |
| `sendMode=segments` | 最多 3 段，每段最多 2999 字符 |
| 模型返回 `skip` | 主动任务要求必须发送，视为无效/失败，不作为正常跳过 |
| 模型返回 `stop=true` | 跳过当前任务，个人联系人进入默认5分钟停止窗口，不转人工处理 |
| 生成亲昵称呼但没有证据 | 自动删除未授权称呼；删除后无正文则跳过 |
| 生成文件、电话、语音、视频承诺 | 系统拦截，不发送 |
| 发送前聊天发生变化 | 重新生成一次，避免基于旧上下文发送 |
| 分段发送中对方回复 | 取消尚未发送的剩余段落；第一段已交棒给自动回复 |
| 分段发送中本人发言 | 停止剩余段落，把控制权交回本人 |
| 用户刚刚手动回复 | 默认等待人工活动窗口，当前实现为约 5 分钟 |
| 第一段发送成功 | 立即写入主动记录和任务背景；仅自动回复已开启时才处理后续来信 |
| 主动背景 | 仅用于帮助自动回复理解来由，有效期默认 48 小时；不改变回复策略、不构成事实 |

### 10.6 主动聊天异常处理

| 异常 | 结果 |
|---|---|
| 联系人不可读取 | 当前对象 `failed`，可刷新后重试或跳过 |
| 模型请求失败 | 记录失败；周期任务在限制内自动重试 |
| 周期任务失败 | 失败对象最多自动重试 3 次 |
| 单次任务失败 | 进入失败状态，需手动重试 |
| 原生发送前失败 | `not-sent`/`stale`，不会误记为已发送 |
| 原生发送后无确认 | `uncertain`，禁止自动重发；交给自动回复时标记为不确定上下文，不纳入学习 |
| 任务暂停 | 未发送对象保留；已发送对象不回滚 |
| 任务结束 | 未发送对象取消；已发送记录保留 |
| 删除任务 | 任务不再运行，但历史执行记录保留 |

## 11. 私聊、群聊、主动聊天总对照表

下表同时列出三类功能的共同规则和专属差异。

| 对比项 | 是否共同规则 | 私聊自动回复 | 群聊自动回复 | 主动聊天 |
|---|---|---|---|---|
| 核心目的 | 否 | 回应对方新消息 | 判断是否参与群聊 | 按任务主动发起聊天 |
| 触发来源 | 否 | 对方产生新来信 | 已验证的 @我、@所有人或实时消息 | 立即执行或定时任务到期 |
| 账号校验 | 是 | 必须是当前微信账号 | 必须是当前微信账号 | 必须是创建任务时的当前账号 |
| 联系人/对象校验 | 是 | 联系人必须仍存在且为 `person` | 群聊必须仍存在且为 `group` | 新版任务为当前账号下的个人联系人 |
| AI 总开关 | 是 | `settings.enabled=true` | `settings.enabled=true` | `settings.enabled=true` |
| 模型配置 | 是 | 模型已配置、同意发送聊天内容、测试通过 | 同左 | 同左 |
| 微信状态 | 是 | 微信运行、已登录、联系人可读取 | 同左 | 微信运行、已登录、联系人可读取 |
| 模型输入 | 是 | 当前联系人最近聊天 | 当前群聊最近聊天、成员和 mentions | 当前联系人最近聊天和主动任务目标 |
| 输入消息顺序 | 是 | 按时间从旧到新 | 按时间从旧到新 | 按时间从旧到新 |
| 输入消息最大范围 | 是 | 最近读取最多约 300 条，超长会截断 | 同左 | 使用当前联系人上下文，超长会截断 |
| 消息身份字段 | 是 | `id`, `direction`, `text`, `timestamp` | 以上字段加 `sender`, `mentions` | 以上普通消息字段 |
| 事实来源限制 | 是 | 只能使用聊天、`strategy.facts`、风格要求 | 同左 | 只能使用聊天、任务目标/要求和风格；目标未确认不算事实 |
| 是否允许编造经历/安排 | 是 | 不允许 | 不允许 | 不允许 |
| 是否允许声称已执行外部动作 | 是 | 不允许声称已发文件、打电话、发媒体 | 不允许 | 不允许 |
| 可发送能力 | 是 | 纯文字；可理解已读取图片 | 纯文字；可理解已读取图片 | 纯文字 |
| 文件、电话、语音、视频 | 是 | 只能文字说明或提供替代方案 | 同左 | 同左 |
| 模型返回格式 | 是 | 只返回 JSON | 只返回 JSON | 只返回 JSON |
| `action=send` | 是 | 允许 | 允许 | 正常情况下必须使用 |
| `text` | 是 | 单条非空文字，每段最多 2999 字符 | 同左 | 同左 |
| `segments` | 部分共同 | `multiTurn=true` 时最多 3 段 | 按群聊触发和 `multiTurn` 配置，最多 3 段 | `sendMode=segments` 时最多 3 段 |
| `action=skip` | 否 | 通常允许；明确提问时受限 | 允许，是群聊主要决策 | 不作为正常动作；返回后视为无效/失败 |
| `action=wait` | 否 | 不允许 | 不允许，等待由系统内部控制 | 不允许 |
| `stop=true` | 否 | 独立反馈；当前轮不发送并设置5分钟 `stopUntil`，不永久暂停 | 明确要求停止时本轮 skip | 个人联系人明确要求停止时跳过并设置停止窗口 |
| 明确提问保护 | 否 | 模型必须针对问题生成文字，不能用 skip 逃避 | @我触发时要求相关回复 | 主动任务不依赖对方提问，必须围绕任务生成 |
| 同一轮消息合并 | 否 | 固定20秒，不可由用户配置 | 同一成员约3秒、最长8秒；群聊节流由系统内部管理 | 生成前重新读取聊天，不重复旧内容 |
| 实时消息等待 | 否 | 无 | 普通 realtime 每 60 秒合并；不同轮次至少间隔 30 秒 | 无 |
| 模型短暂等待 | 否 | 不允许 | 不允许；保留系统内部群聊等待 | 不允许 |
| 多轮沟通 | 否 | `multiTurn` 开启后可分段 | 遵循群聊触发器和 `multiTurn` | 由 `sendMode` 决定单条或分段 |
| 延迟追问 | 否 | 多轮且启用时可安排一次 | 不追加无人发言追问 | 不自动安排追问 |
| `followUp` | 否 | 可为 `true/false` | 不用于群聊追问 | 固定为 `false` |
| 风格来源 | 是 | 当前联系人风格或默认风格 | 当前群聊风格/默认风格 | 当前对象风格或任务指定学习风格 |
| 自动更新风格 | 否 | 由 `updateStyle` 决定 | 由 `updateStyle` 决定 | 始终关闭 |
| 自动写入记忆 | 否 | 可返回 `memoryUpdates` | 可返回 `memoryUpdates` | 不写入新记忆 |
| 称呼规则 | 是 | 默认不加称呼，必须有明确证据 | 不能把某个成员称呼套给全群 | 未授权亲昵称呼会被删除 |
| 用户手动回复 | 是 | 进入人工接管等待窗口 | 进入人工接管等待窗口 | 等待约 5 分钟；分段中本人发言会中断剩余段落 |
| 接管关闭时 | 否 | 关闭该联系人自动回复 | 关闭该群聊触发开关 | 不取消任务，但当前执行会遵守人工活动状态 |
| 账号/聊天变化 | 是 | 取消旧生成，重新读取后再判断 | 保留触发消息，按新版本重新判断 | 发送前重新读取；变化时重生成或取消剩余段落 |
| 发送前校验 | 是 | 校验账号、联系人、聊天版本 | 校验账号、群聊和上下文 | 校验账号、联系人、聊天版本和任务版本 |
| 发送方式 | 是 | 通过微信原生桌面发送 | 通过微信原生桌面发送 | 通过微信原生桌面发送 |
| 发送成功条件 | 是 | 必须获得可靠的数据库新增回执 | 记录实际发送/审计状态 | 必须获得消息 ID 和可靠回执 |
| 发送结果不确定 | 是 | 不自动重发；主动消息作为带不确定标记的自动回复上下文 | 记录审计事实，不自动重发 | `uncertain`，禁止自动重发 |
| 连续回复上限 | 是 | `maxRounds`：1–2000 | `maxRounds`：1–2000；没有固定 10 分钟/3 轮限制 | 不使用普通回复轮数，按任务联系人和分段执行 |
| 达到上限 | 否 | 暂停该联系人，记录 `limit` | 暂停该群聊，记录 `limit` | 不适用；任务按执行项状态结束 |
| 模型失败 | 是 | 记录错误，后续新消息可继续 | 记录错误，后续新群消息可继续 | 当前执行项失败，周期任务可按规则重试 |
| 原生发送前失败 | 是 | 不记为已发送 | 不记为已发送 | `not-sent`/`stale`/`failed`，可重试安全失败 |
| 原生发送后无回执 | 是 | 不重发；可作为当前自动回复假定上下文 | 记录审计，不重发 | `uncertain`，不自动重发 |
| 自动重试 | 部分共同 | 模型/读取错误按服务重试，但不重发不确定消息 | 同左 | 周期任务失败对象最多自动重试 3 次；不确定结果不重试 |
| 任务暂停 | 否 | 暂停对象的自动回复 | 暂停群聊触发 | 保留未发送对象，已发送内容不回滚 |
| 历史记录 | 是 | 保存自动回复、跳过、错误记录 | 保存触发、跳过、等待、错误记录 | 保存任务、联系人、正文、状态和执行记录 |
| 后续对话背景 | 否 | 使用当前回复策略和记忆 | 使用当前群聊上下文 | 第一段发送后，目标/要求作为最多48小时的回复背景 |
| 后续背景是否改变回复策略 | 否 | 不适用 | 不适用 | 不改变联系人原有回复策略，只帮助理解主动聊天来由 |
| 定时执行 | 否 | 不按时间主动触发 | 不按时间主动触发 | 支持单次、每日、工作日、每周、自定义周期 |
| 时间窗口 | 否 | 不适用 | 不适用 | 支持固定时间或随机时间段，统一按北京时间 |
| 删除后的历史 | 是 | 记录可单独删除，不删除微信消息 | 同左 | 删除任务后历史执行记录仍保留 |

## 12. 本次新增规则记录（已实施，设备验收待完成）

以下记录本轮确认并已在工作区实现的规则；真机验收与打包尚未完成时，不视为设备侧验收通过。

| 调整项 | 当前实现 | 记录后的目标规则 | 当前状态 |
|---|---|---|---|
| 去掉群聊 `wait` 字段 | 之前提示词与结果解析允许 `action=wait` 和 `waitSeconds` | 删除模型等待动作；群聊等待仅由系统内部控制 | 已实施 |
| 去掉主动聊天“转交本人处理” | 主动聊天可留人工关注/核验分支 | 不创建主动聊天人工转交分支；保留发送执行状态与必要安全审计 | 已实施 |
| 主动聊天遇明确拒绝 | 之前可把拒绝作为主动任务人工关注结果 | 第一段发送后交给自动回复；对方回复时取消未发段落，不重新生成剩余主动内容 | 已实施 |
| 主动聊天与自动回复承接 | 已确认发送成功后，会把主动消息写入聊天记录，并设置短期 `replyBackground` | 保留承接闭环：对方回复进入自动回复输入；主动聊天目标/要求仅作为背景，不覆盖自动回复策略 | 保留 |

## 13. 本轮补充确认规则（待实施）

### 13.1 联系人明确要求停止联系

| 场景 | 目标处理 |
|---|---|
| 联系人明确要求停止联系 | 不受 `judgeReply` 影响，返回独立反馈字段 `stop=true`，不返回 `action` |
| 停止窗口 | 后端在联系人 profile 上写入 `stopUntil=当前时间+5分钟` |
| 停止窗口内的新消息 | 当前轮不执行发送；不改写为 `action=skip`，保留 `stop=true` 的反馈语义 |
| 停止窗口之后的新消息 | 可以重新进入自动回复流程 |
| 是否永久暂停联系人 | 否。`stopUntil` 到期后恢复；停止窗口内同时限制主动聊天发送 |
| 普通拒绝但未要求停止 | 不自动视为 `stop`，由自动回复按照普通策略处理 |

实现时需要把 `stop` 作为独立反馈字段：当模型返回 `stop=true` 时不返回 `action`，后端写入联系人 profile 的 `stopUntil`，当前发送流程直接结束，不转换为 `skip`，也不永久暂停联系人。

### 13.2 主动聊天完成后的责任边界

| 主动聊天状态 | 目标处理 |
|---|---|
| 主动聊天第一段已确认发送 | 写入目标与要求作为 `replyBackground`，对方后续回复交给联系人自动回复处理 |
| 对方回复时仍有主动聊天段落未发送 | 取消全部剩余段落，不再重新生成或继续发送，避免与自动回复重复 |
| 主动聊天全部段落均已发送 | 主动任务结束；后续消息继续由联系人自动回复处理 |
| 主动聊天已生成但尚未发送 | 仍属于主动聊天任务，不能提前交给自动回复当作已发送事实 |
| 主动聊天发送结果不确定 | 不等待人工核验，直接交给自动回复；能在当前聊天中唯一匹配时按真实消息处理，无法判断时按假定已发送上下文处理 |
| 主动聊天结束后对方明确要求停止联系 | 自动回复返回 `stop=true`，设置 5 分钟 `stopUntil`，当前发送流程直接结束，并限制主动聊天 |

### 13.3 前端页面核查结果

| 项目 | 核查结果 |
|---|---|
| AI 辅助入口 | 存在 |
| 系统设置页面 | 存在，包含模型设置、默认风格、AI 辅助等待、身份说明等内容 |
| “沟通设置”页面 | 当前不存在 |
| “消息合并等待”可见输入框 | 当前不存在 |
| `replyDelay` 后端字段 | 固定20秒；旧值及接口传入值均归一为20秒 |
| 分段/追问等待字段 | 后端存在；前端有残留生成函数和保存处理，但当前没有被实际页面调用 |
| 之前“已有前端设置页”的说法 | 更正为：后端字段已存在，但当前版本前端页面未接入 |

## 15. 最新执行协议确认（覆盖前述旧规则）

| 规则 | 最终定义 |
|---|---|
| `stop` 返回形式 | `stop=true` 是反馈字段；明确停止联系时不返回 `action` |
| `stop` 的执行效果 | 当前流程直接结束，不发送消息；效果等同于跳过，但不记录/转换为模型 `skip` |
| `stopUntil` 存储位置 | 联系人 `profile.stopUntil`，按联系人持久化 |
| `stopUntil` 默认时长 | 当前时间起 5 分钟 |
| `stopUntil` 影响范围 | 自动回复和主动聊天发送均受限；手动回复不受限 |
| 主动聊天交棒时机 | 第一段确认发送后立即设置 `replyBackground`，由自动回复负责对方回复 |
| 主动聊天剩余段落 | 对方回复时全部取消，不再重新整理或发送剩余段落 |
| `uncertain` 的匹配 | 优先读取当前聊天，若唯一匹配正文、方向和时间窗口，则标记为 `confirmed` |
| `uncertain` 明确未发送 | 不作为真实聊天消息，不作为自动回复上下文 |
| `uncertain` 无法判断 | 作为 `assumedPresent=true` 的主动消息上下文交给自动回复；同时保留 `deliveryConfidence=uncertain` |
| `uncertain` 的记忆影响 | 不进入风格学习、聊天记忆和事实沉淀；只用于当前自动回复理解上下文 |
| `uncertain` 的重发 | 不自动重发，避免重复发送 |

### 13.4 消息时序固定规则（已实施）

| 字段 | 产品固定值 | 实际行为 | 用户是否可设置 |
|---|---:|---|---|
| `replyDelay` | 20 秒 | 联系人连续发送消息后，统一等待 20 秒再处理当前轮 | 否 |
| `segmentDelayMin` | 15 秒 | 多段回复之间随机间隔的下限 | 否 |
| `segmentDelayMax` | 60 秒 | 多段回复之间随机间隔的上限 | 否 |
| `followUpDelayMin` | 45 秒 | 延迟追问等待的下限 | 否 |
| `followUpDelayMax` | 120 秒 | 延迟追问等待的上限 | 否 |

随机规则：

- 多段回复每相邻两段之间，从 15–60 秒范围内随机等待；
- 延迟追问从 45–120 秒范围内随机等待；
- `replyDelay` 不随机，固定等待 20 秒；
- 前端不再展示这些数值的输入框、滑块或保存按钮；
- 后端仍可保留字段用于内部协议兼容，但不再将其作为用户配置项。

工作区后端默认值、读取归一、设置接口与随机等待均执行以上固定规则；旧客户端即使提交其他数值也不会改变实际值。

## 14. 全部已确认规则汇总（最终记录）

本节集中汇总当前对话中已经确认的产品规则及工作区实施状态；真机验收/打包状态以最终交付记录为准。

| 编号 | 主题 | 最终确认规则 | 相关字段/状态 | 前端情况 | 实施状态 |
|---:|---|---|---|---|---|
| 1 | 群聊 `wait` | 删除模型 `wait` 与 `waitSeconds`；保留系统内部等待与节流 | 仅系统内部 `groupWait` | 不作为用户设置 | 已实施 |
| 2 | 主动聊天人工转交 | 删除主动聊天“转交本人处理”分支 | 主动任务执行状态 | 不提供设置 | 已实施 |
| 3 | 联系人明确停止联系 | 无论 `judgeReply` 取值，返回独立反馈字段 `stop=true`，不返回 `action` | `stop`、`profile.stopUntil` | 联系人设置页不新增开关 | 已实施 |
| 4 | 停止后的当前轮 | `stop=true` 的执行效果等同跳过当前轮，不写成 `action=skip` | 默认5分钟停止窗口 | 不提供时长设置 | 已实施 |
| 5 | 停止后的后续消息 | 5分钟后新消息可重新进入自动回复，不永久暂停联系人 | `stopUntil` | 继续保留自动回复开关 | 已实施 |
| 6 | 普通拒绝 | 未明确要求停止联系时，不自动转为 `stop`，由普通自动回复处理 | 普通 `send` / `skip` | 使用现有联系人策略 | 待实施 |
| 7 | 主动聊天已完成 | 所有主动聊天段落确认发送后，主动任务结束；对方后续回复只由自动回复处理 | `task` 完成、`replyBackground` | 主动聊天页保留任务记录 | 待实施 |
| 8 | 主动聊天未完成 | 第一段发出后若对方回复，取消所有剩余段落，不重整输入、不再主动发送 | 聊天 revision、剩余 segments | 主动聊天页保留发送方式选择 | 已实施 |
| 9 | 主动聊天发送不确定 | 不自动重发；无法判断是否入库时将带不确定标记的假定正文交给自动回复，不作为确认历史、学习或记忆 | `uncertain`、`assumedPresent`、`deliveryConfidence` | 不要求用户核验后才交棒 | 已实施 |
| 10 | 主动聊天承接 | 主动消息确认发送后写入聊天记录；对方回复进入自动回复输入；任务目标和要求作为短期背景 | `aiGenerated`、`replyBackground` | 不新增用户设置 | 保留 |
| 11 | 主动聊天读取范围 | 读取当前联系人近期最多 300 条；总输入约 90KB；单条文本约 20000 字符；超限从最早消息开始截断 | `messages` | 不提供日期范围设置 | 当前已有 |
| 12 | 主动聊天重点消息 | 重点提供最近 8 条我方消息和最近 1 条对方消息；重点文本通常截取最近 360 字符 | `recentSelfMessages`、`latestIncoming` | 不提供设置 | 当前已有 |
| 13 | 联系人自动回复开关 | 由联系人级 `profile.replyOptions.enabled` 决定最终是否回复 | `profile.replyOptions.enabled` | 联系人设置页可见 | 当前已有 |
| 14 | `judgeReply` | 允许模型判断是否回复；明确停止联系不受其影响，仍返回 `stop=true` | `profile.replyOptions.judgeReply` | 联系人设置页可见 | 已实施 |
| 15 | `settings.replyScope` | 保留。作为联系人未单独设置时的默认范围：`all` 默认全部联系人，`selected` 默认仅选中联系人 | `settings.replyScope` | 当前没有稳定可见的前端选择控件 | 保留 |
| 16 | 联系人设置优先级 | 联系人明确设置 `profile.replyOptions.enabled` 时，覆盖 `settings.replyScope` 的默认值 | `profile.replyOptions.enabled` > `settings.replyScope` | 联系人设置页可见 | 保留 |
| 17 | 消息合并等待 | 固定20秒，接口传入其他值也归一化 | `replyDelay=20` | 不显示设置控件 | 已实施 |
| 18 | 多段回复间隔 | 每相邻两段之间随机等待15–60秒 | `segmentDelayMin=15`、`segmentDelayMax=60` | 不显示设置控件 | 已实施 |
| 19 | 延迟追问等待 | 随机等待45–120秒 | `followUpDelayMin=45`、`followUpDelayMax=120` | 不显示设置控件 | 已实施 |
| 20 | `followUp` | 仅表示一次延迟追问检查；主动聊天固定为 `false`，不用于普通分段 | `followUp`、`followUpAllowed` | 不提供单独开关 | 当前已有，规则保留 |
| 21 | 前端沟通设置页面 | 当前不存在“沟通设置”页面；系统设置页不包含消息合并、分段和追问时间配置 | `settings` 时序字段 | 当前前端未接入 | 已确认 |
| 22 | 时序字段用户配置 | 后端字段保留兼容，但所有实际行为使用固定值 | `replyDelay`、`segmentDelay*`、`followUpDelay*` | 不显示输入框、滑块或保存按钮 | 已实施 |
