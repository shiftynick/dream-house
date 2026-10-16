"""Headless Blender step: build the window and door kit GLBs.

  blender -b --factory-startup -noaudio --python scripts/assets/build_openings.py -- \
      --output-dir public/assets/openings --meta assets-src/previews/openings.json \
      [--preview-dir assets-src/previews]

Every model is authored in meters around one native opening (`opening` in the
meta file), in wall-local glTF axes: x along the wall, +y up from the opening
bottom, +z toward the room interior, the wall's 0.1 m thickness centered on z = 0.
`edges` [left, right, bottom, top] are the bands, measured inward from each
opening edge, that keep their true size; src/renderOpenings.ts scales only the
interior between them (glass, panels) and translates everything outside them.
Objects whose material is `hardware` stay rigid as a whole (handles, hinges).

Materials are named by role and replaced at runtime by the room palette:
frame, glass, sill, flashing, surround, casing, leaf, hardware. TEXCOORD_1.u holds each
face's projection axis (0/1/2 = x/y/z), +3 when grain should run across the
default direction because the part is long horizontally.
"""

import argparse
import json
import math
import os
import sys

import bmesh
import bpy
import mathutils

COLORS = {
    "frame": (0.08, 0.09, 0.08, 1),
    "glass": (0.8, 0.9, 0.9, 0.2),
    "sill": (0.45, 0.32, 0.2, 1),
    "flashing": (0.1, 0.1, 0.1, 1),
    "casing": (0.5, 0.38, 0.25, 1),
    "leaf": (0.55, 0.42, 0.28, 1),
    "hardware": (0.6, 0.6, 0.6, 1),
    "surround": (0.5, 0.38, 0.25, 1),
}
WALL = 0.1  # single wall thickness; interior face at +0.05 (glTF z)


def parse_args():
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--meta", required=True)
    parser.add_argument("--preview-dir")
    return parser.parse_args(argv)


def material(name):
    existing = bpy.data.materials.get(name)
    if existing:
        return existing
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    mat.diffuse_color = COLORS[name]  # workbench previews
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = COLORS[name]
    if name == "glass":
        bsdf.inputs["Alpha"].default_value = 0.2
    if name == "hardware":
        bsdf.inputs["Metallic"].default_value = 1.0
    return mat


def g2b(x, y, z):
    """glTF (x, y up, z interior) -> Blender (x, -z, y)."""
    return mathutils.Vector((x, -z, y))


class Kit:
    def __init__(self, name):
        self.name = name
        self.objects = []

    def box(self, role, lo, hi, bevel=0.0015, label=None):
        """Axis-aligned box from glTF corner `lo` to `hi`, lightly bevelled."""
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1.0)
        size = [hi[i] - lo[i] for i in range(3)]
        center = [(hi[i] + lo[i]) / 2 for i in range(3)]
        for v in bm.verts:
            v.co = g2b(center[0] + v.co.x * size[0], center[1] + v.co.z * size[1],
                       center[2] - v.co.y * size[2])
        if bevel > 0 and min(size) > bevel * 2.5:
            bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, segments=1,
                            affect="EDGES", profile=0.5)
        return self._object(bm, role, label, size)

    def cylinder(self, role, center, radius, depth, axis="z", label=None):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=16, radius1=radius,
                              radius2=radius, depth=depth)
        rotation = {"z": mathutils.Matrix.Rotation(math.pi / 2, 4, "X"),
                    "y": mathutils.Matrix.Identity(4),
                    "x": mathutils.Matrix.Rotation(math.pi / 2, 4, "Y")}[axis]
        bmesh.ops.transform(bm, matrix=rotation, verts=bm.verts)
        bmesh.ops.translate(bm, vec=g2b(*center), verts=bm.verts)
        size = [radius * 2] * 3
        size[{"x": 0, "y": 1, "z": 2}[axis]] = depth
        return self._object(bm, role, label, size)

    def _object(self, bm, role, label, size):
        mesh = bpy.data.meshes.new(label or role)
        bm.to_mesh(mesh)
        bm.free()
        obj = bpy.data.objects.new(label or role, mesh)
        obj.data.materials.append(material(role))
        obj["grain_x"] = size[0] > size[1] * 1.5  # long horizontal member
        obj["grain_depth"] = size[2] > max(size[0], size[1])
        bpy.context.scene.collection.objects.link(obj)
        self.objects.append(obj)
        return obj

    def lever(self, x, y, face, label):
        """A lever handle on a round rose; `face` +1 interior, -1 exterior."""
        self.cylinder("hardware", (x, y, face * (0.02 + 0.005)), 0.026, 0.01, label=f"{label}-rose")
        self.cylinder("hardware", (x, y, face * 0.04), 0.009, 0.03, label=f"{label}-neck")
        toward = -1 if x > 0 else 1  # lever points toward the leaf center
        self.box("hardware", (x + min(0, toward * 0.13), y - 0.009, face * 0.05 - 0.009),
                 (x + max(0, toward * 0.13), y + 0.009, face * 0.05 + 0.009), bevel=0.004,
                 label=f"{label}-lever")


