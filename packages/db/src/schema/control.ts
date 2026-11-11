/**
 * Columns of the control plane tables (docs/design/control-plane.md §9.3), written once for both dialects: each
 * schema file passes its own column builders and declares the tables with its own keys and indexes.
 *
 * Every table is keyed by tenant and project and read only in that scope; none has a public read path. `tenant_id`
 * is "" on the open single-tenant server rather than NULL, because NULLs never collide in a key. Rubric names live in
 * `rubric_name`, version ids in `version_id`; `doc` holds the full document and the other columns exist to be queried.
 */
export function controlColumns<Text, OptionalText, Doc>(text: (name: string) => Text, optionalText: (name: string) => OptionalText, doc: () => Doc) {
  const scope = () => ({ tenantId: text("tenant_id"), project: text("project") });
  return {
    projects: { tenantId: text("tenant_id"), name: text("name"), createdAt: text("created_at") },
    environments: { ...scope(), name: text("name"), createdAt: text("created_at") },
    /** Immutable rubric versions kept in a project under the name services ask for (ProjectVersion). */
    projectVersions: { ...scope(), name: text("rubric_name"), id: text("version_id"), doc: doc(), createdAt: text("created_at") },
    /** Which version of a rubric an environment runs. */
    pointers: { ...scope(), environment: text("environment"), name: text("rubric_name"), versionId: text("version_id"), updatedAt: text("updated_at") },
    /** History of pointer changes (PromotionEvent); never updated. */
    promotions: { ...scope(), id: text("id"), environment: text("environment"), name: text("rubric_name"), doc: doc(), createdAt: text("created_at") },
    /** Numbers of runs reported by CI (RunReport): never a case id, an input or an output. */
    runReports: {
      ...scope(), runId: text("run_id"), name: text("rubric_name"), versionId: text("version_id"), datasetName: optionalText("dataset_name"),
      startedAt: text("started_at"), doc: doc(), reportedAt: text("reported_at"),
    },
    /** Counts of comparisons between two reported runs (ComparisonReport). */
    comparisonReports: { ...scope(), id: text("id"), name: text("rubric_name"), headVersionId: text("head_version_id"), doc: doc(), reportedAt: text("reported_at") },
  };
}
