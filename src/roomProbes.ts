import * as THREE from 'three';
import type { Room, Scene, Side } from '../shared/model';
import { roomOpenings } from '../shared/openings';
import { roofHeightAt, roofMaximumHeight } from '../shared/architecture';
import { roomSlabs, wallAxis } from './renderGeometry';
import {
  daylightSkyPixels,
  EXTERIOR_ENVIRONMENT_INTENSITY,
  roomExposure,
  skyModel,
} from './renderLighting';

/** Runtime-only interior lighting; nothing is baked or stored with a design.
 * See docs/lighting.md.
 *
 * - Window light: the sky through each room's real exterior openings
 *   (Lambert's polygon formula, sky above the surface's height and ground
 *   below), evaluated on the GPU into a per-room 0.5 m irradiance volume
 *   stored as an ambient cube. This gives the falloff away from windows.
 * - Bounce light: a small cube capture of the actual scene (sky masked, so
 *   window light is not counted twice) at each room's probe, projected to SH9
 *   and iterated. Openings into neighbouring rooms are portals that carry the
 *   neighbour's captured light into the volume near the opening.
 * - Reflections: a cube capture per room, prefiltered by Three's PMREM and
 *   box-projected onto the room volume.
 * - Exposure: each room's measured probe luminance sets its exposure; a dim
 *   room seen from a brighter one keeps part of its own (local exposure).
 * Captures run in the browser after an edit, a light change or asset loading. */

type Light = 'day' | 'golden' | 'evening';
const sides: Side[] = ['north', 'south', 'east', 'west'];
export const enclosedRoom = (room: Room) => !['terrace', 'courtyard'].includes(room.kind);
export const MAX_ROOM_APERTURES = 16;
export const ROOM_REFLECTION_SIZE = 128;
export const MAX_ROOM_NEIGHBOURS = 12;
const BOUNCE_SIZE = 32;
const BOUNCE_PASSES = 3;
/** Share of a neighbouring room's own exposure kept when seen from another room. */
const LOCAL_EXPOSURE = 0.7;

export type Aperture = {
  /** Bottom corner; with `along` and `height` it spans the opening. */
  corner: THREE.Vector3;
  along: THREE.Vector3;
  height: number;
  /** Share of the opening that looks outdoors, or into `neighbour`. */
  weight: number;
  /** Set for a portal into another enclosed room, lit by that room's probe. */
  neighbour?: string;
  /** Unit direction from this room through the opening. */
  outward: THREE.Vector3;
};

/** Form-factor vector of a vertical rectangle seen from `point`:
 * Σ θ·γ / 2π over its edges, so its dot product with a unit normal is the
 * (signed) form factor (Lambert's polygon formula). */
export function rectangleVector(
  point: THREE.Vector3,
  corner: THREE.Vector3,
  along: THREE.Vector3,
  height: number,
) {
  const up = new THREE.Vector3(0, height, 0);
  const vertices = [
    corner.clone(),
    corner.clone().add(along),
    corner.clone().add(along).add(up),
    corner.clone().add(up),
  ].map((vertex) => vertex.sub(point).normalize());
  const sum = new THREE.Vector3(),
    cross = new THREE.Vector3();
  for (let i = 0; i < 4; i++) {
    const a = vertices[i],
      b = vertices[(i + 1) % 4];
    cross.crossVectors(a, b);
    const length = cross.length();
    if (length > 1e-7)
      sum.addScaledVector(cross, Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1)) / length);
  }
  return sum.multiplyScalar(1 / (2 * Math.PI));
}

/** Signed form factor of a vertical rectangle for a surface at `point`. */
export function rectangleIntegral(
  point: THREE.Vector3,
  normal: THREE.Vector3,
  corner: THREE.Vector3,
  along: THREE.Vector3,
  height: number,
) {
  return rectangleVector(point, corner, along, height).dot(normal);
}

/** A room's openings as vertical rectangles, wound so their integral is
 * positive for surfaces facing them from inside: windows and doors to the
 * outdoors, and portals into neighbouring enclosed rooms. */
