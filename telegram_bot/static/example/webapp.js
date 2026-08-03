import * as maplibregl from 'https://unpkg.com/maplibre-gl@6.0.0/dist/maplibre-gl.mjs';

let isSearchFocused = false;
let userCoords = null;
let userMarker = null;
let activePianoCoords = null;
const markers = {};
let markersOnScreen = {};
let allFeatures = [];
const loadingIndicator = document.getElementById('loading-indicator');

const DATA_URL = "https://raw.githubusercontent.com/davixde/telegram-bot-vercel-python/refs/heads/master/world_pianos.json";

function safeGetStorage(key, defaultValue = null) {
    try {
        const value = localStorage.getItem(key);
        return value === null ? defaultValue : value;
    } catch (e) {
        return defaultValue;
    }
}

function safeSetStorage(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {}
}

function getTelegramWebApp() {
    const webapp = window.Telegram && window.Telegram.WebApp;
    if (!webapp) return null;
    // Outside Telegram, telegram-web-app.js still creates a stub with empty initData.
    // Only treat it as a real Mini App when initData is present.
    if (typeof webapp.initData === 'string' && webapp.initData.length > 0) {
        return webapp;
    }
    return null;
}

const tgWebApp = getTelegramWebApp();

if (tgWebApp) {
    tgWebApp.ready();
    if (tgWebApp.disableVerticalSwipes) {
        tgWebApp.disableVerticalSwipes();
    }
    if (typeof tgWebApp.requestFullscreen === 'function') {
        tgWebApp.requestFullscreen();
    } else if (typeof tgWebApp.expand === 'function') {
        tgWebApp.expand();
    }
    try {
        tgWebApp.setHeaderColor('#111111');
        tgWebApp.setBackgroundColor('#111111');
    } catch (e) {}
}

document.fonts.load("24px 'Inter'");
document.fonts.load("24px 'Open Sans'");
try {
    document.fonts.load('700 24px "SF Pro Rounded"').catch(() => {
    });
} catch (e) {
}

// MapLibre GL requires absolute sprite URLs. The style spec uses relative
// paths (e.g. "/static/example/sprite") so it works from any deployment;
// here we resolve them against the current origin at runtime. This keeps the
// same style.json working on localhost, Vercel, or any other host.
//
// NOTE: MapLibre calls transformStyle(previousStyle, nextStyle) — the style
// being loaded is the SECOND argument, so we must transform that one.
// IMPORTANT: MapLibre v6 does NOT forward the constructor's `transformStyle`
// option to setStyle(), so the style must be applied via map.setStyle(url,
// { transformStyle }) AFTER construction (see below).
function resolveRelativeSpriteUrls(previousStyle, nextStyle) {
    const style = nextStyle;
    if (!style || !style.sprite) return style;
    const origin = window.location.origin;
    const sprites = Array.isArray(style.sprite) ? style.sprite : [style.sprite];
    style.sprite = sprites.map(s => {
        if (typeof s === 'string' && !/^https?:\/\//.test(s)) {
            return new URL(s, origin).toString();
        }
        if (s && typeof s === 'object' && typeof s.url === 'string' && !/^https?:\/\//.test(s.url)) {
            return { ...s, url: new URL(s.url, origin).toString() };
        }
        return s;
    });
    return style;
}

function applyStyleWithAbsoluteSprites(map) {
    map.setStyle(window.styleJsonUrl || "/static/example/style.json", {
        transformStyle: resolveRelativeSpriteUrls
    });
}

// The style ships a local sprite sheet (telegram_bot/static/example/sprite*.png)
// rebuilt with Spreet --sdf covering the original sheet icons plus the MapTiler
// POI set resolved from temaki/maki — so no runtime icon fetching is needed.
// Icons that MapLibre can't find anywhere (rare OSM subclasses) fall back to
// the "fallback_dot" cell that is already baked into the sheet.
const map = new maplibregl.Map({
    container: 'map',
    center: [12.4964, 41.9028],
    zoom: 12,
    pitchWithRotate: true,
    dragRotate: true,
    touchZoomRotate: true,
    attributionControl: false
});
applyStyleWithAbsoluteSprites(map);

map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

// It stays closed: _updateCompact won't re-add
// maplibregl-compact-show once the maplibregl-compact class is present.
const attribEl = document.querySelector('#map .maplibregl-ctrl-attrib');
if (attribEl) {
    attribEl.classList.remove('maplibregl-compact-show');
    attribEl.removeAttribute('open');
}

function updateMapLanguage(lang) {
    if (!map) return;

    if (!map.isStyleLoaded()) {
        map.once('styledata', () => updateMapLanguage(lang));
        return;
    }

    function injectLanguage(expr, targetLang) {
        if (typeof expr === 'string') {
            if (expr === '{name}' || expr === 'name') {
                return [
                    'coalesce',
                    ['get', `name:${targetLang}`],
                    ['get', `name_${targetLang}`],
                    ['get', 'name:en'],
                    ['get', 'name']
                ];
            }
            return expr;
        }

        if (!Array.isArray(expr)) return expr;

        if (expr[0] === 'get' && typeof expr[1] === 'string') {
            const propName = expr[1];

            if (propName === 'name:nonlatin' || propName.includes('nonlatin')) {
                if (targetLang !== 'en') {
                    return '';
                }
                return expr;
            }

            if (propName.startsWith('name')) {
                return [
                    'coalesce',
                    ['get', `name:${targetLang}`],
                    ['get', `name_${targetLang}`],
                    ['get', 'name:en'],
                    ['get', 'name']
                ];
            }
        }

        return expr.map(child => injectLanguage(child, targetLang));
    }

    const layers = map.getStyle().layers || [];

    layers.forEach(layer => {
        if (layer.type === 'symbol' && layer.layout && layer.layout['text-field']) {
            const currentTextField = layer.layout['text-field'];
            const textFieldStr = JSON.stringify(currentTextField);

            if (textFieldStr.includes('name')) {
                const updatedTextField = injectLanguage(currentTextField, lang);
                map.setLayoutProperty(layer.id, 'text-field', updatedTextField);
            }
        }
    });
}

const appRoot = document.getElementById('app-root');
function lockAppHeight() {
    appRoot.style.height = (window.visualViewport ? window.visualViewport.height : window.innerHeight) + 'px';
}
lockAppHeight();

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        if (isSearchFocused) return;
        lockAppHeight();
        map.resize();
        if (typeof sheetState !== 'undefined' && sheetState !== 'closed') {
            snapTo(sheetState);
        }
    });
} else {
    window.addEventListener('resize', () => {
        if (isSearchFocused) return;
        lockAppHeight();
        map.resize();
        if (typeof sheetState !== 'undefined' && sheetState !== 'closed') {
            snapTo(sheetState);
        }
    });
}

if (tgWebApp) {
    tgWebApp.onEvent('viewportChanged', () => {
        if (isSearchFocused) return;
        map.resize();
        if (typeof sheetState !== 'undefined' && sheetState !== 'closed') {
            snapTo(sheetState);
        }
    });
}

map.touchZoomRotate.disableRotation();

function getAccessColor(access) {
    switch(access) {
        case 'public': 
        case 'yes': 
           return '#28a745';
        case 'customers': return '#ffc107';
        case 'private': 
        case 'no': 
           return '#dc3545';
        case 'permissive': return '#17a2b8';
        default: return '#6c757d';
    }
}

function getAccessLabel(access) {
    switch(access) {
        case 'public': 
        case 'yes': 
           return 'Public';
        case 'customers': return 'Customers Only';
        case 'private': 
        case 'no':
           return 'Private';
        case 'permissive': return 'Permissive';
        default: return 'Not specified';
    }
}

function getInstrumentLabel(inst) {
    switch(inst) {
        case 'digital_piano': return 'Digital Piano';
        case 'piano': return 'Piano';
        case 'grand_piano': return 'Grand Piano';
        case 'pipe_organ': return 'Pipe Organ';
        default: return 'Piano';
    }
}

function updateUserMarker(lat, lng) {
    if (lat === null || lng === null || isNaN(lat) || isNaN(lng)) return;
    if (!userMarker) {
        const el = document.createElement('div');
        el.className = 'user-location-marker';
        userMarker = new maplibregl.Marker({ element: el }).setLngLat([lng, lat]).addTo(map);
    } else {
        userMarker.setLngLat([lng, lat]);
    }
}

async function loadGlobalPianos() {
    try {
        const response = await fetch(DATA_URL);
        if (!response.ok) throw new Error(`Status: ${response.status}`);
        
        const data = await response.json();

        const features = (data.elements || [])
            .filter(el => el.id && (el.lon ?? el.center?.lon) !== undefined && (el.lat ?? el.center?.lat) !== undefined)
            .map(el => {
            const lon = el.lon || el.center?.lon;
            const lat = el.lat || el.center?.lat;
            const t = el.tags || {};
        
            const dates = [t['check_date'], t['survey:date'], t.last_seen].filter(Boolean).sort().reverse();

            return {
               type: 'Feature',
               geometry: { type: 'Point', coordinates: [Number(lon), Number(lat)] },
               properties: {
                id: Number(el.id),
                name: t.name || 'Piano',
                access: t.access || 'unknown',
                description: t.description || '',
                musical_instrument: t.musical_instrument || '',
                last_seen: dates[0] || 'Unknown',
                tags: t
            }
        };
    });

        allFeatures = features;

        map.getSource('pianos').setData({
            type: 'FeatureCollection',
            features: features
        });

        loadingIndicator.style.display = 'none';

    } catch (e) {
        loadingIndicator.innerText = "Error loading data.";
        loadingIndicator.style.background = "#dc3545";
    }
}

