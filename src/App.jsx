import { useState, useEffect, useRef, useCallback } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMapEvents, useMap, ImageOverlay } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import localforage from 'localforage'
import imageCompression from 'browser-image-compression'
import { useGoogleLogin } from '@react-oauth/google'
import { GeoJSON } from 'react-leaflet'

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const TILE_LAYERS = {
  osm: {
    name: 'Calles', icon: '🗺️',
    url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap', maxZoom: 19,
  },
  topo: {
    name: 'Topográfico', icon: '🏔️',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenTopoMap', maxZoom: 17,
  },
  satellite: {
    name: 'Satelital', icon: '🛰️',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '© Esri', maxZoom: 19,
  },
}

// ─── BHP SAMPLE FORM CONSTANTS ───────────────────────────────────────────────
const SAMPLE_TYPES = [
  'Rock Chip', 'Soil', 'Stream Sed', 'Gossan', 'Float', 'Outcrop', 'Trench', 'Other'
]

const SAMPLE_COLLECTION = [
  'Grab', 'Channel', 'Composite', 'Chip', 'Rotary', 'Core', 'Other'
]

const CONTAMINATION_OPTS = ['None', 'Low', 'Medium', 'High']

// Colores por tipo de muestra
const SAMPLE_COLORS = {
  'Rock Chip':  '#EF4444',
  'Soil':       '#F59E0B',
  'Stream Sed': '#3B82F6',
  'Gossan':     '#EC4899',
  'Float':      '#8B5CF6',
  'Outcrop':    '#10B981',
  'Trench':     '#F97316',
  'Other':      '#94A3B8',
}

// ─── LEAFLET ICON FIX ────────────────────────────────────────────────────────
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl:       'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl:     'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
})

// 7. Colores por tipo de muestra
const ROCA_COLORS = SAMPLE_COLORS // alias para compatibilidad con el resto del código

const createStationIcon = (muestras) => {
  const tipo   = muestras[0]?.sampleType || ''
  const color  = SAMPLE_COLORS[tipo] || '#D4AF37'
  const count  = muestras.length
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:32px;height:32px;">
      <div style="width:28px;height:28px;border-radius:50% 50% 50% 0;
        background:${color};border:2.5px solid #fff;transform:rotate(-45deg);
        box-shadow:0 2px 8px rgba(0,0,0,0.5);"></div>
      ${count > 1 ? `<div style="position:absolute;top:-5px;right:-5px;
        width:17px;height:17px;border-radius:50%;background:#D4AF37;color:#000;
        font-size:9px;font-weight:800;display:flex;align-items:center;
        justify-content:center;font-family:Inter,sans-serif;">${count}</div>` : ''}
    </div>`,
    iconSize: [32, 32],
    iconAnchor: [14, 28],
  })
}

const gpsIcon = L.divIcon({
  className: '',
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#3B82F6;
    border:3px solid #fff;box-shadow:0 0 0 4px rgba(59,130,246,0.3);"></div>`,
  iconSize: [16, 16], iconAnchor: [8, 8],
})

// ─── HELPERS ─────────────────────────────────────────────────────────────────
// ─── SECURITY: uso de crypto.randomUUID() en lugar de Math.random() ────────
const generateId = () => crypto.randomUUID().replace(/-/g, '').substring(0, 9)

// ─── CORRELATIVOS ────────────────────────────────────────────────────────────────────────────
const parseCorrelativo = (str) => {
  if (!str) return null
  const match = str.match(/^(.*?)(\d+)$/)
  if (!match) return null
  return { prefix: match[1], num: parseInt(match[2], 10), padLength: match[2].length }
}

const nextCorrelativo = (str) => {
  const parsed = parseCorrelativo(str)
  if (!parsed) return str || ''
  const nextNum = parsed.num + 1
  // Mantiene el padding de ceros: "001" → "002", pero "9" → "10"
  const padded = parsed.padLength > 1
    ? String(nextNum).padStart(parsed.padLength, '0')
    : String(nextNum)
  return parsed.prefix + padded
}

// ─── CONVERSIÓN LAT/LNG → UTM WGS84 ──────────────────────────────────────────────────────────
const latLngToUTM = (lat, lng) => {
  const a   = 6378137.0
  const f   = 1 / 298.257223563
  const e2  = 2 * f - f * f
  const ep2 = e2 / (1 - e2)
  const k0  = 0.9996

  const latR = lat * Math.PI / 180
  const zone = Math.floor((lng + 180) / 6) + 1
  const lng0 = ((zone - 1) * 6 - 180 + 3) * Math.PI / 180

  const N = a / Math.sqrt(1 - e2 * Math.sin(latR) ** 2)
  const T = Math.tan(latR) ** 2
  const C = ep2 * Math.cos(latR) ** 2
  const A = Math.cos(latR) * ((lng * Math.PI / 180) - lng0)

  const M = a * (
    (1 - e2 / 4 - 3 * e2 ** 2 / 64 - 5 * e2 ** 3 / 256) * latR
    - (3 * e2 / 8 + 3 * e2 ** 2 / 32 + 45 * e2 ** 3 / 1024) * Math.sin(2 * latR)
    + (15 * e2 ** 2 / 256 + 45 * e2 ** 3 / 1024) * Math.sin(4 * latR)
    - (35 * e2 ** 3 / 3072) * Math.sin(6 * latR)
  )

  const easting = Math.round(
    k0 * N * (A + (1 - T + C) * A ** 3 / 6
      + (5 - 18 * T + T ** 2 + 72 * C - 58 * ep2) * A ** 5 / 120) + 500000
  )
  let northing = Math.round(
    k0 * (M + N * Math.tan(latR) * (
      A ** 2 / 2
      + (5 - T + 9 * C + 4 * C ** 2) * A ** 4 / 24
      + (61 - 58 * T + T ** 2 + 600 * C - 330 * ep2) * A ** 6 / 720
    ))
  )
  if (lat < 0) northing += 10000000

  const band = 'CDEFGHJKLMNPQRSTUVWXX'[Math.min(Math.floor((lat + 80) / 8), 20)]
  return { zone: `${zone}${band}`, zoneNum: zone, easting, northing }
}

const newMuestra = () => ({
  _id: generateId(),
  sampleId: '',
  surveyName: '', program: '', project: '',
  sampler: '', belt: '',
  sampleType: '', sampleCollection: '',
  standardId: '', sampleWeight: '', parentSampleId: '',
  contamination: 'None', anthropogenic: 'No',
  generalDescription: '',
  fotos: [],
  audioBlob: null,
})

const inputSt = {
  width: '100%', padding: '8px 10px', borderRadius: 8,
  background: '#111113', border: '1px solid rgba(255,255,255,0.1)',
  color: '#fff', fontSize: 13, fontFamily: 'Inter, sans-serif',
  outline: 'none', boxSizing: 'border-box',
}

const labelSt = {
  display: 'block', fontSize: 10, color: '#8E8E93',
  fontWeight: 600, letterSpacing: '0.08em', marginBottom: 4,
  fontFamily: 'Inter, sans-serif',
}

// ─── COMPONENTS ──────────────────────────────────────────────────────────────

