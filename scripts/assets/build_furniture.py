"""Headless Blender step: normalize one source furniture mesh into a browser GLB.

  blender -b --factory-startup -noaudio --python scripts/assets/build_furniture.py -- \
      --input source.gltf --output public/assets/furniture/x.glb --meta x.json \
      [--triangles 30000] [--texture-size 1024] [--rotate-z 0] [--preview x.png]

Result contract (consumed by src/renderAssets.ts):
  * glTF +Y up, the piece's front faces +Z (Terrain yaw 0 faces south, +Z);
  * origin at the bottom center of the bounding box, units in meters;
  * all meshes joined (one node, one primitive per material), transforms applied;
  * every material is named after its finish slot (upholstery, wood, metal, stone,
    rug, glass or other; Blender may add a .001 suffix), so the app can swap in a
    library finish per slot;
  * TEXCOORD_1.u holds each face's box-projection axis (0 = x, 1 = y, 2 = z in glTF
    axes); the renderer rebuilds meter-scale UVs from it after fitting a piece;
  * triangles capped by a collapse decimation, textures capped at --texture-size;
  * Draco-compressed geometry and JPEG textures.
Blender's front view looks along +Y, so a front facing Blender -Y exports as +Z.
"""

import argparse
import json
import math
import os
import sys

import bpy
import mathutils
import numpy as np
from bpy_extras.mesh_utils import mesh_linked_uv_islands

UPHOLSTERY_MEAN = 0.35  # linear mean of the normalized grayscale upholstery albedo


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--meta", required=True)
    parser.add_argument("--triangles", type=int, default=30000)
    parser.add_argument("--texture-size", type=int, default=1024)
    parser.add_argument("--rotate-z", type=float, default=0.0)
    parser.add_argument("--preview")
    parser.add_argument("--upholstery", help="material recolored by the room palette at runtime")
    parser.add_argument("--split-saturated", action="store_true",
                        help="move faces whose texels are saturated (wood trim) to their own material")
    parser.add_argument("--upholstery-contrast", type=float, default=0.6)
    parser.add_argument("--slots", default="{}",
                        help="JSON map of source material name (or prefix) to finish slot")
    parser.add_argument("--split", action="append", default=[],
                        help="MATERIAL:SATURATED_SLOT:REST_SLOT island split of a shared atlas")
    parser.add_argument("--classify", action="append", default=[],
                        help='JSON {"material", "default", "rules": [{"slot", "hue"|"sat"|"val"|"top"|"bottom": [lo, hi]}]}: '
                             "assign each UV island of a shared atlas by its mean texel color and top height")
    parser.add_argument("--slot-preview", help="workbench render colored by finish slot")
    parser.add_argument("--thumbnail", help="Cycles studio thumbnail (PNG) for the catalog picker")
    parser.add_argument("--trim-slot", default="wood",
                        help="slot for faces moved off the upholstery by --split-saturated")
    return parser.parse_args(argv)


SLOTS = ("upholstery", "wood", "metal", "stone", "rug", "glass", "other")
# Ordered: the first keyword found in a lower-cased material name decides its slot.
SLOT_KEYWORDS = (
    ("glass", ("glass", "mirror")),
    ("metal", ("metal", "steel", "chrome", "brass", "iron", "alumin", "copper", "bronze",
               "handle", "screw", "nail", "bolt")),
    ("stone", ("marble", "stone", "concrete", "granite", "terrazzo", "ceramic", "porcelain")),
    ("upholstery", ("fabric", "cloth", "cushion", "pillow", "leather", "upholster", "seat",
                    "textile", "linen", "velvet", "mattress", "sheet", "blanket", "duvet")),
    ("rug", ("rug", "carpet")),
    ("wood", ("wood", "oak", "walnut", "pine", "plank", "timber", "leg", "frame", "veneer",
              "table", "cabinet", "drawer", "shelf", "body")),
)


