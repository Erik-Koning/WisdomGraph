/**
 * scope.ts — the one AsyncLocalStorage the whole graph shares.
 *
 * Mirrors the host app's request scope: the request handler starts one
 * recall per turn (`startTurnRecall`), wraps `graph.invoke` in `scope.run`,
 * and every prompt site deep inside the graph reads the same handle through
 * `scope.laneA()` / `scope.laneB()`. The nodes never receive the handle as
 * an argument and the graph state never carries it — that is the point:
 * zero graph changes, and a site outside any scope gets an empty recall.
 */
import { createRecallScope } from "@mosphere/wisdom-graph/langgraph";

export const scope = createRecallScope();
