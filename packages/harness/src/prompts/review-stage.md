The harness is now running the {{ stage }} checkpoint. This is an intermediate work product, not the published review. The final ReviewResult JSON will be requested only after investigate, verify and challenge pass. The remaining budget is {{ remainingTurns }} model turns across ALL remaining stages, tools and final output. Reserve turns for later stages; a failed evidence gate cannot be bypassed by a clean summary.

{% if stage == "investigate" %}
Read all reviewable diff pages, identify the highest-risk behavioral contracts and investigate their callers/guards. The automatic focus below is a minimum starting point; add other significant risks found in the diff. Form concrete candidate failure scenarios, including those not yet proven. Do not stop after finding one issue.
{% elsif stage == "verify" %}
Try to disprove every prior candidate against actual guards, callers, tests and version contracts. Reassess each prior candidate as supported, dismissed or unresolved, citing exact read_file evidence. Check the highest-risk contracts even when there are no candidates. Use a targeted executable check where available and useful; distinguish a completed command from a passed check. Missing tools are limitations, never passing verification.
{% elsif stage == "challenge" %}
Run an adversarial pass, including when the candidate list is empty. Challenge the strongest no-bug hypothesis with concrete boundary inputs, cross-context access, partial failures, cancellation or at least three-event state sequences where applicable. When there is executable risk scope or a candidate, obtain and cite at least one NEW source page or completed command result in this stage that can resolve a material doubt (for example a guard, caller or test); avoid redundant reads. Reassess prior supported candidates and inspect any new candidate before reporting it. The checkpoint must identify why each chosen scenario is prevented or produces a demonstrated failure. Do not mark unresolved work complete.
{% endif %}

Selected focus (production before test-only paths, then path signals and changed-line size; not exhaustive risk classification):
{{ focus | json }}

Environment facts and limitations:
{{ environment | json }}

Previous checkpoint:
{{ previous | json }}

Recorded evidence, captured from actual completed tool calls:
{{ evidence | json }}

{% if gaps.size > 0 %}
The harness rejected the prior checkpoint. This is the ONE evidence revisit; resolve these gaps with available tools before resubmitting:
{{ gaps | json }}
{% endif %}

For each risk, identify the production contract and its observable result, then compare baseline and head under the same concrete trigger. Trace changed values or signals into their active consumers; check distinct affected branches separately. Ground before/after conclusions in the diff and pinned source, including baseline reads when the diff alone does not establish prior behavior. For newly added behavior, state what was absent at baseline. A test assertion is a claim of intended behavior: verify it against the production contract, rather than treating agreement with the implementation as proof. An unchanged neighboring effect does not establish that the contract's own observable result is preserved.

Keep every prior risk's id, path, contract and trigger exactly unchanged. Update before/after conclusions and citations when evidence confirms or disproves the concern; add a new risk for a different contract or trigger. In challenge, use fresh evidence to test at least one retained contract or candidate. New unrelated inspections do not replace this obligation. These fields are concise verifiable facts and conclusions, not private reasoning.

When this stage is ready, return only JSON:
{"summary":"concise inspected behavior and outcome","risks":[{"id":"risk-1","path":"repository/path","contract":"expected observable behavior at its actual consumer","trigger":"concrete input or event sequence","before":"baseline behavior under this trigger","after":"head behavior and observed guard or consequence under this trigger","evidenceIds":["tool-1"]}],"candidates":[{"path":"repository/path","lineStart":1,"lineEnd":1,"scenario":"concrete trigger and consequence","status":"supported | dismissed | unresolved","evidenceIds":["tool-1"]}],"unresolved":[],"limitations":[]}

Use actual status enum values. Cite only IDs listed by the harness; invented IDs, failed reads, tool unavailability and model assertions are not source evidence. Every minimum focus path needs a risk scenario citing a delivered read_file page overlapping a changed hunk at the specified revision. Candidate ranges require complete head-source coverage. Keep prior candidates unless explicitly reassessed. Empty candidates is valid; empty risk analysis for executable changes is not. Place material unverified behavioral questions in unresolved; list tool/environment restrictions in limitations without pretending they were resolved. Do not include private chain of thought: provide concise conclusions, scenarios and factual evidence references only. Tools remain available until the budget is exhausted.
