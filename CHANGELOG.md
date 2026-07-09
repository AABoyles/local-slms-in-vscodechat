# Changelog

## 0.1.0

Initial release.

- Registers a **Local SLMs** provider in the Copilot Chat model picker via `vscode.lm.registerLanguageModelChatProvider`.
- Runs models locally with [WebLLM](https://github.com/mlc-ai/web-llm) (`@mlc-ai/web-llm`) over WebAssembly + WebGPU, inside a background webview.
- Live-queries WebLLM's prebuilt model catalog and surfaces small models (Gemma, Phi, Qwen, SmolLM, Llama 3.2, ≲4.5B params by default) — configurable via `localSlms.maxModelSizeBillionParams` and `localSlms.customModels`.
- Streams chat responses back into Copilot Chat, with download/load progress reported through VS Code's progress notifications.
- Adds commands: `Local SLMs: Download Model...`, `Local SLMs: Show Engine Panel`, `Local SLMs: Clear Downloaded Models...`.
