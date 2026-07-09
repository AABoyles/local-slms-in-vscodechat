# Local SLMs for VS Code

Run small language models — Gemma, Phi, Qwen, SmolLM, Llama 3.2, and friends — **entirely inside VS Code**, no server, no API key, no network round-trip once a model is downloaded. Local SLMs downloads MLC-compiled model weights on demand and runs them with [WebLLM](https://github.com/mlc-ai/web-llm) over **WebAssembly + WebGPU**, then exposes them as a **Local SLMs** provider in the Copilot Chat model picker so you can chat with them like any other model.

## Why

Everything runs on your machine: no data leaves your editor, there's no API bill, and it keeps working offline after the first download. The tradeoff is that quality and speed depend on your local GPU — this is meant for small (≲4B parameter) models, not a replacement for a frontier hosted model.

## Requirements

- **VS Code 1.104+** (the `languageModelChatProviders` API this extension uses).
- **WebGPU support** in VS Code's underlying Chromium/Electron. Most recent desktop VS Code builds on Windows, macOS, and Linux support this out of the box. If Local SLMs reports "WebGPU unavailable", update VS Code — there's no CPU-only fallback, since WebGPU is what actually executes the model's tensor ops (the WASM module handles tokenization and control flow around it).
- A GPU with enough VRAM for whatever model you pick — the model picker shows an approximate VRAM requirement for each entry.
- Enough disk space to cache the model(s) you download (roughly 1–3 GB per small model, quantized).

## Getting started

1. Install the extension.
2. Open the Copilot Chat view and open the model picker — you'll see a **Local SLMs** section.
3. Pick a model. The first message you send to it triggers a download (with a progress notification); after that it's cached and loads instantly.
4. Keep chatting. Everything after the download runs locally.

You can also manage models proactively from the Command Palette:

- **Local SLMs: Download Model...** — pick a model to fetch ahead of time.
- **Local SLMs: Show Engine Panel** — see WebGPU status and a live log of what the engine is doing.
- **Local SLMs: Clear Downloaded Models...** — free up disk space.

## About "Gemma e2b/e4b"

Gemma's "effective parameter" variants (E2B/E4B-style naming) show up in WebLLM's model catalog as soon as MLC publishes WebGPU-compiled weights for them — this extension queries that catalog live, so new Gemma releases appear automatically without an extension update, as long as they fit under the size threshold below (or you add them explicitly, see [Custom and larger models](#custom-and-larger-models)). If a given Gemma variant hasn't been compiled for WebLLM yet, it simply won't be in the list until it is.

## How it works

VS Code extensions run in a plain Node.js host, which has no access to WebGPU or a browser's WebAssembly execution environment. Local SLMs works around this by running the actual model — WebLLM, backed by `@mlc-ai/web-llm` — inside a hidden/background **webview** (a real Chromium context), and talking to it over `postMessage` from the extension host. The webview:

- Detects WebGPU and reports adapter info.
- Reads WebLLm's live prebuilt model catalog (`prebuiltAppConfig`) so the "Local SLMs" list always reflects what WebLLM currently supports.
- Downloads and caches model weights in the browser's Cache API (configurable — see below), so re-launching VS Code doesn't re-download anything.
- Streams generated tokens back to the extension host, which forwards them into the Copilot Chat response stream.

The **Local SLMs Engine** panel (`Local SLMs: Show Engine Panel`) is that webview made visible — it shows WebGPU status, download progress, and a log, and can be closed without stopping in-flight work as long as you don't close the whole editor window (VS Code keeps it retained in the background via `retainContextWhenHidden`).

## Which models show up

By default, the model picker only offers WebLLM's prebuilt models estimated at **4.5B parameters or smaller** (parsed from the model id, e.g. `gemma-2-2b-it` → 2B, `gemma-3n-E4B-it` → 4B effective params, `SmolLM2-360M-Instruct` → 0.36B). This keeps the picker focused on models that are actually practical to run interactively in an editor.

### Custom and larger models

Two settings let you go beyond the default list:

- `localSlms.maxModelSizeBillionParams` (default `4.5`) — raise this to surface bigger prebuilt WebLLM models.
- `localSlms.customModels` — an array of specific WebLLM prebuilt model ids to always include, regardless of size (e.g. `"gemma-2-9b-it-q4f16_1-MLC"`). Browse available ids in the [MLC model catalog](https://webllm.mlc.ai) or via `@mlc-ai/web-llm`'s `prebuiltAppConfig.model_list`.

### Cache backend

`localSlms.cacheBackend` controls where the webview stores downloaded weights: `cache` (browser Cache API, default and best-tested), `indexeddb`, or `opfs` (Origin Private File System). See WebLLM's docs if you're not sure which to pick — `cache` is fine for most setups.

## Limitations

- **No tool calling / function calling and no image input.** These are small text models; the provider advertises `toolCalling: false` and `imageInput: false` accordingly.
- **Token counts are estimated**, not exact — `provideTokenCount` uses a ~4-characters-per-token heuristic rather than round-tripping through the model's real tokenizer.
- **One model loaded at a time.** Switching models triggers a reload (fast once weights are cached, since only re-initialization is needed).
- **Cancelling mid-download doesn't abort the download.** Cancelling an in-flight chat request stops generation immediately; cancelling while a model is still downloading just stops waiting on the VS Code side — the webview keeps fetching in the background so a later request doesn't restart from scratch.
- Quality and speed depend entirely on local hardware. A 2–4B quantized model on a laptop GPU is not going to match a frontier hosted model.

## Development

```bash
npm install
npm run watch     # esbuild in watch mode
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host with the extension loaded.

```bash
npm run check-types   # tsc --noEmit
npm run lint           # eslint
npm run package         # production build (dist/)
```

## License

[MIT](./LICENSE)
