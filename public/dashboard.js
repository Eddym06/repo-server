/**
 * @file dashboard.js
 * @description Panel de control del servidor AutoQuiz
 */

// ===== CONFIGURACIÓN =====
const API_BASE = window.location.origin;
let ws = null; // WebSocket para logs en tiempo real
let currentUserId = null;
let activityChart = null;
let tokensChart = null;
let modelsChart = null;
let adminToken = null;

// ===== AUTENTICACIÓN =====
function checkAuth() {
    adminToken = sessionStorage.getItem('adminToken');
    
    if (!adminToken) {
        // Redirigir a login si no hay token
        window.location.href = '/login.html';
        return false;
    }
    
    // Verificar token con el servidor
    verifyToken();
    
    return true;
}

async function verifyToken() {
    try {
        const response = await fetch('/api/admin/verify', {
            headers: {
                'Authorization': `Bearer ${adminToken}`
            }
        });
        
        if (!response.ok) {
            // Token inválido, redirigir a login
            console.warn('Token inválido o sesión expirada, redirigiendo a login...');
            sessionStorage.removeItem('adminToken');
            sessionStorage.removeItem('adminUser');
            window.location.href = '/login.html';
        }
    } catch (error) {
        console.error('Error verificando token:', error);
        // No redirigir en caso de error de red, permitir que el usuario siga intentando
    }
}

