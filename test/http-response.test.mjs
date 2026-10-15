import test from 'node:test';
import assert from 'node:assert/strict';
import {readApiResponse, parseApiResponse, requireDownloadResponse} from '../web/http-response.mjs';

test('native fnOS HTTP 200 expired token rejects API reads and upload receipts', async()=>{
  await assert.rejects(readApiResponse(new Response('invalid token', {status:200})), {code:'HOST_SESSION_EXPIRED'});
  assert.throws(()=>parseApiResponse('invalid token\n',200),{code:'HOST_SESSION_EXPIRED'});
  assert.throws(()=>parseApiResponse('<html>Login</html>',401),{code:'HOST_SESSION_EXPIRED'});
  assert.throws(()=>parseApiResponse('',200),/服务响应异常/);
  assert.throws(()=>parseApiResponse('null',200),/服务响应异常/);
  assert.deepEqual(parseApiResponse('{"received":12}',200),{received:12});
  assert.throws(()=>parseApiResponse('{"error":"权限不足","code":"DENIED"}',403),{message:'权限不足',code:'DENIED'});
});

test('gateway errors never become successful report or file downloads',async()=>{
  for(const fallback of ['导出失败，请重试','文件下载未完成，请重试']){
    await assert.rejects(requireDownloadResponse(new Response('invalid token',{status:200,headers:{'Content-Type':'text/plain'}}),fallback),{code:'HOST_SESSION_EXPIRED'});
    await assert.rejects(requireDownloadResponse(new Response('<html>Login</html>',{status:200}),fallback),{message:fallback});
    await assert.rejects(requireDownloadResponse(new Response('{"error":"报告不存在"}',{status:404}),fallback),{message:'报告不存在'});
  }
});

test('valid downloads keep their original stream even if file text says invalid token',async()=>{
  const response=new Response('invalid token',{status:200,headers:{'Content-Type':'text/plain','Content-Disposition':"attachment; filename*=UTF-8''test.txt"}});
  assert.equal(await requireDownloadResponse(response,'下载失败'),response);
  assert.equal(response.bodyUsed,false);
  assert.equal(await response.text(),'invalid token');
});
