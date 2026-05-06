import { marked } from '/vendor/marked/marked.esm.js';

const connectionPill = document.querySelector('#connection-pill');
const promptPill = document.querySelector('#prompt-pill');
const browserStatus = document.querySelector('#browser-status');
const promptStatus = document.querySelector('#prompt-status');
const activeRequests = document.querySelector('#active-requests');
const completedRequests = document.querySelector('#completed-requests');
const failedRequests = document.querySelector('#failed-requests');
const wordsIn = document.querySelector('#words-in');
const wordsOut = document.querySelector('#words-out');
const tokensIn = document.querySelector('#tokens-in');
const tokensOut = document.querySelector('#tokens-out');
const totalRequests = document.querySelector('#total-requests');
const logs = document.querySelector('#logs');
const chatMessages = document.querySelector('#chat-messages');
const chatForm = document.querySelector('#chat-form');
const chatInput = document.querySelector('#chat-input');
const chatSend = document.querySelector('#chat-send');
const newChatButton = document.querySelector('#new-chat');

const state = {
  localLogs: [],
  chatSession: null,
  chatBusy: false,
  serverLogs: [],
};

const COMPLETION_RESERVE_TOKENS = 4096;

marked.setOptions({
  gfm: true,
  breaks: true,
});

function countWords(text = '') {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function estimateTokens(text = '') {
  return Math.ceil(text.length / 4);
}

function flattenContent(content) {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        if (part?.type === 'text' && typeof part.text === 'string') {
          return part.text;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function buildPrompt(messages) {
  return messages
    .map((message) => `${String(message?.role || 'user').toUpperCase()}: ${flattenContent(message?.content)}`)
    .join('\n\n');
}

function escapeHtml(text) {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function renderLocalLogs(serverLogs = state.serverLogs) {
  state.serverLogs = serverLogs;
  const localLogLines = state.localLogs.map((entry) => `[${entry.ts}] LOCAL ${entry.message}`);
  const serverLogLines = serverLogs.map((entry) => {
    const detailSuffix = entry.details ? ` ${JSON.stringify(entry.details)}` : '';
    return `[${new Date(entry.ts).toLocaleTimeString()}] ${entry.level.toUpperCase()} ${entry.message}${detailSuffix}`;
  });

  logs.textContent = [...serverLogLines, ...localLogLines].slice(-60).join('\n');
}

function appendLog(message) {
  state.localLogs.push({
    ts: new Date().toLocaleTimeString(),
    message,
  });
  if (state.localLogs.length > 50) {
    state.localLogs.shift();
  }
  renderLocalLogs();
}

function setPill(element, text, kind) {
  element.textContent = text;
  element.className = `pill pill-${kind}`;
}

function setChatBusy(busy) {
  state.chatBusy = busy;
  chatInput.disabled = busy;
  chatSend.disabled = busy;
  newChatButton.disabled = busy;
}

function updateStats(payload) {
  const stats = payload?.stats || {};
  const browserConnected = Boolean(payload?.browserConnected);
  const promptApiAvailable = Boolean(payload?.browserInfo?.promptApiAvailable);

  browserStatus.textContent = browserConnected ? 'Connected' : 'Disconnected';
  promptStatus.textContent = browserConnected ? (promptApiAvailable ? 'Available' : 'Unavailable') : 'Unknown';

  setPill(connectionPill, browserConnected ? 'Connected' : 'Disconnected', browserConnected ? 'ok' : 'warn');
  setPill(
    promptPill,
    browserConnected ? (promptApiAvailable ? 'Prompt API ready' : 'Prompt API unavailable') : 'Prompt API unknown',
    browserConnected && promptApiAvailable ? 'ok' : 'warn',
  );

  activeRequests.textContent = String(stats.active || 0);
  completedRequests.textContent = String(stats.completed || 0);
  failedRequests.textContent = String(stats.failed || 0);
  wordsIn.textContent = String(stats.totalInputWords || 0);
  wordsOut.textContent = String(stats.totalOutputWords || 0);
  tokensIn.textContent = String(stats.totalInputTokens || 0);
  tokensOut.textContent = String(stats.totalOutputTokens || 0);
  totalRequests.textContent = String(stats.requests || 0);
  renderLocalLogs(payload?.logs || []);
}

function renderChat() {
  if (!state.chatSession?.messages?.length) {
    chatMessages.innerHTML =
      '<p class="chat-empty">Start a conversation. The server keeps the turn history and sends it as context for the next request.</p>';
    return;
  }

  chatMessages.innerHTML = state.chatSession.messages
    .map((message) => {
      const role = String(message.role || 'assistant');
      const content = flattenContent(message.content);
      const renderedContent =
        role === 'assistant'
          ? marked.parse(content)
          : `<div class="chat-plain">${escapeHtml(content).replaceAll('\n', '<br>')}</div>`;
      return `
        <article class="chat-message chat-message-${role}">
          <header>${escapeHtml(role)}</header>
          <div class="chat-body">${renderedContent}</div>
        </article>
      `;
    })
    .join('');
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload?.error?.message || 'Request failed.');
  }

  return payload;
}

async function requestStream(url, options, onEvent) {
  const response = await fetch(url, options);

  if (!response.ok) {
    const payload = await response.json();
    throw new Error(payload?.error?.message || 'Request failed.');
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Streaming response body is unavailable.');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done });

    const parts = buffer.split('\n\n');
    buffer = parts.pop() || '';

    for (const part of parts) {
      const dataLines = part
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6));

      if (!dataLines.length) {
        continue;
      }

      const data = dataLines.join('\n');
      if (data === '[DONE]') {
        return;
      }

      onEvent(JSON.parse(data));
    }

    if (done) {
      return;
    }
  }
}

