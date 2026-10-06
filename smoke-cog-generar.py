# GeoTIFF de prueba CON teselas y overviews (lo que hace un COG), para la prueba de "Mis mapas"
# perezoso (v133). Python puro: numpy + tifffile (pip install tifffile), sin GDAL/rasterio.
# Mismo recuadro UTM 19S que smoke-geotiff-utm19s.tif, 1024x768 px, tablero con franja roja al norte.
import numpy as np, tifffile, os
SALIDA = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'smoke-geotiff-cog.tif')
W, H = 1024, 768
yy, xx = np.mgrid[0:H, 0:W]
img = np.zeros((H, W, 3), np.uint8)
tab = (((xx // 128) + (yy // 128)) % 2).astype(np.uint8) * 255
img[..., 0] = tab; img[..., 1] = tab; img[..., 2] = tab
img[:96, :, 0] = 220; img[:96, :, 1] = 40; img[:96, :, 2] = 40      # franja roja = NORTE
x0, y1, px = 296000.0, 6100000.0, 13.0                             # esquina NO en UTM 19S, 13 m/px
gk = (1,1,0,3, 1024,0,1,1, 1025,0,1,1, 3072,0,1,32719)              # proyectada, PixelIsArea, EPSG:32719
geo = [(33550,12,3,(px,px,0.0),False), (33922,12,6,(0,0,0,x0,y1,0),False), (34735,3,len(gk),gk,False)]
with tifffile.TiffWriter(SALIDA) as t:
    t.write(img, photometric='rgb', tile=(256,256), compression='zlib', extratags=geo, subfiletype=0)
    for f in (2, 4):
        t.write(img[::f, ::f], photometric='rgb', tile=(256,256), compression='zlib', subfiletype=1)
print(SALIDA, os.path.getsize(SALIDA), 'bytes')