function isOlderThanFourYears(tags) {
    if (!tags) return false;
    const dateStr = tags['survey:date'] || tags['check_date'];
    if (!dateStr) return false;

    try {
        const match = dateStr.match(/^(\d{4})/);
        if (!match) return false;
        
        const year = parseInt(match[1], 10);
        const parsedDate = new Date(dateStr);
        if (isNaN(parsedDate.getTime())) {
            const currentYear = new Date().getFullYear();
            return (currentYear - year) > 4;
        }

        const now = new Date();
        const fourYearsInMs = 4 * 365.25 * 24 * 60 * 60 * 1000;
        return (now.getTime() - parsedDate.getTime()) > fourYearsInMs;
    } catch (e) {
        return false;
    }
}

function updateMarkers() {
    if (!map.getSource('pianos') || !map.isSourceLoaded('pianos')) return;

    const newMarkers = {};
    const features = map.querySourceFeatures('pianos');

    for (let i = 0; i < features.length; i++) {
        const coords = features[i].geometry.coordinates;
        const props = features[i].properties;
        
        if (!coords || coords[0] === null || coords[1] === null || isNaN(coords[0]) || isNaN(coords[1])) continue;

        const isCluster = !!props.cluster;
        const currentId = isCluster ? props.cluster_id : props.id;
        if (currentId === undefined || currentId === null) continue;

        const id = isCluster ? `c_${currentId}` : `p_${currentId}`;

        if (newMarkers[id]) continue;

        let marker = markers[id];
        if (!marker) {
            const el = document.createElement('div');
            
            if (isCluster) {
                el.className = 'custom-cluster-marker';
                el.innerText = props.point_count;
                
                el.addEventListener('click', () => {
                    map.easeTo({ center: coords, zoom: map.getZoom() + 2 });
                    snapTo('closed');
                });
                
                marker = markers[id] = new maplibregl.Marker({ element: el }).setLngLat(coords);
            } else {
                el.className = 'piano-marker';
                
                const fullFeature = allFeatures.find(f => f.properties.id === props.id);
                const tags = fullFeature ? (fullFeature.properties.tags || {}) : (props.tags || {});
                const access = fullFeature ? (fullFeature.properties.access || 'unknown') : (props.access || 'unknown');
                
                let markerSvgHtml = window.unknownSvg;
                if (isOlderThanFourYears(tags)) {
                    markerSvgHtml = window.stillHereSvg;
                } else if (access === 'public' || access === 'yes') {
                    markerSvgHtml = window.publicSvg;
                } else if (access === 'customers') {
                    markerSvgHtml = window.customersSvg;
                } else if (access === 'permissive') {
                    markerSvgHtml = window.permissiveSvg;
                } else if (access === 'students') {
                    markerSvgHtml = window.studentsSvg;
                } else {
                    markerSvgHtml = window.unknownSvg;
                }
                
                el.innerHTML = markerSvgHtml;

                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    map.flyTo({ center: coords, zoom: 15, essential: true });
                    const fullFeature = allFeatures.find(f => f.properties.id === props.id);
                    showBottomSheet(fullFeature ? fullFeature.properties : props, coords);
                });

                marker = markers[id] = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat(coords);
            }
        } else if (isCluster) {
            marker.getElement().innerText = props.point_count;
        }
        
        newMarkers[id] = marker;
        if (!markersOnScreen[id]) marker.addTo(map);
    }

    for (const id in markersOnScreen) {
        if (!newMarkers[id]) {
            markersOnScreen[id].remove();
        }
    }
    markersOnScreen = newMarkers;
}

function initLocation() {
    let tgLocationRequested = false;
    
    if (tgWebApp && tgWebApp.LocationManager) {
        const lm = tgWebApp.LocationManager;
        lm.init(function() {
            if (lm.isInited && lm.isLocationAvailable) {
                tgLocationRequested = true;
                lm.getLocation(function(data) {
                    if (data && data.latitude && data.longitude) {
                        userCoords = [data.longitude, data.latitude];
                        updateUserMarker(data.latitude, data.longitude);
                        map.flyTo({ center: userCoords, zoom: 14, essential: true });
                    } else {
                        fallbackGeolocation(true);
                    }
                });
            } else {
                fallbackGeolocation(true);
            }
        });

        setTimeout(() => {
            if (!tgLocationRequested && !userCoords) {
                fallbackGeolocation(true);
            }
        }, 3000);
    } else {
        fallbackGeolocation(true);
    }
}

function fallbackGeolocation(shouldCenter = false) {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude;
                const lng = position.coords.longitude;
                userCoords = [lng, lat];
                updateUserMarker(lat, lng);
                if (shouldCenter) {
                    map.flyTo({ center: userCoords, zoom: 14, essential: true });
                }
            },
            (error) => { console.error(error); },
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }
}

function startWatchingLocation() {
    if (tgWebApp && tgWebApp.LocationManager) {
        tgWebApp.onEvent('locationManagerUpdated', () => {
            const lm = tgWebApp.LocationManager;
            if (lm.isInited && lm.isLocationAvailable) {
                lm.getLocation((data) => {
                    if (data && data.latitude && data.longitude) {
                        userCoords = [data.longitude, data.latitude];
                        updateUserMarker(data.latitude, data.longitude);
                    }
                });
            }
        });
    }

    if (navigator.geolocation) {
        navigator.geolocation.watchPosition((position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            userCoords = [lng, lat];
            updateUserMarker(lat, lng);
        }, null, { enableHighAccuracy: true });
    }
}

map.on('load', () => {
    map.resize();

    updateMapLanguage(safeGetStorage('appLang', 'en'));

    map.addSource('pianos', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
        cluster: true,
        clusterMaxZoom: 13,
        clusterRadius: 50
    });

    map.addLayer({
        id: 'pianos-invisible-layer',
        type: 'circle',
        source: 'pianos',
        paint: {
            'circle-opacity': 0,
            'circle-radius': 12
        }
    });

    loadGlobalPianos();
    initLocation();
    startWatchingLocation();

    map.on('data', (e) => {
        if (e.sourceId !== 'pianos' || !e.isSourceLoaded) return;
        updateMarkers();
    });

    map.on('move', updateMarkers);
    map.on('moveend', updateMarkers);
    
    map.on('click', () => {
        snapTo('closed');
        searchResultsList.style.display = 'none';
    });
});

document.getElementById('locateBtn').addEventListener('click', () => {
    if (userCoords) {
        map.flyTo({ center: userCoords, zoom: 14, essential: true });
    } else {
        initLocation();
    }
});

/* Bottom Sheet Control */
const sheet = document.getElementById('bottom-sheet');
const sheetContent = document.getElementById('sheet-content');
const sheetDragZone = document.getElementById('sheetDragZone');
const sheetHeader = document.getElementById('sheetHeader');
const tabBar = document.querySelector('.tab-bar');

let currentTranslateY = window.innerHeight; 
let dragStartY = 0;
let dragStartTranslateY = 0;
let isDragging = false;
let sheetState = 'closed';

function getSnaps() {
    const h = window.innerHeight * 0.85; 
    const vh = window.innerHeight;
    return {
        closed: h,
        peek: Math.max(0, h - 190), 
        half: h - (vh * 0.50), 
        full: 0 
    };
}

function setTranslateY(val, animate = false) {
    const snaps = getSnaps();
    const h = window.innerHeight * 0.85;
    val = Math.max(0, Math.min(h, val));
    currentTranslateY = val;

    if (animate) {
        sheet.style.transition = 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)';
    } else {
        sheet.style.transition = 'none';
    }
    sheet.style.transform = `translateY(${val}px)`;

    const halfThreshold = snaps.peek - 20;
    if (val < halfThreshold) {
        sheetContent.style.opacity = '1';
        sheetContent.style.pointerEvents = 'auto';
    } else {
        sheetContent.style.opacity = '0';
        sheetContent.style.pointerEvents = 'none';
    }
}

function snapTo(state) {
    sheetState = state;
    const snaps = getSnaps();
    setTranslateY(snaps[state], true);
}

function handlePointerDown(e) {
    if (e.target.closest('button') || e.target.closest('input')) {
        return;
    }

    const isInsideContent = e.target.closest('#sheet-content');
    if (isInsideContent) {
        if (sheetState === 'full' && sheetContent.scrollTop > 0) {
            return; 
        }
    }

    isDragging = true;
    dragStartY = e.clientY;
    dragStartTranslateY = currentTranslateY;
    sheet.style.transition = 'none';
    sheet.setPointerCapture(e.pointerId);
}

