export interface OfflineRegionLabel {
  readonly name: string
  readonly latitude: number
  readonly longitude: number
}

interface SingaporePolygonFeature {
  readonly type: 'Feature'
  readonly properties: { readonly name: string }
  readonly geometry: {
    readonly type: 'Polygon'
    readonly coordinates: readonly (readonly (readonly [number, number])[])[]
  }
}

export interface SingaporeOutlineGeoJson {
  readonly type: 'FeatureCollection'
  readonly features: readonly SingaporePolygonFeature[]
}

export const OFFLINE_REGION_LABELS: readonly OfflineRegionLabel[] = [
  { name: 'Jurong', latitude: 1.335, longitude: 103.725 },
  { name: 'Woodlands', latitude: 1.438, longitude: 103.786 },
  { name: 'Punggol', latitude: 1.404, longitude: 103.902 },
  { name: 'Tampines', latitude: 1.353, longitude: 103.945 },
  { name: 'Central', latitude: 1.305, longitude: 103.848 },
]

export const SINGAPORE_OUTLINE_GEOJSON: SingaporeOutlineGeoJson = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { name: 'Singapore Main Island' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [103.608, 1.271],
            [103.619, 1.329],
            [103.638, 1.375],
            [103.666, 1.4145],
            [103.694, 1.433],
            [103.725, 1.445],
            [103.767, 1.449],
            [103.792, 1.466],
            [103.829, 1.469],
            [103.861, 1.4425],
            [103.898, 1.423],
            [103.925, 1.404],
            [103.959, 1.396],
            [103.991, 1.388],
            [104.018, 1.366],
            [104.032, 1.341],
            [104.005, 1.322],
            [103.963, 1.31],
            [103.914, 1.301],
            [103.877, 1.292],
            [103.854, 1.273],
            [103.828, 1.264],
            [103.792, 1.274],
            [103.757, 1.294],
            [103.719, 1.311],
            [103.681, 1.304],
            [103.643, 1.267],
            [103.608, 1.271],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'Sentosa' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [103.81, 1.253],
            [103.828, 1.258],
            [103.845, 1.247],
            [103.826, 1.242],
            [103.81, 1.253],
          ],
        ],
      },
    },
    {
      type: 'Feature',
      properties: { name: 'Pulau Ubin' },
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [103.931, 1.412],
            [103.964, 1.421],
            [103.997, 1.4145],
            [103.992, 1.401],
            [103.952, 1.402],
            [103.931, 1.412],
          ],
        ],
      },
    },
  ],
}
