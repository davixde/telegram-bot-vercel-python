function appLog(msg) {
    console.log(`[WebApp] ${msg}`);
}


appLog("🚀 webapp.js loading...");

let isSearchFocused = false;
let userCoords = null;
let userMarker = null;
let activePianoCoords = null;
const markers = {};
let markersOnScreen = {};
let allFeatures = [];
let map;
const loadingIndicator = document.getElementById('loading-indicator');

const DATA_URL = "https://raw.githubusercontent.com/davixde/telegram-bot-vercel-python/refs/heads/master/world_pianos.json";

// Safe localStorage wrappers to prevent SecurityError inside restricted WebViews
function safeGetStorage(key, defaultValue = null) {
    try {
        return localStorage.getItem(key) || defaultValue;
    } catch (e) {
        appLog("localStorage not accessible: " + e);
        return defaultValue;
    }
}

function safeSetStorage(key, value) {
    try {
        localStorage.setItem(key, value);
    } catch (e) {
        appLog("Unable to save to localStorage: " + e);
    }
}

// 1. Telegram WebApp Initialization
if (window.Telegram && window.Telegram.WebApp) {
    const webapp = window.Telegram.WebApp;
    webapp.ready();
    
    try {
        if (webapp.disableVerticalSwipes) webapp.disableVerticalSwipes();
    } catch (e) {}

    try {
        if (webapp.isVersionAtLeast && webapp.isVersionAtLeast('8.0') && typeof webapp.requestFullscreen === 'function') {
            webapp.requestFullscreen();
        } else if (typeof webapp.expand === 'function') {
            webapp.expand(); 
        }
    } catch (e) {
        if (typeof webapp.expand === 'function') webapp.expand();
    }

    try {
        webapp.setHeaderColor('#111111');
        webapp.setBackgroundColor('#111111');
    } catch (e) {}

    appLog("✅ Telegram WebApp ready");
}

// 2. Viewport Height Management
const appRoot = document.getElementById('app-root');
function lockAppHeight() {
    if (!appRoot) return;
    const height = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    appRoot.style.height = height + 'px';
    if (map) {
        setTimeout(() => map.resize(), 100);
    }
}

// 3. Map Initialization
function initMap() {
    if (!window.maplibregl) {
        setTimeout(initMap, 100);
        return;
    }

    lockAppHeight();

    try {
        map = new maplibregl.Map({
            container: 'map',
            style: window.styleJsonUrl || "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
            center: [12.4964, 41.9028],
            zoom: 12,
            pitchWithRotate: true,
            dragRotate: true,
            touchZoomRotate: true,
            attributionControl: true
        });

        if (map.touchZoomRotate) {
            map.touchZoomRotate.disableRotation();
        }

        map.on('load', () => {
            map.resize();

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
        });

        map.on('data', (e) => {
            if (e.sourceId !== 'pianos' || !e.isSourceLoaded) return;
            updateMarkers();
        });

        map.on('move', updateMarkers);
        map.on('moveend', () => {
            updateMarkers();
            map.resize();
        });
        
        map.on('click', () => {
            snapTo('closed');
            if (searchResultsList) searchResultsList.style.display = 'none';
        });

    } catch (err) {
        appLog("Map initialization error: " + err);
    }
}

document.addEventListener("DOMContentLoaded", () => {
    initMap();
});

// Resize Event Listeners
if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => {
        if (!isSearchFocused) {
            lockAppHeight();
            if (typeof sheetState !== 'undefined' && sheetState !== 'closed') snapTo(sheetState);
        }
    });
} else {
    window.addEventListener('resize', () => {
        if (!isSearchFocused) {
            lockAppHeight();
            if (typeof sheetState !== 'undefined' && sheetState !== 'closed') snapTo(sheetState);
        }
    });
}

if (window.Telegram && window.Telegram.WebApp) {
    window.Telegram.WebApp.onEvent('viewportChanged', () => {
        if (!isSearchFocused) {
            lockAppHeight();
            if (typeof sheetState !== 'undefined' && sheetState !== 'closed') snapTo(sheetState);
        }
    });
}

// --- HELPERS ---