// Modal para ingresar coordenadas de un PDF no georeferenciado
function PdfGeoreferenceModal({ name, imageUrl, onConfirm, onCancel }) {
  const [coords, setCoords] = useState({ north: '', south: '', east: '', west: '' })
  const set = (k, v) => setCoords(p => ({ ...p, [k]: v }))
  const valid = ['north','south','east','west'].every(k => coords[k] !== '' && !isNaN(+coords[k]))

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.88)', zIndex: 4000,
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
    }}>
      <div style={{
        background: '#111', borderRadius: 16, padding: 20, width: '100%', maxWidth: 420,
        border: '1px solid rgba(239,68,68,0.3)', fontFamily: 'Inter, sans-serif',
        display: 'flex', flexDirection: 'column', gap: 14,
        boxShadow: '0 24px 64px rgba(0,0,0,0.7)',
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: '#F87171', fontWeight: 700, fontSize: 14 }}>📄 Georreferenciar PDF</span>
          <button onClick={onCancel} style={{ background: 'none', border: 'none', color: '#666', fontSize: 20, cursor: 'pointer' }}>×</button>
        </div>

        <p style={{ color: '#888', fontSize: 11, lineHeight: 1.5 }}>
          El PDF <b style={{ color: '#ccc' }}>{name}</b> no tiene coordenadas embebidas.<br />
          Ingresa los límites geográficos de la imagen (WGS84):
        </p>

        {/* Preview miniatura */}
        <img src={imageUrl} alt="preview" style={{
          width: '100%', maxHeight: 140, objectFit: 'contain',
          borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', background: '#0a0a0b',
        }} />

        {/* Inputs de coordenadas */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          {[
            { key: 'north', label: '⬆️ Latitud Norte', placeholder: 'Ej: -29.500' },
            { key: 'south', label: '⬇️ Latitud Sur',  placeholder: 'Ej: -30.200' },
            { key: 'west',  label: '⬅️ Longitud Oeste', placeholder: 'Ej: -71.500' },
            { key: 'east',  label: '➡️ Longitud Este',  placeholder: 'Ej: -70.800' },
          ].map(({ key, label, placeholder }) => (
            <div key={key}>
              <div style={{ fontSize: 10, color: '#666', marginBottom: 4, fontWeight: 600 }}>{label}</div>
              <input
                type="number" step="any" value={coords[key]}
                onChange={e => set(key, e.target.value)}
                placeholder={placeholder}
                style={{
                  width: '100%', background: '#1a1a1c', border: '1px solid rgba(239,68,68,0.25)',
                  borderRadius: 8, color: '#fff', fontSize: 13, padding: '8px 10px', outline: 'none',
                  fontFamily: 'Inter, sans-serif',
                }}
              />
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={onCancel} style={{
            flex: 1, padding: '10px', borderRadius: 10, background: 'transparent',
            border: '1px solid rgba(255,255,255,0.1)', color: '#888', cursor: 'pointer',
            fontSize: 12, fontFamily: 'Inter, sans-serif',
          }}>Cancelar</button>
          <button disabled={!valid} onClick={() => onConfirm({
            north: +coords.north, south: +coords.south,
            east: +coords.east, west: +coords.west,
          })} style={{
            flex: 2, padding: '10px', borderRadius: 10, fontSize: 12, fontWeight: 700,
            background: valid ? 'rgba(239,68,68,0.15)' : 'rgba(255,255,255,0.03)',
            border: `1px solid ${valid ? 'rgba(239,68,68,0.5)' : 'rgba(255,255,255,0.08)'}`,
            color: valid ? '#F87171' : '#555',
            cursor: valid ? 'pointer' : 'not-allowed', fontFamily: 'Inter, sans-serif',
          }}>📌 Colocar en el mapa</button>
        </div>
      </div>
    </div>
  )
}

function GeoTiffLayer({ georaster }) {
  const map = useMap()
  useEffect(() => {
    if (!georaster) return
    let layer
    import('georaster-layer-for-leaflet').then(({ default: GeoRasterLayer }) => {
      try {
        layer = new GeoRasterLayer({
          georaster,
          opacity: 0.7,
          resolution: 256
        })
        layer.addTo(map)
        map.fitBounds(layer.getBounds())
      } catch (err) {
        console.error('Error renderizando GeoTIFF', err)
      }
    })
    return () => {
      if (layer) map.removeLayer(layer)
    }
  }, [georaster, map])
  return null
}

function GPSTracker({ onPosition }) {
  const map = useMap()
  
  useEffect(() => {
    map.locate({ setView: true, maxZoom: 16 })
  }, [map])

  useMapEvents({
    locationfound(e) { onPosition(e.latlng) },
    locationerror() { console.warn('GPS no disponible') },
  })
  return null
}

function RecenterButton({ position }) {
  const map = useMap()
  if (!position) return null
  return (
    <button onClick={() => map.flyTo(position, 16)} style={{
      position: 'absolute', bottom: 100, right: 12, zIndex: 999,
      background: 'rgba(10,10,11,0.9)', border: '1px solid rgba(212,175,55,0.3)',
      color: '#fff', borderRadius: '50%', width: 44, height: 44,
      cursor: 'pointer', fontSize: 18, backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }} title="Ir a mi posición">📍</button>
  )
}

function ChipSelect({ options, value, onChange, multi = false, color = '#B91C1C' }) {
  const toggle = (opt) => {
    if (multi) {
      const arr = value || []
      onChange(arr.includes(opt) ? arr.filter(v => v !== opt) : [...arr, opt])
    } else {
      onChange(value === opt ? '' : opt)
    }
  }
  const sel = (opt) => multi ? (value || []).includes(opt) : value === opt
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
      {options.map(opt => (
        <button key={opt} onClick={() => toggle(opt)} style={{
          padding: '5px 11px', borderRadius: 8, fontSize: 12,
          border: `1.5px solid ${sel(opt) ? color : 'rgba(255,255,255,0.12)'}`,
          background: sel(opt) ? `${color}22` : '#1A1A1C',
          color: sel(opt) ? '#fff' : '#8E8E93',
          cursor: 'pointer', fontFamily: 'Inter, sans-serif',
          fontWeight: sel(opt) ? 600 : 400, transition: 'all 0.15s',
        }}>{opt}</button>
      ))}
    </div>
  )
}

function AlteracionSelector({ value, onChange }) {
  const toggle = (mineral, grado) =>
    onChange({ ...value, [mineral]: value[mineral] === grado ? null : grado })

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        {GRADOS.map(g => (
          <span key={g} style={{
            fontSize: 10, color: GRADO_COLOR[g], fontFamily: 'monospace',
            background: `${GRADO_COLOR[g]}18`, border: `1px solid ${GRADO_COLOR[g]}44`,
            borderRadius: 6, padding: '2px 7px',
          }}>{g} {GRADO_LABEL[g]}</span>
        ))}
      </div>
      {ALT_MINERALES.map(mineral => (
        <div key={mineral} style={{
          display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
          padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)',
        }}>
          <span style={{
            width: 68, fontSize: 12, flexShrink: 0, fontFamily: 'Inter, sans-serif',
            color: value[mineral] ? '#fff' : '#8E8E93', fontWeight: value[mineral] ? 600 : 400,
          }}>{mineral}</span>
          <div style={{ display: 'flex', gap: 5, flex: 1 }}>
            {GRADOS.map(g => {
              const active = value[mineral] === g
              return (
                <button key={g} onClick={() => toggle(mineral, g)} title={GRADO_LABEL[g]} style={{
                  flex: 1, height: 30, borderRadius: 7, fontSize: 11, fontWeight: 700,
                  border: `1.5px solid ${active ? GRADO_COLOR[g] : 'rgba(255,255,255,0.1)'}`,
                  background: active ? `${GRADO_COLOR[g]}30` : '#111113',
                  color: active ? GRADO_COLOR[g] : '#555',
                  cursor: 'pointer', fontFamily: 'monospace', transition: 'all 0.15s',
                  minWidth: 32,
                }}>{g}</button>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}

// ─── SECURITY: Validación de magic bytes para imágenes ───────────────────────
const validateImageMagicBytes = async (file) => {
  const buffer = await file.slice(0, 4).arrayBuffer()
  const bytes = new Uint8Array(buffer)
  const isJpeg = bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF
  const isPng  = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47
  const isWebp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
  return isJpeg || isPng || isWebp
}

function FotoGaleria({ fotos, onChange }) {
  const inputRef = useRef(null)
  const [lightbox, setLightbox] = useState(null)
  const [isCompressing, setIsCompressing] = useState(false)

  const handleFiles = async (e) => {
    const files = Array.from(e.target.files)
    if (!files.length) return
    setIsCompressing(true)

    // SECURITY: Validar magic bytes y tamaño antes de comprimir
    const validFiles = []
    for (const f of files) {
      if (f.size > 20 * 1024 * 1024) {
        alert(`"${f.name}" supera el tamaño máximo permitido (20MB).`)
        continue
      }
      const isValid = await validateImageMagicBytes(f)
      if (!isValid) {
        alert(`"${f.name}" no es una imagen válida (JPEG, PNG o WebP requerido).`)
        continue
      }
      validFiles.push(f)
    }
    if (!validFiles.length) { setIsCompressing(false); e.target.value = ''; return }
    
    const options = { maxSizeMB: 1, maxWidthOrHeight: 1280, useWebWorker: true, initialQuality: 0.8 }

    const compressed = await Promise.all(
      validFiles.map(async (f) => {
        try {
          const compressedFile = await imageCompression(f, options)
          return { file: compressedFile, url: URL.createObjectURL(compressedFile), name: f.name }
        } catch (error) {
          console.error('Error al comprimir foto:', error)
          return { file: f, url: URL.createObjectURL(f), name: f.name }
        }
      })
    )
    
    onChange([...fotos, ...compressed])
    e.target.value = ''
    setIsCompressing(false)
  }

  const remove = (idx) => {
    URL.revokeObjectURL(fotos[idx].url)
    onChange(fotos.filter((_, i) => i !== idx))
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}>
        {fotos.map((f, i) => (
          <div key={i} style={{ position: 'relative', width: 76, height: 76, flexShrink: 0 }}>
            <img src={f.url} alt={`foto ${i + 1}`} onClick={() => setLightbox(f.url)} style={{
              width: '100%', height: '100%', objectFit: 'cover', borderRadius: 10, cursor: 'zoom-in',
              border: '1.5px solid rgba(212,175,55,0.3)',
            }} />
            <button onClick={() => remove(i)} style={{
              position: 'absolute', top: -7, right: -7, width: 20, height: 20, borderRadius: '50%',
              background: '#B91C1C', border: '2px solid #0a0a0b', color: '#fff', fontSize: 9, cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 800,
            }}>✕</button>
          </div>
        ))}
        
        <button onClick={() => inputRef.current.click()} disabled={isCompressing} style={{
          width: 76, height: 76, borderRadius: 10, flexShrink: 0, border: '1.5px dashed rgba(212,175,55,0.4)',
          background: 'rgba(212,175,55,0.04)', color: isCompressing ? '#888' : '#D4AF37', cursor: isCompressing ? 'wait' : 'pointer',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          gap: 4, fontFamily: 'Inter, sans-serif', fontSize: 10, transition: 'background 0.2s', opacity: isCompressing ? 0.6 : 1
        }}>
          {isCompressing ? '⏳' : <><span style={{ fontSize: 22 }}>📸</span>Foto</>}
        </button>
      </div>
      <input ref={inputRef} type="file" accept="image/*" capture="environment" multiple onChange={handleFiles} style={{ display: 'none' }} />
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{
          position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.93)', backdropFilter: 'blur(10px)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'zoom-out',
        }}>
          <img src={lightbox} alt="ampliada" style={{ maxWidth: '96vw', maxHeight: '90vh', borderRadius: 14, objectFit: 'contain' }} />
        </div>
      )}
    </>
  )
}

function SectionLabel({ icon, text }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 7, margin: '16px 0 9px', paddingBottom: 6,
      borderBottom: '1px solid rgba(212,175,55,0.12)',
    }}>
      <span style={{ fontSize: 13 }}>{icon}</span>
      <span style={{ color: '#D4AF37', fontSize: 10, fontWeight: 700, letterSpacing: '0.1em', fontFamily: 'Inter, sans-serif' }}>{text}</span>
    </div>
  )
}

function DestructiveModal({ isOpen, title, message, onConfirm, onCancel, keyword }) {
  const [input, setInput] = useState('')
  if (!isOpen) return null
  const isMatch = !keyword || input === keyword
  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.85)', backdropFilter: 'blur(8px)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20
    }}>
      <div className="slide-up" style={{
        background: '#111113', borderRadius: 16, padding: 24, border: '1px solid rgba(185,28,28,0.5)', maxWidth: 400, width: '100%'
      }}>
        <h3 style={{ color: '#EF4444', marginTop: 0, fontFamily: 'Inter, sans-serif' }}>⚠️ {title}</h3>
        <p style={{ color: '#ccc', fontSize: 13, lineHeight: 1.5, fontFamily: 'Inter, sans-serif' }}>{message}</p>
        {keyword && (
          <div style={{ margin: '20px 0' }}>
            <label style={labelSt}>Escribe <strong>{keyword}</strong> para confirmar:</label>
            <input style={{...inputSt, border: '1px solid rgba(185,28,28,0.5)'}} value={input} onChange={e => setInput(e.target.value)} placeholder={keyword} />
          </div>
        )}
        <div style={{ display: 'flex', gap: 10, marginTop: 24 }}>
          <button onClick={onCancel} style={{
            flex: 1, padding: 12, borderRadius: 8, background: '#222', border: 'none', color: '#fff', cursor: 'pointer', fontFamily: 'Inter, sans-serif', fontWeight: 600
          }}>Cancelar</button>
          <button disabled={!isMatch} onClick={onConfirm} style={{
            flex: 1, padding: 12, borderRadius: 8, background: isMatch ? '#B91C1C' : '#552222', border: 'none', color: isMatch ? '#fff' : '#888', cursor: isMatch ? 'pointer' : 'not-allowed', fontFamily: 'Inter, sans-serif', fontWeight: 600, transition: 'all 0.2s'
          }}>Confirmar</button>
        </div>
      </div>
    </div>
  )
}