def ring(kit, role, x0, x1, y0, y1, width, z0, z1, bevel=0.0015, sides=(True, True, True, True)):
    """Four members of a rectangular frame within [x0, x1] x [y0, y1]."""
    left, right, bottom, top = sides
    if left:
        kit.box(role, (x0, y0, z0), (x0 + width, y1, z1), bevel)
    if right:
        kit.box(role, (x1 - width, y0, z0), (x1, y1, z1), bevel)
    if bottom:
        kit.box(role, (x0 + width * left, y0, z0), (x1 - width * right, y0 + width, z1), bevel)
    if top:
        kit.box(role, (x0 + width * left, y1 - width, z0), (x1 - width * right, y1, z1), bevel)


def casement():
    """One casement bay: frame, opening sash, double glazing, bead and an
    interior lever, set back toward the room so the outside reads a reveal.
    Per-opening parts (placed once, fitted to the whole opening): a timber
    stool inside, a projecting sloped sill and trim boards outside (role
    `surround`). Native opening 1.2 x 1.4 m."""
    w, h = 1.2, 1.4
    kit = Kit("window-casement")
    back = 0.022  # setback from the wall center toward the interior
    ring(kit, "frame", -w / 2, w / 2, 0, h, 0.06, -0.035 + back, 0.028 + back)
    ring(kit, "frame", -w / 2 + 0.06, w / 2 - 0.06, 0.06, h - 0.06, 0.055, -0.012 + back, 0.026 + back)
    ring(kit, "frame", -w / 2 + 0.115, w / 2 - 0.115, 0.115, h - 0.115, 0.014, 0.008 + back, 0.024 + back, 0.001)
    kit.box("glass", (-w / 2 + 0.1, 0.1, -0.006 + back), (w / 2 - 0.1, h - 0.1, 0.008 + back), bevel=0)
    kit.box("sill", (-w / 2 - 0.05, -0.025, back - 0.02), (w / 2 + 0.05, 0.0, WALL / 2 + 0.035), 0.004)
    # Exterior: sill projecting 60 mm past the trim with a sloped top and drip edge.
    board, proud = 0.11, 0.024
    sill = kit.box("flashing", (-w / 2 - board - 0.03, -0.055, -WALL / 2 - proud - 0.06),
                   (w / 2 + board + 0.03, 0.0, back - 0.035), 0.004)
    for v in sill.data.vertices:
        if v.co.z > -0.001 and v.co.y > WALL / 2:
            v.co.z -= 0.014
    for sign in (-1, 1):
        x0, x1 = sorted((sign * w / 2, sign * (w / 2 + board)))
        kit.box("surround", (x0, -0.002, -WALL / 2 - proud), (x1, h + board, -WALL / 2), 0.003)
    # Head board with a small drip cap.
    kit.box("surround", (-w / 2, h, -WALL / 2 - proud), (w / 2, h + board, -WALL / 2), 0.003)
    kit.box("flashing", (-w / 2 - board - 0.01, h + board, -WALL / 2 - proud - 0.018),
            (w / 2 + board + 0.01, h + board + 0.012, -WALL / 2), 0.002)
    kit.lever(w / 2 - 0.09, h * 0.5, 1, "handle")
    return kit, {"opening": [w, h], "edges": [0.12, 0.12, 0.12, 0.12]}


