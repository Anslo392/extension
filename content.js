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
  const MIN_SCROLLS      = 3;   // never fewer than 3 scrolls between interrupts
  const URGENCY_DIVISOR  = 4;   // see algorithm explanation above
  const SCROLL_COOLDOWN  = 400; // ms — debounce so one "flick" = one scroll count

  // state
  let scrollCount    = 0;
  let threshold      = 10;      // default if no tasks exist (rarely interrupts)
  let lastScrollTime = 0;
  let overlayActive  = false;
  let tasks          = [];
  let isActive       = true;
  let bedtime        = null;
  let taskOrder      = [];
  let freeBlocks     = [];

    // --- Detect navigation changes (YouTube Shorts / TikTok style SPAs) ---
  let lastUrl = location.href;

  function handleNavigation() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;

      // Reset scroll counter for the new video
      scrollCount = 0;

      // Recalculate urgency
      recalcThreshold();
    }
  }

  // YouTube SPA navigation event
  document.addEventListener('yt-navigate-finish', handleNavigation);

  // fallback for other platforms
  setInterval(handleNavigation, 500);

  // Load tasks + active state from chrome.storage

  function refreshState() {
    chrome.storage.local.get(['tasks', 'webeActive', 'bedtime', 'taskOrder', 'freeBlocks'], (data) => {
      tasks      = data.tasks      || [];
      isActive   = data.webeActive !== undefined ? data.webeActive : true;
      bedtime    = data.bedtime    || null;
      taskOrder  = data.taskOrder  || [];
      freeBlocks = data.freeBlocks || [];
      recalcThreshold();
    });
  }

  // Recalculate whenever storage changes (user adds/removes a task in popup)
  chrome.storage.onChanged.addListener(() => refreshState());

  // Initial load
  refreshState();

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
      Math.floor(hoursLeft / URGENCY_DIVISOR * diffMult * progMult));
  }

  
  // Listen for scrolls

  // We use 'wheel' + 'touchend' to catch both desktop scroll
  // and mobile-style swipe. Debounced so rapid-fire events
  // from a single gesture only count as one scroll.

  function onScroll() {
    if (!isActive || overlayActive) return;

    const now = Date.now();
    if (now - lastScrollTime < SCROLL_COOLDOWN) return;
    lastScrollTime = now;

    scrollCount++;

    if (scrollCount >= threshold) {
      scrollCount = 0;
      recalcThreshold(); // recalc in case time has passed
      showOverlay();
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

  // Show the full-screen overlay

  function showOverlay() {
    if (overlayActive) return;
    overlayActive = true;

    const overlayStartTime = Date.now();

    // Show sleep overlay for any sleep-aware state
    const sleepState = getSleepState();
    if (sleepState !== 'none' && sleepState !== 'normal' && sleepState !== 'morning') {
      buildSleepOverlay(overlayStartTime, sleepState);
      return;
    }

    // Pick the task with the soonest modular effective deadline
    const scheduled = computeModularDeadlines(tasks, freeBlocks, taskOrder);
    let urgentTask = scheduled[0];
    let soonestMs = Infinity;
    scheduled.forEach(s => {
      const ms = new Date(s.effectiveDue) - Date.now();
      if (ms < soonestMs) { soonestMs = ms; urgentTask = s; }
    });

    // Load lastCheckIn then build overlay
    chrome.storage.local.get(['lastCheckIn'], (data) => {
      const lastCheckIn = data.lastCheckIn || null;
      buildOverlay(urgentTask, lastCheckIn, overlayStartTime);
    });
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

  function buildOverlay(urgentTask, lastCheckIn, overlayStartTime) {
    // Build the check-in reminder block if we have a prior note
    let reminderHtml = '';
    if (lastCheckIn && lastCheckIn.text) {
      const ago = formatTimeAgo(Date.now() - lastCheckIn.timestamp);
      reminderHtml = `
        <div id="webe-reminder">
          <span id="webe-reminder-ago">${escapeHtml(ago)}, you said:</span>
          <span id="webe-reminder-text">"${escapeHtml(lastCheckIn.text)}"</span>
          <span id="webe-reminder-cta">Time to keep going.</span>
        </div>
      `;
    }

    // --- Build overlay DOM ---
    const overlay = document.createElement('div');
    overlay.id = 'webe-overlay';
    overlay.innerHTML = `
      <div id="webe-card">
        <div id="webe-logo">WEBE</div>
        ${reminderHtml}
        <div id="webe-prompt">What have you done to get closer to:</div>
        <div id="webe-task-name">${escapeHtml(urgentTask.name)}</div>
        <div id="webe-due">${formatDue(urgentTask.effectiveDue ? urgentTask.effectiveDue.toISOString() : urgentTask.due)}</div>
        <textarea id="webe-input" placeholder="Type what you've done (or what you'll do next)..." rows="3"></textarea>
        <button id="webe-dismiss">I'm on it →</button>
        <div id="webe-skip">or <span id="webe-skip-link">mark task as done</span></div>
      </div>
    `;

    // Styles (injected inline so no external CSS needed)
    const style = document.createElement('style');
    style.textContent = `
      #webe-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        background: rgba(0,0,0,0.92);
        display: flex;
        align-items: center;
        justify-content: center;
        backdrop-filter: blur(8px);
        animation: webeFadeIn 0.25s ease;
      }

      @keyframes webeFadeIn {
        from { opacity: 0; }
        to   { opacity: 1; }
      }

      #webe-card {
        background: #1a1a1a;
        border: 1px solid #333;
        border-radius: 16px;
        padding: 32px 28px;
        max-width: 380px;
        width: 90%;
        text-align: center;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: #e0e0e0;
      }

      #webe-logo {
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 0.1em;
        color: #4ade80;
        margin-bottom: 20px;
      }

      #webe-prompt {
        font-size: 14px;
        color: #999;
        margin-bottom: 8px;
      }

      #webe-task-name {
        font-size: 22px;
        font-weight: 700;
        color: #fff;
        margin-bottom: 4px;
      }

      #webe-due {
        font-size: 14px;
        color: #f87171;
        font-weight: 700;
        margin-bottom: 20px;
      }

      #webe-input {
        width: 100%;
        background: #111;
        border: 1px solid #333;
        border-radius: 10px;
        padding: 12px;
        color: #e0e0e0;
        font-size: 14px;
        font-family: inherit;
        resize: none;
        outline: none;
        margin-bottom: 14px;
      }

      #webe-input:focus { border-color: #4ade80; }

      #webe-dismiss {
        width: 100%;
        padding: 12px;
        border: none;
        border-radius: 10px;
        background: #4ade80;
        color: #0f0f0f;
        font-size: 15px;
        font-weight: 600;
        cursor: pointer;
        transition: background 0.15s;
      }

      #webe-dismiss:hover { background: #22c55e; }

      #webe-skip {
        margin-top: 12px;
        font-size: 11px;
        color: #555;
      }

      #webe-skip-link {
        color: #888;
        text-decoration: underline;
        cursor: pointer;
      }

      #webe-skip-link:hover { color: #ccc; }

      #webe-reminder {
        display: flex;
        flex-direction: column;
        gap: 4px;
        background: #111;
        border: 1px solid #2a3a2a;
        border-radius: 10px;
        padding: 12px 14px;
        margin-bottom: 16px;
        text-align: left;
      }

      #webe-reminder-ago {
        font-size: 11px;
        color: #4ade80;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      #webe-reminder-text {
        font-size: 13px;
        color: #ccc;
        font-style: italic;
      }

      #webe-reminder-cta {
        font-size: 12px;
        color: #888;
        margin-top: 2px;
      }
    `;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);

    // Prevent scrolling underneath
    document.body.style.overflow = 'hidden';

    // Wire up dismiss
    overlay.querySelector('#webe-dismiss').addEventListener('click', () => {
      const inputText = overlay.querySelector('#webe-input').value.trim();
      if (inputText) {
        chrome.storage.local.set({
          lastCheckIn: {
            text: inputText,
            timestamp: Date.now(),
            taskId: urgentTask.id
          }
        });
      }
      dismiss(overlay, style, overlayStartTime);
    });

    // Wire up "mark as done"
    overlay.querySelector('#webe-skip-link').addEventListener('click', () => {
      // Remove this task from storage
      chrome.storage.local.get(['tasks'], (data) => {
        const updated = (data.tasks || []).filter(t => t.id !== urgentTask.id);
        chrome.storage.local.set({ tasks: updated });
      });
      // Clear check-in since the task is done
      chrome.storage.local.remove('lastCheckIn');
      dismiss(overlay, style, overlayStartTime);
    });

    // Focus the text input so user can immediately type
    setTimeout(() => overlay.querySelector('#webe-input')?.focus(), 100);
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
      const ordered  = (taskOrder || []).filter(id => groupIds.has(id) || freeMap[id]);
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

  function formatDue(dueDateISO) {
    const diff = new Date(dueDateISO) - Date.now();
    const h = Math.max(0, diff / (1000 * 60 * 60));
    if (h <= 0) return formatOverdue(dueDateISO);
    if (h < 24)  return `${Math.round(h)} hours left`;
    return `${Math.round(h / 24)} days left`;
  }

  function formatOverdue(dueDateISO) {
    const overdueMs = Date.now() - new Date(dueDateISO);
    const totalMin  = Math.floor(overdueMs / 60000);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return `-${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  }

  function formatTimeAgo(ms) {
    const mins = Math.floor(ms / 60000);
    if (mins < 1)  return 'just now';
    if (mins < 60) return `${mins} minute${mins !== 1 ? 's' : ''} ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24)  return `${hrs} hour${hrs !== 1 ? 's' : ''} ago`;
    const days = Math.floor(hrs / 24);
    return `${days} day${days !== 1 ? 's' : ''} ago`;
  }

})();
