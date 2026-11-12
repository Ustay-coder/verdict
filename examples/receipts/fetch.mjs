// Downloads the 100 test receipts of CORD v2 (the photos and their annotations) through Hugging Face's dataset
// viewer, into images/ and annotations.json. About 15 MB. The photos are not kept in this repository.
//   node fetch.mjs
import { mkdirSync, writeFileSync } from "node:fs";

const rows = "https://datasets-server.huggingface.co/rows?dataset=naver-clova-ix%2Fcord-v2&config=default&split=test";
// The viewer answers 502 now and then; a few tries a few seconds apart get through.
async function get(url) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(url);
    if (response.ok) return response;
    if (attempt === 5) throw new Error(`${url.slice(0, 100)}: HTTP ${response.status}`);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

mkdirSync("images", { recursive: true });
const receipts = [];
for (let offset = 0; offset < 100; offset += 25) {
  const page = await (await get(`${rows}&offset=${offset}&length=25`)).json();
  for (const { row_idx: index, row } of page.rows) {
    const file = `images/${String(index).padStart(3, "0")}.jpg`;
    writeFileSync(file, Buffer.from(await (await get(row.image.src)).arrayBuffer()));
    receipts.push({ index, file, gt: JSON.parse(row.ground_truth).gt_parse });
  }
  console.error(`${receipts.length} of 100`);
}
writeFileSync("annotations.json", JSON.stringify(receipts));
