import {
  OFFLINE_REGION_LABELS,
  SINGAPORE_OUTLINE_GEOJSON,
} from '@config/singapore-outline.js'
import type { BackwardLead } from '@lib/backward-planner.js'
import type {
  Coordinates,
  QualifiedStop,
  Workplace,
} from '@lib/commute-types.js'
import L from 'leaflet'
import {
  AREA_RADIUS_METERS,
  hasTenMinuteMargin,
} from './neighbourhood-preview.js'

const SINGAPORE_CENTER: [number, number] = [1.3521, 103.8198]
const DEFAULT_ZOOM = 12
const ONEMAP_TILE_URL =
  'https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png'

const cloneOutlineForLeaflet = (): GeoJSON.FeatureCollection => ({
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
  private readonly estimateLayerGroup: L.LayerGroup
  private readonly selectionLayerGroup: L.LayerGroup
  private readonly estimateRenderer: L.Canvas
  private readonly stopMarkers = new Map<
    string,
    { readonly marker: L.Marker; readonly button: HTMLButtonElement }
  >()
  private readonly onSelectStop: (stopId: string) => void

  constructor(
    container: HTMLElement,
    onSelectStop: (stopId: string) => void,
    onSelectArea: (point: Coordinates) => void,
  ) {
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
    this.estimateRenderer = L.canvas({ pane: 'estimatePane' })
    this.estimateLayerGroup = L.layerGroup().addTo(this.map)
    this.selectionLayerGroup = L.layerGroup().addTo(this.map)
    this.map.on('click', (event: L.LeafletMouseEvent) =>
      onSelectArea({ latitude: event.latlng.lat, longitude: event.latlng.lng }),
    )
    new ResizeObserver(() => this.invalidateSize()).observe(container)
  }

  private setupBaseLayers(): void {
    const offlinePane = this.map.createPane('offlineBasePane')
    offlinePane.style.zIndex = '190'

    L.geoJSON(cloneOutlineForLeaflet(), {
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

    const estimatePane = this.map.createPane('estimatePane')
    estimatePane.style.zIndex = '420'
    estimatePane.style.pointerEvents = 'none'
    const selectionPane = this.map.createPane('selectionPane')
    selectionPane.style.zIndex = '430'
    selectionPane.style.pointerEvents = 'none'
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

  clearPreview(): void {
    this.estimateLayerGroup.clearLayers()
    this.selectionLayerGroup.clearLayers()
  }

  setPreview(leads: readonly BackwardLead[], rideCapMinutes: number): void {
    this.clearPreview()
    const bounds = L.latLngBounds([])
    for (const lead of leads) {
      const point: [number, number] = [
        lead.stop.point.latitude,
        lead.stop.point.longitude,
      ]
      bounds.extend(point)
      L.circleMarker(point, {
        pane: 'estimatePane',
        renderer: this.estimateRenderer,
        radius: 4,
        color: hasTenMinuteMargin(lead.estRideMs, rideCapMinutes)
          ? '#2459a6'
          : '#a65c00',
        weight: 1,
        fillOpacity: 0.75,
        interactive: false,
      }).addTo(this.estimateLayerGroup)
    }
    if (bounds.isValid()) {
      this.map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 })
    }
  }

  setAreaSelection(point: Coordinates, focus: boolean): void {
    this.selectionLayerGroup.clearLayers()
    const centre: [number, number] = [point.latitude, point.longitude]
    L.circle(centre, {
      pane: 'selectionPane',
      radius: AREA_RADIUS_METERS,
      color: '#343c46',
      weight: 2,
      dashArray: '6 4',
      fill: false,
      interactive: false,
    }).addTo(this.selectionLayerGroup)
    if (focus) {
      this.map.setView(centre, 15, { animate: false })
    }
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
      radius: AREA_RADIUS_METERS,
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
      animate: false,
    })
  }
}
