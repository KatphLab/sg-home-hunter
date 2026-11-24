import {
  OFFLINE_REGION_LABELS,
  SINGAPORE_OUTLINE_GEOJSON,
} from '@config/singapore-outline.js'
import type { QualifiedStop, Workplace } from '@lib/commute-types.js'
import L from 'leaflet'

const SINGAPORE_CENTER: [number, number] = [1.3521, 103.8198]
const DEFAULT_ZOOM = 12
const ZONE_RADIUS_METERS = 500
const ONEMAP_TILE_URL =
  'https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png'

const buildMutableOutline = (): GeoJSON.FeatureCollection => ({
  type: 'FeatureCollection',
  features: SINGAPORE_OUTLINE_GEOJSON.features.map((feature) => ({
    type: 'Feature',
    properties: { name: feature.properties.name },
    geometry: {
      type: 'Polygon',
      coordinates: feature.geometry.coordinates.map((ring) =>
        ring.map(([lon, lat]) => [lon, lat]),
      ),
    },
  })),
})

const createStopPlaqueButton = (
  entry: QualifiedStop,
  onSelect: (stopId: string) => void,
): HTMLButtonElement => {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className =
    entry.stop.kind === 'rail'
      ? 'stop-plaque-marker stop-plaque-marker--rail'
      : 'stop-plaque-marker'
  btn.dataset['stopId'] = entry.stop.id
  btn.textContent = entry.stop.id
  btn.setAttribute('aria-label', `${entry.stop.name} (${entry.stop.id})`)
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    onSelect(entry.stop.id)
  })
  return btn
}

const createWorkplaceElement = (label: string): HTMLDivElement => {
  const pin = document.createElement('div')
  pin.className = 'workplace-pin'
  pin.textContent = 'W'
  pin.setAttribute('aria-label', `Workplace: ${label}`)
  pin.title = `Workplace: ${label}`
  return pin
}

export class CommuteMapView {
  private readonly map: L.Map
  private readonly zoneRenderer: L.SVG
  private readonly zoneLayerGroup: L.LayerGroup
  private readonly markerLayerGroup: L.LayerGroup
  private readonly workplaceLayerGroup: L.LayerGroup
  private readonly stopMarkers = new Map<
    string,
    { readonly marker: L.Marker; readonly button: HTMLButtonElement }
  >()
  private readonly onSelectStop: (stopId: string) => void

  constructor(container: HTMLElement, onSelectStop: (stopId: string) => void) {
    this.onSelectStop = onSelectStop
    this.map = L.map(container, {
      center: SINGAPORE_CENTER,
      zoom: DEFAULT_ZOOM,
      minZoom: 11,
      maxZoom: 18,
    })

    this.setupBaseLayers()
    this.zoneRenderer = L.svg({ pane: 'commuteZonePane' })
    this.zoneLayerGroup = L.layerGroup().addTo(this.map)
    this.markerLayerGroup = L.layerGroup().addTo(this.map)
    this.workplaceLayerGroup = L.layerGroup().addTo(this.map)
  }

  private setupBaseLayers(): void {
    const offlinePane = this.map.createPane('offlineBasePane')
    offlinePane.style.zIndex = '190'

    L.geoJSON(buildMutableOutline(), {
      pane: 'offlineBasePane',
      style: {
        fillColor: '#f6f7f5',
        fillOpacity: 1,
        color: '#8f9e98',
        weight: 1.5,
      },
      interactive: false,
    }).addTo(this.map)

    for (const region of OFFLINE_REGION_LABELS) {
      const labelEl = document.createElement('span')
      labelEl.className = 'offline-region-label'
      labelEl.textContent = region.name
      L.marker([region.latitude, region.longitude], {
        pane: 'offlineBasePane',
        interactive: false,
        icon: L.divIcon({
          className: '',
          html: labelEl,
          iconSize: [80, 18],
          iconAnchor: [40, 9],
        }),
      }).addTo(this.map)
    }

    L.tileLayer(ONEMAP_TILE_URL, {
      minZoom: 11,
      maxZoom: 18,
      attribution: 'OneMap © contributors | Singapore Land Authority',
    }).addTo(this.map)

    const zonePane = this.map.createPane('commuteZonePane')
    zonePane.style.zIndex = '410'
    zonePane.style.opacity = '0.34'
    zonePane.style.pointerEvents = 'none'

    const markerPane = this.map.getPane('markerPane')
    if (markerPane) {
      markerPane.style.zIndex = '600'
    }
    const workplacePane = this.map.createPane('workplacePane')
    workplacePane.style.zIndex = '620'
  }

  setWorkplace(workplace: Workplace | null): void {
    this.workplaceLayerGroup.clearLayers()
    if (!workplace) {
      return
    }
    const pinEl = createWorkplaceElement(workplace.label)
    L.marker([workplace.point.latitude, workplace.point.longitude], {
      pane: 'workplacePane',
      icon: L.divIcon({
        className: '',
        html: pinEl,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    }).addTo(this.workplaceLayerGroup)
  }

  clearStops(): void {
    this.zoneLayerGroup.clearLayers()
    this.markerLayerGroup.clearLayers()
    this.stopMarkers.clear()
    this.setSelectedStop(null)
  }

  addQualifyingStop(entry: QualifiedStop): void {
    if (this.stopMarkers.has(entry.stop.id)) {
      return
    }
    const coords: [number, number] = [
      entry.stop.point.latitude,
      entry.stop.point.longitude,
    ]
    L.circle(coords, {
      radius: ZONE_RADIUS_METERS,
      pane: 'commuteZonePane',
      renderer: this.zoneRenderer,
      fillColor: '#1B5E4B',
      fillOpacity: 1,
      stroke: false,
      interactive: false,
    }).addTo(this.zoneLayerGroup)

    const button = createStopPlaqueButton(entry, this.onSelectStop)
    const marker = L.marker(coords, {
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: '',
        html: button,
        iconSize: [48, 22],
        iconAnchor: [24, 11],
      }),
    }).addTo(this.markerLayerGroup)

    this.stopMarkers.set(entry.stop.id, { marker, button })
  }

  setSelectedStop(stopId: string | null): void {
    const markerPane = this.map.getPane('markerPane')
    if (markerPane) {
      markerPane.classList.toggle('has-selection', stopId !== null)
    }
    for (const [id, item] of this.stopMarkers) {
      const selected = id === stopId
      item.button.classList.toggle('is-selected', selected)
      item.marker.setZIndexOffset(selected ? 500 : 0)
    }
  }

  invalidateSize(): void {
    this.map.invalidateSize()
  }

  fitToMatches(
    workplace: Workplace | null,
    matches: readonly QualifiedStop[],
  ): void {
    const points: [number, number][] = matches.map((m) => [
      m.stop.point.latitude,
      m.stop.point.longitude,
    ])
    if (workplace) {
      points.push([workplace.point.latitude, workplace.point.longitude])
    }
    if (points.length === 0) {
      this.map.setView(SINGAPORE_CENTER, DEFAULT_ZOOM)
      return
    }
    this.map.fitBounds(L.latLngBounds(points), {
      padding: [40, 40],
      maxZoom: 15,
    })
  }
}