function handlePointerMove(e) {
    if (!isDragging) return;
    const deltaY = e.clientY - dragStartY;
    let targetY = dragStartTranslateY + deltaY;

    if (targetY < 0) {
        targetY = targetY * 0.35; 
    }

    setTranslateY(targetY);
}

function handlePointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    sheet.releasePointerCapture(e.pointerId);

    const snaps = getSnaps();
    const diffClosed = Math.abs(currentTranslateY - snaps.closed);
    const diffPeek = Math.abs(currentTranslateY - snaps.peek);
    const diffHalf = Math.abs(currentTranslateY - snaps.half);
    const diffFull = Math.abs(currentTranslateY - snaps.full);

    const minDiff = Math.min(diffClosed, diffPeek, diffHalf, diffFull);

    if (minDiff === diffClosed) {
        snapTo('closed');
    } else if (minDiff === diffPeek) {
        snapTo('peek');
    } else if (minDiff === diffHalf) {
        snapTo('half');
    } else {
        snapTo('full');
    }
}

sheet.addEventListener('pointerdown', handlePointerDown);
sheet.addEventListener('pointermove', handlePointerMove);
sheet.addEventListener('pointerup', handlePointerUp);
sheet.addEventListener('pointercancel', handlePointerUp);

function getTagValue(tags, keyBase, lang) {
    if (!tags) return null;
    return tags[`${keyBase}:${lang}`] || tags[`${keyBase}-${lang}`] || tags[`${keyBase}_${lang}`] || null;
}

function resolveDescription(tags, targetLang, translationEnabled) {
    tags = tags || {};

    const nativeDesc = getTagValue(tags, 'description', targetLang);
    if (nativeDesc) {
        return { text: nativeDesc, originalText: null, needsTranslation: false };
    }

    let sourceText = null;
    let sourceLang = null;
    const englishDesc = getTagValue(tags, 'description', 'en');
    const defaultDesc = tags['description'] || null;

    if (englishDesc) {
        sourceText = englishDesc;
        sourceLang = 'en';
    } else if (defaultDesc) {
        sourceText = defaultDesc;
        sourceLang = 'auto';
    } else {
        for (const key in tags) {
            if (key.startsWith('description:') || key.startsWith('description-') || key.startsWith('description_')) {
                const parts = key.split(/[:\-_]/);
                if (parts[1]) {
                    sourceText = tags[key];
                    sourceLang = parts[1];
                    break;
                }
            }
        }
    }

    if (!sourceText) {
        return { text: 'No description provided.', originalText: null, needsTranslation: false };
    }

    if (!translationEnabled || (sourceLang === targetLang)) {
        return { text: sourceText, originalText: null, needsTranslation: false };
    }

    return { text: sourceText, originalText: sourceText, needsTranslation: true };
}

let currentTranslationText = "";
let currentOriginalText = "";
let isShowingOriginal = false;
let activePianoId = null;

function setupDescriptionToggle(translatedText, originalText) {
    currentTranslationText = translatedText;
    currentOriginalText = originalText;
    isShowingOriginal = false;

    const textEl = document.getElementById('info-desc');
    const toggleBtn = document.getElementById('info-desc-toggle');
    if (!toggleBtn) return;

    if (originalText && translatedText && originalText.trim().toLowerCase() !== translatedText.trim().toLowerCase()) {
        toggleBtn.style.display = 'inline-flex';
        const spanEl = toggleBtn.querySelector('span');
        if (spanEl) spanEl.innerText = 'Translated - See original';
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            if (isShowingOriginal) {
                if (textEl) textEl.innerText = currentTranslationText;
                if (spanEl) spanEl.innerText = 'Translated - See original';
                isShowingOriginal = false;
            } else {
                if (textEl) textEl.innerText = currentOriginalText;
                if (spanEl) spanEl.innerText = 'See translation';
                isShowingOriginal = true;
            }
        };
    } else {
        toggleBtn.style.display = 'none';
    }
}

function showBottomSheet(props, coords) {
    activePianoCoords = coords; 

    document.getElementById('sheet-title').innerText = props.name || 'Piano';
    
    const label = getInstrumentLabel(props.musical_instrument);
    document.getElementById('sheet-subtitle').innerText = label;

    const iconContainer = document.getElementById('sheet-icon');
    if (props.musical_instrument === 'pipe_organ') {
        iconContainer.innerHTML = window.organSvg;
    } else {
        iconContainer.innerHTML = window.pianoSvg;
    }

    document.getElementById('info-access').innerText = getAccessLabel(props.access);
    activePianoId = props.id;

    const textEl = document.getElementById('info-desc');
    const spinnerEl = document.getElementById('info-desc-spinner');
    const toggleBtn = document.getElementById('info-desc-toggle');

    if (toggleBtn) toggleBtn.style.display = 'none';
    if (spinnerEl) spinnerEl.style.display = 'none';

    const targetLang = safeGetStorage('appLang', 'en');
    const translationEnabled = safeGetStorage('translateEnabled', 'true') !== 'false';
    const resolved = resolveDescription(props.tags, targetLang, translationEnabled);

    if (resolved.needsTranslation) {
        if (textEl) textEl.innerText = '';
        if (spinnerEl) spinnerEl.style.display = 'inline-block';
        const requestPianoId = props.id;

        fetch('/api/translate/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Translate-Token': window.translateToken || ''
            },
            body: JSON.stringify({
                q: resolved.text,
                target: targetLang
            })
        })
        .then(res => res.json())
        .then(data => {
            if (activePianoId === requestPianoId) {
                if (spinnerEl) spinnerEl.style.display = 'none';
                const translated = (data && data.translatedText) ? data.translatedText : resolved.text;
                if (textEl) textEl.innerText = translated;
                setupDescriptionToggle(translated, resolved.text);
            }
        })
        .catch(() => {
            if (activePianoId === requestPianoId) {
                if (spinnerEl) spinnerEl.style.display = 'none';
                if (textEl) textEl.innerText = resolved.text;
            }
        });
    } else if (textEl) {
        textEl.innerText = resolved.text;
    }
    document.getElementById('info-type').innerText = label;
    
    const lastSeenEl = document.getElementById('info-last-seen');
    if (lastSeenEl) {
        lastSeenEl.innerText = props.last_seen || 'Unknown';
    }

    snapTo('peek'); 
}

/* Search Engine */
const searchInput = document.getElementById('search-input');
const searchResultsList = document.getElementById('searchResultsList');
const searchClearBtn = document.getElementById('search-clear-btn');

function performSearch(queryValue) {
    const val = queryValue.toLowerCase().trim();
    if (!val) {
        searchResultsList.style.display = 'none';
        searchClearBtn.style.display = 'none';
        return;
    }

    searchClearBtn.style.display = 'block';

    const filtered = allFeatures.filter(f => {
        const name = (f.properties.name || '').toLowerCase();
        const desc = (f.properties.description || '').toLowerCase();
        return name.includes(val) || desc.includes(val);
    }).slice(0, 10);

    if (filtered.length === 0) {
        searchResultsList.innerHTML = `<div class="search-result-item" style="color: #8e8e93; font-style: italic;">No pianos found</div>`;
    } else {
        searchResultsList.innerHTML = filtered.map(f => {
            return `
                <div class="search-result-item" data-id="${f.properties.id}">
                    <span class="search-result-name">${f.properties.name || 'Piano'}</span>
                    <span class="search-result-details">${getInstrumentLabel(f.properties.musical_instrument)} • ${getAccessLabel(f.properties.access)}</span>
                </div>
            `;
        }).join('');

        searchResultsList.querySelectorAll('.search-result-item').forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                selectPianoById(item.dataset.id);
            });
        });
    }

    searchResultsList.style.display = 'block';
}

function selectPianoById(id) {
    const feature = allFeatures.find(f => f.properties.id == id);
    if (feature) {
        const coords = feature.geometry.coordinates;
        searchInput.blur();
        searchResultsList.style.display = 'none';
        searchInput.value = feature.properties.name || 'Piano';
        
        map.flyTo({ center: coords, zoom: 15, essential: true });
        showBottomSheet(feature.properties, coords);
    }
}

searchInput.addEventListener('focus', () => {
    isSearchFocused = true;
    tabBar.style.transform = 'translateY(100px)';
    tabBar.style.opacity = '0';
    performSearch(searchInput.value);
});

searchInput.addEventListener('blur', () => {
    isSearchFocused = false;
    setTimeout(() => {
        if (document.activeElement !== searchInput) {
            tabBar.style.transform = 'translateY(0)';
            tabBar.style.opacity = '1';
            map.resize();
        }
    }, 150);
});

searchInput.addEventListener('input', (e) => {
    performSearch(e.target.value);
});

searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const val = searchInput.value.toLowerCase().trim();
        if (val) {
            const matched = allFeatures.find(f => {
                const name = (f.properties.name || '').toLowerCase();
                const desc = (f.properties.description || '').toLowerCase();
                return name.includes(val) || desc.includes(val);
            });
            if (matched) {
                selectPianoById(matched.properties.id);
            }
        }
    }
});

searchClearBtn.addEventListener('click', () => {
    searchInput.value = '';
    searchResultsList.style.display = 'none';
    searchClearBtn.style.display = 'none';
searchInput.focus();
});

