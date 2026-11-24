# Commute-based housing search

The search identifies places to look for housing near boarding stops with a qualifying journey to a workplace in Singapore. It does not evaluate individual homes or the walk from a home to a stop.

## Language

**Workplace**: The destination point identified by a postal code or an exact, line-specific rail station ID. Choosing a station identifies a place to reach, not a line the traveller must take.

**Search date**: The Singapore date for which journeys are checked. The default is the first non-holiday Monday through Friday strictly after today, including observed public holidays among the dates to skip.

**Arrival window**: The interval from 15 minutes before office start through office start, inclusive. Arrival includes any final walk; arriving before the window and waiting at the workplace does not qualify.

**Ride cap**: The maximum total time aboard vehicles across all transit legs. Walking and waiting do not count against it.

**Qualifying journey**: A journey on the search date that first boards at the exact candidate stop, stays within the ride cap, and reaches the workplace inside the arrival window.

**Qualifying stop**: A directed bus stop or line-specific rail station with at least one qualifying journey. The exact destination station also qualifies with zero ride time; a different station ID at the same point does not qualify on that basis.

**Housing-search zone**: The union of areas within 500 m straight-line distance of qualifying stops. It can have disconnected patches; shading indicates proximity, not a verified walking route, and unshaded locations are not proven unreachable.
