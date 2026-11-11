/**
 * testing/ — the subpath `@mosphere/wisdom-graph/testing`.
 *
 * Fakes for every port, the text corpora the sanitiser is measured against,
 * the consumer's categories and advisor graph as fixtures, and the shared
 * store-contract suite any `StorePort` implementation must pass. Everything
 * here is deterministic and touches no network, so a consumer's own test
 * suite can run the real engine against them (must-have 9). It imports
 * `core/` by relative path and nothing else.
 *
 * Exports are curated to spec §2.9 and `surface.test.ts` pins them. The
 * pieces the fakes and fixtures are built from (`hashedBagOfWords`,
 * `FAKE_CLOCK_EPOCH`, `EMPTY_PROPOSAL`, the `fixture*` row builders) stay in
 * their files for the package's own tests; a consumer gets the fakes, not
 * their internals.
 */

export { FakeLlm, FakeEmbedding, FakeClock, CollectingLogger, CapturingTracer, FaultyStore } from "./fakes";
export type { FakeLlmStep, FakeLlmOptions, LogLevel, LogEntry, CapturedSpan, FaultyStoreMode, FaultyStoreCall } from "./fakes";
export { injectionCorpus, benignCorpus, advisorCategories, advisorFixture, labelledQueries } from "./fixtures";
export type { AdvisorFixture, LabelledQuery } from "./fixtures";
export { storeContractTests } from "./store-contract";
export type { StoreFactory } from "./store-contract";
