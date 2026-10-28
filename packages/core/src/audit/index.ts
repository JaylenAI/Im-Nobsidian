export { classifyBodyFidelity, summarizeFidelity } from "./fidelity.js";
export type {
  FidelityDefect,
  FidelityDefectForm,
  FidelityClassification,
  FidelityContext,
  FidelitySummary,
} from "./fidelity.js";

export { verifyDatabaseCompleteness, verifyPageCompleteness } from "./completeness.js";
export type {
  CompletenessRemoteSource,
  CompletenessLocalSource,
  CompletenessOptions,
  CompletenessFailure,
  CompletenessReport,
  DatabaseCompleteness,
  PageCompletenessRemoteSource,
  PageCompletenessReport,
  VaultCompletenessReport,
} from "./completeness.js";

export { findNestedFolderPages } from "./nested-folder-pages.js";
export type { NestedFolderPage, NestedFolderRecord } from "./nested-folder-pages.js";

export { lintRenderedMarkdown, RENDER_LINE_RULES, SEPARATOR_BODY } from "./render.js";
export type { RenderFinding, RenderLineRule } from "./render.js";
