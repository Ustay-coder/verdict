#!/usr/bin/env node
import { buildCli } from "./index.js";
buildCli().parseAsync(process.argv).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
