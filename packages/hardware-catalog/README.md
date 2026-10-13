# `@schemora/catalog`

This package publishes typed, versioned hardware facts. Its first release is intentionally small: one ESP32 development board configuration, one red LED, one resistor, and one exact breadboard topology. Records describe source-backed component identity and facts. They do not assert that an arbitrary assembly is electrically safe or physically compatible.

## Public interface

```ts
import { catalogRelease2026_10, getCatalogRelease } from '@schemora/catalog';
import type { BreadboardTopology, CatalogPart, CatalogRelease } from '@schemora/catalog';
```

`catalogReleaseSchema` and the per-kind Zod schemas are exported for validation at API, persistence, and worker boundaries. Consumers should pin a `releaseId` with stored designs and validation reports. A published release is immutable: corrections or additions produce a new release and preserve the old record for historical projects. `BreadboardTopology` exposes an exact board topology, its own `id` and `version`, source references, and explicit hole connectivity sets.

`CatalogPart.id` is stable across releases for the same physical model and configuration. The release ID identifies the exact facts snapshot. Board pins map a semantic terminal ID to a manufacturer-documented header, one-based position, printed label, and functions. LED polarity uses `anodeTerminalId` and `cathodeTerminalId`; the catalog schema rejects references that do not resolve to distinct terminals with matching electrical roles. Part terminals are semantic identities; they are not 3D mesh anchors or breadboard holes.

Every part names its source documents, and release claims link a property to a source locator and a short evidence note. Parsing validates source and subject references. Publication tooling still needs to add review identity, content hashing/signature, and immutable persistence before this package can serve as the production catalog.

## Initial release boundary

`schemora-hw-2026.10` includes:

- **ESP32-DevKitC V4 + ESP32-WROOM-32E + male headers.** The board guide lists several module/header variants, so the module and header configuration must be checked on the physical board. Only documented GPIO19 (J3 position 8), selected GND terminals, and the 3V3 header terminal are modeled. The 3.0–3.6 V figure is the module operating supply range; it does not describe the full board power-source behavior. GPIO current design limits and board total-current budget are intentionally not represented here.
- **Kingbright WP7113ID.** The manufacturer rates forward voltage at 10 mA (1.9 V typical, 2.3 V maximum), maximum DC forward current at 30 mA, and dissipation at 75 mW. These are device ratings and do not themselves select a safe operating current.
- **YAGEO CFR-25JB-52-220R.** The manufacturer specifies 220 ohms, ±5%, and CFR-25 rated power of 0.25 W. It is a non-polarized axial resistor.

The release includes **BusBoard BB400 / BB400T** topology: 60 five-hole terminal groups and four continuous 25-hole rails. This is a specific manufacturer model, not a generic 400-point layout. Rail color/location names do not assign circuit voltage or ground. Other brands, look-alike boards, and boards with different rail breaks are unsupported. The topology does not yet supply mesh anchors or geometry placement. Other DevKit versions, WROVER or UE modules, clone boards, other LED/resistor SKUs, and UNO R3 are outside this release.

This catalog supports identity and fact lookup only. It does not include derived current limits, GPIO derating policy, circuit validation rules, a complete LED I-V curve, exact board SKU ordering identity, or a physical safety certification. Those require separately researched rules and reviewed circuit fixtures.

## Sources

All records below were checked against manufacturer sources on 2026-10-13:

- Espressif, [ESP32-DevKitC V4 User Guide](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html): module/header variant list, header pin tables, and power supply options.
- Espressif, [ESP32-WROOM-32E / 32UE Datasheet](https://documentation.espressif.com/esp32-wroom-32e_esp32-wroom-32ue_datasheet_en.html): module operating supply voltage and variant details.
- Kingbright, [WP7113ID specification](https://www.kingbrightusa.com/images/catalog/SPEC/WP7113ID.pdf), revision V.14A (2026-01-08): package, color, voltage test point, absolute ratings.
- YAGEO, [CFR-25JB-52-220R part specification](https://www.yageogroup.com/component-documentation/download/specsheet/CFR-25JB-52-220R) and [CFR Series specification](https://yageogroup.com/content/datasheet/asset/file/YAGEO-CFR_DATASHEET), revision V.3 (2024-04-03): exact resistance/tolerance and CFR-25 series construction/rating.
- BusBoard Prototype Systems, [BB400 product page](https://busboard.com/BB400T), [BB400 Rev 7 datasheet](https://www.busboard.com/documents/datasheets/BPS-DAT-%28BB400%29-Datasheet.pdf), and manufacturer [Rev 6 internal connection detail](https://www.busboard.com/documents/datasheets/BPS-DAT-%28BB400%29-Datasheet.pdf): orderable BB400/BB400T variants, hole count, row/rail topology, dimensions, pitch, and rating.

## Checks

`pnpm --filter @schemora/catalog typecheck` and `pnpm --filter @schemora/catalog test` validate the contract, initial release references, selected board pin mapping, and exact starter component ratings.
