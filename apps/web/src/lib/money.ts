/** Display-only: integer piastres → "EGP X.XX". Never use the result as an API value. */
export function formatEGP(piastres: number): string {
  return `EGP ${(piastres / 100).toFixed(2)}`;
}