export function roomApertures(house: Scene, room: Room): Aperture[] {
  const result: (Aperture & { area: number })[] = [];
  for (const side of sides) {
    const axis = wallAxis(room, side);
    const openings = roomOpenings(house, room.id, side);
    const cuts =
      (room[side] === 'glass' || room[side] === 'open') && !openings.length
        ? [{ offset: 0, sill: 0, width: axis.length, height: room.height }]
        : openings.length
          ? openings
          : room[side] === 'door'
            ? [
                {
                  offset: 0,
                  sill: 0,
                  width: Math.min(1.3, axis.length),
                  height: Math.min(2.4, room.height),
                },
              ]
            : [];
    const sign = side === 'north' || side === 'west' ? -1 : 1;
    const outward = new THREE.Vector3(axis.horizontal ? 0 : sign, 0, axis.horizontal ? sign : 0);
    const direction = new THREE.Vector3(axis.horizontal ? 1 : 0, 0, axis.horizontal ? 0 : 1);
    for (const cut of cuts) {
      let exterior = 0;
      const neighbours = new Map<string, number>();
      for (const u of [-0.29, 0.29])
        for (const v of [0.21, 0.79]) {
          const along = axis.center + cut.offset + cut.width * u;
          const outside = new THREE.Vector3(
            axis.horizontal ? along : axis.boundary,
            room.elevation + cut.sill + cut.height * v,
            axis.horizontal ? axis.boundary : along,
          ).addScaledVector(outward, 0.04);
          const indoors = house.rooms.find(
            (other) =>
              other.id !== room.id &&
              enclosedRoom(other) &&
              Math.abs(outside.x - other.x) < other.width / 2 &&
              Math.abs(outside.z - other.z) < other.depth / 2 &&
              outside.y >= other.elevation &&
              outside.y < roofHeightAt(house, other, outside.x, outside.z),
          );
          if (!indoors) exterior += 0.25;
          else neighbours.set(indoors.id, (neighbours.get(indoors.id) ?? 0) + 0.25);
        }
      const start = axis.center + cut.offset - cut.width / 2;
      const corner = new THREE.Vector3(
        axis.horizontal ? start : axis.boundary,
        room.elevation + cut.sill,
        axis.horizontal ? axis.boundary : start,
      );
      const along = direction.clone().multiplyScalar(cut.width);
      const middle = corner
        .clone()
        .addScaledVector(along, 0.5)
        .add(new THREE.Vector3(0, cut.height / 2, 0));
      const inside = middle.clone().addScaledVector(outward, -1);
      if (rectangleIntegral(inside, outward, corner, along, cut.height) < 0) {
        corner.add(along);
        along.negate();
      }
      const area = cut.width * cut.height;
      if (exterior)
        result.push({ corner, along, height: cut.height, weight: exterior, outward, area });
      for (const [neighbour, weight] of neighbours)
        result.push({
          corner: corner.clone(),
          along: along.clone(),
          height: cut.height,
          weight,
          neighbour,
          outward,
          area,
        });
    }
  }
  // The shader loop is bounded; keep the openings that admit the most light,
  // windows before portals.
  return result
    .sort(
      (a, b) =>
        Number(!!a.neighbour) - Number(!!b.neighbour) || b.area * b.weight - a.area * a.weight,
    )
    .slice(0, MAX_ROOM_APERTURES)
    .map(({ area: _area, ...aperture }) => aperture);
}

/** The other enclosed rooms nearest this one, padded to the shader's fixed
 * array size with empty boxes. */
export function roomNeighbourBoxes(house: Scene, room: Room) {
  const own = roomProbeVolume(house, room);
  const boxes = house.rooms
    .filter((other) => other.id !== room.id && enclosedRoom(other))
    .map((other) => roomProbeVolume(house, other))
    .map(({ min, max }) => ({
      min,
      max,
      gap: new THREE.Box3(min, max).distanceToPoint(own.probe),
    }))
    .sort((a, b) => a.gap - b.gap)
    .slice(0, MAX_ROOM_NEIGHBOURS);
  const count = boxes.length;
  while (boxes.length < MAX_ROOM_NEIGHBOURS)
    boxes.push({ min: new THREE.Vector3(), max: new THREE.Vector3(), gap: Infinity });
  return Object.assign(boxes, { count });
}

/** The room volume used for box-projected reflections and the probe point. */
export function roomProbeVolume(house: Scene, room: Room) {
  const top = roomSlabs(house, room).roofClipped
    ? room.elevation + room.height
    : roofMaximumHeight(house, room);
  return {
    min: new THREE.Vector3(room.x - room.width / 2, room.elevation, room.z - room.depth / 2),
    max: new THREE.Vector3(room.x + room.width / 2, top, room.z + room.depth / 2),
    probe: new THREE.Vector3(room.x, room.elevation + Math.min(1.4, room.height * 0.45), room.z),
  };
}

const skyCache = new Map<Light, THREE.Vector3[]>();
/** SH9 radiance of the procedural sky at the exterior environment intensity,
 * for room-material faces that are really outdoor surfaces. */
export function skyHarmonics(light: Light) {
  let cached = skyCache.get(light);
  if (!cached) {
    const width = 64,
      height = 32;
    const pixels = daylightSkyPixels(light, width, height);
    const sh = new THREE.SphericalHarmonics3(),
      basis = new Array<number>(9).fill(0),
      direction = new THREE.Vector3();
    let weight = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const theta = (1 - y / (height - 1)) * Math.PI,
          phi = (x / width - 0.5) * 2 * Math.PI;
        const solidAngle = Math.sin(theta);
        direction.set(
          Math.sin(theta) * Math.cos(phi),
          Math.cos(theta),
          Math.sin(theta) * Math.sin(phi),
        );
        THREE.SphericalHarmonics3.getBasisAt(direction, basis);
        const i = (y * width + x) * 4;
        for (let j = 0; j < 9; j++)
          sh.coefficients[j].add(
            new THREE.Vector3(pixels[i], pixels[i + 1], pixels[i + 2]).multiplyScalar(
              basis[j] * solidAngle,
            ),
          );
        weight += solidAngle;
      }
    sh.scale(((4 * Math.PI) / weight) * EXTERIOR_ENVIRONMENT_INTENSITY);
    cached = sh.coefficients;
    skyCache.set(light, cached);
  }
  return cached;
}

/** CPU mirror of the shader's sky (src/renderLighting.ts daylightSkyPixels). */
export function skyRadiance(light: Light, direction: THREE.Vector3, target = new THREE.Color()) {
  const sky = skyModel(light);
  if (direction.y < 0) return target.copy(sky.ground);
  const glow = Math.pow(Math.max(0, direction.dot(sky.sun)), 32) * 0.8;
  return target
    .copy(sky.horizon)
    .lerp(sky.zenith, Math.pow(direction.y, 0.55))
    .multiplyScalar(sky.scale + glow);
}

