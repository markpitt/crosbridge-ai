# crosbridge-ai

🚀 OpenAI-compatible local bridge from **ChromeOS Prompt API** to **Crostini apps**.

`crosbridge-ai` lets Linux tools inside Crostini talk to Chrome's on-device model through a normal local OpenAI-style API. That means existing clients such as Goose can use ChromeOS edge AI, including the device's on-device acceleration path, without needing a custom provider or a heavyweight local model runtime.

## ✨ Why this exists

Chrome can access the built-in Prompt API and the device's on-device AI acceleration path, but Crostini apps cannot use that path directly. In practice, this means Chrome can reach hardware-backed inference such as the NPU while the Linux container cannot. This bridge fills that gap:

- Chrome hosts the model session
- Crostini gets `POST /v1/chat/completions` and `GET /v1/models`
- responses stream over a local WebSocket bridge
- the hosted page shows status, logs, and a simple chat UI

## 🧠 How it works

1. Run the Node server in Crostini.
2. It opens a page in ChromeOS.
3. That page connects back to the server over WebSocket.
4. OpenAI-style requests sent to the local server are forwarded to Chrome.
5. Chrome runs `LanguageModel.create()` and streams the result back.

The OpenAI endpoint is intentionally **stateless**: each request creates a fresh browser-side model session.

## 📋 Requirements

- ChromeOS
- Chrome with the Prompt API flags enabled
- Node.js 24+ in Crostini

## ⚡ Quick start

### 1. 🏁 Enable the Chrome flags

Open `chrome://flags` and enable:

- `#optimization-guide-on-device-model`
- `#prompt-api-for-gemini-nano-multimodal-input`

Then restart Chrome.

Text-only use does not require multimodal input, but enabling both matches the current experimental Prompt API setup many ChromeOS builds expect.

### 2. 📦 Download the on-device model

The most reliable way to trigger model download is to call `LanguageModel.create()` once in Chrome.

Open Chrome DevTools on any page and run:

```js
(async () => {
  const session = await LanguageModel.create({
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => {
        const percent = Math.round((e.loaded / e.total) * 100);
        console.log(`Downloading Gemini Nano: ${percent}%`);
      });
    },
  });
  console.log('Model ready.');
  await session.destroy();
})();
```

You may also see related activity in `chrome://components/`, but the snippet above is the simplest reliable trigger.

### 3. 🔧 Install the bridge

Inside Crostini:

```bash
npm install
```

### 4. ▶️ Start the bridge

```bash
npm start
```

By default the bridge:

- listens on `127.0.0.1:8787`
- opens the hosted page automatically with `xdg-open`
- serves the dashboard, browser bridge, and OpenAI API from the same port

Useful options:

```bash
node src/server.js --no-open
node src/server.js --port 8787 --no-open
node src/server.js --timeout-ms 300000
```

You can also set the timeout with:

```bash
REQUEST_TIMEOUT_MS=300000 npm start
```

### 5. 🪿 Point Goose at it

Goose is just one lightweight example of an OpenAI-compatible client that works well with this bridge.

- **Goose docs:** `https://goose-docs.ai`
- **Base URL:** `http://127.0.0.1:8787`
- **Model:** `chrome-prompt-api`
- **API key:** `anything`

For Goose, the important bits are:

- disable the bundled tools you do not want
- keep `developer` enabled if you want shell and file editing
- set `GOOSE_PROVIDER=openai`
- set `GOOSE_MODEL=chrome-prompt-api`
- set `OPENAI_BASE_URL=http://127.0.0.1:8787`
- set `OPENAI_API_KEY=anything`

For this Prompt API backend, a small context limit is important. A practical Goose launch looks like:

```bash
GOOSE_CONTEXT_LIMIT=9216 \
GOOSE_AUTO_COMPACT_THRESHOLD=0.5 \
GOOSE_CONTEXT_STRATEGY=summarize \
GOOSE_TOOL_CALL_CUTOFF=5 \
goose
```

Notes:

- `GOOSE_CONTEXT_LIMIT=9216` matches a real Prompt API context window seen on this setup
- `GOOSE_AUTO_COMPACT_THRESHOLD=0.5` is a safer default than `0.6` for a ~9k window
- `GOOSE_CLI_SHOW_THINKING=1` is optional and usually not especially useful here

## 🧪 Smoke test

Once the hosted page says the browser bridge is ready:

```bash
curl http://127.0.0.1:8787/v1/models
```

and:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer local" \
  -d '{
    "model": "chrome-prompt-api",
    "stream": true,
    "messages": [
      {"role": "system", "content": "You are concise."},
      {"role": "user", "content": "What do you know about the Django ORM?"}
    ]
  }'
```

## 🎯 Features

- OpenAI-compatible `POST /v1/chat/completions`
- OpenAI-compatible `GET /v1/models`
- SSE streaming and non-streaming responses
- OpenAI-style `tools` / `tool_calls`
- tolerant parsing for a few non-standard tool-call output shapes seen in practice
- hosted browser dashboard with logs and stats
- simple server-backed multi-turn chat UI
- terminal logging with request metrics

## 🚧 Future improvement

Chrome's web Prompt API currently supports the base model session path used by this bridge, but native browser-side Prompt API tool use is not yet reliably available in this localhost web setup. When that changes, the best next step is to move tool execution into the browser-side Prompt API session and keep that session alive across OpenAI tool round trips.

See [`TODO.md`](./TODO.md) for the deferred design, wire protocol, resume logic, fallback requirements, and test plan needed to rebuild that implementation.

## 🔌 API notes

Supported request fields on `chat.completions`:

- `model`
- `messages`
- `stream`
- `stream_options.include_usage`
- `tools`
- `tool_choice`

Unsupported OpenAI fields are currently ignored.

## 🛠️ Operational notes

- Each OpenAI request creates a fresh browser-side `LanguageModel` session.
- The actual context window comes from the browser model, not the OpenAI client.
- On some ChromeOS Prompt API models, the real window may be much smaller than clients expect.
- Usage values are estimated from character counts when the browser does not provide more detailed information.
- The default browser-generation timeout is 5 minutes.
- If the browser page disconnects, in-flight requests fail immediately.
- Hosted chat history lives only in memory for the lifetime of the process.
