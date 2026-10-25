import { randomUUID } from 'node:crypto';

const modes = new Set(['reply', 'proactive', 'speaker-audit', 'style-trial', 'memory-monitor']);
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Correlates existing fetch attempts, not billing or server receipt of a
// timed-out request. Never log endpoint, model keys, actors or message bodies.
export function requestTrace({ mode, format, purpose, emit = value => console.info('[ai-request-trace]', JSON.stringify(value)), now = Date.now } = {}) {
  const requestId = randomUUID(), kind = modes.has(mode) ? mode : format === 'report' ? 'report' : purpose === 'learning' ? 'learning' : 'generation';
  const log = (event, attempt, extra) => {
    try { emit({ requestId, kind, attempt, event, at: now(), bestEffort: true, ...extra }); } catch { /* observation must not trigger a new model request */ }
  };
  return number => {
    let started, responded = false, status = null, usage = null, failure = null, ended = false;
    return {
      dispatch() { started = now(); log('dispatch', number); },
      response(value) { responded = true; status = count(value); log('response', number, { status }); },
      usage(value) { usage = { inputTokens: count(value?.prompt_tokens ?? value?.input_tokens), outputTokens: count(value?.completion_tokens ?? value?.output_tokens), cachedInputTokens: count(value?.prompt_tokens_details?.cached_tokens ?? value?.cache_read_input_tokens), cacheWriteTokens: count(value?.cache_creation_input_tokens) }; },
      failed(error, cancelled) {
        failure = cancelled ? 'cancelled' : error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'AbortError' ? 'aborted'
          : responded ? 'response-processing' : started !== undefined ? 'transport-unknown' : 'local';
      },
      end() {
        if (ended) return;
        ended = true;
        log('end', number, { outcome: responded ? 'response-known' : started !== undefined ? 'response-unknown' : 'not-dispatched', status, failure,
          elapsedMs: started === undefined ? null : Math.max(0, now() - started), usage });
      },
    };
  };
}
