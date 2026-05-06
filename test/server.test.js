import test from 'node:test';
import assert from 'node:assert/strict';

import WebSocket from 'ws';

import { buildPrompt, buildPromptSignature, findLongestExactPrefixMatch } from '../public/lib/prompt-cache.js';
import { createBridgeServer } from '../src/server.js';

function onceOpen(socket) {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
}

function onceClose(socket) {
  return new Promise((resolve) => {
    socket.once('close', resolve);
  });
}

function onceMessage(socket, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const handleMessage = (raw) => {
      const payload = JSON.parse(String(raw));
      if (predicate(payload)) {
        socket.off('message', handleMessage);
        socket.off('error', handleError);
        resolve(payload);
      }
    };

    const handleError = (error) => {
      socket.off('message', handleMessage);
      reject(error);
    };

    socket.on('message', handleMessage);
    socket.once('error', handleError);
  });
}

async function readyBridge(socket) {
  socket.send(
    JSON.stringify({
      type: 'browser-ready',
      promptApiAvailable: true,
      userAgent: 'test-agent',
      location: 'http://test.local/',
    }),
  );

  await onceMessage(
    socket,
    (payload) => payload.type === 'server-state' && payload.browserInfo?.promptApiAvailable === true,
  );
}

test('lists the available OpenAI models', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const response = await fetch(`http://127.0.0.1:${port}/v1/models`);
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.object, 'list');
  assert.equal(body.data[0].id, 'chrome-prompt-api');

  await bridgeServer.close();
});

test('builds prompt transcripts with tool calls and tool outputs', () => {
  const prompt = buildPrompt([
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'Check memory.' },
    {
      role: 'assistant',
      tool_calls: [
        {
          id: 'call_1',
          type: 'function',
          function: {
            name: 'shell',
            arguments: '{"command":"free -h"}',
          },
        },
      ],
    },
    {
      role: 'tool',
      name: 'shell',
      content: 'Mem: 31Gi',
    },
  ]);

  assert.match(prompt, /^SYSTEM: You are helpful\./);
  assert.match(prompt, /USER: Check memory\./);
  assert.match(prompt, /"type":"tool_calls"/);
  assert.match(prompt, /"name":"shell"/);
  assert.match(prompt, /TOOL shell: Mem: 31Gi/);
});

test('finds the longest exact prompt prefix match', () => {
  const entries = [
    {
      signature: buildPromptSignature([
        { role: 'user', content: 'First turn' },
        { role: 'assistant', content: 'First reply' },
      ]),
    },
    {
      signature: buildPromptSignature([
        { role: 'system', content: 'You are helpful.' },
      ]),
    },
    {
      signature: buildPromptSignature([
        { role: 'user', content: 'First turn' },
        { role: 'assistant', content: 'First reply' },
        { role: 'user', content: 'Second turn' },
        { role: 'assistant', content: 'Second reply' },
      ]),
    },
  ];

  const match = findLongestExactPrefixMatch(
    entries,
    [
      { role: 'user', content: 'First turn' },
      { role: 'assistant', content: 'First reply' },
      { role: 'user', content: 'Second turn' },
      { role: 'assistant', content: 'Second reply' },
      { role: 'user', content: 'Third turn' },
    ],
    2,
  );

  assert.equal(match.entry, entries[2]);
  assert.equal(match.prefixMessages, 4);
  assert.equal(match.suffixMessages, 1);
});

