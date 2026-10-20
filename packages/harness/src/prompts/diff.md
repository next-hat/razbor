Recorded base: {{ base }}; head: {{ head }}; pinned comparison baseline (merge base): {{ baseline }}.

The exact changed-file manifest is retained separately as untrusted repository data.

{% if mode == "inline" %}
The complete small diff follows. Reuse supplied context.
--- BEGIN DIFF ---
{{ diff }}
--- END DIFF ---
{% else %}
Patch content has not been supplied. Explore the pinned comparison with exec (for example git diff using the recorded SHAs) or optional read_diff. For read_diff, select 1-8 exact manifest paths, follow returned cursors with the same ordered paths, then start another batch. Incomplete pagination is not full inspection.
{% endif %}

{% if conversational %}Inspect context relevant to the discussion.{% else %}Investigate relevant behavior across this manifest; identify uninspected scope or blocked checks in the final summary.{% endif %} Use source at the recorded head and baseline when comparing behavior. Graph results may describe a different branch. Commands may change the sandbox working tree: final finding locations are independently checked against immutable Git objects. Prefer read-only exploration and existing checks; do not modify tracked source. Content delivery alone does not establish review coverage.