function getAuthHeaders() {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${adminToken}`
    };
}

function logout() {
    sessionStorage.removeItem('adminToken');
    sessionStorage.removeItem('adminUser');
    window.location.href = '/login.html';
}

// ===== INICIALIZACIÓN =====
document.addEventListener('DOMContentLoaded', () => {
    // Verificar autenticación
    if (!checkAuth()) return;
    
    initNavigation();
    initModals();
    initWebSocket();
    initEventDelegation();
    initConsoleListeners();
    loadDashboard();
    
    // Refresh automático cada 30 segundos
    setInterval(loadDashboard, 30000);
    
    // Botón de refresh manual
    const refreshBtn = document.getElementById('refresh-btn');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            loadDashboard();
            animateRefreshButton();
        });
    }
    
    // Botón de logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', logout);
    }
    
    // Filtros de informes - con verificación de elementos
    const searchInput = document.getElementById('reports-search');
    const modelFilter = document.getElementById('reports-model-filter');
    const userFilter = document.getElementById('reports-user-filter');
    
    if (searchInput) {
        searchInput.addEventListener('input', filterReports);
    }
    
    if (modelFilter) {
        modelFilter.addEventListener('change', filterReports);
    }
    
    if (userFilter) {
        userFilter.addEventListener('change', filterReports);
    }
});

// ===== NAVEGACIÓN =====
function initNavigation() {
    const navItems = document.querySelectorAll('.nav-item');
    
    navItems.forEach(item => {
        item.addEventListener('click', () => {
            const view = item.dataset.view;
            switchView(view);
            
            // Actualizar navegación activa
            navItems.forEach(n => n.classList.remove('active'));
            item.classList.add('active');
        });
    });
}

// ===== EVENT DELEGATION =====
function initEventDelegation() {
    // Event delegation para user cards y botones
    document.addEventListener('click', (e) => {
        // Click en user card
        const userCard = e.target.closest('.user-card');
        if (userCard && !e.target.closest('.user-actions')) {
            const userId = parseInt(userCard.dataset.userId);
            if (userId) {
                showUserDetail(userId);
            }
            return;
        }
        
        // Click en botón de toggle status
        const toggleBtn = e.target.closest('.toggle-status-btn');
        if (toggleBtn) {
            e.stopPropagation();
            const userId = parseInt(toggleBtn.dataset.userId);
            if (userId) {
                // Crear un evento sintético para pasar a toggleUserStatus
                const syntheticEvent = { stopPropagation: () => {} };
                toggleUserStatus(syntheticEvent, userId);
            }
            return;
        }
        
        // Click en botón de delete report
        const deleteBtn = e.target.closest('.delete-report-btn');
        if (deleteBtn) {
            const reportId = parseInt(deleteBtn.dataset.reportId);
            deleteReportConfirm(reportId);
            return;
        }
        
        // Click en botón de view report
        const viewBtn = e.target.closest('.view-report-btn');
        if (viewBtn) {
            const reportId = parseInt(viewBtn.dataset.reportId);
            viewReportDetail(reportId);
            return;
        }
    });
}

function switchView(viewName) {
    // Ocultar todas las vistas
    document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
    
    // Mostrar vista seleccionada
    const view = document.getElementById(`${viewName}-view`);
    view.classList.add('active');
    
    // Actualizar título
    const titles = {
        dashboard: { title: 'Dashboard', subtitle: 'Estadísticas generales del sistema' },
        users: { title: 'Gestión de Usuarios', subtitle: 'Administrar usuarios de la extensión' },
        errors: { title: 'Registro de Errores', subtitle: 'Monitoreo de errores del sistema' },
        sessions: { title: 'Sesiones Activas', subtitle: 'Cuestionarios en progreso' },
        reports: { title: 'Informes', subtitle: 'Historial de cuestionarios completados' }
    };
    
    document.getElementById('page-title').textContent = titles[viewName].title;
    document.getElementById('page-subtitle').textContent = titles[viewName].subtitle;
    
    // Animar entrada
    gsap.from(view, { opacity: 0, y: 20, duration: 0.5, ease: 'power2.out' });
    
    // Cargar datos específicos de la vista
    switch(viewName) {
        case 'users':
            loadUsers();
            break;
        case 'errors':
            loadErrors();
            break;
        case 'sessions':
            loadSessions();
            break;
        case 'reports':
            loadReports();
            break;
    }
}

// ===== DASHBOARD =====
async function loadDashboard() {
    try {
        const [statsRes, usersRes] = await Promise.all([
            fetch(`${API_BASE}/api/stats`, { headers: getAuthHeaders() }),
            fetch(`${API_BASE}/api/users`, { headers: getAuthHeaders() })
        ]);
        
        // Manejar error 401 específicamente
        if (statsRes.status === 401 || usersRes.status === 401) {
            console.warn('Sesión expirada o inválida, redirigiendo a login...');
            sessionStorage.removeItem('adminToken');
            window.location.href = '/login.html';
            return;
        }
        
        if (!statsRes.ok || !usersRes.ok) {
            throw new Error('Error al cargar datos del servidor');
        }
        
        const stats = await statsRes.json();
        const users = await usersRes.json();
        
        // Validar que users sea un array antes de usarlo
        if (!Array.isArray(users)) {
            console.error('La respuesta de usuarios no es un array:', users);
            updateStatsCards(stats || {});
            updateCharts([]);
            return;
        }
        
        // Actualizar stats cards
        updateStatsCards(stats || {});
        
        // Actualizar gráficos
        updateCharts(users);
        
    } catch (error) {
        console.error('Error al cargar dashboard:', error);
        showNotification('Error al cargar datos. Por favor, recarga la página.', 'error');
    }
}

function updateStatsCards(stats) {
    const elements = {
        users: document.getElementById('stat-users'),
        quizzes: document.getElementById('stat-quizzes'),
        questions: document.getElementById('stat-questions'),
        tokens: document.getElementById('stat-tokens')
    };
    
    // Animar números
    animateValue(elements.users, parseInt(elements.users.textContent) || 0, stats.total_users || 0, 1000);
    animateValue(elements.quizzes, parseInt(elements.quizzes.textContent) || 0, stats.total_quizzes_completed || 0, 1000);
    animateValue(elements.questions, parseInt(elements.questions.textContent) || 0, stats.total_questions_processed || 0, 1000);
    animateValue(elements.tokens, parseInt(elements.tokens.textContent) || 0, stats.total_tokens_used || 0, 1000);
}

function updateCharts(users) {
    // Validar que users sea un array
    if (!users || !Array.isArray(users)) {
        console.warn('updateCharts llamado sin array válido, usando array vacío');
        users = [];
    }
    
    // Gráfico de actividad
    const activityData = {
        labels: users.map(u => u.username || 'Sin nombre'),
        datasets: [{
            label: 'Cuestionarios Completados',
            data: users.map(u => u.quizzes_completed || 0),
            backgroundColor: 'rgba(79, 70, 229, 0.8)',
            borderColor: 'rgba(79, 70, 229, 1)',
            borderWidth: 2
        }]
    };
    
    if (activityChart) {
        activityChart.data = activityData;
        activityChart.update();
    } else {
        const ctx = document.getElementById('activity-chart').getContext('2d');
        activityChart = new Chart(ctx, {
            type: 'bar',
            data: activityData,
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: '#334155' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
    
    // Gráfico de tokens
    const tokensData = {
        labels: users.map(u => u.username || 'Sin nombre'),
        datasets: [{
            label: 'Tokens Utilizados',
            data: users.map(u => u.total_tokens_used || 0),
            backgroundColor: 'rgba(16, 185, 129, 0.8)',
            borderColor: 'rgba(16, 185, 129, 1)',
            borderWidth: 2
        }]
    };
    
    if (tokensChart) {
        tokensChart.data = tokensData;
        tokensChart.update();
    } else {
        const ctx = document.getElementById('tokens-chart').getContext('2d');
        tokensChart = new Chart(ctx, {
            type: 'line',
            data: tokensData,
            options: {
                responsive: true,
                maintainAspectRatio: true,
                plugins: {
                    legend: { display: false }
                },
                scales: {
                    y: { beginAtZero: true, grid: { color: '#334155' } },
                    x: { grid: { display: false } }
                }
            }
        });
    }
    
    // Gráfica de Modelos Más Usados
    const modelUsage = {};
    users.forEach(user => {
        if (user.favorite_model) {
            let brand = 'Otros';
            if (user.favorite_model.includes('gpt')) brand = 'OpenAI';
            else if (user.favorite_model.includes('gemini')) brand = 'Google';
            else if (user.favorite_model.includes('grok')) brand = 'xAI';
            else if (user.favorite_model.includes('deepseek')) brand = 'DeepSeek';
            else if (user.favorite_model.includes('claude')) brand = 'Anthropic';
            
            modelUsage[brand] = (modelUsage[brand] || 0) + 1;
        }
    });

    const modelsData = {
        labels: Object.keys(modelUsage),
        datasets: [{
            data: Object.values(modelUsage),
            backgroundColor: [
                'rgba(79, 70, 229, 0.8)',
                'rgba(16, 185, 129, 0.8)',
                'rgba(239, 68, 68, 0.8)',
                'rgba(245, 158, 11, 0.8)',
                'rgba(168, 85, 247, 0.8)',
                'rgba(100, 116, 139, 0.8)'
            ]
        }]
    };

    const ctxModels = document.getElementById('models-chart');
    if (ctxModels) {
        if (modelsChart) {
            modelsChart.data = modelsData;
            modelsChart.update();
        } else {
            modelsChart = new Chart(ctxModels, {
                type: 'doughnut',
                data: modelsData,
                options: { 
                    responsive: true, 
                    maintainAspectRatio: true,
                    plugins: { 
                        legend: { 
                            position: 'bottom',
                            labels: { 
                                color: '#f8fafc',
                                padding: 15,
                                font: {
                                    size: 12
                                }
                            }
                        }
                    }
                }
            });
        }
    }
}

// ===== USUARIOS =====
async function loadUsers() {
    try {
        const response = await fetch(`${API_BASE}/api/users`, { headers: getAuthHeaders() });
        
        if (response.status === 401) {
            console.warn('Sesión expirada al cargar usuarios');
            sessionStorage.removeItem('adminToken');
            window.location.href = '/login.html';
            return;
        }
        
        if (!response.ok) {
            throw new Error(`Error HTTP ${response.status}`);
        }
        
        const users = await response.json();
        
        const container = document.getElementById('users-list');
        if (!container) {
            console.error('Contenedor users-list no encontrado');
            return;
        }
        
        container.innerHTML = '';
        
        users.forEach(user => {
            const card = createUserCard(user);
            container.appendChild(card);
            
            // Animar entrada
            gsap.from(card, { opacity: 0, x: -20, duration: 0.4, delay: 0.1 });
        });
        
    } catch (error) {
        console.error('Error al cargar usuarios:', error);
    }
}

function createUserCard(user) {
    const card = document.createElement('div');
    card.className = 'user-card';
    card.dataset.userId = user.id; // Usar data attribute en lugar de onclick
    
    const statusBadge = user.enabled 
        ? '<span class="badge badge-success">Activo</span>'
        : '<span class="badge badge-danger">Inhabilitado</span>';
    
    card.innerHTML = `
        <div class="user-avatar">${user.username.charAt(0).toUpperCase()}</div>
        <div class="user-info">
            <h3>${user.username} ${statusBadge}</h3>
            <div class="user-meta">
                <span>🆔 ${user.identifier}</span>
                <span>✅ ${user.quizzes_completed} quizzes</span>
                <span>🪙 ${formatNumber(user.total_tokens_used)} tokens</span>
            </div>
        </div>
        <div class="user-actions">
            <button class="btn btn-secondary toggle-status-btn" data-user-id="${user.id}" data-enabled="${user.enabled}">
                ${user.enabled ? '⏸️' : '▶️'}
            </button>
        </div>
    `;
    
    return card;
}

async function showUserDetail(userId) {
    try {
        const user = await fetch(`${API_BASE}/api/users/${userId}`, { headers: getAuthHeaders() }).then(r => r.json());
        const errors = await fetch(`${API_BASE}/api/users/${userId}/errors`, { headers: getAuthHeaders() }).then(r => r.json());
        
        currentUserId = userId;
        
        // Llenar modal
        document.getElementById('detail-username').textContent = user.username;
        document.getElementById('detail-identifier').textContent = user.identifier;
        document.getElementById('detail-status').innerHTML = user.enabled 
            ? '<span class="badge badge-success">Activo</span>'
            : '<span class="badge badge-danger">Inhabilitado</span>';
        document.getElementById('detail-created').textContent = formatDate(user.created_at);
        document.getElementById('detail-activity').textContent = formatDate(user.last_activity);
        document.getElementById('detail-quizzes').textContent = user.quizzes_completed || 0;
        document.getElementById('detail-questions').textContent = user.total_questions_processed || 0;
        document.getElementById('detail-tokens').textContent = formatNumber(user.total_tokens_used || 0);
        document.getElementById('detail-errors').textContent = user.total_errors || 0;
        
        // Mostrar logs de errores
        const logsContainer = document.getElementById('user-logs');
        if (errors.length > 0) {
            logsContainer.innerHTML = errors.map(err => `
                <div class="log-entry">
                    <span class="log-timestamp">${formatTime(err.created_at)}</span>
                    <span class="log-message">[${err.error_type}] ${err.error_message}</span>
                </div>
            `).join('');
        } else {
            logsContainer.innerHTML = '<p class="logs-empty">No hay errores registrados</p>';
        }
        
        // Actualizar botón toggle (usar data attribute en lugar de onclick)
        const toggleBtn = document.getElementById('toggle-user-btn');
        toggleBtn.textContent = user.enabled ? '⏸️ Inhabilitar' : '▶️ Habilitar';
        toggleBtn.dataset.userId = userId;
        toggleBtn.dataset.enabled = user.enabled;
        toggleBtn.className = 'btn btn-primary toggle-status-btn';
        
        // Mostrar modal
        showModal('user-detail-modal');
        
    } catch (error) {
        console.error('Error al cargar detalles del usuario:', error);
    }
}

async function deleteUserConfirm() {
    if (!currentUserId) return;
    
    if (!confirm('¿Estás seguro de eliminar este usuario? Esta acción no se puede deshacer.')) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/users/${currentUserId}`, { 
            method: 'DELETE',
            headers: getAuthHeaders()
        });
        
        if (response.status === 401) {
            console.warn('Sesión expirada al eliminar usuario');
            sessionStorage.removeItem('adminToken');
            window.location.href = '/login.html';
            return;
        }
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Error del servidor' }));
            throw new Error(errorData.error || `Error HTTP ${response.status}`);
        }
        
        showNotification('Usuario eliminado', 'success');
        closeModal('user-detail-modal');
        loadUsers();
        loadDashboard();
        
    } catch (error) {
        console.error('Error al eliminar usuario:', error);
        showNotification(error.message || 'Error al eliminar usuario', 'error');
    }
}

