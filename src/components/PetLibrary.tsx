"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import type { IconName } from "@/components/icons";
import { PetView } from "@/components/PetView";
import { SPECIES } from "@/lib/pet";
import { useStore } from "@/lib/store";
import { sfx } from "@/lib/sfx";
import type { PetBlueprint, PetLook, Species } from "@/lib/types";

/** colour ramps offered in the studio — 5 shades, dark → light */
const RAMPS: { id: string; name: string; ramp: string[] }[] = [
  { id: "caramel", name: "Caramel", ramp: ["#14100c", "#54402c", "#8a6c48", "#c0a074", "#f3e6d0"] },
  { id: "classic", name: "Classic", ramp: ["#17171a", "#43434c", "#7c7c8c", "#b6b6c4", "#f2f2f6"] },
  { id: "mint", name: "Mint", ramp: ["#0c1110", "#2e4a42", "#5f8577", "#9dc0ae", "#e8f5ec"] },
  { id: "sky", name: "Sky", ramp: ["#0c0e14", "#33394a", "#626c86", "#a2acc4", "#f0f4fa"] },
  { id: "rose", name: "Rose", ramp: ["#140c12", "#583a52", "#98708c", "#d0a8c4", "#fbeef8"] },
  { id: "sun", name: "Sunshine", ramp: ["#14100a", "#5c4a18", "#a08a28", "#d0bc48", "#f8f0d8"] },
  { id: "lava", name: "Lava", ramp: ["#160a08", "#5c2018", "#a04828", "#d08848", "#f8e8d8"] },
  { id: "violet", name: "Violet", ramp: ["#0e0c14", "#3c3a52", "#74729a", "#b2b0d4", "#f2f0fc"] },
];
const ACCENTS = ["#9db7d0", "#e8853c", "#86c46a", "#f088b0", "#e8a844", "#a8a0e8", "#e05878", "#8fd6c0"];
const ALL_SPECIES: Species[] = ["cat", "bunny", "blob", "dog", "fox", "panda", "frog", "penguin", "ghost", "dragon", "axolotl", "owl"];

const ORIGIN_CHIP: Record<string, { label: string; color: string }> = {
  builtin: { label: "built-in", color: "var(--faint)" },
  custom: { label: "custom", color: "var(--accent)" },
  imported: { label: "imported", color: "#d8a050" },
};

