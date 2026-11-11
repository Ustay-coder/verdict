// Static analysis used by scripts/code-metrics.mjs. Rules are warnings so the metrics script can count them;
// `pnpm lint` reports them for humans. Thresholds follow SonarQube "Sonar way" / SIG unit-size guidance.
import tseslint from "typescript-eslint";
import sonarjs from "eslint-plugin-sonarjs";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "website/**", "examples/**", "**/*.test.ts", "**/drizzle/**", "scripts/**"] },
  ...tseslint.configs.recommended,
  {
    files: ["packages/*/src/**/*.ts"],
    plugins: { sonarjs },
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 15],
      "max-lines-per-function": ["warn", { max: 60, skipBlankLines: true, skipComments: true }],
      "max-lines": ["warn", { max: 400, skipBlankLines: true, skipComments: true }],
      "max-depth": ["warn", 4],
      "max-params": ["warn", 5],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-non-null-assertion": "off",
      "no-console": "off",
    },
  },
);