def fixed():
    """A fixed glazing bay for glass walls and upper rows. Native 1.6 x 2.4 m."""
    w, h = 1.6, 2.4
    kit = Kit("window-fixed")
    ring(kit, "frame", -w / 2, w / 2, 0, h, 0.05, -0.045, 0.045)
    ring(kit, "frame", -w / 2 + 0.05, w / 2 - 0.05, 0.05, h - 0.05, 0.016, 0.014, 0.034, 0.001)
    ring(kit, "frame", -w / 2 + 0.05, w / 2 - 0.05, 0.05, h - 0.05, 0.016, -0.034, -0.014, 0.001)
    kit.box("glass", (-w / 2 + 0.04, 0.04, -0.012), (w / 2 - 0.04, h - 0.04, 0.012), bevel=0)
    return kit, {"opening": [w, h], "edges": [0.07, 0.07, 0.07, 0.07]}


def door_frame():
    """Jamb linings, stops and casings on both faces. Native opening 0.9 x 2.1 m."""
    w, h = 0.9, 2.1
    kit = Kit("door-frame")
    t, c, ct = 0.022, 0.07, 0.016  # lining thickness, casing width and depth
    for sign in (-1, 1):
        x = sign * (w / 2 + t / 2)
        # Linings sit just inside the wall faces, never coplanar with them.
        kit.box("casing", (x - t / 2, 0, -WALL / 2 + 0.002), (x + t / 2, h + t, WALL / 2 - 0.002), 0.001)
        # Stop bead on the lining, against which the leaf closes.
        kit.box("casing", (sign * w / 2 - (0.012 if sign > 0 else 0), 0, -0.035),
                (sign * w / 2 + (0.012 if sign < 0 else 0), h, -0.005), 0.001)
        for face in (-1, 1):
            z0, z1 = sorted((face * WALL / 2, face * (WALL / 2 + ct)))
            x0 = sign * (w / 2 + t)
            kit.box("casing", (min(x0, x0 + sign * c), 0, z0), (max(x0, x0 + sign * c), h + t + c, z1), 0.003)
    kit.box("casing", (-w / 2 - t, h, -WALL / 2 + 0.002), (w / 2 + t, h + t, WALL / 2 - 0.002), 0.001)
    # Oak threshold across the wall depth, nosed slightly past both faces.
    kit.box("sill", (-w / 2 - t, 0, -WALL / 2 - 0.012), (w / 2 + t, 0.006, WALL / 2 + 0.012), 0.002)
    kit.box("casing", (-w / 2, h - 0.012, -0.035), (w / 2, h, -0.005), 0.001)
    for face in (-1, 1):
        z0, z1 = sorted((face * WALL / 2, face * (WALL / 2 + ct)))
        kit.box("casing", (-w / 2 - t, h + t, z0), (w / 2 + t, h + t + c, z1), 0.003)
    return kit, {"opening": [w, h], "edges": [0.05, 0.05, 0.05, 0.05]}