function getAccessColor(access) {
    switch(access) {
        case 'public': 
        case 'yes': return '#28a745';
        case 'customers': return '#ffc107';
        case 'private': 
        case 'no': return '#dc3545';
        case 'permissive': return '#17a2b8';
        default: return '#6c757d';
    }
}

function getAccessLabel(access) {
    switch(access) {
        case 'public': 
        case 'yes': return 'Public';
        case 'customers': return 'Customers Only';
        case 'private': 
        case 'no': return 'Private';
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
            .filter(el => {
                const lon = el.lon || (el.center && el.center.lon);
                const lat = el.lat || (el.center && el.center.lat);
                return el.id && lon !== undefined && lat !== undefined;
            })
            .map(el => {
                const lon = el.lon || (el.center && el.center.lon);
                const lat = el.lat || (el.center && el.center.lat);
                return {
                    type: 'Feature',
                    id: Number(el.id),
                    geometry: { type: 'Point', coordinates: [Number(lon), Number(lat)] },
                    properties: {
                        id: Number(el.id),
                        name: (el.tags && el.tags.name) || 'Piano',
                        access: (el.tags && el.tags.access) || 'unknown',
                        description: (el.tags && el.tags.description) || '',
                        musical_instrument: (el.tags && el.tags.musical_instrument) || '',
                        last_seen: (el.tags && el.tags.last_seen) || 'Unknown',
                        tags: el.tags || {}
                    }
                };
            });

        allFeatures = features;
        if (map && map.getSource('pianos')) {
            map.getSource('pianos').setData({ type: 'FeatureCollection', features: features });
        }
        if (loadingIndicator) loadingIndicator.style.display = 'none';

    } catch (e) {
        appLog("Error loading data: " + e);
        if (loadingIndicator) {
            loadingIndicator.innerText = "Error loading data.";
            loadingIndicator.style.background = "#dc3545";
        }
    }
}

