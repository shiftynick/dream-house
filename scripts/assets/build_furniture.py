"""Headless Blender step: normalize one source furniture mesh into a browser GLB.

  blender -b --factory-startup -noaudio --python scripts/assets/build_furniture.py -- \
      --input source.gltf --output public/assets/furniture/x.glb --meta x.json \
      [--triangles 30000] [--texture-size 1024] [--rotate-z 0] [--preview x.png]

Result contract (consumed by src/furnitureModels.ts):
  * glTF +Y up, the piece's front faces +Z (Terrain yaw 0 faces south, +Z);
  * origin at the bottom center of the bounding box, units in meters;
  * all meshes joined (one node, one primitive per material), transforms applied;
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
    return parser.parse_args(argv)


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

    upholstery = prepare_upholstery(piece, args) if args.upholstery else None

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
        "textureSize": max([max(image.size) for image in bpy.data.images] or [0]),
        "bytes": os.path.getsize(args.output),
        **({"upholstery": upholstery} if upholstery else {}),
    }
    with open(args.meta, "w") as handle:
        json.dump(meta, handle, indent=2)

    if args.preview:
        render_preview(piece, size, args.preview)


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


def prepare_upholstery(piece, args):
    """Turn one material into palette-tintable upholstery.

    The base color becomes grayscale detail normalized to UPHOLSTERY_MEAN, so the
    renderer can multiply it by palette fabric color / UPHOLSTERY_MEAN. With
    --split-saturated, faces sampling saturated texels (e.g. wooden legs sharing
    one atlas) first move to a copy of the original material and keep their color.
    """
    slot_index = next(
        (i for i, slot in enumerate(piece.material_slots)
         if slot.material and slot.material.name == args.upholstery),
        None,
    )
    if slot_index is None:
        raise SystemExit(f"No material {args.upholstery}")
    material = piece.material_slots[slot_index].material
    node = base_color_image(material)
    source = node.image
    rgb = image_rgb(source)
    height, width = rgb.shape[:2]
    mask = saturated(rgb)
    trim_faces = 0
    if args.split_saturated:
        trim = material.copy()
        trim.name = f"{material.name}-trim"
        piece.data.materials.append(trim)
        trim_index = len(piece.data.materials) - 1
        # Classify whole UV islands, so a leg or seam panel moves as one part.
        uv = piece.data.uv_layers.active.data
        mesh = piece.data
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
                    trim_faces += 1
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


def render_preview(piece, size, path):
    """Workbench 3/4 front view from the south-east, so orientation can be checked."""
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.display.shading.show_shadows = True
    scene.render.resolution_x = 640
    scene.render.resolution_y = 480
    scene.render.film_transparent = False
    scene.world = bpy.data.worlds.new("preview") if not scene.world else scene.world
    camera_data = bpy.data.cameras.new("preview")
    camera = bpy.data.objects.new("preview", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    radius = max(size) * 1.9
    # Blender -Y is the front: place the camera in front, to the right and above.
    camera.location = (radius * 0.6, -radius * 0.9, size.z * 0.5 + radius * 0.45)
    target = mathutils.Vector((0, 0, size.z * 0.45))
    direction = target - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    camera_data.lens = 40
    scene.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)


main()
