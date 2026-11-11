/**
 * The control plane's documents (docs/design/control-plane.md): projects, environments, the rubric versions kept in a
 * project, the pointers that say which version an environment runs, the history of pointer changes, and the numbers
 * CI reports about runs. Nothing here holds a case, an input or a model output — only versions and counts.
 */
import type { PublicRunSummary } from "../hub/publication.js";
import type { Comparison, CriterionComparison } from "../versions/compare.js";
import type { RubricVersion } from "../versions/rubric-version.js";
import type { Run } from "../versions/run.js";

/** Project, environment and rubric names: lowercase letters, digits and dashes, up to 63 characters. */
export const CONTROL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Who made a change. An API key until people exist; the cloud replaces it with a signed-in user. */
export interface Actor { kind: "key" | "user"; id?: string; name?: string }

/** Everything in the control plane belongs to one project of one tenant. */
export interface ProjectScope { tenantId?: string; project: string }

export interface Project { tenantId?: string; name: string; createdAt: string }

export interface Environment extends ProjectScope { name: string; createdAt: string }

/** A rubric version kept in a project under the name services ask for. The same content under two names is two records. */
export interface ProjectVersion extends RubricVersion { project: string; name: string }

/** A rubric name of a project, with how many versions are kept under it and when the newest was stored. */
export interface RubricName { name: string; versions: number; updatedAt: string }

/** Which version of a rubric an environment runs. */
export interface Pointer extends ProjectScope { environment: string; name: string; versionId: string; updatedAt: string }

export type PromotionKind = "promote" | "rollback" | "unset";

/**
 * One pointer change. `from` is the version the pointer had to be at for the change to apply (null: no pointer),
 * `to` the version it now names (null: the pointer was removed).
 */
export interface PromotionEvent extends ProjectScope {
  id: string;
  environment: string;
  name: string;
  from: string | null;
  to: string | null;
  kind: PromotionKind;
  note?: string;
  actor?: Actor;
  at: string;
}

/** Where a reported run came from: optional, filled in from CI. */
export interface ReportSource { commit?: string; branch?: string; url?: string }

/** The numbers of one run, as reported by whoever ran it. Never a case id, an input or an output. */
export interface RunReport extends ProjectScope {
  name: string;
  summary: Omit<PublicRunSummary, "casesPublic">;
  /** File name of the cases the run used: groups reports of the same dataset over time. */
  datasetName?: string;
  usage?: Run["usage"];
  source?: ReportSource;
  actor?: Actor;
  reportedAt: string;
}

/** Counts of a comparison between two reported runs: `compareRuns` without its per-case rows. */
export interface ComparisonReport extends ProjectScope, Pick<Comparison, "kind" | "base" | "head" | "conditions" | "labels"> {
  id: string;
  name: string;
  criteria: Array<Omit<CriterionComparison, "cases">>;
  source?: ReportSource;
  actor?: Actor;
  reportedAt: string;
}
