import type { Stop, StopInventory } from '@lib/commute-types.js'
import { filterRailStations } from '@lib/inventory.js'
import type { AppElements } from './dom-render.js'

export const stationLabel = (station: Stop): string =>
  `${station.id} ${station.name}`

export const wireStationAutocomplete = (
  {
    stationInput: input,
    stationSuggestions: list,
    stationSearchStatus: status,
  }: AppElements,
  inventory: StopInventory,
  onSelect: (station: Stop) => void,
): void => {
  let active: Element | null = null
  const setActive = (option: Element | null): void => {
    active?.setAttribute('aria-selected', 'false')
    active = option
    if (option) {
      option.setAttribute('aria-selected', 'true')
      input.setAttribute('aria-activedescendant', option.id)
    } else {
      input.removeAttribute('aria-activedescendant')
    }
  }
  const close = (): void => {
    setActive(null)
    list.hidden = true
    status.textContent = ''
    input.setAttribute('aria-expanded', 'false')
  }

  input.addEventListener('input', () => {
    close()
    const query = input.value.trim()
    if (!query) return
    const stations = filterRailStations(inventory, query).slice(0, 6)
    if (stations.length === 0) {
      status.textContent = 'No matching stations.'
      return
    }
    const options = stations.map((station) => {
      const option = document.createElement('div')
      option.id = `station-option-${station.id}`
      option.textContent = stationLabel(station)
      option.setAttribute('role', 'option')
      option.setAttribute('aria-selected', 'false')
      option.addEventListener('click', () => {
        input.value = stationLabel(station)
        close()
        onSelect(station)
      })
      return option
    })
    list.replaceChildren(...options)
    list.hidden = false
    input.setAttribute('aria-expanded', 'true')
  })

  input.addEventListener('keydown', (event) => {
    if (event.isComposing || list.hidden) return
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        close()
        break
      case 'Enter':
        if (!(active instanceof HTMLElement)) return
        event.preventDefault()
        active.click()
        break
      case 'ArrowDown':
        event.preventDefault()
        setActive(active?.nextElementSibling ?? list.firstElementChild)
        break
      case 'ArrowUp':
        event.preventDefault()
        setActive(active?.previousElementSibling ?? list.lastElementChild)
        break
    }
  })
  list.addEventListener('pointerdown', (event) => event.preventDefault())
  input.addEventListener('blur', close)
  input.disabled = false
}