async function ensureChatSession(forceNew = false) {
  const storageKey = 'localnanollm-chat-session-id';
  let sessionId = forceNew ? null : window.localStorage.getItem(storageKey);

  if (sessionId) {
    try {
      const payload = await requestJson(`/api/chat/sessions/${sessionId}`);
      state.chatSession = payload.session;
      renderChat();
      return;
    } catch {
      sessionId = null;
    }
  }

  const payload = await requestJson('/api/chat/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: '{}',
  });

  state.chatSession = payload.session;
  window.localStorage.setItem(storageKey, payload.session.id);
  renderChat();
}

function sendJson(socket, payload) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(payload));
  }
}

function extractDelta(accumulatedText, chunk) {
  if (!chunk) {
    return '';
  }

  if (chunk.startsWith(accumulatedText)) {
    return chunk.slice(accumulatedText.length);
  }

  return chunk;
}

function formatError(error) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function buildContextOverflowMessage(details) {
  const parts = ['The input is too large.'];

  if (Number.isFinite(details.requestedTokens) && Number.isFinite(details.contextWindow)) {
    parts.push(`requested ${details.requestedTokens} tokens for a ${details.contextWindow}-token window.`);
  }

  if (Number.isFinite(details.trimmedMessages) && details.trimmedMessages > 0) {
    parts.push(`Trimmed ${details.trimmedMessages} earlier messages before giving up.`);
  }

  return parts.join(' ');
}

