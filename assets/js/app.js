const API_URL = 'https://webtechdomains.in/work-management/api/';
const AUTH_TOKEN_KEY = 'work_management_access_token';
const COMMENT_FILE_LIMIT = 5;
const COMMENT_FILE_MAX_BYTES = 5 * 1024 * 1024;
const API_ENDPOINTS = {
    login: 'login',
    logout: 'logout',
    'dashboard.get': 'dashboard',
    'users.list': 'users',
    'users.save': 'users/save',
    'users.delete': 'users/delete',
    'roles.list': 'roles',
    'roles.save': 'roles/save',
    'developers.list': 'developers',
    'developers.save': 'developers/save',
    'developers.delete': 'developers/delete',
    'developers.worklogs': 'developers/worklogs',
    'developers.work_logs': 'developers/work-logs',
    'my.tasks': 'my/tasks',
    'task.assignments': 'tasks/assignments',
    'task.list': 'tasks',
    'task.find': 'tasks/find',
    'task.get': 'tasks/get',
    'task.search': 'tasks/search',
    'task.overdue': 'tasks/overdue',
    'task.save': 'tasks/save',
    'task.bulk_import': 'tasks/bulk-import',
    'task.time_log': 'tasks/time-log',
    'task.comment': 'tasks/comment',
    'task.delete': 'tasks/delete',
    'projects.save': 'projects/save',
    'projects.delete': 'projects/delete'
};
const state = {
    user: null,
    authToken: localStorage.getItem(AUTH_TOKEN_KEY) || '',
    csrfToken: '',
    permissions: [],
    roles: {},
    users: [],
    developers: [],
    projects: [],
    taskIssues: [],
    availablePermissions: {},
    currentIssue: null,
    activityTab: 'all',
    taskColumnPages: {},
    pagination: {
        users: { page: 1, perPage: 20 },
        developers: { page: 1, perPage: 20 },
        roles: { page: 1, perPage: 20 },
        projects: { page: 1, perPage: 20 }
    }
};

const TASK_BATCH_SIZE = 20;
const TASK_STATUSES = ['Todo', 'In Progress', 'Blocked', 'Paused', 'Unsolved', 'Done'];
let taskLazyObservers = [];
let lastWorklogData = null;
let lastDevWorklogData = null;
let searchDebounceTimer = null;
const $ = (selector) => document.querySelector(selector);

function can(permission) {
    return state.permissions.includes(permission);
}

function refreshPermissionVisibility(root = document) {
    root.querySelectorAll('[data-permission]').forEach((element) => {
        element.hidden = !can(element.dataset.permission);
    });

    root.querySelectorAll('[data-permission-text]').forEach((element) => {
        element.hidden = !can(element.dataset.permissionText);
    });
}

function setButtonPermission(selector, permission) {
    const button = $(selector);

    if (!button) {
        return;
    }

    button.dataset.permission = permission;
    button.hidden = !can(permission);
}

function showMessage(message, type = 'flash') {
    if (!message) {
        return;
    }

    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const text = document.createElement('span');
    text.textContent = message;

    const close = document.createElement('button');
    close.className = 'toast-close';
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.textContent = '×';
    close.addEventListener('click', () => dismissToast(toast));

    toast.appendChild(text);
    toast.appendChild(close);
    container.appendChild(toast);

    setTimeout(() => dismissToast(toast), type === 'error' ? 6000 : 4000);
}

function dismissToast(toast) {
    if (!toast.isConnected) {
        return;
    }

    toast.classList.add('toast-hiding');
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
}

function setLoading(button, loading) {
    if (!button) return;
    if (loading) {
        button.disabled = true;
        button.dataset.originalText = button.textContent.trim();
        button.innerHTML = '<span class="btn-spinner"></span>' + escapeHtml(button.dataset.originalText);
    } else {
        button.disabled = false;
        button.textContent = button.dataset.originalText || button.textContent;
        delete button.dataset.originalText;
    }
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatCommentText(text) {
    if (!text) return '';
    const urlRegex = /https?:\/\/\S+/g;
    const parts = [];
    let lastIndex = 0;
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
        const fullMatch = match[0];
        const url = fullMatch.replace(/[.,;:!?)'"]+$/, '');
        if (match.index > lastIndex) {
            parts.push({ type: 'text', value: text.slice(lastIndex, match.index) });
        }
        parts.push({ type: 'url', value: url });
        if (url.length < fullMatch.length) {
            parts.push({ type: 'text', value: fullMatch.slice(url.length) });
        }
        lastIndex = match.index + fullMatch.length;
    }
    if (lastIndex < text.length) {
        parts.push({ type: 'text', value: text.slice(lastIndex) });
    }
    return parts.map((part) => {
        if (part.type === 'url') {
            const href = escapeHtml(part.value);
            return `<a href="${href}" target="_blank" rel="noopener noreferrer" class="comment-link">${href}</a>`;
        }
        return escapeHtml(part.value).replace(/\n/g, '<br>');
    }).join('');
}

function formatBytes(bytes) {
    const size = Number(bytes || 0);

    if (size >= 1024 * 1024) {
        return `${(size / 1024 / 1024).toFixed(1)} MB`;
    }

    if (size >= 1024) {
        return `${Math.ceil(size / 1024)} KB`;
    }

    return `${size} B`;
}

function dataUrlForAttachment(file) {
    return `data:${file.type || 'application/octet-stream'};base64,${file.data || ''}`;
}

function renderAttachments(files = []) {
    if (!files.length) {
        return '';
    }

    return `<div class="attachment-list">${files.map((file) => `
        <a class="attachment-link" href="${escapeHtml(dataUrlForAttachment(file))}" download="${escapeHtml(file.name || 'attachment')}">
            ${escapeHtml(file.name || 'attachment')} <span>${escapeHtml(formatBytes(file.size))}</span>
        </a>
    `).join('')}</div>`;
}

async function readFileAsAttachment(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
            const result = String(reader.result || '');

            resolve({
                name: file.name,
                type: file.type || 'application/octet-stream',
                size: file.size,
                data: result.includes(',') ? result.split(',').pop() : ''
            });
        };
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.readAsDataURL(file);
    });
}

async function compressImage(file, quality = 0.7) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        const reader = new FileReader();

        reader.onload = e => {
            img.src = e.target.result;
        };

        reader.onerror = reject;
        img.onload = () => {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');

            canvas.width = img.width;
            canvas.height = img.height;

            ctx.drawImage(img, 0, 0);
            canvas.toBlob(
                blob => {
                    if (!blob) {
                        reject(new Error('Compression failed'));
                        return;
                    }
                    // Convert Blob → File
                    const compressedFile = new File(
                        [blob],
                        file.name,
                        {
                            type: file.type,
                            lastModified: Date.now()
                        }
                    );
                    resolve(compressedFile);
                },
                file.type,
                quality
            );
        };
        reader.readAsDataURL(file);
    });
}

async function prepareAttachment(file) {
    let processedFile = file;
    const compressibleTypes = [
        'image/jpeg',
        'image/png',
        'image/webp'
    ];

    if (compressibleTypes.includes(file.type)) {
        processedFile = await compressImage(file, 0.7);
    }

    return await readFileAsAttachment(processedFile);
}

async function attachmentsFromInput(input) {
    const files = Array.from(input.files || []);

    if (files.length > COMMENT_FILE_LIMIT) {
        throw new Error(`Upload ${COMMENT_FILE_LIMIT} files or fewer.`);
    }

    files.forEach((file) => {
        if (file.size > COMMENT_FILE_MAX_BYTES) {
            throw new Error(`${file.name} is larger than ${formatBytes(COMMENT_FILE_MAX_BYTES)}.`);
        }
    });

    return Promise.all(files.map(prepareAttachment));
}

function formatDateTime(value) {
    if (!value) {
        return '';
    }

    const date = new Date(value);

    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function formatDate(value) {
    if (!value) {
        return '';
    }

    const text = String(value);

    if (text.includes(' to ')) {
        return text.split(' to ').map(formatDate).join(' to ');
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
        return text;
    }

    const date = new Date(`${text}T00:00:00`);

    return Number.isNaN(date.getTime()) ? text : date.toLocaleDateString();
}

function todayDate() {
    return localDateInputValue(new Date());
}

function isoDateOffset(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);

    return localDateInputValue(date);
}

function localDateInputValue(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `${year}-${month}-${day}`;
}

function issueTotalHours(issue) {
    return (issue.work_logs || []).reduce((total, entry) => total + Number(entry.hours || 0), 0);
}

function badge(value, type = 'neutral') {
    return `<span class="badge ${type}">${escapeHtml(value)}</span>`;
}

function permissionChips(permissions) {
    permissions = permissions || [];
    const visible = permissions.slice(0, 6);
    const hiddenCount = Math.max(0, permissions.length - visible.length);
    const chips = visible
        .map((permission) => `<span class="permission-chip">${escapeHtml(state.availablePermissions[permission] || permission)}</span>`)
        .join('');

    return `<div class="permission-chips">${chips}${hiddenCount ? `<span class="permission-chip muted">+${hiddenCount} more</span>` : ''}</div>`;
}

function renderPagination(selector, pagination) {
    const element = $(selector);

    if (!element || !pagination) {
        return;
    }

    const start = pagination.total === 0 ? 0 : ((pagination.page - 1) * pagination.per_page) + 1;
    const end = Math.min(pagination.page * pagination.per_page, pagination.total);

    element.innerHTML = `<div class="pagination-summary">Showing ${start}-${end} of ${pagination.total}</div>
        <div class="pagination-actions">
            <button class="secondary" data-page="${pagination.page - 1}" type="button" ${pagination.has_prev ? '' : 'disabled'}>Previous</button>
            <span>Page ${pagination.page} of ${pagination.total_pages}</span>
            <button class="secondary" data-page="${pagination.page + 1}" type="button" ${pagination.has_next ? '' : 'disabled'}>Next</button>
        </div>`;
}

