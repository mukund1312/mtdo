# Architecture 02 fixed-layer layout

Signal Deck has one shared safe-area contract for persistent controls. It is
implemented in `web/app/(marketing)/architecture-02/fixed-layer-safety.css`.
Page content uses `--a02-content-safe-bottom`, so it can scroll above every
persistent control instead of each screen maintaining a separate magic number.

| Layer | Position | z-index | Desktop dimensions / behavior | Mobile behavior | Surfaces |
| --- | --- | ---: | --- | --- | --- |
| Dock | Fixed, bottom center | 20 | 59px high, 23px from the bottom | 55px high, 17px + device safe inset | Home, Kanban, Goals, Time, Review, Listen |
| Audio transport | Fixed, bottom left | 19 | 46px high; aligns to dock baseline on desktop, utility row above dock on tablet | Compact 45px utility, aligned above dock | Home, Kanban, Goals, Time, Review, Listen |
| Co-pilot trigger | Fixed, bottom right | 21 | 53px utility row above dock | 45px utility row above dock; label collapses | Home, Kanban, Goals, Time, Review, Listen |
| Co-pilot panel | Fixed contextual panel | 30 | Right edge; bottom clears dock and utility row | Full-width inset panel; bottom clears dock | Home, Kanban, Goals, Time, Review, Listen |
| Feedback trigger | Fixed global control | 40 | Dock baseline at the far right | Stacked above the Audio/Co-pilot utility row | All non-session pages |
| Feedback form | Fixed temporary modal panel | 40 | Above dock, Co-pilot, and their gap | Above the mobile utility row; height constrained to viewport | All non-session pages |
| Product modals / welcome / walkthrough | Fixed modal overlay | 20–41 | Deliberate modal state over inactive UI | Same, viewport constrained | Their owning screen only |
| Listen source rail | Sticky inside Listen content | 2 | No independent viewport layer | Sticky only at <=650px | Listen |

The open Feedback panel sets `data-a02-feedback-open` on the document root.
That temporarily adds to the page reserve instead of covering bottom controls
or form fields. A z-index 39 backdrop makes the temporary form modal, so
background controls cannot be accidentally activated beneath it. The attribute
is removed when the panel closes or the route unmounts.

Persistent controls are ordered from lowest to highest as transport (19), dock
(20), Co-pilot trigger (21), contextual Co-pilot panel (30), then global
Feedback (40). Modal overlays intentionally sit above those layers and are not
treated as persistent controls.
