import { db } from "@/db";
import type { CanvasData } from "@/lib/types";

const g = globalThis as typeof globalThis & { __nookReady?: Promise<void> };

const DAY = 86_400_000;

type Seed = { id: string; title: string; content: string; cover?: string; pinned?: boolean; folder?: string; age: number };

const SEED_NOTES: Seed[] = [
  {
    id: "n-welcome",
    title: "Welcome to Nook",
    cover: "/art/cover-peaks.webp",
    pinned: true,
    age: 0,
    content: `# Welcome to Nook

A soft, pixel-flavoured second brain with a tiny friend living inside it. #start

Everything you write becomes a node you can **see**:

- Jump into the [[Graph view]] and spin your notes around in 3D
- Lay ideas out on an infinite board in [[Canvas boards]]
- Say hi to your companion, [[Meet Mochi]] — they level up while you write
- Learn the [[Keyboard shortcuts]] to fly around
- Play a round in the [[Arcade]] — 12 tiny games pay out coins
- Visit the [[Team room]] and the [[Marketplace]]

> Tip: type [[ in any note to link it to another one. Linked notes appear as stars in the graph.

## First steps
- [x] Open the welcome note
- [ ] Press Ctrl+K and search for anything
- [ ] Write 50 words and watch the coin counter
- [ ] Feed your pet from the Den
- [ ] Beat your high score in the Arcade

Dive into the [[Ideas garden]] when you are ready to plant something.
`,
  },
  {
    id: "n-graph",
    title: "Graph view",
    age: 1,
    content: `# Graph view

Every [[wikilink]] draws a line between two notes. The graph shows your whole mind at once. #guide

## 2D and 3D
- **2D** is a calm, flat constellation
- **3D** lets you orbit, tilt and zoom through depth — drag to rotate, scroll to zoom
- Toggle **Orbit** for a slow cinematic spin

## Tricks
- Click a node to see its card, double-click to open it
- Drag a node to pin it somewhere
- Turn on **Tags** to see topic hubs
- Use **Local** to only see notes near the one you are editing

Back to [[Welcome to Nook]] or try [[Canvas boards]].
`,
  },
  {
    id: "n-canvas",
    title: "Canvas boards",
    age: 2,
    content: `# Canvas boards

Boards are infinite. Drop notes, sticky text and pixel art, then connect them. #guide

1. Pan by dragging the background
2. Scroll to zoom toward your cursor
3. Drag from the small dot on a card's edge to connect it to another card
4. Press Delete to remove the selection

Boards are saved automatically. Want a quick start? Open the *Welcome board* and rearrange it.

See also [[Graph view]] and [[Ideas garden]].
`,
  },
  {
    id: "n-pet",
    title: "Meet Mochi",
    cover: "/art/cover-forest.webp",
    age: 1,
    folder: "f-pets",
    content: `# Meet Mochi

Mochi is a pixel companion that roams the bottom of your window. #pet

## How to earn coins
- Every ~20 words you write gives **1 coin** and some XP
- Finishing a focus session gives **10 coins**
- Every Arcade game pays out — 12 games to master
- Sell your own treasures in the [[Marketplace]]

## What you can do together
- Pet, feed, nap and play fetch
- Adopt a friend from 12 species — fox, panda, dragon, axolotl and more
- Buy hats in the closet (the crown is *very* fancy)
- Ask Mochi questions about your notes — they search your whole vault
- Let Mochi dig up forgotten notes you have not touched in a while

Keep Mochi happy and they will keep you writing. See [[Focus rituals]] for more.
`,
  },
  {
    id: "n-keys",
    title: "Keyboard shortcuts",
    age: 3,
    folder: "f-guides",
    content: `# Keyboard shortcuts

Built for a physical keyboard. #guide

- **Ctrl K** — command palette
- **Alt N** — new note
- **Alt 1-7** — switch view (notes, graph, canvas, den, focus, arcade, team)
- **Ctrl B** — toggle sidebar
- **Ctrl J** — toggle side panel
- **Ctrl E** — cycle write / split / read
- **Alt Z** — zen mode
- **Alt S** — toggle sound

Inside the editor, Tab indents, Enter continues lists, and Ctrl+B / Ctrl+I format text.

Return to [[Welcome to Nook]].
`,
  },
  {
    id: "n-ideas",
    title: "Ideas garden",
    age: 2,
    folder: "f-projects",
    content: `# Ideas garden

Seeds that might grow. #ideas

- A tiny weather station that sends daily haiku
- Mapping my reading to a constellation — see [[Reading list]]
- Turn the [[Pixel garden project]] into a shared board
- [[Someday maybe]] ideas live here until they are ready
- [ ] Sketch the garden layout
- [ ] Write the first real plan

Planting is easier when you can see the whole garden: open the [[Graph view]].
`,
  },
  {
    id: "n-garden",
    title: "Pixel garden project",
    age: 6,
    folder: "f-projects",
    content: `# Pixel garden project

A small game where plants grow while you focus. #project #games

## Goals
- Plants grow in real time while a timer runs
- Withered plants if you leave early
- Soft monochrome art with one accent colour

## Tasks
- [x] Pick a pixel grid size (16x16)
- [x] Moodboard on a canvas
- [x] Prototype growth stages
- [x] Sound design: soft clicks and rain
- [ ] Ship it to the team

Idea source: [[Ideas garden]]. Rituals that help: [[Focus rituals]].
`,
  },
  {
    id: "n-reading",
    title: "Reading list",
    age: 9,
    folder: "f-guides",
    content: `# Reading list

Books and essays queued up. #books #reading

- *The Pragmatic Programmer* — craft, tiny habits, tools
- *Designing Data-Intensive Applications* — systems that scale
- *A Pattern Language* — how places feel
- *Notes on Light and Pixels* — an essay about screens
- [x] *Piranesi*

I want to connect these ideas on a board with my [[Ideas garden]].
`,
  },
  {
    id: "n-focus",
    title: "Focus rituals",
    age: 4,
    folder: "f-guides",
    content: `# Focus rituals

What actually helps me concentrate. #focus #health

1. Water, window open, phone away
2. One 25 minute session on a single note
3. Short walk, then a second session
4. Review in the evening and update [[Weekly review]]

Mochi naps next to me during breaks. More about the pet: [[Meet Mochi]].
`,
  },
  {
    id: "n-weekly",
    title: "Weekly review",
    age: 16,
    folder: "f-journal",
    content: `# Weekly review

A short reflection every Sunday. #journal

## Wins
- Shipped the first prototype of the [[Pixel garden project]]
- Read two chapters
- Unlocked the *"Sharpshooter"* badge in the [[Arcade]]

## Next week
- [ ] Clean up the [[Ideas garden]]
- [ ] Try a 90 minute deep-work block
- [ ] List some old hats in the [[Marketplace]]

Mood: calm, a little tired.
`,
  },
  {
    id: "n-arcade",
    title: "Arcade",
    age: 1,
    folder: "f-games",
    content: `# Arcade

Twelve tiny pixel games that pay real coins. #games

- [[Catch]] — catch falling notes, dodge bugs
- Snake, Flappy, Breakout, Memory, Whack-a-Mole…
- Reaction, Simon, Starfall, 2048, Math Blitz, Brick fall

Every game: best score saved, coins = score ÷ 2, XP for every point. The pet reacts when you play!

High scores land in the Den stats. Bring a friend to the [[Team room]] and compare scores.
`,
  },
  {
    id: "n-team",
    title: "Team room",
    age: 1,
    folder: "f-guides",
    content: `# Team room

A live room for your team. #team

- See who is online right now
- Chat in the shared pixel chat
- Co-edit the shared board — everyone's strokes appear live
- Share your Arcade high scores

The room runs on a tiny socket service. Open Nook in two tabs to try it with yourself!
`,
  },
  {
    id: "n-market",
    title: "Marketplace",
    age: 1,
    folder: "f-guides",
    content: `# Marketplace

The team bazaar. #team #coins

- **Buy**: hats, pets, food and rare themes from other members
- **Sell**: anything from your closet — set your own price
- Every sale rings the coin bell and raises your *Trader* stat

Coins are the currency: write words, win games, finish focus sessions. Then treat yourself.
`,
  },
  {
    id: "n-someday",
    title: "Someday maybe",
    age: 30,
    folder: "f-journal",
    content: `# Someday maybe

- Learn to juggle (three balls, not deadlines)
- Build a tiny synthesizer
- Write a poem about a blob
`,
  },
];

