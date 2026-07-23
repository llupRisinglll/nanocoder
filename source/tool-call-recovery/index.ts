/**
 * tool-call-recovery — public entry point.
 *
 * A harness-agnostic layer that recovers malformed / text-leaked LLM tool calls
 * (the failure mode of weak & Chinese open models that emit tool calls as broken
 * text instead of executing them). Import from here; the internal file layout is
 * an implementation detail. See `README.md` and `types.ts` for the contract.
 */

export {repairToolArguments} from './arg-repair.js';
export {detectLeakedToolCalls} from './detect.js';
export {candidateSignature, recoverWithFallback} from './fallback.js';
export {fuzzyMatchToolName} from './fuzzy-name.js';
export {recoverToolCalls} from './recover.js';
export * from './types';
