# 群聊 @我 回复协议修正（2026-09-25）

## 约定与修正

已验证且开启的 `@我` 与私聊关闭「智能判断是否回复」一致：模型的普通回复协议只允许 `action=send`，不得以「无需回应」返回 `action=skip`。模型异常返回 `skip`、`wait` 或旧暂停/转交动作时，至多再请求一次；仍无可执行回复则留下明确错误，不把该消息记为正常跳过。对方本轮明确要求停止联系时返回独立的 `stop=true`，系统设置默认 5 分钟 `stopUntil`；身份、媒体、人工接管、账号变化和发送结果不确定等保护仍按原规则执行。`@所有人` 和实时回复的模型判断保持原有规则。

## 本地验证

- `npm test`：741 项，740 通过，1 项既有 UGOS 平台跳过，0 失败。
- `npm run check` 与 `git diff --check` 通过。
- 专项覆盖：`@我` 提示词不列出 `skip`、异常 `skip` 后重试并发送、连续异常给出错误、明确 `stop` 设置 `stopUntil`、停止窗口内不发送，以及 `@所有人` 仍允许模型跳过。

## fnOS 真机边界

- 目标：`192.168.3.7`，安装态构建号仍为 `0.9.12-debug.001`。只把三个已部署服务模块按原版本打补丁并热同步，未安装新 FPK，也未改变配置或安装态构建号。
- 热同步前核对原模块哈希并备份；最终备份目录：`/vol1/@appdata/qibox/upgrade-backups/atme-contract-20260925-231809`。部署后三个模块的 SHA-256 分别为 `00efeeeae90ea564a97622e6eac2e0f48f4b5d7f29e2629cfb3e8dd5219ccd9d`、`e56b1e239b644ed3e2f8c4f4a1b3f6241e91cd5239d5a6928cd6076d51e67bd2`、`c3f97b010c2fcd38c958e1a705652a0ba4a3040450493b1cd43ac695482af73c`，顺序为 `ai-group.mjs`、`ai-prompts.mjs`、`ai-service.mjs`。
- 服务重启后 Bot 微信实例为 `running`、`logged-in`，AI 入口 `available=true`，测试群 `atMe=true`、`paused=false`。直接引用真机已部署模块执行隔离专项：18/18 通过。
- 隔离测试同时运行的另一项旧设备代码回归在「不确定发送」状态值上与当前本地测试不一致（设备 `uncertain`、测试预期 `unknown`）；该项不作为本次 `@我` 修正通过证据。
- 后续补做了真实微信群聊验收：将原本停止的 test 微信实例启动并登录，在「测试(3)」群通过原生成员菜单选中 `Bot`，发送 `@Bot ATME-0925-CHK7 请只回复：收到ATME-0925-CHK7`。发送端消息 ID `d0d92ab45b5c0c4acd93ab271b035e61edf93cb08b4811e9d5fb3aa1f6bdeded`；Bot 端对应入站消息 ID `5ef6bb7e9b081beccacacc51bb0ada4b1d6a5daba53a257db439b251b41ad300`，从微信数据源核对 `mentions.verified=true`、`mentions.self=true`、`mentions.all=false`。这证明是真实的成员 @，不是仅含 `@Bot` 字样的普通文字。
- Bot AI 运行记录新增一条 `trigger=atMe`、`source=reply` 的发送项，消息 ID `cd2e22ce7badad01c6c11d04d2732db38f2fd64cfbc43d3a2d1d54a3a06439a0`。Bot 微信数据源确认发出 `收到ATME-0925-CHK7`；test 微信数据源确认收到相同正文，接收端消息 ID `b9639ddacffbb01ae3cc52cd100e34b369f95c1356b3eeebe36b833926745331`。这条 @我 消息完成了真实接收、模型生成、自动发送和对端送达。
- 首个界面脚本曾报告按下发送按钮，但两端数据源均无消息，因此未计入验收。改用原生 @ 成员标记和富文本追加方式，以上述数据源记录为成功依据。测试前后 test 群输入框均为空；测试结束将 test 实例恢复到原先的 `stopped` 状态。Bot 保持 `running`、`logged-in`，测试群 `atMe=true`、`paused=false`、`stopUntil=null`。
- 本次真实收发覆盖正常的 `@我 → send` 路径。异常模型输出、明确停止请求及五分钟 `stopUntil` 的结论来自本地和真机部署模块的专项测试，不将这些边界描述为已做真实微信消息验收。
