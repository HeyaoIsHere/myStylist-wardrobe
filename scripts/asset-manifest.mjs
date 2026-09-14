/**
 * Asset manifest shared by fetch-assets.mjs and gen-svgs.mjs.
 * Each wardrobe slot: stem, garment drawing type, variant, and Unsplash
 * candidate photo IDs (tried in order; first success wins, else an SVG
 * editorial illustration is generated instead).
 */
export const WARDROBE_SLOTS = [
  // — Tops
  { stem: "tops-oxford-shirt", type: "top", variant: 0, color: "white", candidates: ["1521572163474-6864f9cf17ab", "1596755094514-f87e34085b2c", "1611312449408-fcece27cdbb7"] },
  { stem: "tops-silk-blouse", type: "top", variant: 1, color: "cream", candidates: ["1611485988300-b7530defb8e2", "1620799140408-edc6dcb6d633"] },
  { stem: "tops-cashmere-sweater", type: "top", variant: 2, color: "oat", candidates: ["1620656798579-1984d9e87df7", "1434389677669-e08b4cac3105"] },
  { stem: "tops-black-turtleneck", type: "top", variant: 2, color: "black", candidates: ["1583743814966-8936f5b7be1a", "1576566588028-4147f3842f27"] },
  { stem: "tops-striped-linen", type: "top", variant: 0, color: "bluewhite", candidates: ["1594938298603-c8148c4dae35", "1596755094514-f87e34085b2c"] },
  // — Bottoms
  { stem: "bottoms-straight-jeans", type: "bottom", variant: 0, color: "indigo", candidates: ["1542272604-787c3835535d", "1594633312681-425c7b97ccd1"] },
  { stem: "bottoms-wide-trousers", type: "bottom", variant: 1, color: "black", candidates: ["1594633312681-425c7b97ccd1", "1515886657613-9f3515b0c78f"] },
  { stem: "bottoms-pleated-cream", type: "bottom", variant: 1, color: "cream", candidates: ["1515886657613-9f3515b0c78f"] },
  { stem: "bottoms-satin-skirt", type: "bottom", variant: 3, color: "champagne", candidates: [] },
  // — Dresses
  { stem: "dresses-lbd", type: "dress", variant: 0, color: "black", candidates: ["1598554747436-c9293d6a588f", "1617952236317-0bd127407984"] },
  { stem: "dresses-slip-ivory", type: "dress", variant: 1, color: "ivory", candidates: ["1594223274512-ad4803739b7c", "1529374255404-311a2a4f1fd9"] },
  { stem: "dresses-wrap-terracotta", type: "dress", variant: 1, color: "terracotta", candidates: ["1595777457583-95e059d581b8"] },
  { stem: "dresses-knit-midi", type: "dress", variant: 2, color: "grey", candidates: ["1592878904946-b3cd8ae243d0", "1585487000160-6ebcfceb0d03"] },
  // — Outerwear
  { stem: "outer-camel-coat", type: "coat", variant: 0, color: "camel", candidates: ["1539533018447-63fcce2678e3", "1539109136881-3be0616acf4b"] },
  { stem: "outer-leather-jacket", type: "jacket", variant: 0, color: "black", candidates: ["1551028719-00167b16eac5"] },
  { stem: "outer-trench-beige", type: "coat", variant: 1, color: "beige", candidates: ["1559563458-527698bf5295", "1539533018447-63fcce2678e3"] },
  { stem: "outer-tweed-jacket", type: "jacket", variant: 1, color: "creamblack", candidates: ["1612336307429-8a898d10e223", "1520975954732-35dd22299614"] },
  // — Shoes
  { stem: "shoes-white-sneakers", type: "sneaker", variant: 0, color: "white", candidates: ["1595950653106-6c9ebd614d3a", "1560343090-f0409e92791a", "1595341888016-a392ef81b7de", "1611591437281-460bfbe1220a", "1575032617751-6ddec2089882", "1600185365483-26d7a4cc7519"] },
  { stem: "shoes-black-loafers", type: "loafer", variant: 0, color: "black", candidates: ["1591047139829-d91aecb6caea"] },
  { stem: "shoes-strappy-heels", type: "heel", variant: 0, color: "nude", candidates: ["1543163521-1bf539c55dd2", "1590736969955-71cc94901144", "1566174053879-31528523f8ae"] },
  { stem: "shoes-chelsea-boots", type: "boot", variant: 0, color: "brown", candidates: [] },
  { stem: "shoes-ballet-flats", type: "flat", variant: 0, color: "black", candidates: ["1543512214-318c7553f230"] },
  // — Bags
  { stem: "bags-leather-tote", type: "tote", variant: 0, color: "tan", candidates: ["1584917865442-de89df76afd3", "1591561954557-26941169b49e"] },
  { stem: "bags-black-crossbody", type: "bag", variant: 0, color: "black", candidates: ["1572804013309-59a88b7e92f1", "1622560480605-d83c853bc5c3"] },
  { stem: "bags-woven-straw", type: "tote", variant: 1, color: "straw", candidates: [] },
  // — Accessories
  { stem: "acc-gold-hoops", type: "earring", variant: 0, color: "gold", candidates: [] },
  { stem: "acc-pearl-necklace", type: "necklace", variant: 0, color: "pearl", candidates: ["1515562141207-7a88fb7ce338"] },
  { stem: "acc-silk-scarf", type: "scarf", variant: 0, color: "multi", candidates: ["1520903920243-00d872a2d1c9"] },
  // — Hats
  { stem: "hats-straw-sun", type: "hat", variant: 0, color: "straw", candidates: ["1548036328-c9fa89d128fa", "1521572163474-6864f9cf17ab"] },
  { stem: "hats-black-beanie", type: "hat", variant: 1, color: "black", candidates: [] },
  // — Socks
  { stem: "socks-white-crew", type: "sock", variant: 0, color: "white", candidates: ["1586350977771-b3b0abd50c82"] },
  { stem: "socks-cashmere-grey", type: "sock", variant: 1, color: "grey", candidates: [] },
];

