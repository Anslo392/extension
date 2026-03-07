// ============================================================
// popup.js
// Manages the task list UI and syncs everything to
// chrome.storage.local so the content script can read it.
// ============================================================

const taskNameInput  = document.getElementById('task-name');
const taskDateInput  = document.getElementById('task-date');
const taskTimeInput  = document.getElementById('task-time');
const addBtn         = document.getElementById('add-btn');
const taskListEl     = document.getElementById('task-list');
const minutesSavedEl = document.getElementById('minutes-saved');
const toggleActive   = document.getElementById('toggle-active');

const addForm        = document.getElementById('add-form');
const surveyPanel    = document.getElementById('survey-panel');
const surveyPreview  = document.getElementById('survey-task-preview');
const surveyConfirm  = document.getElementById('survey-confirm');
const bedtimeInput   = document.getElementById('bedtime-input');
const scheduleListEl = document.getElementById('schedule-list');
const addFreeBtn     = document.getElementById('add-free-block');
const freeBlockForm  = document.getElementById('free-block-form');
const freeLabelInput = document.getElementById('free-label');
const freeDurOpts    = document.getElementById('free-dur-opts');
const freeConfirmBtn = document.getElementById('free-confirm');

// Schedule state
let taskOrder  = [];
let freeBlocks = [];
let pendingFreeDur = null;

// ---------- helpers ----------

// Generate a simple unique id (timestamp + random suffix)
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Calculate hours remaining until a due date string ("YYYY-MM-DDTHH:MM")
function hoursUntil(dueDateISO) {
  const diff = new Date(dueDateISO) - Date.now();
  return Math.max(0, diff / (1000 * 60 * 60));
}