// ===== ERRORES =====
async function loadErrors() {
    try {
        const response = await fetch(`${API_BASE}/api/errors`, { headers: getAuthHeaders() });
        
        if (response.status === 401) {
            console.warn('Sesión expirada al cargar errores');
            sessionStorage.removeItem('adminToken');
            window.location.href = '/login.html';
            return;
        }
        
        if (!response.ok) {
            throw new Error(`Error HTTP ${response.status}`);
        }
        
        const errors = await response.json();
        
        const container = document.getElementById('errors-list');
        if (!container) {
            console.error('Contenedor errors-list no encontrado');
            return;
        }
        
        container.innerHTML = '';
        
        errors.forEach(error => {
            const card = createErrorCard(error);
            container.appendChild(card);
        });
        
    } catch (error) {
        console.error('Error al cargar errores:', error);
    }
}

function createErrorCard(error) {
    const card = document.createElement('div');
    card.className = 'error-card';
    
    card.innerHTML = `
        <div class="error-header">
            <span class="error-type">${error.error_type}</span>
            <span class="error-time">${formatDate(error.created_at)}</span>
        </div>
        <p class="error-message">${error.error_message}</p>
        <p class="error-user">Usuario: ${error.username} (${error.identifier})</p>
    `;
    
    return card;
}

