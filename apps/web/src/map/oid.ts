/**
 * Stable feature ids, shared by the 2D layers and the 3D scene.
 *
 * This lives in its own module so `layers.ts` and `scene3d.ts` can both use it
 * without an import cycle — `layers.ts` needs `pkeyPosition` from `scene3d.ts`
 * so that a gate has ONE coordinate in 2D and 3D, and `scene3d.ts` previously
 * reached back into `layers.ts` purely for this function.
 */

/**
 * Stable, deterministic objectId from a logical key (gateId, facilityId, …).
 * Using a stable id per asset lets the FeatureLayerView UPDATE a feature in
 * place (smooth attribute/renderer transition) instead of delete+re-add, which
 * is what caused the whole-layer "blink" on every sim tick.
 */
export function stableOid(key: string): number {
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  return Math.abs(h) || 1;
}
