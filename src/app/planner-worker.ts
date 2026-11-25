import {
  type PlanBackwardLeadsOptions,
  planBackwardLeads,
} from '@lib/backward-planner.js'
import {
  buildTransitNetworkIndex,
  parseBusNetworkTsv,
} from '@lib/transit-network.js'

export interface PlannerRequest
  extends Pick<
    PlanBackwardLeadsOptions,
    'inventory' | 'constraints' | 'workplace'
  > {
  readonly networkText: string
}

self.onmessage = ({ data }: MessageEvent<PlannerRequest>): void => {
  const { inventory, networkText, workplace, constraints } = data
  const networkIndex = buildTransitNetworkIndex({
    inventory,
    ...parseBusNetworkTsv(networkText),
  })
  self.postMessage(
    planBackwardLeads({ inventory, networkIndex, workplace, constraints }),
  )
}
