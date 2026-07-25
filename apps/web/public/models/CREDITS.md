# 3D model credits — JNPA UC-2 3D sea-port scene

All meshes are used in the `#/` dashboard's 3D SceneView (2D/3D toggle) as ArcGIS
glTF object symbols. Licences below; CC-BY assets are attributed here as required.

| File | Model | Author | Source | Licence |
|------|-------|--------|--------|---------|
| `ship-cargo-a.glb`, `ship-cargo-b.glb` | Cargo ships | Kenney | Kenney Watercraft Kit (kenney.nl) | CC0 1.0 |
| `cargo-container-a/b/c.glb` | ISO containers (quay-apron cargo) | Kenney | Kenney Watercraft Kit | CC0 1.0 |
| `cargo-pile-a/b.glb` | Container stacks (quay-apron cargo) | Kenney | Kenney Watercraft Kit | CC0 1.0 |
| `toll-naka.glb` | Indian toll-naka gate canopy | — | Generated for this project | CC0 1.0 |
| `gate.glb` | Gate frame | Kenney | Kenney Watercraft Kit | CC0 1.0 |
| `boat-tug-a.glb` | Tug | Kenney | Kenney Watercraft Kit | CC0 1.0 |
| `truck.glb`, `delivery.glb` | Trucks | Kenney | Kenney Car Kit (kenney.nl) | CC0 1.0 |
| `sts-crane.glb` | Quay / gantry crane | **J-Toastie** | poly.pizza | **CC-BY 3.0** |
| `container-ship.glb` | Container ship (alt hero) | **Alex Safayan** | poly.pizza | **CC-BY 3.0** |
| `shipping-port.glb` | Shipping-port kit (spare parts) | Quaternius | poly.pizza | CC0 1.0 |
| `truck-realistic.glb` | Container haulage truck (static queue + live movers) | Quaternius | poly.pizza | CC0 1.0 |
| `pickup-realistic.glb` | Light vehicle (DPD / staff) | Quaternius | poly.pizza | CC0 1.0 |
| `rail-loco.glb` | Rake locomotive (live shunting train) | Quaternius | poly.pizza | CC0 1.0 |
| `rail-wagon.glb` | Flat rail wagon | Quaternius | poly.pizza | CC0 1.0 |
| `rail-container.glb` | Container rail wagon | Quaternius | poly.pizza | CC0 1.0 |
| `gate-realistic.glb` | Terminal gate arch (unused — replaced by composite gate) | **Poly by Google** | poly.pizza | **CC-BY 3.0** |
| `yard-container-red/green/blue.glb` | ISO containers — stacked yard blocks | Quaternius | poly.pizza | CC0 1.0 |
| `gate-boom.glb` | Gate boom barrier (composite gate-house) | Quaternius | poly.pizza | CC0 1.0 |

## Attribution (CC-BY 3.0 — required)

- "Quay / gantry crane" by **J-Toastie**, via poly.pizza — licensed under CC-BY 3.0.
- "Container Ship" by **Alex Safayan**, via poly.pizza — licensed under CC-BY 3.0.
- "Gate" by **Poly by Google**, via poly.pizza — licensed under CC-BY 3.0.

CC0 assets (Kenney, Quaternius) require no attribution but are credited above.

## Live-motion assets (sceneAnim.ts)

The moving trucks, the shunting rail rake (loco + wagons), and the crane hoist
boxes are animated per-frame on dedicated GraphicsLayers (`sceneAnim.ts`), driving
the Quaternius CC0 truck / rail set above along the real quay-aligned road and
siding geometry. Motion is a deterministic function of an elapsed-time clock and
freezes under `prefers-reduced-motion`.