/* Settings */
const langSelect = document.getElementById('settings-lang-select');
const translateToggle = document.getElementById('settings-translate-toggle');
const mapContainer = document.getElementById('map-container');
const searchContainer = document.querySelector('.search-container');
const settingsContainer = document.getElementById('settings-container');
const addContainer = document.getElementById('add-container');

if (langSelect) {
    langSelect.value = safeGetStorage('appLang', 'en');
    langSelect.addEventListener('change', (e) => {
        safeSetStorage('appLang', e.target.value);
        updateMapLanguage(e.target.value);
    });
}

if (translateToggle) {
    translateToggle.checked = safeGetStorage('translateEnabled', 'true') !== 'false';
    translateToggle.addEventListener('change', (e) => {
        safeSetStorage('translateEnabled', e.target.checked ? 'true' : 'false');
    });
}

/* Liquid Glass tab slider */
const tabSlider = document.getElementById('tabSlider');
const glassDisplacementMap = document.getElementById('glassDisplacementMap');
const liquidGlassDisplace = document.getElementById('liquidGlassDisplace');

function buildLiquidGlassMap(width, height, edgeRatio) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imgData = ctx.createImageData(width, height);
    const data = imgData.data;
    const cx = width / 2;
    const cy = height / 2;
    const rx = width / 2;
    const ry = height / 2;
    const innerEdge = 1 - edgeRatio;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const nx = (x - cx) / rx;
            const ny = (y - cy) / ry;
            const dist = Math.sqrt(nx * nx + ny * ny);
            const idx = (y * width + x) * 4;
            let r;
            let g;

            if (dist < innerEdge) {
                const pull = (1 - dist / innerEdge) * 5;
                r = 128 - nx * pull;
                g = 128 - ny * pull;
            } else {
                const t = Math.min(1, (dist - innerEdge) / edgeRatio);
                const strength = Math.pow(t, 1.7) * 120;
                const len = dist || 1;
                r = 128 + (nx / len) * strength;
                g = 128 + (ny / len) * strength;
            }

            data[idx] = Math.max(0, Math.min(255, r));
            data[idx + 1] = Math.max(0, Math.min(255, g));
            data[idx + 2] = 128;
            data[idx + 3] = 255;
        }
    }

    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL('image/png');
}

function refreshLiquidGlassMap() {
    if (!glassDisplacementMap || !tabSlider) return;
    const w = Math.max(40, Math.round(tabSlider.offsetWidth || 160));
    const h = Math.max(30, Math.round(tabSlider.offsetHeight || 56));
    const dataUrl = buildLiquidGlassMap(w, h, 0.45);
    glassDisplacementMap.setAttribute('href', dataUrl);
    glassDisplacementMap.setAttributeNS('http://www.w3.org/1999/xlink', 'href', dataUrl);
    if (liquidGlassDisplace) {
        liquidGlassDisplace.setAttribute('scale', '46');
    }
}

function positionSlider(tab, animate) {
    if (!tab || !tabSlider) return;
    if (!animate) {
        tabSlider.style.transition = 'none';
    }
    tabSlider.style.left = tab.offsetLeft + 'px';
    tabSlider.style.width = tab.offsetWidth + 'px';
    if (!animate) {
        void tabSlider.offsetWidth;
        tabSlider.style.transition = '';
    }
}

function playGlassSquish() {
    if (!tabSlider) return;
    tabSlider.classList.remove('morphing');
    void tabSlider.offsetWidth;
    tabSlider.classList.add('morphing');
    setTimeout(() => tabSlider.classList.remove('morphing'), 600);
}

const initiallyActiveTab = document.querySelector('.tab-item.active') || document.getElementById('tab-map');
positionSlider(initiallyActiveTab, false);
refreshLiquidGlassMap();

window.addEventListener('resize', () => {
    const activeTab = document.querySelector('.tab-item.active');
    positionSlider(activeTab, false);
    refreshLiquidGlassMap();
});

/* Tabs */
const tabs = document.querySelectorAll('.tab-item');
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        positionSlider(tab, true);
        playGlassSquish();
        snapTo('closed');

        if (tab.id === 'tab-settings') {
            if (mapContainer) mapContainer.style.display = 'none';
            if (searchContainer) searchContainer.style.display = 'none';
            if (settingsContainer) settingsContainer.style.display = 'flex';
            if (addContainer) addContainer.style.display = 'none';
        } else if (tab.id === 'tab-add') {
            if (mapContainer) mapContainer.style.display = 'none';
            if (searchContainer) searchContainer.style.display = 'none';
            if (settingsContainer) settingsContainer.style.display = 'none';
            if (addContainer) addContainer.style.display = 'flex';
            updateAddTabAuthViewState();
        } else {
            if (mapContainer) mapContainer.style.display = 'block';
            if (searchContainer) searchContainer.style.display = 'block';
            if (settingsContainer) settingsContainer.style.display = 'none';
            if (addContainer) addContainer.style.display = 'none';
            setTimeout(() => { map.resize(); }, 50);
        }
    });
});

