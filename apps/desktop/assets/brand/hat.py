# Static Mr. Streamer hat, adapted from the desktop launch film's existing model.
# Geometry follows assets/brand/mark.svg. See docs/contributing/store-artwork.md.
# blender -b -P apps/desktop/assets/brand/hat.py -- --out hat.png
import argparse
import math
import sys

import bmesh
import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
parser = argparse.ArgumentParser()
parser.add_argument("--out", required=True)
parser.add_argument("--samples", type=int, default=96)
parser.add_argument("--size", type=int, default=3072)
parser.add_argument("--view", default="three-quarter", choices=["front", "three-quarter"])
parser.add_argument("--background", default="transparent", choices=["black", "transparent"])
args = parser.parse_args(argv)

DEPTH = 0.86  # top hats are oval: depth over width


def z_of(y: float) -> float:
    return (86.6 - y) / 10


def bezier(p0, p1, p2, p3, steps):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append(
            tuple(u**3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t**3 * d for a, b, c, d in zip(p0, p1, p2, p3))
        )
    return out


def quad(p0, p1, p2, steps):
    out = []
    for i in range(steps + 1):
        t = i / steps
        u = 1 - t
        out.append(tuple(u * u * a + 2 * u * t * b + t * t * c for a, b, c in zip(p0, p1, p2)))
    return out


def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, roughness, coat=0.0, sheen=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    bsdf = m.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Coat Weight"].default_value = coat
    bsdf.inputs["Coat Roughness"].default_value = 0.25
    bsdf.inputs["Sheen Weight"].default_value = sheen
    # A touch of subsurface softens the white into porcelain rather than plastic.
    bsdf.inputs["Subsurface Weight"].default_value = 0.04 if color[0] > 0.5 else 0.0
    bsdf.inputs["Subsurface Radius"].default_value = (0.4, 0.3, 0.25)
    return m


def revolve(name, profile, segments=256, close_top=False):
    """A surface of revolution from (radius, z) points, scaled to an oval in depth."""
    mesh = bpy.data.meshes.new(name)
    bm = bmesh.new()
    rings = []
    for r, z in profile:
        ring = []
        for i in range(segments):
            a = 2 * math.pi * i / segments
            ring.append(bm.verts.new((r * math.sin(a), -r * DEPTH * math.cos(a), z)))
        rings.append(ring)
    for upper, lower in zip(rings, rings[1:]):
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((upper[i], upper[j], lower[j], lower[i]))
    if close_top:
        bm.faces.new(list(reversed(rings[0])))
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    for poly in mesh.polygons:
        poly.use_smooth = True
    return obj


def crown_profile():
    # Mark: M31.5 73 C31 55 29.5 35 28.2 16.5 Q27.9 11 33.5 11 L50 11, shifted down by 3.
    side = bezier((31.5, 76), (31, 58), (29.5, 38), (28.2, 19.5), 140)
    top = quad((28.2, 19.5), (27.9, 14), (33.5, 14), 12)[1:]
    flat = [(33.5 + (50 - 33.5) * i / 8, 14) for i in range(1, 9)]
    points = list(reversed(side + top + flat))  # from the centre of the top, out and down
    points += [(31.6, 81), (31.7, 86)]  # on below the mark's crown, hidden inside the brim
    return [((50 - x) / 10, z_of(y)) for x, y in points]


