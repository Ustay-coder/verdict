// Rebuilds cases.jsonl from CORD's annotations, so anyone can check where each answer comes from:
//   node fetch.mjs
//   node build-cases.mjs annotations.json > cases.jsonl
// Every receipt of the test split, in order. The photos are not touched. An answer is written only where the
// annotation settles it.
import { readFileSync } from "node:fs";

/** "60.000", "Rp. 111,000", "365000.00", "9.500,00": rupiah as a whole number. Undefined where there is no amount. */
function rupiah(text) {
  if (typeof text !== "string") return undefined;
  // Two digits after the last separator are cents; every other "." or "," separates thousands.
  const digits = text.replace(/[^0-9.,]/g, "").replace(/[.,]\d{2}$/, "").replace(/[.,]/g, "");
  return digits ? Number(digits) : undefined;
}

const COUNT = ["one", "two", "three", "four_or_more"];

for (const { index, file, gt } of JSON.parse(readFileSync(process.argv[2], "utf8"))) {
  const total = gt.total ?? {};
  // One entry of `menu` is one item bought; an add-on printed under it is its `sub`, not an entry of its own.
  const items = Array.isArray(gt.menu) ? gt.menu.length : gt.menu ? 1 : 0;
  const cash = total.cashprice != null, card = total.creditcardprice != null;
  const amount = rupiah(total.total_price);
  const expected = {
    // Only where the annotation names exactly one of the two: with both, or neither, there is no answer here.
    ...(cash !== card ? { payment: cash ? "cash" : "card" } : {}),
    ...(items ? { items: COUNT[Math.min(items, COUNT.length) - 1] } : {}),
    ...(amount !== undefined ? { large_total: amount >= 100_000 ? "yes" : "no" } : {}),
  };
  const id = `receipt-${String(index).padStart(3, "0")}`;
  console.log(JSON.stringify({ id, name: id, inputs: [{ type: "image", path: file }], expected }));
}
