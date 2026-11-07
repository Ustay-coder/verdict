# Shared tools for the UI videos

The first video B (Primer dashboard, 19 → 76 → 82) was replaced by B v2 ([`../landing-ui-loop/`](../landing-ui-loop)).
Its material (importer, design-system rubric, start page, Take E) is in git history, in commits before the one that added
this README. Two of its tools are still in use, and stay here:

| Tool | Used by |
| --- | --- |
| [`audit/server.mjs`](audit/server.mjs): render-audit scorer on port 7788 (contrast, decoration, motion, template chrome, numbers from a json file, …) | [`../landing-ui-loop/landing-review-strict.yaml`](../landing-ui-loop/landing-review-strict.yaml) |
| [`recording/build_states.py`](recording/build_states.py): replays the agent's Edit/Write calls from a session transcript into every page state, with each evaluate result | [`../landing-ui-loop/`](../landing-ui-loop) renderer |
