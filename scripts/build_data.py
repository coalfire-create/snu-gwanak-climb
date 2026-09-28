"""Build the climb's data from real sources.

- scripts/dem.png: Terrarium elevation tiles (z14, x 13968-13970, y 6350-6352)
  from the AWS Open Data "Terrain Tiles" set, stitched.
- scripts/osm.json: OpenStreetMap (© OpenStreetMap contributors, ODbL) —
  buildings, footpaths and peaks around SNU's Gwanak campus.

Outputs public/height.png (a 16-bit-in-RGB heightmap cropped to the scene)
and src/data/climb.json (buildings, trail, landmarks), all in metres around
the scene origin: x east, z south, y up.
"""
import heapq, json, math, os
from PIL import Image

HERE = os.path.dirname(__file__)
Z, TX0, TY0 = 14, 13968, 6350
BBOX = (37.435, 126.935, 37.472, 126.972)  # south, west, north, east
GATE = (37.46709, 126.94933)  # 서울대학교 정문
PEAK = (37.44514, 126.96424)  # 관악산 정상 (OSM peak, ele 632)
YEONJUDAE = (37.44477, 126.96456)
M_LAT = 110540

dem = Image.open(os.path.join(HERE, 'dem.png')).convert('RGB')
px = dem.load()


def tile_xy(lat, lon):
    n = 2 ** Z
    fx = ((lon + 180) / 360 * n - TX0) * 256
    fy = ((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n - TY0) * 256
    return fx, fy


def elev(lat, lon):
    # Bilinear sample of the Terrarium DEM.
    fx, fy = tile_xy(lat, lon)
    x0, y0 = int(fx), int(fy)
    tx, ty = fx - x0, fy - y0

    def h(x, y):
        r, g, b = px[x, y]
        return r * 256 + g + b / 256 - 32768

    a = h(x0, y0) * (1 - tx) + h(x0 + 1, y0) * tx
    b = h(x0, y0 + 1) * (1 - tx) + h(x0 + 1, y0 + 1) * tx
    return a * (1 - ty) + b * ty


lat0 = (BBOX[0] + BBOX[2]) / 2
lon0 = (BBOX[1] + BBOX[3]) / 2
M_LON = M_LAT * math.cos(math.radians(lat0))
to_xz = lambda lat, lon: ((lon - lon0) * M_LON, -(lat - lat0) * M_LAT)
dist = lambda a, b: math.hypot((a[0] - b[0]) * M_LAT, (a[1] - b[1]) * M_LON)
inside_box = lambda lat, lon: BBOX[0] < lat < BBOX[2] and BBOX[1] < lon < BBOX[3]

# --- heightmap: resample the DEM onto a regular metre grid over the bbox ---
W = H = 512
width_m = (BBOX[3] - BBOX[1]) * M_LON
depth_m = (BBOX[2] - BBOX[0]) * M_LAT
hm = Image.new('RGB', (W, H))
hp = hm.load()
hmin, hmax = 1e9, -1e9
for j in range(H):
    lat = BBOX[2] - (BBOX[2] - BBOX[0]) * j / (H - 1)
    for i in range(W):
        lon = BBOX[1] + (BBOX[3] - BBOX[1]) * i / (W - 1)
        e = max(0.0, elev(lat, lon))
        hmin, hmax = min(hmin, e), max(hmax, e)
        v = int(round(e * 10))  # decimetres, 0..65535
        hp[i, j] = (v >> 8, v & 255, 0)
hm.save(os.path.join(HERE, '..', 'public', 'height.png'))

osm = json.load(open(os.path.join(HERE, 'osm.json')))['elements']

# --- campus outline and buildings ---
# The campus relation's outer ring comes as several ways; chain them end to end.
rel = json.load(open(os.path.join(HERE, 'campus_relation.json')))
parts = [[(p['lat'], p['lon']) for p in m['geometry']] for m in rel['members'] if m.get('role') == 'outer']
outline = parts.pop(0)
while parts:
    tail = outline[-1]
    part = min(parts, key=lambda q: min(dist(tail, q[0]), dist(tail, q[-1])))
    parts.remove(part)
    outline += part if dist(tail, part[0]) <= dist(tail, part[-1]) else part[::-1]


def in_poly(pt, poly):
    lat, lon = pt
    c = False
    for i in range(len(poly)):
        (y1, x1), (y2, x2) = poly[i], poly[i - 1]
        if (y1 > lat) != (y2 > lat) and lon < (x2 - x1) * (lat - y1) / (y2 - y1) + x1:
            c = not c
    return c


buildings = []
for e in osm:
    t = e.get('tags', {})
    if 'building' not in t or e['type'] != 'way' or 'geometry' not in e:
        continue
    ring = [(p['lat'], p['lon']) for p in e['geometry']]
    c = (sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring))
    if not inside_box(*c):
        continue
    try:
        levels = float(t.get('building:levels', 0))
    except ValueError:
        levels = 0
    on_campus = in_poly(c, outline)
    base = min(elev(*p) for p in ring)
    buildings.append({
        'p': [[round(v, 1) for v in to_xz(*p)] for p in ring],
        'y': round(base, 1),
        'h': round(levels * 3.6 if levels else (14 if on_campus else 10), 1),
        'c': 1 if on_campus else 0,
        **({'n': t['name']} if on_campus and t.get('name') else {}),
    })