/* Haversine distance calculator (meters) */
function calculateDistance(coords1, coords2) {
    const [lon1, lat1] = coords1;
    const [lon2, lat2] = coords2;
    const R = 6371e3; 
    const phi1 = lat1 * Math.PI / 180;
    const phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180;
    const deltaLambda = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(deltaPhi/2) * Math.sin(deltaPhi/2) +
              Math.cos(phi1) * Math.cos(phi2) *
              Math.sin(deltaLambda/2) * Math.sin(deltaLambda/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
}

function showNotification(msg) {
    if (tgWebApp && tgWebApp.showPopup) {
        tgWebApp.showPopup({ message: msg });
    } else {
        alert(msg);
    }
}

/* Action Handlers */
document.getElementById('btn-still-here').addEventListener('click', (e) => {
    e.stopPropagation();

    if (!activePianoCoords) return;

    if (!navigator.geolocation) {
        showNotification("Geolocation is not supported by your browser.");
        return;
    }

    navigator.geolocation.getCurrentPosition(
        (position) => {
            const lat = position.coords.latitude;
            const lng = position.coords.longitude;
            userCoords = [lng, lat];
            updateUserMarker(lat, lng);

            const distance = calculateDistance(userCoords, activePianoCoords);
            const MAX_DISTANCE = 150; 

            if (distance <= MAX_DISTANCE) {
                const lastSeenEl = document.getElementById('info-last-seen');
                if (lastSeenEl) {
                    lastSeenEl.innerText = "Just now (Confirmed)";
                }
                
                showNotification("Thank you for confirming!");
                
                // TODO: Send backend API update request here
            } else {
                showNotification("You are too far away from this piano to confirm its presence.");
            }
        },
        (error) => {
            showNotification("Unable to retrieve your current location. Please check your GPS settings.");
        },
        { enableHighAccuracy: true, timeout: 5000 }
    );
});

document.getElementById('btn-modify').addEventListener('click', (e) => { e.stopPropagation(); });
document.getElementById('btn-share').addEventListener('click', (e) => { e.stopPropagation(); });

// ==========================================================================
// OSM Authentication module
// Manages the full OAuth 2.0 PKCE flow lifecycle inside the Mini App.
//
// Token handoff strategies (in priority order):
//
//  1. URL query param  ?osm_token=...
//     Set by the Telegram bot message WebApp button. Works universally on
//     mobile and desktop regardless of which browser was used for OAuth.
//
//  2. localStorage  'osm_pending_token'
//     Written by the relay page. Works when the relay page and Mini App
//     share the same browser (Telegram Web). Picked up via 'storage' event
//     (real-time) or 'visibilitychange' (user switches back to Telegram).
//
//  3. postMessage   (tertiary / popup fallback)
//     Works only when window.opener is available, i.e. when the flow was
//     opened via window.open() and NOT via Telegram.WebApp.openLink().
// ==========================================================================

const osmAuth = (() => {
    // ── Storage keys ──────────────────────────────────────────────────────
    const TOKEN_KEY    = 'osm_access_token';
    const USERNAME_KEY = 'osm_username';
    const PENDING_KEY  = 'osm_pending_token';
    const PENDING_TS   = 'osm_pending_timestamp';
    const PENDING_TTL  = 5 * 60 * 1000; // 5 minutes max validity for pending token

    // ── DOM elements in the Settings tab ─────────────────────────────────
    const elLoggedIn      = document.getElementById('osm-logged-in');
    const elLoggedOut     = document.getElementById('osm-logged-out');
    const elUsername      = document.getElementById('osm-username');
    const elConnectBtn    = document.getElementById('osm-connect-btn');
    const elDisconnectBtn = document.getElementById('osm-disconnect-btn');

    // ── localStorage helpers ──────────────────────────────────────────────

    function getToken()      { return safeGetStorage(TOKEN_KEY, null); }
    function setToken(t)     { safeSetStorage(TOKEN_KEY, t); }
    function clearToken() {
        try { localStorage.removeItem(TOKEN_KEY);    } catch (e) {}
        try { localStorage.removeItem(USERNAME_KEY); } catch (e) {}
    }

    /**
     * Consume (read-and-delete) the pending token left by the relay page.
     * Returns the token string or null if absent / expired.
     */
    function consumePendingToken() {
        const token = safeGetStorage(PENDING_KEY, null);
        const ts    = parseInt(safeGetStorage(PENDING_TS, '0'), 10);
        try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
        try { localStorage.removeItem(PENDING_TS);  } catch (e) {}
        if (!token) return null;
        if (Date.now() - ts > PENDING_TTL) return null; // expired
        return token;
    }

    // ── OSM API ───────────────────────────────────────────────────────────

    async function fetchOsmUser(token) {
        const resp = await fetch(
            'https://api.openstreetmap.org/api/0.6/user/details.json',
            { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!resp.ok) throw new Error(`OSM API ${resp.status}`);
        const data = await resp.json();
        return data?.user?.display_name || null;
    }

    // ── UI helpers ────────────────────────────────────────────────────────

    function showLoggedIn(username) {
        if (elLoggedIn)  elLoggedIn.style.display  = 'flex';
        if (elLoggedOut) elLoggedOut.style.display = 'none';
        if (elUsername) {
            elUsername.classList.remove('loading');
            elUsername.textContent = username || 'OSM User';
        }
    }

    function showLoggedOut() {
        if (elLoggedIn)  elLoggedIn.style.display  = 'none';
        if (elLoggedOut) elLoggedOut.style.display = 'flex';
    }

    function showLoadingUsername() {
        if (elLoggedIn)  elLoggedIn.style.display  = 'flex';
        if (elLoggedOut) elLoggedOut.style.display = 'none';
        if (elUsername) {
            elUsername.textContent = 'Loading\u2026';
            elUsername.classList.add('loading');
        }
    }

    // ── Core: save token, update UI, fetch username ───────────────────────

    async function applyToken(token) {
        setToken(token);
        showLoadingUsername();
        try {
            const name = await fetchOsmUser(token);
            if (name) {
                safeSetStorage(USERNAME_KEY, name);
                showLoggedIn(name);
            } else {
                // Token invalid or revoked – clear it
                clearToken();
                showLoggedOut();
            }
        } catch (err) {
            console.warn('OSM user fetch failed:', err);
            // Network error: keep the token and show a generic label
            showLoggedIn(safeGetStorage(USERNAME_KEY, null));
        }
    }

    // ── Init ─────────────────────────────────────────────────────────────
    //
    // Called once on app load. Checks token sources in priority order:
    //   (a) ?osm_token= URL param   – from the bot message WebApp button
    //   (b) osm_pending_token       – from relay page in same-browser context
    //   (c) already-stored token    – from a previous session
    // ─────────────────────────────────────────────────────────────────────

    async function init() {
        // (a) Bot message path: token is in the URL query string.
        //     The Telegram bot sends a WebApp button pointing to
        //     WEBAPP_URL?osm_token=TOKEN. When the user taps it, Telegram
        //     opens the Mini App at exactly that URL.
        const urlParams = new URLSearchParams(window.location.search);
        const urlToken  = urlParams.get('osm_token');
        if (urlToken) {
            // Remove the token from the address bar immediately so it does
            // not linger in Telegram's title bar or the browser history.
            try {
                const clean = new URL(window.location.href);
                clean.searchParams.delete('osm_token');
                window.history.replaceState({}, '', clean.toString());
            } catch (e) {}
            await applyToken(urlToken);
            return;
        }

        // (b) Same-browser path: relay page wrote token to localStorage.
        const pendingToken = consumePendingToken();
        if (pendingToken) {
            await applyToken(pendingToken);
            return;
        }

        // (c) Restore an existing session from a previous login.
        const token = getToken();
        if (!token) { showLoggedOut(); return; }

        const cachedName = safeGetStorage(USERNAME_KEY, null);
        if (cachedName) {
            showLoggedIn(cachedName); // instant display while API refreshes
        } else {
            showLoadingUsername();
        }

        try {
            const name = await fetchOsmUser(token);
            if (name) {
                safeSetStorage(USERNAME_KEY, name);
                showLoggedIn(name);
            } else {
                // Token revoked or expired
                clearToken();
                showLoggedOut();
            }
        } catch (err) {
            console.warn('OSM user fetch failed:', err);
            // On network errors keep the cached name; don't log the user out
            if (!cachedName) { clearToken(); showLoggedOut(); }
        }
    }

    // ── Start login ───────────────────────────────────────────────────────
    //
    // Opens /api/osm/start/ in an external browser, passing the Telegram
    // user ID so the Django callback can send the return bot message.
    // ─────────────────────────────────────────────────────────────────────

    function startLogin() {
        const startUrl = window.osmOauthStartUrl;
        if (!startUrl) { console.error('osmOauthStartUrl not defined'); return; }

        const url = new URL(startUrl, window.location.href);

        // Include the Telegram user ID so the callback can message the user
        const tgUserId = tgWebApp?.initDataUnsafe?.user?.id;
        if (tgUserId) url.searchParams.set('tg_user_id', String(tgUserId));

        if (tgWebApp && typeof tgWebApp.openLink === 'function') {
            // Standard Telegram API: opens in the device's real browser.
            // try_instant_view: false is essential – without it Telegram may
            // render the OSM login as a plain-text instant view article.
            tgWebApp.openLink(url.href, { try_instant_view: false });
            tgWebApp.close()
        } else {
            // Non-Telegram context (browser testing): use a popup so
            // the postMessage fallback can still fire.
            window.open(url.href, 'osm_auth', 'width=520,height=720');
        }
    }

    // ── Storage event listener (Telegram Web / same-browser) ──────────────
    //
    // When the relay page (in a different tab of the SAME browser) writes
    // 'osm_pending_token', the 'storage' event fires here in real time.
    // This gives an instant UI update without any user interaction.
    // ─────────────────────────────────────────────────────────────────────

    function setupStorageListener() {
        window.addEventListener('storage', async (event) => {
            if (event.key !== PENDING_KEY || !event.newValue) return;
            const token = consumePendingToken();
            if (token) await applyToken(token);
        });
    }

    // ── Visibility change listener ────────────────────────────────────────
    //
    // Fires when the user switches back to Telegram (and thus to the Mini App)
    // after completing the OAuth flow in the external browser. At that moment
    // we check localStorage for a pending token as a belt-and-suspenders
    // measure alongside the bot message.
    // ─────────────────────────────────────────────────────────────────────

    function setupVisibilityListener() {
        document.addEventListener('visibilitychange', async () => {
            if (document.hidden) return;
            const token = consumePendingToken();
            if (token) await applyToken(token);
        });
    }

    // ── postMessage listener (popup / window.open fallback) ───────────────

    function setupMessageListener() {
        window.addEventListener('message', async (event) => {
            const data = event.data;
            if (!data) return;
            if (data.type !== 'osm_auth_success' && data.type !== 'osm_auth_error') return;

            // Strict origin check: only accept from our own domain
            if (event.origin !== window.location.origin) {
                console.warn(`OSM postMessage blocked: unexpected origin "${event.origin}"`);
                return;
            }

            if (data.type === 'osm_auth_error') {
                showNotification('OpenStreetMap login failed. Please try again.');
                showLoggedOut();
                return;
            }
            if (data.access_token) await applyToken(data.access_token);
        });
    }

    // ── Disconnect ────────────────────────────────────────────────────────

    function disconnect() { clearToken(); showLoggedOut(); }

    // ── Wire up buttons and listeners ─────────────────────────────────────

    if (elConnectBtn) {
        elConnectBtn.addEventListener('click', (e) => { e.stopPropagation(); startLogin(); });
    }
    if (elDisconnectBtn) {
        elDisconnectBtn.addEventListener('click', (e) => { e.stopPropagation(); disconnect(); });
    }

    setupMessageListener();
    setupStorageListener();
    setupVisibilityListener();

    return { init, getToken, clearToken };
})();

// Kick off the OSM auth UI (checks URL param, localStorage, cached session)
osmAuth.init();

// ==========================================================================
// Add Tab Module & OpenStreetMap OAuth 2 Submission
// ==========================================================================

// Keyboard open detection: prevent tab bar and floating buttons from jumping up when typing
document.addEventListener('focusin', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
        document.body.classList.add('keyboard-open');
        const appRoot = document.getElementById('app-root');
        if (appRoot) appRoot.classList.add('keyboard-open');
    }
});

document.addEventListener('focusout', (e) => {
    if (e.target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) {
        setTimeout(() => {
            const activeTag = document.activeElement ? document.activeElement.tagName : '';
            if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag)) {
                document.body.classList.remove('keyboard-open');
                const appRoot = document.getElementById('app-root');
                if (appRoot) appRoot.classList.remove('keyboard-open');
            }
        }, 50);
    }
});

// Dev mode: bypass OSM auth requirement when running on localhost
const IS_DEV_MODE = ['localhost', '127.0.0.1'].includes(window.location.hostname);

