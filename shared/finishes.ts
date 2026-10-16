import catalog from './asset-catalog.json';
import {
  finishSlotSchema,
  furnitureKindSchema,
  type FinishSlot,
  type Finishes,
  type Furniture,
  type FurnitureKind,
  type Room,
} from './model.ts';

/** The bundled, generated list of swappable finishes and catalog models
 * (scripts/assets/build-assets.ts). Binary assets load from public/assets. */
export type FinishCategory = 'fabric' | 'leather' | 'wood' | 'metal' | 'stone';
export type CatalogMaterial = {
  id: string;
  name: string;
  category: FinishCategory;
  /** sRGB hex of the photographed mean, for swatches. */
  swatch: string;
  /** Grayscale detail tinted by the palette fabric or rug color. */
  tinted: boolean;
  attribution: string;
};
export type CatalogModel = {
  id: string;
  name?: string;
  kinds: FurnitureKind[];
  slots: string[];
  size: [number, number, number];
  thumbnail?: string;
  style?: string;
  default?: boolean;
  /** Has stretch zones, so it fits any saved length without distortion. */
  stretches?: boolean;
  /** Library finish per slot used when neither the piece nor its room sets one. */
  finishes?: Finishes;
  attribution: string;
};
export const assetCatalog = catalog as { materials: CatalogMaterial[]; models: CatalogModel[] };

export const finishSlots = finishSlotSchema.options;
export const finishSlotLabels: Record<FinishSlot, string> = {
  upholstery: 'Upholstery',
  wood: 'Wood',
  metal: 'Metal',
  stone: 'Stone',
  rug: 'Rug',
};
const slotCategories: Record<FinishSlot, FinishCategory[]> = {
  upholstery: ['fabric', 'leather'],
  wood: ['wood'],
  metal: ['metal'],
  stone: ['stone'],
  rug: ['fabric'],
};

export function finishOptions(slot: FinishSlot) {
  return assetCatalog.materials.filter((item) => slotCategories[slot].includes(item.category));
}
export function catalogMaterial(id: string | undefined) {
  return id ? assetCatalog.materials.find((item) => item.id === id) : undefined;
}
export function finishFits(slot: FinishSlot, id: string) {
  return finishOptions(slot).some((item) => item.id === id);
}

export function catalogModel(id: string | undefined) {
  return id ? assetCatalog.models.find((item) => item.id === id) : undefined;
}
export function modelsForKind(kind: FurnitureKind) {
  return assetCatalog.models.filter((item) => item.kinds.includes(kind));
}
/** `model: 'builtin'` keeps the procedural piece even where a kind has a default model. */
export const BUILTIN_MODEL = 'builtin';
/** The model a piece renders with: its chosen catalog model when that model
 * fits its kind, otherwise the kind's default model, if any; undefined means
 * the built-in procedural piece. */
export function pieceModel(item: Pick<Furniture, 'kind' | 'model'>) {
  if (item.model === BUILTIN_MODEL) return undefined;
  const chosen = catalogModel(item.model);
  return chosen?.kinds.includes(item.kind)
    ? chosen
    : modelsForKind(item.kind).find((model) => model.default);
}

/** Material keys of the procedural fallback geometry (src/renderFurniture.tsx). */
const proceduralMaterialSlots: Record<string, FinishSlot> = {
  fabric: 'upholstery',
  seam: 'upholstery',
  wood: 'wood',
  chrome: 'metal',
  worktop: 'stone',
  rug: 'rug',
  rugEdge: 'rug',
};
export function proceduralSlot(material: string): FinishSlot | undefined {
  return proceduralMaterialSlots[material];
}
const proceduralKindSlots: Record<FurnitureKind, FinishSlot[]> = {
  sofa: ['upholstery', 'wood'],
  armchair: ['upholstery', 'wood'],
  chair: ['upholstery', 'wood'],
  bed: ['upholstery', 'wood'],
  'coffee-table': ['wood'],
  'dining-table': ['wood'],
  nightstand: ['wood', 'metal'],
  wardrobe: ['wood', 'metal'],
  counter: ['wood', 'metal', 'stone'],
  island: ['wood', 'metal', 'stone'],
  vanity: ['wood', 'metal', 'stone'],
  bath: ['metal'],
  toilet: ['metal'],
  rug: ['rug'],
  plant: [],
};
/** A glTF material named `wood` or `wood.001` belongs to the wood slot. */
export function modelMaterialSlot(name: string): FinishSlot | undefined {
  const slot = name.split('.')[0];
  return (finishSlots as readonly string[]).includes(slot) ? (slot as FinishSlot) : undefined;
}

/** Slots a piece exposes for swapping, in display order. */
export function pieceSlots(item: Pick<Furniture, 'kind' | 'model'>): FinishSlot[] {
  const model = pieceModel(item);
  if (!model) return proceduralKindSlots[item.kind];
  return finishSlots.filter((slot) => model.slots.includes(slot));
}