# --- trail: shortest walk over OSM footpaths from the gate to the summit ---
nodes = {}
adj = {}


def node_id(lat, lon):
    k = (round(lat, 6), round(lon, 6))
    nodes[k] = k
    adj.setdefault(k, [])
    return k


for e in osm:
    t = e.get('tags', {})
    if 'highway' not in t or 'geometry' not in e:
        continue
    pts = [node_id(p['lat'], p['lon']) for p in e['geometry']]
    for a, b in zip(pts, pts[1:]):
        # Prefer real trails: steps and paths cost a little less than roads.
        w = dist(a, b)
        adj[a].append((b, w))
        adj[b].append((a, w))

# Bridge nearly-touching dead ends so separately mapped paths connect.
keys = list(nodes)
grid = {}
for k in keys:
    grid.setdefault((round(k[0], 3), round(k[1], 3)), []).append(k)
for k in keys:
    if len(adj[k]) > 1:
        continue
    cell = (round(k[0], 3), round(k[1], 3))
    for dy in (-0.001, 0, 0.001):
        for dx in (-0.001, 0, 0.001):
            for o in grid.get((round(cell[0] + dy, 3), round(cell[1] + dx, 3)), []):
                if o != k and dist(k, o) < 25:
                    adj[k].append((o, dist(k, o) * 2))
                    adj[o].append((k, dist(k, o) * 2))

start = min(keys, key=lambda k: dist(k, GATE))
goal = min(keys, key=lambda k: dist(k, PEAK))
best = {start: 0}
prev = {}
pq = [(0, start)]
while pq:
    d, u = heapq.heappop(pq)
    if u == goal:
        break
    if d > best[u]:
        continue
    for v, w in adj[u]:
        nd = d + w
        if nd < best.get(v, 1e18):
            best[v] = nd
            prev[v] = u
            heapq.heappush(pq, (nd, v))
path = [goal]
while path[-1] != start:
    path.append(prev[path[-1]])
path = [GATE] + path[::-1] + [PEAK]
print('trail nodes', len(path), 'length m', round(best[goal]), 'start gap', round(dist(start, GATE)), 'goal gap', round(dist(goal, PEAK)))

# Resample every ~8 m with DEM elevation.
trail = []
for a, b in zip(path, path[1:]):
    n = max(1, int(dist(a, b) / 8))
    for i in range(n):
        t = i / n
        lat, lon = a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t
        x, z = to_xz(lat, lon)
        trail.append([round(x, 1), round(elev(lat, lon), 1), round(z, 1)])
x, z = to_xz(*PEAK)
trail.append([round(x, 1), round(elev(*PEAK), 1), round(z, 1)])

landmarks = []
for name, pt in [('서울대학교 정문', GATE), ('관악산 정상', PEAK), ('연주대', YEONJUDAE)]:
    x, z = to_xz(*pt)
    landmarks.append({'name': name, 'x': round(x, 1), 'y': round(elev(*pt), 1), 'z': round(z, 1)})
for e in osm:
    t = e.get('tags', {})
    if e['type'] == 'node' and t.get('natural') == 'peak' and t.get('name') and t.get('name') != '관악산':
        x, z = to_xz(e['lat'], e['lon'])
        landmarks.append({'name': t['name'], 'x': round(x, 1), 'y': round(elev(e['lat'], e['lon']), 1), 'z': round(z, 1), 'peak': 1})

out = {
    'size': [round(width_m, 1), round(depth_m, 1)],
    'heightScale': 0.1,  # height.png stores decimetres in R*256+G
    'buildings': buildings,
    'trail': trail,
    'landmarks': landmarks,
    'outline': [[round(v, 1) for v in to_xz(*p)] for p in outline],
}
os.makedirs(os.path.join(HERE, '..', 'src', 'data'), exist_ok=True)
json.dump(out, open(os.path.join(HERE, '..', 'src', 'data', 'climb.json'), 'w'), ensure_ascii=False, separators=(',', ':'))
print('size', out['size'], 'elev', round(hmin), round(hmax), 'buildings', len(buildings), 'campus', sum(b['c'] for b in buildings),
      'named', sum(1 for b in buildings if 'n' in b), 'trail pts', len(trail), 'climb', trail[0][1], '->', trail[-1][1])