/** CPU mirror of the generator's exterior window irradiance (tests and diagnostics). */
export function apertureIrradiance(
  apertures: Aperture[],
  light: Light,
  point: THREE.Vector3,
  normal: THREE.Vector3,
) {
  const sum = new THREE.Color(0, 0, 0),
    color = new THREE.Color();
  const ground = skyModel(light).ground;
  for (const aperture of apertures) {
    if (aperture.neighbour) continue;
    const split = THREE.MathUtils.clamp(point.y - aperture.corner.y, 0, aperture.height);
    if (aperture.height - split > 1e-3) {
      const corner = aperture.corner.clone().setY(aperture.corner.y + split);
      const height = aperture.height - split;
      const middle = corner
        .clone()
        .addScaledVector(aperture.along, 0.5)
        .add(new THREE.Vector3(0, height / 2, 0));
      const form =
        Math.PI * Math.max(0, rectangleIntegral(point, normal, corner, aperture.along, height));
      skyRadiance(light, middle.sub(point).normalize(), color);
      sum.add(color.multiplyScalar(form * aperture.weight));
    }
    if (split > 1e-3) {
      const form =
        Math.PI *
        Math.max(0, rectangleIntegral(point, normal, aperture.corner, aperture.along, split));
      sum.add(color.copy(ground).multiplyScalar(form * aperture.weight));
    }
  }
  return sum;
}

/** Project six RGBA cube faces read back from a WebGL cube render target onto
 * SH9 radiance (Three's LightProbeGenerator convention), plus mean luminance. */
export function cubeFacesToHarmonics(faces: ArrayLike<number>[], size: number) {
  const sh = new THREE.SphericalHarmonics3();
  const basis = new Array<number>(9).fill(0);
  const coord = new THREE.Vector3();
  const pixel = 2 / size;
  let total = 0,
    luminance = 0;
  faces.forEach((data, face) => {
    for (let index = 0; index < size * size; index++) {
      const r = data[index * 4],
        g = data[index * 4 + 1],
        b = data[index * 4 + 2];
      // WebGL readback: flip = -1 in LightProbeGenerator.
      const col = -(1 - ((index % size) + 0.5) * pixel);
      const row = 1 - (Math.floor(index / size) + 0.5) * pixel;
      if (face === 0) coord.set(1, row, -col);
      else if (face === 1) coord.set(-1, row, col);
      else if (face === 2) coord.set(col, 1, -row);
      else if (face === 3) coord.set(col, -1, row);
      else if (face === 4) coord.set(col, row, 1);
      else coord.set(-col, row, -1);
      const lengthSq = coord.lengthSq();
      const weight = 4 / (Math.sqrt(lengthSq) * lengthSq);
      total += weight;
      THREE.SphericalHarmonics3.getBasisAt(coord.normalize(), basis);
      for (let j = 0; j < 9; j++) {
        sh.coefficients[j].x += basis[j] * r * weight;
        sh.coefficients[j].y += basis[j] * g * weight;
        sh.coefficients[j].z += basis[j] * b * weight;
      }
      luminance += (0.2126 * r + 0.7152 * g + 0.0722 * b) * weight;
    }
  });
  sh.scale((4 * Math.PI) / total);
  return { sh, luminance: luminance / total };
}

const REFLECT_LINE = 'reflectVec = inverseTransformDirection( reflectVec, viewMatrix );';
/** Irradiance volume texels per meter, and the cap per axis. */
const VOLUME_SPACING = 0.5;
const VOLUME_MAX = 32;
const VOLUME_INSET = 0.02;

/** Evaluates window and portal irradiance at every grid point of a room's
 * volume for the six axis normals (an ambient cube), one 3D-texture layer per draw. */