function updateMarkers() {
    if (!map || !map.getSource('pianos') || !map.isSourceLoaded('pianos')) return;

    const newMarkers = {};
    const features = map.querySourceFeatures('pianos');

    for (let i = 0; i < features.length; i++) {
        const coords = features[i].geometry.coordinates;
        const props = features[i].properties;
        
        if (!coords || coords[0] === null || coords[1] === null || isNaN(coords[0]) || isNaN(coords[1])) continue;

        const isCluster = !!props.cluster;
        const rawId = isCluster ? props.cluster_id : (props.id !== undefined && props.id !== null ? props.id : features[i].id);
        if (rawId === undefined || rawId === null) continue;

        const currentId = String(rawId);
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
                el.innerHTML = window.markerSvg || `<div style="width:20px;height:20px;background:red;border-radius:50%;"></div>`;
                const pathEl = el.querySelector('.Colored');
                if (pathEl) {
                    pathEl.setAttribute('fill', getAccessColor(props.access));
                }

                el.addEventListener('click', (e) => {
                    e.stopPropagation();
                    map.flyTo({ center: coords, zoom: 15, essential: true });
                    const fullFeature = allFeatures.find(f => String(f.properties.id) === currentId);
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
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.LocationManager) {
        const lm = window.Telegram.WebApp.LocationManager;
        lm.init(function() {
            if (lm.isInited && lm.isLocationAvailable) {
                tgLocationRequested = true;
                lm.getLocation(function(data) {
                    if (data && data.latitude && data.longitude) {
                        userCoords = [data.longitude, data.latitude];
                        updateUserMarker(data.latitude, data.longitude);
                        if (map) map.flyTo({ center: userCoords, zoom: 14, essential: true });
                    } else {
                        fallbackGeolocation(true);
                    }
                });
            } else {
                fallbackGeolocation(true);
            }
        });
        setTimeout(() => { if (!tgLocationRequested && !userCoords) fallbackGeolocation(true); }, 3000);
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
                if (shouldCenter && map) map.flyTo({ center: userCoords, zoom: 14, essential: true });
            },
            (error) => {},
            { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
        );
    }
}

function startWatchingLocation() {
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.LocationManager) {
        window.Telegram.WebApp.onEvent('locationManagerUpdated', () => {
            const lm = window.Telegram.WebApp.LocationManager;
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

const locateBtn = document.getElementById('locateBtn');
if (locateBtn) {
    locateBtn.addEventListener('click', () => {
        if (userCoords && map) {
            map.flyTo({ center: userCoords, zoom: 14, essential: true });
        } else {
            initLocation();
        }
    });
}

// --- BOTTOM SHEET ---
const sheet = document.getElementById('bottom-sheet');
const sheetContent = document.getElementById('sheet-content');
const tabBar = document.querySelector('.tab-bar');

let currentTranslateY = window.innerHeight; 
let dragStartY = 0;
let dragStartTranslateY = 0;
let isDragging = false;
let sheetState = 'closed';

function getSnaps() {
    const h = window.innerHeight * 0.85; 
    const vh = window.innerHeight;
    return { closed: h, peek: Math.max(0, h - 190), half: h - (vh * 0.50), full: 0 };
}

function setTranslateY(val, animate = false) {
    if (!sheet) return;
    const snaps = getSnaps();
    const h = window.innerHeight * 0.85;
    val = Math.max(0, Math.min(h, val));
    currentTranslateY = val;

    sheet.style.transition = animate ? 'transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)' : 'none';
    sheet.style.transform = `translateY(${val}px)`;

    if (sheetContent) {
        const halfThreshold = snaps.peek - 20;
        if (val < halfThreshold) {
            sheetContent.style.opacity = '1';
            sheetContent.style.pointerEvents = 'auto';
        } else {
            sheetContent.style.opacity = '0';
            sheetContent.style.pointerEvents = 'none';
        }
    }
}

function snapTo(state) {
    sheetState = state;
    setTranslateY(getSnaps()[state], true);
}

function handlePointerDown(e) {
    if (e.target.closest('button') || e.target.closest('input')) return;
    const isInsideContent = e.target.closest('#sheet-content');
    if (isInsideContent && sheetState === 'full' && sheetContent && sheetContent.scrollTop > 0) return; 

    isDragging = true;
    dragStartY = e.clientY;
    dragStartTranslateY = currentTranslateY;
    if (sheet) {
        sheet.style.transition = 'none';
        sheet.setPointerCapture(e.pointerId);
    }
}

function handlePointerMove(e) {
    if (!isDragging) return;
    let targetY = dragStartTranslateY + (e.clientY - dragStartY);
    if (targetY < 0) targetY = targetY * 0.35; 
    setTranslateY(targetY);
}

function handlePointerUp(e) {
    if (!isDragging) return;
    isDragging = false;
    if (sheet) sheet.releasePointerCapture(e.pointerId);

    const snaps = getSnaps();
    const minDiff = Math.min(
        Math.abs(currentTranslateY - snaps.closed),
        Math.abs(currentTranslateY - snaps.peek),
        Math.abs(currentTranslateY - snaps.half),
        Math.abs(currentTranslateY - snaps.full)
    );

    if (minDiff === Math.abs(currentTranslateY - snaps.closed)) snapTo('closed');
    else if (minDiff === Math.abs(currentTranslateY - snaps.peek)) snapTo('peek');
    else if (minDiff === Math.abs(currentTranslateY - snaps.half)) snapTo('half');
    else snapTo('full');
}

if (sheet) {
    sheet.addEventListener('pointerdown', handlePointerDown);
    sheet.addEventListener('pointermove', handlePointerMove);
    sheet.addEventListener('pointerup', handlePointerUp);
    sheet.addEventListener('pointercancel', handlePointerUp);
}

// --- DESCRIPTIONS & TRANSLATION ---
function getTagValue(tags, keyBase, lang) {
    if (!tags) return null;
    return tags[`${keyBase}:${lang}`] || tags[`${keyBase}-${lang}`] || tags[`${keyBase}_${lang}`] || null;
}

function resolveDescription(tags, targetLang, translationEnabled) {
    tags = tags || {};
    const nativeDesc = getTagValue(tags, 'description', targetLang);
    if (nativeDesc) return { text: nativeDesc, originalText: null, needsTranslation: false };

    let sourceText = null, sourceLang = null;
    const englishDesc = getTagValue(tags, 'description', 'en');
    const defaultDesc = tags['description'] || null;

    if (englishDesc) { sourceText = englishDesc; sourceLang = 'en'; } 
    else if (defaultDesc) { sourceText = defaultDesc; sourceLang = 'auto'; } 
    else {
        for (const key in tags) {
            if (key.startsWith('description:') || key.startsWith('description-') || key.startsWith('description_')) {
                const parts = key.split(/[:\-_]/);
                if (parts[1]) { sourceText = tags[key]; sourceLang = parts[1]; break; }
            }
        }
    }

    if (!sourceText) return { text: 'No description provided.', originalText: null, needsTranslation: false };
    if (!translationEnabled || (sourceLang === targetLang)) return { text: sourceText, originalText: null, needsTranslation: false };

    return { text: sourceText, originalText: sourceText, needsTranslation: true };
}

let currentTranslationText = "", currentOriginalText = "", isShowingOriginal = false, activePianoId = null;

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
    activePianoId = props.id;

    const titleEl = document.getElementById('sheet-title');
    if (titleEl) titleEl.innerText = props.name || 'Piano';
    
    const label = getInstrumentLabel(props.musical_instrument);
    const subtitleEl = document.getElementById('sheet-subtitle');
    if (subtitleEl) subtitleEl.innerText = label;

    const iconContainer = document.getElementById('sheet-icon');
    if (iconContainer) {
        iconContainer.innerHTML = (props.musical_instrument === 'pipe_organ') ? (window.organSvg || '') : (window.pianoSvg || '');
    }

    const accessEl = document.getElementById('info-access');
    if (accessEl) accessEl.innerText = getAccessLabel(props.access);
    
    const typeEl = document.getElementById('info-type');
    if (typeEl) typeEl.innerText = label;
    
    const lastSeenEl = document.getElementById('info-last-seen');
    if (lastSeenEl) lastSeenEl.innerText = props.last_seen || 'Unknown';

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
            headers: { 'Content-Type': 'application/json', 'X-Translate-Token': window.translateToken || '' },
            body: JSON.stringify({ q: resolved.text, target: targetLang })
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
        .catch(err => {
            if (activePianoId === requestPianoId) {
                if (spinnerEl) spinnerEl.style.display = 'none';
                if (textEl) textEl.innerText = resolved.text;
            }
        });
    } else {
        if (textEl) textEl.innerText = resolved.text;
    }

    snapTo('peek'); 
}

// --- SEARCH & TABS ---
const searchInput = document.getElementById('search-input');
const searchResultsList = document.getElementById('searchResultsList');
const searchClearBtn = document.getElementById('search-clear-btn');

function performSearch(queryValue) {
    if (!searchResultsList) return;
    const val = queryValue.toLowerCase().trim();
    if (!val) {
        searchResultsList.style.display = 'none';
        if (searchClearBtn) searchClearBtn.style.display = 'none';
        return;
    }
    if (searchClearBtn) searchClearBtn.style.display = 'block';
    
    const filtered = allFeatures.filter(f => {
        const name = (f.properties.name || '').toLowerCase();
        const desc = (f.properties.description || '').toLowerCase();
        return name.includes(val) || desc.includes(val);
    }).slice(0, 10);

    if (filtered.length === 0) {
        searchResultsList.innerHTML = `<div class="search-result-item" style="color: #8e8e93; font-style: italic;">No pianos found</div>`;
    } else {
        searchResultsList.innerHTML = filtered.map(f => `
            <div class="search-result-item" data-id="${f.properties.id}">
                <span class="search-result-name">${f.properties.name || 'Piano'}</span>
                <span class="search-result-details">${getInstrumentLabel(f.properties.musical_instrument)} • ${getAccessLabel(f.properties.access)}</span>
            </div>
        `).join('');

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
    if (feature && map) {
        const coords = feature.geometry.coordinates;
        if (searchInput) searchInput.blur();
        if (searchResultsList) searchResultsList.style.display = 'none';
        if (searchInput) searchInput.value = feature.properties.name || 'Piano';
        map.flyTo({ center: coords, zoom: 15, essential: true });
        showBottomSheet(feature.properties, coords);
    }
}

if (searchInput) {
    searchInput.addEventListener('focus', () => {
        isSearchFocused = true;
        if (tabBar) {
            tabBar.style.transform = 'translateY(100px)';
            tabBar.style.opacity = '0';
        }
        performSearch(searchInput.value);
    });

    searchInput.addEventListener('blur', () => {
        isSearchFocused = false;
        setTimeout(() => {
            if (document.activeElement !== searchInput) {
                if (tabBar) {
                    tabBar.style.transform = 'translateY(0)';
                    tabBar.style.opacity = '1';
                }
                if (map) map.resize();
            }
        }, 150);
    });

    searchInput.addEventListener('input', (e) => performSearch(e.target.value));
    searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            const val = searchInput.value.toLowerCase().trim();
            if (val) {
                const matched = allFeatures.find(f => (f.properties.name || '').toLowerCase().includes(val) || (f.properties.description || '').toLowerCase().includes(val));
                if (matched) selectPianoById(matched.properties.id);
            }
        }
    });
}