// ===== SESIONES =====
async function loadSessions() {
    try {
        const response = await fetch(`${API_BASE}/api/sessions`, { headers: getAuthHeaders() });
        
        if (response.status === 401) {
            console.warn('Sesión expirada al cargar sesiones');
            sessionStorage.removeItem('adminToken');
            window.location.href = '/login.html';
            return;
        }
        
        if (!response.ok) {
            throw new Error(`Error HTTP ${response.status}`);
        }
        
        const sessions = await response.json();
        
        const container = document.getElementById('sessions-list');
        if (!container) {
            console.error('Contenedor sessions-list no encontrado');
            return;
        }
        
        container.innerHTML = '';
        
        if (sessions.length === 0) {
            container.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 2rem;">No hay sesiones activas</p>';
            return;
        }
        
        sessions.forEach(session => {
            const card = createSessionCard(session);
            container.appendChild(card);
        });
        
    } catch (error) {
        console.error('Error al cargar sesiones:', error);
    }
}

function createSessionCard(session) {
    const card = document.createElement('div');
    card.className = 'user-card';
    
    const progress = (session.questions_processed / session.questions_total * 100).toFixed(0);
    
    card.innerHTML = `
        <div class="user-avatar">📝</div>
        <div class="user-info">
            <h3>Sesión ${session.session_id.substring(0, 8)}...</h3>
            <div class="user-meta">
                <span>Usuario ID: ${session.user_id}</span>
                <span>Modelo: ${session.model_used}</span>
                <span>Progreso: ${session.questions_processed}/${session.questions_total} (${progress}%)</span>
            </div>
        </div>
    `;
    
    return card;
}

// ===== CREAR USUARIO =====
function initModals() {
    // Prevenir múltiples inicializaciones
    if (window.modalsInitialized) return;
    window.modalsInitialized = true;
    
    // Botón nuevo usuario
    const newUserBtn = document.getElementById('new-user-btn');
    if (newUserBtn) {
        newUserBtn.addEventListener('click', () => {
            showModal('new-user-modal');
            const usernameInput = document.getElementById('new-username');
            if (usernameInput) usernameInput.value = '';
        });
    }
    
    // Botón crear
    const createBtn = document.getElementById('create-user-btn');
    if (createBtn) {
        createBtn.addEventListener('click', createUser);
    }
    
    // Botón cancelar
    const cancelBtn = document.getElementById('cancel-user-btn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
            closeModal('new-user-modal');
        });
    }
    
    // Botón copiar token
    const copyBtn = document.getElementById('copy-token-btn');
    if (copyBtn) {
        copyBtn.addEventListener('click', copyToken);
    }
    
    // Botón cerrar token modal
    const closeTokenBtn = document.getElementById('close-token-btn');
    if (closeTokenBtn) {
        closeTokenBtn.addEventListener('click', () => {
            closeModal('token-modal');
        });
    }
    
    // Botón eliminar usuario
    const deleteBtn = document.getElementById('delete-user-btn');
    if (deleteBtn) {
        deleteBtn.addEventListener('click', deleteUserConfirm);
    }
    
    // Cerrar modales con X o clic fuera
    document.querySelectorAll('.modal').forEach(modal => {
        // Clic fuera del modal
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeModal(modal.id);
            }
        });
        
        // Botones X de cierre
        modal.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', () => closeModal(modal.id));
        });
    });
}

