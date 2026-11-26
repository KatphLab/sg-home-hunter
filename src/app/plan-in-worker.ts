import type { BackwardPlanResult } from '@lib/backward-planner.js'
import type { PlannerRequest } from './planner-worker.js'

export const planInWorker = async (
  request: PlannerRequest,
  signal: AbortSignal,
): Promise<BackwardPlanResult | null> => {
  const worker = new Worker(new URL('./planner-worker.js', import.meta.url), {
    type: 'module',
  })
  const { promise, resolve, reject } =
    Promise.withResolvers<BackwardPlanResult | null>()
  const cancel = () => resolve(null)
  try {
    signal.addEventListener('abort', cancel, { once: true })
    worker.onmessage = ({ data }: MessageEvent<BackwardPlanResult>) =>
      resolve(data)
    worker.onerror = (event: ErrorEvent) =>
      reject(new Error(event.message || 'Planner worker unavailable'))
    worker.postMessage(request)
    return await promise
  } finally {
    signal.removeEventListener('abort', cancel)
    worker.terminate()
  }
}