function taskBatchKey(projectId, status) {
    return `${projectId}:${status}`;
}

async function loadMoreTasks(projectId, status) {
    const key = taskBatchKey(projectId, status);
    const col = state.taskColumnPages[key];

    if (!col || col.loading || !col.hasMore) {
        return;
    }

    col.loading = true;
    renderProjectBoard();

    try {
        const nextPage = col.page + 1;
        const data = await apiRequest('task.list', {
            project_id: projectId,
            status,
            page: nextPage,
            per_page: TASK_BATCH_SIZE
        });

        const newIssues = data.issues || [];
        const existingIds = new Set(state.taskIssues.map((i) => i.id));
        state.taskIssues = [
            ...state.taskIssues,
            ...newIssues.filter((i) => !existingIds.has(i.id))
        ];
        state.taskColumnPages[key] = {
            page: nextPage,
            hasMore: data.pagination?.has_next === true,
            total: data.pagination?.total ?? col.total,
            loading: false
        };
    } catch (error) {
        state.taskColumnPages[key] = { ...col, loading: false };
        showMessage(error.message, 'error');
    }

    renderProjectBoard();
}

function observeTaskSentinels() {
    taskLazyObservers.forEach((obs) => obs.disconnect());
    taskLazyObservers = [];

    if (!('IntersectionObserver' in window)) {
        return;
    }

    document.querySelectorAll('.lazy-task-sentinel').forEach((sentinel) => {
        const scrollRoot = sentinel.closest('.task-list');
        const obs = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) {
                    return;
                }

                obs.unobserve(entry.target);
                entry.target.textContent = 'Loading more tasks...';
                window.setTimeout(() => {
                    loadMoreTasks(Number(entry.target.dataset.projectId), entry.target.dataset.status);
                }, 180);
            });
        }, {
            root: scrollRoot,
            rootMargin: '60px',
            threshold: 0.1
        });

        obs.observe(sentinel);
        taskLazyObservers.push(obs);
    });
}

function openModal(id) {
    const backdrop = $(`#${id}`);
    backdrop.classList.remove('modal-closing');
    backdrop.hidden = false;
    backdrop.classList.add('modal-opening');
    setTimeout(() => backdrop.classList.remove('modal-opening'), 260);
}

function closeModal(id) {
    const backdrop = $(`#${id}`);
    if (backdrop.hidden) {
        return;
    }

    backdrop.classList.remove('modal-opening');
    backdrop.classList.add('modal-closing');
    setTimeout(() => {
        backdrop.hidden = true;
        backdrop.classList.remove('modal-closing');
    }, 160);
}

async function apiRequest(action, payload = {}) {
    const endpoint = API_ENDPOINTS[action];

    if (!endpoint) {
        throw new Error(`Unknown API endpoint: ${action}`);
    }

    const requestBody = JSON.stringify(payload);
    const headers = {
        'Content-Type': 'application/json'
    };
    const authToken = state.authToken || localStorage.getItem(AUTH_TOKEN_KEY) || '';

    if (authToken) {
        headers.Authorization = `Bearer ${authToken}`;
    }

    if (authToken) {
        const timestamp = Math.floor(Date.now() / 1000).toString();
        const nonce = crypto.randomUUID();
        const signature = CryptoJS.HmacSHA256(`${timestamp}.${nonce}.${requestBody}`, authToken).toString();

        headers['X-CSRF-Token'] = authToken;
        headers['X-Timestamp'] = timestamp;
        headers['X-Nonce'] = nonce;
        headers['X-Signature'] = signature;
    }

    try {
        const response = await axios.post(
            `${API_URL}${endpoint}`,
            requestBody,
            { headers }
        );
        const data = response.data;
        if (!data.ok) {
            throw new Error(data.message || 'Request failed.');
        }
        return data;
    } catch (error) {
        // Axios HTTP error
        if (error.response) {
            const data = error.response.data || {};
            throw new Error(data.message || `Request failed with HTTP ${error.response.status}`);
        }
        // Network / parsing error
        throw new Error(error.message || 'Invalid API response.');
    }
}

function setSession(data) {
    state.user = data.user;
    state.authToken = data.access_token || state.authToken || localStorage.getItem(AUTH_TOKEN_KEY) || '';
    state.csrfToken = data.csrf_token || state.authToken || '';
    if (state.authToken) {
        localStorage.setItem(AUTH_TOKEN_KEY, state.authToken);
    }
    state.permissions = data.permissions || [];
    state.roles = data.roles || state.roles || {};

    document.body.classList.remove('login-page');
    document.body.classList.add('app-page');
    $('#login-view').hidden = true;
    $('#app-view').hidden = false;
    $('#nav').hidden = false;
    $('#current-user').textContent = state.user ? state.user.name : '';

    refreshPermissionVisibility();
    $('#task-comment-form').hidden = !can('task.comment');
    $('#task-time-form').hidden = !can('task.time_log');
}

function clearSession() {
    state.user = null;
    state.authToken = '';
    state.csrfToken = '';
    state.permissions = [];
    localStorage.removeItem(AUTH_TOKEN_KEY);
    document.body.classList.add('login-page');
    document.body.classList.remove('app-page');
    $('#login-view').hidden = false;
    $('#app-view').hidden = true;
    $('#nav').hidden = true;
}

function showView(name) {
    document.querySelectorAll('.view').forEach((view) => {
        const active = view.id === `${name}-view`;
        view.hidden = !active;

        if (active) {
            view.classList.add('view-entering');
            setTimeout(() => view.classList.remove('view-entering'), 250);
        }
    });
}

function normalizePage(page) {
    return page === 'tasks' ? 'projects' : page;
}

function setActiveNav(page) {
    document.querySelectorAll('#nav a').forEach((link) => {
        link.classList.toggle('active', link.getAttribute('href') === `#${page}`);
    });
}

function resetUserForm() {
    const form = $('#user-form');
    $('#user-form-title').textContent = 'New User';
    form.reset();
    form.elements.id.value = '0';
    form.elements.active.checked = true;
    setButtonPermission('#save-user-button', 'users.create');
    closeModal('user-modal');
}

function resetRoleForm() {
    const form = $('#role-form');
    $('#role-form-title').textContent = 'New Role';
    form.reset();
    form.elements.original_key.value = '';
    setButtonPermission('#save-role-button', 'roles.manage');
    closeModal('role-modal');
}

function resetDeveloperForm() {
    const form = $('#developer-form');
    $('#developer-form-title').textContent = 'New Developer';
    form.reset();
    form.elements.id.value = '0';
    form.elements.active.checked = true;
    setButtonPermission('#save-developer-button', 'developers.create');
    closeModal('developer-modal');
}

async function loadDashboard() {
    const data = await apiRequest('dashboard.get');
    $('#dashboard-welcome').textContent = `Welcome, ${data.user.name}.`;
    $('#stat-users').textContent = data.stats.users;
    $('#stat-user-summary').textContent = `${data.stats.active_users} active`;
    $('#stat-roles').textContent = data.stats.roles;
    $('#stat-projects').textContent = data.stats.projects;
    $('#stat-project-summary').textContent = `${data.stats.active_projects} active`;
    $('#stat-open-tasks').textContent = data.stats.open_tasks;
    $('#stat-todo-tasks').textContent = data.stats.todo_tasks;
    $('#stat-in-progress-tasks').textContent = data.stats.in_progress_tasks;
    $('#stat-active-today-summary').textContent = `${data.stats.active_today_tasks} active today`;
    $('#stat-done-tasks').textContent = data.stats.done_tasks;
    $('#stat-completed-summary').textContent = `${data.stats.completed_today_tasks} completed today`;
    $('#stat-blocked-tasks').textContent = data.stats.blocked_tasks;
    $('#stat-critical-summary').textContent = `${data.stats.critical_tasks} critical`;
    $('#stat-paused-tasks').textContent = data.stats.paused_tasks;
    $('#stat-unsolved-tasks').textContent = data.stats.unsolved_tasks;
    $('#stat-assigned-tasks').textContent = data.stats.assigned_tasks;
    $('#stat-assigned-summary').textContent = `${data.stats.unassigned_tasks} unassigned`;
    $('#stat-no-developer-tasks').textContent = data.stats.tasks_without_developer;
    $('#stat-completion-rate').textContent = `${Number(data.stats.completion_rate || 0).toFixed(1)}%`;
    $('#stat-average-hours').textContent = `${Number(data.stats.avg_hours_per_task || 0).toFixed(2)}h average per task`;
    $('#stat-total-hours').textContent = `${Number(data.stats.total_hours || 0).toFixed(2)}h`;
    $('#stat-today-hours').textContent = `${Number(data.stats.today_hours || 0).toFixed(2)}h`;
    $('#stat-week-hours').textContent = `${Number(data.stats.week_hours || 0).toFixed(2)}h`;
    $('#stat-my-projects').textContent = data.stats.my_projects;
    $('#stat-my-tasks').textContent = data.stats.my_assigned_tasks;
    $('#stat-my-open-tasks').textContent = `${data.stats.my_open_tasks} open`;
    $('#stat-my-hours').textContent = `${Number(data.stats.my_hours || 0).toFixed(2)}h`;
    $('#stat-my-today-hours').textContent = `${Number(data.stats.my_today_hours || 0).toFixed(2)}h today`;
    $('#stat-my-work-logs').textContent = data.stats.my_work_logs;
    $('#stat-my-activity').textContent = `${data.stats.my_work_logs} work logs, ${data.stats.my_comments} comments`;
    $('#stat-developers').textContent = data.stats.developers;
    $('#stat-developer-summary').textContent = `${data.stats.active_developers} active`;
    $('#stat-task-summary').textContent = `${data.stats.tasks} total tasks`;
    $('#stat-permissions').textContent = `${data.stats.permissions} permissions`;

    if (can('task.view')) {
        apiRequest('task.overdue').then((od) => {
            const navBadge = $('#overdue-nav-badge');
            if (od.total > 0) {
                navBadge.textContent = od.total;
                navBadge.hidden = false;
            }
        }).catch(() => {});
    }
}

