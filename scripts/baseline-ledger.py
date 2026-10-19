"""Import historical acceptance without promoting old evidence to current passes."""
import csv
import hashlib
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path('D:/app开发/栖盒/local/acceptance-plan-20261010')
OUT = ROOT / 'local/stable-baseline-20261019'
OUT.mkdir(parents=True, exist_ok=True)
if (OUT / 'ledger.json').exists():
    print('Existing baseline ledger preserved; import is create-only to retain review decisions.')
    raise SystemExit(0)
rows = list(csv.DictReader((SOURCE / '测试用例清单.csv').open(encoding='utf-8-sig', newline='')))
history_path = SOURCE / 'run-20261010-0.10.46/缺陷记录.md'
history = history_path.read_text(encoding='utf-8-sig')
issues = {}
for row in rows:
    ids = re.findall(r'ACC-?0*(\d+)', row['缺陷编号'])
    for number in ids:
        key = f'ACC-{int(number):03}'
        issue = issues.setdefault(key, dict(id=key, sourceCases=[], pages=[], expected=[], reproduction=[], historicalResults=[], evidence=[]))
        issue['sourceCases'].append(row['编号'])
        for target, value in [('pages', row['模块']), ('expected', row['预期']), ('reproduction', row['步骤']), ('historicalResults', row['状态'] + ': ' + row['实际结果']), ('evidence', row['证据路径'])]:
            if value and value not in issue[target]:
                issue[target].append(value)
        issue['severity'] = min(issue.get('severity', 'P3'), row['优先级'])
for key, issue in issues.items():
    number = int(key[4:])
    paragraphs = [p for p in history.split('\n\n') if re.search(rf'ACC-?0*{number}(?!\d)', p)]
    issue.update(actual=paragraphs[0] if paragraphs else '原表实际结果见 historicalResults；本轮待核实',
                 historicalNotes=paragraphs, status='待核实', repair='未在本轮修改', regression='本轮尚未执行；历史通过不迁移为当前通过',
                 evidenceLevel='历史版本证据，待逐项核查', closureScope=None)
payload = dict(schema=1, sourceCommit='12f8fdc92ba3bc848dde40c574fbbf14d68ee51c', sourceBuild='0.11.5-candidate.003',
               specRevision='2026-10-19.2', uiVersion='0.2.0', baselineStatus='收敛进行中，尚非本地候选或稳定交付基线',
               historicalCaseCount=len(rows), historicalCases=rows, issues=list(issues.values()),
               boundaries=['本轮真机、扫码、真实收发、升级、FPK打包安装暂停', '不新增模型请求或重试次数', '无会员充值计费和1.0.0范围决定'])
(OUT / 'ledger.json').write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
(OUT / 'history-defects.md').write_text(history, encoding='utf-8')
(OUT / 'history-source.json').write_text(json.dumps({str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in [history_path, SOURCE / '测试用例清单.csv']}, ensure_ascii=False, indent=2), encoding='utf-8')
lines = ['# 历史问题统一台账', '', '所有条目先标待核实。历史修复和通过保留在 JSON 中，不自动计为本轮通过。相同 ACC 编号跨用例合并；不同缺陷不按相似标题擅自合并。', '', '|编号|页面/功能|严重度|状态|关联用例|', '|---|---|---|---|---|']
lines += [f"|{x['id']}|{'、'.join(x['pages'])}|{x['severity']}|{x['status']}|{'、'.join(x['sourceCases'])}|" for x in issues.values()]
lines += ['', '逐项预期、实际、复现、修复、回归及完整证据位置见 ledger.json。历史记录包含私有设备信息，本目录维持忽略，不进入源码或安装包。']
(OUT / '问题台账.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
print(json.dumps(dict(cases=len(rows), uniqueIssues=len(issues), output=str(OUT)), ensure_ascii=False))
