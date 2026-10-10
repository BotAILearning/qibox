import test from 'node:test';
import assert from 'node:assert/strict';
import { AIProvider } from '../server/ai-provider.mjs';
import { modelConfig } from './ai-fixtures.mjs';

test('authentication and forbidden responses stay distinct without exposing vendor bodies or retrying', async () => {
  for (const protocol of ['openai', 'anthropic']) for (const action of ['test', 'models']) for (const status of [403, 401]) {
    let requests = 0;
    const provider = new AIProvider({ fetcher: async () => {
      requests++;
      return Response.json({ error: { message: 'vendor-private-fixture' } }, { status });
    } });
    await assert.rejects(provider[action]({ ...modelConfig, protocol }), error => {
      assert.match(error.message, status === 403 ? /权限不足/ : /认证失败/);
      assert.equal(error.code, status === 403 ? 'ai_model_forbidden' : 'ai_model_auth');
      assert.doesNotMatch(error.message, /vendor-private-fixture/);
      assert.equal(requests, 1);
      return true;
    });
  }
});