function MuestraForm({ muestra, index, onChange, onRemove, canRemove }) {
  const [expanded, setExpanded] = useState(index === 0)
  const [isRecording, setIsRecording] = useState(false)
  const [blink, setBlink] = useState(false)
  const mediaRef = useRef(null)
  const blinkRef = useRef(null)

  useEffect(() => {
    if (isRecording) {
      blinkRef.current = setInterval(() => setBlink(b => !b), 500)
    } else {
      clearInterval(blinkRef.current)
      setBlink(false)
    }
    return () => clearInterval(blinkRef.current)
  }, [isRecording])

  const set = (field, val) => onChange({ ...muestra, [field]: val })

  const toggleRecording = async () => {
    if (isRecording) {
      mediaRef.current?.stop()
      setIsRecording(false)
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        const recorder = new MediaRecorder(stream)
        const chunks = []
        recorder.ondataavailable = e => chunks.push(e.data)
        recorder.onstop = () => {
          set('audioBlob', new Blob(chunks, { type: 'audio/webm' }))
          stream.getTracks().forEach(t => t.stop())
        }
        recorder.start()
        mediaRef.current = recorder
        setIsRecording(true)
      } catch {
        alert('Micrófono no disponible')
      }
    }
  }

  const sampleColor = SAMPLE_COLORS[muestra.sampleType] || '#D4AF37'
  const summary = [muestra.sampleId, muestra.sampleType, muestra.sampler].filter(Boolean).join(' · ') || 'Sin datos'
  const fotosCount = muestra.fotos?.length || 0

  return (
    <div style={{
      borderRadius: 14, marginBottom: 10, overflow: 'hidden',
      border: `1px solid ${expanded ? sampleColor + '66' : 'rgba(255,255,255,0.07)'}`,
      background: expanded ? 'rgba(12,12,14,0.9)' : '#0F0F11', transition: 'border-color 0.2s',
    }}>
      <div onClick={() => setExpanded(e => !e)} style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 14px', cursor: 'pointer', userSelect: 'none',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{
            width: 24, height: 24, borderRadius: '50%', flexShrink: 0, background: sampleColor + '22', border: `1px solid ${sampleColor}66`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 800, color: sampleColor, fontFamily: 'Inter, sans-serif',
          }}>{index + 1}</span>
          <span style={{ fontSize: 12, color: expanded ? '#ddd' : '#8E8E93', fontFamily: 'Inter, sans-serif' }}>
            {expanded ? 'MUESTRA' : summary}
          </span>
          {fotosCount > 0 && <span style={{ fontSize: 10, color: '#D4AF37' }}>📸 {fotosCount}</span>}
          {muestra.audioBlob && <span style={{ fontSize: 10, color: '#22C55E' }}>🎤</span>}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {canRemove && (
            <button onClick={e => { e.stopPropagation(); onRemove() }} style={{
              background: 'none', border: 'none', color: '#7f1d1d', cursor: 'pointer', fontSize: 15, padding: '2px 4px', lineHeight: 1,
            }} title="Eliminar muestra">🗑️</button>
          )}
          <span style={{ color: '#555', fontSize: 12 }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '0 14px 18px' }}>

          {/* IDENTIFICATION */}
          <SectionLabel icon="🏷️" text="SAMPLE ID" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            <div><label style={labelSt}>SAMPLE ID *</label>
              <input style={{ ...inputSt, fontWeight: 700, fontSize: 15, color: sampleColor }}
                placeholder="ej: 153651" value={muestra.sampleId || ''}
                onChange={e => set('sampleId', e.target.value)} />
            </div>
            <div><label style={labelSt}>STANDARD ID</label>
              <input style={inputSt} placeholder="ej: STD-001" value={muestra.standardId || ''}
                onChange={e => set('standardId', e.target.value)} />
            </div>
          </div>

          {/* PROJECT INFO */}
          <SectionLabel icon="📂" text="PROJECT INFO" />
          <div style={{ marginBottom: 8 }}>
            <label style={labelSt}>SURVEY NAME</label>
            <input style={inputSt} placeholder="Nombre del survey" value={muestra.surveyName || ''}
              onChange={e => set('surveyName', e.target.value)} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            <div><label style={labelSt}>PROGRAM</label>
              <input style={inputSt} placeholder="Programa" value={muestra.program || ''}
                onChange={e => set('program', e.target.value)} />
            </div>
            <div><label style={labelSt}>PROJECT</label>
              <input style={inputSt} placeholder="Proyecto" value={muestra.project || ''}
                onChange={e => set('project', e.target.value)} />
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            <div><label style={labelSt}>SAMPLER</label>
              <input style={inputSt} placeholder="Nombre" value={muestra.sampler || ''}
                onChange={e => set('sampler', e.target.value)} />
            </div>
            <div><label style={labelSt}>BELT</label>
              <input style={inputSt} placeholder="ej: A, B, N-S" value={muestra.belt || ''}
                onChange={e => set('belt', e.target.value)} />
            </div>
          </div>

          {/* SAMPLE TYPE */}
          <SectionLabel icon="🪨" text="SAMPLE TYPE" />
          <ChipSelect options={SAMPLE_TYPES} value={muestra.sampleType || ''}
            onChange={v => set('sampleType', v)} color={sampleColor} />

          {/* SAMPLE COLLECTION */}
          <SectionLabel icon="🧲" text="SAMPLE COLLECTION" />
          <ChipSelect options={SAMPLE_COLLECTION} value={muestra.sampleCollection || ''}
            onChange={v => set('sampleCollection', v)} color="#60A5FA" />

          {/* SAMPLE WEIGHT */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
            <div><label style={labelSt}>SAMPLE WEIGHT (gr.)</label>
              <input style={inputSt} type="number" step="0.1" placeholder="ej: 500" value={muestra.sampleWeight || ''}
                onChange={e => set('sampleWeight', e.target.value)} />
            </div>
            <div><label style={labelSt}>PARENT SAMPLE ID</label>
              <input style={inputSt} placeholder="opcional" value={muestra.parentSampleId || ''}
                onChange={e => set('parentSampleId', e.target.value)} />
            </div>
          </div>

          {/* CONTAMINATION & ANTHROPOGENIC */}
          <SectionLabel icon="⚠️" text="QUALITY FLAGS" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
            <div>
              <label style={labelSt}>CONTAMINATION</label>
              <ChipSelect options={CONTAMINATION_OPTS} value={muestra.contamination || 'None'}
                onChange={v => set('contamination', v)} color="#F87171" />
            </div>
            <div>
              <label style={labelSt}>ANTHROPOGENIC</label>
              <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                {['No', 'Yes'].map(opt => (
                  <button key={opt} onClick={() => set('anthropogenic', opt)}
                    style={{
                      flex: 1, padding: '6px', borderRadius: 8, fontSize: 12, cursor: 'pointer',
                      border: `1.5px solid ${muestra.anthropogenic === opt ? '#F59E0B' : 'rgba(255,255,255,0.12)'}`,
                      background: muestra.anthropogenic === opt ? 'rgba(245,158,11,0.15)' : '#1A1A1C',
                      color: muestra.anthropogenic === opt ? '#F59E0B' : '#8E8E93',
                      fontFamily: 'Inter, sans-serif', fontWeight: muestra.anthropogenic === opt ? 700 : 400,
                    }}>{opt}</button>
                ))}
              </div>
            </div>
          </div>

          {/* GENERAL DESCRIPTION */}
          <SectionLabel icon="📝" text="GENERAL DESCRIPTION" />
          <textarea value={muestra.generalDescription || ''}
            onChange={e => set('generalDescription', e.target.value)}
            placeholder="Describe the sample: lithology, texture, color, weathering, alteration..."
            style={{ ...inputSt, height: 90, resize: 'none', marginBottom: 10 }}
          />

          {/* PHOTOS */}
          <SectionLabel icon="📸" text="PHOTOGRAPHS" />
          <FotoGaleria fotos={muestra.fotos} onChange={v => set('fotos', v)} />

          {/* AUDIO */}
          <SectionLabel icon="🎤" text="FIELD AUDIO" />
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={toggleRecording} style={{
              width: 48, height: 48, borderRadius: '50%', flexShrink: 0,
              background: isRecording ? (blink ? '#B91C1C' : 'rgba(185,28,28,0.5)') : '#1A1A1C',
              border: `2px solid ${isRecording ? '#D4AF37' : 'rgba(255,255,255,0.15)'}`,
              color: '#fff', fontSize: 20, cursor: 'pointer', transition: 'all 0.3s',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {isRecording ? '⏹️' : '🎙️'}
            </button>
            {muestra.audioBlob
              ? <>
                  <span style={{ color: '#22C55E', fontSize: 12 }}>✅ Audio grabado</span>
                  <button onClick={() => set('audioBlob', null)} style={{
                    background: 'none', border: 'none', color: '#B91C1C', cursor: 'pointer', fontSize: 12,
                  }}>Eliminar</button>
                </>
              : <span style={{ color: '#444', fontSize: 12 }}>Sin audio</span>
            }
          </div>
        </div>
      )}
    </div>
  )
}

function PuntoForm({ position, onSave, onClose, initialData, nextCorrelativos }) {
  // Si es un punto nuevo (no edición) y hay correlativos anteriores, pre-rellenar
  const initMuestras = () => {
    const m = newMuestra()
    if (nextCorrelativos?.nextCp)       m.cp       = nextCorrelativos.nextCp
    if (nextCorrelativos?.nextIdSample) m.idSample = nextCorrelativos.nextIdSample
    if (nextCorrelativos?.takenBy)      m.takenBy  = nextCorrelativos.takenBy
    if (nextCorrelativos?.semana)       m.semana   = nextCorrelativos.semana
    // Auto-fill Xm/Ym desde posición GPS/clic convertida a UTM WGS84
    if (position) {
      const utm = latLngToUTM(position.lat, position.lng)
      m.xm = String(utm.easting)
      m.ym = String(utm.northing)
    }
    // 11. Auto-fill elevación desde GPS si disponible
    if (nextCorrelativos?.gpsAltitude != null) {
      m.elevation = String(Math.round(nextCorrelativos.gpsAltitude))
    }
    return [m]
  }

  const [muestras, setMuestras] = useState(initialData ? initialData.muestras : initMuestras())
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [muestraToDelete, setMuestraToDelete] = useState(null)
  const [isSaving, setIsSaving] = useState(false)

  const update = (id, data) => setMuestras(prev => prev.map(m => m._id === id ? data : m))
  
  const requestRemove = (id) => {
    setMuestraToDelete(id)
    setDeleteModalOpen(true)
  }

  const confirmRemove = () => {
    setMuestras(prev => prev.filter(m => m._id !== muestraToDelete))
    setDeleteModalOpen(false)
    setMuestraToDelete(null)
  }

  // Al agregar nueva muestra: mismo CP, IDSAMPLE incrementado, repite responsable y semana
  const add = () => {
    const lastM = muestras[muestras.length - 1]
    const newM  = newMuestra()
    newM.cp       = lastM.cp || ''
    newM.idSample = nextCorrelativo(lastM.idSample)
    newM.takenBy  = lastM.takenBy  || ''
    newM.semana   = lastM.semana   || ''
    setMuestras(prev => [...prev, newM])
  }

  const handleSave = () => {
    const invalid = muestras.find(m => !m.cp || !m.idSample)
    if (invalid) { alert('Cada muestra requiere CP e IDSAMPLE'); return }
    setIsSaving(true)
    onSave({
      id: initialData ? initialData.id : generateId(),
      position: initialData ? initialData.position : position,
      muestras,
      createdAt: initialData ? initialData.createdAt : new Date().toISOString()
    })
  }

  return (
    <>
      <div className="slide-up" style={{
        position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 2000,
        background: 'rgba(10,10,11,0.97)', backdropFilter: 'blur(24px)',
        borderTop: '1.5px solid rgba(212,175,55,0.3)',
        borderRadius: '24px 24px 0 0',
        maxHeight: '92vh', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '16px 20px 12px', borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
        }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 18 }}>⛏️</span>
              <span style={{ color: '#D4AF37', fontWeight: 700, fontSize: 14, letterSpacing: '0.08em' }}>PUNTO DE MUESTREO</span>
            </div>
            <div style={{ fontSize: 11, color: '#8E8E93', marginTop: 3 }}>
              📍 {position ? (() => { const u = latLngToUTM(position.lat, position.lng); return `Zona ${u.zone} | E: ${u.easting.toLocaleString('es-CL')} N: ${u.northing.toLocaleString('es-CL')}` })() : '—'}
              &nbsp;·&nbsp;
              <span style={{ color: '#D4AF37' }}>{muestras.length}</span> muestra{muestras.length !== 1 ? 's' : ''}
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#8E8E93', fontSize: 22, cursor: 'pointer' }}>✕</button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 16px 0' }}>
          {muestras.map((m, i) => (
            <MuestraForm key={m._id} muestra={m} index={i} onChange={data => update(m._id, data)} onRemove={() => requestRemove(m._id)} canRemove={muestras.length > 1} />
          ))}
          <button onClick={add} style={{
            width: '100%', padding: '12px', borderRadius: 12, marginBottom: 16,
            border: '1.5px dashed rgba(212,175,55,0.35)', background: 'rgba(212,175,55,0.03)', color: '#D4AF37',
            cursor: 'pointer', fontSize: 13, fontFamily: 'Inter, sans-serif', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          }}>
            ＋ Agregar muestra en este punto
          </button>
        </div>

        <div style={{ padding: '12px 16px 28px', borderTop: '1px solid rgba(255,255,255,0.06)', flexShrink: 0 }}>
          <button onClick={handleSave} style={{
            width: '100%', padding: '14px', borderRadius: 14, background: 'linear-gradient(135deg, #B91C1C, #7f1d1d)', border: '1px solid rgba(212,175,55,0.3)',
            color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter, sans-serif', letterSpacing: '0.06em',
          }}>
            💾 GUARDAR PUNTO — {muestras.length} muestra{muestras.length !== 1 ? 's' : ''}
          </button>
        </div>
      </div>

      <DestructiveModal 
        isOpen={deleteModalOpen}
        title="Eliminar Muestra"
        message="¿Estás seguro que deseas eliminar esta muestra? Los datos ingresados no se podrán recuperar."
        onCancel={() => setDeleteModalOpen(false)}
        onConfirm={confirmRemove}
      />
    </>
  )
}

