// content.js
// Injected into Instagram, TikTok, YouTube Shorts.
//
// WHAT IT DOES:
//   1. Listens for scroll events on the page
//   2. Keeps a running scroll counter
//   3. When scrollCount hits the threshold N, it injects a
//      full-screen overlay asking the user about their task
//   4. The overlay is "unskippable" — blocks pointer events
//      on the page until the user engages
//   5. Tracks time the overlay is up as "minutes saved" - change to self reported survey
//
// HOW THE INTERRUPT ALGORITHM WORKS:
//   N = max(MIN_SCROLLS, floor(hoursUntilDue / URGENCY_DIVISOR))
//
//   - hoursUntilDue: hours remaining until the soonest task
//   - URGENCY_DIVISOR: controls how aggressively N shrinks
//     as the deadline approaches (lower = more aggressive)
//   - MIN_SCROLLS: the floor — never interrupt more often
//     than every MIN_SCROLLS scrolls
//
//   Example with defaults (MIN_SCROLLS=3, URGENCY_DIVISOR=4):
//     Due in 48h → N = floor(48/4) = 12 scrolls between interrupts
//     Due in 12h → N = floor(12/4) = 3  scrolls (hits the minimum)
//     Due in 2h  → N = 3 (clamped to minimum)


(() => {
  // consts
  const MIN_SCROLLS     = 5;    // never fewer than 5 scrolls between interrupts
  const SCROLL_COOLDOWN = 400;  // ms — debounce so one "flick" = one scroll count

  // Maps popup urgency slider (1-4) → URGENCY_DIVISOR value.
  // Higher divisor = smaller threshold = more frequent interrupts.
  // Slider 1 (Chill) → divisor 16 (rare); Slider 4 (Max) → divisor 2 (very frequent).
  const URGENCY_DIVISOR_MAP = { 1: 16, 2: 8, 3: 4, 4: 2 };
  let urgencyDivisor = 8; // default: Normal (slider pos 2)

  // state
  let stateLoaded    = false;   // true after first refreshState() callback completes
  let threshold      = 10;      // default if no tasks exist (rarely interrupts)
  let lastScrollTime = 0;
  let overlayActive  = false;
  let tasks          = [];
  let isActive       = true;
  let bedtime        = null;
  let taskOrder      = [];
  let freeBlocks     = [];

  // surface-aware scroll state
  let currentSurface     = null;  // 'reels' | 'shorts' | 'home' | 'other'
  let sessionScrollCount = 0;     // total scrolls this session (for hard cap)
  // Note: per-escalation scroll counting is owned by ai.js (scrollsSinceLastStage)

  // first-run / watch-limit state
  let watchLimit   = null;   // user's preferred reel/minute cap
  let watchUnit    = 'count'; // 'count' | 'minutes'
  let firstRunDone = false;

  // Load tasks + active state from chrome.storage

  function refreshState() {
    chrome.storage.local.get(
      ['tasks', 'webeActive', 'bedtime', 'taskOrder', 'freeBlocks',
       'watchLimit', 'watchUnit', 'firstRunDone', 'urgencyLevel'],
      (data) => {
        tasks        = data.tasks      || [];
        isActive     = data.webeActive !== undefined ? data.webeActive : true;
        bedtime      = data.bedtime    || null;
        taskOrder    = data.taskOrder  || [];
        freeBlocks   = data.freeBlocks || [];
        watchLimit   = data.watchLimit ?? null;
        watchUnit    = data.watchUnit  || 'count';
        firstRunDone   = !!data.firstRunDone;
        urgencyDivisor = URGENCY_DIVISOR_MAP[data.urgencyLevel] ?? 8;
        recalcThreshold();
        if (!stateLoaded) {
          stateLoaded = true;
          handleUrlChange(); // first surface detection after state is known
        }
      }
    );
  }

  // Recalculate whenever storage changes (user adds/removes a task in popup)
  chrome.storage.onChanged.addListener(() => refreshState());

  // Initial load — handleUrlChange fires inside the callback above
  refreshState();

  // ---------- Surface detection ----------

  function getSurfaceFromUrl(urlStr) {
    try {
      const u    = new URL(urlStr, location.origin);
      const p    = u.pathname + (u.search || '') + (u.hash || '');
      const host = u.hostname;

      if (host.includes('youtube.com') && p.includes('/shorts'))                    return 'shorts';
      if (host.includes('tiktok.com')  && (/\/video\/|\/v\//).test(p))             return 'shorts';
      if (host.includes('vm.tiktok.com'))                                           return 'shorts';
      if (host.includes('instagram.com') && (/\/reel|\/reels\//).test(p))          return 'reels';

      // Home / feed pages — tracked separately but not interrupted
      if (host.includes('youtube.com')  && (p === '/' || p.startsWith('/feed') || p.startsWith('/results'))) return 'home';
      if (host.includes('instagram.com') && (p === '/' || p.startsWith('/explore')))                         return 'home';
      if (host.includes('tiktok.com')   && (p === '/' || p.includes('/for-you') || p.includes('/foryou')))   return 'home';

      return 'other';
    } catch (_) {
      return 'other';
    }
  }

  // SPA navigation hook — fires a synthetic 'locationchange' on any history mutation
  (function installLocationChangeHook() {
    const wrap = (type) => {
      const orig = history[type];
      return function () {
        const ret = orig.apply(this, arguments);
        window.dispatchEvent(new Event('locationchange'));
        return ret;
      };
    };
    history.pushState    = wrap('pushState');
    history.replaceState = wrap('replaceState');
    window.addEventListener('popstate',    () => window.dispatchEvent(new Event('locationchange')));
    window.addEventListener('hashchange',  () => window.dispatchEvent(new Event('locationchange')));
  })();

  function handleUrlChange() {
    const newSurface = getSurfaceFromUrl(location.href);
    if (newSurface !== currentSurface) onSurfaceChange(newSurface);
  }

  function onSurfaceChange(newSurface) {
    currentSurface = newSurface;

    // Only reset counters and check first-run when entering a watched surface.
    // For home/other, just updating currentSurface is enough — onScroll's
    // early-return handles the rest without wiping session progress.
    if (newSurface === 'reels' || newSurface === 'shorts') {
      sessionScrollCount = 0;
      recalcThreshold();
      if (window.resetEscalation) window.resetEscalation();
      if (!firstRunDone) showFirstRunPrompt();
    }
  }

  // SPA nav: fires normally on every URL change
  window.addEventListener('locationchange', handleUrlChange);

  // ---------- URL polling fallback ----------
  // Instagram (and some other SPAs) can navigate without triggering
  // pushState/replaceState in a way our hook catches. So we also poll
  // location.href every 2 seconds. If the URL changed since last check,
  // we call handleUrlChange() which will update currentSurface and
  // enable/disable scroll interception accordingly.
  let lastPolledHref = location.href;
  setInterval(() => {
    if (location.href !== lastPolledHref) {
      lastPolledHref = location.href;
      handleUrlChange();
    }
  }, 2000);

  // Calculate the interrupt threshold N

  const DIFFICULTY_MULT = { Easy: 2.0, Medium: 1.0, Hard: 0.6, Brutal: 0.4 };

  function recalcThreshold() {
    const sleepState = getSleepState();
    // Any sleep-aware state → interrupt aggressively
    if (sleepState !== 'none' && sleepState !== 'normal' && sleepState !== 'morning') {
      threshold = MIN_SCROLLS;
      return;
    }

    if (tasks.length === 0) { threshold = 999; return; }

    // Use modular deadlines so same-day tasks don't compete
    const scheduled = computeModularDeadlines(tasks, freeBlocks, taskOrder);

    let best = null, soonestMs = Infinity;
    scheduled.forEach(s => {
      const ms = new Date(s.effectiveDue) - Date.now();
      if (ms < soonestMs) { soonestMs = ms; best = s; }
    });

    const hoursLeft = Math.max(0, soonestMs / (1000 * 60 * 60));
    const diffMult  = DIFFICULTY_MULT[best.difficulty] ?? 1.0;
    const progMult  = 1 + ((best.progress ?? 0) / 100); // 1.0 – 2.0

    threshold = Math.max(MIN_SCROLLS,
      Math.floor(hoursLeft / urgencyDivisor * diffMult * progMult));
  }

  
  // Listen for scrolls

  // We use 'wheel' + 'touchend' to catch both desktop scroll
  // and mobile-style swipe. Debounced so rapid-fire events
  // from a single gesture only count as one scroll.

  function onScroll() {
    if (!isActive || overlayActive) return;

    // Only intercept reels/shorts — ignore home feed and other surfaces
    if (currentSurface !== 'reels' && currentSurface !== 'shorts') return;

    const now = Date.now();
    if (now - lastScrollTime < SCROLL_COOLDOWN) return;
    lastScrollTime = now;

    sessionScrollCount++;

    // Hard session cap check (runs before AI escalation)
    const cap = computeSessionCap();
    if (cap !== null && sessionScrollCount >= cap) {
      sessionScrollCount = 0;
      showHardBlock();
      return;
    }

    const action = window.getEscalationAction(threshold);
    if (!action) return; // not time yet

    recalcThreshold();

    // Check sleep state first — sleep overlays override AI escalation
    const sleepState = getSleepState();
    if (sleepState !== 'none' && sleepState !== 'normal' && sleepState !== 'morning') {
      overlayActive = true;
      buildSleepOverlay(Date.now(), sleepState);
      return;
    }

    // No tasks → nothing to show
    if (tasks.length === 0) return;

    // Build taskInfo for ai.js from the most urgent task
    const scheduled = computeModularDeadlines(tasks, freeBlocks, taskOrder);
    let urgentTask = scheduled[0];
    let soonestMs = Infinity;
    scheduled.forEach(s => {
      const ms = new Date(s.effectiveDue) - Date.now();
      if (ms < soonestMs) { soonestMs = ms; urgentTask = s; }
    });

    const taskInfo = {
      id:        urgentTask.id,
      name:      urgentTask.name,
      due:       urgentTask.effectiveDue || urgentTask.due,
      hoursLeft: soonestMs / (1000 * 60 * 60),
      progress:  urgentTask.progress ?? 0
    };

    overlayActive = true;
    const overlayStartTime = Date.now();

    if (action.hardBlock) {
      // Stage 4: permanent block with AI farewell roast
      window.showHardBlockAI(action.personality, taskInfo);
    } else {
      // Stages 1-3: chat overlay with AI conversation
      window.showChatOverlay(action.stage, action.personality, taskInfo, () => {
        // onDismiss callback — same cleanup as the original dismiss()
        const minutesOnOverlay = (Date.now() - overlayStartTime) / (1000 * 60);
        chrome.storage.local.get(['minutesSaved'], (data) => {
          const total = (data.minutesSaved || 0) + minutesOnOverlay;
          chrome.storage.local.set({ minutesSaved: total });
        });
        overlayActive = false;
      });
    }
  }

  window.addEventListener('wheel',    onScroll, { passive: true });
  window.addEventListener('touchend', onScroll, { passive: true });

  // Also catch keyboard-based scrolling (arrow keys, spacebar)
  window.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', ' ', 'PageDown'].includes(e.key)) {
      onScroll();
    }
  });

  function getSleepState() {
    if (!bedtime) return 'none';

    const [bh, bm] = bedtime.split(':').map(Number);
    const now = new Date();
    const bed = new Date(now);
    bed.setHours(bh, bm, 0, 0);

    const diff = now - bed; // ms after bedtime (negative = before bedtime)

    if (diff < -3600000)      return 'normal';
    if (diff < 0)             return 'winddown';
    if (diff <= 3600000)      return 'bedtime';
    if (diff <= 3 * 3600000)  return 'late';
    if (diff <= 9 * 3600000)  return 'allnighter';
    return 'morning';
  }

  // First-run prompt 

  function showFirstRunPrompt() {
    if (overlayActive) return;
    overlayActive = true;

    const overlay = document.createElement('div');
    overlay.id = 'webe-overlay';
    overlay.innerHTML = `
      <div id="webe-card">
        <div id="webe-logo">WEBE</div>
        <div id="webe-prompt" style="font-size:18px;font-weight:700;color:#fff;margin-bottom:8px;">
          How many reels do you want to watch?
        </div>
        <div id="webe-first-sub">Set a soft limit. WEBE will cut you off when the math says you've had enough.</div>
        <div id="webe-first-row">
          <input id="webe-first-count" type="number" min="1" step="1" placeholder="e.g. 10" />
          <select id="webe-first-unit">
            <option value="count">reels</option>
            <option value="minutes">minutes</option>
          </select>
        </div>
        <button id="webe-dismiss">Save &amp; Start</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #webe-overlay { position:fixed; inset:0; z-index:2147483647; background:rgba(0,0,0,0.92); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px); animation:webeFadeIn 0.25s ease; }
      @keyframes webeFadeIn { from{opacity:0} to{opacity:1} }
      #webe-card { background:#1a1a1a; border:1px solid #333; border-radius:16px; padding:32px 28px; max-width:380px; width:90%; text-align:center; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#e0e0e0; }
      #webe-logo { font-size:14px; font-weight:700; letter-spacing:0.1em; color:#4ade80; margin-bottom:20px; }
      #webe-first-sub { font-size:13px; color:#888; margin-bottom:20px; }
      #webe-first-row { display:flex; gap:8px; margin-bottom:20px; }
      #webe-first-count { flex:1; padding:10px; border-radius:8px; border:1px solid #333; background:#111; color:#e0e0e0; font-size:15px; outline:none; }
      #webe-first-count:focus { border-color:#4ade80; }
      #webe-first-unit { padding:10px; border-radius:8px; border:1px solid #333; background:#111; color:#e0e0e0; font-size:15px; cursor:pointer; }
      #webe-dismiss { width:100%; padding:12px; border:none; border-radius:10px; background:#4ade80; color:#0f0f0f; font-size:15px; font-weight:600; cursor:pointer; transition:background 0.15s; }
      #webe-dismiss:hover { background:#22c55e; }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    overlay.querySelector('#webe-dismiss').addEventListener('click', () => {
      const val  = Number(overlay.querySelector('#webe-first-count').value || 0);
      const unit = overlay.querySelector('#webe-first-unit').value;
      if (!val || val <= 0) {
        overlay.querySelector('#webe-first-count').style.borderColor = '#f87171';
        return;
      }
      watchLimit   = val;
      watchUnit    = unit;
      firstRunDone = true;
      chrome.storage.local.set({ watchLimit: val, watchUnit: unit, firstRunDone: true });
      overlay.remove();
      style.remove();
      document.body.style.overflow = '';
      overlayActive = false;
    });
  }

  // cap

  function computeSessionCap() {
    if (!watchLimit) return null;
    if (tasks.length === 0) return null;

    // Convert user preference to scroll count
    const userCap = watchUnit === 'minutes' ? Math.floor(watchLimit * 2) : watchLimit;

    // Compute logical max from task urgency (soonest effective due)
    const scheduled = computeModularDeadlines(tasks, freeBlocks, taskOrder);
    let best = null, soonestMs = Infinity;
    scheduled.forEach(s => {
      const ms = new Date(s.effectiveDue) - Date.now();
      if (ms < soonestMs) { soonestMs = ms; best = s; }
    });

    if (!best) return userCap;

    const hoursLeft      = Math.max(0, soonestMs / 3600000);
    const estimatedHours = ESTIMATE_HOURS[best.estimatedTime] ?? 1;
    const slackHours     = Math.max(0, hoursLeft - estimatedHours);
    const leisureMinutes = slackHours * 60 * 0.25;
    const logicalMax     = Math.max(1, Math.floor(leisureMinutes * 2)); // min 1 so cap always applies

    return Math.min(userCap, logicalMax);
  }

  function showHardBlock() {
    if (overlayActive) return;
    overlayActive = true;

    // Build context string from soonest task
    const scheduled = computeModularDeadlines(tasks, freeBlocks, taskOrder);
    let urgentTask = null, soonestMs = Infinity;
    scheduled.forEach(s => {
      const ms = new Date(s.effectiveDue) - Date.now();
      if (ms < soonestMs) { soonestMs = ms; urgentTask = s; }
    });

    const userCapStr = watchUnit === 'minutes' ? `${watchLimit} minutes` : `${watchLimit} reels`;
    const cap        = computeSessionCap();
    const logicalStr = cap !== null ? `${cap} reels` : '?';
    const taskCtx    = urgentTask
      ? `based on <strong>${escapeHtml(urgentTask.name)}</strong> due in ${Math.round(soonestMs / 3600000)}h`
      : 'given your upcoming tasks';

    const overlay = document.createElement('div');
    overlay.id = 'webe-overlay';
    overlay.innerHTML = `
      <div id="webe-card">
        <div id="webe-logo">WEBE</div>
        <div id="webe-sleep-icon">&#x1F6D1;</div>
        <div id="webe-sleep-title">Session limit reached.</div>
        <div id="webe-sleep-sub">
          You set <strong>${escapeHtml(userCapStr)}</strong>.
          WEBE calculated you can afford ${logicalStr} ${taskCtx}.
        </div>
        <div id="webe-hard-cta">Close this tab to continue working.</div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #webe-overlay { position:fixed; inset:0; z-index:2147483647; background:rgba(20,0,0,0.97); display:flex; align-items:center; justify-content:center; backdrop-filter:blur(8px); animation:webeFadeIn 0.25s ease; }
      @keyframes webeFadeIn { from{opacity:0} to{opacity:1} }
      #webe-card { background:#160a0a; border:1px solid #dc2626; border-radius:16px; padding:32px 28px; max-width:360px; width:90%; text-align:center; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; color:#e0e0e0; }
      #webe-logo { font-size:14px; font-weight:700; letter-spacing:0.1em; color:#f87171; margin-bottom:16px; }
      #webe-sleep-icon { font-size:40px; margin-bottom:12px; }
      #webe-sleep-title { font-size:20px; font-weight:700; color:#fff; margin-bottom:8px; }
      #webe-sleep-sub { font-size:13px; color:#ccc; margin-bottom:20px; line-height:1.5; }
      #webe-hard-cta { font-size:15px; font-weight:700; color:#f87171; padding:14px; border:1px solid #dc2626; border-radius:10px; }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    // No dismiss handler — intentionally blocks until tab is closed
  }

  function buildSleepOverlay(overlayStartTime, sleepState) {
    const [bh, bm] = bedtime.split(':').map(Number);
    const bedStr = `${String(bh).padStart(2,'0')}:${String(bm).padStart(2,'0')}`;

    const now = new Date();
    const bed = new Date(now);
    bed.setHours(bh, bm, 0, 0);
    const hoursOver = Math.floor((now - bed) / 3600000);

    const SLEEP_CONTENT = {
      winddown:   { icon: '&#x1F319;', title: 'Wind-down time.',       sub: `Bedtime is at ${escapeHtml(bedStr)}. Close this tab and start winding down.`, btn: 'Winding down &#x2192;' },
      bedtime:    { icon: '&#x1F319;', title: "It's bedtime.",          sub: `You set bedtime at ${escapeHtml(bedStr)}. Time to sleep.`,                     btn: 'Going to sleep &#x2192;' },
      late:       { icon: '&#x1F62A;', title: "You're up late.",        sub: `It's ${hoursOver}h past your bedtime. Sleep debt compounds fast.`,             btn: 'Going to sleep now &#x2192;' },
      allnighter: { icon: '&#x1F635;', title: "All-nighter alert.",     sub: `It's been ${hoursOver}h since your bedtime. This is hurting your focus.`,      btn: 'Okay, going to sleep &#x2192;' },
    };

    const c = SLEEP_CONTENT[sleepState] || SLEEP_CONTENT.bedtime;

    const overlay = document.createElement('div');
    overlay.id = 'webe-overlay';
    overlay.innerHTML = `
      <div id="webe-card">
        <div id="webe-logo">WEBE</div>
        <div id="webe-sleep-icon">${c.icon}</div>
        <div id="webe-sleep-title">${c.title}</div>
        <div id="webe-sleep-sub">${c.sub}</div>
        <button id="webe-dismiss">${c.btn}</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = `
      #webe-overlay {
        position: fixed; inset: 0; z-index: 2147483647;
        background: rgba(10,5,20,0.95);
        display: flex; align-items: center; justify-content: center;
        backdrop-filter: blur(8px);
        animation: webeFadeIn 0.25s ease;
      }
      @keyframes webeFadeIn { from { opacity:0; } to { opacity:1; } }
      #webe-card {
        background: #13101f;
        border: 1px solid #7c3aed;
        border-radius: 16px;
        padding: 32px 28px;
        max-width: 360px; width: 90%;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #e0e0e0;
      }
      #webe-logo { font-size:14px; font-weight:700; letter-spacing:0.1em; color:#a78bfa; margin-bottom:16px; }
      #webe-sleep-icon { font-size:40px; margin-bottom:12px; }
      #webe-sleep-title { font-size:20px; font-weight:700; color:#fff; margin-bottom:8px; }
      #webe-sleep-sub { font-size:13px; color:#999; margin-bottom:24px; }
      #webe-dismiss {
        width:100%; padding:12px; border:none; border-radius:10px;
        background:#7c3aed; color:#fff; font-size:15px; font-weight:600;
        cursor:pointer; transition:background 0.15s;
      }
      #webe-dismiss:hover { background:#6d28d9; }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    overlay.querySelector('#webe-dismiss').addEventListener('click', () => {
      dismiss(overlay, style, overlayStartTime);
    });
  }

  // Dismiss overlay & track minutes saved

  function dismiss(overlay, style, startTime) {
    // Calculate how long the overlay was visible (in minutes)
    const minutesOnOverlay = (Date.now() - startTime) / (1000 * 60);

    // Add to cumulative minutes saved
    chrome.storage.local.get(['minutesSaved'], (data) => {
      const total = (data.minutesSaved || 0) + minutesOnOverlay;
      chrome.storage.local.set({ minutesSaved: total });
    });

    // Clean up DOM
    overlay.remove();
    style.remove();
    document.body.style.overflow = '';
    overlayActive = false;
  }

  
  // Utility functions (duplicated here so content script is
  // self-contained — no imports in content scripts)
  

  const ESTIMATE_HOURS = {
    '15m': 0.25, '30m': 0.5, '1h': 1, '2h': 2, '4h+': 4, 'All day': 8
  };

  function computeModularDeadlines(tasks, freeBlocks, taskOrder) {
    const freeMap = Object.fromEntries((freeBlocks || []).map(b => [b.id, b]));
    const taskMap = Object.fromEntries(tasks.map(t => [t.id, t]));

    const groups = {};
    tasks.forEach(t => {
      const day = t.due.slice(0, 10);
      if (!groups[day]) groups[day] = [];
      groups[day].push(t);
    });

    const result = [];

    Object.values(groups).forEach((groupTasks) => {
      const deadlineMs = new Date(groupTasks[0].due).getTime();

      const groupIds = new Set(groupTasks.map(t => t.id));
      const ordered  = (taskOrder || []).filter(id => groupIds.has(id));
      const unordered = groupTasks.filter(t => !(taskOrder || []).includes(t.id)).map(t => t.id);
      const fullOrder = [...ordered, ...unordered];

      let cursor = deadlineMs;
      const effectiveDues = {};

      for (let i = fullOrder.length - 1; i >= 0; i--) {
        const id = fullOrder[i];
        if (taskMap[id]) {
          const t = taskMap[id];
          effectiveDues[id] = new Date(cursor);
          cursor -= (ESTIMATE_HOURS[t.estimatedTime] ?? 1) * 60 * 60 * 1000;
        } else if (freeMap[id]) {
          cursor -= freeMap[id].durationHours * 60 * 60 * 1000;
        }
      }

      groupTasks.forEach(t => {
        result.push({ ...t, effectiveDue: effectiveDues[t.id] || new Date(t.due) });
      });
    });

    return result;
  }

  function escapeHtml(str) {
    const d = document.createElement('span');
    d.textContent = str;
    return d.innerHTML;
  }


})();