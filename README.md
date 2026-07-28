# HK HA Bus Card

A frontend-only Home Assistant custom card for Hong Kong KMB and GMB arrival
times. It queries the public transport APIs directly from the browser, so it
does not require Node-RED, helper entities, scenes, automations, or `card-mod`.

![HK HA Bus Card preview](images/preview.png)

## Features

- GUI Card Editor for choosing directions, routes, and stops
- No ETA request until a direction button is pressed
- Automatic refresh while a 15-minute browser session is active
- Browser-session recovery when navigating or reloading Home Assistant views
- Configurable ETA window, route count, arrival count, and refresh interval
- Routes sorted by the earliest usable ETA
- Linear timeline with collision lanes for arrivals close together
- KMB and GMB route colours, urgent-arrival highlighting, and dark mode support
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
   /local/community/hk-ha-bus-card/hk-ha-bus-card.js?v=1.1.0
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

1. Enter the direction button name and displayed stop name.
2. Select KMB or GMB. For GMB, also select the region.
3. Enter a route number and select **搜尋方向**.
4. Select the service direction and stop.
5. Select **加入已選路線**.

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
  `/local/community/hk-ha-bus-card/hk-ha-bus-card.js?v=1.1.1`.
- **One device cannot query ETA**: check whether its browser, DNS, or network
  blocks `data.etabus.gov.hk` or `data.etagmb.gov.hk`.
- **No direction buttons appear**: open the Card Editor and configure routes;
  this project intentionally has no default directions.

## Upgrading from `custom:spk-bus-card`

Replace the old resource with
`/local/community/hk-ha-bus-card/hk-ha-bus-card.js?v=1.1.0`, then change the
card type to:

```yaml
type: custom:hk-ha-bus-card
```

The tag, resource filename, default `session_key`, and browser storage prefix
changed in version 1.1.0. Reopen the editor and save your route configuration
after upgrading.