const GENERATOR = /* glsl */ `
#define ROOM_APERTURES ${MAX_ROOM_APERTURES}
uniform vec4 roomAperture[ ROOM_APERTURES * 4 ];
uniform int roomApertureCount;
uniform vec3 roomSkyZenith;
uniform vec3 roomSkyHorizon;
uniform vec3 roomSkyGround;
uniform vec3 roomSkySun;
uniform float roomSkyScale;
uniform vec3 roomProbePosition;
uniform vec3 roomGridMin;
uniform vec3 roomGridMax;
uniform vec3 roomGrid;
uniform float roomLayer;
const float PI = 3.141592653589793;

vec3 roomSky( const in vec3 direction ) {
	if ( direction.y < 0.0 ) return roomSkyGround;
	float glow = pow( max( 0.0, dot( direction, roomSkySun ) ), 32.0 ) * 0.8;
	return mix( roomSkyHorizon, roomSkyZenith, pow( direction.y, 0.55 ) ) * ( roomSkyScale + glow );
}
// Edge term of the form-factor vector (Heitz et al.'s LTC approximation of
// acos(x)/sin, already divided by 2π); dot with a normal gives the form factor.
vec3 roomEdge( const in vec3 a, const in vec3 b ) {
	float x = dot( a, b );
	float y = abs( x );
	float v = ( 0.8543985 + ( 0.4965155 + 0.0145206 * y ) * y ) / ( 3.4175940 + ( 4.1616724 + y ) * y );
	float k = x > 0.0 ? v : 0.5 * inversesqrt( max( 1.0 - x * x, 1e-7 ) ) - v;
	return cross( a, b ) * k;
}
// Windows: sky above the fragment's height and ground below it, sharing the
// split edge. Portals: the neighbour's captured radiance, as the change from
// what this room's own probe already saw through that opening.
vec3 roomWindowIrradiance( const in vec3 p, const in vec3 n ) {
	vec3 sum = vec3( 0.0 );
	for ( int i = 0; i < ROOM_APERTURES; i ++ ) {
		if ( i >= roomApertureCount ) break;
		vec4 a = roomAperture[ i * 4 ];
		vec4 b = roomAperture[ i * 4 + 1 ];
		vec4 c = roomAperture[ i * 4 + 2 ];
		vec3 top = vec3( 0.0, b.w, 0.0 );
		vec3 A = a.xyz - p;
		vec3 B = A + b.xyz;
		vec3 C = B + top;
		vec3 D = A + top;
		// Openings wholly behind the surface contribute nothing.
		if ( max( max( dot( A, n ), dot( B, n ) ), max( dot( C, n ), dot( D, n ) ) ) <= 0.0 ) continue;
		vec3 a0 = normalize( A ), b0 = normalize( B ), c0 = normalize( C ), d0 = normalize( D );
		if ( c.w > 0.5 ) {
			vec3 form = roomEdge( a0, b0 ) + roomEdge( b0, c0 ) + roomEdge( c0, d0 ) + roomEdge( d0, a0 );
			vec3 probe = roomAperture[ i * 4 + 3 ].xyz;
			sum += ( max( 0.0, dot( form, n ) ) - max( 0.0, dot( probe, n ) ) ) * PI * c.rgb * a.w;
			continue;
		}
		vec3 lift = vec3( 0.0, clamp( -A.y, 0.0, b.w ), 0.0 );
		vec3 s0 = normalize( A + lift ), s1 = normalize( B + lift );
		vec3 shared = roomEdge( s0, s1 );
		vec3 upper = shared + roomEdge( s1, c0 ) + roomEdge( c0, d0 ) + roomEdge( d0, s0 );
		vec3 lower = roomEdge( a0, b0 ) + roomEdge( b0, s1 ) - shared + roomEdge( s0, a0 );
		sum += PI * a.w * (
			max( 0.0, dot( upper, n ) ) * roomSky( normalize( 0.5 * ( A + lift + C ) ) ) +
			max( 0.0, dot( lower, n ) ) * roomSkyGround );
	}
	return sum;
}
// Metres to the nearest portal into another room (alpha channel).
float roomPortalDistance( const in vec3 p ) {
	float nearest = 100.0;
	for ( int i = 0; i < ROOM_APERTURES; i ++ ) {
		if ( i >= roomApertureCount ) break;
		if ( roomAperture[ i * 4 + 2 ].w < 0.5 ) continue;
		vec3 corner = roomAperture[ i * 4 ].xyz;
		vec4 b = roomAperture[ i * 4 + 1 ];
		float width = length( b.xyz );
		vec3 along = b.xyz / width;
		vec3 offset = p - corner;
		vec3 closest = corner + along * clamp( dot( offset, along ), 0.0, width ) +
			vec3( 0.0, clamp( offset.y, 0.0, b.w ), 0.0 );
		nearest = min( nearest, distance( p, closest ) );
	}
	return nearest;
}
void main() {
	float face = floor( gl_FragCoord.x / roomGrid.x );
	vec3 index = vec3( gl_FragCoord.x - face * roomGrid.x - 0.5, gl_FragCoord.y - 0.5, roomLayer );
	vec3 p = mix( roomGridMin, roomGridMax, index / max( roomGrid - 1.0, vec3( 1.0 ) ) );
	vec3 n = face < 0.5 ? vec3( 1, 0, 0 ) : face < 1.5 ? vec3( -1, 0, 0 ) : face < 2.5 ? vec3( 0, 1, 0 ) :
		face < 3.5 ? vec3( 0, -1, 0 ) : face < 4.5 ? vec3( 0, 0, 1 ) : vec3( 0, 0, -1 );
	gl_FragColor = vec4( roomWindowIrradiance( p, n ), roomPortalDistance( p ) );
}
`;