async function preparePromptForSession(session, messages) {
  let workingMessages = [...messages];
  let promptText = buildPrompt(workingMessages);
  let measuredTokens =
    typeof session.measureContextUsage === 'function' ? await session.measureContextUsage(promptText) : estimateTokens(promptText);
  const contextWindow = Number.isFinite(session.contextWindow) ? session.contextWindow : null;
  const reserveTokens = contextWindow ? Math.min(COMPLETION_RESERVE_TOKENS, Math.max(1024, Math.floor(contextWindow * 0.1))) : COMPLETION_RESERVE_TOKENS;
  const limit = contextWindow ? Math.max(1, contextWindow - reserveTokens) : null;
  let trimmedMessages = 0;

  while (limit && measuredTokens > limit) {
    const trimIndex = workingMessages.findIndex((message, index) => index < workingMessages.length - 1 && message?.role !== 'system');
    if (trimIndex === -1) {
      break;
    }

    workingMessages.splice(trimIndex, 1);
    trimmedMessages += 1;
    promptText = buildPrompt(workingMessages);
    measuredTokens =
      typeof session.measureContextUsage === 'function' ? await session.measureContextUsage(promptText) : estimateTokens(promptText);
  }

  if (limit && measuredTokens > limit) {
    const overflowError = new Error(
      buildContextOverflowMessage({
        requestedTokens: measuredTokens,
        contextWindow,
        trimmedMessages,
      }),
    );
    overflowError.code = 'context_length_exceeded';
    overflowError.details = {
      requestedTokens: measuredTokens,
      contextWindow,
      trimmedMessages,
      reservedTokens: reserveTokens,
    };
    throw overflowError;
  }

  return {
    promptText,
    promptTokens: measuredTokens,
    contextWindow,
    trimmedMessages,
  };
}

async function runRequest(socket, message) {
  const { requestId, payload } = message;

  appendLog(`Starting request ${requestId}`);

  let session;
  let outputText = '';
  let firstChunkAt = null;
  let streamFallbackUsed = false;
  const startedAt = performance.now();

  try {
    if (!window.LanguageModel?.create) {
      throw new Error('window.LanguageModel.create() is not available in this browser.');
    }

    session = await window.LanguageModel.create();
    const preparedPrompt = await preparePromptForSession(session, payload.messages);
    const promptText = preparedPrompt.promptText;
    const promptWords = countWords(promptText);

    sendJson(socket, {
      type: 'job-started',
      requestId,
      usage: {
        prompt_words: promptWords,
        prompt_tokens: preparedPrompt.promptTokens,
        context_window: preparedPrompt.contextWindow,
        trimmed_messages: preparedPrompt.trimmedMessages,
      },
    });

    const stream = session.promptStreaming(promptText);

    for await (const chunk of stream) {
      const textChunk = String(chunk ?? '');
      const delta = extractDelta(outputText, textChunk);

      if (!delta) {
        continue;
      }

      if (firstChunkAt === null) {
        firstChunkAt = performance.now();
      }

      outputText += delta;
      sendJson(socket, {
        type: 'job-chunk',
        requestId,
        delta,
      });
    }

    if (!outputText && typeof session.prompt === 'function') {
      const fallbackText = String((await session.prompt(promptText)) ?? '');
      if (fallbackText) {
        outputText = fallbackText;
        streamFallbackUsed = true;
      }
    }

    const completionWords = countWords(outputText);
    const completionTokens = estimateTokens(outputText);

    sendJson(socket, {
      type: 'job-complete',
      requestId,
      text: outputText,
      usage: {
        prompt_words: promptWords,
        prompt_tokens: preparedPrompt.promptTokens,
        completion_words: completionWords,
        completion_tokens: completionTokens,
        context_window: preparedPrompt.contextWindow,
        trimmed_messages: preparedPrompt.trimmedMessages,
        stream_fallback_used: streamFallbackUsed,
      },
      timings: {
        total_ms: Math.round(performance.now() - startedAt),
        ttft_ms: firstChunkAt === null ? null : Math.round(firstChunkAt - startedAt),
      },
    });

    appendLog(
      `Completed ${requestId} (${completionWords} words, ~${completionTokens} completion tokens${
        firstChunkAt === null ? '' : `, TTFT ${Math.round(firstChunkAt - startedAt)} ms`
      }${streamFallbackUsed ? ', prompt() fallback' : ''})`,
    );
  } catch (error) {
    const messageText = formatError(error);
    sendJson(socket, {
      type: 'job-error',
      requestId,
      error: messageText,
      code: error?.code === 'context_length_exceeded' || error?.name === 'QuotaExceededError' ? 'context_length_exceeded' : undefined,
      details:
        error?.details ||
        (error?.name === 'QuotaExceededError'
          ? {
              requestedTokens: Number.isFinite(error.requested) ? error.requested : null,
              contextWindow: Number.isFinite(error.contextWindow) ? error.contextWindow : null,
              trimmedMessages: 0,
            }
          : undefined),
    });
    appendLog(`Request ${requestId} failed: ${messageText}`);
  } finally {
    if (typeof session?.destroy === 'function') {
      await session.destroy();
    }
  }
}

