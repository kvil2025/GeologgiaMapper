#!/usr/bin/env python3
"""
╔══════════════════════════════════════════════════════════════════════╗
║         GeoINducta — Procesador Diario de Campaña v1.0              ║
║         Corre en Google Colab (colab.research.google.com)            ║
╠══════════════════════════════════════════════════════════════════════╣
║  FLUJO:                                                              ║
║  1. App móvil exporta ZIP → Google Drive                            ║
║  2. Abre este script en Colab (File → Upload notebook)              ║
║  3. Ejecuta Run All → informe HTML listo en tu Drive                ║
╚══════════════════════════════════════════════════════════════════════╝

QUÉ GENERA:
  ✅ Mapa interactivo de todos los puntos del día
  ✅ Estadísticas: rocas, horizontes, estructuras, mineralización
  ✅ Transcripción automática de audios de campo (Whisper)
  ✅ Geocodificación inversa (lugares cercanos a cada punto)
  ✅ Galería de fotos con coordenadas UTM
  ✅ Tabla completa de muestras
  ✅ Informe HTML guardado en Google Drive
"""

# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 1 — INSTALAR DEPENDENCIAS (puede tardar 2-3 min la primera vez)
# ═══════════════════════════════════════════════════════════════════════════════
import subprocess, sys
pkgs = ['openai-whisper', 'folium', 'geopy', 'Pillow', 'pandas']
subprocess.run([sys.executable, '-m', 'pip', 'install', *pkgs, '-q'], check=True)
print("✅ Dependencias instaladas")


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 2 — IMPORTS Y MONTAR DRIVE
# ═══════════════════════════════════════════════════════════════════════════════
import os, zipfile, json, base64, time, io
from datetime import datetime, date
from pathlib import Path

import pandas as pd
import whisper
import folium
from folium.plugins import MarkerCluster
from geopy.geocoders import Nominatim
from PIL import Image

try:
    from google.colab import drive
    drive.mount('/content/drive')
    IN_COLAB = True
    print("✅ Google Drive montado")
except ImportError:
    IN_COLAB = False
    print("⚠️  No estás en Colab — ajusta las rutas manualmente")


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 3 — ⚙️ CONFIGURACIÓN  (solo edita esta sección)
# ═══════════════════════════════════════════════════════════════════════════════
DRIVE_ROOT    = '/content/drive/MyDrive'           # Raíz de tu Drive
ZIP_PATTERN   = 'geoinducta'                        # Parte del nombre del ZIP
FECHA_FILTRO  = str(date.today())                   # 'YYYY-MM-DD' o None = campaña completa
WHISPER_MODEL = 'base'                              # tiny|base|small|medium|large
AUDIO_LANG    = 'es'                               # Idioma de los audios
OUTPUT_DIR    = f'{DRIVE_ROOT}/GeoINducta/Informes' # Carpeta de salida


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 4 — ENCONTRAR Y EXTRAER EL ZIP
# ═══════════════════════════════════════════════════════════════════════════════
def find_latest_zip(root, pattern):
    candidates = list(Path(root).rglob('*.zip'))
    matches = [f for f in candidates if pattern.lower() in f.name.lower()]
    if not matches:
        raise FileNotFoundError(
            f"No se encontró ningún ZIP con '{pattern}' en {root}\n"
            f"Asegúrate de haber exportado desde la app y sincronizado con Drive."
        )
    latest = max(matches, key=lambda f: f.stat().st_mtime)
    print(f"📦 ZIP encontrado: {latest.name}  ({latest.stat().st_size // 1024} KB)")
    return str(latest)