def guess_slot(name):
    lower = name.lower()
    for slot, words in SLOT_KEYWORDS:
        if any(word in lower for word in words):
            return slot
    return "other"


def assign_slots(piece, mapping, upholstery_names):
    """Rename every material to its finish slot; returns {slot: [source names]}."""
    assigned = {}
    for slot_entry in piece.material_slots:
        material = slot_entry.material
        if not material:
            continue
        source = material.name
        if source in upholstery_names:
            slot = "upholstery"
        elif material.get("slot"):
            slot = material["slot"]
        else:
            slot = next((value for key, value in mapping.items()
                         if source == key or source.startswith(key)), None) or guess_slot(source)
        if slot not in SLOTS:
            raise SystemExit(f"Unknown slot {slot} for {source}")
        assigned.setdefault(slot, []).append(source)
        material.name = slot
    return assigned


def add_projection_axes(piece):
    """Second UV map: u = the glTF axis a face projects along (meters are rebuilt at runtime)."""
    mesh = piece.data
    layer = mesh.uv_layers.new(name="projection")
    if layer is None:
        raise SystemExit("Could not add a projection UV map (8 maps maximum)")
    # Blender x, y, z -> glTF x, -z, y.
    to_gltf = (0, 2, 1)
    for polygon in mesh.polygons:
        normal = polygon.normal
        axis = to_gltf[max(range(3), key=lambda i: abs(normal[i]))]
        for loop in polygon.loop_indices:
            layer.data[loop].uv = (axis, 0.0)
    # Keep the source UVs as TEXCOORD_0 for the model's own textures.
    mesh.uv_layers.active_index = 0
    for index, uv in enumerate(mesh.uv_layers):
        uv.active_render = index == 0


