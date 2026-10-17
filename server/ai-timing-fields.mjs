// Browser-safe shared settings contract.
export const timingDefaults = Object.freeze({ replyDelay: 20, replyMaxWait: 60, segmentDelayMin: 15, segmentDelayMax: 60, followUpDelayMin: 45, followUpDelayMax: 120 });
export const timingLabels = { replyDelay: '消息合并等待（秒）', replyMaxWait: '整轮最长等待（秒）', segmentDelayMin: '分段最短间隔（秒）', segmentDelayMax: '分段最长间隔（秒）', followUpDelayMin: '延迟续聊最短等待（秒）', followUpDelayMax: '延迟续聊最长等待（秒）' };
