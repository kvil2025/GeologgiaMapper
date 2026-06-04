"""
GeoINducta — QGIS Plugin (Carga rápida)
========================================
Pega este script en la Consola Python de QGIS:
  Complementos → Consola Python → Pegar y ejecutar

QUÉ HACE:
  - Carga el GeoJSON de muestras como capa vectorial
  - Aplica estilo por tipo de roca caja (colores por categoría)
  - Centra el mapa en los puntos

CÓMO USAR:
  1. Exporta tu campaña desde GeoINducta (ZIP o solo GeoJSON)
  2. Abre QGIS y abre la Consola Python (Ctrl+Alt+P)
  3. Cambia GEOJSON_PATH a la ruta de tu archivo
  4. Ejecuta el script

REQUIERE: QGIS 3.x (testado en 3.28+)
"""

import os
from qgis.core import (
    QgsVectorLayer, QgsProject, QgsCategorizedSymbolRenderer,
    QgsRendererCategory, QgsMarkerSymbol, QgsStyle,
    QgsSymbol, QgsSingleSymbolRenderer
)
from qgis.utils import iface
from PyQt5.QtGui import QColor

# ══════════════════════════════════════════════════════════
# ⚙️ CONFIGURACIÓN — cambia solo esta línea
GEOJSON_PATH = r"C:\Users\TuUsuario\Downloads\muestras.geojson"
# ══════════════════════════════════════════════════════════

# Colores por tipo de roca (deben coincidir con la app)
ROCA_COLORS = {
    'Granodiorita':   '#EF4444',
    'Tonalita':       '#F97316',
    'Granito':        '#8B5CF6',
    'Pórfido Q-Fsp':  '#EC4899',
    'Andesita':       '#6366F1',
    'Brecha':         '#F59E0B',
    'Skarn':          '#10B981',
    'Mármol':         '#06B6D4',
    'Cuarcita':       '#84CC16',
    'Metapelita':     '#14B8A6',
    'Otro':           '#94A3B8',
}
DEFAULT_COLOR = '#D4AF37'


def load_geoinducta(geojson_path):
    if not os.path.exists(geojson_path):
        iface.messageBar().pushCritical(
            "GeoINducta", f"Archivo no encontrado: {geojson_path}"
        )
        return

    # Cargar capa
    layer = QgsVectorLayer(geojson_path, "GeoINducta Muestras", "ogr")
    if not layer.isValid():
        iface.messageBar().pushCritical("GeoINducta", "No se pudo cargar el GeoJSON")
        return

    # Crear categorías por ROCA CAJA
    field_name = "ROCA CAJA"
    categories = []

    # Obtener valores únicos
    idx = layer.fields().indexFromName(field_name)
    unique_values = layer.uniqueValues(idx) if idx >= 0 else []

    for roca in unique_values:
        color_hex = ROCA_COLORS.get(str(roca), DEFAULT_COLOR)

        symbol = QgsMarkerSymbol.createSimple({
            'name': 'circle',
            'color': color_hex,
            'color_border': '#ffffff',
            'size': '4',
            'outline_width': '0.5',
        })

        cat = QgsRendererCategory(roca, symbol, str(roca) or '(sin datos)')
        categories.append(cat)

    # Categoría para valores no mapeados
    if not categories:
        symbol = QgsMarkerSymbol.createSimple({
            'name': 'circle', 'color': DEFAULT_COLOR,
            'color_border': '#ffffff', 'size': '4'
        })
        renderer = QgsSingleSymbolRenderer(symbol)
    else:
        renderer = QgsCategorizedSymbolRenderer(field_name, categories)

    layer.setRenderer(renderer)

    # Etiquetas: mostrar CP
    from qgis.core import QgsPalLayerSettings, QgsVectorLayerSimpleLabeling, QgsTextFormat
    from PyQt5.QtGui import QFont

    label_settings = QgsPalLayerSettings()
    label_settings.fieldName = 'CP'
    label_settings.enabled = True

    text_format = QgsTextFormat()
    text_format.setFont(QFont('Inter', 8))
    text_format.setColor(QColor('#D4AF37'))
    text_format.setSize(8)
    label_settings.setFormat(text_format)

    labeling = QgsVectorLayerSimpleLabeling(label_settings)
    layer.setLabelsEnabled(True)
    layer.setLabeling(labeling)

    # Agregar al proyecto y centrar
    QgsProject.instance().addMapLayer(layer)
    iface.mapCanvas().setExtent(layer.extent())
    iface.mapCanvas().refresh()

    # Mensaje de éxito
    n = layer.featureCount()
    iface.messageBar().pushSuccess(
        "GeoINducta", f"✅ {n} muestras cargadas con estilo por roca caja"
    )
    print(f"[GeoINducta] {n} muestras | Colores por ROCA CAJA | Labels: CP")


# Ejecutar
load_geoinducta(GEOJSON_PATH)