const SEED_FOLDERS: { id: string; name: string; icon: string; color: string; position: number }[] = [
  { id: "f-guides", name: "Guides", icon: "book-open", color: "#9db7d0", position: 0 },
  { id: "f-projects", name: "Projects", icon: "shapes", color: "#bccb92", position: 1 },
  { id: "f-pets", name: "Pets", icon: "dog", color: "#cba5ba", position: 2 },
  { id: "f-games", name: "Games", icon: "gamepad", color: "#e0b589", position: 3 },
  { id: "f-journal", name: "Journal", icon: "notebook", color: "#b59fd0", position: 4 },
];

const SEED_CANVAS: CanvasData = {
  view: { x: 40, y: 20, z: 0.8 },
  nodes: [
    { id: "c1", type: "image", x: 40, y: 40, w: 360, h: 190, src: "/art/hero.webp" },
    { id: "c2", type: "note", x: 470, y: 30, w: 250, h: 150, noteId: "n-welcome" },
    { id: "c3", type: "note", x: 800, y: 20, w: 250, h: 150, noteId: "n-graph" },
    { id: "c4", type: "text", x: 470, y: 250, w: 230, h: 130, text: "Idea: connect every project to a goal.\nUse the dot on the card edge to link.", tone: 1 },
    { id: "c5", type: "note", x: 800, y: 250, w: 250, h: 150, noteId: "n-ideas" },
    { id: "c6", type: "image", x: 80, y: 310, w: 220, h: 120, src: "/art/plant.webp" },
    { id: "c7", type: "note", x: 1120, y: 140, w: 250, h: 150, noteId: "n-pet" },
  ],
  edges: [
    { id: "e1", from: "c2", to: "c3" },
    { id: "e2", from: "c2", to: "c4" },
    { id: "e3", from: "c3", to: "c5" },
    { id: "e4", from: "c5", to: "c7" },
    { id: "e5", from: "c1", to: "c2" },
  ],
};

