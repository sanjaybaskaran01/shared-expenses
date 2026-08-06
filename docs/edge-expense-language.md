# On-device expense language architecture

Status: implemented fast path, August 2026

## Decision

Tallied compiles English expense language into a typed draft locally, shows every inferred field as a tappable chip, and only writes a ledger operation after the person confirms it.

The production path is intentionally deterministic. A language model may later propose a draft when the compiler cannot resolve a phrase, but it must never calculate allocations, choose an ambiguous person, or write to the ledger. Existing allocation and payer validators remain the financial authority.

This is the only approach that meets all four product requirements simultaneously:

- No inference infrastructure or per-request cost.
- Offline and private operation.
- Useful first interaction without a model download.
- A predictable sub-second response on iPhone.

## Evidence and platform constraints

| Option | iPhone web availability | Cold-start cost | Reliability for money | Decision |
| --- | --- | ---: | --- | --- |
| Typed deterministic compiler | Any current browser | No model; application code only | Auditable and testable | Primary path |
| FunctionGemma 270M + Transformers.js | Safari 26 WebGPU is available, subject to runtime/model compatibility | The available q4f16 ONNX data file alone is about 426 MB | Requires a Tallied-specific fine-tune and schema validation | Optional future ambiguity helper |
| Apple Foundation Models | Native Swift framework on Apple Intelligence devices | System-managed | Guided generation and tool calling are strong, but model availability is user/device dependent | Native-app enhancement, not usable by the PWA |
| Gemini Nano browser APIs | Not available on Chrome for iOS or other mobile devices | Browser-managed model | Experimental API availability | Not viable for the iPhone PWA |
| Cloud model | Broad | Network round trip and service dependency | Strong language coverage, but data leaves device | Rejected for the zero-infrastructure/private path |

Primary references:

- WebKit ships WebGPU on iOS in Safari 26 and specifically names Transformers.js and ONNX Runtime as supported frameworks: <https://webkit.org/blog/17333/webkit-features-in-safari-26-0/>
- Transformers.js runs ONNX models in-browser using WebGPU or quantized WASM: <https://huggingface.co/docs/transformers.js/guides/webgpu>
- ONNX Runtime Web documents the privacy, offline, latency, and cost advantages of browser inference, plus WASM fallback: <https://onnxruntime.ai/docs/tutorials/web/>
- Google describes FunctionGemma as a 270M function-calling foundation intended to be fine-tuned for a specific task: <https://huggingface.co/google/functiongemma-270m-it>
- The current q4f16 ONNX data artifact is 426 MB: <https://huggingface.co/onnx-community/functiongemma-270m-it-ONNX-GQA/blob/main/onnx/model_q4f16.onnx_data>
- Apple Foundation Models is a native framework with guided structured output and tool calling, and requires Apple Intelligence to be enabled: <https://developer.apple.com/documentation/FoundationModels>
- Chrome documents that Gemini Nano is unavailable on mobile, including Chrome for iOS: <https://developer.chrome.com/docs/ai/get-started>

Documentation can lag browser releases: the ONNX Runtime browser matrix still marks Safari WebGPU unsupported even though WebKit now ships it. Any model path therefore requires a real iPhone compatibility and memory test, not documentation-only approval.

## Runtime architecture

```text
English sentence
      |
      v
local tokenizer + member resolver
      |
      v
typed ExpenseDraftIntent
      |
      +--> unresolved/ambiguous --> visible issue; never guess
      |
      v
confirmation chips
      |
      +--> tap a chip --> existing form control
      |
      v
allocation + payer validators
      |
      v
explicit Add confirmation
      |
      v
offline-first signed ledger operation
```

The compiler recognizes the current expense model:

- Equal splits.
- Exact amounts, including distributing a known remainder.
- Percentages, including equally distributing an unspecified remainder.
- Whole-number shares.
- Positive and negative adjustments that must net to zero.
- One payer or multiple payer amounts.
- Explicit participants, `everyone`, exclusions, and splits between people that do not include the payer.
- Currency symbols/codes, today/yesterday/common English dates, and supported recurrence intervals.

Member resolution prefers an exact full display name. A first name is accepted only when unique in the selected group. Unknown and ambiguous names produce review issues rather than guessed IDs.

## Latency and loading budget

The focused corpus runs 1,000 parses and enforces an average below 5 ms. The current development-machine result is approximately 0.1–0.2 ms per sentence. The UI reports the actual parse duration and performs no request.

The end-to-end iPhone acceptance target is:

- Warm interaction p95 below 100 ms from input event to chips painted.
- No network request and no model download for the fast path.
- No long task above 50 ms attributable to parsing.
- Correct native text keyboard behavior and no Safari input zoom.

The product promise is “understood on this device,” not “AI understood it.” This remains accurate if the implementation evolves.

## Optional model phase

FunctionGemma is the best current model candidate because its job is already natural-language-to-function-call. It should only be considered after collecting a privacy-preserving corpus of phrases the deterministic compiler could not resolve.

A safe model rollout would:

1. Fine-tune FunctionGemma on Tallied's exact draft schema and group-scoped name placeholders.
2. Quantize and measure the complete download, initialization memory, first-token latency, and structured-call accuracy on an iPhone 17—not a desktop proxy.
3. Load it in a worker only after explicit opt-in and a Wi-Fi/storage notice; cache it separately from financial data.
4. Validate its output against known member IDs, supported currencies, allocation totals, and payer totals.
5. Fall back to the deterministic compiler and manual form on any timeout, unsupported browser, model eviction, invalid schema, or low confidence.
6. Keep the model read-only: it returns a proposed draft and cannot call `createExpense`.

The model phase is blocked from becoming the default until its complete artifact is small enough for responsible mobile delivery and it beats the deterministic compiler on a held-out Tallied corpus without breaking the latency target.

## Trust boundaries

- The parser receives only the selected group's active display names and IDs.
- Text and parser results remain in browser memory; they are not persisted as prompts or telemetry.
- Chips expose all inferred values before mutation.
- Existing ledger signing, local-first storage, and sync semantics are unchanged.
- Financial arithmetic uses integer minor units in the existing allocation functions; language/model output never performs final accounting.
