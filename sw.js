// Service worker offline-first (cache estatico)
const CACHE='geonotas-v128';
// Caches que ESTA app puede purgar al activarse. NO se borra "todo lo que no sea CACHE":
// la Cache API tiene alcance de ORIGEN, no de ruta, y las dos PWAs (completa y light) viven
// en el mismo cvenegas-sernageomin.github.io. Con el filtro viejo, activar una borraba la
// cache de la otra -- y tambien 'transformers-cache', donde Transformers.js guarda el modelo
// de voz (~78 MB) de la light. En terreno eso deja sin offline a la otra app, sin aviso y sin
// forma de recuperarlo. Medido el 2026-08-31 contra el sitio en vivo: abrir la light dejaba
// caches.keys() en ['geonotas-light-9'], con 'geonotas-v108' ya borrada.
// Las dos listas son disjuntas: 'geonotas-v109' no calza en las de la light y viceversa.
const MIAS=[/^geonotas-v\d+$/, /^geoterreno-cdc-v\d+$/];   // la 2a: nombres previos al renombre
const esMia=k=>MIAS.some(re=>re.test(k));
// Cesium (Vista 3D) se baja de su CDN la primera vez que se abre el 3D estando en linea, y de
// ahi queda cache-first: en terreno funciona sin señal. NO va en ASSETS por el mismo motivo que
// gdal3 (ver abajo): son ~15 MB entre Cesium.js, sus Workers, ThirdParty, Assets y Widgets, y el
// install los bajaria en cada dispositivo aunque el geologo nunca abra el 3D. El prefijo de ruta
// cubre TODOS los subrecursos, no solo los dos que inyecta index.html: Cesium pide Workers/*.js,
// Assets/*.json e imagenes de Widgets/ en tiempo de ejecucion.
// CESIUM_CACHE es una CADENA, no un regex, y no calza con MIAS: ninguna de las dos PWAs la purga
// al activarse. Corolario: al subir V3D_CESIUM_VER en index.html la copia vieja NO se borra sola;
// el panel de Vista 3D trae un boton para borrarla.
const CESIUM_CACHE='geonotas-cesium';
const esCesium=u=>u.hostname==='cesium.com' && u.pathname.startsWith('/downloads/cesiumjs/');
const ASSETS=['./','./index.html','./manifest.json','./icons/icon-192.png','./icons/icon-512.png',
  './vendor/leaflet.css','./vendor/leaflet.js','./vendor/idb.js','./vendor/leaflet.offline.js',
  './vendor/georaster.browser.bundle.min.js','./vendor/georaster-layer-for-leaflet.min.js',
  './vendor/sql-wasm.js','./vendor/sql-wasm.wasm','./vendor/jszip.js','./vendor/shp.js',
  './vendor/images/marker-icon.png','./vendor/images/marker-icon-2x.png','./vendor/images/marker-shadow.png',
  './vendor/images/layers.png','./vendor/images/layers-2x.png'];
// vendor/gdal3.js + gdal3WebAssembly.{data,wasm} quedan FUERA de ASSETS a proposito: pesan
// ~39 MB entre los tres y el install del SW los bajaria en cada dispositivo aunque el geologo
// nunca exporte GDB. Igual quedan cacheados por la rama cache-first de abajo la primera vez
// que se usa la exportacion estando en linea. NO agregarlos aca "para completar la lista".
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting()));});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==CACHE&&esMia(k)).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;
  const req=e.request;
  // Cross-origin (tiles satelitales/topo de Esri y OpenTopoMap, export de ArcGIS): NO se
  // cachea aca. Los tiles offline los administra leaflet.offline en IndexedDB con el boton
  // "Descargar tiles", que ademas deja elegir el area y el zoom. Cachearlos tambien aca
  // duplicaba el almacenamiento y crecia sin techo: este cache solo se limpia al subir de
  // version, asi que cada tile que el usuario mirara al pasar quedaba guardado para siempre.
  // Lo mismo vale para las teselas de elevacion Terrarium del 3D (s3.amazonaws.com): las
  // administra el modulo v3d* en su propia cache 'geonotas-dem'. NO agregar una rama aca para
  // ellas: seria el mismo almacenamiento duplicado que se evito con los tiles satelitales.
  const u=new URL(req.url);
  if(u.origin!==self.location.origin){
    if(esCesium(u)){
      e.respondWith(caches.open(CESIUM_CACHE).then(c=>c.match(req).then(r=>r||fetch(req).then(resp=>{
        // se guarda tambien la respuesta opaque (status 0): index.html inyecta Cesium.js con
        // crossorigin="anonymous" para que la mayoria llegue como 'cors' e inspeccionable, pero
        // los subrecursos que Cesium pide solo se guardan asi. Sin esto no habria 3D offline.
        if(resp.ok||resp.type==='opaque'){const cp=resp.clone();c.put(req,cp);}
        return resp;
      }))));
    }
    return;
  }
  const esDoc = req.mode==='navigate' || req.destination==='document' || req.url.endsWith('/') || req.url.endsWith('index.html');
  if(esDoc){   // network-first para el HTML: siempre la última versión estando en línea
    // solo se cachea si resp.ok: un 404 (ej. deploy a medio subir) quedaba cacheado para
    // siempre y la app seguía rota offline hasta la próxima versión de CACHE.
    e.respondWith(fetch(req).then(resp=>{if(resp.ok){const cp=resp.clone();caches.open(CACHE).then(c=>c.put(req,cp));}return resp;})
      .catch(()=>caches.match(req).then(r=>r||caches.match('./index.html'))));
    return;
  }
  // cache-first para assets. Sin fallback a index.html: devolver el HTML cuando falla una
  // imagen o un .wasm no arregla nada y disfraza el error real de un fallo de red.
  e.respondWith(caches.match(req).then(r=>r||fetch(req).then(resp=>{
    // mismo criterio que la rama de documento: no cachear respuestas con error.
    if(resp.ok){const cp=resp.clone();caches.open(CACHE).then(c=>c.put(req,cp));}return resp;
  })));});