async function createUser() {
    const username = document.getElementById('new-username').value.trim();
    
    if (!username) {
        showNotification('Ingresa un nombre de usuario', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/api/users`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ username })
        });
        
        // Validar respuesta HTTP
        if (response.status === 401) {
            console.warn('Sesión expirada al crear usuario');
            sessionStorage.removeItem('adminToken');
            window.location.href = '/login.html';
            return;
        }
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Error del servidor' }));
            throw new Error(errorData.error || `Error HTTP ${response.status}`);
        }
        
        const user = await response.json();
        
        // Validar que la respuesta tenga los campos necesarios
        if (!user || !user.token || !user.identifier) {
            throw new Error('Respuesta del servidor incompleta');
        }
        
        // Cerrar modal de creación
        closeModal('new-user-modal');
        
        // Mostrar modal de token
        const usernameEl = document.getElementById('created-username');
        const identifierEl = document.getElementById('created-identifier');
        const tokenEl = document.getElementById('created-token');
        
        if (usernameEl) usernameEl.textContent = user.username || username;
        if (identifierEl) identifierEl.textContent = user.identifier;
        if (tokenEl) tokenEl.textContent = user.token;
        
        showModal('token-modal');
        
        // Actualizar listas
        loadUsers();
        loadDashboard();
        
    } catch (error) {
        console.error('Error al crear usuario:', error);
        showNotification(error.message || 'Error al crear usuario', 'error');
    }
}

function copyToken() {
    const token = document.getElementById('created-token').textContent;
    navigator.clipboard.writeText(token);
    
    const btn = document.getElementById('copy-token-btn');
    btn.textContent = '✅ Copiado!';
    setTimeout(() => {
        btn.textContent = '📋 Copiar';
    }, 2000);
}

// ===== WEBSOCKET (Logs en tiempo real) =====
function initWebSocket() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${window.location.host}/ws`);
    
    ws.onopen = () => {
        console.log('[WS] Conectado');
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        handleWebSocketMessage(data);
    };
    
    ws.onerror = (error) => {
        console.error('[WS] Error:', error);
    };
    
    ws.onclose = () => {
        console.log('[WS] Desconectado. Reconectando en 5s...');
        setTimeout(initWebSocket, 5000);
    };
}

function handleWebSocketMessage(data) {
    // Actualizar logs en tiempo real si el modal del usuario está abierto
    if (data.type === 'log' && currentUserId === data.userId) {
        const logsContainer = document.getElementById('user-logs');
        const logEntry = document.createElement('div');
        logEntry.className = 'log-entry';
        logEntry.innerHTML = `
            <span class="log-timestamp">${formatTime(new Date())}</span>
            <span class="log-message">${data.message}</span>
        `;
        logsContainer.insertBefore(logEntry, logsContainer.firstChild);
        
        // Limitar a 50 logs
        while (logsContainer.children.length > 50) {
            logsContainer.removeChild(logsContainer.lastChild);
        }
    }
    
    // Actualizar dashboard si hay cambios
    if (data.type === 'stats_update') {
        loadDashboard();
    }
}

// ===== UTILIDADES =====
function showModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) {
        console.error(`Modal ${modalId} no encontrado`);
        return;
    }
    modal.classList.add('active');
    const modalContent = modal.querySelector('.modal-content');
    if (modalContent) {
        gsap.from(modalContent, { scale: 0.9, opacity: 0, duration: 0.3 });
    }
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (!modal) {
        console.error(`Modal ${modalId} no encontrado`);
        return;
    }
    const modalContent = modal.querySelector('.modal-content');
    if (modalContent) {
        gsap.to(modalContent, {
            scale: 0.9, opacity: 0, duration: 0.2, onComplete: () => {
                modal.classList.remove('active');
            }
        });
    } else {
        modal.classList.remove('active');
    }
}

function showNotification(message, type = 'info') {
    // Implementación simple - puede mejorarse
    alert(message);
}

function animateValue(element, start, end, duration) {
    const range = end - start;
    const increment = range / (duration / 16);
    let current = start;
    
    const timer = setInterval(() => {
        current += increment;
        if ((increment > 0 && current >= end) || (increment < 0 && current <= end)) {
            current = end;
            clearInterval(timer);
        }
        element.textContent = Math.floor(current).toLocaleString();
    }, 16);
}

function animateRefreshButton() {
    const btn = document.getElementById('refresh-btn');
    const icon = btn.querySelector('span');
    
    // Animación con anime.js (rotación suave de 360 grados)
    anime({
        targets: icon,
        rotate: '1turn', // 360 grados
        duration: 800,
        easing: 'easeOutCubic',
        complete: function() {
            // Reset rotation después de la animación
            icon.style.transform = 'rotate(0deg)';
        }
    });
    
    // Efecto de pulso en el botón
    anime({
        targets: btn,
        scale: [1, 0.95, 1],
        duration: 200,
        easing: 'easeInOutQuad'
    });
}

function formatNumber(num) {
    return parseInt(num).toLocaleString();
}

function formatDate(dateString) {
    const date = new Date(dateString);
    return date.toLocaleString('es-ES', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric', 
        hour: '2-digit', 
        minute: '2-digit' 
    });
}

function formatTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleTimeString('es-ES');
}

// ===== CONSOLA EN TIEMPO REAL =====
let consoleWs = null;
let consoleUserId = null;
let consoleLineCount = 0;
let consoleActiveFilter = 'all';
let consoleIsStreaming = false;

// Inicializar event listeners de la consola (llamar en DOMContentLoaded)
function initConsoleListeners() {
    // Botón de abrir consola
    const openConsoleBtn = document.getElementById('open-console-btn');
    if (openConsoleBtn) {
        openConsoleBtn.addEventListener('click', () => {
            if (currentUserId) {
                openConsole(currentUserId);
            }
        });
    }

    // Botones de control de la consola
    const startBtn = document.getElementById('console-start-btn');
    const stopBtn = document.getElementById('console-stop-btn');
    const clearBtn = document.getElementById('console-clear-btn');
    
    if (startBtn) startBtn.addEventListener('click', startConsoleStreaming);
    if (stopBtn) stopBtn.addEventListener('click', stopConsoleStreaming);
    if (clearBtn) clearBtn.addEventListener('click', clearConsole);

    // Filtros de nivel
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            consoleActiveFilter = btn.dataset.level;
            filterConsoleLogs();
        });
    });

    // Cerrar consola
    const consoleModal = document.getElementById('console-modal');
    if (consoleModal) {
        consoleModal.addEventListener('click', (e) => {
            if (e.target.id === 'console-modal') {
                closeConsole();
            }
        });

        consoleModal.querySelectorAll('.modal-close').forEach(btn => {
            btn.addEventListener('click', closeConsole);
        });
    }
}