// Format how overdue a task is as "-HH:MM"
function formatOverdue(dueDateISO) {
  const overdueMs = Date.now() - new Date(dueDateISO);
  const totalMin  = Math.floor(overdueMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `-${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// Format a due date for display
function formatDue(dueDateISO) {
  const h = hoursUntil(dueDateISO);
  if (h <= 0) return formatOverdue(dueDateISO);
  if (h < 24) return `${Math.round(h)}h left`;
  return `${Math.round(h / 24)}d left`;
}

// ---------- render ----------

function renderTasks(tasks) {
  taskListEl.innerHTML = '';

  if (tasks.length === 0) {
    taskListEl.innerHTML = '<div class="empty-state">No tasks yet — add one above!</div>';
    return;
  }

  // Sort by due date (soonest first)
  tasks.sort((a, b) => new Date(a.due) - new Date(b.due));

  tasks.forEach(task => {
    const item = document.createElement('div');
    item.className = 'task-item';

    const h = hoursUntil(task.due);
    const urgentClass = (new Date(task.due) < Date.now() || h < 24) ? ' urgent' : '';

    item.innerHTML = `
      <span class="task-name">${escapeHtml(task.name)}</span>
      <span class="task-due${urgentClass}">${formatDue(task.due)}</span>
      <button class="delete-btn" data-id="${task.id}" title="Remove task">&times;</button>
    `;

    taskListEl.appendChild(item);
  });

  // Wire up delete buttons
  taskListEl.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', () => deleteTask(btn.dataset.id));
  });
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

// ---------- storage helpers ----------

async function loadTasks() {
  const data = await chrome.storage.local.get(['tasks']);
  return data.tasks || [];
}

async function saveTasks(tasks) {
  await chrome.storage.local.set({ tasks });
}

async function loadMinutesSaved() {
  const data = await chrome.storage.local.get(['minutesSaved']);
  return data.minutesSaved || 0;
}

async function loadActive() {
  const data = await chrome.storage.local.get(['webeActive']);
  return data.webeActive !== undefined ? data.webeActive : true;
}

async function loadScheduleState() {
  const data = await chrome.storage.local.get(['taskOrder', 'freeBlocks']);
  taskOrder  = data.taskOrder  || [];
  freeBlocks = data.freeBlocks || [];
}

async function saveScheduleState() {
  await chrome.storage.local.set({ taskOrder, freeBlocks });
}

// ---------- schedule rendering ----------

function formatModularDue(effectiveDue, estimatedHours) {
  const leftMs    = effectiveDue - Date.now();
  const deficitMs = leftMs - (estimatedHours * 3600000);

  if (deficitMs < 0) {
    // Not enough time left to complete the task (Y - X < 0)
    const totalMin = Math.floor(-deficitMs / 60000);
    const h = Math.floor(totalMin / 60);
    const m = totalMin % 60;
    return { text: `-${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`, cls: 'overdue' };
  }

  const h = Math.floor(leftMs / 3600000);
  const m = Math.floor((leftMs % 3600000) / 60000);
  return { text: `due ${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`, cls: 'on-time' };
}

function renderSchedule(tasks) {
  scheduleListEl.innerHTML = '';
  if (tasks.length === 0 && freeBlocks.length === 0) {
    scheduleListEl.innerHTML = '<div class="empty-state">Add tasks to see your schedule.</div>';
    return;
  }

  const scheduled = computeModularDeadlines(tasks, freeBlocks, taskOrder);
  const schedMap  = Object.fromEntries(scheduled.map(s => [s.id, s]));
  const freeMap   = Object.fromEntries(freeBlocks.map(b => [b.id, b]));
  const taskMap   = Object.fromEntries(tasks.map(t => [t.id, t]));

  // Build display order: taskOrder items first, then unordered tasks
  const knownIds = new Set([...tasks.map(t => t.id), ...freeBlocks.map(b => b.id)]);
  const ordered  = taskOrder.filter(id => knownIds.has(id));
  const unordered = tasks.filter(t => !taskOrder.includes(t.id)).map(t => t.id);
  const fullOrder = [...ordered, ...unordered];

  let dragSrcId = null;

  fullOrder.forEach(id => {
    let row;
    if (taskMap[id]) {
      const s = schedMap[id] || taskMap[id];
      const estimatedHours = ESTIMATE_HOURS[s.estimatedTime] ?? 1;
      const due = formatModularDue(s.effectiveDue || new Date(s.due), estimatedHours);
      const pct = s.progress ?? 0;
      const durLabel = s.estimatedTime || '?';

      row = document.createElement('div');
      row.className = 'sched-row';
      row.draggable = true;
      row.dataset.id = id;
      const segs = [1,2,3,4,5,6,7,8,9,10].map(n =>
        `<span class="pb-seg${(pct / 10) >= n ? ' filled' : ''}" data-n="${n}"></span>`
      ).join('');

      row.innerHTML = `
        <div class="sched-row-top">
          <span class="drag-handle">&#9776;</span>
          <span class="sched-name">${escapeHtml(s.name)}</span>
          <span class="sched-badge">${escapeHtml(durLabel)}</span>
          <span class="sched-due ${due.cls}">${escapeHtml(due.text)}</span>
        </div>
        <div class="progress-bar" data-id="${id}">${segs}</div>
      `;
    } else if (freeMap[id]) {
      const b = freeMap[id];
      const durLabel = b.durationHours >= 1
        ? `${b.durationHours}h`
        : `${Math.round(b.durationHours * 60)}m`;

      row = document.createElement('div');
      row.className = 'free-row';
      row.draggable = true;
      row.dataset.id = id;
      row.innerHTML = `
        <span class="drag-handle">&#9776;</span>
        <span class="free-row-label">${escapeHtml(b.label || 'Free time')}</span>
        <span class="free-row-dur">${escapeHtml(durLabel)}</span>
        <button class="delete-btn" data-id="${id}">&times;</button>
      `;
    }

    if (!row) return;

    // Drag-and-drop
    row.addEventListener('dragstart', () => { dragSrcId = id; row.style.opacity = '0.5'; });
    row.addEventListener('dragend',   () => { row.style.opacity = ''; });
    row.addEventListener('dragover',  (e) => { e.preventDefault(); row.classList.add('drag-over'); });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', async (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      if (!dragSrcId || dragSrcId === id) return;

      // Ensure both IDs are in taskOrder
      if (!taskOrder.includes(dragSrcId)) taskOrder.push(dragSrcId);
      if (!taskOrder.includes(id))        taskOrder.push(id);

      const from = taskOrder.indexOf(dragSrcId);
      const to   = taskOrder.indexOf(id);
      if (from === -1 || to === -1) return;

      taskOrder.splice(from, 1);
      taskOrder.splice(to, 0, dragSrcId);
      await saveScheduleState();
      renderSchedule(tasks);
    });

    scheduleListEl.appendChild(row);
  });

  // Wire up 10-segment progress bars
  scheduleListEl.querySelectorAll('.progress-bar').forEach(bar => {
    bar.addEventListener('click', async (e) => {
      const seg = e.target.closest('.pb-seg');
      if (!seg) return;
      const n = Number(seg.dataset.n);
      const taskId = bar.dataset.id;
      const t = tasks.find(t => t.id === taskId);
      if (!t) return;

      if (n === 10) {
        await deleteTask(taskId);
      } else {
        t.progress = n * 10;
        await saveTasks(tasks);
        renderSchedule(tasks);
        renderTasks(tasks);
      }
    });
  });

  // Wire up free block delete buttons
  scheduleListEl.querySelectorAll('.free-row .delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      freeBlocks = freeBlocks.filter(b => b.id !== id);
      taskOrder  = taskOrder.filter(i => i !== id);
      await saveScheduleState();
      renderSchedule(tasks);
    });
  });
}

// ---------- scheduling ----------

const ESTIMATE_HOURS = {
  '15m': 0.25, '30m': 0.5, '1h': 1, '2h': 2, '4h+': 4, 'All day': 8
};

// Computes a modular effective deadline for each task so same-deadline
// tasks don't compete. Tasks due on the same day are stacked backward
// from the deadline based on their estimated time and the user's ordering.
//
// Returns: array of { ...task, effectiveDue: Date }
function computeModularDeadlines(tasks, freeBlocks, taskOrder) {
  const freeMap = Object.fromEntries((freeBlocks || []).map(b => [b.id, b]));
  const taskMap = Object.fromEntries(tasks.map(t => [t.id, t]));

  // Group tasks by due-date day (YYYY-MM-DD)
  const groups = {};
  tasks.forEach(t => {
    const day = t.due.slice(0, 10);
    if (!groups[day]) groups[day] = [];
    groups[day].push(t);
  });

  const result = [];

  Object.values(groups).forEach((groupTasks) => {
    // Use the raw due date of the first task in the group as the deadline
    const deadlineMs = new Date(groupTasks[0].due).getTime();

    // Build ordered list of IDs for this group from taskOrder, then append
    // any tasks not yet in taskOrder at the end
    const groupIds = new Set(groupTasks.map(t => t.id));
    const ordered = (taskOrder || []).filter(id => groupIds.has(id) || freeMap[id]);
    const unordered = groupTasks.filter(t => !taskOrder.includes(t.id)).map(t => t.id);
    const fullOrder = [...ordered, ...unordered];

    // Scan backward: assign effectiveDue starting from the raw deadline
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

// ---------- actions ----------

// Pending task waiting for survey answers
let pendingTask = null;

async function addTask() {
  const name = taskNameInput.value.trim();
  const date = taskDateInput.value;
  const time = taskTimeInput.value || '23:59';

  if (!name) { taskNameInput.focus(); return; }
  if (!date) { taskDateInput.focus(); return; }

  const due = `${date}T${time}`;
  pendingTask = { id: uid(), name, due };

  showSurvey();
}

function showSurvey() {
  // Hide add form, show survey
  addForm.style.display = 'none';
  surveyPanel.style.display = 'flex';

  // Show task name in preview
  surveyPreview.textContent = pendingTask.name;

  // Reset selections
  surveyPanel.querySelectorAll('.survey-opts button').forEach(b => b.classList.remove('selected'));
  surveyConfirm.disabled = true;
  pendingTask.difficulty   = null;
  pendingTask.estimatedTime = null;
}

function hideSurvey() {
  surveyPanel.style.display = 'none';
  addForm.style.display = 'flex';
}

function checkSurveyComplete() {
  surveyConfirm.disabled = !(pendingTask.difficulty && pendingTask.estimatedTime);
}

async function confirmAddTask() {
  if (!pendingTask.difficulty || !pendingTask.estimatedTime) return;

  const tasks = await loadTasks();
  tasks.push(pendingTask);
  await saveTasks(tasks);

  // Clear inputs
  taskNameInput.value = '';
  taskDateInput.value = '';
  taskTimeInput.value = '23:59';
  pendingTask = null;

  hideSurvey();
  renderTasks(tasks);
  renderSchedule(tasks);
}

async function deleteTask(id) {
  let tasks = await loadTasks();
  tasks = tasks.filter(t => t.id !== id);
  taskOrder = taskOrder.filter(i => i !== id);
  await saveTasks(tasks);
  await saveScheduleState();
  renderTasks(tasks);
  renderSchedule(tasks);
}

// ---------- init ----------

(async () => {
  // Load schedule state first (taskOrder, freeBlocks)
  await loadScheduleState();

  // Render tasks
  const tasks = await loadTasks();
  renderTasks(tasks);
  renderSchedule(tasks);

  // Show minutes saved
  const mins = await loadMinutesSaved();
  minutesSavedEl.textContent = Math.round(mins);

  // Set toggle state
  toggleActive.checked = await loadActive();

  // Load bedtime — always persist so content.js can read it
  const { bedtime: savedBedtime } = await chrome.storage.local.get(['bedtime']);
  const bedtimeVal = savedBedtime || '23:00';
  bedtimeInput.value = bedtimeVal;
  if (!savedBedtime) chrome.storage.local.set({ bedtime: bedtimeVal });
})();

// ---------- tab switching ----------

const tabTasks    = document.getElementById('tab-tasks');
const tabSchedule = document.getElementById('tab-schedule');

document.getElementById('tab-bar').addEventListener('click', (e) => {
  const btn = e.target.closest('.tab');
  if (!btn) return;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  btn.classList.add('active');
  const which = btn.dataset.tab;
  tabTasks.style.display    = which === 'tasks'    ? 'block' : 'none';
  tabSchedule.style.display = which === 'schedule' ? 'block' : 'none';
});

// ---------- event listeners ----------

addBtn.addEventListener('click', addTask);

taskNameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') addTask();
});

// Survey option buttons
document.getElementById('diff-opts').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn || !pendingTask) return;
  document.querySelectorAll('#diff-opts button').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  pendingTask.difficulty = btn.dataset.val;
  checkSurveyComplete();
});

document.getElementById('time-opts').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn || !pendingTask) return;
  document.querySelectorAll('#time-opts button').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  pendingTask.estimatedTime = btn.dataset.val;
  checkSurveyComplete();
});

surveyConfirm.addEventListener('click', confirmAddTask);

toggleActive.addEventListener('change', async () => {
  await chrome.storage.local.set({ webeActive: toggleActive.checked });
});

bedtimeInput.addEventListener('change', () => {
  chrome.storage.local.set({ bedtime: bedtimeInput.value });
});

// Free block form
addFreeBtn.addEventListener('click', () => {
  freeBlockForm.style.display = freeBlockForm.style.display === 'flex' ? 'none' : 'flex';
  freeLabelInput.value = '';
  freeDurOpts.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
  freeConfirmBtn.disabled = true;
  pendingFreeDur = null;
});

freeDurOpts.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-val]');
  if (!btn) return;
  freeDurOpts.querySelectorAll('button').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
  pendingFreeDur = parseFloat(btn.dataset.val);
  freeConfirmBtn.disabled = !pendingFreeDur;
});

freeConfirmBtn.addEventListener('click', async () => {
  if (!pendingFreeDur) return;
  const label = freeLabelInput.value.trim() || 'Free time';
  const block = { id: uid(), label, durationHours: pendingFreeDur };
  freeBlocks.push(block);
  taskOrder.push(block.id);
  await saveScheduleState();
  freeBlockForm.style.display = 'none';
  const tasks = await loadTasks();
  renderSchedule(tasks);
});
