# Problem statement

**Smart India Hackathon — On-device Visual Perception for Light-weight Browser Agents**

## Background

AI agents are becoming omnipresent in the current era and can play an important role in our
digital interactions. If an agentic AI pipeline has access to our visual context and screen
states, they can assist users in complex workflows and automate many tasks. Most agentic AI
pipelines are deployed on the server side, which limits the type of data a user can share with
them. It would open a new dimension of possibilities if a local agent were deployed on the
user's machine — particularly in the browser — which can eliminate the need to share sensitive
data with the server. A local system generally has fewer resources than a server and is unable
to host a full-fledged pipeline; therefore only the non-sensitive data, such as the structure of
the screen and application fields, can be sent to the server for processing.

Modern browser APIs (such as WebGPU and WebAssembly) and local inference libraries (like ONNX
Runtime Web and Transformers.js) have unlocked the ability to run lightweight machine learning
models directly on the client. The aim is to bridge these two environments: leveraging the
reasoning power of cloud- or server-based AI while strictly enforcing data privacy at the
client side.

## Description

Participants are required to build a privacy-preserving vision agent which runs in the browser.
This involves implementing a client-side architecture where a local Vision Transformer (ViT) or
equivalent computer vision model "reads" the user's screen and takes decisions based on that. If
it requires the visual context to be sent to the server, it shall sanitize the sensitive/PII
data using DOM tags or any other method before any network request is made. It should
dynamically detect and redact sensitive elements — for example blurring faces, blacking out
passwords, and masking PII. Only this anonymized, unidentifiable data should be transmitted to
the central server, which should be aware of this redaction scheme and can process the data
accordingly. The server will then process the sanitized context and return actionable commands
for the browser agent to execute. Participants must balance the trade-offs between inference
latency and accuracy.

## Expected solution

A successful submission should include a working prototype consisting of a client-side extension
and a server that demonstrates the following.

### Client-side (extension / JS) running in popular browsers (Chrome, Firefox)

- **Local vision processing:** implementation of a client-side vision model running in the
  browser (e.g. via WebGPU) that evaluates the current screen state.
- **Privacy-preserving filter:** a mechanism for sanitizing sensitive or personal visual data.
  This can be achieved through local bounding-box redaction, semantic obfuscation, masking, etc.
  This should be clearly demonstrated.

### Server-side

- **Server-side integration:** the transmission of the anonymized visual context to a
  centralized LLM/VLM, which successfully interprets the sanitized data and returns a response —
  which may be processed data to be ingested again by the local client, or a UI action (e.g.
  "click the submit button", "scroll down") that the local client executes.
- Participants are free to use any offline-deployable (open-source / open-weights) model on the
  server side. During SIH they may use a cloud-hosted version of these. An end-to-end task
  assisting the user should be demonstrated.

## How this maps to our build

| Requirement | Where it lives |
|---|---|
| Local vision model reading the screen | `extension/lib/vision/` (onnxruntime-web, WebGPU → WASM) |
| Privacy-preserving filter | `extension/lib/pii/` + `extension/lib/redact/` |
| Anonymized transmission | `extension/lib/protocol.ts` + egress guard |
| Server-side VLM returning UI actions | `server/` (FastAPI, OpenAI-compatible open-weights VLM) |
| End-to-end assisted task | `demo-site/` + the agent loop in `entrypoints/background.ts` |
| Latency vs accuracy trade-off | `eval/` metric scripts and the side-panel metrics table |

See `docs/PLAN.md` for the architecture and milestones, and the judging metrics in `CLAUDE.md`.
