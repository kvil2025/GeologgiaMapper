# SMASH → GeoINducta: Documento de Referencia

> Fecha: 2026-05-30  
> Este documento registra todas las funcionalidades de SMASH (app Flutter original)  
> y define cómo se implementarán en GeoINducta (app web PWA con stack Google).

---

## SMASH — Funcionalidades Originales (Flutter/Dart)

### App
- **Nombre**: SMASH — Smart Mobile App for the Surveyor's Happiness
- **Versión**: 1.11.0+83
- **Plataformas**: Android, iOS, macOS (desktop)
- **Licencia**: GPL3
- **Autor**: Antonello Andrea / hydrologis.com

### Mapas
- flutter_map + Mapsforge (tiles offline .map y .mbtiles)
- Tiles online: OSM, OpenTopoMap, WMS
- GPS tracking en tiempo real
- Waypoints con marcadores, colores, fotos, audio y formularios JSON
- Bookmarks de ubicaciones
- Clustering de marcadores (flutter_map_marker_cluster)
- Editor de líneas y polígonos en el mapa

### Base de Datos — GeoPackage (.gpkg)
- SQLite/GeoPackage estándar OGC
- Tabla NOTES: puntos con texto, color, ícono, formulario JSON
- Tabla IMAGES: fotos vinculadas a notas (blob)
- Tabla AUDIOS: grabaciones vinculadas a notas
- Tabla GPSLOGS: trayectorias GPS
- Tabla BOOKMARKS: ubicaciones guardadas
- Geometrías vectoriales en capas separadas

### Formulario Geológico (custom, desarrollado en este proyecto)
- Panel bottom sheet con glassmorphism (blur backdrop)
- Litología: Ígnea / Sedimentaria / Metamórfica / Aluvión
- Estructura: Falla / Diaclasa / Foliación / Veta
- Rumbo (Strike): 0–360°
- Buzamiento (Dip): 0–90°
- Botón mic con estado blink para grabación activa
- UI glove-friendly (botones grandes 56px de alto)
- Colores: fondo #0A0A0B, acento rojo #B91C1C, dorado #D4AF37

### Audio
- Grabación via plugin `record` (record_darwin en iOS/macOS)
- Vinculación automática a estación activa
- Renombrado por estación + timestamp en exportación

### Exportación — "Paquete de Campaña Geológica"
- ZIP con: estaciones (JSON/CSV), audios renombrados, fotos, track GPX
- Plugin: `CampaignExportPlugin` en `smash_import_export_plugins`
- Título: "Paquete de Campaña Geológica"

### Importación
- GPX, GeoJSON, KMZ/KML, WMS/WFS, PostGIS, GeoPackage externo

### Conectividad
- GEOPAPARAZZI Cloud / SMASHCloud
- Bluetooth (sensores GPS externos, flutter_blue_plus)
- Background GPS (background_locator_2)

### UI/UX
- Dark mode por defecto
- Fuente: OpenSans
- Paleta: rojo #B91C1C (primary), dorado #D4AF37 (accent), fondo #0A0A0B
- Glassmorphism en paneles
- Soporte 13 idiomas

### Dependencias clave
- flutter_map: ^8.1.1
- flutter_geopackage: ^0.6.3
- dart_hydrologis_db: ^1.1.0
- sqlite3_flutter_libs: ^0.5.39
- record: ^5.1.2
- background_locator_2 (git)
- flutter_blue_plus: ^1.31.0
- mapsforge_flutter: ^3.0.1
- dart_jts, dart_postgis, dart_shp
- fl_chart: ^1.0.0

---

## GeoINducta — Plan de Implementación Web

### Stack
```
Frontend:  React 18 + Vite (PWA)
Mapas:     Leaflet.js + OpenStreetMap tiles
DB cloud:  Firebase Firestore
DB local:  Dexie.js (IndexedDB) — offline
Archivos:  Firebase Storage
Auth:      Firebase Auth (Google Sign-in)
Hosting:   Firebase Hosting
IA:        Gemini API (análisis geológico)
Export:    JSZip + GeoJSON
PWA:       Workbox Service Worker
```

### Mapeo SMASH → Web
| SMASH | GeoINducta |
|---|---|
| GeoPackage SQLite | Firestore + IndexedDB |
| flutter_map | Leaflet.js |
| GPS nativo | Browser Geolocation API |
| record (audio) | MediaRecorder API → Firebase Storage |
| camera | MediaDevices.getUserMedia → Firebase Storage |
| background_locator | Geolocation watchPosition |
| ZIP export | JSZip |
| Mapsforge offline | Tile caching via Service Worker |
| PostGIS | Cloud Run + PostGIS (futuro) |

### Paleta de Colores
```css
--color-primary:   #B91C1C  /* Rojo geológico */
--color-accent:    #D4AF37  /* Dorado */
--color-bg:        #0A0A0B  /* Fondo base */
--color-surface:   #1E1E20  /* Cards */
--color-surface-2: #161618  /* Inputs */
--color-text:      #FFFFFF
--color-muted:     #8E8E93
--color-success:   #22C55E
```

### Estructura Firestore
```
users/{uid}
projects/{projectId}
  name, description, createdBy, createdAt, bounds
projects/{projectId}/stations/{stationId}
  lat, lng, litologia, estructura, rumbo, buzamiento
  notas, audioUrls[], photoUrls[], aiDescription
projects/{projectId}/tracks/{trackId}
  coordinates[{lat,lng,timestamp}], startedAt, endedAt
```

### Fases
- **v0.1 MVP**: Mapa + Auth + Proyectos + Formulario geológico + GPS
- **v0.2 Media**: Audio + Foto + Offline PWA + Export ZIP
- **v0.3 IA**: Gemini análisis litología + Track GPS + Import GeoJSON/GPX