const SEED_LISTINGS = [
  { id: "l-1", kind: "hat", itemId: "beanie", name: "Cozy beanie", blurb: "Warm ears, warmer heart. Gently used.", price: 9, seller: "Fern", payload: {} },
  { id: "l-2", kind: "hat", itemId: "wizard", name: "Wizard hat", blurb: "+10 to note magic. Slightly enchanted.", price: 24, seller: "Ozzy", payload: {} },
  { id: "l-3", kind: "hat", itemId: "shades", name: "Pixel shades", blurb: "Deal with it. No refunds on coolness.", price: 12, seller: "Vex", payload: {} },
  { id: "l-4", kind: "pet", itemId: "fox", name: "Fox kit", blurb: "Curious, quick, steals socks. Trained.", price: 60, seller: "Maple", payload: {} },
  { id: "l-5", kind: "pet", itemId: "dragon", name: "Baby dragon", blurb: "Hatched last week. Eats ideas.", price: 140, seller: "Ember", payload: {} },
  { id: "l-6", kind: "pet", itemId: "axolotl", name: "Axolotl", blurb: "Perma-smile. Aquatic. Regrows bad moods.", price: 90, seller: "Bloop", payload: {} },
  { id: "l-7", kind: "food", itemId: "cake", name: "Moon cake ×5", blurb: "Pure happiness, five slices.", price: 18, seller: "Baker Bot", payload: { food: "cake", qty: 5 } },
  { id: "l-8", kind: "food", itemId: "coffee", name: "Warm drink ×5", blurb: "Wakes everyone up. Bundle deal.", price: 14, seller: "Baker Bot", payload: { food: "coffee", qty: 5 } },
  { id: "l-9", kind: "theme", itemId: "sunset", name: "Sunset theme", blurb: "Golden hour, forever.", price: 30, seller: "Skye", payload: {} },
  { id: "l-10", kind: "hat", itemId: "crown", name: "Royal crown", blurb: "Archive royalty. Only worn once.", price: 46, seller: "Queen Bee", payload: {} },
];