async function loadUsers() {
    const data = await apiRequest('users.list', {
        page: state.pagination.users.page,
        per_page: state.pagination.users.perPage
    });
    state.users = data.users;
    state.roles = data.roles;
    state.pagination.users.page = data.pagination.page;

    const roleSelect = $('#user-role');
    roleSelect.innerHTML = Object.entries(state.roles)
        .map(([key, role]) => `<option value="${escapeHtml(key)}">${escapeHtml(role.name)}</option>`)
        .join('');

    $('#users-table').innerHTML = state.users.map((user) => {
        const roleName = state.roles[user.role]?.name || user.role;
        const actions = [
            can('users.edit') ? `<button class="secondary" data-edit-user="${user.id}" type="button">Edit</button>` : '',
            can('users.delete') && user.id !== state.user.id ? `<button class="danger" data-delete-user="${user.id}" type="button">Delete</button>` : ''
        ].join('');

        return `<tr>
            <td>${escapeHtml(user.name)}</td>
            <td><span class="key-chip">${escapeHtml(user.employee_id || '')}</span></td>
            <td>${escapeHtml(user.job_position || '')}</td>
            <td>${escapeHtml(user.email)}</td>
            <td>${escapeHtml(roleName)}</td>
            <td>${badge(user.active ? 'Active' : 'Inactive', user.active ? 'active' : 'neutral')}</td>
            <td><div class="actions">${actions}</div></td>
        </tr>`;
    }).join('') || '<tr><td colspan="7">No users found.</td></tr>';
    renderPagination('#users-pagination', data.pagination);
}

