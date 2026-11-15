/**
 * Persistence for change tests and their trials, next to `VersionStore`: the memory and file stores implement it
 * (the local workbench). Every read is tenant-scoped, as everywhere else. Tests and trials are documents that only
 * grow: revisions, verifications and history are appended, never rewritten.
 */
import type { Store } from "../store/index.js";
import type { DatasetVersion } from "../versions/dataset.js";
import type { VersionStore } from "../versions/store.js";
import type { ChangeTest, Trial } from "./types.js";

export interface ChangeStore {
  putChangeTest(t: ChangeTest): Promise<void>;
  getChangeTest(id: string, tenantId?: string): Promise<ChangeTest | undefined>;
  /** Newest first. */
  listChangeTests(o?: { tenantId?: string; limit?: number }): Promise<ChangeTest[]>;
  putTrial(t: Trial): Promise<void>;
  getTrial(id: string, tenantId?: string): Promise<Trial | undefined>;
  /** Newest first; `testId` narrows to one test's trials. */
  listTrials(o?: { tenantId?: string; testId?: string; limit?: number }): Promise<Trial[]>;
  /** Newest first: the document sets a new test can be written for. */
  listDatasetVersions(o?: { tenantId?: string; limit?: number }): Promise<DatasetVersion[]>;
}

/** A store that keeps everything a change test touches: evaluations, versions and datasets, tests and trials. */
export type ChangeWorkbench = Store & VersionStore & ChangeStore;

export function hasChangeTests(store: object): store is ChangeStore {
  return typeof (store as Partial<ChangeStore>).putChangeTest === "function";
}