def leaf(glazed):
    """A door leaf, hinge on -x, origin at its bottom center, 0.04 m thick.
    Panelled (interior) or full-lite glazed (exterior). Native 0.9 x 2.08 m."""
    w, h, d = 0.9, 2.08, 0.04
    kit = Kit("door-leaf-glazed" if glazed else "door-leaf-panel")
    role = "frame" if glazed else "leaf"
    stile, top, bottom = 0.11, 0.11, 0.22 if glazed else 0.2
    kit.box(role, (-w / 2, 0, -d / 2), (-w / 2 + stile, h, d / 2), 0.002)
    kit.box(role, (w / 2 - stile, 0, -d / 2), (w / 2, h, d / 2), 0.002)
    kit.box(role, (-w / 2 + stile, h - top, -d / 2), (w / 2 - stile, h, d / 2), 0.002)
    kit.box(role, (-w / 2 + stile, 0, -d / 2), (w / 2 - stile, bottom, d / 2), 0.002)
    if glazed:
        kit.box("glass", (-w / 2 + stile - 0.01, bottom - 0.01, -0.006),
                (w / 2 - stile + 0.01, h - top + 0.01, 0.006), bevel=0)
        for face in (-1, 1):  # glazing beads
            z0, z1 = sorted((face * 0.006, face * 0.016))
            ring(kit, "frame", -w / 2 + stile, w / 2 - stile, bottom, h - top, 0.014, z0, z1, 0.001)
    else:
        rail = (0.98, 1.14)  # lock rail, inside the rigid lower band
        kit.box(role, (-w / 2 + stile, rail[0], -d / 2), (w / 2 - stile, rail[1], d / 2), 0.002)
        for y0, y1 in ((bottom, rail[0]), (rail[1], h - top)):
            # Recessed panels with a raised field, slightly thinner than the leaf.
            kit.box(role, (-w / 2 + stile, y0, -d / 2 + 0.01), (w / 2 - stile, y1, d / 2 - 0.01), 0.002)
            kit.box(role, (-w / 2 + stile + 0.03, y0 + 0.03, -d / 2 + 0.006),
                    (w / 2 - stile - 0.03, y1 - 0.03, d / 2 - 0.006), 0.006)
    for face in (-1, 1):
        kit.lever(w / 2 - 0.065, 1.0, face, f"handle-{'in' if face > 0 else 'out'}")
    for y in (0.25, 1.05, 1.85):
        kit.cylinder("hardware", (-w / 2 - 0.004, y, 0), 0.008, 0.1, axis="y", label=f"hinge-{y}")
    return kit, {"opening": [w, h], "edges": [0.13, 0.13, 1.2, 0.13], "hinge": "left", "thickness": d}


def add_projection_axes(obj):
    mesh = obj.data
    if not mesh.uv_layers:
        mesh.uv_layers.new(name="UVMap")  # TEXCOORD_0 placeholder; meters are rebuilt at runtime
    layer = mesh.uv_layers.new(name="projection")
    to_gltf = (0, 2, 1)
    for polygon in mesh.polygons:
        normal = polygon.normal
        axis = to_gltf[max(range(3), key=lambda i: abs(normal[i]))]
        # Grain normally runs up vertical faces and along x on horizontal ones;
        # long horizontal members (rails, heads, sills) turn it to run along x.
        swap = obj["grain_x"] and axis in (0, 2)
        for loop in polygon.loop_indices:
            layer.data[loop].uv = (axis + (3 if swap else 0), 0.0)
    mesh.uv_layers.active_index = 0
    for index, uv in enumerate(mesh.uv_layers):
        uv.active_render = index == 0


def export(kit, path):
    bpy.ops.object.select_all(action="DESELECT")
    for obj in kit.objects:
        add_projection_axes(obj)
        obj.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_texcoords=True,
        export_normals=True,
        export_materials="EXPORT",
        export_draco_mesh_compression_enable=True,
        export_draco_mesh_compression_level=6,
        export_draco_position_quantization=16,
        export_draco_normal_quantization=10,
        export_draco_texcoord_quantization=12,
        export_animations=False,
    )
    triangles = 0
    for obj in kit.objects:
        obj.data.calc_loop_triangles()
        triangles += len(obj.data.loop_triangles)
    return triangles


def render_preview(kit, path, size):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.render.resolution_x, scene.render.resolution_y = 480, 480
    camera = bpy.data.objects.new("preview", bpy.data.cameras.new("preview"))
    scene.collection.objects.link(camera)
    scene.camera = camera
    radius = max(size) * 1.6
    camera.location = (radius * 0.45, radius * 0.9, size[1] * 0.5 + radius * 0.2)
    target = mathutils.Vector((0, 0, size[1] * 0.5))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()
    scene.render.filepath = os.path.abspath(path)
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(camera, do_unlink=True)


def main():
    args = parse_args()
    os.makedirs(args.output_dir, exist_ok=True)
    meta = {}
    for build in (casement, fixed, door_frame, lambda: leaf(False), lambda: leaf(True)):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        kit, info = build()
        path = os.path.join(os.path.abspath(args.output_dir), f"{kit.name}.glb")
        info["triangles"] = export(kit, path)
        info["bytes"] = os.path.getsize(path)
        meta[kit.name] = info
        if args.preview_dir:
            render_preview(kit, os.path.join(args.preview_dir, f"{kit.name}.png"), info["opening"])
    with open(args.meta, "w") as handle:
        json.dump(meta, handle, indent=2)


main()