function downloadPack(pets: PetBlueprint[], folders: { id: string; name: string; position: number }[], filename: string) {
  const usedIds = new Set(pets.map((b) => b.folderId));
  const folderName = new Map(folders.map((f) => [f.id, f.name]));
  const pack = {
    format: "nook-pets" as const,
    version: 1 as const,
    exportedAt: new Date().toISOString(),
    folders: folders.filter((f) => usedIds.has(f.id)),
    pets: pets.map((b) => ({ name: b.name, species: b.species, folderName: b.folderId ? folderName.get(b.folderId) : undefined, look: b.look, origin: b.origin })),
  };
  const blob = new Blob([JSON.stringify(pack, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

function PetCard({ bp, onEdit }: { bp: PetBlueprint; onEdit: () => void }) {
  const st = useStore.getState;
  const active = useStore((s) => s.pet.name === bp.name && s.pet.species === bp.species);
  const [sure, setSure] = useState(false);
  const chip = ORIGIN_CHIP[bp.origin] ?? ORIGIN_CHIP.custom;
  return (
    <div className="group relative flex flex-col items-center gap-1.5 rounded-2xl border border-line bg-panel2/40 p-3 transition-transform hover:-translate-y-0.5" data-active={active}>
      {active && <span className="tiny-font absolute left-2 top-2 rounded-md bg-accent px-1 py-px text-[9px] text-accent-ink">ACTIVE</span>}
      <span className="tiny-font absolute right-2 top-2" style={{ color: chip.color }}>{chip.label}</span>
      <div className="grid h-[74px] place-items-end overflow-hidden">
        <PetView species={bp.species} tint={bp.look} scale={1.85} fps={9} mood="happy" style={{ marginBottom: -4 }} />
      </div>
      <div className="pixel-font max-w-full truncate text-[13px]">{bp.name}</div>
      <div className="text-[10.5px] text-faint">{SPECIES[bp.species]?.label ?? bp.species}</div>
      {bp.look.blurb && <div className="line-clamp-2 min-h-[24px] text-center text-[10.5px] leading-tight text-faint">{bp.look.blurb}</div>}
      <div className="flex w-full flex-wrap justify-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button className="btn btn-sm btn-accent !px-2 !text-[11px]" onClick={() => st().useBlueprint(bp.id)} title="Make this your companion">
          <Icon name="check" size={11} /> Use
        </button>
        <button className="icon-btn !h-7 !w-7" title="Edit" onClick={onEdit}><Icon name="pencil" size={12} /></button>
        <button className="icon-btn !h-7 !w-7" title="Duplicate" onClick={() => void st().duplicateBlueprint(bp)}><Icon name="copy" size={12} /></button>
        <button
          className="icon-btn !h-7 !w-7"
          title="Export this pet (JSON)"
          onClick={() => downloadPack([bp], st().petFolders.filter((f) => f.id === bp.folderId), `nook-pet-${bp.name.replace(/\s+/g, "-").toLowerCase()}.json`)}
        >
          <Icon name="download" size={12} />
        </button>
        <button
          className="icon-btn !h-7 !w-7"
          style={sure ? { background: "#a5594f", color: "#fff" } : undefined}
          title={sure ? "Click again to delete" : "Delete"}
          onClick={() => {
            if (sure) void st().removeBlueprint(bp.id);
            else { setSure(true); setTimeout(() => setSure(false), 2200); }
          }}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
    </div>
  );
}

/** the pet library — folders like /pet/dog, pet cards, studio, import/export */
export function PetLibrary() {
  const petFolders = useStore((s) => s.petFolders);
  const petBlueprints = useStore((s) => s.petBlueprints);
  const registryLoaded = useStore((s) => s.registryLoaded);
  const petStudio = useStore((s) => s.petStudio);
  const [folder, setFolder] = useState<string | null>(null); // null = all
  const [folderQ, setFolderQ] = useState("");
  const [newFolder, setNewFolder] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!registryLoaded) void useStore.getState().loadRegistry();
  }, [registryLoaded]);

  const shown = useMemo(() => petBlueprints.filter((b) => !folder || b.folderId === folder), [petBlueprints, folder]);
  const folderName = petFolders.find((f) => f.id === folder)?.name;
  const path = `/pet/${folderName ?? "all"}`;

  return (
    <div
      className="scroll min-h-0 flex-1 overflow-y-auto p-3"
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) void useStore.getState().importPetPack(f);
      }}
    >
      {/* header row: path + actions */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="library" size={14} className="text-accent" />
        <span className="pixel-font text-[12.5px]" title="Library path — folders group your pets">{path}</span>
        <span className="chip !py-0 !text-[10px]">{shown.length} pet{shown.length === 1 ? "" : "s"}</span>
        <span className="flex-1" />
        <button className="btn btn-accent btn-sm" onClick={() => useStore.setState({ petStudio: "new" })}>
          <Icon name="plus" size={12} /> New pet
        </button>
        <button className="btn btn-sm" onClick={() => fileRef.current?.click()} title="Import a nook-pets JSON pack">
          <Icon name="upload" size={12} /> Import
        </button>
        <button className="btn btn-sm" onClick={() => useStore.getState().exportPetPack()} title="Export every pet as JSON">
          <Icon name="download" size={12} /> Export
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void useStore.getState().importPetPack(f); e.target.value = ""; }}
        />
      </div>

      {/* folder rail */}
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        <button className="chip" data-on={folder === null} onClick={() => setFolder(null)}>
          <Icon name="library" size={11} /> All
        </button>
        {petFolders.map((f) => (
          <span key={f.id} className="group/f relative inline-flex">
            <button
              className="chip"
              data-on={folder === f.id}
              onClick={() => setFolder(f.id)}
              onDoubleClick={() => {
                const name = prompt("Rename folder", f.name);
                if (name?.trim()) void useStore.getState().renamePetFolder(f.id, name.trim());
              }}
              title={`${path.replace("all", f.name)} — double-click to rename`}
            >
              <Icon name="folder" size={11} className="text-accent" /> {f.name}
              <span className="ml-0.5 text-[9px] opacity-60">{petBlueprints.filter((b) => b.folderId === f.id).length}</span>
            </button>
            {folder === f.id && (
              <button
                className="absolute -right-1.5 -top-1.5 grid h-3.5 w-3.5 place-items-center rounded-full border border-line bg-panel text-[8px] text-dim hover:text-ink"
                title="Delete folder (must be empty)"
                onClick={() => void useStore.getState().deletePetFolder(f.id)}
              >
                ×
              </button>
            )}
          </span>
        ))}
        {newFolder ? (
          <input
            autoFocus
            className="input !w-28 !py-0.5 !text-[11px]"
            placeholder="folder name…"
            value={folderQ}
            onChange={(e) => setFolderQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && folderQ.trim()) { void useStore.getState().newPetFolder(folderQ.trim()); setFolderQ(""); setNewFolder(false); }
              if (e.key === "Escape") setNewFolder(false);
            }}
            onBlur={() => setNewFolder(false)}
          />
        ) : (
          <button className="icon-btn !h-6 !w-6" title="New folder" onClick={() => { setNewFolder(true); sfx("pop"); }}>
            <Icon name="folder-plus" size={12} />
          </button>
        )}
      </div>

      {/* grid */}
      {!registryLoaded ? (
        <div className="pixel-font py-8 text-center text-[13px] text-faint">opening the library…</div>
      ) : shown.length === 0 ? (
        <div className="grid place-items-center gap-2 py-10 text-center">
          <Icon name="dog" size={26} className="text-faint" />
          <div className="pixel-font text-[13px] text-dim">{folder ? `No pets in /pet/${folderName}` : "The library is empty"}</div>
          <div className="max-w-[300px] text-[11.5px] text-faint">
            Create a new pet in the studio, or drop a <span className="pixel-font">nook-pets.json</span> pack anywhere here to import a whole collection.
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
          {shown.map((bp) => (
            <PetCard key={bp.id} bp={bp} onEdit={() => useStore.setState({ petStudio: bp.id })} />
          ))}
        </div>
      )}

      {dragOver && (
        <div className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-2xl border-2 border-dashed border-accent bg-panel/80">
          <div className="pixel-font text-[13px] text-accent">drop a nook-pets pack to import</div>
        </div>
      )}

      {petStudio && <PetStudio id={petStudio} onClose={() => useStore.setState({ petStudio: null })} />}
    </div>
  );
}

