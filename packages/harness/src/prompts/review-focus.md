The harness selected these focused review guide sections from the changed-file manifest. Apply them to the actual affected contracts and follow relevant callers/guards; filenames are only prioritization signals. This supplements the core guide and does not replace reviewing the complete diff.

{% for section in sections %}
### {{ section.name }}
{{ section.guide }}
{% endfor %}

Minimum deeper inspection targets prioritize changed production code before test-only files; maintained vendor source remains production code. Tests help locate intended behavior but do not replace checking the affected production contract. Targets: {{ paths | json }}

The harness runs investigate → verify → challenge (including zero findings) → final serialization. It records successful pinned source reads and completed command outcomes independently of model claims. Intermediate checkpoints are requested by the harness before the final ReviewResult. Unresolved evidence gaps receive one bounded revisit and then fail as an incomplete review.
