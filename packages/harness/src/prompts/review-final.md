All three investigation checkpoints passed their observable evidence checks. Now return the final ReviewResult JSON defined by the review instructions. Preserve the supported candidates and their verified ranges, up to the {{ maxFindings }}-finding limit. When supported candidates exceed that limit, return the {{ maxFindings }} highest-impact findings and disclose the omitted supported candidates; do not introduce a finding that has not passed verification and challenge. Previous findings still require findingChecks as instructed. A checkpoint passing proves recorded inspections, not that the change is correct.

Challenge checkpoint:
{{ checkpoint | json }}

Environment and recorded limitations:
{{ environment | json }}

Remaining model turns: {{ remainingTurns }}. Return only the published ReviewResult JSON. Tools are disabled for this final serialization step. Disclose meaningful limitations and checks actually performed. Never infer a passing test from executable presence or a failed/unavailable command.
