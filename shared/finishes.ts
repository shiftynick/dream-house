import catalog from './asset-catalog.json';
import {
  finishSlotSchema,
  type FinishSlot,
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

/** Piece finish, then the room default, for one slot; undefined keeps the model's own. */
export function resolveFinish(
  item: Pick<Furniture, 'finishes'>,
  room: Pick<Room, 'furnitureFinishes'> | undefined,
  slot: FinishSlot,
) {
  const id = item.finishes?.[slot] ?? room?.furnitureFinishes?.[slot];
  return id && finishFits(slot, id) ? id : undefined;
}

/** Native [width, depth, height] of a model in centimeter-rounded meters. */
export function modelDimensions(model: CatalogModel) {
  const [width, height, depth] = model.size;
  return { width, depth, height };
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
