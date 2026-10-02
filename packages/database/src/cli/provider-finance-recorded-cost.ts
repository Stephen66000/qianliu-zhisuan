import { readFile } from "node:fs/promises";
import { createKysely } from "../kysely.js";
import { applyRecordedCostDisposition, previewRecordedCostDisposition,
  type RecordedCostDispositionInput, type RecordedCostDispositionPreview,
} from "../repositories/provider-finance-recorded-cost-disposition.js";

const [mode, inputPath] = process.argv.slice(2);
if (!["preview", "apply"].includes(mode ?? "") || !inputPath) {
  throw new Error("Usage: provider-finance-recorded-cost.ts preview <input.json> | apply <preview.json>");
}
const input: unknown = JSON.parse(await readFile(inputPath, "utf8"));
const db = createKysely();
try {
  const result = mode === "preview"
    ? await previewRecordedCostDisposition(db, input as RecordedCostDispositionInput)
    : await applyRecordedCostDisposition(db, input as RecordedCostDispositionPreview);
  console.log(JSON.stringify(result, null, 2));
} finally { await db.destroy(); }
