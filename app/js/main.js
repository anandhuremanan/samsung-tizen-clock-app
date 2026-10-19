(function () {
    'use strict';

    var VERSION = '1.2.1';
    var REFRESH_MS = 3 * 60 * 60 * 1000; // re-fetch the photo list every 3 hours
    var CORNERS = ['tr', 'br', 'bl', 'tl']; // clockwise order for CH up
    var KEYS = { ENTER: 13, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, BACK: 10009, CH_UP: 427, CH_DOWN: 428 };

    // Each setting cycles through its options with OK or ◀ / ▶
    var SETTINGS = [
        { key: 'background', label: 'Background', options: [['photos', 'Photos'], ['black', 'Black']] },
        { key: 'motion', label: 'Photo motion', options: [['on', 'On'], ['off', 'Off']] },
        { key: 'format', label: 'Clock format', options: [['12', '12-hour'], ['24', '24-hour']] },
        { key: 'captions', label: 'Photo captions', options: [['on', 'On'], ['off', 'Off']] },
        { key: 'interval', label: 'Change photo every', initial: '60', options: [['30', '30 sec'], ['60', '1 min'], ['300', '5 min'], ['900', '15 min']] },
        { key: 'sources', label: 'Photo sources', options: [['all', 'Bing + Picsum'], ['picsum', 'Picsum only']] }
    ];

    var clockEl = document.getElementById('clock');
    var timeEl = document.getElementById('time');
    var dateEl = document.getElementById('date');
    var captionEl = document.getElementById('caption');
    var helpEl = document.getElementById('help');
    var settingsEl = document.getElementById('settings');
    var listEl = document.getElementById('settings-list');
    var layers = [document.getElementById('slideA'), document.getElementById('slideB')];

    var prefs = {};
    SETTINGS.forEach(function (s) { prefs[s.key] = load(s.key, s.initial || s.options[0][0]); });

    var state = {
        corner: load('corner', 'tr'),
        big: load('big', 'false') === 'true',
        photos: [],
        index: -1,
        front: 0,
        timer: null,
        settingsOpen: false,
        focus: 0
    };

    function load(key, fallback) {
        try { return localStorage.getItem('tvclock.' + key) || fallback; } catch (e) { return fallback; }
    }
    function save(key, value) {
        try { localStorage.setItem('tvclock.' + key, String(value)); } catch (e) { /* ignore */ }
    }

    // ---------- Clock ----------
    var DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    var tickTimer = null;

    function renderTime() {
        var d = new Date();
        var m = ('0' + d.getMinutes()).slice(-2);
        if (prefs.format === '24') {
            timeEl.textContent = ('0' + d.getHours()).slice(-2) + ':' + m;
        } else {
            timeEl.textContent = (d.getHours() % 12 || 12) + ':' + m;
            var ampm = document.createElement('span');
            ampm.className = 'ampm';
            ampm.textContent = d.getHours() < 12 ? 'AM' : 'PM';
            timeEl.appendChild(ampm);
        }
        dateEl.textContent = DAYS[d.getDay()] + ', ' + d.getDate() + ' ' + MONTHS[d.getMonth()];
        return d;
    }

    function tick() {
        var d = renderTime();
        shiftClock();
        // Re-run right after the next minute boundary so the display never lags
        clearTimeout(tickTimer);
        tickTimer = setTimeout(tick, 60000 - d.getSeconds() * 1000 - d.getMilliseconds() + 50);
    }

    function isBlack() {
        return prefs.background === 'black';
    }

    // On the black screen, nudge the clock a few pixels each minute so the same
    // pixels are not lit with the same digits for hours
    function shiftClock() {
        var range = isBlack() ? 16 : 0;
        clockEl.style.marginLeft = Math.round((Math.random() * 2 - 1) * range) + 'px';
        clockEl.style.marginTop = Math.round((Math.random() * 2 - 1) * range) + 'px';
    }

    // The black background always uses the big centered clock
    function isBig() {
        return state.big || isBlack();
    }

    function applyLayout() {
        clockEl.className = 'pill' + (isBig() ? ' big' : ' corner-' + state.corner);
        // Keep the caption out of the pill's way: use the bottom corner the pill isn't in
        captionEl.className = (!isBig() && state.corner === 'bl') ? 'right' : '';
    }

    function moveCorner(step) {
        if (isBlack()) return;
        if (state.big) { state.big = false; save('big', false); }
        var i = CORNERS.indexOf(state.corner);
        state.corner = CORNERS[(i + step + CORNERS.length) % CORNERS.length];
        save('corner', state.corner);
        applyLayout();
    }

    function toggleBig() {
        if (isBlack()) return;
        state.big = !state.big;
        save('big', state.big);
        applyLayout();
    }

    // ---------- Photos ----------
    function fetchJson(url) {
        return new Promise(function (resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.open('GET', url);
            xhr.timeout = 15000;
            xhr.onload = function () {
                try { resolve(JSON.parse(xhr.responseText)); } catch (e) { reject(e); }
            };
            xhr.onerror = xhr.ontimeout = reject;
            xhr.send();
        });
    }

    function bingPhotos() {
        if (prefs.sources !== 'all') return Promise.resolve([]);
        return fetchJson('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=en-IN')
            .then(function (data) {
                return (data.images || []).map(function (img) {
                    return {
                        url: 'https://www.bing.com' + img.urlbase + '_1920x1080.jpg',
                        caption: img.copyright || ''
                    };
                });
            })
            .catch(function () { return []; });
    }

    function picsumPhotos(count) {
        var seed = Date.now();
        var list = [];
        for (var i = 0; i < count; i++) {
            list.push({ url: 'https://picsum.photos/seed/' + (seed + i) + '/1920/1080', caption: '' });
        }
        return list;
    }

    function shuffle(arr) {
        for (var i = arr.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
        }
        return arr;
    }

    function refreshPhotos() {
        return bingPhotos().then(function (bing) {
            state.photos = shuffle(bing.concat(picsumPhotos(prefs.sources === 'all' ? 12 : 20)));
            state.index = -1;
        });
    }

    function preload(url) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(url); };
            img.onerror = reject;
            img.src = url;
        });
    }

    function show(step, attempts) {
        if (isBlack()) return;
        attempts = attempts || 0;
        if (!state.photos.length || attempts > state.photos.length) { schedule(); return; }
        state.index = (state.index + step + state.photos.length) % state.photos.length;
        var photo = state.photos[state.index];

        preload(photo.url).then(function () {
            if (isBlack()) return; // switched to Black while this photo was loading
            var next = layers[1 - state.front];
            var prev = layers[state.front];
            next.style.backgroundImage = 'url("' + photo.url + '")';
            next.className = 'slide show ' + (Math.random() < 0.5 ? 'drift-a' : 'drift-b');
            prev.classList.remove('show');
            state.front = 1 - state.front;
            captionEl.textContent = photo.caption;
            schedule();
        }, function () {
            show(step || 1, attempts + 1); // skip broken image
        });
    }

    function schedule() {
        clearTimeout(state.timer);
        state.timer = setTimeout(function () { show(1); }, Number(prefs.interval) * 1000);
    }

    // ---------- Settings ----------
    function applyPrefs() {
        document.body.classList.toggle('black-bg', isBlack());
        document.body.classList.toggle('no-motion', prefs.motion === 'off');
        document.body.classList.toggle('no-captions', prefs.captions === 'off');
        renderTime();
        shiftClock();
        applyLayout();
    }

    // Start or stop the slideshow to match the Background setting
    function startPhotos() {
        clearTimeout(state.timer);
        if (isBlack()) {
            layers.forEach(function (l) { l.className = 'slide'; l.style.backgroundImage = ''; });
            captionEl.textContent = '';
            return;
        }
        refreshPhotos().then(function () { show(1); });
    }

    function renderSettings() {
        listEl.innerHTML = '';
        SETTINGS.forEach(function (s, i) {
            var current = s.options.filter(function (o) { return o[0] === prefs[s.key]; })[0] || s.options[0];
            var li = document.createElement('li');
            if (i === state.focus) li.className = 'focus';
            var label = document.createElement('span');
            label.textContent = s.label;
            var value = document.createElement('span');
            value.className = 'value';
            value.textContent = current[1];
            li.appendChild(label);
            li.appendChild(value);
            listEl.appendChild(li);
        });
    }

    function changeSetting(step) {
        var s = SETTINGS[state.focus];
        var i = 0;
        s.options.forEach(function (o, n) { if (o[0] === prefs[s.key]) i = n; });
        prefs[s.key] = s.options[(i + step + s.options.length) % s.options.length][0];
        save(s.key, prefs[s.key]);
        applyPrefs();
        renderSettings();
        if (s.key === 'interval' && !isBlack()) schedule();
        if (s.key === 'sources' || s.key === 'background') startPhotos();
    }

    function openSettings() {
        state.settingsOpen = true;
        helpEl.classList.remove('show');
        renderSettings();
        settingsEl.classList.add('open');
        settingsEl.setAttribute('aria-hidden', 'false');
    }

    function closeSettings() {
        state.settingsOpen = false;
        settingsEl.classList.remove('open');
        settingsEl.setAttribute('aria-hidden', 'true');
    }

    function handleSettingsKey(code) {
        switch (code) {
            case KEYS.UP: state.focus = (state.focus - 1 + SETTINGS.length) % SETTINGS.length; renderSettings(); return true;
            case KEYS.DOWN: state.focus = (state.focus + 1) % SETTINGS.length; renderSettings(); return true;
            case KEYS.LEFT: changeSetting(-1); return true;
            case KEYS.RIGHT:
            case KEYS.ENTER: changeSetting(1); return true;
            case KEYS.BACK: closeSettings(); return true;
            default: return false;
        }
    }

    // ---------- Remote keys ----------
    function registerKeys() {
        try {
            tizen.tvinputdevice.registerKey('ChannelUp');
            tizen.tvinputdevice.registerKey('ChannelDown');
        } catch (e) { /* running outside a TV */ }
    }

    var helpTimer = null;
    function flashHelp(ms) {
        if (state.settingsOpen) return;
        helpEl.classList.add('show');
        clearTimeout(helpTimer);
        helpTimer = setTimeout(function () { helpEl.classList.remove('show'); }, ms || 5000);
    }

    // Belt and braces: the page should never scroll, so snap it back if anything does
    function pinScroll() {
        if (window.scrollX || window.scrollY) window.scrollTo(0, 0);
        document.documentElement.scrollLeft = document.documentElement.scrollTop = 0;
        document.body.scrollLeft = document.body.scrollTop = 0;
    }
    window.addEventListener('scroll', pinScroll, true);

    // Stop the TV's default arrow/channel handling (spatial navigation, scrolling)
    document.addEventListener('keyup', function (e) { e.preventDefault(); pinScroll(); });

    document.addEventListener('keydown', function (e) {
        if (state.settingsOpen && handleSettingsKey(e.keyCode)) {
            e.preventDefault();
            return;
        }
        switch (e.keyCode) {
            case KEYS.CH_UP: moveCorner(1); break;
            case KEYS.CH_DOWN: moveCorner(-1); break;
            case KEYS.ENTER: toggleBig(); break;
            case KEYS.RIGHT: show(1); break;
            case KEYS.LEFT: show(-1); break;
            case KEYS.UP:
            case KEYS.DOWN: openSettings(); break;
            case KEYS.BACK:
                try { tizen.application.getCurrentApplication().exit(); } catch (err) { /* not on TV */ }
                break;
            default: flashHelp(); return;
        }
        e.preventDefault();
    });

    // Stop the TV's own screensaver from taking over while this app is open
    function keepAwake() {
        try {
            webapis.appcommon.setScreenSaver(webapis.appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF);
        } catch (e) { /* not available */ }
    }

    // ---------- Start ----------
    document.getElementById('app-version').textContent = VERSION;
    registerKeys();
    keepAwake();
    applyPrefs();
    applyLayout();
    tick();
    flashHelp(7000);
    startPhotos();
    setInterval(function () { if (!isBlack()) refreshPhotos(); }, REFRESH_MS);
    document.addEventListener('visibilitychange', function () {
        if (!document.hidden) keepAwake();
    });
})();
