---
name: image-describe
description: Inspect and describe images/screenshots sent via Telegram or local paths. Prioritizes native multimodal vision (`read` tool) when the current model supports images; automatically falls back to Gemma 4 26B via OpenRouter only for text-only models (e.g. DeepSeek, GLM).
---

# Image Describe & Vision Routing

## When to use

The user sent an image via Telegram or asked to inspect an image file (e.g. `inboxDir/.../*.jpg|png|gif|webp`).
Trigger phrases: "看这张图", "这张截图是什么", "识图", "what's in this image", "describe this", or any message referencing an image path in Telegram inbox or local filesystem.

## Core Principle: Native Vision First, Fallback Second

**DO NOT blindly call fallback vision!** If the current conversational model already supports multimodal image input (e.g. Gemini 3.7 Flash, Claude Sonnet, GPT-5.6), calling a small fallback model is a severe downgrade ("纯纯负提升").

### Decision Tree

1. **Check if the current model supports multimodal / image input**:
   - Inspect `$PI_MODEL` / `$PI_PROVIDER` or check `models.json` in `agentDir` (`input` array contains `"image"`).
   - **Multimodal models include**:
     - `gemini-3.7-flash-high` / `gemini-*` (Antigravity / Google)
     - `claude-sonnet-5` / `claude-*` (Anthropic)
     - `gpt-5.6-sol` / `gpt-5.6-luna` / `gpt-4o` (OpenAI / Codex)
   - **Text-only models include**:
     - `DeepSeek-V4-Flash` / `deepseek-*`
     - `GLM-5.2` / `glm-*`
     - `kimi-k3` / `moonshot-*`

2. **Branch A — Current model supports Vision (Multimodal)**:
   - **Action**: Call the built-in `read` tool directly on the image path:
     ```json
     read({ "path": "/var/lib/pi-tg/inbox/.../photo_1234.jpg" })
     ```
   - The `read` tool automatically reads the binary, detects the MIME type, base64-encodes the image, and attaches it into the conversation context.
   - You can then directly see and analyze the image in full fidelity with your native multimodal capabilities.
   - **DO NOT call `describe.sh` or fallback vision in this case.**

3. **Branch B — Current model is Text-Only**:
   - **Action**: Use the fallback describe script in this skill directory:
     ```bash
     bash <skill_dir>/scripts/describe.sh "<image-path>" "[optional custom question]"
     ```
   - This sends the image to Google Gemma 4 26B (`google/gemma-4-26b-a4b-it:free`) on OpenRouter to extract textual descriptions, OCR text, or table data.
   - Use Gemma's text output to answer the user's question.

## Procedure Details

### Step 1 — Find the image path

If the prompt includes an image path (such as under `inboxDir` or local path), use it directly.
Otherwise check the inbox directory configured for Telegram media.

### Step 2 — Route by capability

- **Multimodal model** -> `read({ path: "<image-path>" })`
- **Text-only model** -> `bash <skill_dir>/scripts/describe.sh "<image-path>" "[optional custom question]"`

### Step 3 — Answer the user

Answer the user's specific question (e.g. summary, OCR, bug analysis, data extraction) concisely in Chinese.

## Fallback Details (for text-only models)

- **Script**: `scripts/describe.sh`
- **Model**: `google/gemma-4-26b-a4b-it:free` via OpenRouter.
- **Key location**: `auth.json` in `agentDir` (`openrouter.key` or `openrouter.apiKey`), or `OPENROUTER_API_KEY` environment variable.
- **Rate limits**: 5–20 RPM on free tier. If 429 occurs, retry after a few seconds.