async function loadRoles() {
    const data = await apiRequest('roles.list', {
        page: state.pagination.roles.page,
        per_page: state.pagination.roles.perPage
    });
    state.roles = data.roles;
    state.availablePermissions = data.available_permissions;
    state.pagination.roles.page = data.pagination.page;

    $('#permission-list').innerHTML = Object.entries(state.availablePermissions)
        .map(([permission, label]) => `<label><input name="permissions" type="checkbox" value="${escapeHtml(permission)}"> ${escapeHtml(label)}</label>`)
        .join('');

    $('#roles-table').innerHTML = Object.entries(state.roles).map(([key, role]) => {
        const action = can('roles.manage') ? `<button class="secondary" data-edit-role="${escapeHtml(key)}" type="button">Edit</button>` : '';

        return `<tr>
            <td><span class="key-chip">${escapeHtml(key)}</span></td>
            <td>${escapeHtml(role.name)}</td>
            <td>${permissionChips(role.permissions)}</td>
            <td>${action}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="4">No roles found.</td></tr>';
    renderPagination('#roles-pagination', data.pagination);
}

async function loadDevelopers() {
    const data = await apiRequest('developers.list', {
        page: state.pagination.developers.page,
        per_page: state.pagination.developers.perPage
    });
    state.developers = data.developers;
    state.pagination.developers.page = data.pagination.page;

    $('#developers-table').innerHTML = state.developers.map((developer) => {
        const actions = [
            can('developers.edit') ? `<button class="secondary" data-edit-developer="${developer.id}" type="button">Edit</button>` : '',
            can('developers.delete') ? `<button class="danger" data-delete-developer="${developer.id}" type="button">Delete</button>` : ''
        ].join('');

        return `<tr>
            <td>${escapeHtml(developer.name)}</td>
            <td><span class="key-chip">${escapeHtml(developer.git_username)}</span></td>
            <td>${badge(developer.active ? 'Active' : 'Inactive', developer.active ? 'active' : 'neutral')}</td>
            <td><div class="actions">${actions}</div></td>
        </tr>`;
    }).join('') || '<tr><td colspan="4">No developers found.</td></tr>';
    renderPagination('#developers-pagination', data.pagination);
}

async function loadWorklogs() {
    if (!$('#worklog-date-from').value) {
        $('#worklog-date-from').value = isoDateOffset(-6);
    }

    if (!$('#worklog-date-to').value) {
        $('#worklog-date-to').value = todayDate();
    }

    $('#worklogs-table').innerHTML = '<tr class="loading-row"><td colspan="5">Loading…</td></tr>';

    const data = await apiRequest('developers.worklogs', {
        user_id: Number($('#worklog-user-filter').value || 0),
        date_from: $('#worklog-date-from').value,
        date_to: $('#worklog-date-to').value
    });

    lastWorklogData = data;

    const currentUserId = Number($('#worklog-user-filter').value || 0);
    $('#worklog-user-filter').innerHTML = [
        '<option value="0">All users</option>',
        ...data.users.map((user) => `<option value="${user.id}" ${currentUserId === Number(user.id) ? 'selected' : ''}>${escapeHtml(user.name)}</option>`)
    ].join('');

    $('#worklogs-table').innerHTML = renderWorklogRows(data.logs, data.total_hours);
}

function renderWorklogRows(logs, finalTotalHours) {
    if (!logs || !logs.length) {
        return '<tr><td colspan="5">No work logs found for this period.</td></tr>';
    }

    const userGroups = new Map();

    logs.forEach((log) => {
        const key = `${log.user_id || 0}:${log.user_name || 'Unknown'}`;

        if (!userGroups.has(key)) {
            userGroups.set(key, { name: log.user_name || 'Unknown', hours: 0, logs: [] });
        }

        const group = userGroups.get(key);
        group.hours += Number(log.hours || 0);
        group.logs.push(log);
    });

    const html = [];

    userGroups.forEach((group) => {
        html.push(`<tr class="group-row user-group"><td colspan="5">User: ${escapeHtml(group.name)}</td></tr>`);

        group.logs.forEach((log) => {
            html.push(`<tr>
                <td class="date-cell">${escapeHtml(formatDate(log.work_date))}</td>
                <td><span class="key-chip">${escapeHtml(log.task_id)}</span> ${escapeHtml(log.task_title)}</td>
                <td>${escapeHtml(log.project || 'No project')}</td>
                <td class="hours-column">${Number(log.hours || 0).toFixed(2)}h</td>
                <td class="note-cell" title="${escapeHtml(log.note || '')}">${escapeHtml(log.note || '—')}</td>
            </tr>`);
        });

        html.push(`<tr class="total-row"><td colspan="3">Total for ${escapeHtml(group.name)}</td><td class="hours-column">${group.hours.toFixed(2)}h</td><td></td></tr>`);
    });

    html.push(`<tr class="final-total-row"><td colspan="3">Total hours</td><td class="hours-column">${Number(finalTotalHours || 0).toFixed(2)}h</td><td></td></tr>`);

    return html.join('');
}

async function loadDeveloperWorkLogs() {
    if (!$('#dev-worklogs-date-from').value) {
        $('#dev-worklogs-date-from').value = isoDateOffset(-6);
    }

    if (!$('#dev-worklogs-date-to').value) {
        $('#dev-worklogs-date-to').value = todayDate();
    }

    $('#dev-work-logs-table').innerHTML = '<tr class="loading-row"><td colspan="6">Loading…</td></tr>';

    const data = await apiRequest('developers.work_logs', {
        developer_id: Number($('#dev-worklogs-developer-filter').value || 0),
        date_from: $('#dev-worklogs-date-from').value,
        date_to: $('#dev-worklogs-date-to').value
    });

    lastDevWorklogData = data;

    const currentDevId = Number($('#dev-worklogs-developer-filter').value || 0);
    $('#dev-worklogs-developer-filter').innerHTML = [
        '<option value="0">All developers</option>',
        ...data.developers.map((developer) => `<option value="${developer.id}" ${currentDevId === Number(developer.id) ? 'selected' : ''}>${escapeHtml(developer.name)}</option>`)
    ].join('');

    $('#dev-work-logs-table').innerHTML = renderDeveloperWorklogReportRows(data.logs, data.total_hours);
}

function renderDeveloperWorklogReportRows(logs, finalTotalHours) {
    if (!logs || !logs.length) {
        return '<tr><td colspan="6">No developer work logs found for this period.</td></tr>';
    }

    const developerGroups = new Map();

    logs.forEach((log) => {
        const key = `${log.developer_id || 0}:${log.developer_name || 'Unassigned'}`;

        if (!developerGroups.has(key)) {
            developerGroups.set(key, {
                name: log.developer_name || 'Unassigned',
                git: log.git_username || '',
                hours: 0,
                logs: []
            });
        }

        const developer = developerGroups.get(key);
        developer.hours += Number(log.hours || 0);
        developer.logs.push(log);
    });

    const html = [];

    developerGroups.forEach((developer) => {
        html.push(`<tr class="group-row developer-group"><td colspan="6">Developer: ${escapeHtml(developer.name)}${developer.git ? ` <span class="muted-text">(${escapeHtml(developer.git)})</span>` : ''}</td></tr>`);

        developer.logs.forEach((log) => {
            html.push(`<tr>
                <td class="date-cell">${escapeHtml(formatDate(log.work_date))}</td>
                <td><span class="key-chip">${escapeHtml(log.task_id)}</span> ${escapeHtml(log.task_title)}</td>
                <td>${escapeHtml(log.user_name || 'Unknown')}</td>
                <td>${escapeHtml(log.project || 'No project')}</td>
                <td class="hours-column">${Number(log.hours || 0).toFixed(2)}h</td>
                <td class="note-cell" title="${escapeHtml(log.note || '')}">${escapeHtml(log.note || '—')}</td>
            </tr>`);
        });

        html.push(`<tr class="total-row"><td colspan="4">Total for ${escapeHtml(developer.name)}</td><td class="hours-column">${developer.hours.toFixed(2)}h</td><td></td></tr>`);
    });

    html.push(`<tr class="final-total-row"><td colspan="4">Total hours</td><td class="hours-column">${Number(finalTotalHours || 0).toFixed(2)}h</td><td></td></tr>`);

    return html.join('');
}

function downloadCsv(filename, headers, rows) {
    const escapeCell = (value) => {
        const str = String(value ?? '');
        return str.includes(',') || str.includes('"') || str.includes('\n') ? `"${str.replace(/"/g, '""')}"` : str;
    };
    const csv = [headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\n');
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

async function loadMyTasks() {
    $('#my-tasks-content').innerHTML = '<div class="loading-tasks"><span class="spinner"></span> Loading your tasks…</div>';

    const data = await apiRequest('my.tasks');

    // Merge users, developers, and tasks into state for the details modal
    if (Array.isArray(data.users)) state.users = data.users;
    if (Array.isArray(data.developers)) state.developers = data.developers;

    (data.tasks || []).forEach((task) => {
        const idx = state.taskIssues.findIndex((t) => t.id === task.id);
        if (idx === -1) state.taskIssues.push(task);
        else state.taskIssues[idx] = task;
    });

    if (!data.tasks || !data.tasks.length) {
        $('#my-tasks-content').innerHTML = '<p class="empty-state">No tasks are currently assigned to you.</p>';
        return;
    }

    const STATUS_GROUPS = [
        { key: 'In Progress', label: 'In Progress' },
        { key: 'Blocked', label: 'Blocked' },
        { key: 'Unsolved', label: 'Unsolved' },
        { key: 'Paused', label: 'Paused' },
        { key: 'Todo', label: 'To Do' },
        { key: 'Done', label: 'Done' },
    ];
    const MY_TASKS_LIMIT = 12;

    const grouped = {};
    STATUS_GROUPS.forEach(({ key }) => { grouped[key] = []; });
    data.tasks.forEach((task) => {
        if (grouped[task.status] !== undefined) grouped[task.status].push(task);
    });

    const priorityType = { Critical: 'warning', High: 'warning', Medium: 'neutral', Low: 'neutral' };

    const html = STATUS_GROUPS
        .filter(({ key }) => grouped[key]?.length)
        .map(({ key, label }) => {
            const all = grouped[key];
            const hiddenCount = Math.max(0, all.length - MY_TASKS_LIMIT);
            const cards = all.map((task, idx) => {
                const hours = issueTotalHours(task);
                const extraClass = idx >= MY_TASKS_LIMIT ? ' my-task-hidden' : '';
                return `<div class="my-task-card${extraClass}" data-view-task="${task.id}">
                    <div class="my-task-meta">
                        <span class="key-chip">${escapeHtml(task.task_id)}</span>
                        ${badge(task.priority || 'Normal', priorityType[task.priority] || 'neutral')}
                        ${hours > 0 ? `<span class="my-task-hours">${hours.toFixed(1)}h</span>` : ''}
                    </div>
                    <p class="my-task-title">${escapeHtml(task.title)}</p>
                    <span class="muted-text my-task-project">${escapeHtml(task.project || 'No project')}</span>
                </div>`;
            }).join('') + (hiddenCount > 0 ? `<button class="my-tasks-show-more" type="button">Show more (+${hiddenCount})</button>` : '');

            const cssKey = key.toLowerCase().replace(/\s+/g, '_');
            return `<div class="my-tasks-group">
                <h3 class="my-tasks-group-title my-tasks-${cssKey}">${escapeHtml(label)} <span class="task-count-badge">${all.length}</span></h3>
                <div class="my-tasks-cards">${cards}</div>
            </div>`;
        }).join('');

    $('#my-tasks-content').innerHTML = html;
}

async function loadOverdueTasks() {
    $('#overdue-tasks-table').innerHTML = '<tr class="loading-row"><td colspan="9">Loading…</td></tr>';

    const data = await apiRequest('task.overdue');

    const navBadge = $('#overdue-nav-badge');
    if (data.total > 0) {
        navBadge.textContent = data.total;
        navBadge.hidden = false;
        $('#overdue-tasks-subtitle').textContent = `${data.total} task${data.total !== 1 ? 's' : ''} whose start date has passed and are not yet complete.`;
    } else {
        navBadge.hidden = true;
    }

    if (!data.tasks || !data.tasks.length) {
        $('#overdue-tasks-table').innerHTML = '<tr><td colspan="9">No overdue tasks found.</td></tr>';
        return;
    }

    $('#overdue-tasks-table').innerHTML = data.tasks.map((task) => {
        const urgency = task.days_overdue > 7 ? 'overdue-critical' : task.days_overdue >= 3 ? 'overdue-warning' : 'overdue-mild';
        const priorityClass = task.priority === 'critical' ? 'warning' : 'neutral';
        return `<tr class="${urgency}">
            <td><span class="key-chip">${escapeHtml(task.task_id)}</span></td>
            <td>${escapeHtml(task.title)}</td>
            <td>${escapeHtml(task.project || 'No project')}</td>
            <td>${escapeHtml(task.assignee || 'Unassigned')}</td>
            <td>${badge(task.priority || 'normal', priorityClass)}</td>
            <td>${badge(task.status, 'neutral')}</td>
            <td>${escapeHtml(formatDate(task.start_date))}</td>
            <td class="overdue-days-cell">${task.days_overdue} day${task.days_overdue !== 1 ? 's' : ''}</td>
            <td><button class="secondary" data-load-task="${task.id}" type="button">Details</button></td>
        </tr>`;
    }).join('');
}

async function openTaskById(id) {
    try {
        const data = await apiRequest('task.get', { id: Number(id) });
        mergeTaskLookupData(data);
        showTaskDetails(data.issue);
        openModal('task-details-modal');
    } catch (error) {
        showMessage(error.message, 'error');
    }
}

async function performSearch(query) {
    if (!query || query.length < 2) {
        $('#search-results').innerHTML = '<p class="search-hint">Type at least 2 characters…</p>';
        return;
    }

    $('#search-results').innerHTML = '<p class="search-hint">Searching…</p>';

    try {
        const data = await apiRequest('task.search', { query });

        if (!data.tasks.length) {
            $('#search-results').innerHTML = '<p class="search-hint">No tasks found.</p>';
            return;
        }

        $('#search-results').innerHTML = data.tasks.map((task) => {
            const statusSlug = String(task.status || '').toLowerCase().replaceAll(' ', '-');
            return `<div class="search-result" data-load-task="${task.id}" role="button" tabindex="0">
                <div class="search-result-main">
                    <span class="key-chip">${escapeHtml(task.task_id)}</span>
                    <span class="search-result-title">${escapeHtml(task.title)}</span>
                </div>
                <div class="search-result-meta">
                    <span class="muted-text">${escapeHtml(task.project || '')}</span>
                    ${badge(task.status, statusSlug)}
                </div>
            </div>`;
        }).join('') + `<p class="search-hint">${data.tasks.length} result${data.tasks.length !== 1 ? 's' : ''}</p>`;
    } catch (error) {
        $('#search-results').innerHTML = `<p class="search-hint error-text">${escapeHtml(error.message)}</p>`;
    }
}

async function loadTaskAssignments() {
    if (!$('#task-assignment-date-from').value) {
        $('#task-assignment-date-from').value = todayDate();
    }

    if (!$('#task-assignment-date-to').value) {
        $('#task-assignment-date-to').value = todayDate();
    }

    const selectedUser = $('#task-assignment-user-filter').value || '';
    const selectedDeveloper = $('#task-assignment-developer-filter').value || '';
    const data = await apiRequest('task.assignments', {
        user_name: selectedUser,
        developer_id: Number(selectedDeveloper),
        date_from: $('#task-assignment-date-from').value,
        date_to: $('#task-assignment-date-to').value
    });

    $('#task-assignment-user-filter').innerHTML = [
        '<option value="">All users</option>',
        ...(data.assignees || []).map((name) => `<option value="${escapeHtml(name)}" ${selectedUser === name ? 'selected' : ''}>${escapeHtml(name)}</option>`)
    ].join('');

    $('#task-assignment-developer-filter').innerHTML = [
        '<option value="">All developers</option>',
        ...(data.developers || []).map((developer) => {
            const value = String(developer.id);
            const label = developer.git_username ? `${developer.name} (${developer.git_username})` : developer.name;
            return `<option value="${escapeHtml(value)}" ${selectedDeveloper === value ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        })
    ].join('');

    $('#task-assignments-table').innerHTML = data.rows.map((row) => {
        const developers = (row.developers || []).length
            ? `<div class="permission-chips">${row.developers.map((developer) => `<span class="permission-chip">${escapeHtml(developer.name)}${developer.git_username ? ` <span class="muted-text">(${escapeHtml(developer.git_username)})</span>` : ''}</span>`).join('')}</div>`
            : '<span class="muted-text">No developer assigned</span>';
        const timeLogNotes = (row.time_log_notes || []).length
            ? `<br><span class="muted-text">${escapeHtml(row.time_log_notes.join(', '))}</span>`
            : '';
        const dayTimeLog = data.can_view_time_logs
            ? `${Number(row.time_logged_hours || 0).toFixed(2)}h${timeLogNotes}`
            : '<span class="muted-text">No permission</span>';

        return `<tr>
            <td>${escapeHtml(formatDate(row.assignment_date))}</td>
            <td>${escapeHtml(row.user_name || 'Unassigned user')}</td>
            <td><strong>${escapeHtml(row.task_id)}</strong><br><span class="muted-text">${escapeHtml(row.title)}</span></td>
            <td>${escapeHtml(row.project || 'No project')}</td>
            <td>${developers}</td>
            <td>${dayTimeLog}</td>
            <td>${badge(row.status || 'Todo', String(row.status || 'neutral').toLowerCase().replaceAll(' ', '-'))}</td>
            <td>${badge(row.priority || 'Medium', 'neutral')}</td>
        </tr>`;
    }).join('') || '<tr><td colspan="8">No working tasks found for this date.</td></tr>';
}

async function loadTasks() {
    const data = await apiRequest('task.list', {
        page: state.pagination.projects.page,
        per_page: state.pagination.projects.perPage
    });
    state.taskIssues = data.issues;
    state.users = data.users || state.users;
    state.developers = data.developers || state.developers;
    state.projects = data.projects || [];
    state.pagination.projects.page = data.pagination.page;

    const columnHasMore = data.column_has_more || {};
    const columnTotals = data.column_totals || {};
    state.taskColumnPages = {};
    state.projects.forEach((project) => {
        TASK_STATUSES.forEach((status) => {
            const key = taskBatchKey(project.id, status);
            state.taskColumnPages[key] = {
                page: 1,
                hasMore: columnHasMore[key] === true,
                total: columnTotals[key] ?? null,
                loading: false
            };
        });
    });

    renderProjectOptions();
    renderProjectMembers();
    renderProjectBoard();
    renderPagination('#projects-pagination', data.pagination);
}

function renderProjectBoard() {
    $('#project-board').innerHTML = state.projects.map((project) => {
        const tasks = state.taskIssues.filter((issue) => Number(issue.project_id) === Number(project.id));
        const taskColumns = TASK_STATUSES.map((status) => renderTaskColumn(project, tasks, status)).join('');
        const projectActions = [
            can('task.create') ? `<button data-new-task="${project.id}" type="button">New Task</button>` : '',
            can('projects.edit') ? `<button class="secondary" data-edit-project="${project.id}" type="button">Edit Project</button>` : '',
            can('projects.delete') ? `<button class="danger" data-delete-project="${project.id}" type="button">Delete Project</button>` : ''
        ].join('');

        return `<section class="project-card">
            <div class="section-header">
                <div>
                    <h2>${escapeHtml(project.name)} <span>${escapeHtml(project.key)}</span></h2>
                    <p>${escapeHtml(project.description || '')}</p>
                    ${badge(project.status, project.status.toLowerCase())}
                    <p class="member-line">${escapeHtml(memberNames(project))}</p>
                </div>
                <div class="actions">${projectActions}</div>
            </div>
            <div class="task-board">${taskColumns}</div>
        </section>`;
    }).join('') || '<p class="empty-state">No projects found.</p>';
    observeTaskSentinels();
}

function renderTaskColumn(project, tasks, status) {
    const statusTasks = tasks.filter((issue) => issue.status === status);
    const key = taskBatchKey(project.id, status);
    const col = state.taskColumnPages[key] || { hasMore: false, loading: false };
    const cards = statusTasks.map(renderTaskCard).join('');

    let footer = '';
    if (col.loading) {
        footer = '<p class="load-more-tasks loading-tasks">Loading…</p>';
    } else if (col.hasMore) {
        footer = `<button class="load-more-tasks" data-load-more-tasks="1" data-project-id="${project.id}" data-status="${escapeHtml(status)}" type="button">Load more</button>
            <div class="lazy-task-sentinel" data-project-id="${project.id}" data-status="${escapeHtml(status)}"></div>`;
    }

    const displayTotal = col.total !== null && col.total !== undefined ? col.total : statusTasks.length;

    return `<section class="task-column">
        <div class="column-title">
            <span>${escapeHtml(status)}</span>
            <strong>${displayTotal}</strong>
        </div>
        <div class="task-list">${cards || '<p class="empty-state">No tasks</p>'}${footer}</div>
    </section>`;
}

function renderTaskCard(issue) {
    const hours = can('task.time_logs.view') ? `${issueTotalHours(issue).toFixed(2)}h` : '';
    const developers = developerNames(issue.developer_ids || []);
    const actions = [
        can('task.edit') ? `<button class="secondary" data-edit-task="${issue.id}" type="button">Edit</button>` : '',
        `<button class="secondary" data-view-task="${issue.id}" type="button">Details</button>`,
        can('task.delete') ? `<button class="danger" data-delete-task="${issue.id}" type="button">Delete</button>` : ''
    ].join('');

    return `<article class="task-card">
        <div class="task-key">${escapeHtml(issue.task_id)}</div>
        <h3>${escapeHtml(issue.title)}</h3>
        <div class="task-meta">
            ${badge(issue.priority, issue.priority.toLowerCase())}
            ${hours ? `<span>${escapeHtml(hours)}</span>` : ''}
        </div>
        <div class="task-dates">
            ${issue.start_date ? `<span>Start ${escapeHtml(formatDate(issue.start_date))}</span>` : ''}
            ${issue.completed_date ? `<span>Done ${escapeHtml(formatDate(issue.completed_date))}</span>` : ''}
        </div>
        <div class="task-footer">
            <span>${escapeHtml(developers || issue.assignee || 'Unassigned')}</span>
            <div class="actions">${actions}</div>
        </div>
    </article>`;
}

function developerNames(ids) {
    const names = ids
        .map((id) => state.developers.find((developer) => Number(developer.id) === Number(id))?.name)
        .filter(Boolean);

    return names.join(', ');
}

function renderProjectOptions() {
    $('#task-project').innerHTML = state.projects
        .map((project) => `<option value="${project.id}">${escapeHtml(project.name)} (${escapeHtml(project.key)})</option>`)
        .join('');
}

function renderProjectMembers(selectedIds = []) {
    $('#project-member-list').innerHTML = state.users
        .filter((user) => user.active)
        .map((user) => `<label><input name="member_ids" type="checkbox" value="${user.id}" ${selectedIds.includes(Number(user.id)) ? 'checked' : ''}> ${escapeHtml(user.name)}</label>`)
        .join('');
}

function projectMembers(projectId) {
    const project = state.projects.find((item) => Number(item.id) === Number(projectId));
    return project?.members || [];
}

function memberNames(project) {
    const members = project.members || [];
    return members.length ? `Members: ${members.map((member) => member.name).join(', ')}` : 'No members assigned';
}

function renderAssigneeOptions(projectId, selectedIds = []) {
    const members = projectMembers(projectId);
    selectedIds = selectedIds.map(Number);
    $('#task-assignee').innerHTML = members
        .map((member) => `<option value="${member.id}" ${selectedIds.includes(Number(member.id)) ? 'selected' : ''}>${escapeHtml(member.name)}</option>`)
        .join('');
}

function renderDeveloperOptions(selectedIds = []) {
    $('#task-developers').innerHTML = state.developers
        .filter((developer) => developer.active)
        .map((developer) => `<option value="${developer.id}" ${selectedIds.includes(Number(developer.id)) ? 'selected' : ''}>${escapeHtml(developer.name)} (${escapeHtml(developer.git_username)})</option>`)
        .join('');
}

function mergeTaskLookupData(data) {
    if (Array.isArray(data.users)) {
        state.users = data.users;
    }

    if (Array.isArray(data.developers)) {
        state.developers = data.developers;
    }

    if (data.project && !state.projects.some((project) => Number(project.id) === Number(data.project.id))) {
        state.projects.push(data.project);
    }

    if (data.issue) {
        const existingIndex = state.taskIssues.findIndex((issue) => Number(issue.id) === Number(data.issue.id));

        if (existingIndex >= 0) {
            state.taskIssues[existingIndex] = data.issue;
        } else {
            state.taskIssues.push(data.issue);
        }
    }
}

function renderWorkLogDeveloperOptions(issue) {
    const selectedDevelopers = state.developers.filter((developer) => (issue.developer_ids || []).map(Number).includes(Number(developer.id)));
    $('#task-worker').innerHTML = [
        '<option value="0">Unassigned developer</option>',
        ...selectedDevelopers.map((developer) => `<option value="${developer.id}">${escapeHtml(developer.name)} (${escapeHtml(developer.git_username)})</option>`)
    ].join('');
}

function openProjectModal(project = null) {
    const form = $('#project-form');
    $('#project-modal-title').textContent = project ? 'Edit Project' : 'New Project';
    form.reset();
    form.elements.id.value = project?.id || 0;
    form.elements.key.value = project?.key || '';
    form.elements.name.value = project?.name || '';
    form.elements.owner.value = project?.owner || state.user?.name || '';
    form.elements.status.value = project?.status || 'Active';
    form.elements.description.value = project?.description || '';
    renderProjectMembers((project?.member_ids || []).map(Number));
    setButtonPermission('#save-project-button', project ? 'projects.edit' : 'projects.create');
    openModal('project-modal');
}

function openTaskModal(issue = null, projectId = 0) {
    const form = $('#task-form');
    $('#task-modal-title').textContent = issue ? 'Edit Task' : 'New Task';
    form.reset();
    form.elements.id.value = issue?.id || 0;
    form.elements.task_id.value = issue?.task_id || '';
    form.elements.title.value = issue?.title || '';
    form.elements.project_id.value = issue?.project_id || projectId || state.projects[0]?.id || '';
    form.elements.status.value = issue?.status || 'Todo';
    form.elements.priority.value = issue?.priority || 'Medium';
    form.elements.start_date.value = issue?.start_date || '';
    form.elements.completed_date.value = issue?.completed_date || '';
    syncCompletedDateState();
    renderAssigneeOptions(form.elements.project_id.value, (issue?.assignee_ids || []).map(Number));
    renderDeveloperOptions((issue?.developer_ids || []).map(Number));
    form.elements.description.value = issue?.description || '';
    setButtonPermission('#save-task-button', issue ? 'task.edit' : 'task.create');
    openModal('task-modal');
}

function syncCompletedDateState() {
    const form = $('#task-form');
    const isDone = form.elements.status.value === 'Done';
    form.elements.completed_date.disabled = !isDone;
    form.elements.completed_date.required = isDone;

    if (!isDone) {
        form.elements.completed_date.value = '';
    } else if (isDone && !form.elements.completed_date.value) {
        form.elements.completed_date.value = todayDate();
    }
}

function showTaskDetails(issue, preserveTab = false) {
    state.currentIssue = issue;
    state.activityTab = preserveTab ? (state.activityTab || 'all') : 'all';
    $('#task-details-title').textContent = `${issue.task_id}: ${issue.title}`;
    $('#task-details-description').textContent = [
        issue.description || '',
        issue.start_date ? `Start: ${formatDate(issue.start_date)}` : '',
        issue.completed_date ? `Completed: ${formatDate(issue.completed_date)}` : ''
    ].filter(Boolean).join(' | ');
    setButtonPermission('#task-details-edit-button', 'task.edit');
    $('#task-time-form').hidden = !can('task.time_log');
    setButtonPermission('#add-time-button', 'task.time_log');
    $('#task-time-form').elements.id.value = issue.id;
    $('#task-time-form').elements.work_date.value = todayDate();
    renderWorkLogDeveloperOptions(issue);
    $('#task-total-users').textContent = projectMembers(issue.project_id).length;
    $('#task-assigned-users').textContent = (issue.assignee_ids || []).length;
    $('#task-total-hours').textContent = `${issueTotalHours(issue).toFixed(2)}h`;
    $('#task-time-form').elements.project.value = issue.project || '';
    $('#task-time-form').elements.hours.value = '';
    $('#task-time-form').elements.note.value = '';
    $('#task-comment-form').hidden = !can('task.comment');
    setButtonPermission('#add-comment-button', 'task.comment');
    $('#task-comment-form').elements.id.value = issue.id;
    $('#task-comment-form').elements.comment.value = '';
    $('#task-comment-form').elements.files.value = '';
    renderTaskActivity();
    openModal('task-details-modal');
}

function renderTaskActivity() {
    const issue = state.currentIssue;

    if (!issue) {
        return;
    }

    document.querySelectorAll('[data-activity-tab]').forEach((button) => {
        button.classList.toggle('active', button.dataset.activityTab === state.activityTab);
    });

    const items = [];

    if (state.activityTab === 'all' || state.activityTab === 'comments') {
        (issue.comments || []).forEach((comment) => {
            items.push({
                type: 'comment',
                created_at: comment.created_at,
                html: `<div class="timeline-item comment-item">
                    <div><strong>${escapeHtml(comment.user_name)}</strong> <span>commented ${escapeHtml(formatDateTime(comment.created_at))}</span></div>
                    ${comment.comment ? `<div class="comment-text">${formatCommentText(comment.comment)}</div>` : ''}
                    ${renderAttachments(comment.attachments || [])}
                </div>`
            });
        });
    }

    if (can('task.time_logs.view') && (state.activityTab === 'all' || state.activityTab === 'work')) {
        (issue.work_logs || []).forEach((entry) => {
            items.push({
                type: 'work',
                created_at: entry.created_at || entry.work_date,
                html: `<div class="timeline-item work-item">
                    <div><strong>${escapeHtml(entry.worker)}</strong> <span>logged ${escapeHtml(entry.hours)}h on ${escapeHtml(formatDate(entry.work_date))}</span></div>
                    <p>${escapeHtml(entry.project)}${entry.note ? ` - ${escapeHtml(entry.note)}` : ''}</p>
                </div>`
            });
        });
    }

    if (can('task.logs.view') && (state.activityTab === 'all' || state.activityTab === 'history')) {
        (issue.logs || []).forEach((log) => {
            items.push({
                type: 'history',
                created_at: log.created_at,
                html: renderActivityLog(log)
            });
        });
    }

    items.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    $('#task-activity-list').innerHTML = items.length
        ? items.map((item) => item.html).join('')
        : '<p class="empty-state">No activity found.</p>';
}

function renderActivityLog(log) {
    return `<div class="timeline-item">
        <strong>${escapeHtml(activityTitle(log))}</strong>
        <span>${escapeHtml(log.user_name)} ${escapeHtml(formatDateTime(log.created_at))}</span>
        ${activityDetails(log)}
    </div>`;
}

function activityTitle(log) {
    const titles = {
        created: 'Created task',
        import_created: 'Imported task',
        import_updated: 'Updated imported task',
        updated: 'Updated task',
        project_members_updated: 'Updated project members',
        time_logged: 'Logged time',
        commented: 'Added comment'
    };

    return titles[log.action] || log.action;
}

function activityDetails(log) {
    const changes = log.changes || {};

    if (log.action === 'time_logged') {
        return `<p>${escapeHtml(changes.worker || log.user_name)} logged <strong>${escapeHtml(changes.hours || 0)}h</strong> on ${escapeHtml(changes.project || '')} for ${escapeHtml(formatDate(changes.work_date || ''))}.</p>`;
    }

    if (log.action === 'commented') {
        return `${changes.comment ? `<div class="comment-text">${formatCommentText(changes.comment)}</div>` : ''}${changes.attachment_count ? `<p>${escapeHtml(changes.attachment_count)} file(s) attached.</p>` : ''}`;
    }

    if (log.action === 'created') {
        return `<p>${escapeHtml(changes.task_id || 'Task')} was created.</p>${assignmentSummaryFromValues(changes)}`;
    }

    if (log.action === 'import_created') {
        return `<p>${escapeHtml(changes.task_id || 'Task')} was imported${changes.project ? ` in ${escapeHtml(changes.project)}` : ''}.</p>${assignmentSummaryFromValues(changes)}`;
    }

    if (log.action === 'project_members_updated') {
        return assignmentChangeSummary('Project members', 'assignee_ids', changes.member_ids?.from || [], changes.member_ids?.to || []);
    }

    if (log.action === 'updated' || log.action === 'import_updated') {
        const assignmentSummary = [
            changes.assignee_ids ? assignmentChangeSummary('Assignees', 'assignee_ids', changes.assignee_ids.from, changes.assignee_ids.to) : '',
            changes.developer_ids ? assignmentChangeSummary('Developers', 'developer_ids', changes.developer_ids.from, changes.developer_ids.to) : ''
        ].filter(Boolean).join('');
        const nonAssignmentRows = Object.entries(changes)
            .filter(([field]) => !['assignee_ids', 'developer_ids'].includes(field))
            .map(([field, change]) => `<li><strong>${escapeHtml(activityFieldLabel(field))}</strong>: ${escapeHtml(activityValue(field, change.from))} to ${escapeHtml(activityValue(field, change.to))}</li>`)
            .join('');

        return `${assignmentSummary}${nonAssignmentRows ? `<ul class="change-list">${nonAssignmentRows}</ul>` : ''}`;
    }

    const rows = Object.entries(changes)
        .map(([field, change]) => `<li><strong>${escapeHtml(activityFieldLabel(field))}</strong>: ${escapeHtml(activityValue(field, change.from))} to ${escapeHtml(activityValue(field, change.to))}</li>`)
        .join('');

    return rows ? `<ul class="change-list">${rows}</ul>` : '';
}

function activityFieldLabel(field) {
    const labels = {
        developer_ids: 'Developers',
        assignee_ids: 'Assignees',
        start_date: 'Start date',
        completed_date: 'Completed date',
        task_id: 'Task ID',
        project_id: 'Project'
    };
    return labels[field] || field.replaceAll('_', ' ');
}

function activityValue(field, value) {
    if (field === 'developer_ids') {
        return developerNames(parseDeveloperIds(value)) || 'No developers';
    }

    if (field === 'assignee_ids') {
        return assigneeNames(parseDeveloperIds(value)) || 'No assignees';
    }

    if (field === 'start_date' || field === 'completed_date') {
        return formatDate(value);
    }

    return String(value ?? '');
}

function assignmentSummaryFromValues(values) {
    return [
        values.assignee_ids?.length ? `<p><strong>Assignees:</strong> ${escapeHtml(assigneeNames(values.assignee_ids))}</p>` : '',
        values.developer_ids?.length ? `<p><strong>Developers:</strong> ${escapeHtml(developerNames(values.developer_ids))}</p>` : ''
    ].filter(Boolean).join('');
}

function assignmentChangeSummary(label, field, fromValue, toValue) {
    const fromIds = parseDeveloperIds(fromValue);
    const toIds = parseDeveloperIds(toValue);
    const added = toIds.filter((id) => !fromIds.includes(id));
    const removed = fromIds.filter((id) => !toIds.includes(id));
    const lines = [];

    if (added.length) {
        lines.push(`<li><strong>Added ${escapeHtml(label.toLowerCase())}</strong>: ${escapeHtml(activityValue(field, added))}</li>`);
    }

    if (removed.length) {
        lines.push(`<li><strong>Removed ${escapeHtml(label.toLowerCase())}</strong>: ${escapeHtml(activityValue(field, removed))}</li>`);
    }

    if (!lines.length && fromIds.length !== toIds.length) {
        lines.push(`<li><strong>${escapeHtml(label)}</strong>: ${escapeHtml(activityValue(field, fromIds))} to ${escapeHtml(activityValue(field, toIds))}</li>`);
    }

    return lines.length ? `<ul class="change-list">${lines.join('')}</ul>` : '';
}

function assigneeNames(ids) {
    const names = ids
        .map((id) => state.users.find((user) => Number(user.id) === Number(id))?.name)
        .filter(Boolean);

    return names.join(', ');
}

function parseDeveloperIds(value) {
    if (Array.isArray(value)) {
        return value.map(Number).filter(Boolean);
    }

    if (typeof value === 'number') {
        return value ? [value] : [];
    }

    return String(value ?? '')
        .split(',')
        .map((item) => Number(item.trim()))
        .filter(Boolean);
}

function bindPagination(selector, key, loader) {
    $(selector).addEventListener('click', async (event) => {
        const page = Number(event.target.dataset.page || 0);

        if (!page || event.target.disabled) {
            return;
        }

        state.pagination[key].page = page;

        try {
            await loader();
        } catch (error) {
            showMessage(error.message, 'error');
        }
    });
}

async function route() {
    if (!state.user) {
        clearSession();
        return;
    }

    const page = normalizePage((location.hash || '#dashboard').slice(1));
    setActiveNav(page);
    showMessage('');

    try {
        if (page === 'users' && can('users.view')) {
            showView('users');
            await loadUsers();
            return;
        }

        if (page === 'developers' && can('developers.view')) {
            showView('developers');
            await loadDevelopers();
            return;
        }

        if (page === 'roles' && can('roles.view')) {
            showView('roles');
            await loadRoles();
            return;
        }

        if (page === 'projects' && can('task.view')) {
            showView('projects');
            await loadTasks();
            return;
        }

        if (page === 'task-assignments' && can('task.assignments.view')) {
            showView('task-assignments');
            await loadTaskAssignments();
            return;
        }

        if (page === 'my-tasks' && can('dashboard.view')) {
            showView('my-tasks');
            await loadMyTasks();
            return;
        }

        if (page === 'overdue-tasks' && can('task.view')) {
            showView('overdue-tasks');
            await loadOverdueTasks();
            return;
        }

        if (page === 'worklogs' && can('developers.worklogs.view')) {
            showView('worklogs');
            await loadWorklogs();
            return;
        }

        if (page === 'dev-work-logs' && can('developers.work_logs.view')) {
            showView('dev-work-logs');
            await loadDeveloperWorkLogs();
            return;
        }

        showView('dashboard');
        await loadDashboard();
    } catch (error) {
        showMessage(error.message, 'error');
    }
}

$('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    showMessage('');
    const button = event.currentTarget.querySelector('[type="submit"]');
    setLoading(button, true);

    try {
        const data = await apiRequest('login', {
            email: event.currentTarget.elements.email.value,
            password: event.currentTarget.elements.password.value
        });
        setSession(data);
        location.hash = '#dashboard';
        await route();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#logout-button').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setLoading(button, true);

    try {
        await apiRequest('logout');
    } catch (error) {
    } finally {
        setLoading(button, false);
    }

    clearSession();
    location.hash = '#dashboard';
});

bindPagination('#users-pagination', 'users', loadUsers);
bindPagination('#developers-pagination', 'developers', loadDevelopers);
bindPagination('#roles-pagination', 'roles', loadRoles);
bindPagination('#projects-pagination', 'projects', loadTasks);

$('#refresh-worklog-report').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setLoading(button, true);

    try {
        await loadWorklogs();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#export-worklogs-csv').addEventListener('click', () => {
    if (!lastWorklogData?.logs?.length) {
        showMessage('Load the report first before exporting.', 'error');
        return;
    }
    downloadCsv('worklogs.csv',
        ['Date', 'User', 'Task ID', 'Task Title', 'Project', 'Hours', 'Note'],
        lastWorklogData.logs.map((log) => [log.work_date, log.user_name, log.task_id, log.task_title, log.project, log.hours, log.note])
    );
});

$('#refresh-dev-worklogs-report').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setLoading(button, true);

    try {
        await loadDeveloperWorkLogs();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#export-dev-worklogs-csv').addEventListener('click', () => {
    if (!lastDevWorklogData?.logs?.length) {
        showMessage('Load the report first before exporting.', 'error');
        return;
    }
    downloadCsv('dev-worklogs.csv',
        ['Date', 'Developer', 'Git Username', 'User', 'Task ID', 'Task Title', 'Project', 'Hours', 'Note'],
        lastDevWorklogData.logs.map((log) => [log.work_date, log.developer_name, log.git_username, log.user_name, log.task_id, log.task_title, log.project, log.hours, log.note])
    );
});

$('#refresh-my-tasks').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setLoading(button, true);

    try {
        await loadMyTasks();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#refresh-overdue-tasks').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setLoading(button, true);

    try {
        await loadOverdueTasks();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#my-tasks-content').addEventListener('click', (event) => {
    const showMore = event.target.closest('.my-tasks-show-more');
    if (showMore) {
        const group = showMore.closest('.my-tasks-group');
        group.querySelectorAll('.my-task-hidden').forEach((el) => el.classList.remove('my-task-hidden'));
        showMore.remove();
        return;
    }

    const card = event.target.closest('[data-view-task]');
    if (!card) return;
    const issue = state.taskIssues.find((t) => t.id === Number(card.dataset.viewTask));
    if (issue) {
        showTaskDetails(issue);
        openModal('task-details-modal');
    }
});

$('#overdue-tasks-table').addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-load-task]');
    if (!btn) return;
    setLoading(btn, true);
    await openTaskById(btn.dataset.loadTask);
    setLoading(btn, false);
});

$('#search-trigger').addEventListener('click', () => {
    openModal('search-modal');
    setTimeout(() => $('#search-input').focus(), 50);
});

$('#close-search-modal').addEventListener('click', () => closeModal('search-modal'));

$('#search-modal').addEventListener('click', (event) => {
    if (event.target === $('#search-modal')) {
        closeModal('search-modal');
    }
});

$('#search-input').addEventListener('input', (event) => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => performSearch(event.target.value.trim()), 300);
});

$('#search-results').addEventListener('click', async (event) => {
    const result = event.target.closest('[data-load-task]');
    if (!result) return;
    closeModal('search-modal');
    await openTaskById(result.dataset.loadTask);
});

document.addEventListener('keydown', (event) => {
    if (event.key === '/' && !event.target.matches('input, textarea, select, [contenteditable]') && $('#search-modal').hidden) {
        event.preventDefault();
        openModal('search-modal');
        setTimeout(() => $('#search-input').focus(), 50);
    }

    if (event.key === 'Escape' && !$('#search-modal').hidden) {
        closeModal('search-modal');
    }
});

$('#refresh-task-assignments-report').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    setLoading(button, true);

    try {
        await loadTaskAssignments();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#user-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#save-user-button');
    setLoading(button, true);

    try {
        await apiRequest('users.save', {
            id: Number(form.elements.id.value || 0),
            name: form.elements.name.value,
            employee_id: form.elements.employee_id.value,
            job_position: form.elements.job_position.value,
            email: form.elements.email.value,
            password: form.elements.password.value,
            role: form.elements.role.value,
            active: form.elements.active.checked
        });
        resetUserForm();
        showMessage('User saved.');
        await loadUsers();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#users-table').addEventListener('click', async (event) => {
    const editId = event.target.dataset.editUser;
    const deleteId = event.target.dataset.deleteUser;

    if (editId) {
        const user = state.users.find((item) => Number(item.id) === Number(editId));
        const form = $('#user-form');
        $('#user-form-title').textContent = 'Edit User';
        form.elements.id.value = user.id;
        form.elements.name.value = user.name;
        form.elements.employee_id.value = user.employee_id || '';
        form.elements.job_position.value = user.job_position || '';
        form.elements.email.value = user.email;
        form.elements.password.value = '';
        form.elements.role.value = user.role;
        form.elements.active.checked = Boolean(user.active);
        setButtonPermission('#save-user-button', 'users.edit');
        openModal('user-modal');
    }

    if (deleteId && confirm('Delete this user?')) {
        const button = event.target;
        setLoading(button, true);

        try {
            await apiRequest('users.delete', { id: Number(deleteId) });
            showMessage('User deleted.');
            await loadUsers();
        } catch (error) {
            showMessage(error.message, 'error');
            setLoading(button, false);
        }
    }
});

$('#cancel-user-edit').addEventListener('click', () => {
    resetUserForm();
});

$('#role-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const permissions = Array.from(form.querySelectorAll('input[name="permissions"]:checked')).map((input) => input.value);
    const button = $('#save-role-button');
    setLoading(button, true);

    try {
        await apiRequest('roles.save', {
            original_key: form.elements.original_key.value,
            key: form.elements.key.value,
            name: form.elements.name.value,
            permissions
        });
        resetRoleForm();
        showMessage('Role saved.');
        await loadRoles();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#roles-table').addEventListener('click', (event) => {
    const key = event.target.dataset.editRole;

    if (!key) {
        return;
    }

    const role = state.roles[key];
    const form = $('#role-form');
    $('#role-form-title').textContent = 'Edit Role';
    form.elements.original_key.value = key;
    form.elements.key.value = key;
    form.elements.name.value = role.name;
    form.querySelectorAll('input[name="permissions"]').forEach((input) => {
        input.checked = role.permissions.includes(input.value);
    });
    setButtonPermission('#save-role-button', 'roles.manage');
    openModal('role-modal');
});

$('#cancel-role-edit').addEventListener('click', () => {
    resetRoleForm();
});

$('#developer-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#save-developer-button');
    setLoading(button, true);

    try {
        await apiRequest('developers.save', {
            id: Number(form.elements.id.value || 0),
            name: form.elements.name.value,
            git_username: form.elements.git_username.value,
            active: form.elements.active.checked
        });
        resetDeveloperForm();
        showMessage('Developer saved.');
        await loadDevelopers();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#developers-table').addEventListener('click', async (event) => {
    const editId = event.target.dataset.editDeveloper;
    const deleteId = event.target.dataset.deleteDeveloper;

    if (editId) {
        const developer = state.developers.find((item) => Number(item.id) === Number(editId));
        const form = $('#developer-form');
        $('#developer-form-title').textContent = 'Edit Developer';
        form.elements.id.value = developer.id;
        form.elements.name.value = developer.name;
        form.elements.git_username.value = developer.git_username;
        form.elements.active.checked = Boolean(developer.active);
        setButtonPermission('#save-developer-button', 'developers.edit');
        openModal('developer-modal');
    }

    if (deleteId && confirm('Delete this developer?')) {
        const button = event.target;
        setLoading(button, true);

        try {
            await apiRequest('developers.delete', { id: Number(deleteId) });
            showMessage('Developer deleted.');
            await loadDevelopers();
        } catch (error) {
            showMessage(error.message, 'error');
            setLoading(button, false);
        }
    }
});

$('#cancel-developer-edit').addEventListener('click', () => {
    resetDeveloperForm();
});

$('#new-user-button').addEventListener('click', () => {
    resetUserForm();
    openModal('user-modal');
});

$('#new-role-button').addEventListener('click', () => {
    resetRoleForm();
    openModal('role-modal');
});

$('#new-developer-button').addEventListener('click', () => {
    resetDeveloperForm();
    openModal('developer-modal');
});

$('#project-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#save-project-button');
    setLoading(button, true);

    try {
        await apiRequest('projects.save', {
            id: Number(form.elements.id.value || 0),
            key: form.elements.key.value,
            name: form.elements.name.value,
            owner: form.elements.owner.value,
            status: form.elements.status.value,
            member_ids: Array.from(form.querySelectorAll('input[name="member_ids"]:checked')).map((input) => Number(input.value)),
            description: form.elements.description.value
        });
        closeModal('project-modal');
        showMessage('Project saved.');
        await loadTasks();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#task-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#save-task-button');
    setLoading(button, true);

    try {
        await apiRequest('task.save', {
            id: Number(form.elements.id.value || 0),
            task_id: form.elements.task_id.value,
            title: form.elements.title.value,
            project_id: Number(form.elements.project_id.value),
            status: form.elements.status.value,
            priority: form.elements.priority.value,
            start_date: form.elements.start_date.value,
            completed_date: form.elements.completed_date.value,
            assignee_ids: Array.from(form.elements.assignee_ids.selectedOptions).map((option) => Number(option.value)),
            developer_ids: Array.from(form.elements.developer_ids.selectedOptions).map((option) => Number(option.value)),
            description: form.elements.description.value
        });
        closeModal('task-modal');
        showMessage('Task saved.');
        await loadTasks();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#task-search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const result = $('#task-search-result');
    const button = $('#task-search-button');
    result.className = 'search-result-text';
    result.textContent = 'Checking task...';
    setLoading(button, true);

    try {
        const data = await apiRequest('task.find', {
            task_id: form.elements.task_id.value
        });

        if (!data.exists) {
            result.classList.add('error-text');
            result.textContent = data.message || 'Task ID not found.';
            return;
        }

        mergeTaskLookupData(data);
        result.classList.add('success-text');
        result.textContent = `${data.issue.task_id} found. Showing activity.`;
        showTaskDetails(data.issue);
    } catch (error) {
        result.classList.add('error-text');
        result.textContent = error.message;
    } finally {
        setLoading(button, false);
    }
});

$('#project-board').addEventListener('click', async (event) => {
    const newTaskProjectId = event.target.dataset.newTask;
    const editProjectId = event.target.dataset.editProject;
    const deleteProjectId = event.target.dataset.deleteProject;
    const editId = event.target.dataset.editTask;
    const viewId = event.target.dataset.viewTask;
    const deleteId = event.target.dataset.deleteTask;
    const loadMore = event.target.dataset.loadMoreTasks;

    if (loadMore) {
        loadMoreTasks(Number(event.target.dataset.projectId), event.target.dataset.status);
        return;
    }

    if (newTaskProjectId) {
        openTaskModal(null, Number(newTaskProjectId));
    }

    if (editProjectId) {
        const project = state.projects.find((item) => Number(item.id) === Number(editProjectId));
        openProjectModal(project);
    }

    if (deleteProjectId && confirm('Delete this project?')) {
        const button = event.target;
        setLoading(button, true);

        try {
            await apiRequest('projects.delete', { id: Number(deleteProjectId) });
            showMessage('Project deleted.');
            await loadTasks();
        } catch (error) {
            showMessage(error.message, 'error');
            setLoading(button, false);
        }
    }

    if (viewId) {
        const issue = state.taskIssues.find((item) => Number(item.id) === Number(viewId));
        showTaskDetails(issue);
    }

    if (editId) {
        const issue = state.taskIssues.find((item) => Number(item.id) === Number(editId));
        openTaskModal(issue);
    }

    if (deleteId && confirm('Delete this task?')) {
        const button = event.target;
        setLoading(button, true);

        try {
            await apiRequest('task.delete', { id: Number(deleteId) });
            showMessage('Task deleted.');
            await loadTasks();
        } catch (error) {
            showMessage(error.message, 'error');
            setLoading(button, false);
        }
    }
});

$('#activity-tabs').addEventListener('click', (event) => {
    const tab = event.target.dataset.activityTab;

    if (!tab) {
        return;
    }

    state.activityTab = tab;
    renderTaskActivity();
});

$('#task-time-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#add-time-button');
    setLoading(button, true);

    try {
        await apiRequest('task.time_log', {
            id: Number(form.elements.id.value),
            work_date: form.elements.work_date.value,
            developer_id: Number(form.elements.developer_id.value || 0),
            project: form.elements.project.value,
            hours: Number(form.elements.hours.value),
            note: form.elements.note.value
        });
        showMessage('Time logged.');
        await loadTasks();
        const issue = state.taskIssues.find((item) => Number(item.id) === Number(form.elements.id.value));
        showTaskDetails(issue, true);
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#task-comment-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#add-comment-button');
    setLoading(button, true);

    try {
        const attachments = await attachmentsFromInput(form.elements.files);

        if (!form.elements.comment.value.trim() && attachments.length === 0) {
            throw new Error('Add a comment or choose at least one file.');
        }

        await apiRequest('task.comment', {
            id: Number(form.elements.id.value),
            comment: form.elements.comment.value,
            attachments
        });
        showMessage(attachments.length ? 'Comment/files added.' : 'Comment added.');
        await loadTasks();
        const issue = state.taskIssues.find((item) => Number(item.id) === Number(form.elements.id.value));
        showTaskDetails(issue, true);
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

$('#new-project-button').addEventListener('click', () => {
    openProjectModal();
});

$('#import-tasks-button').addEventListener('click', () => {
    $('#task-import-form').reset();
    openModal('task-import-modal');
});

$('#task-import-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = $('#import-tasks-submit-button');
    setLoading(button, true);

    try {
        const data = await apiRequest('task.bulk_import', {
            rows: form.elements.rows.value
        });
        closeModal('task-import-modal');
        showMessage(`Imported ${data.imported} tasks, updated ${data.updated} tasks${data.skipped ? `, skipped ${data.skipped}` : ''}.`);
        await loadTasks();
    } catch (error) {
        showMessage(error.message, 'error');
    } finally {
        setLoading(button, false);
    }
});

document.querySelectorAll('[data-close-modal]').forEach((button) => {
    button.addEventListener('click', () => closeModal(button.dataset.closeModal));
});

document.querySelectorAll('.modal-backdrop').forEach((backdrop) => {
    backdrop.addEventListener('click', (event) => {
        if (event.target !== backdrop) return;
        const modal = backdrop.querySelector('.modal');
        if (!modal) return;
        modal.classList.remove('modal-attention');
        void modal.offsetWidth;
        modal.classList.add('modal-attention');
        modal.addEventListener('animationend', () => modal.classList.remove('modal-attention'), { once: true });
    });
});

$('#task-details-edit-button').addEventListener('click', () => {
    closeModal('task-details-modal');
    openTaskModal(state.currentIssue);
});

$('#task-project').addEventListener('change', (event) => {
    renderAssigneeOptions(event.currentTarget.value, []);
});

$('#task-status').addEventListener('change', syncCompletedDateState);

window.addEventListener('hashchange', route);

async function restoreSession() {
    if (!state.authToken) {
        clearSession();
        return;
    }

    try {
        const data = await apiRequest('dashboard.get');
        setSession(data);
        await route();
    } catch (error) {
        clearSession();
        showMessage('Please log in again.', 'error');
    }
}

restoreSession();
