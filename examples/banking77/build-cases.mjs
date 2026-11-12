// Rebuilds cases.jsonl from BANKING77's test split, so anyone can check that the cases were not hand-picked:
//   curl -sLO https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/test.csv
//   node build-cases.mjs test.csv > cases.jsonl
// The first PER_INTENT messages of each intent, in the order the file has them. Nothing is skipped or reworded.
import { readFileSync } from "node:fs";

const INTENTS = ["pending_transfer", "transfer_not_received_by_recipient", "failed_transfer", "declined_transfer", "transfer_timing", "balance_not_updated_after_bank_transfer", "cancel_transfer", "transfer_fee_charged"];
const PER_INTENT = 10;

/** One CSV record per row; BANKING77 quotes a field that holds a comma, a quote or a line break. */
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field || row.length) { row.push(field); if (row.length > 1) rows.push(row); }
  return rows;
}

const [header, ...records] = parseCsv(readFileSync(process.argv[2], "utf8"));
if (header.join(",") !== "text,category") throw new Error(`unexpected header: ${header.join(",")}`);
for (const intent of INTENTS) {
  const messages = records.filter(([, category]) => category === intent).slice(0, PER_INTENT);
  if (messages.length !== PER_INTENT) throw new Error(`${intent}: ${messages.length} message(s)`);
  messages.forEach(([text], i) => {
    const id = `${intent}-${String(i + 1).padStart(2, "0")}`;
    console.log(JSON.stringify({ id, name: id, inputs: [{ type: "text", text }], expected: { intent } }));
  });
}