EXTRACT_DIR = '/content/geoinducta_data'
os.makedirs(EXTRACT_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

zip_path = find_latest_zip(DRIVE_ROOT, ZIP_PATTERN)
with zipfile.ZipFile(zip_path, 'r') as z:
    z.extractall(EXTRACT_DIR)
    total = len(z.namelist())

print(f"✅ Extraídos {total} archivos → {EXTRACT_DIR}")


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 5 — PARSEAR DATOS TSV + GEOJSON
# ═══════════════════════════════════════════════════════════════════════════════
tsv_path = os.path.join(EXTRACT_DIR, 'muestras.tsv')
if not os.path.exists(tsv_path):
    raise FileNotFoundError(f"No se encontró muestras.tsv en el ZIP")

df_all = pd.read_csv(tsv_path, sep='\t', encoding='utf-8', dtype=str).fillna('')

if FECHA_FILTRO:
    df = df_all[df_all['Fecha'].astype(str).str.startswith(FECHA_FILTRO)].copy()
    print(f"📅 Fecha {FECHA_FILTRO}: {len(df)} muestras en {df['CP'].nunique()} puntos")
else:
    df = df_all.copy()
    print(f"📊 Campaña completa: {len(df)} muestras en {df['CP'].nunique()} puntos")

if len(df) == 0:
    raise ValueError(
        f"No hay muestras para la fecha {FECHA_FILTRO}.\n"
        f"Cambia FECHA_FILTRO o ponlo en None para ver toda la campaña."
    )

geojson_path = os.path.join(EXTRACT_DIR, 'muestras.geojson')
with open(geojson_path, encoding='utf-8') as f:
    geojson = json.load(f)

print(f"🗺️  GeoJSON cargado: {len(geojson['features'])} features")


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 6 — 🎙️ TRANSCRIPCIÓN DE AUDIOS CON WHISPER
# ═══════════════════════════════════════════════════════════════════════════════
audio_dir = os.path.join(EXTRACT_DIR, 'audios')
transcriptions = {}
AUDIO_EXTS = {'.webm', '.mp3', '.wav', '.ogg', '.m4a', '.opus'}

if os.path.exists(audio_dir):
    audio_files = [f for f in Path(audio_dir).iterdir() if f.suffix.lower() in AUDIO_EXTS]

    if audio_files:
        print(f"🎙️  Cargando modelo Whisper '{WHISPER_MODEL}'...")
        wmodel = whisper.load_model(WHISPER_MODEL)
        print(f"✅ Modelo listo — transcribiendo {len(audio_files)} audio(s)...")

        for af in audio_files:
            print(f"  ▶ {af.name} ...", end=' ', flush=True)
            try:
                result = wmodel.transcribe(str(af), language=AUDIO_LANG, verbose=False)
                text = result['text'].strip()
                # Intenta extraer el CP del nombre: audio_CP-20_1234.webm → CP-20
                stem = af.stem.replace('audio_', '')
                key = stem.split('_')[0] if '_' in stem else stem
                transcriptions[key] = text
                print(f"✅  ({len(text)} chars)")
            except Exception as e:
                print(f"❌ Error: {e}")

        print(f"\n🎙️  {len(transcriptions)} audios transcritos con éxito")
    else:
        print("ℹ️  No hay archivos de audio en el ZIP")
else:
    print("ℹ️  Carpeta 'audios/' no encontrada en el ZIP")


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 7 — 📍 GEOCODIFICACIÓN INVERSA (Nominatim / OpenStreetMap — GRATIS)
# ═══════════════════════════════════════════════════════════════════════════════
geolocator = Nominatim(user_agent="geoinducta-report-v1", timeout=10)

def reverse_geocode(lat, lng, retries=3):
    for attempt in range(retries):
        try:
            loc = geolocator.reverse(f"{lat},{lng}", language='es', exactly_one=True)
            if not loc:
                return ''
            a = loc.raw.get('address', {})
            return (a.get('village') or a.get('hamlet') or a.get('town') or
                    a.get('municipality') or a.get('county') or
                    a.get('state', ''))
        except Exception:
            time.sleep(2 ** attempt)
    return ''

# Construir dict de puntos desde GeoJSON filtrando por fecha
cps_del_dia = set(df['CP'].dropna().unique())
points = {}

print(f"📍 Geocodificando {len(cps_del_dia)} puntos...")
for feat in geojson['features']:
    cp = feat['properties'].get('CP', '')
    if cp not in cps_del_dia or cp in points:
        continue
    lat = feat['geometry']['coordinates'][1]
    lng = feat['geometry']['coordinates'][0]
    points[cp] = {
        'lat':      lat,
        'lng':      lng,
        'easting':  feat['properties'].get('UTM_ESTE', ''),
        'northing': feat['properties'].get('UTM_NORTE', ''),
        'zona':     feat['properties'].get('UTM_ZONA', ''),
    }
    place = reverse_geocode(lat, lng)
    points[cp]['place'] = place
    print(f"  📍 {cp}: {place or '(sin nombre cercano)'}")
    time.sleep(1.2)  # Respetar rate limit de Nominatim (1 req/s)

print(f"✅ {len(points)} puntos geocodificados")


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 8 — 🗺️ GENERAR MAPA CON FOLIUM
# ═══════════════════════════════════════════════════════════════════════════════
lats = [v['lat'] for v in points.values()]
lngs = [v['lng'] for v in points.values()]
center = [sum(lats) / len(lats), sum(lngs) / len(lngs)]

m = folium.Map(location=center, zoom_start=14,
               tiles='https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
               attr='Google Satellite')

# Capa adicional OpenTopoMap
folium.TileLayer('OpenTopoMap', name='Topo').add_to(m)
folium.TileLayer('OpenStreetMap', name='Calles').add_to(m)
folium.LayerControl().add_to(m)

cluster = MarkerCluster(name='Muestras').add_to(m)

for cp, info in sorted(points.items()):
    muestras_cp = df[df['CP'] == cp]
    samples_rows = ''.join([
        f"<tr><td style='padding:3px 6px'>{r.get('IDSAMPLE','')}</td>"
        f"<td style='padding:3px 6px'>{r.get('ROCA CAJA','')}</td>"
        f"<td style='padding:3px 6px'>{r.get('HORIZONTE','')}</td></tr>"
        for _, r in muestras_cp.iterrows()
    ])
    popup_html = f"""
    <div style='font-family:sans-serif;min-width:220px;font-size:12px'>
      <b style='color:#B91C1C;font-size:14px'>{cp}</b><br>
      <span style='color:#666'>📍 {info.get('place','')}</span><br>
      <span style='color:#888;font-size:11px'>E:{info['easting']} N:{info['northing']} {info['zona']}</span>
      <table style='margin-top:8px;width:100%;border-collapse:collapse'>
        <tr style='background:#f5f5f5'><th style='padding:3px 6px'>Sample</th><th>Roca</th><th>Horizonte</th></tr>
        {samples_rows}
      </table>
      {'<p style="color:#333;margin-top:8px;font-style:italic;font-size:11px">🎙️ ' + transcriptions[cp][:150] + '...</p>' if cp in transcriptions else ''}
    </div>"""

    folium.Marker(
        location=[info['lat'], info['lng']],
        popup=folium.Popup(popup_html, max_width=300),
        tooltip=f"<b>{cp}</b> — {info.get('place','')[:30]}",
        icon=folium.Icon(color='red', icon='flask', prefix='fa')
    ).add_to(cluster)

map_html_str = m._repr_html_()
print(f"🗺️  Mapa generado con {len(points)} puntos")


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 9 — 📊 ESTADÍSTICAS
# ═══════════════════════════════════════════════════════════════════════════════
def top_vals(col, n=6):
    return df[col].replace('', pd.NA).dropna().value_counts().head(n).to_dict()

stats = {
    'fecha':          FECHA_FILTRO or 'Campaña completa',
    'total_puntos':   len(points),
    'total_muestras': len(df),
    'total_audios':   len(transcriptions),
    'responsables':   ', '.join(df['TAKEN BY'].replace('', pd.NA).dropna().unique()),
    'semana':         ', '.join(df['SEMANA'].replace('', pd.NA).dropna().unique()),
    'rango_cp':       f"{df['CP'].iloc[0]} → {df['CP'].iloc[-1]}",
    'rango_sample':   f"{df['IDSAMPLE'].iloc[0]} → {df['IDSAMPLE'].iloc[-1]}",
    'rocas':          top_vals('ROCA CAJA'),
    'horizontes':     top_vals('HORIZONTE'),
    'estructuras':    top_vals('ESTRUCTURA'),
    'mineralizacion': top_vals('MINERALIZACION'),
    'alteraciones':   top_vals('ALTERACION'),
}

print("📊 Estadísticas calculadas:")
for k, v in stats.items():
    if isinstance(v, dict):
        print(f"  {k}: {dict(list(v.items())[:3])}")
    else:
        print(f"  {k}: {v}")


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 10 — 📄 GENERAR INFORME HTML
# ═══════════════════════════════════════════════════════════════════════════════
def img_b64(path, max_px=(400, 300)):
    try:
        img = Image.open(path).convert('RGB')
        img.thumbnail(max_px, Image.LANCZOS)
        buf = io.BytesIO()
        img.save(buf, 'JPEG', quality=72)
        return base64.b64encode(buf.getvalue()).decode()
    except Exception:
        return None

# Cargar fotos
foto_dir = os.path.join(EXTRACT_DIR, 'fotos')
fotos = {}
if os.path.exists(foto_dir):
    for f in sorted(Path(foto_dir).iterdir()):
        if f.suffix.lower() in {'.jpg', '.jpeg', '.png', '.webp'}:
            b64 = img_b64(str(f))
            if b64:
                fotos[f.stem] = b64
print(f"📷 {len(fotos)} fotos cargadas")


def bar_chart(data):
    if not data:
        return '<p style="color:#555;font-size:12px">Sin datos</p>'
    total = sum(data.values()) or 1
    colors = ['#B91C1C', '#D4AF37', '#1D4ED8', '#059669', '#7C3AED', '#EA580C']
    html = ''
    for i, (k, v) in enumerate(data.items()):
        pct = round(v / total * 100)
        html += f"""
        <div style="margin-bottom:10px">
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#ccc">
            <span>{k or '—'}</span>
            <span style="color:#888">{v} ({pct}%)</span>
          </div>
          <div style="background:#1a1a1a;border-radius:4px;height:8px;margin-top:4px">
            <div style="background:{colors[i % len(colors)]};width:{pct}%;height:8px;border-radius:4px;transition:width 0.5s"></div>
          </div>
        </div>"""
    return html


def build_transcriptions():
    if not transcriptions:
        return '<p style="color:#555;font-style:italic;font-size:13px">No hay audios transcritos para este período.</p>'
    html = ''
    for cp in sorted(transcriptions):
        text = transcriptions[cp]
        info = points.get(cp, {})
        html += f"""
        <div style="background:#0f0f10;border-left:3px solid #D4AF37;padding:16px 20px;margin-bottom:14px;border-radius:0 10px 10px 0">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;flex-wrap:wrap;gap:6px">
            <span style="color:#D4AF37;font-weight:700;font-size:15px">{cp}</span>
            <span style="color:#555;font-size:11px">E:{info.get('easting','')} N:{info.get('northing','')} {info.get('zona','')}</span>
          </div>
          {f'<div style="color:#888;font-size:12px;margin-bottom:8px">📍 {info.get("place","")}</div>' if info.get('place') else ''}
          <p style="color:#ccc;font-size:13px;line-height:1.7;margin:0">{text}</p>
        </div>"""
    return html


def build_photos():
    if not fotos:
        return '<p style="color:#555;font-style:italic;font-size:13px">No hay fotografías disponibles.</p>'
    html = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px">'
    for name, b64 in fotos.items():
        cp = name.split('_')[0] if '_' in name else ''
        info = points.get(cp, {})
        muestra_data = df[df['CP'] == cp].iloc[0] if cp and len(df[df['CP'] == cp]) > 0 else {}
        roca = muestra_data.get('ROCA CAJA', '') if hasattr(muestra_data, 'get') else ''
        html += f"""
        <div style="background:#111;border-radius:10px;overflow:hidden;border:1px solid #1e1e1e">
          <img src="data:image/jpeg;base64,{b64}" style="width:100%;height:160px;object-fit:cover">
          <div style="padding:10px 12px">
            <div style="color:#D4AF37;font-weight:600;font-size:12px;margin-bottom:3px">{name}</div>
            {f'<div style="color:#e5e5e5;font-size:12px">{roca}</div>' if roca else ''}
            {f'<div style="color:#888;font-size:11px;margin-top:2px">📍 {info.get("place","")}</div>' if info.get('place') else ''}
            <div style="color:#555;font-size:10px;margin-top:3px">E:{info.get('easting','')} N:{info.get('northing','')}</div>
          </div>
        </div>"""
    return html + '</div>'


def build_table():
    rows = ''
    for _, r in df.iterrows():
        cp   = r.get('CP', '')
        info = points.get(cp, {})
        rows += f"""<tr>
          <td><span style="color:#D4AF37;font-weight:600">{cp}</span></td>
          <td>{r.get('IDSAMPLE','')}</td>
          <td>{r.get('ROCA CAJA','')}</td>
          <td>{r.get('HORIZONTE','')}</td>
          <td>{r.get('ESTRUCTURA','')}</td>
          <td>{info.get('easting','')}</td>
          <td>{info.get('northing','')}</td>
          <td>{info.get('zona','')}</td>
          <td style="color:#888;max-width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">{r.get('COMENTARIO','')}</td>
        </tr>"""
    return rows


# HTML completo
generated_at = datetime.now().strftime('%d/%m/%Y %H:%M')
REPORT = f"""<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>GeoINducta — Informe {stats['fecha']}</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *{{box-sizing:border-box;margin:0;padding:0}}
    body{{background:#0a0a0b;color:#e5e5e5;font-family:'Inter',sans-serif;line-height:1.6}}
    .header{{background:linear-gradient(135deg,#0f0f10,#1a0505);border-bottom:1px solid #B91C1C33;padding:32px 40px}}
    .header h1{{font-size:26px;font-weight:700;color:#fff;display:flex;align-items:center;gap:12px}}
    .header h1 .geo{{color:#B91C1C}}.header h1 .in{{color:#D4AF37}}
    .meta{{color:#666;font-size:13px;margin-top:8px}}
    .container{{max-width:1280px;margin:0 auto;padding:32px 24px}}
    .section{{margin-bottom:44px}}
    .section-title{{font-size:13px;font-weight:600;color:#D4AF37;text-transform:uppercase;letter-spacing:.1em;border-bottom:1px solid #1e1e1e;padding-bottom:10px;margin-bottom:20px}}
    .cards{{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:14px;margin-bottom:28px}}
    .card{{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:20px;text-align:center;transition:border-color .2s}}
    .card:hover{{border-color:#D4AF3766}}
    .card-num{{font-size:36px;font-weight:700;color:#D4AF37;line-height:1}}
    .card-label{{font-size:11px;color:#666;margin-top:6px;text-transform:uppercase;letter-spacing:.05em}}
    .info-row{{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:24px;padding:16px 20px;background:#111;border-radius:10px;border:1px solid #1e1e1e}}
    .info-item{{font-size:13px;color:#888}}.info-item strong{{color:#e5e5e5}}
    .stats-grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:18px}}
    .stat-box{{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:20px}}
    .stat-box h3{{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.08em;margin-bottom:16px}}
    .map-wrap{{border-radius:12px;overflow:hidden;border:1px solid #1e1e1e;height:480px}}
    .map-wrap iframe{{width:100%;height:100%;border:none}}
    table{{width:100%;border-collapse:collapse;font-size:12px}}
    thead th{{background:#111;color:#D4AF37;padding:10px 14px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.06em;position:sticky;top:0}}
    tbody tr:hover{{background:#0f0f10}}
    td{{padding:9px 14px;color:#ccc;border-bottom:1px solid #111}}
    .table-wrap{{background:#0a0a0b;border:1px solid #1e1e1e;border-radius:12px;overflow:auto;max-height:500px}}
    @media print{{.map-wrap{{height:350px}}.table-wrap{{max-height:none}}}}
  </style>
</head>
<body>
<div class="header">
  <h1>🪨 <span class="geo">Geo</span><span class="in">IN</span>ducta — Informe de Campaña</h1>
  <div class="meta">Generado automáticamente · {generated_at} · GeoINducta Daily Processor v1.0</div>
</div>

<div class="container">

  <!-- INFO GENERAL -->
  <div class="section">
    <div class="info-row">
      <div class="info-item">📅 <strong>{stats['fecha']}</strong></div>
      <div class="info-item">👤 <strong>{stats['responsables'] or '—'}</strong></div>
      <div class="info-item">📋 Semana <strong>{stats['semana'] or '—'}</strong></div>
      <div class="info-item">🔢 CP: <strong>{stats['rango_cp']}</strong></div>
      <div class="info-item">🔬 Sample: <strong>{stats['rango_sample']}</strong></div>
    </div>
    <div class="cards">
      <div class="card"><div class="card-num">{stats['total_puntos']}</div><div class="card-label">Puntos CP</div></div>
      <div class="card"><div class="card-num">{stats['total_muestras']}</div><div class="card-label">Muestras</div></div>
      <div class="card"><div class="card-num">{stats['total_audios']}</div><div class="card-label">Audios</div></div>
      <div class="card"><div class="card-num">{len(fotos)}</div><div class="card-label">Fotos</div></div>
    </div>
  </div>

  <!-- MAPA -->
  <div class="section">
    <div class="section-title">🗺️ Mapa de Puntos Visitados</div>
    <div class="map-wrap">{map_html_str}</div>
  </div>

  <!-- ESTADÍSTICAS -->
  <div class="section">
    <div class="section-title">📊 Estadísticas del Día</div>
    <div class="stats-grid">
      <div class="stat-box"><h3>Roca Caja</h3>{bar_chart(stats['rocas'])}</div>
      <div class="stat-box"><h3>Horizonte</h3>{bar_chart(stats['horizontes'])}</div>
      <div class="stat-box"><h3>Estructura</h3>{bar_chart(stats['estructuras'])}</div>
      <div class="stat-box"><h3>Mineralización</h3>{bar_chart(stats['mineralizacion'])}</div>
    </div>
  </div>

  <!-- TABLA DE MUESTRAS -->
  <div class="section">
    <div class="section-title">📋 Tabla de Muestras</div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>CP</th><th>IDSAMPLE</th><th>ROCA CAJA</th><th>HORIZONTE</th>
          <th>ESTRUCTURA</th><th>UTM Este</th><th>UTM Norte</th><th>Zona</th><th>Comentario</th>
        </tr></thead>
        <tbody>{build_table()}</tbody>
      </table>
    </div>
  </div>

  <!-- TRANSCRIPCIONES -->
  <div class="section">
    <div class="section-title">🎙️ Notas de Campo — Transcripciones de Audio</div>
    {build_transcriptions()}
  </div>

  <!-- FOTOGRAFÍAS -->
  <div class="section">
    <div class="section-title">📷 Galería de Fotografías</div>
    {build_photos()}
  </div>

</div>
</body>
</html>"""


# ═══════════════════════════════════════════════════════════════════════════════
# CELDA 11 — 💾 GUARDAR EN DRIVE
# ═══════════════════════════════════════════════════════════════════════════════
fecha_str = (FECHA_FILTRO or 'campaña').replace('-', '')
report_name = f"Informe_GeoINducta_{fecha_str}.html"
report_path = os.path.join(OUTPUT_DIR, report_name)

with open(report_path, 'w', encoding='utf-8') as f:
    f.write(REPORT)

size_kb = os.path.getsize(report_path) // 1024
print(f"""
╔════════════════════════════════════════════════════════════╗
║  ✅  INFORME GENERADO CON ÉXITO                            ║
╠════════════════════════════════════════════════════════════╣
║  📄 Archivo : {report_name:<44} ║
║  📁 Ruta    : GeoINducta/Informes/                         ║
║  💾 Tamaño  : {str(size_kb) + ' KB':<44} ║
╠════════════════════════════════════════════════════════════╣
║  Abre el archivo HTML en tu navegador para                 ║
║  ver el informe completo. Puedes imprimirlo                ║
║  como PDF desde el navegador (Ctrl+P → PDF)               ║
╚════════════════════════════════════════════════════════════╝
""")