function updateAddTabAuthViewState() {
    const token = osmAuth.getToken();
    const loggedOutView = document.getElementById('add-logged-out');
    const loggedInView = document.getElementById('add-logged-in');
    // On localhost, always show the form even without a token
    if (!token && !IS_DEV_MODE) {
        if (loggedOutView) loggedOutView.style.display = 'flex';
        if (loggedInView) loggedInView.style.display = 'none';
    } else {
        if (loggedOutView) loggedOutView.style.display = 'none';
        if (loggedInView) loggedInView.style.display = 'flex';
    }
}

document.getElementById('add-goto-settings-btn')?.addEventListener('click', () => {
    const settingsTab = document.getElementById('tab-settings');
    if (settingsTab) settingsTab.click();
});

// HTML & XML escaping helpers
function escapeHtml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function escapeXml(str) {
    return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

// Add Form State
let addFormTags = [
    { key: 'amenity', value: 'piano', readonly: true }
];
let selectedPinCoords = null; // [lng, lat]

// Render Tag Editor List
function renderAddTagsList() {
    const container = document.getElementById('add-tags-list');
    const countEl = document.getElementById('add-tags-count');
    if (!container) return;

    if (countEl) {
        countEl.textContent = `${addFormTags.length} tag${addFormTags.length === 1 ? '' : 's'}`;
    }

    container.innerHTML = '';

    addFormTags.forEach((tag, idx) => {
        const item = document.createElement('div');
        item.className = 'tag-item-card';

        // Key element
        const keyBox = document.createElement('div');
        keyBox.className = 'tag-key-box';
        if (tag.readonly) {
            const keyInput = document.createElement('input');
            keyInput.type = 'text';
            keyInput.className = 'tag-key-input tag-readonly-input';
            keyInput.value = tag.key;
            keyInput.readOnly = true;
            keyInput.disabled = true;
            keyBox.appendChild(keyInput);
        } else {
            const keyInput = document.createElement('input');
            keyInput.type = 'text';
            keyInput.className = 'tag-key-input';
            keyInput.value = tag.key;
            keyInput.placeholder = 'Tag Key';
            keyInput.addEventListener('change', (e) => {
                tag.key = e.target.value.trim();
            });
            keyBox.appendChild(keyInput);
        }

        // Value element
        const valBox = document.createElement('div');
        valBox.className = 'tag-val-box';

        const keyLower = (tag.key || '').toLowerCase();

        if (tag.readonly) {
            const valInput = document.createElement('input');
            valInput.type = 'text';
            valInput.className = 'tag-val-input tag-readonly-input';
            valInput.value = tag.value;
            valInput.readOnly = true;
            valInput.disabled = true;
            valBox.appendChild(valInput);
        } else if (keyLower === 'indoor' || keyLower === 'covered') {
            // True / False selector (or yes / no)
            const select = document.createElement('select');
            select.className = 'tag-val-select';
            
            const isTrue = (tag.value === 'true' || tag.value === 'yes' || tag.value === true);
            
            select.innerHTML = `
                <option value="true" ${isTrue ? 'selected' : ''}>True (yes)</option>
                <option value="false" ${!isTrue ? 'selected' : ''}>False (no)</option>
            `;
            select.addEventListener('change', (e) => {
                if (keyLower === 'covered') {
                    tag.value = e.target.value === 'true' ? 'yes' : 'no';
                } else {
                    tag.value = e.target.value; // 'true' or 'false'
                }
            });
            valBox.appendChild(select);
        } else if (keyLower === 'wheelchair') {
            // True / False selector (default true)
            const select = document.createElement('select');
            select.className = 'tag-val-select';
            const isTrue = (tag.value !== 'false' && tag.value !== 'no');
            select.innerHTML = `
                <option value="true" ${isTrue ? 'selected' : ''}>True (yes)</option>
                <option value="false" ${!isTrue ? 'selected' : ''}>False (no)</option>
            `;
            select.addEventListener('change', (e) => {
                tag.value = e.target.value;
            });
            valBox.appendChild(select);
        } else if (keyLower === 'access') {
            // Multiple values selector (public, permissive, clients, students - default public)
            const select = document.createElement('select');
            select.className = 'tag-val-select';
            const values = ['public', 'permissive', 'clients', 'students'];
            const currentVal = values.includes(tag.value) ? tag.value : 'public';
            select.innerHTML = values.map(v => 
                `<option value="${v}" ${v === currentVal ? 'selected' : ''}>${v.charAt(0).toUpperCase() + v.slice(1)}</option>`
            ).join('');
            select.addEventListener('change', (e) => {
                tag.value = e.target.value;
            });
            valBox.appendChild(select);
        } else if (keyLower === 'airside') {
            // Selector yes / no
            const select = document.createElement('select');
            select.className = 'tag-val-select';
            const isYes = (tag.value === 'yes' || tag.value === 'true');
            select.innerHTML = `
                <option value="yes" ${isYes ? 'selected' : ''}>Yes</option>
                <option value="no" ${!isYes ? 'selected' : ''}>No</option>
            `;
            select.addEventListener('change', (e) => {
                tag.value = e.target.value;
            });
            valBox.appendChild(select);
        } else {
            // Standard text input
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'tag-val-input';
            input.value = tag.value || '';
            input.placeholder = 'Tag Value';
            input.addEventListener('change', (e) => {
                tag.value = e.target.value.trim();
            });
            valBox.appendChild(input);
        }

        item.appendChild(keyBox);
        item.appendChild(valBox);

        // Info button (OSM Wiki / Taginfo preview)
        const infoBtn = document.createElement('button');
        infoBtn.type = 'button';
        infoBtn.className = 'tag-info-btn';
        infoBtn.title = 'Tag info';
        infoBtn.innerHTML = '<span class="material-symbols-outlined">info</span>';
        infoBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openTagInfo(tag.key, tag.value);
        });
        item.appendChild(infoBtn);

        if (!tag.readonly) {
            const removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'tag-remove-btn';
            removeBtn.innerHTML = '&times;';
            removeBtn.addEventListener('click', () => {
                addFormTags.splice(idx, 1);
                renderAddTagsList();
            });
            item.appendChild(removeBtn);
        }

        container.appendChild(item);
    });
}

// Tag Info Modal & Taginfo API fetch
async function openTagInfo(key, val) {
    if (!key) return;
    const modal = document.getElementById('tag-info-modal');
    const titleEl = document.getElementById('tag-info-title');
    const spinner = document.getElementById('tag-info-spinner');
    const descEl = document.getElementById('tag-info-desc');
    const linkEl = document.getElementById('tag-info-link');

    if (modal) modal.style.display = 'flex';
    if (titleEl) titleEl.textContent = val ? `${key} = ${val}` : key;
    if (spinner) spinner.style.display = 'block';
    if (descEl) descEl.style.display = 'none';
    if (linkEl) linkEl.style.display = 'none';

    try {
        let foundPage = null;

        function pickUsablePage(pages) {
            return pages.find(p => p.lang === 'en' && (p.description || p.wiki_url)) || null;
        }

        if (val) {
            const tagApiUrl = `https://taginfo.openstreetmap.org/api/4/tag/wiki_pages?key=${encodeURIComponent(key)}&value=${encodeURIComponent(val)}&lang=en`;
            const tagResp = await fetch(tagApiUrl);
            if (tagResp.ok) {
                const tagData = await tagResp.json();
                foundPage = pickUsablePage(tagData.data || []);
            }
        }

        if (!foundPage) {
            const keyApiUrl = `https://taginfo.openstreetmap.org/api/4/key/wiki_pages?key=${encodeURIComponent(key)}&lang=en`;
            const keyResp = await fetch(keyApiUrl);
            if (keyResp.ok) {
                const keyData = await keyResp.json();
                foundPage = pickUsablePage(keyData.data || []);
            }
        }

        if (spinner) spinner.style.display = 'none';

        if (foundPage && (foundPage.description || foundPage.wiki_url)) {
            if (descEl) {
                descEl.textContent = foundPage.description || "No short description text available in OSM Wiki.";
                descEl.style.display = 'block';
            }
            if (linkEl && foundPage.wiki_url) {
                linkEl.href = foundPage.wiki_url;
                linkEl.style.display = 'inline-block';
            }
        } else {
            if (descEl) {
                const langMatch = key.match(/^description[:_-]([a-zA-Z]{2,3}(-[a-zA-Z]{2,4})?)$/i);
                if (langMatch) {
                    const langCode = langMatch[1].toLowerCase();
                    let languageName = langCode.toUpperCase();
                    try {
                        const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
                        languageName = displayNames.of(langCode) || languageName;
                    } catch (e) {}
                    descEl.textContent = `The description of this location in ${languageName}.`;
                } else {
                    descEl.textContent = `No detailed OSM Wiki description found for "${key}${val ? '=' + val : ''}".`;
                }
                descEl.style.display = 'block';
            }
        }
    } catch (err) {
        console.warn("Taginfo fetch error:", err);
        if (spinner) spinner.style.display = 'none';
        if (descEl) {
            descEl.textContent = `Tag: ${key}${val ? ' = ' + val : ''}`;
            descEl.style.display = 'block';
        }
    }
}

document.getElementById('tag-info-close-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('tag-info-modal');
    if (modal) modal.style.display = 'none';
});
document.getElementById('tag-info-backdrop')?.addEventListener('click', () => {
    const modal = document.getElementById('tag-info-modal');
    if (modal) modal.style.display = 'none';
});