const PARS = /* glsl */ `
uniform vec3 roomBounce[ 9 ];
uniform float roomExposureGain;
uniform vec3 roomSky[ 9 ];
#define ROOM_NEIGHBOURS ${MAX_ROOM_NEIGHBOURS}
uniform vec3 roomNeighbourMin[ ROOM_NEIGHBOURS ];
uniform vec3 roomNeighbourMax[ ROOM_NEIGHBOURS ];
uniform int roomNeighbourCount;
uniform sampler3D roomWindowVolume;
uniform vec3 roomGrid;
uniform vec3 roomGridMin;
uniform vec3 roomGridMax;
uniform vec3 roomBoxMin;
uniform vec3 roomBoxMax;
uniform vec3 roomProbePosition;
varying vec3 vRoomWorldPosition;

// Ambient-cube lookup of the window volume: exact for axis-aligned surfaces,
// a smooth blend for others. Faces sit side by side along x; clamping to texel
// centres keeps filtering inside one face.
vec3 roomWindowFace( const in vec3 cell, const in float face ) {
	vec3 uvw = ( cell + 0.5 ) / roomGrid;
	uvw.x = ( cell.x + 0.5 + face * roomGrid.x ) / ( 6.0 * roomGrid.x );
	return texture( roomWindowVolume, uvw ).rgb;
}
// Faces that look out through the nearby room boundary (wall ends at
// building corners, floor-slab edges) are outdoor surfaces: sky light, not
// the room's. Inward faces, jambs and furniture stay indoor.
float roomExteriorFacing( const in vec3 p, const in vec3 n ) {
	vec3 a = abs( n );
	float major = max( max( a.x, a.y ), a.z );
	vec3 toFace = mix( p - roomBoxMin, roomBoxMax - p, step( 0.0, n ) );
	float d = a.x == major ? toFace.x : a.y == major ? toFace.y : toFace.z;
	float outside = smoothstep( 0.2, 0.04, d ) * smoothstep( 0.6, 0.9, major );
	if ( outside <= 0.0 ) return 0.0;
	// Past the face lies another room (a slab underside over a hall, say):
	// still indoors.
	vec3 beyond = p + n * 0.3;
	for ( int i = 0; i < ROOM_NEIGHBOURS; i ++ ) {
		if ( i >= roomNeighbourCount ) break;
		if ( all( greaterThan( beyond, roomNeighbourMin[ i ] ) ) && all( lessThan( beyond, roomNeighbourMax[ i ] ) ) ) return 0.0;
	}
	return outside;
}
// Short-range occlusion where surfaces meet the room's walls, floor and
// ceiling: each box face perpendicular to the normal darkens indirect light
// within 0.6 m of it, like contact occlusion in a photograph.
float roomEdgeOcclusion( const in vec3 p, const in vec3 n ) {
	vec3 low = clamp( 1.0 - ( p - roomBoxMin ) / 0.6, 0.0, 1.0 );
	vec3 high = clamp( 1.0 - ( roomBoxMax - p ) / 0.6, 0.0, 1.0 );
	vec3 across = 1.0 - abs( n );
	vec3 occlusion = 0.5 * ( low * low + high * high ) * across;
	return clamp( 1.0 - 0.6 * ( occlusion.x + occlusion.y + occlusion.z ), 0.45, 1.0 );
}
// Local exposure: a room seen from another keeps part of its own exposure,
// fading out within a few metres of the openings they share.
float roomLocalExposure( const in vec3 p ) {
	vec3 cell = clamp( ( p - roomGridMin ) / ( roomGridMax - roomGridMin ), 0.0, 1.0 ) * ( roomGrid - 1.0 );
	float portal = texture( roomWindowVolume, ( cell + 0.5 ) / vec3( 6.0 * roomGrid.x, roomGrid.yz ) ).a;
	return mix( 1.0, roomExposureGain, smoothstep( 0.5, 3.0, portal ) );
}
vec3 roomWindowIrradiance( const in vec3 p, const in vec3 n ) {
	vec3 cell = clamp( ( p - roomGridMin ) / ( roomGridMax - roomGridMin ), 0.0, 1.0 ) * ( roomGrid - 1.0 );
	vec3 n2 = n * n;
	return n2.x * roomWindowFace( cell, n.x >= 0.0 ? 0.0 : 1.0 ) +
		n2.y * roomWindowFace( cell, n.y >= 0.0 ? 2.0 : 3.0 ) +
		n2.z * roomWindowFace( cell, n.z >= 0.0 ? 4.0 : 5.0 );
}
// Parallax-corrected lookup into the room's reflection capture.
vec3 roomBoxProject( const in vec3 direction, const in float roughness ) {
	vec3 position = clamp( vRoomWorldPosition, roomBoxMin, roomBoxMax );
	vec3 d = vec3(
		direction.x >= 0.0 ? max( direction.x, 1e-4 ) : min( direction.x, -1e-4 ),
		direction.y >= 0.0 ? max( direction.y, 1e-4 ) : min( direction.y, -1e-4 ),
		direction.z >= 0.0 ? max( direction.z, 1e-4 ) : min( direction.z, -1e-4 ) );
	vec3 far = max( ( roomBoxMax - position ) / d, ( roomBoxMin - position ) / d );
	float t = min( min( far.x, far.y ), far.z );
	vec3 projected = normalize( position + d * t - roomProbePosition );
	// Very rough lobes span the whole room; the projection matters little there.
	return normalize( mix( projected, direction, smoothstep( 0.45, 0.9, roughness ) ) );
}
`;

/** Shared uniforms for every material of one room: updating a capture updates
 * all of them without recompiling. */
