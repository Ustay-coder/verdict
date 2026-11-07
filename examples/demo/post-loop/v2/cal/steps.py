# Writes cal/steps/NN-name.md: the start post with one more fix applied each step (the order an agent would likely take).
import os
here = os.path.dirname(os.path.abspath(__file__))
doc = open(os.path.join(here, "..", "start", "post.md")).read()
fixes = [
  ("gate", " It now fixes any landing page in minutes, guaranteed.", ""),
  ("no_hype", " Honestly the most INSANE thing we've built!!!", ""),
  ("styled_text", "𝗧𝗵𝗲 𝘀𝗰𝗼𝗿𝗲𝘀:", "The scores:"),
  ("hashtags", "#AI #DevTools #buildinpublic #webdev #SaaS", "#DevTools"),
  ("mentions", "cc @AnthropicAI @github\n\n", ""),
  ("fiction_flagged", "landing page for Tideline and", "landing page for Tideline, a fictional uptime tool, and"),
  ("what_it_is", "scored by Verdict.", "scored by Verdict, our evaluation engine that scores work against a rubric."),
  ("limits", "in about 8 minutes, unattended.", "in about 8 minutes, unattended. Two rounds barely moved because the fix was only partial."),
  ("question", "\n\n#DevTools", "\n\nWhat would your agent's first draft score?\n\n#DevTools"),
]
os.makedirs(os.path.join(here, "steps"), exist_ok=True)
open(os.path.join(here, "steps", "00-start.md"), "w").write(doc)
for i, (name, old, new) in enumerate(fixes, 1):
    assert old in doc, name
    doc = doc.replace(old, new, 1)
    open(os.path.join(here, "steps", f"{i:02d}-{name}.md"), "w").write(doc)
