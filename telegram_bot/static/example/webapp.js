let isSearchFocused = false;
let userCoords = null;
let userMarker = null;
let activePianoCoords = null;
const markers = {};
let markersOnScreen = {};
let allFeatures = [];
const loadingIndicator = document.getElementById('loading-indicator');

const DATA_URL = "https://raw.githubusercontent.com/davixde/telegram-bot-vercel-python/refs/heads/master/world_pianos.json";

if (window.Telegram && window.Telegram.WebApp) {
    const webapp = window.Telegram.WebApp;
    webapp.ready();
    if (webapp.disableVerticalSwipes) {
        webapp.disableVerticalSwipes();
    }
    if (typeof webapp.requestFullscreen === 'function') {
        webapp.requestFullscreen();
    } else {
        webapp.expand(); 
    }
    webapp.setHeaderColor('#111111');
    webapp.setBackgroundColor('#111111');
}

const map = new maplibregl.Map({
    container: 'map',
    style: window.styleJsonUrl || "/static/example/style.json",
    center: [12.4964, 41.9028],
    zoom: 12,
    pitchWithRotate: true,
    dragRotate: true,
    touchZoomRotate: true,
    attributionControl: true
});

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

if (window.Telegram && window.Telegram.WebApp) {
    window.Telegram.WebApp.onEvent('viewportChanged', () => {
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
                el.innerHTML = window.markerSvg;
                const pathEl = el.querySelector('.Colored');
                if (pathEl) {
                    pathEl.setAttribute('fill', getAccessColor(props.access));
                }

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
    
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.LocationManager) {
        const lm = window.Telegram.WebApp.LocationManager;
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

/* Helper to fetch tag values for different key formats: description:en, description-en, description_en */
function getTagValue(tags, keyBase, lang) {
    if (!tags) return null;
    return tags[`${keyBase}:${lang}`] || tags[`${keyBase}-${lang}`] || tags[`${keyBase}_${lang}`] || null;
}

/* Description language selection and translation strategy */
function resolveDescription(tags, targetLang, translationEnabled) {
    tags = tags || {};
    
    // 1. Check if target language description exists in tags
    const nativeDesc = getTagValue(tags, 'description', targetLang);
    if (nativeDesc) {
        return { text: nativeDesc, originalText: null, needsTranslation: false };
    }

    // 2. Select source description for fallback / translation
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
        // Look for any description variant (e.g., description:fr)
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

    // If translation is disabled or target language matches source language
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
        toggleBtn.querySelector('span').innerText = 'Translated - See original';
        toggleBtn.onclick = (e) => {
            e.stopPropagation();
            if (isShowingOriginal) {
                textEl.innerText = currentTranslationText;
                toggleBtn.querySelector('span').innerText = 'Translated - See original';
                isShowingOriginal = false;
            } else {
                textEl.innerText = currentOriginalText;
                toggleBtn.querySelector('span').innerText = 'See translation';
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
    document.getElementById('info-type').innerText = label;
    
    const lastSeenEl = document.getElementById('info-last-seen');
    if (lastSeenEl) {
        lastSeenEl.innerText = props.last_seen || 'Unknown';
    }

    // Description Handling & Translation
    const textEl = document.getElementById('info-desc');
    const spinnerEl = document.getElementById('info-desc-spinner');
    const toggleBtn = document.getElementById('info-desc-toggle');

    if (toggleBtn) toggleBtn.style.display = 'none';
    if (spinnerEl) spinnerEl.style.display = 'none';

    const targetLang = localStorage.getItem('appLang') || 'en';
    const translationEnabled = localStorage.getItem('translateEnabled') !== 'false';

    const resolved = resolveDescription(props.tags, targetLang, translationEnabled);

    if (resolved.needsTranslation) {
        textEl.innerText = '';
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
                textEl.innerText = translated;
                setupDescriptionToggle(translated, resolved.text);
            }
        })
        .catch(err => {
            console.error("Translation request failed:", err);
            if (activePianoId === requestPianoId) {
                if (spinnerEl) spinnerEl.style.display = 'none';
                textEl.innerText = resolved.text;
            }
        });
    } else {
        textEl.innerText = resolved.text;
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
}

if (searchClearBtn) {
    searchClearBtn.addEventListener('click', () => {
        if (searchInput) searchInput.value = '';
        if (searchResultsList) searchResultsList.style.display = 'none';
        searchClearBtn.style.display = 'none';
        if (searchInput) searchInput.focus();
    });
}

/* Settings Management */
const langSelect = document.getElementById('settings-lang-select');
const translateToggle = document.getElementById('settings-translate-toggle');
const mapContainer = document.getElementById('map-container');
const searchContainer = document.querySelector('.search-container');
const settingsContainer = document.getElementById('settings-container');

if (langSelect) {
    langSelect.value = localStorage.getItem('appLang') || 'en';
    langSelect.addEventListener('change', (e) => {
        localStorage.setItem('appLang', e.target.value);
    });
}

if (translateToggle) {
    const isEnabled = localStorage.getItem('translateEnabled') !== 'false';
    translateToggle.checked = isEnabled;
    translateToggle.addEventListener('change', (e) => {
        localStorage.setItem('translateEnabled', e.target.checked ? 'true' : 'false');
    });
}

/* Tabs */
const tabs = document.querySelectorAll('.tab-item');
tabs.forEach(tab => {
    tab.addEventListener('click', () => {
        tabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
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
    if (window.Telegram && window.Telegram.WebApp && window.Telegram.WebApp.showPopup) {
        window.Telegram.WebApp.showPopup({ message: msg });
    } else {
        alert(msg);
    }
}

/* Action Handlers */
const btnStillHere = document.getElementById('btn-still-here');
if (btnStillHere) {
    btnStillHere.addEventListener('click', (e) => {
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
}

const btnModify = document.getElementById('btn-modify');
if (btnModify) btnModify.addEventListener('click', (e) => { e.stopPropagation(); });

const btnShare = document.getElementById('btn-share');
if (btnShare) btnShare.addEventListener('click', (e) => { e.stopPropagation(); });