export const INSPO_SLOTS = [
  { stem: "inspo-sunlit-linen", variant: 0, palette: ["#E8D9BE", "#C9A26B", "#7B6A4F"], candidates: ["1490481651871-ab68de25d43d", "1483985988355-763728e1935b"] },
  { stem: "inspo-paris-cafe", variant: 1, palette: ["#2A241E", "#C8A97E", "#F0E7D8"], candidates: ["1509631179647-0177331693ae"] },
  { stem: "inspo-coastal-minimal", variant: 2, palette: ["#DCE6E8", "#A5B8C9", "#F5F0E7"], candidates: ["1529139574466-a303027c1d8b"] },
  { stem: "inspo-autumn-layers", variant: 3, palette: ["#C08A6A", "#7B7A54", "#E4D5BC"], candidates: ["1539109136881-3be0616acf4b"] },
  { stem: "inspo-street-chic", variant: 4, palette: ["#26221D", "#E5DED2", "#8A6242"], candidates: ["1495385794356-15371f348c31"] },
  { stem: "inspo-atelier-rack", variant: 5, palette: ["#E8D9BE", "#C8A97E", "#5A6B7E"], candidates: ["1445205170230-053b83016050", "1441986300917-64674bd600d8", "1489987707025-afc232f7ea0f"] },
  { stem: "inspo-soft-portrait", variant: 6, palette: ["#F0E7D8", "#C9A26B", "#2A241E"], candidates: ["1517841905240-472988babdf9", "1529626455594-4ff0802cfb7e"] },
  { stem: "inspo-magazine-edit", variant: 7, palette: ["#F5F0E7", "#26221D", "#C08A6A"], candidates: ["1469334031218-e382a71b716b"] },
  { stem: "inspo-shoes-purse", variant: 8, palette: ["#E9DCC3", "#8A6242", "#26221D"], candidates: ["1487222477894-8943e31ef7b2"] },
  { stem: "inspo-effortless-denim", variant: 9, palette: ["#5A6B7E", "#F5F0E7", "#C8A97E"], candidates: ["1594633312681-425c7b97ccd1", "1515886657613-9f3515b0c78f"] },
  { stem: "inspo-evening-glow", variant: 10, palette: ["#C08A6A", "#2A241E", "#E9DCC3"], candidates: ["1496747611176-843222e1e57c"] },
  { stem: "inspo-weekend-editorial", variant: 11, palette: ["#E5DED2", "#7B7A54", "#C9A26B"], candidates: ["1524250502761-1ac6f2e30d43"] },
];

export const FONTS = [
  { family: "Cormorant Garamond", file: "cormorant", weights: [{ w: "400", italic: false }, { w: "400", italic: true }, { w: "500", italic: false }, { w: "600", italic: false }, { w: "700", italic: false }] },
  { family: "Inter", file: "inter", weights: [{ w: "400", italic: false }, { w: "500", italic: false }, { w: "600", italic: false }] },
];
