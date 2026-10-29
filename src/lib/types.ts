export type Species =
  | "cat"
  | "bunny"
  | "blob"
  | "dog"
  | "fox"
  | "panda"
  | "frog"
  | "penguin"
  | "ghost"
  | "dragon"
  | "axolotl"
  | "owl";

export type Note = {
  id: string;
  title: string;
  content: string;
  cover: string | null;
  pinned: boolean;
  folderId: string | null;
  tags: string[];
  createdAt: number;
  updatedAt: number;
};

export type Folder = {
  id: string;
  name: string;
  icon: string;
  color: string;
  position: number;
};

export type CanvasNode = {
  id: string;
  type: "note" | "text" | "image" | "draw";
  x: number;
  y: number;
  w: number;
  h: number;
  noteId?: string;
  text?: string;
  src?: string;
  tone?: number;
  /** draw nodes: flat [x0,y0,x1,y1,…] world-space polyline (x/y/w/h is the bbox) */
  points?: number[];
  color?: string;
  sw?: number;
};
export type CanvasEdge = { id: string; from: string; to: string };
export type CanvasData = {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  view: { x: number; y: number; z: number };
};
export type Canvas = { id: string; name: string; data: CanvasData; updatedAt: number };

export type PetStats = { words: number; fed: number; pats: number; games: number; focus: number; best: number; sold: number; earned: number; sales: number; tricks: number };
/** custom colour override for a pet's look — ramp is 5 shades dark→light */
export type PetLook = { ramp?: string[]; accent?: string };
export type Pet = {
  id: string;
  name: string;
  species: Species;
  food: number;
  energy: number;
  joy: number;
  xp: number;
  coins: number;
  hat: string;
  owned: string[];
  tricks: string[];
  stats: PetStats;
  look: PetLook;
  tickAt: number;
};

/** a saveable pet design in the pet library — "use" it to make it your active companion */
export type PetBlueprint = {
  id: string;
  folderId: string | null;
  name: string;
  species: Species;
  look: PetLook & { says?: string[]; blurb?: string };
  origin: "builtin" | "custom" | "imported";
  updatedAt: number;
};
export type PetFolderRow = { id: string; name: string; position: number };

export type ListingKind = "hat" | "pet" | "food" | "theme" | "decor" | "iconpack" | "fontpack" | "wallpaper" | "game";
/** one point on a listing's price timeline */
export type ListingPricePoint = { p: number; k: "list" | "reprice" | "sold"; at: number };
export type Listing = {
  id: string;
  kind: ListingKind;
  itemId: string;
  name: string;
  blurb: string;
  price: number;
  seller: string;
  payload: Record<string, unknown>;
  sold: boolean;
  createdAt: number;
  /** price timeline (listed → reprice… → sold) — present on GET /api/listings responses */
  history?: ListingPricePoint[];
};

export type InitialData = { notes: Note[]; canvases: Canvas[]; pet: Pet; folders: Folder[]; listings: Listing[] };
/** import/export envelope for pet blueprints + their folders */
export type PetPack = {
  format: "nook-pets";
  version: 1;
  exportedAt: string;
  folders: { id: string; name: string; position: number }[];
  pets: { name: string; species: string; folderName?: string; look?: PetLook & { says?: string[]; blurb?: string }; origin?: string }[];
};

export type AiLink = { id: string; title: string; reason: string };
/** one harness tool run, rendered as a card in the chat UI */
export type AiTool = { name: string; args: Record<string, unknown>; ok: boolean; summary: string; ms: number };
export type AiEffect =
  | { type: "navigate"; view: string }
  | { type: "theme"; id: string }
  | { type: "pet"; mood: "happy" | "think" | "spin" }
  | { type: "confetti" };
export type AiResult = {
  mode: "local" | "cloud";
  text: string;
  title?: string;
  tags?: string[];
  links?: AiLink[];
  sources?: { id: string; title: string; url?: string }[];
  /** harness tool runs that already executed server-side */
  tools?: AiTool[];
  /** client-side side effects the assistant requests (navigate, theme switch, pet reaction…) */
  effects?: AiEffect[];
  /** true while the harness executed real work for this answer */
  acted?: boolean;
};

export type Achievement = { key: string; title: string; desc: string; icon: string; at: number };