/** Piece finish, then the room default, then the model's default finish, for
 * one slot; undefined keeps the model's own material. */
export function resolveFinish(
  item: Pick<Furniture, 'finishes'>,
  room: Pick<Room, 'furnitureFinishes'> | undefined,
  slot: FinishSlot,
  model?: Pick<CatalogModel, 'finishes'>,
) {
  const id = item.finishes?.[slot] ?? room?.furnitureFinishes?.[slot] ?? model?.finishes?.[slot];
  return id && finishFits(slot, id) ? id : undefined;
}

/** Smallest footprint a saved piece may have (furnitureSchema). */
const MINIMUM_FOOTPRINT = 0.2;
/** Native width, depth and height of a model in meters. A model smaller than
 * the minimum footprint (the aloe) is scaled up uniformly to fit it. */
export function modelDimensions(model: CatalogModel) {
  const [width, height, depth] = model.size;
  const scale = Math.max(1, MINIMUM_FOOTPRINT / width, MINIMUM_FOOTPRINT / depth);
  return { width: width * scale, depth: depth * scale, height: height * scale };
}

/** The update for choosing a model: models with stretch zones keep the saved
 * size; others adopt their native proportions instead of being distorted. */
export function chooseModelPatch(item: Pick<Furniture, 'kind'>, id: string): Partial<Furniture> {
  const model = catalogModel(id);
  if (!model || !model.kinds.includes(item.kind) || model.stretches) return { model: id };
  const round = (value: number) => Math.round(value * 100) / 100;
  const { width, depth, height } = modelDimensions(model);
  return { model: id, width: round(width), depth: round(depth), height: round(height) };
}

/** The library as the design agent sees it: model IDs by furniture kind and
 * finish IDs by slot, generated from the bundled catalog so it cannot drift
 * from public/assets/manifest.json. */
export function furnitureLibrary() {
  const kinds = furnitureKindSchema.options.map((kind) => ({
    kind,
    models: modelsForKind(kind).map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      style: model.style,
      default: Boolean(model.default),
      stretches: Boolean(model.stretches),
      slots: finishSlots.filter((slot) => model.slots.includes(slot)),
      finishes: model.finishes ?? {},
      size: modelDimensions(model),
    })),
    builtinSlots: proceduralKindSlots[kind],
  }));
  const finishes = finishSlots.map((slot) => ({
    slot,
    ids: finishOptions(slot).map((item) => item.id),
    tinted: finishOptions(slot)
      .filter((item) => item.tinted)
      .map((item) => item.id),
  }));
  return { kinds, finishes };
}

const size = (value: number) => Math.round(value * 100) / 100;
/** System-prompt section listing every catalog model and finish ID. */
export function furnitureLibraryPrompt() {
  const { kinds, finishes } = furnitureLibrary();
  const models = kinds.map(({ kind, models, builtinSlots }) => {
    const listed = models.map((model) => {
      const traits = [
        model.style,
        model.default ? 'DEFAULT' : '',
        model.stretches
          ? 'fits any size'
          : `native ${size(model.size.width)}x${size(model.size.depth)}x${size(model.size.height)}`,
        `slots ${model.slots.join('/') || 'none'}`,
        ...Object.entries(model.finishes).map(([slot, id]) => `default ${slot} ${id}`),
      ].filter(Boolean);
      return `${model.id} (${model.name}; ${traits.join('; ')})`;
    });
    const builtin = `builtin (parametric${models.some((model) => model.default) ? '' : '; DEFAULT'}; slots ${builtinSlots.join('/') || 'none'})`;
    return `- ${kind}: ${[...listed, builtin].join(', ')}`;
  });
  return [
    'FURNITURE MODELS AND FINISHES',
    "A piece renders a catalog model or the built-in parametric piece. Set `model` in add_furniture/update_furniture to an ID listed for that piece's kind, or 'builtin' for the parametric piece. A new piece without `model` uses the kind's DEFAULT; an update without it keeps the current model, so name the DEFAULT's ID to switch back. Models that fit any size keep the saved width/depth/height. For other models also set width/depth/height (meters, WxDxH) to the native size listed, so they are not distorted. Choose models and finishes that suit the requested style; do not change them unprompted.",
    "Finishes: `finishes` {slot: id} on a piece, or update_room furnitureFinishes for every piece in a room (a piece's own finish wins). Both replace the whole map, so include the slots you keep. Only the slots its model lists take effect, and an ID must belong to that slot. Without one, a model's listed default finish applies, else its own material. Fabrics marked * take the palette colour.",
    'Models by kind (WxDxH in meters):',
    ...models,
    'Finish IDs by slot:',
    ...finishes.map(
      ({ slot, ids, tinted }) =>
        `- ${slot}: ${ids.map((id) => (tinted.includes(id) ? `${id}*` : id)).join(', ')}`,
    ),
  ].join('\n');
}