if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        if (searchResultsList) searchResultsList.style.display = 'none';
        searchClearBtn.style.display = 'none';
        if (searchInput) searchInput.focus();
    });
}

// Settings Initialization
document.addEventListener('DOMContentLoaded', () => {
    try {
        const langSelect = document.getElementById('settings-lang-select');
        const translateToggle = document.getElementById('settings-translate-toggle');
        if (langSelect) {
            langSelect.value = safeGetStorage('appLang', 'en');
            langSelect.addEventListener('change', (e) => safeSetStorage('appLang', e.target.value));
        }
        if (translateToggle) {
            translateToggle.checked = safeGetStorage('translateEnabled', 'true') !== 'false';
            translateToggle.addEventListener('change', (e) => safeSetStorage('translateEnabled', e.target.checked ? 'true' : 'false'));
        }
    } catch(e) {
        appLog("Settings initialization error: " + e);
    }
});

const tabs = document.querySelectorAll('.tab-item');
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        snapTo('closed');

        const mapContainer = document.getElementById('map-container');
        const searchContainer = document.querySelector('.search-container');
        const settingsContainer = document.getElementById('settings-container');

        if (tab.id === 'tab-settings') {
            if (mapContainer) mapContainer.style.display = 'none';
            if (searchContainer) searchContainer.style.display = 'none';
            if (settingsContainer) settingsContainer.style.display = 'flex';
        } else {
            if (mapContainer) mapContainer.style.display = 'block';
            if (searchContainer) searchContainer.style.display = 'block';
            if (settingsContainer) settingsContainer.style.display = 'none';
            setTimeout(() => { if (map) map.resize(); }, 50);
        }
    });
});