// Initialize tag editor list
renderAddTagsList();

// Helper to add or update tag in list
function addTagOrUpdate(key, defaultVal) {
    const existing = addFormTags.find(t => (t.key || '').toLowerCase() === key.toLowerCase());
    if (existing) {
        existing.value = defaultVal;
    } else {
        addFormTags.push({ key, value: defaultVal });
    }
    renderAddTagsList();
}

// Name input warning logic: generic names in many languages (README: avoid generic names)
const addNameInput = document.getElementById('add-name-input');
const nameWarningDropdown = document.getElementById('name-warning-dropdown');

// Generic/redundant words for "piano" across languages.
// "piano" (substring) already covers en/it/es/fr/nl/sv/pt/... plus "pianoforte".
const GENERIC_NAME_WORDS = [
    // Latin script: languages where the word for piano isn't "piano"
    'klavier',    // de
    'klaver',     // da / no / sv
    'fortepian',  // pl
    'zongora',    // hu
    'piyano',     // tr
    // Cyrillic
    'фортепиано', // ru
    'пианино',    // ru
    'піаніно',    // uk
    // CJK and other scripts
    'ピアノ',      // ja
    '钢琴', '鋼琴', // zh (semplice / tradizionale)
    '피아노',      // ko
    'πιάνο',       // el
    'פסנתר',      // he
    'بيانو'        // ar
];

addNameInput?.addEventListener('input', (e) => {
    const text = (e.target.value || '').toLowerCase();
    const isGeneric = text.includes('public') || text.includes('street') || text.includes('piano')
        || GENERIC_NAME_WORDS.some(w => text.includes(w));
    if (nameWarningDropdown) nameWarningDropdown.style.display = isGeneric ? 'block' : 'none';
});

// Description language detection via /api/translate/ endpoint (returns detectedLanguage)
const addDescInput = document.getElementById('add-desc-input');
const descHintBox = document.getElementById('desc-hint-box');
const descHintText = document.getElementById('desc-hint-text');
const descLangChips = document.getElementById('desc-lang-chips');

let descCheckTimeout = null;

async function checkDescriptionLanguage() {
    if (!addDescInput || !descHintBox) return;
    const text = addDescInput.value.trim();

    if (!text || text.length < 3) {
        descHintBox.style.display = 'none';
        return;
    }

    try {
        const resp = await fetch('/api/translate/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Translate-Token': window.translateToken || ''
            },
            body: JSON.stringify({ q: text, target: 'en' })
        });

        if (!resp.ok) return;
        const data = await resp.json();
        const detectedLang = data.detectedLanguage;

        if (detectedLang && detectedLang !== 'en') {
            descHintBox.style.display = 'flex';
            if (descHintText) {
                descHintText.textContent = `Non-English text detected (${detectedLang.toUpperCase()}). Convert to tag?`;
            }
            if (descLangChips) {
                descLangChips.innerHTML = `
                    <button type="button" class="desc-lang-chip active-detected-chip" data-lang="${detectedLang}">
                        + description:${detectedLang}
                    </button>
                `;

                descLangChips.querySelector('.desc-lang-chip')?.addEventListener('click', () => {
                    addTagOrUpdate(`description:${detectedLang}`, text);
                    addDescInput.value = '';
                    descHintBox.style.display = 'none';
                });
            }
        } else {
            descHintBox.style.display = 'none';
        }
    } catch (err) {
        console.warn("Language detection error:", err);
    }
}

addDescInput?.addEventListener('blur', checkDescriptionLanguage);
addDescInput?.addEventListener('input', () => {
    if (descCheckTimeout) clearTimeout(descCheckTimeout);
    descCheckTimeout = setTimeout(checkDescriptionLanguage, 800);
});

// Presets Overlay Modal Handling
const presetOverlay = document.getElementById('preset-overlay');
const addTagTriggerBtn = document.getElementById('add-tag-trigger-btn');
const presetBackdrop = document.getElementById('preset-backdrop');
const presetCloseBtn = document.getElementById('preset-close-btn');
const presetBackBtn = document.getElementById('preset-back-btn');
const presetTitle = document.getElementById('preset-sheet-title');

function openPresetOverlay() {
    if (presetOverlay) presetOverlay.style.display = 'flex';
    showPresetView('main', 'Add Tag Presets');
}

function closePresetOverlay() {
    if (presetOverlay) presetOverlay.style.display = 'none';
}

function showPresetView(viewName, titleText) {
    const views = {
        'main': document.getElementById('preset-view-main'),
        'general-info': document.getElementById('preset-view-general-info'),
        'indoor-outdoor': document.getElementById('preset-view-indoor-outdoor'),
        'access': document.getElementById('preset-view-access'),
    };

    Object.keys(views).forEach(v => {
        if (views[v]) views[v].style.display = (v === viewName) ? 'grid' : 'none';
    });

    if (presetTitle) presetTitle.textContent = titleText;
    if (presetBackBtn) {
        presetBackBtn.style.display = (viewName === 'main') ? 'none' : 'flex';
    }
}

addTagTriggerBtn?.addEventListener('click', openPresetOverlay);
presetBackdrop?.addEventListener('click', closePresetOverlay);
presetCloseBtn?.addEventListener('click', closePresetOverlay);
presetBackBtn?.addEventListener('click', () => showPresetView('main', 'Add Tag Presets'));

// Handle preset button clicks
document.querySelectorAll('.preset-grid-card').forEach(card => {
    card.addEventListener('click', () => {
        const preset = card.dataset.preset;
        const action = card.dataset.action;

        if (preset) {
            if (preset === 'general-info') {
                showPresetView('general-info', 'General Info');
            } else if (preset === 'indoor-outdoor') {
                showPresetView('indoor-outdoor', 'Indoor / Outdoor');
            } else if (preset === 'wheelchair') {
                addTagOrUpdate('wheelchair', 'true');
                closePresetOverlay();
            } else if (preset === 'access') {
                showPresetView('access', 'Access');
            } else if (preset === 'custom') {
                addFormTags.push({ key: '', value: '' });
                renderAddTagsList();
                closePresetOverlay();
            }
        } else if (action) {
            if (action === 'add-level') {
                addTagOrUpdate('level', '0');
            } else if (action === 'add-indoor') {
                addTagOrUpdate('indoor', 'true');
            } else if (action === 'add-covered') {
                addTagOrUpdate('covered', 'yes');
            } else if (action === 'add-outdoor') {
                addTagOrUpdate('indoor', 'false');
            } else if (action === 'add-access') {
                addTagOrUpdate('access', 'public');
            } else if (action === 'add-airside') {
                addTagOrUpdate('airside', 'yes');
            } else if (action === 'add-access-students') {
                addTagOrUpdate('access', 'students');
            }
            closePresetOverlay();
        }
    });
});

// Location Map Embed & Map Location Picker Overlay Logic
let pickerMap = null;
let embedMap = null;
let embedMarker = null;

const mapPickerOverlay = document.getElementById('map-picker-overlay');
const locationTrigger = document.getElementById('add-location-trigger');
const locationBtn = document.getElementById('add-location-btn');
const mapPickerCloseBtn = document.getElementById('map-picker-back-btn');
const mapPickerConfirmBtn = document.getElementById('map-picker-confirm-btn');
const pickerLocateBtn = document.getElementById('pickerLocateBtn');
const embedChangeBtn = document.getElementById('add-location-embed-change-btn');

function renderLocationEmbedMap(lon, lat) {
    const triggerCard = document.getElementById('add-location-trigger');
    const embedContainer = document.getElementById('add-location-embed-container');
    const coordsEl = document.getElementById('add-location-embed-coords');

    if (triggerCard) triggerCard.style.display = 'none';
    if (embedContainer) embedContainer.style.display = 'block';
    if (coordsEl) coordsEl.textContent = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

    if (!embedMap) {
        embedMap = new maplibregl.Map({
            container: 'add-location-embed-map',
            center: [lon, lat],
            zoom: 16,
            attributionControl: false,
            interactive: false
        });
        applyStyleWithAbsoluteSprites(embedMap);

        // Create marker with pin.svg element
        const el = document.createElement('div');
        el.className = 'embed-marker-pin';
        el.style.width = '20px';
        el.style.height = '26px';
        el.style.cursor = 'pointer';
        el.innerHTML = window.pinSvg || `<img src="${window.pinSvgUrl}" width="20" height="26" />`;
        embedMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([lon, lat])
            .addTo(embedMap);
    } else {
        embedMap.setCenter([lon, lat]);
        if (embedMarker) embedMarker.setLngLat([lon, lat]);
        setTimeout(() => embedMap.resize(), 100);
    }
}

function openMapPicker() {
    if (mapPickerOverlay) mapPickerOverlay.style.display = 'flex';
    
    if (!pickerMap) {
        pickerMap = new maplibregl.Map({
            container: 'picker-map',
            center: selectedPinCoords || (userCoords ? userCoords : [12.4964, 41.9028]),
            zoom: 15,
            attributionControl: false
        });
        applyStyleWithAbsoluteSprites(pickerMap);
    } else {
        if (selectedPinCoords) {
            pickerMap.setCenter(selectedPinCoords);
        } else if (userCoords) {
            pickerMap.setCenter(userCoords);
        }
        setTimeout(() => pickerMap.resize(), 100);
    }
}