/**
 * Abrir consola para un usuario específico
 */
async function openConsole(userId) {
    consoleUserId = userId;
    consoleLineCount = 0;
    
    // Obtener información del usuario
    try {
        const response = await fetch(`${API_BASE}/api/users/${userId}`, {
            headers: getAuthHeaders()
        });
        const user = await response.json();
        
        document.getElementById('console-username').textContent = user.username || user.identifier;
    } catch (error) {
        console.error('Error al obtener usuario:', error);
        document.getElementById('console-username').textContent = `#${userId}`;
    }
    
    // Limpiar output y mostrar modal
    clearConsole();
    showModal('console-modal');
    updateConsoleStatus('disconnected', 'Desconectado');
    
    // Inicializar WebSocket
    initConsoleWebSocket();
}

/**
 * Cerrar consola
 */
function closeConsole() {
    if (consoleIsStreaming) {
        stopConsoleStreaming();
    }
    
    if (consoleWs) {
        consoleWs.close();
        consoleWs = null;
    }
    
    closeModal('console-modal');
    consoleUserId = null;
}

/**
 * Inicializar WebSocket para la consola
 */
function initConsoleWebSocket() {
    if (consoleWs) {
        consoleWs.close();
    }
    
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    consoleWs = new WebSocket(`${protocol}//${window.location.host}?role=admin&userId=${consoleUserId}`);
    
    consoleWs.onopen = () => {
        console.log('[Console WS] Conectado');
        updateConsoleStatus('connected', 'Conectado');
        addConsoleLog('INFO', 'WebSocket conectado. Presiona "Iniciar" para recibir logs.');
    };
    
    consoleWs.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            handleConsoleMessage(data);
        } catch (error) {
            console.error('[Console WS] Error parsing message:', error);
        }
    };
    
    consoleWs.onerror = (error) => {
        console.error('[Console WS] Error:', error);
        updateConsoleStatus('error', 'Error de conexión');
        addConsoleLog('ERROR', 'Error en la conexión WebSocket');
    };
    
    consoleWs.onclose = () => {
        console.log('[Console WS] Desconectado');
        updateConsoleStatus('disconnected', 'Desconectado');
        if (consoleIsStreaming) {
            addConsoleLog('WARN', 'Conexión cerrada inesperadamente');
            consoleIsStreaming = false;
            updateStreamingButtons(false);
        }
    };
    
    // Keep alive
    setInterval(() => {
        if (consoleWs && consoleWs.readyState === WebSocket.OPEN) {
            consoleWs.send(JSON.stringify({ type: 'ping' }));
        }
    }, 30000);
}

/**
 * Manejar mensajes del WebSocket
 */
function handleConsoleMessage(data) {
    switch (data.type) {
        case 'connected':
            addConsoleLog('INFO', data.message || 'Conectado al servidor');
            break;
            
        case 'log':
            // Log de la extensión
            if (data.userId == consoleUserId) {
                addConsoleLog(data.level || 'INFO', data.message, data.source);
            }
            break;
            
        case 'monitoring_started':
            addConsoleLog('INFO', `✅ ${data.message}`);
            consoleIsStreaming = true;
            updateStreamingButtons(true);
            updateConsoleStatus('streaming', 'Streaming activo');
            break;
            
        case 'monitoring_stopped':
            addConsoleLog('INFO', `⏸️ ${data.message}`);
            consoleIsStreaming = false;
            updateStreamingButtons(false);
            updateConsoleStatus('connected', 'Conectado');
            break;
            
        case 'pong':
            // Respuesta al ping (keep alive)
            break;
            
        case 'error':
            addConsoleLog('ERROR', data.message || 'Error desconocido');
            break;
            
        default:
            console.log('[Console WS] Mensaje desconocido:', data);
    }
}

/**
 * Iniciar streaming de logs
 */
function startConsoleStreaming() {
    if (!consoleWs || consoleWs.readyState !== WebSocket.OPEN) {
        addConsoleLog('ERROR', 'WebSocket no conectado');
        return;
    }
    
    if (consoleIsStreaming) {
        addConsoleLog('WARN', 'El streaming ya está activo');
        return;
    }
    
    // Enviar comando para iniciar monitoreo
    consoleWs.send(JSON.stringify({
        type: 'start_monitoring',
        userId: consoleUserId
    }));
    
    addConsoleLog('INFO', '▶️ Solicitando inicio de streaming...');
}

/**
 * Detener streaming de logs
 */
function stopConsoleStreaming() {
    if (!consoleWs || consoleWs.readyState !== WebSocket.OPEN) {
        return;
    }
    
    if (!consoleIsStreaming) {
        return;
    }
    
    // Enviar comando para detener monitoreo
    consoleWs.send(JSON.stringify({
        type: 'stop_monitoring',
        userId: consoleUserId
    }));
    
    addConsoleLog('INFO', '⏸️ Solicitando pausa de streaming...');
}

/**
 * Limpiar consola
 */
function clearConsole() {
    const output = document.getElementById('console-output');
    output.innerHTML = '<div class="console-welcome"><p>🖥️ <strong>Consola de Logs en Tiempo Real</strong></p><p>Presiona <strong>"Iniciar"</strong> para comenzar a recibir logs de la extensión del usuario.</p></div>';
    consoleLineCount = 0;
    updateConsoleLineCount();
}

