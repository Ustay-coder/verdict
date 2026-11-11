import { copyFileSync } from "node:fs";
copyFileSync(new URL("../LICENSE", import.meta.url), "LICENSE");
