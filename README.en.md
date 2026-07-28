[廣東話](README.md) | **English**

# HK HA Bus Card

A Home Assistant custom card for checking arrival times for Hong Kong KMB,
Citybus, Green Minibus, and New Lantao Bus services.

![HK HA Bus Card preview](images/preview.png)

## Features

- Enter a route number first, then search across all supported operators
- Select the actual service direction and bus stop from official route data
- Automatically identify joint KMB + Citybus routes and merge their ETAs
- Keep KMB-only special and short-working journeys in the same joint-route group
- Display stop names directly from the official data for each selected route
- Do not query automatically when the dashboard opens; a direction button must be pressed first
- Refresh automatically after a query starts and stop after 15 minutes by default
- Configure the ETA display window, maximum routes, arrivals per route, and refresh interval
- Sort routes by the earliest arrival time

## Install with HACS

1. Open HACS, select the menu in the top-right corner, then choose
   **Custom repositories**.
2. Add this GitHub repository and select **Dashboard** as the category.
3. Download **HK HA Bus Card**.
4. Go to **Settings > Dashboards > Resources** and confirm that this JavaScript
   module is present:

   ```text
   /hacsfiles/hk-ha-bus-card/hk-ha-bus-card.js
   ```

5. Clear the browser cache and reload Home Assistant, then add
   **HK HA Bus Card** from the card picker.

## Manual installation

1. Create the directory and place `hk-ha-bus-card.js` at:

   ```text
   /config/www/community/hk-ha-bus-card/hk-ha-bus-card.js
   ```

2. Go to **Settings > Dashboards > Resources** and add this JavaScript module:

   ```text
   /local/community/hk-ha-bus-card/hk-ha-bus-card.js?v=1.3.2
   ```

3. Clear the browser cache and reload. If the Home Assistant Companion App
   still uses an older version, fully close and reopen the app.

4. Add **HK HA Bus Card** from the card picker, then use the visual editor to
   add at least one direction, route, and bus stop.

Minimal configuration:

```yaml
type: custom:hk-ha-bus-card
title: HK HA Bus Card
session_key: auto
update_interval: 30
session_minutes: 15
display_window: 30
max_routes: 3
max_arrivals: 3
directions: []
```

The card uses `directions: []` by default. Configure your own routes through
the visual editor instead of copying another user's route and stop IDs.

## Using the Card Editor

For each query direction:

1. Enter a direction button name, such as "Home" or "Work".
2. Enter a bus route and select **搜尋營辦商**.
3. If the route number belongs to several unrelated operators, select KMB,
   Citybus, Green Minibus, or New Lantao Bus. Joint KMB + Citybus routes such as
   117 and 118 are grouped automatically, so KMB and Citybus do not need to be
   selected separately.
4. Select the route's actual service direction and bus stop.
5. Select **加入這條路線**.

For some joint routes, the official API also provides KMB-only special or
short-working journeys. Examples include route 118 journeys starting from
Mong Kok, the Cross-Harbour Tunnel, or Chai Wan. These journeys remain in the
**Route direction** list of the same joint-route group. If a KMB-only journey
is selected, the result row correctly displays **KMB**.

The card stores the official name of the selected route's bus stop. There is
no need to enter a shared stop name manually, and different routes under the
same query direction may use different bus stops.

The direction name configured at the top is used only on the query button.
Each route result displays the actual destination from that route's official
data.

The editor calls only route and stop discovery APIs. It does not start ETA
polling. Normal ETA queries still begin only after a direction button is
pressed on the dashboard.

## Configuration

| Option | Default | Description |
| --- | ---: | --- |
| `title` | `HK HA Bus Card` | Card title |
| `session_key` | `auto` | Automatically isolates sessions according to each card's directions and routes |
| `update_interval` | `30` | Refresh interval in seconds; minimum 10 seconds |
| `session_minutes` | `15` | Number of minutes before queries stop automatically |
| `display_window` | `30` | Only display arrivals within this many minutes |
| `max_routes` | `3` | Maximum number of earliest-arriving routes to display |
| `max_arrivals` | `3` | Maximum number of arrivals to display per route |
| `directions` | `[]` | Direction and route settings created by the Card Editor |

With `auto`, cards containing different directions or routes query independently,
while the same card can still reconnect to its session after a view change or
reload. To intentionally share a query between several cards, give them the
same custom `session_key`; use different keys to keep them independent.

## Query behaviour

- Loading the card without a saved session does not send any ETA requests.
- Pressing a direction button starts an immediate query followed by updates at
  the configured interval.
- Pressing the same button again or changing direction cancels the previous
  request and restarts the session timer.
- Query state is kept by a page-global owner and synchronized to
  `sessionStorage`, allowing the same browser tab to recover after switching
  views or reloading Home Assistant.
- Updates stop when the session expires and do not restart automatically.
- Each browser tab or device has its own session. Closing the tab, clearing
  site data, signing out, or using private browsing may end the session.

If queries must be shared across devices or continue after every browser is
closed, keep the query scheduler in Home Assistant or Node-RED.

## Troubleshooting

- **Custom element doesn't exist**: check the resource path, then clear the
  browser cache and reload.
- **The old card is still loaded**: increase the version number at the end of
  the resource URL, for example
  `/local/community/hk-ha-bus-card/hk-ha-bus-card.js?v=1.3.3`.
- **Cards on different pages show the same query result**: upgrade to 1.3.2 and
  set `session_key` to `auto`. The legacy default `hk_ha_bus_card` is also
  treated as `auto` automatically.
- **The card is clipped in a Sections view**: enter dashboard edit mode, open
  the card menu, and select **Reset size**. If the YAML contains a saved
  `grid_options.rows` value, remove `rows`.
- **One device cannot query ETAs**: check whether its browser, DNS, or network
  blocks `data.etabus.gov.hk`, `data.etagmb.gov.hk`, or `rt.data.gov.hk`.
- **No direction buttons are shown**: open the Card Editor and add directions
  and routes. This project intentionally provides no default directions.
