/**
 * Persistence for versions, datasets and runs. Separate from `Store` so stores adopt it one at a time: Memory and
 * File stores implement it now (the local workbench), the database stores with the hub (docs/design/hub.md P3).
 * Every read is tenant-scoped, as in `Store`.
 */
import type { DatasetVersion } from "./dataset.js";
import type { RubricVersion } from "./rubric-version.js";
import type { Run } from "./run.js";

export interface VersionStore {
  putRubricVersion(v: RubricVersion): Promise<void>;
  getRubricVersion(id: string, tenantId?: string): Promise<RubricVersion | undefined>;
  /** Newest first; `rubricKey` narrows to one rubric's history. */
  listRubricVersions(o?: { tenantId?: string; rubricKey?: string; limit?: number }): Promise<RubricVersion[]>;
  putDatasetVersion(d: DatasetVersion): Promise<void>;
  getDatasetVersion(id: string, tenantId?: string): Promise<DatasetVersion | undefined>;
  putRun(r: Run): Promise<void>;
  getRun(id: string, tenantId?: string): Promise<Run | undefined>;
  /** Newest first; filters by the version and dataset a run used. */
  listRuns(o?: { tenantId?: string; rubricVersionId?: string; datasetVersionId?: string; limit?: number }): Promise<Run[]>;
}

/** True when a store can keep versions, datasets and runs. */
export function hasVersions(store: object): store is VersionStore {
  return typeof (store as Partial<VersionStore>).putRubricVersion === "function";
}
