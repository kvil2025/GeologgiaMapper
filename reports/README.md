# 📄 GeoINducta — Procesador Diario de Campaña

Script Python que corre en **Google Colab** (gratis, sin instalación).

## Flujo de trabajo

```
📱 Campo              ☁️ Drive              💻 Colab (browser)
──────────            ──────────            ──────────────────
Registras puntos  →  ZIP exportado  →  Abres informe_diario.py
Audios de campo                         Run All (~5 min)
Fotos                                       ↓
                                     📄 Informe HTML en Drive
```

## Qué genera el informe

| Sección | Contenido |
|---|---|
| 🗺️ Mapa | Puntos del día con popups (satelital + topo + calles) |
| 📊 Estadísticas | Rocas, horizontes, estructuras, mineralización |
| 📋 Tabla | Todas las muestras del día con UTM |
| 🎙️ Transcripciones | Audios de campo transcritos con Whisper |
| 📷 Fotos | Galería con ubicación y datos de cada muestra |

## Cómo usarlo

### 1. Exportar desde la app
En GeoINducta → botón **☁️ Drive** → sincronizar el ZIP

### 2. Abrir en Colab
1. Ve a [colab.research.google.com](https://colab.research.google.com)
2. **File → Upload notebook** → sube `informe_diario.py`  
   *(o copia el contenido en un notebook nuevo)*

### 3. Configurar (solo una línea)
```python
FECHA_FILTRO = '2026-06-03'   # Fecha del día que quieres procesar
                               # None = campaña completa
```

### 4. Run All
**Runtime → Run all** → espera ~5 minutos → informe listo en Drive

## Costos

| Servicio | Costo |
|---|---|
| Google Colab | **$0** (gratis) |
| Whisper (transcripción) | **$0** (corre localmente en Colab) |
| Nominatim (geocodificación) | **$0** (OpenStreetMap) |
| Google Drive | **$0** (tu cuenta existente) |
| **TOTAL** | **$0** |

## Opciones de Whisper

| Modelo | Velocidad | Calidad | RAM |
|---|---|---|---|
| `tiny` | ⚡⚡⚡ | ⭐⭐ | 1 GB |
| `base` *(recomendado)* | ⚡⚡ | ⭐⭐⭐ | 1 GB |
| `small` | ⚡ | ⭐⭐⭐⭐ | 2 GB |
| `medium` | 🐢 | ⭐⭐⭐⭐⭐ | 5 GB |

## Carpeta de salida en Drive

```
MyDrive/
└── GeoINducta/
    └── Informes/
        ├── Informe_GeoINducta_20260602.html
        ├── Informe_GeoINducta_20260603.html
        └── ...
```

Abre el HTML en tu navegador y usa **Ctrl+P → Guardar como PDF** para el informe final.