/** the pet studio — create / edit a pet design (shape + colours + personality) */
export function PetStudio({ id, onClose }: { id: string | "new"; onClose: () => void }) {
  const editing = useStore((s) => (id === "new" ? null : s.petBlueprints.find((b) => b.id === id) ?? null));
  const petFolders = useStore((s) => s.petFolders);
  const [name, setName] = useState(editing?.name ?? "");
  const [species, setSpecies] = useState<Species>(editing?.species ?? "cat");
  const [ramp, setRamp] = useState<string[]>(editing?.look.ramp ?? RAMPS[0].ramp);
  const [accent, setAccent] = useState(editing?.look.accent ?? ACCENTS[0]);
  const [blurb, setBlurb] = useState(editing?.look.blurb ?? "");
  const [says, setSays] = useState((editing?.look.says ?? []).join("\n"));
  const [folderId, setFolderId] = useState<string | null>(editing?.folderId ?? null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const look: PetLook & { blurb?: string; says?: string[] } = { ramp, accent, blurb: blurb.trim() || undefined, says: says.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 8) };

  const save = async () => {
    if (saving) return;
    setSaving(true);
    const savedId = await useStore.getState().saveBlueprint({
      id: editing?.id, name: name.trim() || "New pet", species, look, folderId, origin: editing?.origin ?? "custom",
    });
    setSaving(false);
    if (savedId) {
      sfx("achieve");
      useStore.getState().toast(`${name.trim() || "New pet"} saved to the library`, "sparkles");
      useStore.getState().unlock("pet-smith", "Pet Smith", "Created a custom pet in the studio", "sparkles");
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-black/40 p-4" onPointerDown={onClose}>
      <div
        className="panel panel-solid flex max-h-[90vh] w-full max-w-[720px] flex-col overflow-hidden rounded-[20px]"
        style={{ animation: "pop .22s var(--ease-soft) both", backdropFilter: "none" }}
        onPointerDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Pet studio"
      >
        <header className="flex flex-none items-center gap-2 border-b border-line px-4 py-3">
          <Icon name="sparkles" size={15} className="text-accent" />
          <span className="label !text-[11px]">{editing ? `Edit ${editing.name}` : "Pet studio — design a new pet"}</span>
          <span className="flex-1" />
          <button className="icon-btn !h-6 !w-6 !rounded-md" onClick={onClose} aria-label="Close"><Icon name="close" size={13} /></button>
        </header>

        <div className="grid min-h-0 flex-1 gap-0 overflow-y-auto md:grid-cols-[220px_1fr]">
          {/* live preview */}
          <div className="flex flex-col items-center justify-center gap-2 border-b border-line p-4 md:border-b-0 md:border-r">
            <div className="grid h-[150px] w-full place-items-end justify-center overflow-hidden rounded-2xl border border-line bg-panel2/50">
              <PetView species={species} tint={{ ramp, accent }} scale={3.4} fps={10} mood="happy" style={{ marginBottom: -6 }} />
            </div>
            <div className="pixel-font text-[14px]">{name.trim() || "Unnamed pet"}</div>
            <div className="flex gap-1">
              {ramp.map((c) => <i key={c} className="h-3.5 w-3.5 rounded-[3px]" style={{ background: c }} />)}
              <i className="h-3.5 w-3.5 rounded-full" style={{ background: accent }} title="accent" />
            </div>
            <div className="text-center text-[11px] leading-tight text-faint">{blurb.trim() || SPECIES[species]?.blurb}</div>
          </div>

          {/* form */}
          <div className="space-y-3.5 p-4">
            <div>
              <span className="label !text-[10px]">Name</span>
              <input className="input mt-1 w-full" placeholder="e.g. Biscuit, Nova, Mochi…" value={name} maxLength={24} onChange={(e) => setName(e.target.value)} />
            </div>

            <div>
              <span className="label !text-[10px]">Shape — pick a species body</span>
              <div className="mt-1 grid grid-cols-6 gap-1.5">
                {ALL_SPECIES.map((sp) => (
                  <button
                    key={sp}
                    className="grid place-items-end justify-center overflow-hidden rounded-xl border p-1 transition-transform hover:-translate-y-0.5"
                    data-on={species === sp}
                    onClick={() => { setSpecies(sp); sfx("pop"); }}
                    title={SPECIES[sp]?.label}
                  >
                    <PetView species={sp} tint={{ ramp, accent }} scale={0.78} fps={6} style={{ marginBottom: -2 }} />
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="label !text-[10px]">Colour ramp</span>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {RAMPS.map((r) => (
                  <button
                    key={r.id}
                    className="flex overflow-hidden rounded-lg border transition-transform hover:-translate-y-0.5"
                    data-on={ramp.join() === r.ramp.join()}
                    onClick={() => { setRamp(r.ramp); sfx("pop"); }}
                    title={r.name}
                  >
                    {r.ramp.map((c) => <i key={c} className="h-6 w-4" style={{ background: c }} />)}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <span className="label !text-[10px]">Accent colour</span>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                {ACCENTS.map((c) => (
                  <button
                    key={c}
                    className="h-6 w-6 rounded-full border-2 transition-transform hover:scale-110"
                    style={{ background: c, borderColor: accent === c ? "var(--ink)" : "transparent" }}
                    onClick={() => { setAccent(c); sfx("pop"); }}
                    aria-label={`Accent ${c}`}
                  />
                ))}
                <input type="color" value={accent} onChange={(e) => setAccent(e.target.value)} className="h-7 w-9 cursor-pointer rounded-md border border-line bg-transparent p-0.5" title="Custom accent" />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <span className="label !text-[10px]">Personality — things it says (one per line)</span>
                <textarea
                  className="input mt-1 min-h-[64px] w-full resize-y !text-[12px]"
                  placeholder={"Woof! Let's write!\nI guard your notes."}
                  value={says}
                  onChange={(e) => setSays(e.target.value)}
                />
              </div>
              <div>
                <span className="label !text-[10px]">Blurb</span>
                <textarea className="input mt-1 min-h-[64px] w-full resize-y !text-[12px]" placeholder="A short description…" value={blurb} maxLength={120} onChange={(e) => setBlurb(e.target.value)} />
                <span className="label mt-2 block !text-[10px]">Folder</span>
                <select className="input mt-1 w-full !text-[12px]" value={folderId ?? ""} onChange={(e) => setFolderId(e.target.value || null)}>
                  <option value="">— no folder —</option>
                  {petFolders.map((f) => <option key={f.id} value={f.id}>/pet/{f.name}</option>)}
                </select>
              </div>
            </div>
          </div>
        </div>

        <footer className="flex flex-none items-center gap-2 border-t border-line px-4 py-3">
          <span className="text-[11px] text-faint">Saved designs live in the library — Use any card to make it your companion.</span>
          <span className="flex-1" />
          <button className="btn btn-sm" onClick={onClose}>Cancel</button>
          <button className="btn btn-accent btn-sm" disabled={saving} onClick={() => void save()}>
            <Icon name="save" size={13} /> {saving ? "Saving…" : editing ? "Save changes" : "Create pet"}
          </button>
        </footer>
      </div>
    </div>
  );
}