export class RoomLighting {
  readonly uniforms;
  readonly reflection: THREE.WebGLCubeRenderTarget;
  /** Window and portal irradiance on a grid, regenerated when portals change. */
  readonly irradiance: THREE.WebGL3DRenderTarget;
  readonly bounds: ReturnType<typeof roomProbeVolume>;
  readonly apertures: Aperture[];
  /** Mean scene luminance seen by the bounce probe; drives exposure. */
  luminance = 0;
  /** The irradiance volume needs regenerating (new portal radiance). */
  dirty = true;
  private generator: THREE.ShaderMaterial;
  constructor(
    house: Scene,
    readonly room: Room,
    readonly light: Light,
    reflectionSize: number,
  ) {
    this.bounds = roomProbeVolume(house, room);
    const neighbours = roomNeighbourBoxes(house, room);
    this.apertures = roomApertures(house, room);
    const sky = skyModel(light);
    const packed = Array.from({ length: MAX_ROOM_APERTURES * 4 }, () => new THREE.Vector4());
    this.apertures.forEach((aperture, index) => {
      const { corner, along, height, weight } = aperture;
      packed[index * 4].set(corner.x, corner.y, corner.z, weight);
      packed[index * 4 + 1].set(along.x, along.y, along.z, height);
      packed[index * 4 + 2].set(0, 0, 0, aperture.neighbour ? 1 : 0);
      // A portal's form-factor vector at the probe: what the capture already saw.
      const probe = rectangleVector(this.bounds.probe, corner, along, height);
      packed[index * 4 + 3].set(probe.x, probe.y, probe.z, 0);
    });
    const size = this.bounds.max.clone().sub(this.bounds.min);
    const grid = new THREE.Vector3(
      ...size
        .toArray()
        .map((length) =>
          THREE.MathUtils.clamp(Math.ceil(length / VOLUME_SPACING) + 1, 2, VOLUME_MAX),
        ),
    );
    const gridMin = this.bounds.min.clone().addScalar(VOLUME_INSET);
    const gridMax = this.bounds.max.clone().addScalar(-VOLUME_INSET);
    this.irradiance = new THREE.WebGL3DRenderTarget(grid.x * 6, grid.y, grid.z, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
    this.uniforms = {
      roomBounce: { value: Array.from({ length: 9 }, () => new THREE.Vector3()) },
      roomWindowVolume: { value: this.irradiance.texture },
      roomGrid: { value: grid },
      roomGridMin: { value: gridMin },
      roomGridMax: { value: gridMax },
      roomBoxMin: { value: this.bounds.min },
      roomBoxMax: { value: this.bounds.max },
      roomProbePosition: { value: this.bounds.probe },
      roomExposureGain: { value: 1 },
      roomSky: { value: skyHarmonics(light) },
      roomNeighbourMin: { value: neighbours.map((box) => box.min) },
      roomNeighbourMax: { value: neighbours.map((box) => box.max) },
      roomNeighbourCount: { value: neighbours.count },
    };
    this.generator = new THREE.ShaderMaterial({
      vertexShader: 'void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }',
      fragmentShader: GENERATOR,
      uniforms: {
        roomAperture: { value: packed },
        roomApertureCount: { value: this.apertures.length },
        roomSkyZenith: { value: sky.zenith },
        roomSkyHorizon: { value: sky.horizon },
        roomSkyGround: { value: sky.ground },
        roomSkySun: { value: sky.sun },
        roomSkyScale: { value: sky.scale },
        roomProbePosition: { value: this.bounds.probe },
        roomGridMin: { value: gridMin },
        roomGridMax: { value: gridMax },
        roomGrid: { value: grid },
        roomLayer: { value: 0 },
      },
      depthTest: false,
      depthWrite: false,
    });
    this.reflection = new THREE.WebGLCubeRenderTarget(reflectionSize, {
      type: THREE.HalfFloatType,
      generateMipmaps: false,
    });
  }
  setBounce(coefficients: THREE.Vector3[]) {
    coefficients.forEach((value, index) => this.uniforms.roomBounce.value[index].copy(value));
  }
  /** Portals into `neighbour` show the radiance its probe saw looking away from this room. */
  setPortalRadiance(neighbour: RoomLighting) {
    const sh = new THREE.SphericalHarmonics3();
    neighbour.uniforms.roomBounce.value.forEach((value, index) =>
      sh.coefficients[index].copy(value),
    );
    const radiance = new THREE.Vector3();
    const packed = this.generator.uniforms.roomAperture.value as THREE.Vector4[];
    this.apertures.forEach((aperture, index) => {
      if (aperture.neighbour !== neighbour.room.id) return;
      sh.getAt(aperture.outward, radiance).max(new THREE.Vector3());
      packed[index * 4 + 2].set(radiance.x, radiance.y, radiance.z, 1);
      this.dirty = true;
    });
  }
  /** Regenerate the irradiance volume, one layer per draw. */
  renderIrradiance(renderer: THREE.WebGLRenderer) {
    const quad = (fullscreen ??= new THREE.Mesh(new THREE.PlaneGeometry(2, 2)));
    quad.material = this.generator;
    // A light-less draw would otherwise consume the scene's pending shadow update.
    const shadows = renderer.shadowMap.needsUpdate;
    for (let layer = 0; layer < this.irradiance.depth; layer++) {
      this.generator.uniforms.roomLayer.value = layer;
      renderer.setRenderTarget(this.irradiance, layer);
      renderer.render(quad, ORTHOGRAPHIC);
    }
    renderer.shadowMap.needsUpdate = shadows;
    this.dirty = false;
  }
  /** Light a material with this room's window, bounce and reflection probes. */
  apply(material: THREE.MeshStandardMaterial) {
    material.envMap = this.reflection.texture;
    material.envMapIntensity = 1;
    material.onBeforeCompile = (shader) => {
      // Without these hooks the material keeps the room's reflection probe
      // for both terms rather than receiving broken GLSL.
      const chunks = THREE.ShaderChunk;
      if (
        !shader.vertexShader.includes('#include <worldpos_vertex>') ||
        !shader.fragmentShader.includes('#include <lights_fragment_maps>') ||
        !shader.fragmentShader.includes('#include <envmap_physical_pars_fragment>') ||
        !chunks.envmap_physical_pars_fragment.includes(REFLECT_LINE) ||
        !chunks.lights_pars_begin.includes('vec3 getLightProbeIrradiance(') ||
        !chunks.lights_fragment_maps.includes('iblIrradiance') ||
        !shader.fragmentShader.includes('#include <tonemapping_fragment>')
      )
        return;
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader =
        'varying vec3 vRoomWorldPosition;\n' +
        shader.vertexShader.replace(
          '#include <worldpos_vertex>',
          '#include <worldpos_vertex>\nvRoomWorldPosition = worldPosition.xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <envmap_physical_pars_fragment>',
          PARS +
            chunks.envmap_physical_pars_fragment.replace(
              REFLECT_LINE,
              `${REFLECT_LINE}\n\t\t\treflectVec = roomBoxProject( reflectVec, roughness );`,
            ),
        )
        .replace(
          '#include <lights_fragment_maps>',
          `#include <lights_fragment_maps>
vec3 roomNormal = inverseTransformDirection( normal, viewMatrix );
float roomOutside = roomExteriorFacing( vRoomWorldPosition, inverseTransformDirection( geometryNormal, viewMatrix ) );
float roomOcclusion = roomEdgeOcclusion( vRoomWorldPosition, roomNormal );
vec3 roomIndoor = max( vec3( 0.0 ),
	getLightProbeIrradiance( roomBounce, normal ) * roomOcclusion +
	roomWindowIrradiance( vRoomWorldPosition, roomNormal ) * mix( 1.0, roomOcclusion, 0.5 ) );
iblIrradiance = mix( roomIndoor, getLightProbeIrradiance( roomSky, normal ), roomOutside );`,
        )
        .replace(
          '#include <tonemapping_fragment>',
          'gl_FragColor.rgb *= mix( roomLocalExposure( vRoomWorldPosition ), 1.0, roomOutside );\n#include <tonemapping_fragment>',
        );
    };
    material.customProgramCacheKey = () => 'terrain-room-lighting-v4';
  }
  /** Free GPU objects (they are recreated on next use) and mark for regeneration. */
  release() {
    this.reflection.dispose();
    this.irradiance.dispose();
    this.generator.dispose();
    this.dirty = true;
  }
  dispose() {
    this.release();
  }
}
let fullscreen: THREE.Mesh | undefined;
const ORTHOGRAPHIC = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

type Task = { kind: 'bounce' | 'reflection'; lighting: RoomLighting };
type Bounce = { sh: THREE.Vector3[]; luminance: number };
/** Converged bounce light per visual scene key, shared by every canvas in the
 * page so agent image captures only redo the cheap reflection captures. */
const bounceCache = new Map<string, Map<string, Bounce>>();
/** Last known bounce per room id: new probe sets start from it after an edit. */
const latestBounce = new Map<string, Bounce>();

/** Owns the captures for one canvas. Registered on `scene.userData.roomProbes`;
 * the interactive loop spends a small per-frame budget, image captures finish
 * everything before drawing. */
export class RoomProbeSystem {
  private queue: Task[] = [];
  private bounce = new THREE.WebGLCubeRenderTarget(BOUNCE_SIZE, {
    type: THREE.HalfFloatType,
    generateMipmaps: false,
  });
  private camera = new THREE.CubeCamera(0.05, 400, this.bounce);
  private shadowPrimer = new THREE.WebGLRenderTarget(1, 1);
  private pixels = Array.from({ length: 6 }, () => new Uint16Array(BOUNCE_SIZE * BOUNCE_SIZE * 4));
  private floats = Array.from({ length: 6 }, () => new Float32Array(BOUNCE_SIZE * BOUNCE_SIZE * 4));
  captures = 0;
  milliseconds = 0;
  /** True once every queued capture has run at least once. */
  converged = false;
  /** Diagnostics: time spent drawing, reading back and reflecting. */
  timings = { bounceDraw: 0, readback: 0, reflection: 0 };
  private key?: string;
  constructor(readonly lightings: RoomLighting[]) {
    const seeded = lightings.filter((lighting) => latestBounce.has(lighting.room.id));
    seeded.forEach((lighting) => this.restore(lighting, latestBounce.get(lighting.room.id)!));
    // Rooms that existed before relight progressively instead of stalling.
    this.converged = lightings.length > 0 && seeded.length === lightings.length;
    this.reset();
  }
  /** Queue captures after edits, light changes or asset loads. With a key whose
   * bounce light is cached, only the reflection captures run. */
  reset(key?: string) {
    this.key = key;
    this.queue = [];
    const cached = key ? bounceCache.get(key) : undefined;
    if (cached && this.lightings.every((lighting) => cached.has(lighting.room.id)))
      this.lightings.forEach((lighting) => this.restore(lighting, cached.get(lighting.room.id)!));
    else
      for (let pass = 0; pass < BOUNCE_PASSES; pass++)
        for (const lighting of this.lightings) this.queue.push({ kind: 'bounce', lighting });
    for (const lighting of this.lightings) this.queue.push({ kind: 'reflection', lighting });
  }
  /** Local exposure for the camera's position: `interior` is the blended
   * exposure of the rooms around the camera, `inside` 0 outdoors to 1 indoors. */
  setCameraExposure(interior: number, inside: number) {
    for (const lighting of this.lightings) {
      // Only dim rooms open up; brighter neighbours keep their physical level.
      const gain = Math.max(
        1,
        Math.pow(roomExposure(lighting.luminance) / interior, LOCAL_EXPOSURE),
      );
      lighting.uniforms.roomExposureGain.value = 1 + (gain - 1) * inside;
    }
  }
  private restore(lighting: RoomLighting, bounce: Bounce) {
    lighting.setBounce(bounce.sh);
    lighting.luminance = bounce.luminance;
    this.luminance.set(lighting.room.id, bounce.luminance);
    for (const other of this.lightings)
      if (other.apertures.some((aperture) => aperture.neighbour === lighting.room.id))
        other.setPortalRadiance(lighting);
  }
  private remember() {
    const bounces = new Map(
      this.lightings.map((lighting) => [
        lighting.room.id,
        {
          sh: lighting.uniforms.roomBounce.value.map((value) => value.clone()),
          luminance: lighting.luminance,
        },
      ]),
    );
    bounces.forEach((bounce, id) => latestBounce.set(id, bounce));
    if (!this.key) return;
    bounceCache.set(this.key, bounces);
    while (bounceCache.size > 8) bounceCache.delete(bounceCache.keys().next().value!);
  }
  /** Captures still queued (diagnostics and tests). */
  get queued() {
    return this.queue.length;
  }
  get pending() {
    return this.queue.length > 0 || this.lightings.some((lighting) => lighting.dirty);
  }
  private refreshIrradiance(renderer: THREE.WebGLRenderer) {
    for (const lighting of this.lightings) if (lighting.dirty) lighting.renderIrradiance(renderer);
  }
  private luminance = new Map<string, number>();
  /** Mean luminance per room id, available once a bounce pass has run. */
  luminances() {
    return this.luminance;
  }
  /** Run queued captures until the budget is spent (at least one). */
  update(renderer: THREE.WebGLRenderer, scene: THREE.Scene, budgetMs = Infinity) {
    if (!this.pending) return false;
    const start = performance.now();
    const background = scene.background;
    const target = renderer.getRenderTarget();
    const hidden: THREE.Object3D[] = [];
    let masked = false;
    // Captures record physical radiance: no local exposure in them.
    const gains = this.lightings.map((lighting) => lighting.uniforms.roomExposureGain.value);
    this.lightings.forEach((lighting) => (lighting.uniforms.roomExposureGain.value = 1));
    // Bounce captures mask the sky and site: window light is integrated analytically.
    const mask = (on: boolean) => {
      if (on === masked) return;
      masked = on;
      scene.background = on ? BLACK : background;
      if (on)
        scene.traverse((object) => {
          if (object.userData.probeHidden && object.visible) {
            object.visible = false;
            hidden.push(object);
          }
        });
      else hidden.splice(0).forEach((object) => (object.visible = true));
    };
    try {
      // A pending shadow refresh must see the whole scene, not a masked capture.
      if (renderer.shadowMap.enabled && renderer.shadowMap.needsUpdate) {
        renderer.setRenderTarget(this.shadowPrimer);
        renderer.render(scene, this.camera.children[0] as THREE.Camera);
      }
      this.refreshIrradiance(renderer);
      while (this.queue.length) {
        const task = this.queue.shift()!;
        mask(task.kind === 'bounce');
        this.camera.position.copy(task.lighting.bounds.probe);
        if (task.kind === 'bounce') this.captureBounce(renderer, scene, task.lighting);
        else {
          const begin = performance.now();
          this.camera.renderTarget = task.lighting.reflection;
          this.camera.update(renderer, scene);
          task.lighting.reflection.texture.needsPMREMUpdate = true;
          this.timings.reflection += performance.now() - begin;
        }
        this.captures++;
        // Portal radiance changed: neighbours' volumes follow before their captures.
        this.refreshIrradiance(renderer);
        if (performance.now() - start >= budgetMs) break;
      }
      if (!this.queue.length) {
        this.converged = true;
        this.remember();
      }
    } finally {
      this.lightings.forEach(
        (lighting, index) => (lighting.uniforms.roomExposureGain.value = gains[index]),
      );
      mask(false);
      renderer.setRenderTarget(target);
      this.milliseconds += performance.now() - start;
    }
    return true;
  }
  private captureBounce(renderer: THREE.WebGLRenderer, scene: THREE.Scene, lighting: RoomLighting) {
    let begin = performance.now();
    this.camera.renderTarget = this.bounce;
    this.camera.update(renderer, scene);
    this.timings.bounceDraw += performance.now() - begin;
    begin = performance.now();
    for (let face = 0; face < 6; face++) {
      renderer.readRenderTargetPixels(
        this.bounce,
        0,
        0,
        BOUNCE_SIZE,
        BOUNCE_SIZE,
        this.pixels[face],
        face,
      );
      const source = this.pixels[face],
        output = this.floats[face];
      for (let i = 0; i < source.length; i++) output[i] = THREE.DataUtils.fromHalfFloat(source[i]);
    }
    this.timings.readback += performance.now() - begin;
    const { sh, luminance } = cubeFacesToHarmonics(this.floats, BOUNCE_SIZE);
    this.restore(lighting, { sh: sh.coefficients, luminance });
  }
  /** On context loss: free GPU objects while their handles still belong to the
   * lost context; the next update recreates them after a restore. */
  release() {
    this.bounce.dispose();
    this.shadowPrimer.dispose();
    fullscreen?.geometry.dispose();
    this.lightings.forEach((lighting) => lighting.release());
  }
  dispose() {
    this.bounce.dispose();
    this.shadowPrimer.dispose();
    this.lightings.forEach((lighting) => lighting.dispose());
  }
}
const BLACK = new THREE.Color(0, 0, 0);

export function roomProbeSystem(scene: THREE.Scene) {
  return scene.userData.roomProbes as RoomProbeSystem | undefined;
}
