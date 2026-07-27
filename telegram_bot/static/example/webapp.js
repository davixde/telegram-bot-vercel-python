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
const map = new maplibregl.Map({
    container: 'map',
    style: window.styleJsonUrl || "/static/example/style.json",
    center: [12.4964, 41.9028],
    zoom: 12,
    pitchWithRotate: true,
    dragRotate: true,
    touchZoomRotate: true,
    attributionControl: false
});

map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');

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
        } else {
            if (mapContainer) mapContainer.style.display = 'block';
            if (searchContainer) searchContainer.style.display = 'block';
            if (settingsContainer) settingsContainer.style.display = 'none';
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
// Manages the full OAuth 2.0 PKCE flow lifecycle inside the Mini App:
//   - Persisting the access token in localStorage
//   - Fetching the OSM user profile to display the username
//   - Initiating the external OAuth flow via Telegram.WebApp.openLink
//   - Receiving the token back via a secure window.postMessage
// ==========================================================================

const osmAuth = (() => {
    // Storage keys
    const TOKEN_KEY    = 'osm_access_token';
    const USERNAME_KEY = 'osm_username';

    // DOM elements in the Settings tab
    const elLoggedIn     = document.getElementById('osm-logged-in');
    const elLoggedOut    = document.getElementById('osm-logged-out');
    const elUsername     = document.getElementById('osm-username');
    const elConnectBtn   = document.getElementById('osm-connect-btn');
    const elDisconnectBtn = document.getElementById('osm-disconnect-btn');

    // -----------------------------------------------------------------------
    // localStorage helpers
    // -----------------------------------------------------------------------

    function getToken() {
        return safeGetStorage(TOKEN_KEY, null);
    }

    function setToken(token) {
        safeSetStorage(TOKEN_KEY, token);
    }

    function clearToken() {
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) {}
        try { localStorage.removeItem(USERNAME_KEY); } catch (e) {}
    }

    // -----------------------------------------------------------------------
    // OSM API: fetch the authenticated user's display name
    // -----------------------------------------------------------------------

    async function fetchOsmUser(token) {
        const resp = await fetch(
            'https://api.openstreetmap.org/api/0.6/user/details.json',
            { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!resp.ok) throw new Error(`OSM API error: ${resp.status}`);
        const data = await resp.json();
        return data?.user?.display_name || null;
    }

    // -----------------------------------------------------------------------
    // UI helpers
    // -----------------------------------------------------------------------

    function showLoggedIn(username) {
        if (elLoggedIn)  elLoggedIn.style.display  = 'flex';
        if (elLoggedOut) elLoggedOut.style.display  = 'none';
        if (elUsername) {
            elUsername.classList.remove('loading');
            elUsername.textContent = username || 'OSM User';
        }
    }

    function showLoggedOut() {
        if (elLoggedIn)  elLoggedIn.style.display  = 'none';
        if (elLoggedOut) elLoggedOut.style.display  = 'flex';
    }

    function showLoadingUsername() {
        if (elLoggedIn)  elLoggedIn.style.display  = 'flex';
        if (elLoggedOut) elLoggedOut.style.display  = 'none';
        if (elUsername) {
            elUsername.textContent = 'Loading…';
            elUsername.classList.add('loading');
        }
    }

    // -----------------------------------------------------------------------
    // Initialise: restore state from cache on app start
    // -----------------------------------------------------------------------

    async function init() {
        const token = getToken();
        if (!token) {
            showLoggedOut();
            return;
        }

        // Try to use a cached username first for instant display
        const cachedName = safeGetStorage(USERNAME_KEY, null);
        if (cachedName) {
            showLoggedIn(cachedName);
        } else {
            showLoadingUsername();
        }

        // Refresh the username from the API in the background
        try {
            const name = await fetchOsmUser(token);
            if (name) {
                safeSetStorage(USERNAME_KEY, name);
                showLoggedIn(name);
            } else {
                // Token may be invalid – clear and show logged-out state
                clearToken();
                showLoggedOut();
            }
        } catch (err) {
            console.warn('OSM user fetch failed:', err);
            // Keep the cached name on network error; don't log the user out
            if (!cachedName) {
                clearToken();
                showLoggedOut();
            }
        }
    }

    // -----------------------------------------------------------------------
    // Initiate the OAuth flow
    // Opens the Django /api/osm/start/ endpoint in an external browser window
    // so the user can log in on openstreetmap.org without leaving Telegram.
    // -----------------------------------------------------------------------

    function startLogin() {
        const startUrl = window.osmOauthStartUrl;
        if (!startUrl) {
            console.error('osmOauthStartUrl is not defined.');
            return;
        }

        // Resolve relative URL to absolute (needed for openLink)
        const absoluteUrl = new URL(startUrl, window.location.href).href;

        if (tgWebApp && typeof tgWebApp.openLink === 'function') {
            // Primary path: opens a real browser tab outside Telegram.
            // try_instant_view: false prevents Telegram from rendering the
            // OSM login page as a plain-text instant view.
            tgWebApp.openLink(absoluteUrl, { try_instant_view: false });
        } else {
            // Fallback: standard popup; the relay page will postMessage back.
            window.open(absoluteUrl, 'osm_auth', 'width=520,height=720,noopener');
        }
    }

    // -----------------------------------------------------------------------
    // Handle the token arriving back via postMessage from the relay page.
    // We validate the origin strictly before accepting any data.
    // -----------------------------------------------------------------------

    function setupMessageListener() {
        window.addEventListener('message', async (event) => {
            // Security: only accept messages that look like our OSM auth relay.
            // We check that the data has the right type before doing anything.
            const data = event.data;
            if (!data || data.type !== 'osm_auth_success' && data.type !== 'osm_auth_error') {
                return; // Not our message
            }

            // Verify the origin: must match the host serving the Mini App
            // (i.e. the same Vercel domain) OR the same origin as this page.
            const expectedOrigin = window.location.origin;
            if (event.origin !== expectedOrigin) {
                console.warn(
                    `OSM postMessage rejected: unexpected origin "${event.origin}". ` +
                    `Expected "${expectedOrigin}".`
                );
                return;
            }

            if (data.type === 'osm_auth_error') {
                console.error('OSM auth error:', data.error);
                showNotification('OpenStreetMap login failed. Please try again.');
                showLoggedOut();
                return;
            }

            // Success: store the token and update the UI
            const token = data.access_token;
            if (!token) return;

            setToken(token);
            showLoadingUsername();

            try {
                const name = await fetchOsmUser(token);
                if (name) {
                    safeSetStorage(USERNAME_KEY, name);
                    showLoggedIn(name);
                } else {
                    clearToken();
                    showLoggedOut();
                }
            } catch (err) {
                console.warn('OSM user fetch after login failed:', err);
                // Still show as connected – the token is valid, name fetch may retry later
                showLoggedIn(null);
            }
        });
    }

    // -----------------------------------------------------------------------
    // Disconnect: clear stored credentials and update UI
    // -----------------------------------------------------------------------

    function disconnect() {
        clearToken();
        showLoggedOut();
    }

    // -----------------------------------------------------------------------
    // Wire up button event listeners
    // -----------------------------------------------------------------------

    if (elConnectBtn) {
        elConnectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            startLogin();
        });
    }

    if (elDisconnectBtn) {
        elDisconnectBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            disconnect();
        });
    }

    // Register the postMessage listener as soon as the module loads,
    // so tokens arriving in any order are always caught.
    setupMessageListener();

    // Expose minimal public API (useful for debugging or future extensions)
    return { init, getToken, clearToken };
})();

// Initialise the OSM auth UI once the module is set up
osmAuth.init();