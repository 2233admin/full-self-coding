// packages/core/src/salacia/index.ts
export { SalaciaPlugin, type SalaciaConfig } from "./plugin";
export { generateContract, contractToPromptSuffix, type ExecutionContract, type GenerateContractOptions } from "./contract";
export { getCoChangedFiles, expandWithCoupling, type CoChangeEntry } from "./coupling";
export { detectDrift, isFatalDrift, exceedsThreshold, type DriftReport } from "./drift";
export { EvidenceJournal } from "./journal";
export { ABExperiment, assignGroup, type ExperimentMetrics, type ExperimentReport, type ExperimentGroup } from "./experiment";