def import_source(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".gltf", ".glb"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    else:
        raise SystemExit(f"Unsupported source format: {ext}")


def triangle_count(obj):
    mesh = obj.data
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


def world_bounds(obj):
    points = [obj.matrix_world @ v.co for v in obj.data.vertices]
    low = mathutils.Vector([min(p[i] for p in points) for i in range(3)])
    high = mathutils.Vector([max(p[i] for p in points) for i in range(3)])
    return low, high


def main():
    args = parse_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    import_source(os.path.abspath(args.input))

    # Keep only meshes; bake every parent/child transform into the vertices.
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            bpy.data.objects.remove(obj, do_unlink=True)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    if not meshes:
        raise SystemExit("Source contains no meshes")
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    if len(meshes) > 1:
        bpy.ops.object.join()
    piece = bpy.context.view_layer.objects.active
    piece.name = os.path.splitext(os.path.basename(args.output))[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    # Importers use quaternion rotation modes; rotate the vertices directly.
    piece.data.transform(mathutils.Matrix.Rotation(math.radians(args.rotate_z), 4, "Z"))

    source_triangles = triangle_count(piece)
    if source_triangles > args.triangles:
        modifier = piece.modifiers.new("budget", "DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = args.triangles / source_triangles
        modifier.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=modifier.name)

    # Bottom-center origin.
    low, high = world_bounds(piece)
    offset = mathutils.Vector(((low.x + high.x) / 2, (low.y + high.y) / 2, low.z))
    piece.data.transform(mathutils.Matrix.Translation(-offset))
    piece.data.update()
    low, high = world_bounds(piece)

    # Texture budget: scale down in memory; the exporter re-encodes pixels.
    for image in bpy.data.images:
        width, height = image.size
        if max(width, height) > args.texture_size:
            factor = args.texture_size / max(width, height)
            image.scale(max(1, round(width * factor)), max(1, round(height * factor)))

    classified = [classify_material(piece, json.loads(rule)) for rule in args.classify]
    # Drop now-unused source materials so they do not export as empty slots.
    mesh = piece.data
    used = sorted({polygon.material_index for polygon in mesh.polygons})
    if len(used) < len(mesh.materials):
        kept = [mesh.materials[i] for i in used]
        remap = {old: new for new, old in enumerate(used)}
        indices = [remap[polygon.material_index] for polygon in mesh.polygons]
        mesh.materials.clear()
        for mat in kept:
            mesh.materials.append(mat)
        for polygon, index in zip(mesh.polygons, indices):
            polygon.material_index = index
    for rule in args.split:
        name, saturated_slot, rest_slot = rule.rsplit(":", 2)
        split_material(piece, name, saturated_slot, rest_slot)
    upholstery = prepare_upholstery(piece, args) if args.upholstery else None
    slots = assign_slots(piece, json.loads(args.slots), {"upholstery"} if upholstery else set())
    add_projection_axes(piece)

    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.abspath(args.output),
        export_format="GLB",
        use_selection=False,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_image_format="JPEG",
        export_image_quality=85,
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=14,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )

    size = high - low
    meta = {
        # glTF axes: width = x, height = y (Blender z), depth = z (Blender y).
        "size": [round(size.x, 4), round(size.z, 4), round(size.y, 4)],
        "triangles": triangle_count(piece),
        "sourceTriangles": source_triangles,
        "materials": [slot.material.name for slot in piece.material_slots if slot.material],
        "slots": sorted(slots),
        "slotSources": slots,
        "textureSize": max([max(image.size) for image in bpy.data.images] or [0]),
        "bytes": os.path.getsize(args.output),
        **({"upholstery": upholstery} if upholstery else {}),
        **({"classified": classified} if classified else {}),
    }
    with open(args.meta, "w") as handle:
        json.dump(meta, handle, indent=2)

    if args.preview:
        render_preview(piece, size, args.preview)
    if args.slot_preview:
        render_slot_preview(piece, size, args.slot_preview)
    if args.thumbnail:
        render_thumbnail(piece, size, args.thumbnail)


def base_color_image(material):
    for node in material.node_tree.nodes:
        if node.type == "BSDF_PRINCIPLED":
            links = node.inputs["Base Color"].links
            if links and links[0].from_node.type == "TEX_IMAGE":
                return links[0].from_node
    raise SystemExit(f"{material.name} has no base color image")


def image_rgb(image):
    """Display-encoded (sRGB) RGB floats, shape (height, width, 3)."""
    width, height = image.size
    pixels = np.empty(width * height * 4, dtype=np.float32)
    image.pixels.foreach_get(pixels)
    return pixels.reshape(height, width, 4)[:, :, :3]


def to_linear(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def saturated(rgb):
    high, low = rgb.max(axis=-1), rgb.min(axis=-1)
    return ((high - low) / np.maximum(high, 1e-4) > 0.5) & (high > 0.08)


def material_index(piece, name):
    index = next(
        (i for i, slot in enumerate(piece.material_slots)
         if slot.material and slot.material.name == name),
        None,
    )
    if index is None:
        raise SystemExit(f"No material {name}")
    return index


def split_saturated_islands(piece, slot_index, mask, trim_slot):
    """Move whole UV islands that mostly sample saturated texels (wood sharing a
    fabric or stone atlas) onto a copy of the material marked `trim_slot`."""
    material = piece.material_slots[slot_index].material
    height, width = mask.shape
    trim = material.copy()
    trim.name = f"{material.name}-trim"
    trim["slot"] = trim_slot
    piece.data.materials.append(trim)
    trim_index = len(piece.data.materials) - 1
    # Classify whole UV islands, so a leg or seam panel moves as one part.
    uv = piece.data.uv_layers.active.data
    mesh = piece.data
    moved = 0
    for island in mesh_linked_uv_islands(mesh):
        faces = [mesh.polygons[i] for i in island if mesh.polygons[i].material_index == slot_index]
        votes = total = 0
        for polygon in faces:
            points = [uv[loop].uv for loop in polygon.loop_indices]
            centroid = sum(points, mathutils.Vector((0, 0))) / len(points)
            for point in points + [centroid]:
                sample = (point + centroid) / 2
                x = min(width - 1, max(0, int((sample.x % 1.0) * width)))
                y = min(height - 1, max(0, int((sample.y % 1.0) * height)))
                votes += bool(mask[y, x])
                total += 1
        if total and votes * 2 > total:
            for polygon in faces:
                polygon.material_index = trim_index
                moved += 1
    return moved


def island_colors(piece, index, rgb):
    """Yield (faces, mean sRGB color) for each UV island using material `index`."""
    height, width = rgb.shape[:2]
    uv = piece.data.uv_layers.active.data
    mesh = piece.data
    for island in mesh_linked_uv_islands(mesh):
        faces = [mesh.polygons[i] for i in island if mesh.polygons[i].material_index == index]
        samples = []
        for polygon in faces:
            points = [uv[loop].uv for loop in polygon.loop_indices]
            centroid = sum(points, mathutils.Vector((0, 0))) / len(points)
            for point in points + [centroid]:
                sample = (point + centroid) / 2
                x = min(width - 1, max(0, int((sample.x % 1.0) * width)))
                y = min(height - 1, max(0, int((sample.y % 1.0) * height)))
                samples.append(rgb[y, x])
        if faces:
            heights = [(piece.matrix_world @ mesh.vertices[v].co).z for f in faces for v in f.vertices]
            yield faces, np.mean(samples, axis=0), max(heights), min(heights)


def classify_material(piece, rule_set):
    """--classify: move each UV island of one atlas material to a per-slot copy
    chosen by HSV rules on its mean color (first match wins, else `default`)."""
    index = material_index(piece, rule_set["material"])
    material = piece.material_slots[index].material
    rgb = image_rgb(base_color_image(material).image)
    copies = {}
    counts = {}
    import colorsys
    low, high = world_bounds(piece)
    span = max(high.z - low.z, 1e-6)
    for faces, color, top, bottom in list(island_colors(piece, index, rgb)):
        hue, sat, val = colorsys.rgb_to_hsv(*[float(c) for c in color[:3]])
        # `top`/`bottom`: the island's highest/lowest point as a fraction of the
        # piece height (legs sit low; a seat cushion sits in one height band).
        measured = {"hue": hue, "sat": sat, "val": val,
                    "top": (top - low.z) / span, "bottom": (bottom - low.z) / span}
        slot = next((rule["slot"] for rule in rule_set.get("rules", [])
                     if all(rule.get(key, [0, 1])[0] <= value <= rule.get(key, [0, 1])[1]
                            for key, value in measured.items())),
                    rule_set.get("default", "other"))
        if slot not in copies:
            copy = material.copy()
            copy.name = f"{material.name}-{slot}"
            copy["slot"] = slot
            piece.data.materials.append(copy)
            copies[slot] = len(piece.data.materials) - 1
        for polygon in faces:
            polygon.material_index = copies[slot]
        counts[slot] = counts.get(slot, 0) + len(faces)
    return counts


def split_material(piece, name, saturated_slot, rest_slot):
    """--split: separate a shared atlas into a saturated slot and the rest."""
    index = material_index(piece, name)
    material = piece.material_slots[index].material
    mask = saturated(image_rgb(base_color_image(material).image))
    moved = split_saturated_islands(piece, index, mask, saturated_slot)
    material["slot"] = rest_slot
    return moved


def prepare_upholstery(piece, args):
    """Turn one material into palette-tintable upholstery.

    The base color becomes grayscale detail normalized to UPHOLSTERY_MEAN, so the
    renderer can multiply it by palette fabric color / UPHOLSTERY_MEAN. With
    --split-saturated, faces sampling saturated texels (e.g. wooden legs sharing
    one atlas) first move to a copy of the original material and keep their color.
    """
    slot_index = material_index(piece, args.upholstery)
    material = piece.material_slots[slot_index].material
    node = base_color_image(material)
    source = node.image
    rgb = image_rgb(source)
    height, width = rgb.shape[:2]
    mask = saturated(rgb)
    trim_faces = split_saturated_islands(piece, slot_index, mask, args.trim_slot) \
        if args.split_saturated else 0
    linear = to_linear(rgb)
    luminance = linear @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    mean = float(luminance[~mask].mean()) if (~mask).any() else float(luminance.mean())
    detail = mean + (luminance - mean) * args.upholstery_contrast
    detail = np.clip(detail * (UPHOLSTERY_MEAN / max(mean, 1e-4)), 0, 1)
    encoded = to_srgb(detail)
    output = np.ones((height, width, 4), dtype=np.float32)
    output[:, :, 0] = output[:, :, 1] = output[:, :, 2] = encoded
    image = bpy.data.images.new(f"{source.name}-upholstery", width, height)
    image.pixels.foreach_set(output.ravel())
    image.pack()
    node.image = image
    material.name = "upholstery"
    return {"mean": UPHOLSTERY_MEAN, "sourceMean": round(mean, 5), "trimFaces": trim_faces}


SLOT_COLORS = {"upholstery": (0.85, 0.3, 0.3, 1), "wood": (0.55, 0.35, 0.15, 1),
               "metal": (0.3, 0.5, 0.9, 1), "stone": (0.9, 0.9, 0.85, 1),
               "rug": (0.9, 0.6, 0.1, 1), "glass": (0.4, 0.9, 0.9, 1), "other": (0.3, 0.8, 0.3, 1)}


def render_slot_preview(piece, size, path):
    """The preview camera with each material colored by its slot, to verify splits."""
    for slot in piece.material_slots:
        if slot.material:
            slot.material.diffuse_color = SLOT_COLORS.get(slot.material.name.split(".")[0], (1, 0, 1, 1))
    bpy.context.scene.display.shading.color_type = "MATERIAL"
    render_preview(piece, size, path, color_type="MATERIAL")


def place_camera(scene, size, lens=40, distance=1.9):
    camera = scene.camera
    if camera is None:
        camera = bpy.data.objects.new("preview", bpy.data.cameras.new("preview"))
        scene.collection.objects.link(camera)
        scene.camera = camera
    radius = max(size) * distance
    # Blender -Y is the front: place the camera in front, to the right and above.
    camera.location = (radius * 0.6, -radius * 0.9, size.z * 0.5 + radius * 0.45)
    target = mathutils.Vector((0, 0, size.z * 0.45))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = lens
    return camera


def render_thumbnail(piece, size, path):
    """A soft studio render on the editor's paper color, for the catalog picker."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = 48
    scene.cycles.use_denoising = True
    scene.render.resolution_x = scene.render.resolution_y = 256
    scene.render.film_transparent = False
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = scene.world or bpy.data.worlds.new("thumbnail")
    scene.world = world
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.62, 0.61, 0.57, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.55
    sun = bpy.data.objects.new("key", bpy.data.lights.new("key", "SUN"))
    sun.data.energy = 4.5
    sun.data.angle = math.radians(25)
    sun.rotation_euler = (math.radians(50), 0, math.radians(35))
    scene.collection.objects.link(sun)
    # A floor that catches the contact shadow, colored like the background.
    bpy.ops.mesh.primitive_plane_add(size=max(size) * 20)
    floor = bpy.context.active_object
    mat = bpy.data.materials.new("floor")
    mat.use_nodes = True
    mat.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.55, 0.54, 0.5, 1)
    floor.data.materials.append(mat)
    place_camera(scene, size, lens=50, distance=1.75)
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)


def render_preview(piece, size, path, color_type="TEXTURE"):
    """Workbench 3/4 front view from the south-east, so orientation can be checked."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = color_type
    scene.display.shading.show_shadows = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 480
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("preview") if not scene.world else scene.world
    place_camera(scene, size)
    scene.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)


main()
