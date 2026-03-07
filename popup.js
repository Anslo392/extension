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

// Format a due date for display
function formatDue(dueDateISO) {
  const h = hoursUntil(dueDateISO);
  if (h <= 0) return 'overdue';
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
    const urgentClass = h < 24 ? ' urgent' : '';

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
  // Default to active if never set
  return data.webeActive !== undefined ? data.webeActive : true;
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
}

async function deleteTask(id) {
  let tasks = await loadTasks();
  tasks = tasks.filter(t => t.id !== id);
  await saveTasks(tasks);
  renderTasks(tasks);
}

// ---------- init ----------

(async () => {
  // Render tasks
  const tasks = await loadTasks();
  renderTasks(tasks);

  // Show minutes saved
  const mins = await loadMinutesSaved();
  minutesSavedEl.textContent = Math.round(mins);

  // Set toggle state
  toggleActive.checked = await loadActive();
})();

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
