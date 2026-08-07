# On-device expense-language model decision

Status: **no model selected**. Qwen3-0.6B baseline rejected by development
smoke benchmark; deterministic compiler remains the production path.

## Decision

Do not select an on-device language model yet. Keep the typed deterministic
compiler as the only production language path and treat every model as a
read-only research candidate until it clears the promotion gate below.

**Qwen3-0.6B + WebLLM/XGrammar is rejected as the current candidate.** Its
352 MB MLC artifact fits the explicit download budget and has a convenient
browser runtime, but an actual CPU-only Qwen baseline produced unsafe semantic
errors and invalid/truncated review output. See
[the benchmark record](./on-device-model-benchmark-2026-08-06.md).

The next research candidate is **LFM2.5-350M Q4**, pending legal approval of
its revenue-conditioned license and the same benchmark. Granite 4.0 350M
remains an Apache-2.0 local baseline, but its current browser/runtime path is
less direct. Neither is selected or approved for product use.

The rejected Qwen artifact remains useful as a reproducible comparison point:

- Base model: <https://huggingface.co/Qwen/Qwen3-0.6B>
- MLC/WebLLM artifact: <https://huggingface.co/mlc-ai/Qwen3-0.6B-q4f16_0-MLC/tree/main>
- Browser runtime: <https://github.com/mlc-ai/web-llm>
- Constrained decoding: <https://github.com/mlc-ai/xgrammar>

The released artifact must be reproduced from a pinned base revision and
adapter, self-hosted under our origin, and integrity-checked. Do not ship a
mutable third-party artifact URL.

## Why Qwen was initially attractive—and why that was insufficient

Tallied has a fixed, narrow job: turn one short sentence into a proposed
expense draft. Qwen initially appeared to offer four useful properties:

1. Apache-2.0 base weights and a credible path to commercial redistribution.
2. A complete browser-ready MLC artifact under the explicit download budget.
3. A first-class WebLLM path, including a worker-friendly lifecycle and
   schema/grammar-constrained decoding with XGrammar.
4. Qwen's supported small-model fine-tuning path through LoRA/QLoRA. See the
   Qwen project and the PEFT documentation:
   <https://github.com/QwenLM/Qwen3>,
   <https://huggingface.co/docs/transformers/peft>.

The model was run with thinking disabled, temperature zero, a fixed seed and
a JSON schema. This smoke benchmark showed the missing property: semantic
reliability. Qwen's own function-calling documentation warns that protocol
output remains fallible and recommends task-specific fine-tuning when
templates are insufficient:
<https://github.com/QwenLM/Qwen3/blob/main/docs/source/framework/function_call.md>.

## Boundary of model authority

The model produces an `ExpenseDraftProposal`; it never creates an expense or
executes a tool. It may emit raw text, source evidence, a split hypothesis,
and review reasons. Deterministic application code remains responsible for:

- Matching names to unique members in the selected group.
- Parsing the original amount into integer minor units.
- Applying dates using the device timezone.
- Ensuring payers, participants, and allocations reconcile exactly.
- Treating unknown people, hedges, missing details, and contradictions as
  review states.
- Requiring an explicit confirmation before an operation is written.

For example, "Lunch yesterday at Palermo for 10 dollars, just me and Matt.
Matt had very less tho like 10% maybe?" must propose only `me` and `Matt`,
preserve the `10%` language, and return `requiresReview`. It must not include
defaults, assume a payer, or silently save a 90/10 split.

Constrained decoding makes the output shape deterministic. It does not make
the semantic interpretation true, which is why this boundary exists.

## Alternatives considered

| Candidate | Current decision |
| --- | --- |
| Qwen3-0.6B | **Rejected baseline.** Fits the PWA artifact budget and has the best browser grammar stack, but failed the actual Tallied semantic/safety smoke. Do not rescue this selection with prompt changes alone; it would need a new trained model and an independent held-out result. |
| Granite 4.0 350M | Excellent Apache-2.0 model with small official GGUFs, but stock WebLLM/MLC does not support its architecture. Its browser route is Transformers.js + ONNX Runtime, whose JSON-Schema generation support is still an open request. The IBM demo also parses tool-tag text rather than constraining it. [Model](https://huggingface.co/ibm-granite/granite-4.0-350m), [browser demo](https://huggingface.co/spaces/ibm-granite/Granite-4.0-Nano-WebGPU/blob/main/src/hooks/useLLM.ts), [schema issue](https://github.com/huggingface/transformers.js/issues/1328) |
| LFM2.5 350M | **Next benchmark candidate**, not a selection. Its extraction/function focus and compact official GGUFs make it the most relevant challenger, but its license has a commercial-use revenue condition. [Model and license](https://huggingface.co/LiquidAI/LFM2.5-350M) |
| FunctionGemma 270M | Strong function-specialization story, but its browser exports consume most of the budget and the practical browser stack lacks first-class grammar-constrained generation. Better suited to a native/LiteRT path. [Model card](https://ai.google.dev/gemma/docs/functiongemma/model_card) |
| Needle | Remarkably small and MIT-licensed, but uses a custom runtime and has no independently comparable function-calling benchmark. It is an R&D experiment, not the initial product parser. [Model](https://huggingface.co/Cactus-Compute/needle) |
| Hammer and xLAM | Their published licenses are non-commercial. |

## Promotion gate

Any candidate becomes the default only after all of the following:

1. The current 17 behavior tests remain green, and the formal model corpus
   includes their semantics plus hedges, explicit-only participant language,
   unknown people, prompt injection, multiple payers, multilingual inputs,
   and non-expenses.
2. XGrammar produces valid schema output for every generated and adversarial
   test. The validator rejects every unknown ID, malformed amount, invalid
   currency, and non-reconciling allocation.
3. On a held-out, human-authored set, the candidate reaches at least 99.5%
   exact amount/currency/date accuracy, 99% payer/participant accuracy, and
   97% complete-draft accuracy for unambiguous inputs. Ambiguous or hedged
   inputs must route to review rather than auto-complete.
4. It is tested in both Safari and the installed PWA on the oldest supported
   iPhone and the target flagship: cold/warm start, 20 sequential entries,
   background/foreground, storage eviction, and GPU-device-loss recovery.
5. The complete model download stays at or below 450 MB and warm p95 proposal
   latency stays below 1.5 seconds without blocking typing.

Safari 26 exposes WebGPU, but that does not remove the need for physical
device testing: <https://developer.apple.com/documentation/safari-release-notes/safari-26-release-notes>.

## Rollout sequence

1. Build a local candidate/runtime spike with the single schema and no ledger write.
2. Run the baseline model against the corpus and inspect every financial-impact
   error.
3. Collect only consented, corrected drafts; train a Tallied-specific LoRA if
   the baseline misses the gate.
4. Merge the adapter, re-quantize/recompile, rerun the same corpus and device
   tests, then offer the model as an explicit opt-in beta.
5. Retire the semantic regex parser only after the beta meets the gate. Keep
   the manual structured form as the universal fallback.
