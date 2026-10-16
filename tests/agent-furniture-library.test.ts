import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { SYSTEM_PROMPT } from '../server/agent.ts';
import { finishSlots, furnitureLibrary, furnitureLibraryPrompt } from '../shared/finishes.ts';
import { furnitureKindSchema } from '../shared/model.ts';

type Manifest = {
  furniture: {
    id: string;
    kinds: string[];
    slots: string[];
    default?: boolean;
    stretch?: unknown;
    finishes?: Record<string, string>;
    size: [number, number, number];
  }[];
  materials: { id: string; category: string; albedo: string }[];
};
const manifest = JSON.parse(readFileSync('public/assets/manifest.json', 'utf8')) as Manifest;
const section = furnitureLibraryPrompt();
const lines = section.split('\n');
/** `- kind: id (…), id (…)` → the IDs, in order. */
const listedIds = (line: string) =>
  [...line.replace(/^- [\w-]+: /, '').matchAll(/(?:^|, )([\w-]+) \(/g)].map((match) => match[1]);
const modelLine = (kind: string) => lines.find((line) => line.startsWith(`- ${kind}: `))!;
const entry = (line: string, id: string) => line.match(new RegExp(`(?:^|, |: )${id} \\(([^)]*)\\)`))![1];

test('the design agent prompt carries the generated furniture library', () => {
  assert.ok(SYSTEM_PROMPT.includes(section));
});

test('prompt model IDs match the asset manifest for every furniture kind', () => {
  for (const kind of furnitureKindSchema.options) {
    const line = modelLine(kind);
    assert.ok(line, kind);
    const expected = manifest.furniture.filter((model) => model.kinds.includes(kind));
    assert.deepEqual(listedIds(line), [...expected.map((model) => model.id), 'builtin'], kind);
    for (const model of expected) {
      const traits = entry(line, model.id);
      assert.equal(traits.includes('DEFAULT'), Boolean(model.default), `${model.id} default`);
      if (model.stretch) assert.ok(traits.includes('fits any size'), model.id);
      else {
        // Manifest size is [width, height, depth]; the prompt lists WxDxH.
        const [width, height, depth] = model.size.map((value) => Math.round(value * 100) / 100);
        assert.ok(traits.includes(`native ${width}x${depth}x${height}`), model.id);
      }
      // Slots in the prompt are exactly the manifest's finish slots, in display order.
      const slots = finishSlots.filter((slot) => model.slots.includes(slot));
      assert.ok(traits.includes(`slots ${slots.join('/') || 'none'}`), `${model.id} slots`);
      const defaults = Object.entries(model.finishes ?? {}).map(([slot, id]) => `default ${slot} ${id}`);
      assert.deepEqual(
        traits.split('; ').filter((trait) => trait.startsWith('default ')),
        defaults,
        `${model.id} default finishes`,
      );
    }
    const builtin = entry(line, 'builtin');
    assert.equal(builtin.includes('DEFAULT'), !expected.some((model) => model.default), kind);
  }
});

test('prompt finish IDs match the asset manifest materials by slot', () => {
  const categories: Record<string, string[]> = {
    upholstery: ['fabric', 'leather'],
    wood: ['wood'],
    metal: ['metal'],
    stone: ['stone'],
    rug: ['fabric'],
  };
  const listed = new Set<string>();
  for (const [slot, allowed] of Object.entries(categories)) {
    const line = lines.find((item) => item.startsWith(`- ${slot}: `) && !item.includes('('));
    assert.ok(line, slot);
    const entries = line.replace(`- ${slot}: `, '').split(', ');
    const ids = entries.map((entry) => entry.replace(/\*$/, ''));
    ids.forEach((id) => listed.add(id));
    const expected = manifest.materials.filter((item) => allowed.includes(item.category));
    assert.deepEqual(ids, expected.map((item) => item.id), slot);
    // `*` marks the palette-tinted (grayscale "luminance") finishes.
    assert.deepEqual(
      entries.map((entry) => entry.endsWith('*')),
      expected.map((item) => item.albedo === 'luminance'),
      `${slot} tinted`,
    );
  }
  assert.deepEqual([...listed].sort(), manifest.materials.map((item) => item.id).sort());
});

test('every model default finish names a library finish that fits its slot', () => {
  for (const { kind, models } of furnitureLibrary().kinds)
    for (const model of models)
      for (const [slot, id] of Object.entries(model.finishes)) {
        assert.ok(model.slots.includes(slot as never), `${kind} ${model.id} has no ${slot} slot`);
        const finish = furnitureLibrary().finishes.find((item) => item.slot === slot);
        assert.ok(finish?.ids.includes(id!), `${model.id} ${slot} ${id}`);
      }
});