def build_crown(white):
    profile = crown_profile()
    crown = revolve("crown", profile[1:], close_top=False)
    # Close the top with a fan to the centre point.
    bm = bmesh.new()
    bm.from_mesh(crown.data)
    centre = bm.verts.new((0, 0, profile[0][1]))
    bm.verts.ensure_lookup_table()
    segments = 256
    first = [v for v in bm.verts[:segments]]
    for i in range(segments):
        bm.faces.new((centre, first[(i + 1) % segments], first[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    bm.to_mesh(crown.data)
    bm.free()
    solid = crown.modifiers.new("shell", "SOLIDIFY")
    solid.thickness = 0.12
    solid.offset = -1
    crown.data.materials.append(white)
    return crown


def build_band(black):
    # Mark's stripe: M20 57.5 Q50 59.5 80 57.5 L80 64.5 Q50 66.5 20 64.5Z, shifted down by 3.
    # A ribbon just proud of the crown between those heights, its front edge dipping by 2 units.
    side = bezier((31.5, 76), (31, 58), (29.5, 38), (28.2, 19.5), 200)
    def radius_at(y):
        return (50 - min(side, key=lambda p: abs(p[1] - y))[0]) / 10 + 0.035
    profile = [(radius_at(y), z_of(y)) for y in [60.5 + i * 7 / 12 for i in range(13)]]
    band = revolve("band", profile)
    # The mark's band curves down toward the front: bend it by depth.
    for v in band.data.vertices:
        front = max(0.0, -v.co.y / (radius_at(64) * DEPTH))
        v.co.z -= 0.2 * front**2
    band.data.materials.append(black)
    return band


def build_brim(white):
    # Front silhouette: the sides curl up to y 70 (after shift 73) and the middle sits at 75.3 to 86.6.
    outer_x, outer_y = 4.0, 2.5
    inner_x, inner_y = 1.82, 1.82 * DEPTH
    rings, segments = 24, 160
    mesh = bpy.data.meshes.new("brim")
    bm = bmesh.new()
    grid = []
    for k in range(rings + 1):
        f = k / rings
        rx = inner_x + (outer_x - inner_x) * f
        ry = inner_y + (outer_y - inner_y) * f
        ring = []
        for i in range(segments):
            a = 2 * math.pi * i / segments
            x, y = rx * math.sin(a), -ry * math.cos(a)
            side = abs(math.sin(a))
            # Curl: the sides rise toward the rim; front and back dip a little.
            z = z_of(84.0) + 0.95 * (f**2.2) * side**3 - 0.12 * f * (1 - side) ** 2
            ring.append(bm.verts.new((x, y, z)))
        grid.append(ring)
    for upper, lower in zip(grid, grid[1:]):
        for i in range(segments):
            j = (i + 1) % segments
            bm.faces.new((upper[i], upper[j], lower[j], lower[i]))
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    brim = bpy.data.objects.new("brim", mesh)
    bpy.context.collection.objects.link(brim)
    for poly in mesh.polygons:
        poly.use_smooth = True
    solid = brim.modifiers.new("thickness", "SOLIDIFY")
    solid.thickness = 0.16
    solid.offset = 0
    bevel = brim.modifiers.new("edge", "BEVEL")
    bevel.width = 0.06
    bevel.segments = 4
    brim.data.materials.append(white)
    return brim


def cut_play(crown):
    # Mark: polygon 43.5,25 43.5,47 62,36 with a 4.5-wide round stroke, shifted down by 3.
    pts = [(43.5, 28), (43.5, 50), (62, 39)]
    mesh = bpy.data.meshes.new("play")
    bm = bmesh.new()
    front = [bm.verts.new(((x - 50) / 10, -4, z_of(y))) for x, y in pts]
    back = [bm.verts.new(((x - 50) / 10, -0.5, z_of(y))) for x, y in pts]
    bm.faces.new(front)
    bm.faces.new(list(reversed(back)))
    for i in range(3):
        j = (i + 1) % 3
        bm.faces.new((front[i], back[i], back[j], front[j]))
    bm.normal_update()
    bm.to_mesh(mesh)
    bm.free()
    play = bpy.data.objects.new("play", mesh)
    bpy.context.collection.objects.link(play)
    # The round stroke: grow the triangle by half the stroke and round its corners.
    bevel = play.modifiers.new("round", "BEVEL")
    bevel.affect = "VERTICES"
    bevel.width = 0.225
    bevel.segments = 8
    cut = crown.modifiers.new("play", "BOOLEAN")
    cut.operation = "DIFFERENCE"
    cut.object = play
    cut.solver = "EXACT"
    play.hide_render = True
    play.hide_viewport = True
    # Keep the crown smooth without blending its normals across the flat cut walls.
    bpy.context.view_layer.update()
    evaluated = crown.evaluated_get(bpy.context.evaluated_depsgraph_get())
    mesh = bpy.data.meshes.new_from_object(evaluated)
    crown.modifiers.clear()
    crown.data = mesh
    mesh.set_sharp_from_angle(angle=math.radians(30))
    return play


def light(name, kind, location, energy, size, color=(1, 1, 1)):
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = color
    if kind == "AREA":
        data.shape = "DISK"
        data.size = size
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = location
    direction = Vector((0, 0, 3.2)) - Vector(location)
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    return obj


def scene_setup():
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = args.samples
    scene.cycles.use_denoising = True
    scene.render.resolution_x = args.size
    scene.render.resolution_y = args.size
    scene.render.film_transparent = args.background == "transparent"
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    world = bpy.data.worlds.new("world")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0, 0, 0, 1)
    scene.world = world
    return scene


def camera(scene):
    data = bpy.data.cameras.new("camera")
    data.lens = 70
    cam = bpy.data.objects.new("camera", data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    # Slightly above, as the mark's brim shows its top surface; three-quarter turns 25° to the left.
    yaw = math.radians(25 if args.view == "three-quarter" else 0)
    distance, height = 26.0, 6.2
    target = Vector((0, 0, 3.3))
    cam.location = Vector((distance * math.sin(yaw), -distance * math.cos(yaw), height))
    cam.rotation_euler = (target - cam.location).to_track_quat("-Z", "Y").to_euler()
    return cam


reset()
scene = scene_setup()
white = material("white satin", (0.9, 0.9, 0.89), 0.3, coat=0.35, sheen=0.25)
black = material("black satin", (0.008, 0.008, 0.009), 0.32, coat=0.4)
crown = build_crown(white)
band = build_band(black)
brim = build_brim(white)
cut_play(crown)
light("key", "AREA", (-9, -7, 13), 2200, 6)
light("fill", "AREA", (10, -9, 3), 120, 12, (0.9, 0.94, 1))
light("rim", "AREA", (7, 8, 10), 2600, 4)
light("rim left", "AREA", (-8, 7, 6), 1400, 4)
camera(scene)
scene.render.filepath = args.out
bpy.ops.render.render(write_still=True)
