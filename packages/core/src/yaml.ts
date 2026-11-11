/**
 * Loads and renders rubric YAML at the serialization boundary.
 * Both YAML and JSON rubrics pass through the same validation and defaulting rules.
 */
import YAML from "yaml";
import { parseRubric, type Rubric } from "./schema/rubric.js";

/** Parse a rubric from YAML or JSON text. */
export function loadRubricText(text: string): Rubric {
  const trimmed = text.trim();
  const data = trimmed.startsWith("{") ? JSON.parse(trimmed) : YAML.parse(trimmed);
  return parseRubric(data);
}

/** Serializes a validated rubric to YAML; serialization failures propagate. */
export function rubricToYaml(rubric: Rubric): string {
  return YAML.stringify(rubric, { lineWidth: 100 });
}
