# Dos GeoTIFF de prueba con el MISMO recuadro en el terreno, uno en WGS84 geograficas y otro en
# UTM 19S, para comprobar donde los coloca GeoRasterLayer. El patron es un tablero con una franja
# roja arriba, para reconocer de un vistazo si sale rotado, espejado o corrido.
import numpy as np, rasterio, json, os
from rasterio.transform import from_bounds
from rasterio.warp import transform_bounds

SALIDA = os.path.dirname(os.path.abspath(__file__))
W, H = 256, 192

# recuadro en WGS84 (cerca de Curico, la misma zona que el shapefile de prueba)
OESTE, SUR, ESTE, NORTE = -71.25, -35.30, -71.10, -35.18

def patron():
    img = np.zeros((3, H, W), dtype=np.uint8)
    yy, xx = np.mgrid[0:H, 0:W]
    tab = (((xx // 32) + (yy // 32)) % 2).astype(np.uint8) * 255
    img[0] = tab; img[1] = tab; img[2] = tab
    img[0, :24, :] = 220; img[1, :24, :] = 40; img[2, :24, :] = 40      # franja roja = NORTE
    img[0, :, :16] = 40;  img[1, :, :16] = 90; img[2, :, :16] = 220     # franja azul = OESTE
    return img

img = patron()

# --- 1) EPSG:4326 ---
p4326 = os.path.join(SALIDA, 'mapa_wgs84.tif')
with rasterio.open(p4326, 'w', driver='GTiff', height=H, width=W, count=3, dtype='uint8',
                   crs='EPSG:4326', transform=from_bounds(OESTE, SUR, ESTE, NORTE, W, H),
                   compress='deflate') as dst:
    dst.write(img)

# --- 2) EPSG:32719 (WGS84 / UTM 19S): el MISMO recuadro, en metros ---
xmin, ymin, xmax, ymax = transform_bounds('EPSG:4326', 'EPSG:32719', OESTE, SUR, ESTE, NORTE)
p32719 = os.path.join(SALIDA, 'mapa_utm19s.tif')
with rasterio.open(p32719, 'w', driver='GTiff', height=H, width=W, count=3, dtype='uint8',
                   crs='EPSG:32719', transform=from_bounds(xmin, ymin, xmax, ymax, W, H),
                   compress='deflate') as dst:
    dst.write(img)

esperado = {'wgs84': {'west': OESTE, 'south': SUR, 'east': ESTE, 'north': NORTE},
            'utm19s_en_metros': {'xmin': xmin, 'ymin': ymin, 'xmax': xmax, 'ymax': ymax},
            'utm19s_esperado_en_wgs84': {'west': OESTE, 'south': SUR, 'east': ESTE, 'north': NORTE}}
json.dump(esperado, open(os.path.join(SALIDA, 'geotiff_esperado.json'), 'w'), indent=1)

for p in (p4326, p32719):
    with rasterio.open(p) as s:
        print('%-18s %s  bounds=%s  %d bytes' % (os.path.basename(p), s.crs,
              tuple(round(v, 3) for v in s.bounds), os.path.getsize(p)))
print('\nLos dos cubren EXACTAMENTE el mismo terreno:')
print('  W=%.4f S=%.4f E=%.4f N=%.4f' % (OESTE, SUR, ESTE, NORTE))