function connect() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/bridge`);

  socket.addEventListener('open', () => {
    appendLog('Connected to local bridge server');
    sendJson(socket, {
      type: 'browser-ready',
      userAgent: navigator.userAgent,
      promptApiAvailable: Boolean(window.LanguageModel?.create),
      location: window.location.href,
    });
  });

  socket.addEventListener('message', async (event) => {
    const payload = JSON.parse(event.data);

    if (payload.type === 'server-state') {
      updateStats(payload);
      return;
    }

    if (payload.type === 'server-log') {
      renderLocalLogs([...state.serverLogs.slice(-24), payload.entry]);
      return;
    }

    if (payload.type === 'generate') {
      await runRequest(socket, payload);
    }
  });

  socket.addEventListener('close', () => {
    updateStats({ browserConnected: false, browserInfo: null, stats: {}, logs: [] });
    appendLog('Disconnected from bridge server. Reconnecting in 2 seconds...');
    window.setTimeout(connect, 2000);
  });

  socket.addEventListener('error', () => {
    appendLog('WebSocket error from bridge server');
  });
}

chatForm.addEventListener('submit', async (event) => {
  event.preventDefault();

  const content = chatInput.value.trim();
  if (!content || !state.chatSession?.id || state.chatBusy) {
    return;
  }

  const previousMessages = state.chatSession.messages;
  state.chatSession = {
    ...state.chatSession,
    messages: [...previousMessages, { role: 'user', content }],
  };
  renderChat();
  chatInput.value = '';
  setChatBusy(true);

  try {
    let assistantMessage = null;

    await requestStream(`/api/chat/sessions/${state.chatSession.id}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content, stream: true }),
    }, (payload) => {
      if (payload.type === 'assistant-start') {
        assistantMessage = { role: 'assistant', content: '' };
        state.chatSession = {
          ...state.chatSession,
          messages: [...state.chatSession.messages, assistantMessage],
        };
        renderChat();
        return;
      }

      if (payload.type === 'assistant-delta') {
        if (!assistantMessage) {
          assistantMessage = { role: 'assistant', content: '' };
          state.chatSession = {
            ...state.chatSession,
            messages: [...state.chatSession.messages, assistantMessage],
          };
        }

        assistantMessage.content += payload.delta || '';
        state.chatSession = {
          ...state.chatSession,
          messages: [...state.chatSession.messages.slice(0, -1), assistantMessage],
        };
        renderChat();
        return;
      }

      if (payload.type === 'assistant-complete') {
        state.chatSession = payload.session;
        renderChat();
        return;
      }

      if (payload.type === 'error') {
        throw new Error(payload.error?.message || 'Chat streaming failed.');
      }
    });
  } catch (error) {
    state.chatSession = {
      ...state.chatSession,
      messages: previousMessages,
    };
    renderChat();
    appendLog(`Chat request failed: ${formatError(error)}`);
  } finally {
    setChatBusy(false);
  }
});

newChatButton.addEventListener('click', async () => {
  if (state.chatBusy) {
    return;
  }

  setChatBusy(true);
  try {
    await ensureChatSession(true);
    appendLog('Started a new local chat session');
  } catch (error) {
    appendLog(`Failed to start a new chat session: ${formatError(error)}`);
  } finally {
    setChatBusy(false);
  }
});

appendLog('Opening browser bridge...');
connect();
ensureChatSession().catch((error) => {
  appendLog(`Failed to initialize local chat: ${formatError(error)}`);
});
