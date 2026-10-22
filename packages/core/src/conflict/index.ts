export { threeWayMerge } from "./merger.js";
export type { MergeResult, MergeConflictRegion } from "./merger.js";
export {
  ConflictResolver,
  applicableChoices,
  choiceForStrategy,
  isRemoteDeletion,
} from "./resolver.js";
export type { ResolutionChoice, ResolutionResult } from "./resolver.js";