const SEED_DECOR_LISTINGS = [
  { id: "l-11", kind: "decor", itemId: "decor-window", name: "Star window", blurb: "The den deserves a view. Pixels twinkle at night.", price: 20, seller: "Denkeeper", payload: {} },
  { id: "l-12", kind: "decor", itemId: "decor-boombox", name: "Boombox", blurb: "Lo-fi beats for the whole team.", price: 22, seller: "Denkeeper", payload: {} },
  { id: "l-13", kind: "decor", itemId: "decor-trophy", name: "Trophy shelf", blurb: "Flex those achievements.", price: 26, seller: "Denkeeper", payload: {} },
  { id: "l-14", kind: "decor", itemId: "decor-fern", name: "Pixel fern", blurb: "Photosynthesizes ideas. Water monthly.", price: 13, seller: "Fern", payload: {} },
];

const SEED_PREMIUM_THEMES = [
  { id: "l-15", kind: "theme", itemId: "aurora", name: "Aurora theme", blurb: "Rare. Northern lights over a pixel forest.", price: 60, seller: "Borealis", payload: { premium: true } },
  { id: "l-16", kind: "theme", itemId: "noir", name: "Noir theme", blurb: "Rare. Gold on midnight — for serious detectives.", price: 80, seller: "Detective Fox", payload: { premium: true } },
  { id: "l-17", kind: "theme", itemId: "seafoam", name: "Seafoam theme", blurb: "Rare. Tide-pool teal, sun-warmed paper.", price: 50, seller: "Tidekeeper", payload: { premium: true } },
];

async function bootstrap() {
  const noteCount = await db.note.count();
  const cc = await db.canvas.count();
  const pc = await db.pet.count();
  const fc = await db.folder.count();
  const lc = await db.listing.count();

  const now = Date.now();
  if (fc === 0) {
    for (const f of SEED_FOLDERS) {
      await db.folder.create({ data: { ...f } }).catch(() => {});
    }
  }
  if (noteCount === 0) {
    for (let i = 0; i < SEED_NOTES.length; i++) {
      const n = SEED_NOTES[i];
      await db.note
        .create({
          data: {
            id: n.id,
            title: n.title,
            content: n.content,
            cover: n.cover ?? null,
            pinned: !!n.pinned,
            folderId: n.folder ?? null,
            createdAt: new Date(now - (n.age + 2) * DAY),
            updatedAt: new Date(now - n.age * DAY - i * 60_000),
          },
        })
        .catch(() => {});
    }
  }
  if (cc === 0) {
    await db.canvas
      .create({ data: { id: "b-welcome", name: "Welcome board", data: JSON.stringify(SEED_CANVAS) } })
      .catch(() => {});
  }
  if (pc === 0) {
    await db.pet
      .create({
        data: {
          id: "pet-1",
          name: "Mochi",
          species: "cat",
          food: 85,
          energy: 92,
          joy: 78,
          xp: 0,
          coins: 120,
          hat: "none",
          owned: JSON.stringify(["none", "bow"]),
          stats: JSON.stringify({ words: 0, fed: 0, pats: 0, games: 0, focus: 0, best: 0, sold: 0, earned: 0 }),
        },
      })
      .catch(() => {});
  }
  if (lc === 0) {
    for (const l of SEED_LISTINGS) {
      await db.listing.create({ data: { ...l, payload: JSON.stringify(l.payload) } }).catch(() => {});
    }
  }
  // decor listings: seed for both fresh and existing archives
  const dc = await db.listing.count({ where: { kind: "decor" } });
  if (dc === 0) {
    for (const l of SEED_DECOR_LISTINGS) {
      await db.listing.create({ data: { ...l, payload: JSON.stringify(l.payload) } }).catch(() => {});
    }
  }
  // rare premium themes: seed for both fresh and existing archives
  const ptc = await db.listing.count({ where: { kind: "theme", itemId: { in: ["aurora", "noir", "seafoam"] } } });
  if (ptc === 0) {
    for (const l of SEED_PREMIUM_THEMES) {
      await db.listing.create({ data: { ...l, payload: JSON.stringify(l.payload) } }).catch(() => {});
    }
  }
}

export function ensureReady(): Promise<void> {
  if (!g.__nookReady) {
    g.__nookReady = bootstrap().catch((e) => {
      g.__nookReady = undefined;
      throw e;
    });
  }
  return g.__nookReady;
}