function StationSidebar({ stations, onClose, onExport, isExporting, onDriveSync, isSyncing, onClearAll, driveToken, loginToDrive, onEditStation, onDeleteStation, onExportCSV, onExportSHP, onLoadFromDrive, isLoadingDrive, externalLayers, onRemoveLayer, onLayerOpacity, hiddenCampaigns, onToggleCampaign, onDeleteCampaign }) {
  const [clearModalOpen, setClearModalOpen] = useState(false)
  const totalMuestras = stations.reduce((a, s) => a + s.muestras.length, 0)
  const totalFotos    = stations.reduce((a, s) => a + s.muestras.reduce((b, m) => b + (m.fotos?.length || 0), 0), 0)

  const isBusy = isExporting || isSyncing

  // Campanas únicas cargadas
  const CAMP_COLORS = ['#60A5FA','#F59E0B','#A78BFA','#34D399','#F87171','#FB923C','#E879F9','#22D3EE']
  const campaigns = [...new Set(stations.map(s => s.campaignSource ?? '__current__'))]
    .map((name, i) => ({
      name,
      label: name === '__current__' ? '🔧 Campo actual' : name.replace(/GeologgiaMapper_?/,'').replace('.zip',''),
      color: CAMP_COLORS[i % CAMP_COLORS.length],
      count: stations.filter(s => (s.campaignSource ?? '__current__') === name).length,
      hidden: hiddenCampaigns?.has(name) ?? false,
    }))

  return (
    <>
      <div className="slide-in" style={{
        position: 'fixed', top: 0, left: 0, bottom: 0, width: 340, zIndex: 1500,
        background: 'rgba(10,10,11,0.97)', backdropFilter: 'blur(20px)',
        borderRight: '1px solid rgba(212,175,55,0.2)', display: 'flex', flexDirection: 'column',
      }}>
        <div style={{ padding: '20px 16px 12px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ color: '#D4AF37', fontWeight: 700, fontSize: 13, letterSpacing: '0.1em' }}>⛏️ CAMPAÑA</span>
            <button onClick={onClose} disabled={isBusy} style={{ background: 'none', border: 'none', color: '#8E8E93', cursor: 'pointer', fontSize: 18 }}>✕</button>
          </div>
          <div style={{ color: '#8E8E93', fontSize: 12 }}>
            {stations.length} punto{stations.length !== 1 ? 's' : ''}
            &nbsp;·&nbsp;{totalMuestras} muestras
            {totalFotos > 0 && <>&nbsp;·&nbsp;📸 {totalFotos}</>}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {stations.length === 0 ? (
            <div style={{ textAlign: 'center', color: '#555', paddingTop: 60, fontSize: 13, lineHeight: 1.8 }}>
              <div style={{ fontSize: 36, marginBottom: 10 }}>🗺️</div>
              Sin puntos aún.<br />Toca el mapa para comenzar.
            </div>
          ) : visibleStations.map((s, i) => {
            const fCnt = s.muestras.reduce((a, m) => a + (m.fotos?.length || 0), 0)
            const hasAudio = s.muestras.some(m => m.audioBlob)
            const rocaColor = ROCA_COLORS[s.muestras[0]?.rocaCaja] || '#D4AF37'
            return (
              <div key={s.id || i} className="fade-in" style={{
                background: '#1A1A1C', borderRadius: 12, padding: '12px 14px',
                marginBottom: 8, border: `1px solid ${rocaColor}33`,
                borderLeft: `3px solid ${rocaColor}`,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', flex: 1 }}>
                    {s.muestras.slice(0, 2).map((m, j) => (
                      <span key={j} style={{
                        padding: '2px 8px', borderRadius: 6, fontSize: 11, background: 'rgba(212,175,55,0.1)', color: '#D4AF37',
                        border: '1px solid rgba(212,175,55,0.25)', fontFamily: 'Inter, sans-serif', fontWeight: 600,
                      }}>{m.cp} · {m.idSample}</span>
                    ))}
                    {s.muestras.length > 2 && (
                      <span style={{
                        padding: '2px 8px', borderRadius: 6, fontSize: 11, background: 'rgba(212,175,55,0.06)', color: '#8E8E93', border: '1px solid rgba(255,255,255,0.08)',
                      }}>+{s.muestras.length - 2}</span>
                    )}
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                    <button onClick={() => onEditStation(s)} disabled={isBusy} style={{
                      background: 'rgba(212,175,55,0.1)', border: '1px solid rgba(212,175,55,0.3)',
                      color: '#D4AF37', borderRadius: 6, padding: '3px 8px', fontSize: 11,
                      cursor: 'pointer', fontFamily: 'Inter, sans-serif'
                    }}>✏️ Editar</button>
                  </div>
                </div>
                {s.muestras[0]?.horizonte && (
                  <div style={{ fontSize: 11, color: '#aaa', marginBottom: 3 }}>{s.muestras[0].horizonte}</div>
                )}
                <div style={{ fontSize: 10, color: '#555' }}>
                  {s.muestras.length} muestra{s.muestras.length !== 1 ? 's' : ''}
                  {fCnt > 0 && ` · 📸 ${fCnt}`}
                  {hasAudio && ' · 🎙️'}
                </div>
              </div>
            )
          })}
          
          {stations.length > 0 && (
            <div style={{ marginTop: 24, textAlign: 'center' }}>
              <button onClick={() => setClearModalOpen(true)} disabled={isBusy} style={{
                background: 'none', border: 'none', color: '#7f1d1d', textDecoration: 'underline',
                fontSize: 12, cursor: 'pointer', fontFamily: 'Inter, sans-serif'
              }}>Limpiar campaña (Eliminar todo)</button>
            </div>
          )}
        </div>

        {/* Drive: siempre visible para conectar antes de agregar puntos */}
        <div style={{ padding: '12px 16px 8px', borderTop: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {!driveToken ? (
            <button onClick={loginToDrive} disabled={isBusy} style={{
              width: '100%', padding: '13px', borderRadius: 12,
              background: '#fff', color: '#000', fontSize: 13, fontWeight: 700,
              cursor: isBusy ? 'wait' : 'pointer', fontFamily: 'Inter, sans-serif',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              border: '1px solid #ccc'
            }}>
              <img src="https://upload.wikimedia.org/wikipedia/commons/c/c1/Google_%22G%22_logo.svg" width={16} alt="G" />
              Conectar Google Drive
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px',
                background: 'rgba(16,185,129,0.08)', borderRadius: 10, border: '1px solid rgba(16,185,129,0.25)' }}>
                <span style={{ fontSize: 16 }}>✅</span>
                <span style={{ fontSize: 12, color: '#10B981', fontFamily: 'Inter, sans-serif', fontWeight: 600 }}>
                  Google Drive conectado
                </span>
                <button onClick={() => { loginToDrive() }} style={{
                  marginLeft: 'auto', background: 'none', border: 'none',
                  color: '#555', fontSize: 10, cursor: 'pointer', fontFamily: 'Inter, sans-serif'
                }}>cambiar</button>
              </div>
              {/* Cargar desde Drive */}
              <button onClick={onLoadFromDrive} disabled={isLoadingDrive} style={{
                width: '100%', padding: '11px', borderRadius: 12,
                background: isLoadingDrive ? '#333' : 'rgba(59,130,246,0.12)',
                border: '1px solid rgba(59,130,246,0.35)',
                color: isLoadingDrive ? '#888' : '#60A5FA', fontSize: 12, fontWeight: 600,
                cursor: isLoadingDrive ? 'wait' : 'pointer', fontFamily: 'Inter, sans-serif',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              }}>
                {isLoadingDrive ? '⏳ Buscando en Drive...' : '📥 Cargar campana desde Drive'}
              </button>
            </div>
          )}
        </div>

        {stations.length > 0 && (
          <div style={{ padding: '0 16px 24px', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {driveToken && (
              <button onClick={onDriveSync} disabled={isBusy} style={{
                width: '100%', padding: '13px', borderRadius: 12,
                background: isBusy ? '#333' : 'linear-gradient(135deg, #10B981, #047857)',
                border: '1px solid rgba(16, 185, 129, 0.4)',
                color: isBusy ? '#888' : '#fff', fontSize: 13, fontWeight: 700,
                cursor: isBusy ? 'wait' : 'pointer', fontFamily: 'Inter, sans-serif',
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                transition: 'all 0.3s'
              }}>
                {isSyncing ? '⏳ Subiendo a Drive...' : '☁️ Guardar en mi Drive'}
              </button>
            )}
            
            <button onClick={onExport} disabled={isBusy} style={{
              width: '100%', padding: '13px', borderRadius: 12,
              background: isBusy ? '#333' : 'transparent',
              border: '1px solid rgba(212,175,55,0.3)',
              color: isBusy ? '#888' : '#D4AF37', fontSize: 13, fontWeight: 600,
              cursor: isBusy ? 'wait' : 'pointer', fontFamily: 'Inter, sans-serif',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
              transition: 'all 0.3s'
            }}>
              {isExporting ? '⏳ Generando ZIP...' : '📦 Guardar ZIP Localmente'}
            </button>

            <button onClick={onExportCSV} disabled={isBusy} style={{
              width: '100%', padding: '10px', borderRadius: 12,
              background: 'transparent',
              border: '1px solid rgba(99,102,241,0.35)',
              color: '#818CF8', fontSize: 12, fontWeight: 600,
              cursor: isBusy ? 'wait' : 'pointer', fontFamily: 'Inter, sans-serif',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}>
              📊 Exportar CSV (rápido)
            </button>

            <button onClick={onExportSHP} disabled={isBusy} style={{
              width: '100%', padding: '10px', borderRadius: 12,
              background: 'transparent',
              border: '1px solid rgba(16,185,129,0.35)',
              color: '#34D399', fontSize: 12, fontWeight: 600,
              cursor: isBusy ? 'wait' : 'pointer', fontFamily: 'Inter, sans-serif',
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
            }}>
              🗺️ Exportar Shapefile (QGIS / ArcGIS)
            </button>

            {/* Panel de campañas — filtro visual y de exportación */}
            {campaigns.length > 1 && (
              <div style={{ marginTop: 4 }}>
                <div style={{ fontSize: 10, color: '#555', fontWeight: 600, textTransform: 'uppercase',
                  letterSpacing: '0.08em', marginBottom: 6 }}>
                  Campañas cargadas
                </div>
                {campaigns.map(c => (
                  <div key={c.name} style={{
                    display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
                    borderRadius: 8, marginBottom: 4,
                    background: c.hidden ? 'rgba(255,255,255,0.02)' : `${c.color}10`,
                    border: `1px solid ${c.hidden ? 'rgba(255,255,255,0.06)' : c.color + '35'}`,
                    opacity: c.hidden ? 0.5 : 1, transition: 'all 0.15s',
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: c.color, flexShrink: 0 }} />
                    <span style={{ flex: 1, fontSize: 11, color: '#ccc', overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.label}>
                      {c.label}
                    </span>
                    <span style={{ fontSize: 10, color: '#555', flexShrink: 0 }}>{c.count}p</span>
                    {/* Toggle visibilidad */}
                    <button onClick={() => onToggleCampaign(c.name)} title={c.hidden ? 'Mostrar' : 'Ocultar'}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14,
                        padding: '0 2px', lineHeight: 1 }}>
                      {c.hidden ? '👁️‍🗨️' : '👁️'}
                    </button>
                    {/* Eliminar campaña */}
                    {c.name !== '__current__' && (
                      <button onClick={() => { if(confirm(`¿Eliminar todos los puntos de "${c.label}"?`)) onDeleteCampaign(c.name) }}
                        title="Eliminar campaña del mapa"
                        style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12,
                          padding: '0 2px', lineHeight: 1, color: '#555' }}>
                        🗑️
                      </button>
                    )}
                  </div>
                ))}
                <p style={{ fontSize: 9, color: '#444', marginTop: 4 }}>
                  👁️ oculta del mapa y de la exportación
                </p>
              </div>
            )}
          </div>
        )}

        {/* Capas externas activas con opacidad */}
        {externalLayers.length > 0 && (
          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 10, color: '#555', fontWeight: 600, textTransform: 'uppercase',
              letterSpacing: '0.08em', marginBottom: 6 }}>
              Capas cargadas
            </div>
            {externalLayers.map(l => (
              <div key={l.id} style={{
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: 8, padding: '7px 10px', marginBottom: 5,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: l.type === 'pdf-overlay' ? 6 : 0 }}>
                  <span style={{ fontSize: 12 }}>
                    {l.type === 'pdf-overlay' ? '📄' : l.type === 'geotiff' ? '🗻️' : '🗺️'}
                  </span>
                  <span style={{ flex: 1, fontSize: 11, color: '#ccc', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</span>
                  <button onClick={() => onRemoveLayer(l.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 12,
                      color: '#555', padding: '0 2px' }}>×</button>
                </div>
                {l.type === 'pdf-overlay' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 9, color: '#555', flexShrink: 0 }}>Opacidad</span>
                    <input type="range" min="0" max="1" step="0.05"
                      value={l.opacity ?? 0.75}
                      onChange={e => onLayerOpacity(l.id, +e.target.value)}
                      style={{ flex: 1, accentColor: '#F87171', cursor: 'pointer', height: 3 }}
                    />
                    <span style={{ fontSize: 9, color: '#888', flexShrink: 0, width: 28, textAlign: 'right' }}>
                      {Math.round((l.opacity ?? 0.75) * 100)}%
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <DestructiveModal 
        isOpen={clearModalOpen}
        title="Limpiar Campaña"
        message="ADVERTENCIA CRÍTICA: Estás a punto de borrar TODAS las muestras registradas. Esta acción no se puede deshacer y perderás el trabajo no exportado."
        onCancel={() => setClearModalOpen(false)}
        onConfirm={() => {
          onClearAll()
          setClearModalOpen(false)
        }}
        keyword="ELIMINAR"
      />
    </>
  )
}

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [stations, setStations] = useState([])
  const [showForm, setShowForm] = useState(false)
  const [editingStation, setEditingStation] = useState(null)
  const [clickPosition, setClickPosition] = useState(null)
  const [gpsPosition, setGpsPosition] = useState(null)
  const [gpsAltitude, setGpsAltitude] = useState(null)   // 11. Elevación GPS
  const [showSidebar, setShowSidebar] = useState(false)
  const [showListView, setShowListView] = useState(false) // 8. Vista de lista
  const [mapCenter] = useState([-33.45, -70.65])
  const [activeLayer, setActiveLayer] = useState('osm')
  // 9. Deshacer eliminación
  const [lastDeleted, setLastDeleted] = useState(null)
  const undoTimerRef = useRef(null)
  
  const [isExporting, setIsExporting] = useState(false)
  const [isSyncing, setIsSyncing] = useState(false)
  const [isLoaded, setIsLoaded] = useState(false)
  const [driveToken, setDriveToken] = useState(null)
  const [tokenExpiry, setTokenExpiry] = useState(null)
  const lastSyncRef = useRef(0)
  const [driveFiles, setDriveFiles] = useState(null)   // lista backups Drive
  const [isLoadingDrive, setIsLoadingDrive] = useState(false)
  const [selectedDriveFiles, setSelectedDriveFiles] = useState([]) // multi-selección
  const [hiddenCampaigns, setHiddenCampaigns] = useState(new Set()) // campanas ocultas

  // ─── ESTACIONES VISIBLES (filtradas por campaña) ──────────────────────────────────
  const visibleStations = stations.filter(s => !hiddenCampaigns.has(s.campaignSource ?? '__current__'))

  const [externalLayers, setExternalLayers] = useState([])
  const fileInputRef = useRef(null)
  const pdfInputRef  = useRef(null)
  const [pdfPending, setPdfPending] = useState(null) // { name, imageUrl } esperando coords

  // SECURITY: Verifica si el token de Drive sigue vigente (con 60s de margen)
  const isDriveTokenValid = () =>
    driveToken && tokenExpiry && Date.now() < tokenExpiry - 60_000

  // ─── GOOGLE LOGIN ───
  const loginToDrive = useGoogleLogin({
    onSuccess: (tokenResponse) => {
      setDriveToken(tokenResponse.access_token)
      setTokenExpiry(Date.now() + (tokenResponse.expires_in ?? 3600) * 1000)
    },
    onError: () => alert('Error al iniciar sesión con Google'),
    scope: 'https://www.googleapis.com/auth/drive.file'
  })

  useEffect(() => {
    async function loadData() {
      try {
        const stored = await localforage.getItem('geologgia_stations')
        if (stored && Array.isArray(stored)) {
          const restored = stored.map(s => ({
            ...s,
            muestras: s.muestras.map(m => ({
              ...m,
              fotos: (m.fotos || []).map(f => ({
                ...f,
                url: f.file ? URL.createObjectURL(f.file) : null
              }))
            }))
          }))
          setStations(restored)
        }
      } catch (err) {
        console.error("Error loading data from localforage:", err)
      } finally {
        setIsLoaded(true)
      }
    }
    loadData()
  }, [])

  const saveStations = async (newStationsOrFn) => {
    setStations(prev => {
      const nextStations = typeof newStationsOrFn === 'function' ? newStationsOrFn(prev) : newStationsOrFn
      localforage.setItem('geologgia_stations', nextStations).catch(e => console.error('Save error', e))
      return nextStations
    })
  }

  function MapClickHandler() {
    useMapEvents({
      click(e) {
        setClickPosition(e.latlng)
        setEditingStation(null)
        setShowForm(true)
        setShowSidebar(false)
      }
    })
    return null
  }

  const handleSavePunto = useCallback((punto) => {
    saveStations(prev => {
      const idx = prev.findIndex(p => p.id === punto.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = punto
        return next
      }
      return [...prev, punto]
    })
    setShowForm(false)
    setEditingStation(null)
    setClickPosition(null)
  }, [])

  const handleClearAll = useCallback(() => {
    saveStations([])
  }, [])

  // ─── CARGAR DESDE DRIVE ───────────────────────────────────────────────────
  const handleLoadFromDrive = useCallback(async () => {
    if (!isDriveTokenValid()) {
      alert('Reconecta Google Drive primero.')
      return
    }
    setIsLoadingDrive(true)
    try {
      // Listar archivos GeoINducta ZIP en Drive
      const q = encodeURIComponent("name contains 'GeologgiaMapper' and mimeType='application/zip' and trashed=false")
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=createdTime+desc&fields=files(id,name,createdTime,size)&pageSize=20`,
        { headers: { Authorization: `Bearer ${driveToken}` } }
      )
      const data = await res.json()
      if (!data.files || data.files.length === 0) {
        alert('No se encontraron backups de GeologgiaMapper en tu Drive.\nGuarda primero desde el celular.')
        setIsLoadingDrive(false)
        return
      }
      setDriveFiles(data.files)
    } catch (err) {
      console.error('Drive list error', err)
      alert('Error al leer Drive: ' + err.message)
    } finally {
      setIsLoadingDrive(false)
    }
  }, [driveToken, tokenExpiry])

  const handleRestoreFromFile = useCallback(async (fileId, fileName) => {
    setIsLoadingDrive(true)
    try {
      const res = await fetch(
        `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        { headers: { Authorization: `Bearer ${driveToken}` } }
      )
      const arrayBuffer = await res.arrayBuffer()
      const { default: JSZip } = await import('jszip')
      const zip = await JSZip.loadAsync(arrayBuffer)

      // Intentar leer stations.json primero (backup completo)
      let restored = null
      const stationsFile = zip.file('stations.json')
      if (stationsFile) {
        const json = await stationsFile.async('text')
        restored = JSON.parse(json)
      } else {
        // Fallback: leer GeoJSON y reconstruir estaciones básicas
        const geojsonFile = zip.file('muestras.geojson')
        if (geojsonFile) {
          const geojson = JSON.parse(await geojsonFile.async('text'))
          const byStation = {}
          geojson.features.forEach(f => {
            const p = f.properties
            const sid = p.stationId || p.CP || crypto.randomUUID()
            if (!byStation[sid]) byStation[sid] = { id: sid, position: { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }, createdAt: p.Fecha || new Date().toISOString(), muestras: [] }
            byStation[sid].muestras.push({ _id: crypto.randomUUID(), cp: p.CP, idSample: p.IDSAMPLE, horizonte: p.HORIZONTE, rocaCaja: p['ROCA CAJA'] || p.ROCA_CAJA, estructura: p.ESTRUCTURA, rumbo: p.RUMBO, manteo: p.MANTEO, mineralizacion: p.MINERALIZACION, comentario: p.COMENTARIO, takenBy: p['TAKEN BY'] || p.TAKEN_BY, semana: p.SEMANA, elevation: p.ELEVATION, xm: p.UTM_ESTE, ym: p.UTM_NORTE, fotos: [], alteracion: {} })
          })
          restored = Object.values(byStation)
        }
      }

      if (!restored || restored.length === 0) {
        alert('No se pudieron leer datos del archivo.')
        return
      }

      // Reconstruir URLs de fotos (solo las que tengan file blob)
      const clean = restored.map(s => ({
        ...s,
        campaignSource: fileName, // tag de origen
        muestras: s.muestras.map(m => ({ ...m, fotos: (m.fotos||[]).map(f => ({ ...f, url: f.file ? URL.createObjectURL(f.file) : null })) }))
      }))

      saveStations(clean)
      setDriveFiles(null)
      setSelectedDriveFiles([])
      alert(`✅ ${clean.length} estaciones restauradas desde "${fileName}"`)
    } catch (err) {
      console.error('Restore error', err)
      alert('Error al restaurar: ' + err.message)
    } finally {
      setIsLoadingDrive(false)
    }
  }, [driveToken])

  // ─── MERGE MULTI-CAMPANA ─────────────────────────────────────────────────────
  const parseZip = useCallback(async (fileId, fileName) => {
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
      { headers: { Authorization: `Bearer ${driveToken}` } }
    )
    const arrayBuffer = await res.arrayBuffer()
    const { default: JSZip } = await import('jszip')
    const zip = await JSZip.loadAsync(arrayBuffer)
    let restored = null
    const stationsFile = zip.file('stations.json')
    if (stationsFile) {
      restored = JSON.parse(await stationsFile.async('text'))
    } else {
      const geojsonFile = zip.file('muestras.geojson')
      if (geojsonFile) {
        const geojson = JSON.parse(await geojsonFile.async('text'))
        const byStation = {}
        geojson.features.forEach(f => {
          const p = f.properties
          const sid = p.stationId || p.CP || crypto.randomUUID()
          if (!byStation[sid]) byStation[sid] = { id: sid, position: { lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] }, createdAt: p.Fecha || new Date().toISOString(), muestras: [] }
          byStation[sid].muestras.push({ _id: crypto.randomUUID(), cp: p.CP, idSample: p.IDSAMPLE, horizonte: p.HORIZONTE, rocaCaja: p['ROCA CAJA'] || p.ROCA_CAJA, estructura: p.ESTRUCTURA, rumbo: p.RUMBO, manteo: p.MANTEO, mineralizacion: p.MINERALIZACION, comentario: p.COMENTARIO, takenBy: p['TAKEN BY'] || p.TAKEN_BY, semana: p.SEMANA, elevation: p.ELEVATION, xm: p.UTM_ESTE, ym: p.UTM_NORTE, fotos: [], alteracion: {} })
        })
        restored = Object.values(byStation)
      }
    }
    if (!restored) return []
    return restored.map(s => ({
      ...s,
      id: s.id || crypto.randomUUID(),
      campaignSource: fileName,
      muestras: s.muestras.map(m => ({ ...m, fotos: (m.fotos||[]).map(f => ({ ...f, url: f.file ? URL.createObjectURL(f.file) : null })) }))
    }))
  }, [driveToken])

  const handleMergeCampaigns = useCallback(async (files, replaceAll) => {
    if (!files.length) return
    setIsLoadingDrive(true)
    try {
      // Descargar todos en paralelo
      const results = await Promise.all(files.map(f => parseZip(f.id, f.name)))
      const incoming = results.flat()
      if (!incoming.length) { alert('No se encontraron datos en los archivos.'); return }

      if (replaceAll) {
        saveStations(incoming)
        alert(`✅ ${incoming.length} estaciones cargadas (${files.length} campaña${files.length > 1 ? 's' : ''})`)
      } else {
        // Merge: agrega las que no existan (por id)
        setStations(prev => {
          const existingIds = new Set(prev.map(s => s.id))
          const nuevas = incoming.filter(s => !existingIds.has(s.id))
          const merged = [...prev, ...nuevas].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
          localforage.setItem('geologgia_stations', merged).catch(console.error)
          const added = nuevas.length
          const dupes = incoming.length - added
          setTimeout(() => alert(`✅ +${added} estaciones agregadas${dupes ? ` (${dupes} ya existían)` : ''} · Total: ${merged.length}`), 100)
          return merged
        })
      }
      setDriveFiles(null)
      setSelectedDriveFiles([])
    } catch (err) {
      console.error('Merge error', err)
      alert('Error al cargar campañas: ' + err.message)
    } finally {
      setIsLoadingDrive(false)
    }
  }, [parseZip])
  const handleDeleteStation = useCallback((id) => {
    setStations(prev => {
      const deleted = prev.find(s => s.id === id)
      if (!deleted) return prev
      setLastDeleted(deleted)
      clearTimeout(undoTimerRef.current)
      undoTimerRef.current = setTimeout(() => setLastDeleted(null), 6000)
      const next = prev.filter(s => s.id !== id)
      localforage.setItem('geologgia_stations', next).catch(console.error)
      return next
    })
  }, [])

  const handleUndoDelete = useCallback(() => {
    if (!lastDeleted) return
    clearTimeout(undoTimerRef.current)
    setStations(prev => {
      const next = [...prev, lastDeleted].sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
      localforage.setItem('geologgia_stations', next).catch(console.error)
      return next
    })
    setLastDeleted(null)
  }, [lastDeleted])

  // 13. Exportar CSV directo (sin ZIP)
  const handleExportCSV = useCallback(() => {
    const exportList = visibleStations
    if (exportList.length === 0) { alert('No hay puntos visibles para exportar.'); return }
    const COLS = [
      'SAMPLE_ID','SURVEY_NAME','PROGRAM','PROJECT',
      'SAMPLER','BELT','SAMPLE_TYPE','SAMPLE_COLLECTION',
      'STANDARD_ID','SAMPLE_WEIGHT_gr','PARENT_SAMPLE_ID',
      'CONTAMINATION','ANTHROPOGENIC','GENERAL_DESCRIPTION',
      'N_PHOTOS','AUDIO',
      'LAT_WGS84','LONG_WGS84','UTM_ZONE','UTM_EAST','UTM_NORTH','ALTITUDE_m','DATE'
    ]
    const rows = [COLS.join(',')]
    exportList.forEach(s => {
      const utm = latLngToUTM(s.position.lat, s.position.lng)
      s.muestras.forEach(m => {
        const altStr = Object.entries(m.alteracion || {})
          .filter(([,v]) => v).map(([k,v]) => `${k}:${v}`).join('; ')
        const rocaFull = m.rocaCaja + (m.rocaCajaCustom ? ` — ${m.rocaCajaCustom}` : '')
        const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`
        rows.push([
          esc(m.sampleId), esc(m.surveyName), esc(m.program), esc(m.project),
          esc(m.sampler), esc(m.belt), esc(m.sampleType), esc(m.sampleCollection),
          esc(m.standardId), m.sampleWeight ?? '', esc(m.parentSampleId),
          esc(m.contamination), esc(m.anthropogenic), esc(m.generalDescription),
          m.fotos?.length || 0, m.audioBlob ? 1 : 0,
          s.position.lat, s.position.lng, utm.zone, utm.easting, utm.northing,
          '', s.createdAt
        ].join(','))
      })
    })
    const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `GeologgiaMapper_${new Date().toISOString().slice(0,10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [visibleStations])

  // SHP export — Shapefile compatible con QGIS y ArcGIS
  const handleExportSHP = useCallback(async () => {
    const exportList = visibleStations
    if (exportList.length === 0) { alert('No hay puntos visibles para exportar.'); return }
    try {
      // Importación dinámica para no penalizar el bundle inicial
      const shpwrite = (await import('@mapbox/shp-write')).default

      // Construir GeoJSON — nombres de campo máx 10 chars (límite DBF)
      const features = []
      exportList.forEach(s => {
        const utm = latLngToUTM(s.position.lat, s.position.lng)
        s.muestras.forEach(m => {
          const altStr  = Object.entries(m.alteracion || {})
            .filter(([,v]) => v).map(([k,v]) => `${k}:${v}`).join('; ')
          const rocaFull = (m.rocaCaja + (m.rocaCajaCustom ? ` ${m.rocaCajaCustom}` : '')).substring(0, 80)
          features.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [s.position.lng, s.position.lat] },
            properties: {
              CP:         (m.cp        || '').substring(0, 20),
              IDSAMPLE:   (m.idSample  || '').substring(0, 20),
              ELEVATION:  m.elevation  || '',
              XM:         m.xm         || '',
              YM:         m.ym         || '',
              FROM_M:     m.from       || '',
              TO_M:       m.to         || '',
              HORIZONTE:  (m.horizonte  || '').substring(0, 30),
              ROCA_CAJA:  rocaFull,
              ESTRUCTURA: (m.estructura || '').substring(0, 30),
              RUMBO:      m.rumbo      || '',
              MANTEO:     m.manteo     || '',
              MINERALOG:  ((m.mineralogia||[]).join('; ')).substring(0, 100),
              ALTERACION: altStr.substring(0, 100),
              MINERALIZ:  (m.mineralizacion || '').substring(0, 20),
              COMENTARIO: (m.comentario    || '').substring(0, 200),
              TAKEN_BY:   (m.takenBy       || '').substring(0, 50),
              SEMANA:     m.semana     || '',
              UTM_ZONA:   utm.zone,
              UTM_ESTE:   utm.easting,
              UTM_NORTE:  utm.northing,
              LAT_DD:     s.position.lat,
              LNG_DD:     s.position.lng,
              FECHA:      (s.createdAt || '').substring(0, 20),
            }
          })
        })
      })

      const geojson = { type: 'FeatureCollection', features }
      const fecha   = new Date().toISOString().slice(0, 10)

      const blob = await shpwrite.zip(geojson, {
        folder:      'GeoINducta',
        filename:    `muestras_${fecha}`,
        outputType:  'blob',
        compression: 'DEFLATE',
      })

      const url = URL.createObjectURL(blob)
      const a   = document.createElement('a')
      a.href    = url
      a.download = `GeoINducta_SHP_${fecha}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('SHP export error', err)
      alert('Error al generar Shapefile: ' + err.message)
    }
  }, [visibleStations])

  // ─── CORRELATIVOS: lee el último punto guardado (localforage) y calcula el siguiente ───
  const getNextCorrelativos = useCallback(() => {
    if (stations.length === 0) return { nextCp: '', nextIdSample: '', takenBy: '', semana: '' }
    const lastStation = stations[stations.length - 1]
    const lastMuestra = lastStation.muestras[lastStation.muestras.length - 1]
    return {
      nextCp:       nextCorrelativo(lastMuestra.cp),
      nextIdSample: nextCorrelativo(lastMuestra.idSample),
      takenBy:      lastMuestra.takenBy  || '',
      semana:       lastMuestra.semana   || '',
      gpsAltitude:  gpsAltitude,
    }
  }, [stations])

  // ─── SECURITY: Sanitización de propiedades GeoJSON contra XSS ───────────────
  const sanitizeStr = (val) => {
    if (typeof val !== 'string') return val
    return val
      .replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
      .replace(/javascript:/gi, '')
  }
  const sanitizeGeoJSON = (geojson) => {
    if (!geojson?.features) return geojson
    return {
      ...geojson,
      features: geojson.features.map(f => ({
        ...f,
        properties: f.properties
          ? Object.fromEntries(Object.entries(f.properties).map(([k, v]) => [k, sanitizeStr(v)]))
          : f.properties
      }))
    }
  }

  // ─── CARGAR PDF GEOREFERENCIADO ───────────────────────────────────────────────
  const handlePdfUpload = useCallback(async (e) => {
    const file = e.target.files[0]
    if (!file) return
    e.target.value = ''
    const MAX_PDF = 50 * 1024 * 1024 // 50 MB
    if (file.size > MAX_PDF) { alert('El PDF supera el límite de 50 MB.'); return }

    try {
      const arrayBuffer = await file.arrayBuffer()
      // Import PDF.js dinámicamente
      const pdfjsLib = await import('pdfjs-dist')
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href

      const pdfDoc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise
      const page  = await pdfDoc.getPage(1)

      // Intentar extraer metadatos geográficos (GeoPDF / XMP)
      let autoBounds = null
      try {
        const meta = await pdfDoc.getMetadata()
        const xmp  = meta?.info?.Custom || {}
        // Algunos GeoPDF exportan BBOX en campos personalizados
        if (xmp.BBOX || xmp.bbox) {
          const parts = (xmp.BBOX || xmp.bbox).split(',')
          if (parts.length === 4) {
            autoBounds = { west: +parts[0], south: +parts[1], east: +parts[2], north: +parts[3] }
          }
        }
      } catch (_) { /* no metadata */ }

      // Renderizar página 1 a canvas PNG
      const viewport = page.getViewport({ scale: 2.0 })
      const canvas   = document.createElement('canvas')
      canvas.width   = viewport.width
      canvas.height  = viewport.height
      const ctx = canvas.getContext('2d')
      await page.render({ canvasContext: ctx, viewport }).promise
      const imageUrl = canvas.toDataURL('image/png')

      if (autoBounds) {
        // Bounds encontrados automáticamente
        setExternalLayers(prev => [...prev, {
          id: crypto.randomUUID(), type: 'pdf-overlay',
          name: file.name.replace('.pdf',''), imageUrl, bounds: autoBounds, opacity: 0.75,
        }])
        alert(`✅ PDF cargado con coordenadas automáticas`)
      } else {
        // Pedir coordenadas al usuario
        setPdfPending({ name: file.name.replace('.pdf',''), imageUrl })
      }
    } catch (err) {
      console.error('PDF load error', err)
      alert('Error al cargar PDF: ' + err.message)
    }
  }, [])

  // ─── GUARDAR PDF CON BOUNDS MANUALES ─────────────────────────────────────────
  const handlePdfGeoref = useCallback((bounds) => {
    if (!pdfPending) return
    setExternalLayers(prev => [...prev, {
      id: crypto.randomUUID(), type: 'pdf-overlay',
      name: pdfPending.name, imageUrl: pdfPending.imageUrl, bounds, opacity: 0.75,
    }])
    setPdfPending(null)
  }, [pdfPending])

  // ─── CAMBIAR OPACIDAD CAPA PDF ───────────────────────────────────────────────────
  const handleLayerOpacity = useCallback((id, opacity) => {
    setExternalLayers(prev => prev.map(l => l.id === id ? { ...l, opacity } : l))
  }, [])

  // ─── HANDLE LAYER UPLOAD ───────────────────────────────────────────────────────
  const handleLayerUpload = async (e) => {
    const file = e.target.files[0]
    if (!file) return
    const name = file.name
    const ext = name.split('.').pop().toLowerCase()

    // SECURITY: Límite de tamaño para GeoTIFF (100MB)
    const MAX_TIFF_SIZE = 100 * 1024 * 1024
    if ((ext === 'tif' || ext === 'tiff') && file.size > MAX_TIFF_SIZE) {
      alert('El archivo GeoTIFF supera el límite de 100MB. Usa un archivo más pequeño.')
      e.target.value = ''
      return
    }
    
    try {
      if (ext === 'kmz') {
        const { default: JSZip } = await import('jszip')
        const arrayBuffer = await file.arrayBuffer()
        const zip = await JSZip.loadAsync(arrayBuffer)
        const kmlFile = Object.values(zip.files).find(f => f.name.endsWith('.kml'))
        if (kmlFile) {
          const { kml } = await import('@tmcw/togeojson')
          const text = await kmlFile.async('text')
          const dom = new DOMParser().parseFromString(text, 'text/xml')
          const geojson = sanitizeGeoJSON(kml(dom)) // SECURITY: sanitizar
          setExternalLayers(prev => [...prev, { id: generateId(), type: 'geojson', data: geojson, name }])
        } else {
          alert('No se encontró archivo .kml dentro del KMZ')
        }
      } else if (ext === 'kml') {
        const { kml } = await import('@tmcw/togeojson')
        const text = await file.text()
        const dom = new DOMParser().parseFromString(text, 'text/xml')
        const geojson = sanitizeGeoJSON(kml(dom)) // SECURITY: sanitizar
        setExternalLayers(prev => [...prev, { id: generateId(), type: 'geojson', data: geojson, name }])
      } else if (ext === 'geojson' || ext === 'json') {
        const text = await file.text()
        const geojson = sanitizeGeoJSON(JSON.parse(text)) // SECURITY: sanitizar
        setExternalLayers(prev => [...prev, { id: generateId(), type: 'geojson', data: geojson, name }])
      } else if (ext === 'tif' || ext === 'tiff') {
        const { default: parseGeoraster } = await import('georaster')
        const arrayBuffer = await file.arrayBuffer()
        const raster = await parseGeoraster(arrayBuffer)
        setExternalLayers(prev => [...prev, { id: generateId(), type: 'geotiff', georaster: raster, name }])
      } else {
        alert('Formato no soportado. Usa KML, KMZ, GeoJSON o TIF.')
      }
    } catch (err) {
      console.error(err)
      alert('Error procesando el archivo.')
    }
    e.target.value = ''
  }

  // ─── CORE ZIP GENERATOR ───
  const generateZipBlob = async () => {
    const exportList = visibleStations
    const { default: JSZip } = await import('jszip')
    const zip = new JSZip()
    const fotosDir  = zip.folder('fotos')
    const audiosDir = zip.folder('audios')

    const features = exportList.flatMap(s =>
      s.muestras.map(m => {
        const altStr = Object.entries(m.alteracion)
          .filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join('; ')
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [s.position.lng, s.position.lat] },
          properties: {
            CP: m.cp, IDSAMPLE: m.idSample,
            Elevation: m.elevation, Xm: m.xm, Ym: m.ym,
            From: m.from, To: m.to,
            HORIZONTE: m.horizonte, 'ROCA CAJA': m.rocaCaja + (m.rocaCajaCustom ? ` — ${m.rocaCajaCustom}` : ''),
            ESTRUCTURA: m.estructura, RUMBO: m.rumbo, MANTEO: m.manteo,
            MINERALOGÍA: (m.mineralogia || []).join('; '),
            ALTERACION: altStr,
            MINERALIZACION: m.mineralizacion,
            COMENTARIO: m.comentario,
            'TAKEN BY': m.takenBy, SEMANA: m.semana,
            Lat: s.position.lat, Lng: s.position.lng, Fecha: s.createdAt,
          }
        }
      })
    )
    zip.file('muestras.geojson', JSON.stringify({ type: 'FeatureCollection', features }, null, 2))

    const COLS = [
      'CP', 'IDSAMPLE', 'Elevation', 'Xm', 'Ym', 'From', 'To',
      'HORIZONTE', 'ROCA CAJA', 'ESTRUCTURA', 'RUMBO', 'MANTEO',
      'MINERALOGÍA', 'ALTERACION', 'MINERALIZACION', 'COMENTARIO',
      'TAKEN BY', 'SEMANA', 'UTM_ZONA', 'UTM_ESTE', 'UTM_NORTE', 'Lat_DD', 'Lng_DD', 'Fecha',
    ]
    const rows = [COLS.join('\t')]
    stations.forEach(s => {
      const utm = latLngToUTM(s.position.lat, s.position.lng)
      s.muestras.forEach(m => {
        const altStr = Object.entries(m.alteracion)
          .filter(([, v]) => v).map(([k, v]) => `${k}:${v}`).join('; ')
        rows.push([
          m.cp, m.idSample, m.elevation, m.xm, m.ym, m.from, m.to,
          m.horizonte, m.rocaCaja + (m.rocaCajaCustom ? ` — ${m.rocaCajaCustom}` : ''), m.estructura, m.rumbo, m.manteo,
          (m.mineralogia || []).join('; '), altStr, m.mineralizacion,
          `"${(m.comentario || '').replace(/"/g, '""')}"`,
          m.takenBy, m.semana,
          utm.zone, utm.easting, utm.northing,
          s.position.lat, s.position.lng, s.createdAt,
        ].join('\t'))
      })
    })
    zip.file('muestras.tsv', rows.join('\n'))

    for (const s of stations) {
      for (const m of s.muestras) {
        const prefix = `${m.cp || 'CP'}_${m.idSample || 'S'}`
        if (m.fotos?.length) {
          m.fotos.forEach((f, i) => {
            if (f.file) fotosDir.file(`${prefix}_foto_${i + 1}.jpg`, f.file)
          })
        }
        if (m.audioBlob) {
          audiosDir.file(`${prefix}_audio.webm`, m.audioBlob)
        }
      }
    }

    // stations.json — backup completo para restaurar en cualquier navegador
    const stationsForExport = stations.map(s => ({
      ...s,
      muestras: s.muestras.map(m => ({ ...m, audioBlob: undefined, fotos: (m.fotos||[]).map(f => ({ ...f, file: undefined, url: undefined })) }))
    }))
    zip.file('stations.json', JSON.stringify(stationsForExport, null, 2))

    return await zip.generateAsync({ type: 'blob' })
  }

  // ─── LOCAL EXPORT ───
  const handleExport = useCallback(async () => {
    setIsExporting(true)
    try {
      const blob = await generateZipBlob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `campana_GeoINducta_${new Date().toISOString().slice(0, 10)}.zip`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error("Export error", err)
      alert("Error al generar el ZIP local.")
    } finally {
      setIsExporting(false)
    }
  }, [stations])

  // ─── CLOUD SYNC (Direct to Google Drive) ───
  const handleDriveSync = useCallback(async () => {
    // SECURITY: Verificar token vigente
    if (!isDriveTokenValid()) {
      setDriveToken(null)
      setTokenExpiry(null)
      alert('La sesión de Google Drive expiró. Por favor reconecta.')
      return
    }
    // SECURITY: Rate limiting — mínimo 5 segundos entre sincronizaciones
    const MIN_INTERVAL = 5_000
    if (Date.now() - lastSyncRef.current < MIN_INTERVAL) {
      alert('Por favor espera unos segundos antes de sincronizar de nuevo.')
      return
    }
    lastSyncRef.current = Date.now()
    setIsSyncing(true)
    try {
      const blob = await generateZipBlob()
      
      const boundary = 'geoinducta_boundary_' + Date.now()
      const delimiter = "\r\n--" + boundary + "\r\n"
      const close_delim = "\r\n--" + boundary + "--"

      const metadata = {
        name: `GeoINducta_${new Date().toISOString().slice(0, 10)}.zip`,
        mimeType: 'application/zip'
      }

      // 1. Search if file already exists for today
      const query = encodeURIComponent(`name='${metadata.name}' and trashed=false`)
      const searchRes = await fetch(`https://www.googleapis.com/drive/v3/files?q=${query}&spaces=drive`, {
        headers: { 'Authorization': `Bearer ${driveToken}` }
      })
      const searchData = await searchRes.json()
      
      if (searchData.error) throw new Error(searchData.error.message)

      const existingFileId = searchData.files && searchData.files.length > 0 ? searchData.files[0].id : null

      // We construct the multipart/related body manually
      const multipartRequestBody = new Blob([
        delimiter,
        'Content-Type: application/json; charset=UTF-8\r\n\r\n',
        JSON.stringify(metadata),
        delimiter,
        'Content-Type: application/zip\r\n\r\n',
        blob,
        close_delim
      ])

      let uploadUrl = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart'
      let uploadMethod = 'POST'

      if (existingFileId) {
        uploadUrl = `https://www.googleapis.com/upload/drive/v3/files/${existingFileId}?uploadType=multipart`
        uploadMethod = 'PATCH'
      }

      const response = await fetch(uploadUrl, {
        method: uploadMethod,
        headers: {
          'Authorization': `Bearer ${driveToken}`,
          'Content-Type': `multipart/related; boundary=${boundary}`
        },
        body: multipartRequestBody
      })
      
      if (!response.ok) {
        const err = await response.json()
        throw new Error(err.error?.message || 'Error en subida')
      }
      
      alert("✅ ¡Sincronización Exitosa!\n\nEl archivo ZIP ha sido guardado directamente en tu Google Drive.")
    } catch (err) {
      console.error("Drive sync error", err)
      alert(`❌ Error al subir a Drive.\n${err.message}`)
      if (err.message.includes('Invalid Credentials') || err.message.includes('Auth')) {
        setDriveToken(null)
        setTokenExpiry(null) // SECURITY: limpiar expiración junto al token
      }
    } finally {
      setIsSyncing(false)
    }
  }, [stations, driveToken, tokenExpiry])


  const totalMuestras = stations.reduce((a, s) => a + s.muestras.length, 0)

  if (!isLoaded) return <div style={{ background: '#0a0a0b', height: '100vh' }}></div>

  return (
    <div style={{ height: '100vh', width: '100vw', position: 'relative' }}>
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, zIndex: 1000,
        background: 'rgba(10,10,11,0.92)', backdropFilter: 'blur(16px)',
        borderBottom: '1px solid rgba(212,175,55,0.2)',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 16px', height: 56,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={() => { setShowSidebar(s => !s); setShowForm(false) }}
            style={{ background: 'none', border: 'none', color: showSidebar ? '#D4AF37' : '#8E8E93', fontSize: 20, cursor: 'pointer' }}>
            ☰
          </button>
          <span style={{ fontWeight: 700, fontSize: 16, letterSpacing: '0.05em', fontFamily: 'Inter, sans-serif' }}>
            Geo<span style={{ color: '#B91C1C' }}>IN</span>ducta
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button onClick={() => fileInputRef.current?.click()} style={{
            background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.4)',
            color: '#60A5FA', borderRadius: 8, padding: '4px 8px', fontSize: 11, cursor: 'pointer',
            fontFamily: 'Inter, sans-serif'
          }}>+ 🗺️ Capa</button>
          <input type="file" ref={fileInputRef} onChange={handleLayerUpload} accept=".kml,.kmz,.geojson,.json,.tif,.tiff" style={{ display: 'none' }} />
          <button onClick={() => pdfInputRef.current?.click()} style={{
            background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.35)',
            color: '#F87171', borderRadius: 8, padding: '4px 8px', fontSize: 11, cursor: 'pointer',
            fontFamily: 'Inter, sans-serif'
          }}>+ 📄 PDF Geo</button>
          <input type="file" ref={pdfInputRef} onChange={handlePdfUpload} accept=".pdf" style={{ display: 'none' }} />
          
          {gpsPosition && (
            <span style={{ padding: '3px 8px', borderRadius: 8, fontSize: 11, background: 'rgba(34,197,94,0.12)', color: '#22C55E', border: '1px solid rgba(34,197,94,0.3)' }}>
              📍 GPS
            </span>
          )}
          {totalMuestras > 0 && (
            <span style={{ padding: '3px 8px', borderRadius: 8, fontSize: 11, background: 'rgba(212,175,55,0.1)', color: '#D4AF37', border: '1px solid rgba(212,175,55,0.3)' }}>
              {totalMuestras} muestras
            </span>
          )}
        </div>
      </div>

      <MapContainer center={mapCenter} zoom={13} style={{ height: '100%', width: '100%' }} zoomControl={false}>
        <TileLayer
          key={activeLayer}
          url={TILE_LAYERS[activeLayer].url}
          attribution={TILE_LAYERS[activeLayer].attribution}
          maxZoom={TILE_LAYERS[activeLayer].maxZoom}
        />
        <MapClickHandler />
        <GPSTracker onPosition={(pos) => {
          setGpsPosition(pos)
          if (pos?.altitude != null) setGpsAltitude(pos.altitude)
        }} />

        {gpsPosition && <Marker position={gpsPosition} icon={gpsIcon}><Popup>Tu posición actual</Popup></Marker>}

        {externalLayers.map(layer => {
          if (layer.type === 'geojson') {
            return <GeoJSON key={layer.id} data={layer.data} style={{ color: '#3B82F6', weight: 2, opacity: 0.8 }} />
          } else if (layer.type === 'geotiff') {
            return <GeoTiffLayer key={layer.id} georaster={layer.georaster} />
          } else if (layer.type === 'pdf-overlay') {
            return <ImageOverlay key={layer.id} url={layer.imageUrl}
              bounds={[[layer.bounds.south, layer.bounds.west],[layer.bounds.north, layer.bounds.east]]}
              opacity={layer.opacity ?? 0.8} />
          }
          return null
        })}

        {stations.map((s, i) => (
          <Marker key={s.id || i} position={s.position} icon={createStationIcon(s.muestras)}>
            <Popup>
              <div style={{ minWidth: 200, fontFamily: 'Inter, sans-serif', fontSize: 12 }}>
                <strong style={{ color: '#B91C1C', display: 'block', marginBottom: 6 }}>
                  Punto #{i + 1} — {s.muestras.length} muestra{s.muestras.length !== 1 ? 's' : ''}
                </strong>
                {s.muestras.map((m, j) => (
                  <div key={m._id || j} style={{
                    marginBottom: 6, paddingBottom: 6, borderBottom: j < s.muestras.length - 1 ? '1px solid #eee' : 'none',
                  }}>
                    <div><b>{m.cp}</b> — {m.idSample}</div>
                    {m.horizonte && <div>Horizonte: {m.horizonte}</div>}
                    {m.rocaCaja && <div>Roca: {m.rocaCaja}</div>}
                    {m.mineralizacion && <div>Mineralización: {m.mineralizacion}</div>}
                    {m.fotos?.length > 0 && <div>📸 {m.fotos.length} foto{m.fotos.length !== 1 ? 's' : ''}</div>}
                  </div>
                ))}
              </div>
            </Popup>
          </Marker>
        ))}

        <RecenterButton position={gpsPosition} />
      </MapContainer>

      <div style={{ position: 'fixed', bottom: 96, left: 12, zIndex: 999 }}>
        <select value={activeLayer} onChange={e => setActiveLayer(e.target.value)} style={{
          background: 'rgba(10,10,11,0.9)', color: '#fff', border: '1px solid rgba(212,175,55,0.3)',
          borderRadius: 8, padding: '8px 12px', outline: 'none', cursor: 'pointer', fontFamily: 'Inter, sans-serif'
        }}>
          {Object.entries(TILE_LAYERS).map(([k, v]) => (
            <option key={k} value={k}>{v.icon} {v.name}</option>
          ))}
        </select>
      </div>

      {showSidebar && (
        <StationSidebar
          stations={stations}
          onClose={() => setShowSidebar(false)}
          onExport={handleExport}
          isExporting={isExporting}
          onDriveSync={handleDriveSync}
          isSyncing={isSyncing}
          onClearAll={handleClearAll}
          driveToken={driveToken}
          loginToDrive={loginToDrive}
          externalLayers={externalLayers}
          onRemoveLayer={(id) => setExternalLayers(prev => prev.filter(l => l.id !== id))}
          onLayerOpacity={handleLayerOpacity}
          hiddenCampaigns={hiddenCampaigns}
          onToggleCampaign={(name) => setHiddenCampaigns(prev => {
            const next = new Set(prev)
            if (next.has(name)) next.delete(name); else next.add(name)
            return next
          })}
          onDeleteCampaign={(name) => {
            setStations(prev => {
              const next = prev.filter(s => (s.campaignSource ?? '__current__') !== name)
              localforage.setItem('geoinducta_stations', next).catch(console.error)
              return next
            })
            setHiddenCampaigns(prev => { const n = new Set(prev); n.delete(name); return n })
          }}
          onEditStation={(s) => {
            setEditingStation(s)
            setShowForm(true)
            setShowSidebar(false)
          }}
          onDeleteStation={handleDeleteStation}
          onExportCSV={handleExportCSV}
          onExportSHP={handleExportSHP}
          onLoadFromDrive={handleLoadFromDrive}
          isLoadingDrive={isLoadingDrive}
        />
      )}
      {/* Modal georreferencia PDF */}
      {pdfPending && (
        <PdfGeoreferenceModal
          name={pdfPending.name}
          imageUrl={pdfPending.imageUrl}
          onConfirm={handlePdfGeoref}
          onCancel={() => setPdfPending(null)}
        />
      )}

      {/* Modal selector de backups Drive — multi-selección */}
      {driveFiles && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.82)', zIndex: 3000,
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
        }}>
          <div style={{
            background: '#111', borderRadius: 16, padding: 20, width: '100%', maxWidth: 400,
            border: '1px solid rgba(212,175,55,0.25)', maxHeight: '85vh', display: 'flex', flexDirection: 'column',
            fontFamily: 'Inter, sans-serif', boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          }}>
            {/* Header */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ color: '#D4AF37', fontWeight: 700, fontSize: 14 }}>📥 Campañas en Google Drive</span>
              <button onClick={() => { setDriveFiles(null); setSelectedDriveFiles([]) }}
                style={{ background: 'none', border: 'none', color: '#888', fontSize: 20, cursor: 'pointer' }}>×</button>
            </div>
            <p style={{ color: '#666', fontSize: 11, marginBottom: 12 }}>
              Selecciona una o más campañas para cargar
            </p>

            {/* Lista con checkboxes */}
            <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
              {driveFiles.map(f => {
                const isSelected = selectedDriveFiles.some(s => s.id === f.id)
                return (
                  <div key={f.id}
                    onClick={() => setSelectedDriveFiles(prev =>
                      isSelected ? prev.filter(s => s.id !== f.id) : [...prev, f]
                    )}
                    style={{
                      background: isSelected ? 'rgba(212,175,55,0.1)' : 'rgba(255,255,255,0.03)',
                      border: `1px solid ${isSelected ? 'rgba(212,175,55,0.5)' : 'rgba(255,255,255,0.08)'}`,
                      borderRadius: 10, padding: '10px 12px', cursor: 'pointer',
                      display: 'flex', alignItems: 'center', gap: 10, transition: 'all 0.15s',
                    }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: 5, flexShrink: 0,
                      border: `2px solid ${isSelected ? '#D4AF37' : '#444'}`,
                      background: isSelected ? '#D4AF37' : 'transparent',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      {isSelected && <span style={{ color: '#000', fontSize: 11, fontWeight: 900 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ color: '#fff', fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{f.name}</div>
                      <div style={{ color: '#555', fontSize: 10, marginTop: 2 }}>
                        {new Date(f.createdTime).toLocaleString('es-CL')}
                        {f.size && ` · ${(f.size/1024).toFixed(0)} KB`}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>

            {/* Contador seleccionados */}
            {selectedDriveFiles.length > 0 && (
              <div style={{ margin: '10px 0 0', padding: '6px 10px', background: 'rgba(212,175,55,0.08)',
                borderRadius: 8, fontSize: 11, color: '#D4AF37', textAlign: 'center' }}>
                {selectedDriveFiles.length} campaña{selectedDriveFiles.length > 1 ? 's' : ''} seleccionada{selectedDriveFiles.length > 1 ? 's' : ''}
              </div>
            )}

            {/* Botones de acción */}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button
                disabled={!selectedDriveFiles.length || isLoadingDrive}
                onClick={() => handleMergeCampaigns(selectedDriveFiles, false)}
                style={{
                  flex: 1, padding: '11px 8px', borderRadius: 10, fontSize: 12, fontWeight: 700,
                  background: selectedDriveFiles.length ? 'rgba(59,130,246,0.15)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${selectedDriveFiles.length ? 'rgba(59,130,246,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  color: selectedDriveFiles.length ? '#60A5FA' : '#555',
                  cursor: selectedDriveFiles.length ? 'pointer' : 'not-allowed', fontFamily: 'Inter, sans-serif',
                }}>
                {isLoadingDrive ? '⏳' : '➕ Agregar al mapa'}
              </button>
              <button
                disabled={!selectedDriveFiles.length || isLoadingDrive}
                onClick={() => handleMergeCampaigns(selectedDriveFiles, true)}
                style={{
                  flex: 1, padding: '11px 8px', borderRadius: 10, fontSize: 12, fontWeight: 700,
                  background: selectedDriveFiles.length ? 'rgba(212,175,55,0.12)' : 'rgba(255,255,255,0.03)',
                  border: `1px solid ${selectedDriveFiles.length ? 'rgba(212,175,55,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  color: selectedDriveFiles.length ? '#D4AF37' : '#555',
                  cursor: selectedDriveFiles.length ? 'pointer' : 'not-allowed', fontFamily: 'Inter, sans-serif',
                }}>
                {isLoadingDrive ? '⏳' : '🔄 Reemplazar todo'}
              </button>
            </div>
            <p style={{ color: '#444', fontSize: 9, marginTop: 8, textAlign: 'center' }}>
              "Agregar" fusiona sin borrar lo actual · "Reemplazar" borra el mapa actual
            </p>
          </div>
        </div>
      )}


      {/* 9. Toast deshacer eliminación */}
      {lastDeleted && (
        <div style={{
          position: 'fixed', bottom: 100, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(20,20,22,0.97)', backdropFilter: 'blur(12px)',
          border: '1px solid rgba(185,28,28,0.5)', borderRadius: 12,
          padding: '12px 18px', zIndex: 2000, display: 'flex', alignItems: 'center', gap: 12,
          fontFamily: 'Inter, sans-serif', boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
          animation: 'fadeIn .2s ease'
        }}>
          <span style={{ fontSize: 13, color: '#ccc' }}>
            🗑️ Punto <b style={{ color: '#D4AF37' }}>{lastDeleted.muestras[0]?.cp}</b> eliminado
          </span>
          <button onClick={handleUndoDelete} style={{
            background: 'rgba(212,175,55,0.15)', border: '1px solid rgba(212,175,55,0.4)',
            color: '#D4AF37', borderRadius: 8, padding: '5px 12px', fontSize: 12,
            fontWeight: 700, cursor: 'pointer', fontFamily: 'Inter, sans-serif'
          }}>↩️ Deshacer</button>
          <button onClick={() => { clearTimeout(undoTimerRef.current); setLastDeleted(null) }} style={{
            background: 'none', border: 'none', color: '#555', cursor: 'pointer', fontSize: 14
          }}>×</button>
        </div>
      )}

      {showForm && (
        <PuntoForm
          position={clickPosition}
          initialData={editingStation}
          onSave={handleSavePunto}
          onClose={() => { setShowForm(false); setEditingStation(null); setClickPosition(null) }}
          nextCorrelativos={!editingStation ? getNextCorrelativos() : null}
        />
      )}

      {!showForm && !showSidebar && stations.length === 0 && (
        <div className="fade-in" style={{
          position: 'fixed', bottom: 80, left: '50%', transform: 'translateX(-50%)',
          background: 'rgba(10,10,11,0.88)', backdropFilter: 'blur(12px)',
          border: '1px solid rgba(212,175,55,0.3)', borderRadius: 99,
          padding: '10px 20px', fontSize: 13, color: '#D4AF37', zIndex: 999, whiteSpace: 'nowrap',
          fontFamily: 'Inter, sans-serif',
        }}>
          👆 Toca el mapa para registrar un punto de muestreo
        </div>
      )}

      {/* Botón GPS — solo posiciona el marcador */}
      <button onClick={() => {
        if (navigator.geolocation) {
          navigator.geolocation.getCurrentPosition(
            pos => setGpsPosition({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
            () => alert('GPS no disponible')
          )
        }
      }} style={{
        position: 'fixed', bottom: 96, right: 12, zIndex: 999,
        background: 'rgba(10,10,11,0.9)', border: '1px solid rgba(212,175,55,0.3)',
        color: '#fff', borderRadius: '50%', width: 44, height: 44,
        cursor: 'pointer', fontSize: 20, backdropFilter: 'blur(8px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }} title="Mostrar posición GPS">🛡️</button>

      {/* Botón REGISTRAR EN GPS — abre formulario directo en posición actual */}
      <button onClick={() => {
        if (!navigator.geolocation) { alert('GPS no disponible en este dispositivo'); return }
        navigator.geolocation.getCurrentPosition(
          pos => {
            const latlng = { lat: pos.coords.latitude, lng: pos.coords.longitude }
            setGpsPosition(latlng)
            setClickPosition(latlng)
            setEditingStation(null)
            setShowForm(true)
            setShowSidebar(false)
          },
          () => alert('No se pudo obtener la posición GPS.\nVerifica que el GPS esté activo y que hayas dado permiso.'),
          { enableHighAccuracy: true, timeout: 10000 }
        )
      }} style={{
        position: 'fixed', bottom: 40, right: 12, zIndex: 999,
        background: 'linear-gradient(135deg, #059669, #065f46)',
        border: '1px solid rgba(16,185,129,0.5)',
        color: '#fff', borderRadius: 14, padding: '10px 16px',
        cursor: 'pointer', fontSize: 13, fontWeight: 700,
        backdropFilter: 'blur(8px)', fontFamily: 'Inter, sans-serif',
        display: 'flex', alignItems: 'center', gap: 6,
        boxShadow: '0 4px 20px rgba(5,150,105,0.4)',
      }} title="Registrar punto en mi posición GPS">
        📍 Registrar aquí
      </button>
    </div>
  )
}
