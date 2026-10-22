import type { GleeokApi } from '../../../shared/src/ipc.ts';

declare global {
  const gleeok: GleeokApi;
  /** Build time, injected by Vite; shown in the sidebar so a stale build is obvious. */
  const __GLEEOK_BUILD__: string;
}