function closeMapPicker() {
    if (mapPickerOverlay) mapPickerOverlay.style.display = 'none';
}

locationTrigger?.addEventListener('click', openMapPicker);
locationBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    openMapPicker();
});
embedChangeBtn?.addEventListener('click', openMapPicker);
document.getElementById('add-location-embed-map')?.addEventListener('click', openMapPicker);
mapPickerCloseBtn?.addEventListener('click', closeMapPicker);

mapPickerConfirmBtn?.addEventListener('click', () => {
    if (!pickerMap) return;
    const center = pickerMap.getCenter();
    selectedPinCoords = [center.lng, center.lat];

    renderLocationEmbedMap(center.lng, center.lat);

    closeMapPicker();
});

pickerLocateBtn?.addEventListener('click', () => {
    if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(pos => {
            const lng = pos.coords.longitude;
            const lat = pos.coords.latitude;
            userCoords = [lng, lat];
            updateUserMarker(lat, lng);
            if (pickerMap) {
                pickerMap.flyTo({ center: [lng, lat], zoom: 17 });
            }
        }, () => {
            showNotification("Could not retrieve current location.");
        });
    }
});

// Map Picker Place Search (Nominatim)
const pickerSearchInput = document.getElementById('map-picker-search-input');
const pickerSearchResults = document.getElementById('mapPickerSearchResults');
const pickerSearchClear = document.getElementById('map-picker-search-clear');

let pickerSearchTimeout = null;

pickerSearchInput?.addEventListener('input', (e) => {
    const q = e.target.value.trim();
    if (pickerSearchClear) pickerSearchClear.style.display = q ? 'block' : 'none';

    if (pickerSearchTimeout) clearTimeout(pickerSearchTimeout);
    if (!q) {
        if (pickerSearchResults) pickerSearchResults.style.display = 'none';
        return;
    }

    pickerSearchTimeout = setTimeout(async () => {
        try {
            const resp = await fetch(`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}`);
            if (!resp.ok) return;
            const results = await resp.json();
            
            if (!pickerSearchResults) return;
            pickerSearchResults.innerHTML = '';

            if (results.length === 0) {
                pickerSearchResults.style.display = 'none';
                return;
            }

            results.slice(0, 5).forEach(res => {
                const item = document.createElement('div');
                item.className = 'search-result-item';
                item.innerHTML = `
                    <div class="search-result-name">${escapeHtml(res.display_name.split(',')[0])}</div>
                    <div class="search-result-details">${escapeHtml(res.display_name)}</div>
                `;
                item.addEventListener('click', () => {
                    const lat = parseFloat(res.lat);
                    const lon = parseFloat(res.lon);
                    if (pickerMap) pickerMap.flyTo({ center: [lon, lat], zoom: 16 });
                    pickerSearchResults.style.display = 'none';
                    pickerSearchInput.value = res.display_name.split(',')[0];
                });
                pickerSearchResults.appendChild(item);
            });
            pickerSearchResults.style.display = 'block';
        } catch (err) {
            console.warn("Location search error:", err);
        }
    }, 300);
});

pickerSearchClear?.addEventListener('click', () => {
    if (pickerSearchInput) pickerSearchInput.value = '';
    if (pickerSearchClear) pickerSearchClear.style.display = 'none';
    if (pickerSearchResults) pickerSearchResults.style.display = 'none';
});

// Commit to OpenStreetMap API
const addSubmitBtn = document.getElementById('add-submit-btn');

addSubmitBtn?.addEventListener('click', async () => {
    if (!selectedPinCoords) {
        showNotification("Please set a location pin on the map first.");
        return;
    }

    const token = osmAuth.getToken();

    // In dev mode on localhost, simulate a successful commit without hitting the OSM API
    if (IS_DEV_MODE && !token) {
        const nameInput = document.getElementById('add-name-input');
        const name = nameInput ? nameInput.value.trim() : '';
        showNotification(`[DEV] "${name || 'Piano'}" would be committed to OSM here.`);
        if (selectedPinCoords) {
            const [lon, lat] = selectedPinCoords;
            const devFeature = {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [lon, lat] },
                properties: {
                    id: 'dev-' + Date.now(),
                    name: name || 'Piano (dev)',
                    access: 'unknown',
                    musical_instrument: 'piano'
                }
            };
            allFeatures.push(devFeature);
            if (map.getSource('pianos')) {
                map.getSource('pianos').setData({ type: 'FeatureCollection', features: allFeatures });
            }
            const mapTab = document.getElementById('tab-map');
            if (mapTab) mapTab.click();
            map.flyTo({ center: [lon, lat], zoom: 16 });
        }
        return;
    }

    if (!token) {
        showNotification("Please log in with OpenStreetMap in Settings first.");
        return;
    }

    if (!selectedPinCoords) {
        showNotification("Please set a location pin on the map first.");
        return;
    }

    const nameInput = document.getElementById('add-name-input');
    const descInput = document.getElementById('add-desc-input');
    const name = nameInput ? nameInput.value.trim() : '';
    const description = descInput ? descInput.value.trim() : '';

    const [lon, lat] = selectedPinCoords;

    addSubmitBtn.disabled = true;
    addSubmitBtn.innerHTML = '<span class="material-symbols-outlined">sync</span> Committing...';

    try {
        // Step 1: Create changeset with changeset comment tag
        const commentText = name ? `Add piano location: ${name}` : 'Add new piano location via Telegram Bot';
        const csXml = `<osm><changeset><tag k="created_by" v="Telegram Piano Bot WebApp"/><tag k="comment" v="${escapeXml(commentText)}"/></changeset></osm>`;
        
        const csResp = await fetch('https://api.openstreetmap.org/api/0.6/changeset/create', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/xml'
            },
            body: csXml
        });

        if (!csResp.ok) {
            throw new Error(`Failed to create changeset (HTTP ${csResp.status})`);
        }

        const changesetId = (await csResp.text()).trim();

        // Step 2: Build Node XML
        let tagsXml = `<tag k="musical_instrument" v="piano"/>`;
        if (name) tagsXml += `<tag k="name" v="${escapeXml(name)}"/>`;
        if (description) tagsXml += `<tag k="description" v="${escapeXml(description)}"/>`;

        addFormTags.forEach(t => {
            if (t.key && t.value !== undefined && t.value !== '') {
                tagsXml += `<tag k="${escapeXml(t.key.trim())}" v="${escapeXml(String(t.value).trim())}"/>`;
            }
        });

        const nodeXml = `<osm><node lat="${lat}" lon="${lon}" changeset="${changesetId}">${tagsXml}</node></osm>`;
        
        const nodeResp = await fetch('https://api.openstreetmap.org/api/0.6/node/create', {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/xml'
            },
            body: nodeXml
        });

        if (!nodeResp.ok) {
            throw new Error(`Failed to create node (HTTP ${nodeResp.status})`);
        }

        const nodeId = (await nodeResp.text()).trim();

        // Step 3: Close changeset
        try {
            await fetch(`https://api.openstreetmap.org/api/0.6/changeset/${changesetId}/close`, {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
        } catch (e) {
            console.warn("Changeset close warning:", e);
        }

        showNotification(`Successfully committed to OpenStreetMap! (Node ID: ${nodeId})`);

        // Dynamically add feature to current map view
        const newFeature = {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: {
                id: Number(nodeId),
                name: name || 'Piano',
                access: addFormTags.find(t => (t.key || '').toLowerCase() === 'access')?.value || 'unknown',
                description: description,
                musical_instrument: 'piano',
                last_seen: 'Just now',
                tags: {
                    name,
                    description,
                    musical_instrument: 'piano',
                    ...Object.fromEntries(addFormTags.map(t => [t.key, t.value]))
                }
            }
        };

        allFeatures.push(newFeature);
        if (map.getSource('pianos')) {
            map.getSource('pianos').setData({
                type: 'FeatureCollection',
                features: allFeatures
            });
        }

        // Reset form
        if (nameInput) nameInput.value = '';
        if (descInput) descInput.value = '';
        selectedPinCoords = null;
        
        const titleEl = document.getElementById('add-location-title');
        const subEl = document.getElementById('add-location-coords');
        if (titleEl) titleEl.textContent = "Tap to set location on map";
        if (subEl) subEl.textContent = "No pin selected";
        
        addFormTags = [{ key: 'musical_instrument', value: 'piano', readonly: true }];
        renderAddTagsList();

        // Switch back to Map tab and fly to new node location
        const mapTab = document.getElementById('tab-map');
        if (mapTab) mapTab.click();
        map.flyTo({ center: [lon, lat], zoom: 16 });

    } catch (err) {
        console.error("OSM commit error:", err);
        showNotification(`Error saving to OpenStreetMap: ${err.message}`);
    } finally {
        addSubmitBtn.disabled = false;
        addSubmitBtn.innerHTML = '<span class="material-symbols-outlined">cloud_upload</span><span>Commit to OpenStreetMap</span>';
    }
});

