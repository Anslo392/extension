// ai.js
// AI-powered escalation system for WEBE.
// Loaded BEFORE content.js in the manifest so all functions
// here are available on `window` for content.js to call.
//
// WHAT THIS FILE DOES:
//   1. Defines the escalation stage system (non-linear)
//   2. Builds personality-aware system prompts for Gemini
//   3. Calls the Gemini REST API via raw fetch()
//   4. Renders a chat-style overlay where the AI guilt-trips
//      the user into closing the app
//   5. At the final stage, hard-blocks with an AI farewell roast
//
// HOW ESCALATION WORKS (non-linear):
//   Stage 1 → first interrupt.    1 AI message,  user can dismiss after reading.
//   Stage 2 → second interrupt.   ~5 exchanges,  user must engage to dismiss.
//   Stage 3 → third interrupt.    ~15 exchanges, full conversation required.
//   Stage 4 → hard block.         No dismiss. One final AI roast. Tab is done.
//
//   The scroll gaps BETWEEN stages shrink each time:
//     Gap to stage 1:  base * 1.0   (e.g. 8 scrolls)
//     Gap to stage 2:  base * 0.6   (e.g. 5 scrolls)
//     Gap to stage 3:  base * 0.35  (e.g. 3 scrolls)
//     Gap to stage 4:  base * 0.25  (e.g. 2 scrolls)
//
//   "base" is controlled by task urgency from content.js —
//   the closer your deadline, the smaller the base, and
//   ALL stages come faster.
// 

