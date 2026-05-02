import type { DemoState } from "./types";
import { createInitialState } from "./demo-engine";

declare global {
  // eslint-disable-next-line no-var
  var __team_manager_state: DemoState | undefined;
}

export function getDemoState(): DemoState {
  if (!globalThis.__team_manager_state) {
    globalThis.__team_manager_state = createInitialState();
  }

  return globalThis.__team_manager_state;
}

export function setDemoState(state: DemoState): DemoState {
  globalThis.__team_manager_state = state;
  return state;
}

export function resetDemoState(): DemoState {
  globalThis.__team_manager_state = createInitialState();
  return globalThis.__team_manager_state;
}
