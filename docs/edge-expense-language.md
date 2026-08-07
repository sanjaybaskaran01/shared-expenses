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
| Qwen3-0.6B + WebLLM/XGrammar | Safari 26 WebGPU, subject to physical-device validation | 352 MB MLC artifact plus runtime memory | Baseline semantic/safety smoke failed | Rejected candidate; do not ship |
| Apple Foundation Models | Native Swift framework on Apple Intelligence devices | System-managed | Guided generation and tool calling are strong, but model availability is user/device dependent | Native-app enhancement, not usable by the PWA |
| Gemini Nano browser APIs | Not available on Chrome for iOS or other mobile devices | Browser-managed model | Experimental API availability | Not viable for the iPhone PWA |
| Cloud model | Broad | Network round trip and service dependency | Strong language coverage, but data leaves device | Rejected for the zero-infrastructure/private path |

Primary references:

- WebKit ships WebGPU on iOS in Safari 26: <https://webkit.org/blog/17333/webkit-features-in-safari-26-0/>
- Qwen3-0.6B is Apache-2.0 and supports a local function-calling path: <https://huggingface.co/Qwen/Qwen3-0.6B>
- The browser-ready Qwen MLC artifact is 352 MB: <https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_0-MLC/tree/main>
- WebLLM provides browser WebGPU inference and structured JSON generation: <https://github.com/mlc-ai/web-llm>
- XGrammar provides JSON-schema/grammar-constrained output: <https://github.com/mlc-ai/xgrammar>
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

The 100 ms budget applies to the existing deterministic fast path. A model
proposal is deliberately asynchronous and must never block typing; its separate
promotion target is documented in
[on-device-model-decision.md](./on-device-model-decision.md).

## Model research phase

The current production path remains deterministic. **No on-device model is
selected.** Qwen3-0.6B through WebLLM/XGrammar fit the artifact budget, but
the actual Qwen baseline failed Tallied's semantic and safety smoke; the
evidence and the next candidate gate are documented in
[on-device-model-decision.md](./on-device-model-decision.md) and
[on-device-model-benchmark-2026-08-06.md](./on-device-model-benchmark-2026-08-06.md).

Any model phase is blocked from becoming the default until it beats the
deterministic compiler on a held-out Tallied corpus, passes the explicit
safety gate, and succeeds on physical iPhone PWA tests. It returns a
read-only proposal and cannot call `createExpense`.

## Trust boundaries

- The parser receives only the selected group's active display names and IDs.
- Text and parser results remain in browser memory; they are not persisted as prompts or telemetry.
- Chips expose all inferred values before mutation.
- Existing ledger signing, local-first storage, and sync semantics are unchanged.
- Financial arithmetic uses integer minor units in the existing allocation functions; language/model output never performs final accounting.
