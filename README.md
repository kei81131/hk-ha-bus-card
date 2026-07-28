# HK HA Bus Card

A frontend-only Home Assistant custom card for Hong Kong KMB, Citybus, Green
Minibus, and New Lantao Bus arrival times. It queries the public
transport APIs directly from the browser, so it does not require Node-RED,
helper entities, scenes, automations, or `card-mod`.

![HK HA Bus Card preview](images/preview.png)

## Features

- Route-first GUI search across all supported operators
- Operator, actual route direction, and stop selection from live route data
- Automatic KMB + Citybus joint-route discovery and merged ETA results
- Every displayed stop name comes from the selected route stop
- No ETA request until a direction button is pressed
- Automatic refresh while a 15-minute browser session is active
- Browser-session recovery when navigating or reloading Home Assistant views
- Configurable ETA window, route count, arrival count, and refresh interval
- Routes sorted by the earliest usable ETA
- Linear timeline with collision lanes for arrivals close together
- Operator route colours, urgent-arrival highlighting, and dark mode support
- Automatic content height in Home Assistant Sections views
- No built-in directions or personal stop IDs

## Install with HACS

1. In HACS, open the top-right menu and select **Custom repositories**.
2. Add this GitHub repository and select the **Dashboard** category.
3. Download **HK HA Bus Card**.
4. Confirm that the following JavaScript module resource exists under
   **Settings > Dashboards > Resources**:

   ```text
   /hacsfiles/hk-ha-bus-card/hk-ha-bus-card.js
   ```

5. Reload Home Assistant without browser cache, then add **HK HA Bus Card**
   from the card picker.

## Manual installation

1. Create the card directory and copy `hk-ha-bus-card.js` to:

   ```text
   /config/www/community/hk-ha-bus-card/hk-ha-bus-card.js
   ```

2. In **Settings > Dashboards > Resources**, add a JavaScript module resource:

   ```text
   /local/community/hk-ha-bus-card/hk-ha-bus-card.js?v=1.3.0
   ```

3. Reload the browser without cache. In the Home Assistant Companion App,
   fully close and reopen the app if it still uses an older resource.

4. Add **HK HA Bus Card** from the card picker, then use its GUI editor to add
   at least one direction, route, and stop.

Minimal YAML:

```yaml
type: custom:hk-ha-bus-card
title: HK HA Bus Card
session_key: hk_ha_bus_card
update_interval: 30
session_minutes: 15
display_window: 30
max_routes: 3
max_arrivals: 3
directions: []
```

The card deliberately ships with `directions: []`. Configure routes through
the visual editor instead of copying another user's route and stop IDs.

## Card Editor

For each direction:

1. Enter the direction button name.
2. Enter a route number and select **搜尋營辦商**.
3. If more than one unrelated operator matches, select KMB, Citybus, Green
   Minibus, or New Lantao Bus. KMB + Citybus joint routes such as 117 are
   combined automatically, so there is no separate operator choice.
4. Select the route's actual service direction and bus stop.
5. Select **加入這條路線**.

The card stores the name returned by the selected route-stop record. There is
no manually entered shared stop name, and different routes in one direction
may use different stops.

The direction name configured at the top is only used on the query button.
Every result row shows the actual destination returned by that route's live
route record.

The editor only calls route and stop discovery endpoints. It does not start ETA
polling; normal ETA requests still require pressing a direction button on the
dashboard.

## Configuration

| Option | Default | Description |
| --- | ---: | --- |
| `title` | `HK HA Bus Card` | Card heading |
| `session_key` | `hk_ha_bus_card` | Shares one browser-local query between card instances |
| `update_interval` | `30` | Refresh interval in seconds; minimum 10 |
| `session_minutes` | `15` | Time before automatic expiry |
| `display_window` | `30` | Only show arrivals within this many minutes |
| `max_routes` | `3` | Show the fastest routes only |
| `max_arrivals` | `3` | Maximum arrivals shown per route |
| `directions` | `[]` | Direction and route definitions created by the editor |

Use a different `session_key` when two cards should run independently. Use the
same key when copies of the same card should reconnect to one active query.

## Runtime behaviour

- Loading a card with no saved active session performs zero ETA requests.
- Pressing a direction starts an immediate query and periodic updates.
- Pressing again or changing direction aborts the older request and restarts
  the session timer.
- Active state is kept in a page-global owner and mirrored to `sessionStorage`.
  This allows both SPA navigation and full Home Assistant frontend reloads in
  the same browser tab to resume the remaining session.
- An expired session is removed and does not restart automatically.
- Each browser tab/device has its own session. Closing the tab, clearing site
  storage, signing out, or using private browsing may end it.

For a server-side session shared across devices or available when every browser
is closed, keep the query scheduler in Home Assistant or Node-RED instead.

## Troubleshooting

- **Custom element doesn't exist**: check the resource path and reload without
  cache.
- **Old card remains loaded**: increment the resource query suffix, for example
  `/local/community/hk-ha-bus-card/hk-ha-bus-card.js?v=1.3.1`.
- **Card is clipped in a Sections view after upgrading**: open the card menu
  while editing the dashboard and select **Reset size**. If YAML mode contains
  a saved `grid_options.rows`, remove that `rows` value. Version 1.3.0 leaves
  the row count automatic so the card grows with the displayed routes.
- **One device cannot query ETA**: check whether its browser, DNS, or network
  blocks `data.etabus.gov.hk`, `data.etagmb.gov.hk`, or `rt.data.gov.hk`.
- **No direction buttons appear**: open the Card Editor and configure routes;
  this project intentionally has no default directions.

## Upgrading from `custom:spk-bus-card`

Replace the old resource with
`/local/community/hk-ha-bus-card/hk-ha-bus-card.js?v=1.3.0`, then change the
card type to:

```yaml
type: custom:hk-ha-bus-card
```

The tag, resource filename, default `session_key`, and browser storage prefix
changed in version 1.1.0. Reopen the editor and save your route configuration
after upgrading.

## Upgrading from 1.1.x

Version 1.2.0 adds Citybus and New Lantao Bus, changes the editor to route-first
operator discovery, and removes the manually entered direction-level stop
name. Existing KMB and Green Minibus route records continue to work; reopen the
editor when adding or replacing routes so their selected stop names are saved
directly on each route.

## Upgrading to 1.3.0

Version 1.3.0 shortens the KMB label to `九巴`, automatically combines matching
KMB + Citybus joint routes, displays each route's real destination instead of
the direction-button name, and lets Sections views calculate the card height
from its content.

Existing separately saved KMB and Citybus records continue to work. To use the
new single-row joint-route behaviour, remove those old route records in the
editor and search/add the joint route again. In an existing Sections dashboard,
use **Reset size** once if the old fixed row height was saved in the view.