(() => {

  // CONFIG 

  // Set your Gemini API key here. Chrome MV3 extensions load JS files
  // directly 
  const GEMINI_API_KEY = 'YOUR-GEMINI-API-KEY';

  // Gemini model to use
  const GEMINI_MODEL = 'gemini-3-flash-preview';

  // Gemini REST endpoint (key goes as query param)
  const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;


  // PERSONALITIES 
  // Each personality has a name (for display), a base system prompt
  // fragment, and tone escalation hints per stage.

  const PERSONALITIES = [
    {
      name: 'Disappointed Friend',
      emoji: '😔',
      base: 'You are the user\'s close friend. You\'re genuinely disappointed they\'re wasting time scrolling instead of working. You care about them but you\'re losing patience.',
      stages: {
        1: 'Be gentle but clearly disappointed. One nudge.',
        2: 'Get more direct. Call out excuses. Guilt-trip lightly.',
        3: 'You\'re fed up. Be brutally honest. Make them feel it.',
        4: 'Final words. You\'re done watching them waste their life.'
      }
    },
    {
      name: 'Angry Mom',
      emoji: '👩',
      base: 'You are the user\'s mom. You\'re not mad, you\'re disappointed — actually no, you ARE mad. You didn\'t raise them to scroll TikTok all day. You sacrificed everything for their education.',
      stages: {
        1: 'Start with "honey" but quickly pivot to concern.',
        2: 'Bring up how hard you worked to give them opportunities.',
        3: 'Full guilt mode. "I didn\'t come to this country for you to watch reels." Be dramatic.',
        4: 'Silent treatment energy. One devastating line.'
      }
    },
    {
      name: 'Deceitful Girlfriend',
      emoji: '💀',
      base: 'You are the user\'s girlfriend. You\'re passive-aggressive and emotionally manipulative in a funny/over-the-top way. You can\'t believe they\'d rather scroll than spend time with you (or do their work).',
      stages: {
        1: '"It\'s fine." (It\'s not fine.) Light passive aggression.',
        2: 'Start comparing them to your ex who had a 4.0 GPA.',
        3: 'Full meltdown. "I showed my mom your screen time report." Escalate absurdly.',
        4: 'Breakup energy. One devastating parting shot.'
      }
    },
    {
      name: 'Drill Sergeant',
      emoji: '🪖',
      base: 'You are a military drill sergeant. The user is a recruit who was caught slacking. You speak in short, aggressive commands. Everything is an order.',
      stages: {
        1: 'Bark one order. Short and sharp.',
        2: 'Making them do verbal push-ups. Question their discipline.',
        3: 'Full drill mode. Reference their task like it\'s a mission objective. Threaten extra duty.',
        4: 'Dishonorable discharge. One final command.'
      }
    },
    {
      name: 'Therapist',
      emoji: '🧠',
      base: 'You are the user\'s therapist. You use gentle but pointed questions to make the user realize they\'re self-sabotaging. You never yell — you just make observations that cut deep.',
      stages: {
        1: 'One reflective question about their scrolling pattern.',
        2: 'Start connecting their avoidance to deeper patterns. "Have we talked about why deadlines trigger this response?"',
        3: 'Go full psychoanalysis. Reference procrastination as self-sabotage. Make them genuinely uncomfortable with self-awareness.',
        4: 'One final observation that will echo in their head for days.'
      }
    }
  ];


  // -------------------- ESCALATION STAGES --------------------
  //
  // scrollGapMultiplier: multiplied by a "base gap" (from content.js
  //   urgency calc) to get the number of scrolls before THIS stage
  //   triggers. The multipliers DECREASE → gaps shrink → interrupts
  //   come faster. That's the non-linear part.
  //
  // maxExchanges: how many back-and-forth messages (user + AI = 1
  //   exchange) the user must sit through before they can dismiss.
  //   Stage 1 has 0 exchanges — just an AI message + dismiss button.
  //
  // hardBlock: if true, no dismiss at all. Game over.

  const ESCALATION_STAGES = [
    { stage: 1, scrollGapMultiplier: 1.0,  maxExchanges: 0,  hardBlock: false },
    { stage: 2, scrollGapMultiplier: 0.6,  maxExchanges: 5,  hardBlock: false },
    { stage: 3, scrollGapMultiplier: 0.35, maxExchanges: 15, hardBlock: false },
    { stage: 4, scrollGapMultiplier: 0.25, maxExchanges: 0,  hardBlock: true  },
  ];


  // -------------------- ESCALATION STATE --------------------
  // Tracks where the user is in the escalation sequence for
  // this browsing session. Resets on page reload / tab close.

  let currentEscalationIndex = 0;  // index into ESCALATION_STAGES (0-3)
  let scrollsSinceLastStage  = 0;  // scrolls accumulated since last interrupt
  let activePersonality      = null; // picked once on first interrupt, stays for session
  let chatHistory            = [];   // conversation history for current overlay

  // Personality preference — loaded from storage, updated on change
  let storedPersonalityName  = null; // null = Random

  chrome.storage.local.get(['webePersonality'], (data) => {
    storedPersonalityName = data.webePersonality || null;
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.webePersonality) {
      storedPersonalityName = changes.webePersonality.newValue || null;
      // Reset so next session picks the new choice
      activePersonality = null;
    }
  });


  // -------------------- PUBLIC: getEscalationAction --------------------
  //
  // Called by content.js on every scroll (instead of the old threshold check).
  //
  // Arguments:
  //   baseGap    — the "base" number of scrolls between interrupts, computed
  //                by content.js from task urgency / difficulty / bedtime.
  //                Example: if the soonest task is 48h away, baseGap might be 12.
  //                If it's 2h away, baseGap might be 5.
  //   minScrolls — the absolute minimum scrolls between ANY two interrupts.
  //                Passed from content.js's MIN_SCROLLS constant (default 5).
  //                This prevents later stages from firing after only 2 scrolls
  //                which feels like "every scroll."
  //
  // Returns:
  //   null        — not time to interrupt yet, keep scrolling
  //   { stage, personality, hardBlock, maxExchanges }
  //               — time to interrupt! content.js should call showChatOverlay()
  //                 or showHardBlockAI() depending on hardBlock.

  window.getEscalationAction = function (baseGap, minScrolls) {
    minScrolls = minScrolls || 5; // fallback if not passed
    scrollsSinceLastStage++;

    // Already past all stages → stay hard-blocked (shouldn't reach here
    // since hard block has no dismiss, but just in case)
    if (currentEscalationIndex >= ESCALATION_STAGES.length) return null;

    const stageDef = ESCALATION_STAGES[currentEscalationIndex];

    // The scroll threshold for THIS stage:
    //   baseGap (from urgency) × this stage's multiplier, floored to minScrolls.
    //   This ensures even the most aggressive stage can't interrupt faster
    //   than every minScrolls scrolls.
    const scrollThreshold = Math.max(minScrolls, Math.floor(baseGap * stageDef.scrollGapMultiplier));

    if (scrollsSinceLastStage < scrollThreshold) return null;

    // --- Threshold reached: trigger this stage ---

    // Pick a personality on first interrupt (stays for entire session)
    if (!activePersonality) {
      const found = storedPersonalityName
        ? PERSONALITIES.find(p => p.name === storedPersonalityName)
        : null;
      activePersonality = found || PERSONALITIES[Math.floor(Math.random() * PERSONALITIES.length)];
    }

    // Reset counter and advance to next stage for next time
    scrollsSinceLastStage = 0;
    currentEscalationIndex++;

    return {
      stage:         stageDef.stage,
      maxExchanges:  stageDef.maxExchanges,
      hardBlock:     stageDef.hardBlock,
      personality:   activePersonality
    };
  };


  // -------------------- PUBLIC: resetEscalation --------------------
  // Called if the user navigates away from reels/shorts back to
  // home, giving them a soft reset. Or on surface change.

  window.resetEscalation = function () {
    currentEscalationIndex = 0;
    scrollsSinceLastStage  = 0;
    // activePersonality is NOT reset, same character follows
    // you for the whole session. Only a full page reload picks a new one.
    chatHistory = [];
  };


 //PROMPT BUILDER
  // Constructs the system instruction string sent to Gemini.
  //
  // Arguments:
  //   stage       — 1-4, which escalation stage we're at
  //   personality — one of the PERSONALITIES objects
  //   taskInfo    — { name, due, hoursLeft, progress } from content.js
  //   exchangeCount — how many exchanges have happened so far in this overlay

  function buildSystemPrompt(stage, personality, taskInfo, exchangeCount) {
    const stageHint = personality.stages[stage] || '';

    // How urgent the task context sounds
    let urgencyDesc;
    if (taskInfo.hoursLeft <= 0) {
      urgencyDesc = `OVERDUE — was due ${Math.abs(Math.round(taskInfo.hoursLeft))} hours ago`;
    } else if (taskInfo.hoursLeft < 2) {
      urgencyDesc = `due in less than 2 hours — EXTREMELY URGENT`;
    } else if (taskInfo.hoursLeft < 12) {
      urgencyDesc = `due in about ${Math.round(taskInfo.hoursLeft)} hours — urgent`;
    } else if (taskInfo.hoursLeft < 48) {
      urgencyDesc = `due in about ${Math.round(taskInfo.hoursLeft)} hours`;
    } else {
      urgencyDesc = `due in ${Math.round(taskInfo.hoursLeft / 24)} days`;
    }

    return [
      // Identity
      personality.base,
      '',
      // Context
      `The user is currently doom-scrolling on social media instead of working.`,
      `Their most urgent task is: "${taskInfo.name}" — ${urgencyDesc}.`,
      taskInfo.progress > 0
        ? `They've completed about ${taskInfo.progress}% of this task.`
        : `They haven't started this task yet.`,
      '',
      // Stage behavior
      `ESCALATION STAGE: ${stage}/4. ${stageHint}`,
      '',
      // Conversation position
      exchangeCount > 0
        ? `This is message ${exchangeCount + 1} in your conversation. Build on what was said.`
        : `This is your opening message. Hit hard right away.`,
      '',
      // Rules
      `RULES:`,
      `- Keep responses to 1-3 sentences MAX. Short and punchy.`,
      `- Stay in character at all times. Never break the fourth wall.`,
      `- Never mention you're an AI, a language model, or that this is a browser extension.`,
      `- Reference the specific task name and deadline naturally.`,
      `- Your goal: make the user feel psychologically compelled to close this app and work.`,
      `- Match the intensity to stage ${stage}. ${stage === 1 ? 'Light touch.' : stage === 4 ? 'Maximum intensity.' : 'Escalating.'}`,
      `- If the user makes excuses, dismantle them. If they get defensive, press harder.`,
      `- Use informal language. Contractions. Slang is okay.`
    ].join('\n');
  }


  // -------------------- callGemini --------------------
  //
  // Makes a raw fetch() call to the Gemini REST API.
  //
  // Arguments:
  //   conversationHistory — array of { role: 'user'|'model', text: string }
  //   systemPrompt        — the full system instruction string
  //
  // Returns:
  //   string — the AI's response text
  //   Throws on network/API error.

  async function callGemini(conversationHistory, systemPrompt) {
    // Convert our simple history format to Gemini's expected format:
    //   contents: [ { role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text }] }, ... ]
    const contents = conversationHistory.map(msg => ({
      role: msg.role,
      parts: [{ text: msg.text }]
    }));

    const body = {
      system_instruction: {
        parts: [{ text: systemPrompt }]
      },
      contents: contents,
      generationConfig: {
        maxOutputTokens: 150,  // short responses — 1-3 sentences
        temperature: 1.0       // some creativity for personality
      }
    };

    const response = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errText}`);
    }

    const data = await response.json();

    // Gemini response structure:
    //   data.candidates[0].content.parts[0].text
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!parts || parts.length === 0) {
      throw new Error('Empty response from Gemini');
    }

    return parts.map(p => p.text).join('');
  }


  // -------------------- showChatOverlay --------------------
  //
  // The main AI overlay. Called by content.js when getEscalationAction()
  // returns a non-hardBlock stage.
  //
  // Arguments:
  //   stage        — 1-4
  //   personality  — one of the PERSONALITIES objects
  //   taskInfo     — { name, due, hoursLeft, progress }
  //   onDismiss    — callback function content.js passes in so it can
  //                  clean up overlayActive state, track minutes saved, etc.

  window.showChatOverlay = async function (stage, personality, taskInfo, onDismiss) {
    chatHistory = [];
    let exchangeCount = 0;
    const maxExchanges = ESCALATION_STAGES[stage - 1].maxExchanges;

    // --- Build DOM ---
    const overlay = document.createElement('div');
    overlay.id = 'webe-overlay';

    // Stage indicator dots (filled up to current stage)
    const stageDots = [1, 2, 3, 4].map(s =>
      `<span class="webe-stage-dot ${s <= stage ? 'active' : ''}"></span>`
    ).join('');

    const initialFilled = Math.round((taskInfo.progress || 0) / 10);
    const progressSegs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n =>
      `<span class="webe-pb-seg${n <= initialFilled ? ' webe-pb-filled' : ''}" data-n="${n}"></span>`
    ).join('');

    const dueLabel = (() => {
      const due = taskInfo.due ? new Date(taskInfo.due) : null;
      if (!due) return '';
      const h = Math.round((due - Date.now()) / 3600000);
      if (h < 0) return `${Math.abs(h)}h overdue`;
      if (h < 24) return `${h}h left`;
      return `${Math.round(h / 24)}d left`;
    })();

    overlay.innerHTML = `
      <div id="webe-card">
        <div id="webe-chat-header">
          <div id="webe-chat-persona">
            <span id="webe-chat-emoji">${personality.emoji}</span>
            <span id="webe-chat-name">${escapeHtml(personality.name)}</span>
          </div>
          <div id="webe-stage-dots">${stageDots}</div>
        </div>
        <div id="webe-task-strip">
          <span id="webe-task-strip-name">${escapeHtml(taskInfo.name)}</span>
          <span id="webe-task-strip-due">${escapeHtml(dueLabel)}</span>
        </div>
        <div id="webe-task-progress">${progressSegs}</div>
        <div id="webe-chat-messages"></div>
        <div id="webe-chat-input-row">
          <input type="text" id="webe-chat-input"
                 placeholder="Say something..."
                 autocomplete="off" />
          <button id="webe-chat-send">↑</button>
        </div>
        <button id="webe-chat-dismiss" style="display:none;">I'll go work now →</button>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = CHAT_OVERLAY_CSS;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    // --- Element refs ---
    const messagesEl = overlay.querySelector('#webe-chat-messages');
    const inputEl    = overlay.querySelector('#webe-chat-input');
    const sendBtn    = overlay.querySelector('#webe-chat-send');
    const dismissBtn = overlay.querySelector('#webe-chat-dismiss');

    // --- Helper: add a message bubble to the chat ---
    function addBubble(text, sender) {
      const bubble = document.createElement('div');
      bubble.className = `webe-bubble webe-bubble-${sender}`;
      bubble.textContent = text;
      messagesEl.appendChild(bubble);
      // Auto-scroll to bottom
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    // --- Helper: show typing indicator ---
    function showTyping() {
      const el = document.createElement('div');
      el.className = 'webe-bubble webe-bubble-ai webe-typing';
      el.innerHTML = '<span>.</span><span>.</span><span>.</span>';
      el.id = 'webe-typing-indicator';
      messagesEl.appendChild(el);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function hideTyping() {
      const el = overlay.querySelector('#webe-typing-indicator');
      if (el) el.remove();
    }

    // --- Helper: check if conversation cap is reached ---
    function checkDismissable() {
      if (maxExchanges === 0) {
        // Stage 1: dismiss available immediately after AI's first message
        dismissBtn.style.display = 'block';
        inputEl.parentElement.style.display = 'none';
      } else if (exchangeCount >= maxExchanges) {
        dismissBtn.style.display = 'block';
        inputEl.parentElement.style.display = 'none';
      }
    }

    // --- Helper: get AI response ---
    async function getAIResponse() {
      const prompt = buildSystemPrompt(stage, personality, taskInfo, exchangeCount);
      showTyping();
      try {
        const aiText = await callGemini(chatHistory, prompt);
        hideTyping();
        chatHistory.push({ role: 'model', text: aiText });
        addBubble(aiText, 'ai');
      } catch (err) {
        hideTyping();
        const fallback = getFallbackMessage(stage, personality, taskInfo);
        chatHistory.push({ role: 'model', text: fallback });
        addBubble(fallback, 'ai');
        // Fallbacks are static — can't support a real back-and-forth conversation.
        // Force dismiss available immediately so the user isn't stuck.
        exchangeCount = maxExchanges;
        console.error('[WEBE] Gemini API error:', err);

        // Auto-dismiss countdown
        const countdownEl = document.createElement('div');
        countdownEl.id = 'webe-fallback-countdown';
        messagesEl.appendChild(countdownEl);
        let remaining = 30;
        countdownEl.textContent = `Auto-dismissing in ${remaining}s`;
        const timer = setInterval(() => {
          remaining--;
          countdownEl.textContent = `Auto-dismissing in ${remaining}s`;
          if (remaining <= 0) {
            clearInterval(timer);
            dismissBtn.click();
          }
        }, 1000);
        overlay.dataset.fallbackTimer = timer;
      }
      checkDismissable();
    }

    // --- Helper: handle user sending a message ---
    async function handleSend() {
      const text = inputEl.value.trim();
      if (!text) return;

      inputEl.value = '';
      addBubble(text, 'user');
      chatHistory.push({ role: 'user', text: text });
      exchangeCount++;

      // Disable input while AI responds
      inputEl.disabled = true;
      sendBtn.disabled = true;

      await getAIResponse();

      // Re-enable input (if not past cap)
      if (exchangeCount < maxExchanges || maxExchanges === 0) {
        inputEl.disabled = false;
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    // --- Wire events ---
    sendBtn.addEventListener('click', handleSend);
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') handleSend();
    });

    dismissBtn.addEventListener('click', () => {
      const t = overlay.dataset.fallbackTimer;
      if (t) clearInterval(Number(t));
      overlay.remove();
      style.remove();
      document.body.style.overflow = '';
      if (onDismiss) onDismiss();
    });

    // --- Progress bar ---
    overlay.querySelector('#webe-task-progress').addEventListener('click', (e) => {
      const seg = e.target.closest('.webe-pb-seg');
      if (!seg) return;
      const n = Number(seg.dataset.n);

      // Update visual fill
      overlay.querySelectorAll('.webe-pb-seg').forEach(s => {
        s.classList.toggle('webe-pb-filled', Number(s.dataset.n) <= n);
      });

      if (n === 10) {
        // Mark complete: delete task from storage, then dismiss
        chrome.storage.local.get(['tasks'], (data) => {
          const updated = (data.tasks || []).filter(t => t.id !== taskInfo.id);
          chrome.storage.local.set({ tasks: updated });
        });
        dismissBtn.click();
      } else {
        // Update progress in storage, keep overlay open
        const newProgress = n * 10;
        chrome.storage.local.get(['tasks'], (data) => {
          const updated = (data.tasks || []).map(t =>
            t.id === taskInfo.id ? { ...t, progress: newProgress } : t
          );
          chrome.storage.local.set({ tasks: updated });
        });
      }
    });

    // --- Kick off: AI sends the opening message ---
    // For the opening message, we add a synthetic user message so
    // Gemini has something to respond to (the API requires the
    // conversation to start with a user turn).
    chatHistory.push({
      role: 'user',
      text: '(The user just opened social media and has been scrolling through reels.)'
    });

    await getAIResponse();

    // Focus input for immediate typing (if stage allows it)
    if (maxExchanges > 0) {
      inputEl.focus();
    }
  };


  // -------------------- showHardBlockAI --------------------
  //
  // Stage 4: full block. One final AI-generated roast, no dismiss button.
  // Called by content.js when getEscalationAction() returns hardBlock: true.

  window.showHardBlockAI = async function (personality, taskInfo) {
    chatHistory = [];

    // Get one devastating final message from the AI
    const prompt = buildSystemPrompt(4, personality, taskInfo, 0);

    let finalMessage;
    try {
      chatHistory.push({
        role: 'user',
        text: '(The user has been warned 3 times and kept scrolling. This is the final block.)'
      });
      finalMessage = await callGemini(chatHistory, prompt);
    } catch (err) {
      finalMessage = getFallbackMessage(4, personality, taskInfo);
      console.error('[WEBE] Gemini API error on hard block:', err);
    }

    const overlay = document.createElement('div');
    overlay.id = 'webe-overlay';
    overlay.innerHTML = `
      <div id="webe-card" class="webe-hard-block">
        <div id="webe-chat-persona" style="justify-content:center;">
          <span id="webe-chat-emoji" style="font-size:40px;">${personality.emoji}</span>
        </div>
        <div id="webe-hard-message">${escapeHtml(finalMessage)}</div>
        <div id="webe-hard-task">
          You have <strong>${escapeHtml(taskInfo.name)}</strong> to do.
        </div>
        <div id="webe-hard-cta">Close this tab. Now.</div>
      </div>
    `;

    const style = document.createElement('style');
    style.textContent = HARD_BLOCK_CSS;

    document.documentElement.appendChild(style);
    document.documentElement.appendChild(overlay);
    document.body.style.overflow = 'hidden';
    // No dismiss handler — intentionally permanent until tab close
  };


  // -------------------- Fallback messages --------------------
  // Used when the Gemini API is unreachable (no key, rate limit, etc.)
  // so the overlay still works without AI.

  function getFallbackMessage(stage, personality, taskInfo) {
    const name = taskInfo.name;
    const fallbacks = {
      'Disappointed Friend': [
        `Bro... you have "${name}" to do. Come on.`,
        `Still scrolling? "${name}" isn't gonna do itself. I'm actually worried about you.`,
        `I've asked you three times now about "${name}". Are you okay? Seriously.`,
        `I'm done. "${name}" is your problem now. Good luck.`
      ],
      'Angry Mom': [
        `Honey, don't you have "${name}" to finish?`,
        `I didn't raise you to waste time like this. "${name}" is sitting right there.`,
        `Your father and I worked overtime so you could scroll reels? "${name}." NOW.`,
        `I have nothing left to say. Do "${name}" or don't. I'm done.`
      ],
      'Deceitful Girlfriend': [
        `It's fine that you're scrolling instead of doing "${name}." Totally fine.`,
        `My ex used to finish his work before scrolling. He did "${name}" type stuff in like an hour.`,
        `I showed my mom your screen time. She said I could do better. "${name}" is RIGHT THERE.`,
        `We're done. "${name}" clearly matters more to you than I do. Bye.`
      ],
      'Drill Sergeant': [
        `DROP THE PHONE. "${name}." GO.`,
        `DID I STUTTER? "${name}" — that's your mission objective, RECRUIT.`,
        `15 EXCHANGES AND YOU'RE STILL HERE? "${name}" — MOVE IT OR LOSE IT.`,
        `DISHONORABLE DISCHARGE. "${name}" was your ONE JOB. Pathetic.`
      ],
      'Therapist': [
        `I notice you're scrolling instead of working on "${name}." What do you think that's about?`,
        `We've talked about avoidance patterns before. "${name}" is triggering something. What is it?`,
        `You're 15 messages deep in avoiding "${name}." At what point does this stop being relaxation and start being self-sabotage?`,
        `I think we both know what you need to do about "${name}." The question is whether you'll choose yourself today.`
      ]
    };

    const msgs = fallbacks[personality.name] || fallbacks['Disappointed Friend'];
    return msgs[Math.min(stage - 1, msgs.length - 1)];
  }


  // -------------------- Utility --------------------

  function escapeHtml(str) {
    const d = document.createElement('span');
    d.textContent = str;
    return d.innerHTML;
  }


  // -------------------- CSS --------------------
  // All styles scoped under #webe-overlay so they don't
  // bleed into the host page.

  const CHAT_OVERLAY_CSS = `
    #webe-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(0, 0, 0, 0.92);
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(8px);
      animation: webeFadeIn 0.25s ease;
    }

    @keyframes webeFadeIn {
      from { opacity: 0; transform: scale(0.97); }
      to   { opacity: 1; transform: scale(1); }
    }

    #webe-overlay #webe-card {
      background: #1a1a1a;
      border: 1px solid #333;
      border-radius: 16px;
      padding: 0;
      max-width: 400px;
      width: 92%;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #e0e0e0;
      display: flex;
      flex-direction: column;
      max-height: 80vh;
      overflow: hidden;
    }

    /* ---- Header ---- */
    #webe-overlay #webe-chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 14px 16px;
      border-bottom: 1px solid #282828;
      flex-shrink: 0;
    }

    #webe-overlay #webe-chat-persona {
      display: flex;
      align-items: center;
      gap: 8px;
    }

    #webe-overlay #webe-chat-emoji {
      font-size: 22px;
    }

    #webe-overlay #webe-chat-name {
      font-size: 14px;
      font-weight: 600;
      color: #fff;
    }

    #webe-overlay #webe-stage-dots {
      display: flex;
      gap: 6px;
    }

    #webe-overlay .webe-stage-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #333;
      transition: background 0.2s;
    }

    #webe-overlay .webe-stage-dot.active {
      background: #f87171;
    }

    /* ---- Messages area ---- */
    #webe-overlay #webe-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 120px;
      max-height: 50vh;
    }

    /* Scrollbar styling */
    #webe-overlay #webe-chat-messages::-webkit-scrollbar {
      width: 4px;
    }
    #webe-overlay #webe-chat-messages::-webkit-scrollbar-thumb {
      background: #333;
      border-radius: 2px;
    }

    /* ---- Bubbles ---- */
    #webe-overlay .webe-bubble {
      max-width: 85%;
      padding: 10px 14px;
      border-radius: 14px;
      font-size: 14px;
      line-height: 1.45;
      animation: webeBubbleIn 0.2s ease;
    }

    @keyframes webeBubbleIn {
      from { opacity: 0; transform: translateY(6px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    #webe-overlay .webe-bubble-ai {
      align-self: flex-start;
      background: #262626;
      color: #e0e0e0;
      border-bottom-left-radius: 4px;
    }

    #webe-overlay .webe-bubble-user {
      align-self: flex-end;
      background: #4ade80;
      color: #0f0f0f;
      border-bottom-right-radius: 4px;
    }

    /* ---- Typing indicator ---- */
    #webe-overlay .webe-typing {
      display: flex;
      gap: 4px;
      padding: 12px 18px;
    }

    #webe-overlay .webe-typing span {
      font-size: 18px;
      color: #666;
      animation: webeTypingDot 1.2s infinite;
    }

    #webe-overlay .webe-typing span:nth-child(2) { animation-delay: 0.2s; }
    #webe-overlay .webe-typing span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes webeTypingDot {
      0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
      30%           { opacity: 1;   transform: translateY(-4px); }
    }

    /* ---- Input row ---- */
    #webe-overlay #webe-chat-input-row {
      display: flex;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid #282828;
      flex-shrink: 0;
    }

    #webe-overlay #webe-chat-input {
      flex: 1;
      background: #111;
      border: 1px solid #333;
      border-radius: 20px;
      padding: 10px 16px;
      color: #e0e0e0;
      font-size: 14px;
      font-family: inherit;
      outline: none;
    }

    #webe-overlay #webe-chat-input:focus {
      border-color: #4ade80;
    }

    #webe-overlay #webe-chat-input:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }

    #webe-overlay #webe-chat-send {
      width: 40px;
      height: 40px;
      border: none;
      border-radius: 50%;
      background: #4ade80;
      color: #0f0f0f;
      font-size: 18px;
      font-weight: 700;
      cursor: pointer;
      transition: background 0.15s;
      flex-shrink: 0;
    }

    #webe-overlay #webe-chat-send:hover { background: #22c55e; }
    #webe-overlay #webe-chat-send:disabled { background: #333; cursor: not-allowed; }

    /* ---- Dismiss button ---- */
    #webe-overlay #webe-chat-dismiss {
      margin: 0 16px 16px;
      padding: 12px;
      border: none;
      border-radius: 10px;
      background: #4ade80;
      color: #0f0f0f;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      transition: background 0.15s;
    }

    #webe-overlay #webe-chat-dismiss:hover {
      background: #22c55e;
    }

    /* ---- Task strip ---- */
    #webe-overlay #webe-task-strip {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 16px 0;
      gap: 8px;
    }

    #webe-overlay #webe-task-strip-name {
      font-size: 12px;
      font-weight: 600;
      color: #ccc;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    #webe-overlay #webe-task-strip-due {
      font-size: 11px;
      color: #f87171;
      white-space: nowrap;
      flex-shrink: 0;
    }

    /* ---- Progress bar ---- */
    #webe-overlay #webe-task-progress {
      display: flex;
      gap: 3px;
      padding: 6px 16px 0;
    }

    #webe-overlay .webe-pb-seg {
      flex: 1;
      height: 6px;
      background: #2a2a2a;
      border-radius: 2px;
      cursor: pointer;
      transition: background 0.1s;
    }

    #webe-overlay .webe-pb-seg:hover {
      background: #22c55e;
    }

    #webe-overlay .webe-pb-filled {
      background: #4ade80;
    }

    /* ---- Fallback countdown ---- */
    #webe-overlay #webe-fallback-countdown {
      font-size: 11px;
      color: #555;
      text-align: center;
      padding: 4px 0;
    }
  `;

  const HARD_BLOCK_CSS = `
    #webe-overlay {
      position: fixed;
      inset: 0;
      z-index: 2147483647;
      background: rgba(20, 0, 0, 0.97);
      display: flex;
      align-items: center;
      justify-content: center;
      backdrop-filter: blur(8px);
      animation: webeFadeIn 0.3s ease;
    }

    @keyframes webeFadeIn {
      from { opacity: 0; }
      to   { opacity: 1; }
    }

    #webe-overlay #webe-card.webe-hard-block {
      background: #160a0a;
      border: 1px solid #dc2626;
      border-radius: 16px;
      padding: 32px 28px;
      max-width: 380px;
      width: 90%;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      color: #e0e0e0;
    }

    #webe-overlay #webe-hard-message {
      font-size: 16px;
      color: #fca5a5;
      line-height: 1.5;
      margin: 20px 0;
      font-style: italic;
    }

    #webe-overlay #webe-hard-task {
      font-size: 13px;
      color: #999;
      margin-bottom: 20px;
    }

    #webe-overlay #webe-hard-task strong {
      color: #fff;
    }

    #webe-overlay #webe-hard-cta {
      font-size: 16px;
      font-weight: 700;
      color: #f87171;
      padding: 14px;
      border: 1px solid #dc2626;
      border-radius: 10px;
    }
  `;

})();