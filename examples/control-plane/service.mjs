// A service that judges on its own machine. It asks the Verdict server one thing — which version of `intent` does
// `prod` run? — and then evaluates locally with its own judges. The message it judges never goes to that server.
//
//   VERDICT_HUB_URL=http://127.0.0.1:8787 VERDICT_HUB_KEY=sk_… node service.mjs "can I talk to a human?"
import { Engine } from "@verdict-ai/core";
import { Verdict } from "@verdict-ai/sdk";

const verdict = new Verdict({ baseUrl: process.env.VERDICT_HUB_URL, apiKey: process.env.VERDICT_HUB_KEY });

// One reader per environment, kept for the life of the process: it holds the versions it received and asks the
// server again at most once a minute. If the server is down it keeps answering with what it holds.
const prod = verdict.environment({
  project: process.env.VERDICT_PROJECT || "support-bot",
  environment: process.env.VERDICT_ENV || "prod",
  onError: (error) => console.error(`verdict: ${error.message}`),
});

const engine = new Engine();

export async function wantsAgent(message) {
  const { rubric, versionId, source } = await prod.rubric("intent");
  const evaluation = await engine.evaluate({ rubric, subject: { name: "message", inputs: [{ type: "text", text: message }] } });
  // Log the version with every judgment: "which rubric decided this?" then has an answer.
  const answer = evaluation.criteria.find((c) => c.criterionId === "wants");
  return { wants: answer?.score === 1, versionId, source };
}

for (const message of process.argv.slice(2)) console.log(JSON.stringify({ message, ...(await wantsAgent(message)) }));
