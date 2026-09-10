# Genera shapefiles de prueba (puntos y lineas) escribiendo .shp/.shx/.dbf a mano con struct,
# porque en esta maquina no hay pyshp ni GDAL. Sirve como fixture para verificar que shpjs
# reproyecta de verdad: el .prj declara UTM 19S y pyproj da la respuesta esperada en WGS84.
import struct, zipfile, io, os, json, sys

SALIDA = os.path.dirname(os.path.abspath(__file__))

# EPSG:24879 = PSAD56 / UTM zone 19S  (el datum historico de las cartas chilenas)
PRJ_PSAD56_19S = (
 'PROJCS["PSAD56 / UTM zone 19S",GEOGCS["PSAD56",DATUM["Provisional_South_American_Datum_1956",'
 'SPHEROID["International 1924",6378388,297],TOWGS84[-302,272,-360,0,0,0,0]],'
 'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],'
 'PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-69],'
 'PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],'
 'PARAMETER["false_northing",10000000],UNIT["metre",1]]')

def cab_shp(tipo, n_words, bbox):
    h = struct.pack('>7i', 9994, 0, 0, 0, 0, 0, n_words)
    h += struct.pack('<2i', 1000, tipo)
    h += struct.pack('<4d', *bbox)
    h += struct.pack('<4d', 0, 0, 0, 0)
    return h

def dbf(nombres):
    campos = [('NOMBRE', 'C', 40)]
    n_rec, largo_rec = len(nombres), 1 + sum(f[2] for f in campos)
    largo_cab = 32 + 32 * len(campos) + 1
    out = struct.pack('<B3BI2H20x', 3, 99, 1, 1, n_rec, largo_cab, largo_rec)
    for nom, tipo, ancho in campos:
        out += nom.encode('ascii').ljust(11, b'\0') + tipo.encode('ascii')
        out += b'\0' * 4 + struct.pack('<2B', ancho, 0) + b'\0' * 14
    out += b'\x0d'
    for nom in nombres:
        out += b' ' + nom.encode('latin-1')[:40].ljust(40, b' ')
    return out + b'\x1a'

def shp_puntos(pts):
    """pts: [(x, y)] en las unidades del .prj"""
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    bbox = (min(xs), min(ys), max(xs), max(ys))
    cuerpo, indice, offset = b'', b'', 50            # offset en words de 16 bits
    for i, (x, y) in enumerate(pts, 1):
        cont = struct.pack('<i2d', 1, x, y)          # tipo 1 = Point
        cuerpo += struct.pack('>2i', i, len(cont) // 2) + cont
        indice += struct.pack('>2i', offset, len(cont) // 2)
        offset += 4 + len(cont) // 2
    shp = cab_shp(1, 50 + len(cuerpo) // 2, bbox) + cuerpo
    shx = cab_shp(1, 50 + len(indice) // 2, bbox) + indice
    return shp, shx

def shp_lineas(lineas, tipo=3):
    """lineas: [[(x, y), ...]]  ·  tipo 3 = PolyLine, 5 = Polygon (mismo layout binario)"""
    todos = [p for ln in lineas for p in ln]
    xs, ys = [p[0] for p in todos], [p[1] for p in todos]
    bbox = (min(xs), min(ys), max(xs), max(ys))
    cuerpo, indice, offset = b'', b'', 50
    for i, ln in enumerate(lineas, 1):
        lxs, lys = [p[0] for p in ln], [p[1] for p in ln]
        cont = struct.pack('<i', tipo)
        cont += struct.pack('<4d', min(lxs), min(lys), max(lxs), max(lys))
        cont += struct.pack('<2i', 1, len(ln))                         # numParts, numPoints
        cont += struct.pack('<i', 0)                                   # parts[0]
        for x, y in ln:
            cont += struct.pack('<2d', x, y)
        cuerpo += struct.pack('>2i', i, len(cont) // 2) + cont
        indice += struct.pack('>2i', offset, len(cont) // 2)
        offset += 4 + len(cont) // 2
    shp = cab_shp(tipo, 50 + len(cuerpo) // 2, bbox) + cuerpo
    shx = cab_shp(tipo, 50 + len(indice) // 2, bbox) + indice
    return shp, shx

# --- datos: tres puntos y una linea cerca de Curico, en UTM 19S ---
PUNTOS = [(300000.0, 6100000.0), (305500.0, 6103200.0), (298750.0, 6096400.0)]
NOMBRES_PT = ['PC-101', 'PC-102', 'PC-103']
LINEA = [[(300000.0, 6100000.0), (302000.0, 6101000.0), (304000.0, 6100500.0)]]
# anillo CERRADO y en sentido horario, como exige el formato para un anillo exterior
POLIGONO = [[(300000.0, 6100000.0), (300000.0, 6102000.0), (303000.0, 6102000.0),
             (303000.0, 6100000.0), (300000.0, 6100000.0)]]

pshp, pshx = shp_puntos(PUNTOS)
lshp, lshx = shp_lineas(LINEA)
gshp, gshx = shp_lineas(POLIGONO, tipo=5)

z = os.path.join(SALIDA, 'prueba_utm19s.zip')
with zipfile.ZipFile(z, 'w', zipfile.ZIP_DEFLATED) as zf:
    zf.writestr('puntos.shp', pshp); zf.writestr('puntos.shx', pshx)
    zf.writestr('puntos.dbf', dbf(NOMBRES_PT)); zf.writestr('puntos.prj', PRJ_PSAD56_19S)
    zf.writestr('lineas.shp', lshp); zf.writestr('lineas.shx', lshx)
    zf.writestr('lineas.dbf', dbf(['Contacto A'])); zf.writestr('lineas.prj', PRJ_PSAD56_19S)
    zf.writestr('unidades.shp', gshp); zf.writestr('unidades.shx', gshx)
    zf.writestr('unidades.dbf', dbf(['Fm. Abanico'])); zf.writestr('unidades.prj', PRJ_PSAD56_19S)

# --- respuesta esperada, calculada con pyproj ---
from pyproj import Transformer
t = Transformer.from_crs('EPSG:24879', 'EPSG:4326', always_xy=True)
esperado = {
    'puntos': [dict(zip(('lon', 'lat'), t.transform(x, y))) for x, y in PUNTOS],
    'linea':  [dict(zip(('lon', 'lat'), t.transform(x, y))) for x, y in LINEA[0]],
    'poligono': [dict(zip(('lon', 'lat'), t.transform(x, y))) for x, y in POLIGONO[0]],
}
with open(os.path.join(SALIDA, 'esperado.json'), 'w') as f:
    json.dump(esperado, f, indent=1)

print('zip:', os.path.getsize(z), 'bytes')
print('esperado (PSAD56/UTM19S -> WGS84):')
for n, p in zip(NOMBRES_PT, esperado['puntos']):
    print('  %-8s lat=%.6f lon=%.6f' % (n, p['lat'], p['lon']))