function calculateDistance(coords1, coords2) {
    const [lon1, lat1] = coords1, [lon2, lat2] = coords2;
    const R = 6371e3, phi1 = lat1 * Math.PI / 180, phi2 = lat2 * Math.PI / 180;
    const deltaPhi = (lat2 - lat1) * Math.PI / 180, deltaLambda = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(deltaPhi/2) * Math.sin(deltaPhi/2) + Math.cos(phi1) * Math.cos(phi2) * Math.sin(deltaLambda/2) * Math.sin(deltaLambda/2);
    return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function showNotification(msg) {
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.showPopup) {
        window.Telegram.WebApp.showPopup({ message: msg });
    } else {
        alert(msg);
    }
}

const btnStillHere = document.getElementById('btn-still-here');
if (btnStillHere) {
    btnStillHere.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!activePianoCoords) return;
        if (!navigator.geolocation) return showNotification("Geolocation not supported.");

        navigator.geolocation.getCurrentPosition(
            (position) => {
                const lat = position.coords.latitude, lng = position.coords.longitude;
                userCoords = [lng, lat];
                updateUserMarker(lat, lng);
                if (calculateDistance(userCoords, activePianoCoords) <= 150) {
                    const lastSeenEl = document.getElementById('info-last-seen');
                    if (lastSeenEl) lastSeenEl.innerText = "Just now (Confirmed)";
                    showNotification("Thank you for confirming!");
                } else {
                    showNotification("You are too far away from this piano to confirm its presence.");
                }
            },
            () => showNotification("Unable to retrieve location."),
            { enableHighAccuracy: true, timeout: 5000 }
        );
    });
}