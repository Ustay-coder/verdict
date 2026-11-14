# What is true about Verdict (the judge reads this; the page must not claim more)

- Verdict is an open-source (MIT) evaluation engine on GitHub: https://github.com/Ustay-coder/verdict
- Tagline: "One rubric, every decision model." Write a rubric (criteria, scales, levels) once, run it on Jev, Clef, Clef-flash, OpenAI's Decisions API, Gemini's decision model and OpenRouter, and see where they disagree on your own cases.
- Install: `npm install -g @verdict-ai/cli` (Node 22+). The first run needs no API key: `--models mock`.
- Commands include `verdict run`, `verdict eval`, `verdict diff`, `verdict version freeze`.
- Inputs: text, files, PDFs, web pages, YouTube transcripts, JSON and images. Judges: decision models, rules, people, prompted models.
- Also: a REST API (Node or Cloudflare Workers), a TypeScript SDK, an MCP server. Docs: https://docs.verdict-ai.dev
- The one published measurement: on 2026-11-12, 80 BANKING77 customer messages on six models agreed with the labels 83% to 91% (Clef-flash 73/80 highest, Jev 66/80 lowest). The README says this is not a ranking.
- There are no published customers, testimonials, company logos, user counts, star counts, uptime figures or pricing plans. Verdict is free; there is no paid tier, no sign-up and no waitlist.
