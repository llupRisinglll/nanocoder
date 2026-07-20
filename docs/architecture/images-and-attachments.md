---
title: "Images and Attachments"
description: "How Nanocoder sends images and files to vision-capable models"
sidebar_order: 3
---

# Images and Attachments (Under the Hood)

This page explains how Nanocoder prepares images and file attachments before
sending them to the AI model. For user-facing instructions (how to paste,
drag, and manage attachments), see [Image Attachments](../features/image-attachments.md).

## Why this matters

Some AI models can "see" images. Claude, GPT-4o, and Gemini all support
vision. But each provider expects images in a slightly different format, and
sending the wrong format (or an image that is too large) will cause the
request to fail.

Nanocoder handles these differences automatically. Here is what it does:

## The three things Nanocoder handles

| Problem | How Nanocoder handles it |
|---|---|
| **Images that are too large** | Drops images over 4 MB (base64) and adds a text note so the model knows an image was removed |
| **Different detail levels** | Sends `imageDetail: 'auto'` so the provider picks the right resolution (high for detail, low for speed) |
| **Non-image files (PDFs, docs)** | Sends them as file parts instead of image parts, so Claude can read PDFs |

## How images travel to the model

When you attach an image and send a message, here is what happens:

```
You paste an image
       ↓
Nanocoder reads the file and stores it as base64 data
       ↓
When you submit your message, the image is attached to it
       ↓
The message converter checks each attachment:
  - Is it an image (PNG/JPEG/GIF/WebP)?
    → Yes: create an image part with imageDetail: 'auto'
    → No: create a file part (for PDFs, docs, etc.)
  - Is it over 4 MB?
    → Yes: drop it and add a "[image omitted: too large]" note
       ↓
The AI SDK sends the message with text + image/file parts to the provider
       ↓
The provider processes the image and returns a response
```

## Image detail levels

Different models can look at images at different levels of detail. A high
detail level means the model sees the image clearly but uses more tokens
(costs more). A low detail level is cheaper but less precise.

Nanocoder sends `imageDetail: 'auto'`, which tells the provider to choose
based on the image size:

| Detail level | When the provider uses it | Token cost |
|---|---|---|
| High | Large images with fine detail (screenshots with text) | Higher |
| Low | Small images or simple graphics | Lower |
| Auto | The provider decides | Varies |

This matches what Codex (OpenAI's CLI) does — it also defaults to `auto` and
strips explicit detail settings.

## File attachments (PDFs and more)

Not everything you attach is an image. Nanocoder also supports **file parts**
for documents like PDFs:

| Attachment type | How it is sent | Which providers understand it |
|---|---|---|
| Image (PNG, JPEG, GIF, WebP) | Image part with `imageDetail: 'auto'` | Anthropic (Claude), OpenAI (GPT-4o), Google (Gemini) |
| PDF | File part | Anthropic (Claude) — full PDF support; OpenAI — limited |
| Other files | File part | Depends on the provider |

If a provider does not support file parts, it will ignore them or return an
error. Nanocoder does not pre-check this — it sends the attachment and lets
the provider decide.

## Size limits

| Limit | Value | What happens if exceeded |
|---|---|---|
| Per-image size | 4 MB (base64, roughly 3 MB raw) | Image is dropped, a text note is added |
| Total request size | Provider-dependent | The provider returns an error |

Nanocoder drops oversized images **before** sending the request, so one large
paste does not crash the whole turn. The text part of your message still goes
through — only the image is lost.

If you need to send a large image, resize it first. A future version of
Nanocoder may include automatic resizing (like opencode's `Image.Service`),
but for now this is a manual step.

## Technical details for contributors

The image and file conversion happens in
`source/ai-sdk-client/converters/message-converter.ts`:

- `toImagePart(attachment)` — converts an image attachment to an AI SDK
  `ImagePart` with `providerOptions.openai.imageDetail = 'auto'`. Returns
  `null` if the image exceeds the 4 MB limit.
- `toFilePart(attachment)` — converts a non-image attachment to an AI SDK
  `FilePart` (for PDFs and documents).
- `isImageMediaType(mediaType)` — checks if a media type starts with `image/`.

The `MAX_IMAGE_BASE64_BYTES` constant (4 MB) is the drop threshold. It is set
conservatively to stay under both Anthropic's and OpenAI's per-image limits.

The input pipeline (user paste → message) lives in
`source/components/user-input.tsx` and `source/utils/message-builder.ts`.
