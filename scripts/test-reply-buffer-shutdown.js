/**
 * Reply buffer on shutdown (2026-10-01, Dan H.). A message waiting in the
 * reply buffer's timer when a deploy's SIGTERM arrives is fired at once, so
 * its reply goes out inside the drain instead of waiting for the ~5-minute
 * decision-engine backstop. The timer can never fire it a second time.
 *
 * Run: node --test scripts/test-reply-buffer-shutdown.js
 */

process.env.SUPABASE_URL ||= 'http://127.0.0.1:9';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
process.env.REPLY_DEBOUNCE_MS = '600000';          // the timer must not be what fires it
process.env.REPLY_BUFFER_MAX_RETRIES = '1';        // no 20s retry timer in a test
process.env.SELF_BASE_URL = 'http://127.0.0.1:9';  // the pipeline's self-calls fail fast

import test from 'node:test';
import assert from 'node:assert/strict';

const emitter = await import('../src/behavioral-emitter.js');

test('a pending buffer is fired by the shutdown flush, once', async () => {
  emitter._scheduleBufferedPipelineForTests('C-flush-1', 'Does it make any difference?', null, 'SMS', 'm1');
  emitter._scheduleBufferedPipelineForTests('C-flush-2', 'hello', null, 'SMS', 'm2');
  assert.equal(emitter._replyBufferCountForTests(), 2);

  assert.equal(emitter.flushReplyBuffersNow(), 2, 'both buffers fire now, not in 10 minutes');
  assert.equal(emitter._replyBufferCountForTests(), 0, 'fired buffers leave the map at once');
  assert.equal(emitter.flushReplyBuffersNow(), 0, 'a second flush finds nothing to run twice');
});

test('a new message after the flush starts a fresh buffer', () => {
  emitter._scheduleBufferedPipelineForTests('C-flush-3', 'one more', null, 'SMS', 'm3');
  assert.equal(emitter._replyBufferCountForTests(), 1);
  assert.equal(emitter.flushReplyBuffersNow(), 1);
});