test('returns a non-streaming OpenAI chat completion from the browser bridge', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Say hello.' }],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');

  socket.send(
    JSON.stringify({
      type: 'job-started',
      requestId: generateMessage.requestId,
    }),
  );
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: 'Hello from Chrome.',
      usage: {
        prompt_tokens: 5,
        completion_tokens: 4,
      },
    }),
  );

  const response = await requestPromise;
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'Hello from Chrome.');
  assert.equal(body.usage.total_tokens, 9);

  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
  const statusBody = await statusResponse.json();
  const completionLog = statusBody.logs.find(
    (entry) => entry.message === `Request completed: ${body.id}`,
  );
  assert.equal(completionLog.details.source, 'openai-chat');
  assert.equal(completionLog.details.stream, false);
  assert.equal(completionLog.details.toolsProvided, 0);
  assert.equal(completionLog.details.completionTokens, 4);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('records browser prompt-cache metrics in request logs', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [
        { role: 'user', content: 'First turn' },
        { role: 'assistant', content: 'First reply' },
        { role: 'user', content: 'Second turn' },
      ],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  assert.equal(generateMessage.payload.cache.enabled, true);
  assert.equal(generateMessage.payload.cache.minPrefixMessages, 2);

  socket.send(
    JSON.stringify({
      type: 'job-started',
      requestId: generateMessage.requestId,
      usage: {
        prompt_tokens: 7,
        context_window: 9216,
        trimmed_messages: 0,
        cache_hit: true,
        cache_prefix_messages: 2,
        cache_suffix_messages: 1,
        cache_entries: 3,
      },
    }),
  );
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: 'Second reply',
      usage: {
        prompt_tokens: 7,
        completion_tokens: 3,
        cache_hit: true,
        cache_prefix_messages: 2,
        cache_suffix_messages: 1,
        cache_entries: 4,
        cache_stored: true,
      },
    }),
  );

  const response = await requestPromise;
  assert.equal(response.status, 200);

  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
  const statusBody = await statusResponse.json();
  const startLog = statusBody.logs.find((entry) => entry.message === `Browser started request: ${generateMessage.requestId}`);
  const completionLog = statusBody.logs.find((entry) => entry.message === `Request completed: ${generateMessage.requestId}`);

  assert.equal(startLog.details.cacheHit, true);
  assert.equal(startLog.details.cachePrefixMessages, 2);
  assert.equal(startLog.details.cacheSuffixMessages, 1);
  assert.equal(startLog.details.cacheEntries, 3);
  assert.equal(completionLog.details.cacheHit, true);
  assert.equal(completionLog.details.cachePrefixMessages, 2);
  assert.equal(completionLog.details.cacheSuffixMessages, 1);
  assert.equal(completionLog.details.cacheEntries, 4);
  assert.equal(completionLog.details.cacheStored, true);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('streams SSE chat completion chunks from the browser bridge', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const responsePromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Count to three.' }],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');

  socket.send(JSON.stringify({ type: 'job-started', requestId: generateMessage.requestId }));
  socket.send(JSON.stringify({ type: 'job-chunk', requestId: generateMessage.requestId, delta: 'One, ' }));
  socket.send(JSON.stringify({ type: 'job-chunk', requestId: generateMessage.requestId, delta: 'two, ' }));
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: 'One, two, three.',
      usage: {
        prompt_tokens: 6,
        completion_tokens: 4,
      },
    }),
  );

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

  const body = await response.text();
  assert.match(body, /"role":"assistant"/);
  assert.match(body, /"content":"One, "/);
  assert.match(body, /"content":"two, "/);
  assert.match(body, /"content":"three\."/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.match(body, /"total_tokens":10/);
  assert.match(body, /\[DONE\]/);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('streams the final response text when the browser sends no intermediate chunks', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const responsePromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: 'user', content: 'Say one sentence.' }],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');

  socket.send(JSON.stringify({ type: 'job-started', requestId: generateMessage.requestId }));
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: 'Only the final response arrived.',
      usage: {
        prompt_tokens: 5,
        completion_tokens: 8,
      },
    }),
  );

  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

  const body = await response.text();
  assert.match(body, /"role":"assistant"/);
  assert.match(body, /"content":"Only the final response arrived\."/);
  assert.match(body, /"finish_reason":"stop"/);
  assert.match(body, /"total_tokens":13/);
  assert.match(body, /\[DONE\]/);

  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
  const statusBody = await statusResponse.json();
  const completionLog = statusBody.logs.find(
    (entry) => entry.message === `Request completed: ${generateMessage.requestId}`,
  );
  assert.equal(completionLog.details.outputChars, 'Only the final response arrived.'.length);
  assert.equal(completionLog.details.completionTokens, 8);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('keeps multi-turn chat history on the server for the hosted page', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/chat/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const createdSession = await createResponse.json();
  const sessionId = createdSession.session.id;

  const firstTurn = fetch(`http://127.0.0.1:${port}/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: 'First turn' }),
  });

  const firstGenerate = await onceMessage(socket, (payload) => payload.type === 'generate');
  assert.equal(firstGenerate.payload.messages.length, 1);
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: firstGenerate.requestId,
      text: 'First reply',
      usage: {
        prompt_tokens: 2,
        completion_tokens: 2,
      },
    }),
  );
  await firstTurn;

  const secondTurn = fetch(`http://127.0.0.1:${port}/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: 'Second turn' }),
  });

  const secondGenerate = await onceMessage(socket, (payload) => payload.type === 'generate');
  assert.equal(secondGenerate.payload.messages.length, 3);
  assert.deepEqual(
    secondGenerate.payload.messages.map((message) => message.content),
    ['First turn', 'First reply', 'Second turn'],
  );
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: secondGenerate.requestId,
      text: 'Second reply',
      usage: {
        prompt_tokens: 4,
        completion_tokens: 2,
      },
    }),
  );

  const finalResponse = await secondTurn;
  const finalPayload = await finalResponse.json();
  assert.equal(finalPayload.session.messages.length, 4);
  assert.equal(finalPayload.session.messages[3].content, 'Second reply');

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('streams hosted chat responses and persists the assistant message', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const createResponse = await fetch(`http://127.0.0.1:${port}/api/chat/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: '{}',
  });
  const createdSession = await createResponse.json();
  const sessionId = createdSession.session.id;

  const streamResponsePromise = fetch(`http://127.0.0.1:${port}/api/chat/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ content: 'Give me a list', stream: true }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(JSON.stringify({ type: 'job-chunk', requestId: generateMessage.requestId, delta: '- one\n' }));
  socket.send(JSON.stringify({ type: 'job-chunk', requestId: generateMessage.requestId, delta: '- two' }));
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: '- one\n- two',
      usage: {
        prompt_tokens: 4,
        completion_tokens: 3,
      },
    }),
  );

  const response = await streamResponsePromise;
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') || '', /text\/event-stream/);

  const body = await response.text();
  assert.match(body, /"type":"assistant-start"/);
  assert.match(body, /"type":"assistant-delta","delta":"- one\\n"/);
  assert.match(body, /"type":"assistant-delta","delta":"- two"/);
  assert.match(body, /"type":"assistant-complete"/);
  assert.match(body, /\[DONE\]/);

  const sessionResponse = await fetch(`http://127.0.0.1:${port}/api/chat/sessions/${sessionId}`);
  const sessionPayload = await sessionResponse.json();
  assert.equal(sessionPayload.session.messages.length, 2);
  assert.equal(sessionPayload.session.messages[1].content, '- one\n- two');

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('returns OpenAI-style tool calls when tools are provided', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Run free -h and tell me the result.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'run_shell_command',
            description: 'Run a shell command on the host.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  assert.match(generateMessage.payload.promptText, /run_shell_command/);
  assert.equal(generateMessage.payload.cache.enabled, true);
  assert.equal(generateMessage.payload.cache.awaitServerStore, true);
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: JSON.stringify({
        type: 'tool_calls',
        tool_calls: [
          {
            name: 'run_shell_command',
            arguments: {
              command: 'free -h',
            },
          },
        ],
      }),
      usage: {
        prompt_tokens: 12,
        completion_tokens: 8,
      },
    }),
  );

  const response = await requestPromise;
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.role, 'assistant');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'run_shell_command');
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"command":"free -h"}');

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('accepts Goose-style fenced tool call arrays', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Can you run free -h?' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run a shell command.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: '```tool_calls```\n```json\n[\n  {"name":"shell","arguments":{"command":"free -h"}}\n]\n```',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 6,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'shell');
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"command":"free -h"}');

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('accepts single-object shorthand tool calls', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Check disk usage.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run a shell command.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: '{"type":"shell","arguments":{"command":"df -h"}}',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'shell');
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"command":"df -h"}');

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('coerces shorthand string tool arguments into JSON object parameters', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Check the disk device.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run a shell command.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: '{"type":"shell","arguments":"df -h /dev/vdb"}',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'shell');
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, '{"command":"df -h /dev/vdb"}');

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('biases file-creation requests toward write instead of shell', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [
        {
          role: 'user',
          content: 'Write a Python script and add a second test file.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'write',
            description: 'Write a file.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        },
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run a shell command.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  assert.match(generateMessage.payload.promptText, /prefer the "write" tool instead of "shell"/i);
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: '{"type":"write","arguments":{"path":"/tmp/example.py","content":"print(1)"}}',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'write');

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('retries malformed tool-call-shaped output once before falling back to text', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Write a file to /tmp/example.py.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'write',
            description: 'Write a file.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        },
      ],
    }),
  });

  const firstGenerate = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: firstGenerate.requestId,
      text: '{"type":"tool_calls","tool_calls":[{"arguments":{"path":"/tmp/example.py","content":"print(1)"}}]}',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 6,
      },
    }),
  );

  const secondGenerate = await onceMessage(socket, (payload) => payload.type === 'generate');
  assert.match(secondGenerate.payload.promptText, /could not be parsed or matched/i);
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: secondGenerate.requestId,
      text: '{"type":"write","arguments":{"path":"/tmp/example.py","content":"print(1)"}}',
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'write');

  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
  const statusBody = await statusResponse.json();
  const malformedLog = statusBody.logs.find((entry) => entry.message === `Could not normalize tool calls for ${firstGenerate.requestId}`);
  const retryLog = statusBody.logs.find((entry) => entry.message === `Retrying malformed tool response for ${firstGenerate.requestId}`);
  assert.ok(malformedLog);
  assert.ok(retryLog);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('recovers escaped stringified tool JSON with local repairs before regenerating', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Write a file to /tmp/example.py.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'write',
            description: 'Write a file.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        },
      ],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: '"{\\"type\\":\\"write\\",\\"arguments\\":{\\"path\\":\\"/tmp/example.py\\",\\"content\\":\\"print(1)\\"}}"',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 6,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'write');

  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
  const statusBody = await statusResponse.json();
  const recoveryLog = statusBody.logs.find(
    (entry) => entry.message === `Recovered tool response locally for ${generateMessage.requestId}`,
  );
  assert.ok(recoveryLog);
  assert.equal(recoveryLog.details.localRepairCount, 1);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('recovers write tool calls with unescaped inner quotes', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Write hello.py with a hello world print statement.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'write',
            description: 'Write a file.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        },
      ],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: '{"type":"tool_calls","tool_calls":[{"name":"write","arguments":{"path":"hello.py","content":"print("Hello, world!")"}}]}}',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'write');
  assert.equal(
    body.choices[0].message.tool_calls[0].function.arguments,
    '{"path":"hello.py","content":"print(\\"Hello, world!\\")"}',
  );

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('retries malformed tool-call-shaped output up to a second repair generation', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Write a file to /tmp/example.py.' }],
      tools: [
        {
          type: 'function',
          function: {
            name: 'write',
            description: 'Write a file.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string' },
                content: { type: 'string' },
              },
              required: ['path', 'content'],
            },
          },
        },
      ],
    }),
  });

  const firstGenerate = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: firstGenerate.requestId,
      text: '{"type":"tool_calls","tool_calls":[{"arguments":{"path":"/tmp/example.py","content":"print(1)"}}]}',
      usage: {
        prompt_tokens: 10,
        completion_tokens: 6,
      },
    }),
  );

  const secondGenerate = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: secondGenerate.requestId,
      text: '{"type":"tool_calls","tool_calls":[{"arguments":{"path":"/tmp/example.py","content":"print(1)"}}]}',
      usage: {
        prompt_tokens: 12,
        completion_tokens: 6,
      },
    }),
  );

  const thirdGenerate = await onceMessage(socket, (payload) => payload.type === 'generate');
  assert.match(thirdGenerate.payload.promptText, /could not be parsed or matched/i);
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: thirdGenerate.requestId,
      text: '{"type":"write","arguments":{"path":"/tmp/example.py","content":"print(1)"}}',
      usage: {
        prompt_tokens: 14,
        completion_tokens: 4,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'tool_calls');
  assert.equal(body.choices[0].message.tool_calls[0].function.name, 'write');

  const statusResponse = await fetch(`http://127.0.0.1:${port}/api/status`);
  const statusBody = await statusResponse.json();
  const retryLogs = statusBody.logs.filter((entry) => entry.message === `Retrying malformed tool response for ${firstGenerate.requestId}`);
  assert.equal(retryLogs.length, 1);
  assert.equal(retryLogs[0].details.normalizationErrors[0].reason, 'missing_tool_name');
  const secondRetryLog = statusBody.logs.find((entry) => entry.message === `Retrying malformed tool response for ${secondGenerate.requestId}`);
  assert.ok(secondRetryLog);
  assert.equal(secondRetryLog.details.attempt, 2);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('retries once when the model repeats an already-executed tool call', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [
        { role: 'user', content: 'Can you check my disk usage too?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_existing',
              type: 'function',
              function: {
                name: 'shell',
                arguments: '{"command":"df -h"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_existing',
          name: 'shell',
          content: 'Filesystem      Size  Used Avail Use% Mounted on\n/dev/vdc 128G 68G 58G 54% /',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run a shell command.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
    }),
  });

  const firstGenerate = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: firstGenerate.requestId,
      text: '{"type":"shell","arguments":{"command":"df -h"}}',
      usage: {
        prompt_tokens: 14,
        completion_tokens: 4,
      },
    }),
  );

  const secondGenerate = await onceMessage(socket, (payload) => payload.type === 'generate');
  assert.match(secondGenerate.payload.promptText, /Do not call the same tool again/);
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: secondGenerate.requestId,
      text: 'Your root filesystem is 54% full, with about 58G available.',
      usage: {
        prompt_tokens: 16,
        completion_tokens: 6,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.match(body.choices[0].message.content, /54% full/);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('salvages malformed wrapped final answers in tool mode', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [
        { role: 'user', content: 'Can you check my free memory and disk?' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_existing',
              type: 'function',
              function: {
                name: 'shell',
                arguments: '{"command":"free -m; df -h"}',
              },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call_existing',
          name: 'shell',
          content: 'Mem: 13980 total, 11318 available. Root filesystem is 54% full with 58G available.',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'shell',
            description: 'Run a shell command.',
            parameters: {
              type: 'object',
              properties: {
                command: { type: 'string' },
              },
              required: ['command'],
            },
          },
        },
      ],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-complete',
      requestId: generateMessage.requestId,
      text: '{"type":"final","content":"You have about 11 GiB of RAM available, and your root disk is 54% full with around 58G free."}',
      usage: {
        prompt_tokens: 18,
        completion_tokens: 10,
      },
    }),
  );

  const response = await requestPromise;
  const body = await response.json();
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.match(body.choices[0].message.content, /11 GiB/);
  assert.doesNotMatch(body.choices[0].message.content, /^\{"type":"final"/);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('surfaces context-length errors from the browser bridge', async () => {
  const bridgeServer = createBridgeServer();
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const requestPromise = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'Huge prompt' }],
    }),
  });

  const generateMessage = await onceMessage(socket, (payload) => payload.type === 'generate');
  socket.send(
    JSON.stringify({
      type: 'job-error',
      requestId: generateMessage.requestId,
      error: 'The input is too large. requested 131000 tokens for a 128000-token window.',
      code: 'context_length_exceeded',
      details: {
        requestedTokens: 131000,
        contextWindow: 128000,
        trimmedMessages: 12,
      },
    }),
  );

  const response = await requestPromise;
  assert.equal(response.status, 400);

  const body = await response.json();
  assert.equal(body.error.code, 'context_length_exceeded');
  assert.match(body.error.message, /128000-token window/);

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});

test('supports configuring a shorter request timeout', async () => {
  const bridgeServer = createBridgeServer({ requestTimeoutMs: 20 });
  await bridgeServer.listen(0);
  const { port } = bridgeServer.server.address();

  const socket = new WebSocket(`ws://127.0.0.1:${port}/bridge`);
  await onceOpen(socket);
  await readyBridge(socket);

  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'chrome-prompt-api',
      messages: [{ role: 'user', content: 'This should time out.' }],
    }),
  });

  assert.equal(response.status, 504);
  const body = await response.json();
  assert.equal(body.error.code, 'timeout_error');

  const closed = onceClose(socket);
  socket.close();
  await closed;
  await bridgeServer.close();
});