/**
 * Agregar log a la consola
 */
function addConsoleLog(level, message, source = 'system') {
    const output = document.getElementById('console-output');
    
    // Remover mensaje de bienvenida si existe
    const welcome = output.querySelector('.console-welcome');
    if (welcome) {
        welcome.remove();
    }
    
    const timestamp = new Date().toLocaleTimeString('es-ES', { hour12: false });
    
    const entry = document.createElement('div');
    entry.className = `console-log-entry level-${level}`;
    entry.dataset.level = level;
    
    entry.innerHTML = `
        <span class="console-timestamp">[${timestamp}]</span>
        <span class="console-level level-${level}">${level}</span>
        <span class="console-message">${escapeHtml(message)}</span>
    `;
    
    output.appendChild(entry);
    
    // Auto-scroll al final
    output.scrollTop = output.scrollHeight;
    
    // Incrementar contador
    consoleLineCount++;
    updateConsoleLineCount();
    updateConsoleLastUpdate();
    
    // Aplicar filtro si está activo
    if (consoleActiveFilter !== 'all' && level !== consoleActiveFilter) {
        entry.style.display = 'none';
    }
}

/**
 * Filtrar logs por nivel
 */
function filterConsoleLogs() {
    const entries = document.querySelectorAll('.console-log-entry');
    
    entries.forEach(entry => {
        if (consoleActiveFilter === 'all') {
            entry.style.display = 'flex';
        } else {
            entry.style.display = entry.dataset.level === consoleActiveFilter ? 'flex' : 'none';
        }
    });
}

/**
 * Actualizar estado de la consola
 */
function updateConsoleStatus(state, text) {
    const indicator = document.getElementById('console-status-indicator');
    const statusText = document.getElementById('console-status-text');
    
    indicator.className = 'status-indicator';
    
    switch (state) {
        case 'connected':
            indicator.classList.add('status-connected');
            break;
        case 'streaming':
            indicator.classList.add('status-streaming');
            break;
        case 'error':
            indicator.classList.add('status-error');
            break;
        default:
            indicator.classList.add('status-disconnected');
    }
    
    statusText.textContent = text;
}

/**
 * Actualizar botones de streaming
 */
function updateStreamingButtons(isStreaming) {
    const startBtn = document.getElementById('console-start-btn');
    const stopBtn = document.getElementById('console-stop-btn');
    
    startBtn.disabled = isStreaming;
    stopBtn.disabled = !isStreaming;
}

/**
 * Actualizar contador de líneas
 */
function updateConsoleLineCount() {
    document.getElementById('console-line-count').textContent = consoleLineCount;
}

/**
 * Actualizar última actualización
 */
function updateConsoleLastUpdate() {
    const time = new Date().toLocaleTimeString('es-ES', { hour12: false });
    document.getElementById('console-last-update').textContent = time;
}

