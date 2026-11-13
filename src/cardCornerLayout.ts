/** Shared by the live SVG and the cached animation artwork. */
export function cardCornerLayout(narrow: boolean) {
  return {
    rank: { x: narrow ? 4 : 10, y: narrow ? 25 : 26, size: narrow ? 20 : 22,
      family: narrow ? 'Arial Narrow, Arial, sans-serif' : 'Georgia, serif', width: narrow ? 12 : 20 },
    suit: { x: narrow ? 4 : 11, y: narrow ? 41 : 44, size: narrow ? 12 : 18 },
  };
}
