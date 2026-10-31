/** store-free brand helpers (the widget imports these without pulling in the app store) */
export type BrandTone = "dark" | "light";
export const brandSrc = (tone: BrandTone, size: 128 | 256 = 128) => `/brand/nook-${tone}-${size}.webp`;