/**
 * Escapar HTML
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ===== DETECCIÓN DE GÉNERO POR NOMBRE =====
function detectGender(fullName) {
    const firstName = fullName.split(' ')[0].toLowerCase();
    
    const femaleNames = ['maría', 'ana', 'carmen', 'isabel', 'dolores', 'pilar', 'teresa', 
                         'rosa', 'francisca', 'antonia', 'julia', 'laura', 'marta', 'elena', 
                         'cristina', 'paula', 'sara', 'patricia', 'andrea', 'lucía', 'sofía', 
                         'valentina', 'camila', 'martina', 'carla', 'daniela', 'alejandra', 'gabriela'];
    
    const maleNames = ['antonio', 'josé', 'manuel', 'francisco', 'juan', 'david', 'miguel', 
                       'javier', 'daniel', 'carlos', 'rafael', 'pedro', 'jesús', 'alejandro', 
                       'fernando', 'sergio', 'pablo', 'jorge', 'alberto', 'luis', 'roberto', 
                       'eduardo', 'diego', 'ángel', 'adrián', 'mario', 'oscar', 'raúl', 'víctor'];
    
    if (femaleNames.includes(firstName)) return 'female';
    if (maleNames.includes(firstName)) return 'male';
    
    if (firstName.endsWith('a') && !firstName.endsWith('ía')) {
        return maleNames.includes(firstName) ? 'male' : 'female';
    }
    
    return 'neutral';
}

// ===== TOGGLE USER STATUS =====
async function toggleUserStatus(event, userId) {
    event.stopPropagation();
    
    try {
        // Endpoint correcto: /api/users/:id/toggle (POST)
        const response = await fetch(`${API_BASE}/api/users/${userId}/toggle`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ enabled: true }) // El servidor togglea automáticamente
        });
        
        if (response.status === 401) {
            console.warn('Sesión expirada al cambiar estado');
            sessionStorage.removeItem('adminToken');
            window.location.href = '/login.html';
            return;
        }
        
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({ error: 'Error del servidor' }));
            throw new Error(errorData.error || 'Error al cambiar estado');
        }
        
        const data = await response.json();
        
        const toggle = document.getElementById(`toggle-${userId}`);
        if (!toggle) {
            console.warn(`Elemento toggle-${userId} no encontrado`);
            // Recargar usuarios para actualizar UI
            loadUsers();
            return;
        }
        
        const statusText = toggle.parentElement.querySelector('.toggle-status-text');
        
        if (data.user.enabled) {
            toggle.classList.add('enabled');
            if (statusText) {
                statusText.classList.remove('disabled');
                statusText.classList.add('enabled');
                statusText.textContent = 'Habilitado';
            }
        } else {
            toggle.classList.remove('enabled');
            if (statusText) {
                statusText.classList.remove('enabled');
                statusText.classList.add('disabled');
                statusText.textContent = 'Deshabilitado';
            }
        }
        
        showNotification(`Usuario ${data.user.enabled ? 'habilitado' : 'deshabilitado'} exitosamente`, 'success');
    } catch (error) {
        console.error('Error al cambiar estado del usuario:', error);
        showNotification(error.message || 'Error al cambiar estado del usuario', 'error');
    }
}

// ===== TOGGLE ERROR DETAILS =====
function toggleErrorDetails(errorId) {
    const errorCard = document.getElementById(`error-${errorId}`);
    if (errorCard) {
        errorCard.classList.toggle('expanded');
    }
}

// ===== GESTIÓN DE INFORMES =====
async function loadReports() {
    try {
        const response = await fetch('/api/reports/list', {
            headers: getAuthHeaders()
        });
        
        if (!response.ok) throw new Error('Error al cargar informes');
        
        const data = await response.json();
        renderReports(data.reports || []);
        loadUsersForFilter();
    } catch (error) {
        console.error('Error al cargar informes:', error);
        showNotification('Error al cargar informes', 'error');
        const container = document.getElementById('reports-list');
        if (container) {
            container.innerHTML = '<p class="empty-state">❌ Error al cargar informes</p>';
        }
    }
}

function renderReports(reports) {
    const container = document.getElementById('reports-list');
    
    if (!container) {
        console.warn('Elemento reports-list no encontrado');
        return;
    }
    
    if (!reports || reports.length === 0) {
        container.innerHTML = '<p class="empty-state">📋 No hay informes disponibles</p>';
        return;
    }
    
    container.innerHTML = reports.map(report => {
        const accuracy = report.questions_total > 0 
            ? ((report.questions_correct / report.questions_total) * 100).toFixed(1)
            : 0;
        
        return `
            <div class="report-card">
                <div class="report-header">
                    <h3>${report.report_title || 'Cuestionario'}</h3>
                    <span class="report-date">${formatDate(report.completed_at)}</span>
                </div>
                <div class="report-body">
                    <div class="report-stats">
                        <div class="stat">
                            <span class="label">Usuario:</span>
                            <span class="value">${report.username || 'Desconocido'}</span>
                        </div>
                        <div class="stat">
                            <span class="label">Preguntas:</span>
                            <span class="value">${report.questions_total}</span>
                        </div>
                        <div class="stat">
                            <span class="label">Correctas:</span>
                            <span class="value success">${report.questions_correct}</span>
                        </div>
                        <div class="stat">
                            <span class="label">Fallidas:</span>
                            <span class="value danger">${report.questions_failed}</span>
                        </div>
                        <div class="stat">
                            <span class="label">Precisión:</span>
                            <span class="value">${accuracy}%</span>
                        </div>
                        <div class="stat">
                            <span class="label">Modelo:</span>
                            <span class="value">${report.model_used}</span>
                        </div>
                        <div class="stat">
                            <span class="label">Tokens:</span>
                            <span class="value">${formatNumber(report.tokens_used || 0)}</span>
                        </div>
                        <div class="stat">
                            <span class="label">Duración:</span>
                            <span class="value">${formatDuration(report.duration_seconds)}</span>
                        </div>
                    </div>
                </div>
                <div class="report-footer">
                    <button class="btn btn-sm btn-primary" onclick="viewReportDetails(${report.id})">
                        👁️ Ver Detalles
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="downloadReport(${report.id})">
                        📥 Descargar
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

async function viewReportDetails(reportId) {
    alert(`Ver detalles del informe ${reportId} - En desarrollo`);
}

async function downloadReport(reportId) {
    try {
        const response = await fetch(`/api/reports/${reportId}`, {
            headers: getAuthHeaders()
        });
        
        if (!response.ok) throw new Error('Error al descargar informe');
        
        const report = await response.json();
        const blob = new Blob([JSON.stringify(report, null, 2)], { 
            type: 'application/json' 
        });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `informe-${reportId}-${Date.now()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        showNotification('Informe descargado exitosamente', 'success');
    } catch (error) {
        console.error('Error:', error);
        showNotification('Error al descargar informe', 'error');
    }
}

async function loadUsersForFilter() {
    try {
        const response = await fetch('/api/admin/users', {
            headers: getAuthHeaders()
        });
        
        if (!response.ok) return;
        
        const data = await response.json();
        const select = document.getElementById('reports-user-filter');
        
        if (select) {
            select.innerHTML = '<option value="">Todos los usuarios</option>' +
                data.users.map(user => 
                    `<option value="${user.id}">${user.username}</option>`
                ).join('');
        }
    } catch (error) {
        console.error('Error cargando usuarios:', error);
    }
}

function formatDuration(seconds) {
    if (!seconds || seconds === 0) return '0s';
    
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
    
    return parts.join(' ');
}

function filterReports() {
    const searchInput = document.getElementById('reports-search');
    const modelFilterSelect = document.getElementById('reports-model-filter');
    
    const searchText = searchInput?.value.toLowerCase() || '';
    const modelFilter = modelFilterSelect?.value || '';
    
    const cards = document.querySelectorAll('.report-card');
    
    if (cards.length === 0) return;
    
    cards.forEach(card => {
        const text = card.textContent.toLowerCase();
        const matchSearch = text.includes(searchText);
        const matchModel = !modelFilter || text.includes(modelFilter);
        
        if (matchSearch && matchModel) {
            card.style.display = 'block';
        } else {
            card.style.display = 'none';
        }
    });
}
