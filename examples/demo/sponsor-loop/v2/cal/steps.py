# Writes cal/steps/NN.md: the start script with one more fix applied each step (the order an agent would likely take).
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
doc = open(os.path.join(here, "..", "start", "script.md")).read()
fixes = [
  ("gate", "[0:42] And if money is tight, Tallyleaf guarantees you'll be approved for a credit line, no credit check, 100% of the time.\n\n", ""),
  ("disclosure", "[0:10] Day one:", "[0:08] Quick note: Tallyleaf paid for this video. [on screen: Paid ad]\n\n[0:12] Day one:"),
  ("own_experience", "I've used Tallyleaf every day for two years now, and it changed everything.", "So in October I tracked every dollar with Tallyleaf for 30 days."),
  ("typical_results", " Use it for a month and you'll spend at least $300 less.", " That's my month; yours will be different."),
  ("trial_terms", "Try it free with code SMALLDESK. The link is in the description.", "Try it free for a month with code SMALLDESK; after that it's $4.99 a month unless you cancel, and you can cancel anytime in the app. The link is in the description."),
  ("no_competitor", "[0:38] Honestly, it's so much smarter than BudgetBee.\n\n", ""),
  ("talking_points", "and I'd forgotten two.", "and I'd forgotten two. Tallyleaf flags each one the day before it renews, so I cancelled the two I never open."),
  ("drawback", "Honestly, it's the best app on my phone.", "What I'd change: the charts are small on my phone, and the web app is still in beta."),
]
for i, (name, old, new) in enumerate(fixes, 1):
    assert old in doc, name
    doc = doc.replace(old, new, 1)
    open(os.path.join(here, "steps", f"{i:02d}-{name}.md"), "w").write(doc)
