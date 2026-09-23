import test from 'node:test';
import assert from 'node:assert/strict';
import { unsupportedTextAction, promisesMedia } from '../server/ai-capabilities.mjs';

test('truthful file and call limitations can be sent as text',()=>{
  for(const text of ['我不能发送文件，只能用文字说明','暂时无法提供附件，可以把测试说明写在这里','我不支持拨打电话，我们可以继续文字交流','没法下载文档','我不能接语音通话','我发不了文件，只能文字说明','我接不了语音通话','暂时发不出文件'])
    assert.equal(unsupportedTextAction(text),null,text);
});

test('a denial in another clause does not authorize a file or call promise',()=>{
  for(const text of ['不能发文件，但是我马上上传文档','我无法发文件，不过可以给你发附件','不能发送文件，马上给你打电话','我不会下载文档；我这就打开文件'])
    assert.ok(unsupportedTextAction(text),text);
  assert.equal(unsupportedTextAction('请给我发送文件'),'file');
  assert.equal(unsupportedTextAction('请给我打电话'),'call');
});

test('media denials remain distinct from promises in a later clause',()=>{
  assert.equal(promisesMedia('我发不了图片，可以文字说明'),false);
  assert.equal(promisesMedia('我不能发图片，但是我已经发了照片'),true);
  assert.equal(promisesMedia('我发不了图片，不过我马上发截图'),true);
});
