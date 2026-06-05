export interface ScrollAccelerationState {
  lastAt: number;
  velocity: number;
}

export function acceleratedScrollDelta(direction: -1 | 1, state: ScrollAccelerationState, now = Date.now()): number {
  const elapsed = now - state.lastAt;
  state.velocity = elapsed < 180 ? Math.min(8, state.velocity + 1) : 1;
  state.lastAt = now;
  return direction * state.velocity;
}
