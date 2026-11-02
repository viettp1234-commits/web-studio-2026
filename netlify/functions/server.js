const crypto = require('crypto');
const fs = require('fs');
const querystring = require('querystring');

const TARGET_URL = 'https://lightvisual.studio';
const ADMIN_PASS = 'admin123';
const BRAND_NAME = 'AI Studio Pro';
const SECRET_KEY = 'khoa-bao-mat-proxy-2026-queue-vip';
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 phút treo máy không thao tác tự nhường lượt

const DB_FILE = '/tmp/database.json';
let lastDbLoadTime = 0;

let db = {
    masterCookie: '_fbp=fb.1.1791519268646.363735489448337118; llmgw_session=M1Y2NgLnIDTr9nJ21I4RrvOGHLovdiW0pH8-obhseXE',
    masterCsrfToken: '',
    hideHistoryTabs: false,
    configUpdatedAt: 0,
    lastCreated: null,
    activeUser: null,
    queue: [],
    users: {},
    kickedUsers: {},
    chatUsers: {},      // uid -> { uid, name, fingerprint, ip, createdAt, lastSeen }
    deviceUidMap: {},   // fingerprint -> uid (Khóa 1 máy chỉ tạo 1 UID vĩnh viễn)
    publicMessages: [], // Kênh chat chung giữa các web
    privateChats: {}    // uid -> [ { sender, text, time, accountData } ] (Chat riêng với Admin)
};

function loadDB(force = false) {
    const now = Date.now();
    if (!force && now - lastDbLoadTime < 1200) return;
    lastDbLoadTime = now;
    if (fs.existsSync(DB_FILE)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            if ((loaded.configUpdatedAt || 0) < (db.configUpdatedAt || 0)) {
                loaded.masterCookie = db.masterCookie;
                loaded.masterCsrfToken = db.masterCsrfToken;
                loaded.hideHistoryTabs = db.hideHistoryTabs;
                loaded.configUpdatedAt = db.configUpdatedAt;
            }
            db = {
                ...db,
                ...loaded,
                queue: Array.isArray(loaded.queue) ? loaded.queue : [],
                users: { ...db.users, ...(loaded.users || {}) },
                kickedUsers: { ...db.kickedUsers, ...(loaded.kickedUsers || {}) },
                chatUsers: { ...db.chatUsers, ...(loaded.chatUsers || {}) },
                deviceUidMap: { ...db.deviceUidMap, ...(loaded.deviceUidMap || {}) },
                publicMessages: Array.isArray(loaded.publicMessages) ? loaded.publicMessages.slice(-80) : [],
                privateChats: { ...db.privateChats, ...(loaded.privateChats || {}) }
            };
        } catch (e) {}
    }
}

function saveDB() {
    try {
        lastDbLoadTime = Date.now();
        fs.writeFileSync(DB_FILE, JSON.stringify(db), 'utf8');
    } catch (e) {}
}

function signToken(data) {
    const payload = Buffer.from(JSON.stringify(data)).toString('base64url');
    const sig = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function verifyToken(token) {
    if (!token || !token.includes('.')) return null;
    const [payload, sig] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', SECRET_KEY).update(payload).digest('base64url');
    if (sig !== expectedSig) return null;
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch (e) { return null; }
}

function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach(cookie => {
        let [name, ...rest] = cookie.split('=');
        name = name?.trim();
        if (name) list[name] = decodeURIComponent(rest.join('=').trim());
    });
    return list;
}

// Tạo và khôi phục Cookie cấu hình gốc để không bao giờ bị mất khi Netlify reset /tmp
function getConfigSyncCookie() {
    const token = signToken({
        c: db.masterCookie,
        t: db.masterCsrfToken,
        h: db.hideHistoryTabs,
        u: db.configUpdatedAt || 1
    });
    return `cfg_sync=${token}; Path=/; HttpOnly; Max-Age=31536000`;
}

function restoreConfigFromCookie(cookies) {
    if (!cookies.cfg_sync) return;
    const data = verifyToken(cookies.cfg_sync);
    if (data && data.c && (data.u || 0) > (db.configUpdatedAt || 0)) {
        db.masterCookie = data.c;
        db.masterCsrfToken = data.t || '';
        db.hideHistoryTabs = Boolean(data.h);
        db.configUpdatedAt = data.u;
        saveDB();
    }
}

// Tự động cập nhật session mới nếu server gốc lightvisual.studio trả về Set-Cookie mới
function updateMasterCookieFromResponse(response) {
    try {
        const setCookieHeader = response.headers.get('set-cookie');
        if (!setCookieHeader) return;
        const match = setCookieHeader.match(/llmgw_session=([^;,\s]+)/);
        if (match && match[1]) {
            const newSession = `llmgw_session=${match[1]}`;
            if (!db.masterCookie.includes(newSession)) {
                if (db.masterCookie.includes('llmgw_session=')) {
                    db.masterCookie = db.masterCookie.replace(/llmgw_session=[^;,\s]+/, newSession);
                } else {
                    db.masterCookie = `${db.masterCookie}; ${newSession}`;
                }
                db.configUpdatedAt = Date.now();
                saveDB();
            }
        }
    } catch (e) {}
}

function isStaticAsset(path) {
    return /\.(js|mjs|css|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|otf|json|map|wasm)$/i.test(path) ||
           path.startsWith('/assets/') ||
           path.startsWith('/_next/') ||
           path.startsWith('/static/');
}

function isMediaStream(path, acceptHeader = '') {
    return /\.(mp4|webm|m3u8|ts|mov|mp3|wav|ogg)$/i.test(path) ||
           acceptHeader.includes('video/') ||
           acceptHeader.includes('audio/');
}

// Tạo mật khẩu từ username, số phút và quota (không bao giờ bị ẩn thành "Đã mã hóa")
function computeSmartPassword(username, durationMinutes, maxQuota) {
    const mins36 = Math.min(46655, Math.max(1, durationMinutes || 60)).toString(36).padStart(3, '0');
    const quota36 = Math.min(1295, Math.max(0, maxQuota || 0)).toString(36).padStart(2, '0');
    const sig = crypto.createHmac('sha256', SECRET_KEY).update(`${username}:${mins36}:${quota36}`).digest('hex').slice(0, 4);
    return `${mins36}${quota36}${sig}`;
}

function generateSmartAccount(durationMinutes, maxQuota) {
    const id = Math.floor(1000 + Math.random() * 9000);
    const username = `tk_${id}`;
    const password = computeSmartPassword(username, durationMinutes, maxQuota);
    return { username, password };
}

function verifySmartAccount(username, password) {
    if (!username || !password || password.length !== 9) return null;
    const mins36 = password.slice(0, 3);
    const quota36 = password.slice(3, 5);
    const sig = password.slice(5, 9);
    const expectedSig = crypto.createHmac('sha256', SECRET_KEY).update(`${username}:${mins36}:${quota36}`).digest('hex').slice(0, 4);
    if (sig !== expectedSig) return null;
    return {
        durationMinutes: parseInt(mins36, 36) || 60,
        maxQuota: parseInt(quota36, 36) || 0
    };
}

function getDeviceName(ua = '') {
    let os = 'Thiết bị khác';
    if (ua.includes('Windows')) os = '💻 Windows PC';
    else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = '💻 MacBook/Mac';
    else if (ua.includes('iPhone') || ua.includes('iPad')) os = '📱 iPhone/iPad';
    else if (ua.includes('Android')) os = '📱 Android';

    let browser = 'Web';
    if (ua.includes('Edg/')) browser = 'Edge';
    else if (ua.includes('Chrome/')) browser = 'Chrome';
    else if (ua.includes('Safari/') && !ua.includes('Chrome')) browser = 'Safari';
    else if (ua.includes('Firefox/')) browser = 'Firefox';
    return `${os} (${browser})`;
}

function getDeviceFingerprint(clientIp, userAgent) {
    return crypto.createHash('md5').update(`${clientIp}::${getDeviceName(userAgent)}`).digest('hex').slice(0, 12);
}

function formatTimeVN(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h} giờ ${m} phút ${s} giây`;
    return `${m} phút ${s < 10 ? '0' : ''}${s} giây`;
}

function getRemainSeconds(u, now = Date.now()) {
    if (!u) return 0;
    if (!u.firstLoginAt) return u.durationMinutes * 60;
    return Math.max(0, Math.floor((u.firstLoginAt + u.durationMinutes * 60000 - now) / 1000));
}

function getEstimatedWaitSeconds(queueIndex) {
    const now = Date.now();
    let waitSec = 0;
    if (db.activeUser && db.users[db.activeUser]) {
        waitSec += getRemainSeconds(db.users[db.activeUser], now);
    }
    for (let i = 0; i < queueIndex; i++) {
        const qUser = db.users[db.queue[i]];
        if (qUser) waitSec += getRemainSeconds(qUser, now);
    }
    return waitSec;
}

function syncQueueEngine() {
    const now = Date.now();
    let changed = false;

    if (db.activeUser) {
        const u = db.users[db.activeUser];
        if (!u || db.kickedUsers[db.activeUser]) {
            db.activeUser = null;
            changed = true;
        } else {
            if (!u.firstLoginAt) {
                u.firstLoginAt = now;
                changed = true;
            }
            if (!u.lastInteractionAt) {
                u.lastInteractionAt = now;
                changed = true;
            }
            const expireTime = u.firstLoginAt + u.durationMinutes * 60000;
            const isIdleTimeout = (now - u.lastInteractionAt) >= IDLE_TIMEOUT_MS;

            if (now >= expireTime || isIdleTimeout) {
                u.isOnline = false;
                db.activeUser = null;
                changed = true;
            }
        }
    }

    const cleanQueue = [];
    for (const qUser of db.queue) {
        const u = db.users[qUser];
        if (!u || db.kickedUsers[qUser]) {
            changed = true;
            continue;
        }
        if (u.firstLoginAt && (now >= u.firstLoginAt + u.durationMinutes * 60000)) {
            changed = true;
            continue;
        }
        if (!cleanQueue.includes(qUser) && qUser !== db.activeUser) {
            cleanQueue.push(qUser);
        } else {
            changed = true;
        }
    }
    db.queue = cleanQueue;

    if (!db.activeUser && db.queue.length > 0) {
        const nextUser = db.queue.shift();
        const u = db.users[nextUser];
        if (u) {
            db.activeUser = nextUser;
            if (!u.firstLoginAt) u.firstLoginAt = now;
            u.isOnline = true;
            u.lastActiveAt = now;
            u.lastInteractionAt = now;
            changed = true;
        }
    }

    if (changed) saveDB();
}

// Khôi phục tài khoản từ Cookie mà vẫn giữ nguyên mật khẩu thật 100%
function ensureUserFromSession(session, userAgent, clientIp) {
    const username = session.username;
    const realPass = session.password || computeSmartPassword(username, session.durationMinutes || 60, session.maxQuota || 0);
    if (!db.users[username]) {
        db.users[username] = {
            password: realPass,
            durationMinutes: session.durationMinutes || 60,
            maxQuota: session.maxQuota || 0,
            usedQuota: session.usedQuota || 0,
            firstLoginAt: session.firstLoginAt || null,
            lastActiveAt: Date.now(),
            lastInteractionAt: Date.now(),
            isOnline: true,
            device: getDeviceName(userAgent),
            ip: clientIp
        };
    } else if (!db.users[username].password || db.users[username].password === '(Đã mã hóa)') {
        db.users[username].password = realPass;
    }
    if (!db.activeUser && db.queue.length === 0 && db.users[username].firstLoginAt) {
        db.activeUser = username;
    }
    return db.users[username];
}

// ==========================================
// COMPONENT GIAO DIỆN WIDGET CHAT DÀNH CHO KHÁCH (NHÚNG Ở MỌI TRANG)
// ==========================================
function getCustomerChatWidgetHTML(roleLabel = 'Khách') {
    return `
    <style>
        #vip-chat-launcher {
            position: fixed; bottom: 20px; right: 20px; z-index: 2147483646;
            background: linear-gradient(135deg, #ea580c, #f59e0b); color: #fff;
            border: none; border-radius: 99px; padding: 12px 20px;
            font-family: system-ui, sans-serif; font-weight: bold; font-size: 14px;
            cursor: pointer; box-shadow: 0 8px 25px rgba(234,88,12,0.5);
            display: flex; align-items: center; gap: 8px;
        }
        #vip-chat-badge {
            background: #ef4444; color: #fff; font-size: 11px; padding: 2px 7px;
            border-radius: 99px; display: none;
        }
        #vip-chat-modal {
            position: fixed; bottom: 76px; right: 20px; z-index: 2147483646;
            width: 360px; height: 480px; background: #141417; border: 1px solid #3f3f46;
            border-radius: 16px; box-shadow: 0 15px 45px rgba(0,0,0,0.85);
            font-family: system-ui, sans-serif; color: #fff; display: none;
            flex-direction: column; overflow: hidden;
        }
        .vc-header {
            background: #1c1c21; padding: 12px 14px; border-bottom: 1px solid #27272a;
            display: flex; justify-content: space-between; align-items: center;
        }
        .vc-tabs { display: flex; background: #0f0f12; border-bottom: 1px solid #27272a; }
        .vc-tab {
            flex: 1; padding: 10px 6px; text-align: center; font-size: 12.5px;
            font-weight: bold; color: #a1a1aa; cursor: pointer; border-bottom: 2px solid transparent;
        }
        .vc-tab.active { color: #f59e0b; border-bottom-color: #f59e0b; background: #18181b; }
        .vc-body { flex: 1; padding: 12px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
        .vc-msg { padding: 8px 12px; border-radius: 10px; max-width: 85%; word-wrap: break-word; line-height: 1.45; }
        .vc-msg.me { background: #ea580c; color: #fff; align-self: flex-end; border-bottom-right-radius: 2px; }
        .vc-msg.other { background: #27272a; color: #e4e4e7; align-self: flex-start; border-bottom-left-radius: 2px; }
        .vc-msg.admin { background: #14532d; border: 1px solid #22c55e; color: #fff; align-self: flex-start; }
        .vc-footer { padding: 10px; background: #1c1c21; border-top: 1px solid #27272a; display: flex; gap: 6px; }
        .vc-footer input {
            flex: 1; padding: 9px 12px; border-radius: 8px; border: 1px solid #3f3f46;
            background: #09090b; color: #fff; font-size: 13px; margin: 0;
        }
        .vc-footer button {
            width: auto; margin: 0; padding: 9px 14px; background: #f59e0b; color: #000;
            border: none; border-radius: 8px; font-weight: bold; cursor: pointer; font-size: 13px;
        }
    </style>

    <button id="vip-chat-launcher" type="button">
        💬 Chat Admin / Cộng đồng <span id="vip-chat-badge">Mới</span>
    </button>

    <div id="vip-chat-modal">
        <div class="vc-header">
            <div>
                <b style="color:#f59e0b;font-size:14px;">Hỗ Trợ & Chat Trực Tuyến</b>
                <div id="vc-uid-label" style="font-size:11px;color:#4ade80;">Chưa tạo UID</div>
            </div>
            <button type="button" id="vc-close-btn" style="background:transparent;color:#a1a1aa;border:none;font-size:18px;cursor:pointer;width:auto;padding:2px 6px;margin:0;">✕</button>
        </div>

        <!-- Màn hình tạo UID 1 lần duy nhất -->
        <div id="vc-create-uid-view" style="padding:24px 18px;text-align:center;flex:1;display:flex;flex-direction:column;justify-content:center;">
            <div style="font-size:34px;margin-bottom:8px;">🆔</div>
            <h3 style="margin:0 0 8px 0;color:#f59e0b;font-size:16px;">Tạo Tên UID Của Bạn</h3>
            <p style="color:#a1a1aa;font-size:12.5px;line-height:1.5;margin:0 0 16px 0;">
                Bấm tạo tên UID để nhắn tin cho Admin xin cấp Tài khoản/Mật khẩu và chat với người dùng khác.<br>
                <b style="color:#f87171;">⚠️ Lưu ý:</b> Mỗi máy chỉ được tạo 1 UID duy nhất và được lưu vĩnh viễn!
            </p>
            <input type="text" id="vc-new-uid-input" placeholder="Nhập tên của bạn (VD: Huy Hoàng)..." maxlength="20" style="width:100%;padding:11px;border-radius:8px;border:1px solid #3f3f46;background:#09090b;color:#fff;box-sizing:border-box;margin-bottom:10px;font-size:13.5px;" />
            <button type="button" id="vc-create-uid-btn" style="width:100%;padding:11px;background:#22c55e;color:#000;border:none;border-radius:8px;font-weight:bold;cursor:pointer;font-size:14px;">➕ Tạo UID Vĩnh Viễn Ngay</button>
        </div>

        <!-- Màn hình chính sau khi đã có UID -->
        <div id="vc-main-chat-view" style="display:none;flex:1;flex-direction:column;overflow:hidden;">
            <div class="vc-tabs">
                <div class="vc-tab active" data-tab="admin">👨‍💼 Chat với Admin</div>
                <div class="vc-tab" data-tab="public">🌐 Chat Chung (2 Web)</div>
            </div>
            <div class="vc-body" id="vc-messages-box"></div>
            <div class="vc-footer">
                <input type="text" id="vc-msg-input" placeholder="Nhập tin nhắn..." maxlength="300" />
                <button type="button" id="vc-send-btn">Gửi</button>
            </div>
        </div>
    </div>

    <script>
        (function(){
            const ROLE_LABEL = ${JSON.stringify(roleLabel)};
            let myUid = localStorage.getItem(' PERMANENT_CHAT_UID_V1 ') || '';
            let currentTab = 'admin';
            let isOpen = false;
            let lastAdminCount = 0;

            const launcher = document.getElementById('vip-chat-launcher');
            const badge = document.getElementById('vip-chat-badge');
            const modal = document.getElementById('vip-chat-modal');
            const closeBtn = document.getElementById('vc-close-btn');
            const uidLabel = document.getElementById('vc-uid-label');
            const createView = document.getElementById('vc-create-uid-view');
            const mainView = document.getElementById('vc-main-chat-view');
            const uidInput = document.getElementById('vc-new-uid-input');
            const uidBtn = document.getElementById('vc-create-uid-btn');
            const msgBox = document.getElementById('vc-messages-box');
            const msgInput = document.getElementById('vc-msg-input');
            const sendBtn = document.getElementById('vc-send-btn');

            function updateViewMode() {
                if (myUid) {
                    uidLabel.textContent = '🆔 UID của bạn: ' + myUid + ' (Đã lưu vĩnh viễn)';
                    createView.style.display = 'none';
                    mainView.style.display = 'flex';
                } else {
                    uidLabel.textContent = 'Chưa có UID định danh';
                    createView.style.display = 'flex';
                    mainView.style.display = 'none';
                }
            }

            launcher.addEventListener('click', () => {
                isOpen = !isOpen;
                modal.style.display = isOpen ? 'flex' : 'none';
                if (isOpen) {
                    badge.style.display = 'none';
                    syncChat();
                }
            });
            closeBtn.addEventListener('click', () => {
                isOpen = false;
                modal.style.display = 'none';
            });

            document.querySelectorAll('.vc-tab').forEach(tab => {
                tab.addEventListener('click', () => {
                    document.querySelectorAll('.vc-tab').forEach(t => t.classList.remove('active'));
                    tab.classList.add('active');
                    currentTab = tab.getAttribute('data-tab');
                    syncChat();
                });
            });

            uidBtn.addEventListener('click', () => {
                const rawName = (uidInput.value || '').trim();
                if (!rawName) return alert('Vui lòng nhập tên bạn muốn tạo UID!');
                uidBtn.disabled = true;
                uidBtn.textContent = 'Đang khởi tạo...';
                fetch('/chat-api?action=init_uid', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ desiredName: rawName, savedUid: myUid })
                }).then(r => r.json()).then(data => {
                    uidBtn.disabled = false;
                    uidBtn.textContent = '➕ Tạo UID Vĩnh Viễn Ngay';
                    if (data.uid) {
                        myUid = data.uid;
                        localStorage.setItem(' PERMANENT_CHAT_UID_V1 ', myUid);
                        updateViewMode();
                        syncChat();
                    }
                }).catch(() => { uidBtn.disabled = false; });
            });

            function fillLoginFromChat(u, p) {
                const uInput = document.querySelector('input[name="username"]');
                const pInput = document.querySelector('input[name="password"]');
                if (uInput && pInput) {
                    uInput.value = u;
                    pInput.value = p;
                    const form = uInput.closest('form');
                    if (form) form.submit();
                } else {
                    navigator.clipboard.writeText('TK: ' + u + ' | MK: ' + p);
                    alert('Đã copy Tài khoản: ' + u + ' và Mật khẩu: ' + p);
                }
            }
            window.__fillLoginFromChat = fillLoginFromChat;

            function renderMessages(data) {
                const list = currentTab === 'admin' ? (data.privateMessages || []) : (data.publicMessages || []);
                if (list.length === 0) {
                    msgBox.innerHTML = '<div style="color:#71717a;text-align:center;margin-top:40px;font-size:12.5px;">' +
                        (currentTab === 'admin'
                            ? '👋 Hãy nhắn tin cho Admin để được cấp Tài khoản & Mật khẩu vào Studio!'
                            : '🌐 Kênh chat chung giữa tất cả người dùng đang mở web.') + '</div>';
                    return;
                }
                msgBox.innerHTML = list.map(m => {
                    const isMe = m.sender === myUid;
                    const isAdmin = m.sender === 'ADMIN';
                    const cls = isAdmin ? 'vc-msg admin' : (isMe ? 'vc-msg me' : 'vc-msg other');
                    const senderLabel = isAdmin ? '👑 ADMIN' : (isMe ? 'Bạn (' + myUid + ')' : ('👤 ' + m.sender + (m.role ? ' [' + m.role + ']' : '')));
                    let extraBtn = '';
                    if (m.accountData && m.accountData.username && m.accountData.password) {
                        extraBtn = '<div style="margin-top:8px;padding-top:6px;border-top:1px dashed rgba(255,255,255,0.2);">' +
                            '<button type="button" onclick="window.__fillLoginFromChat(\\'' + m.accountData.username + '\\', \\'' + m.accountData.password + '\\')" style="width:100%;padding:7px;background:#facc15;color:#000;border:none;border-radius:6px;font-weight:bold;cursor:pointer;font-size:12px;">⚡ Tự điền TK/MK & Đăng nhập ngay</button></div>';
                    }
                    return '<div class="' + cls + '">' +
                        '<div style="font-size:10.5px;opacity:0.8;margin-bottom:3px;font-weight:bold;">' + senderLabel + ' • ' + m.time + '</div>' +
                        '<div>' + m.text + '</div>' + extraBtn +
                    '</div>';
                }).join('');
                msgBox.scrollTop = msgBox.scrollHeight;
            }

            function syncChat() {
                fetch('/chat-api?action=poll&uid=' + encodeURIComponent(myUid))
                    .then(r => r.json())
                    .then(data => {
                        if (data.uid && data.uid !== myUid) {
                            myUid = data.uid;
                            localStorage.setItem(' PERMANENT_CHAT_UID_V1 ', myUid);
                        }
                        updateViewMode();
                        if (!myUid) return;
                        const adminMsgs = (data.privateMessages || []).filter(m => m.sender === 'ADMIN').length;
                        if (adminMsgs > lastAdminCount && !isOpen && lastAdminCount > 0) {
                            badge.style.display = 'inline-block';
                        }
                        lastAdminCount = adminMsgs;
                        if (isOpen) renderMessages(data);
                    }).catch(() => {});
            }

            function sendMessage() {
                const text = (msgInput.value || '').trim();
                if (!text || !myUid) return;
                msgInput.value = '';
                fetch('/chat-api?action=send', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        uid: myUid,
                        target: currentTab,
                        role: ROLE_LABEL,
                        text
                    })
                }).then(r => r.json()).then(data => {
                    renderMessages(data);
                }).catch(() => {});
            }

            sendBtn.addEventListener('click', sendMessage);
            msgInput.addEventListener('keydown', e => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    sendMessage();
                }
            });

            syncChat();
            setInterval(syncChat, 3500);
        })();
    </script>`;
}

function escapeHtml(str = '') {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function nowTimeStr() {
    const d = new Date(Date.now() + 7 * 3600 * 1000);
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

exports.handler = async (event) => {
    const reqPath = event.path || '/';
    const method = event.httpMethod || 'GET';
    const query = event.queryStringParameters || {};
    const userAgent = event.headers['user-agent'] || '';
    const acceptHeader = event.headers['accept'] || '';
    const queryStr = event.rawQuery ? `?${event.rawQuery}` : '';
    const targetFullUrl = `${TARGET_URL}${reqPath}${queryStr}`;

    // ==========================================
    // 0A. STREAM VIDEO / AUDIO TRỰC TIẾP
    // ==========================================
    if (isMediaStream(reqPath, acceptHeader)) {
        return {
            statusCode: 302,
            headers: {
                'Location': targetFullUrl,
                'Cache-Control': 'public, max-age=3600'
            }
        };
    }

    const cookies = parseCookies(event.headers.cookie || event.headers.Cookie);
    loadDB();
    restoreConfigFromCookie(cookies);

    // ==========================================
    // 0B. TẢI FILE TĨNH (.JS, .CSS, ẢNH) VỚI COOKIE GỐC ĐÃ ĐỒNG BỘ
    // ==========================================
    if (isStaticAsset(reqPath)) {
        try {
            const response = await fetch(targetFullUrl, {
                method,
                headers: {
                    'Cookie': db.masterCookie,
                    'Origin': TARGET_URL,
                    'Referer': `${TARGET_URL}/`,
                    'User-Agent': userAgent || 'Mozilla/5.0',
                    'Accept': acceptHeader || '*/*'
                }
            });
            updateMasterCookieFromResponse(response);
            const contentType = response.headers.get('content-type') || 'application/octet-stream';
            const arrayBuffer = await response.arrayBuffer();
            return {
                statusCode: response.status,
                headers: {
                    'content-type': contentType,
                    'cache-control': 'public, max-age=86400, immutable'
                },
                body: Buffer.from(arrayBuffer).toString('base64'),
                isBase64Encoded: true
            };
        } catch (err) {
            return { statusCode: 502, body: '' };
        }
    }

    syncQueueEngine();

    const bodyText = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const clientIp = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'Không rõ IP').split(',')[0].trim();
    const deviceFp = getDeviceFingerprint(clientIp, userAgent);

    // ==========================================
    // 0C. API CHAT 2 CHIỀU & KHÓA 1 MÁY 1 UID VĨNH VIỄN (/chat-api)
    // ==========================================
    if (reqPath === '/chat-api') {
        const cookieUidData = verifyToken(cookies.chat_uid_token);
        let existingUid = (cookieUidData && cookieUidData.uid) || db.deviceUidMap[deviceFp] || '';

        if (method === 'POST' && query.action === 'init_uid') {
            let payload = {};
            try { payload = JSON.parse(bodyText || '{}'); } catch (e) {}

            if (!existingUid && payload.savedUid && db.chatUsers[payload.savedUid]) {
                existingUid = payload.savedUid;
            }

            // Nếu máy này chưa từng có UID -> Tạo mới 1 lần duy nhất
            if (!existingUid) {
                let cleanName = String(payload.desiredName || 'Khach')
                    .replace(/[^a-zA-Z0-9À-ỹ_\-\s]/g, '')
                    .trim()
                    .slice(0, 14) || 'Khach';
                const randSuffix = Math.floor(100 + Math.random() * 900);
                existingUid = `${cleanName}_${randSuffix}`;
            }

            db.deviceUidMap[deviceFp] = existingUid;
            db.chatUsers[existingUid] = {
                uid: existingUid,
                device: getDeviceName(userAgent),
                ip: clientIp,
                lastSeen: Date.now()
            };
            if (!db.privateChats[existingUid]) {
                db.privateChats[existingUid] = [{
                    sender: 'ADMIN',
                    text: `Xin chào ${existingUid}! Bạn cần cấp Tài khoản/Mật khẩu hãy nhắn vào đây nhé.`,
                    time: nowTimeStr()
                }];
            }
            saveDB();

            const uidToken = signToken({ uid: existingUid, fp: deviceFp });
            return {
                statusCode: 200,
                multiValueHeaders: {
                    'Set-Cookie': [
                        `chat_uid_token=${uidToken}; Path=/; HttpOnly; Max-Age=315360000`,
                        getConfigSyncCookie()
                    ]
                },
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ uid: existingUid })
            };
        }

        if (method === 'POST' && query.action === 'send') {
            let payload = {};
            try { payload = JSON.parse(bodyText || '{}'); } catch (e) {}
            const uid = existingUid || payload.uid;
            const text = escapeHtml((payload.text || '').trim().slice(0, 300));
            const target = payload.target || 'admin';
            const role = escapeHtml(payload.role || 'Khách');

            if (uid && text) {
                db.deviceUidMap[deviceFp] = uid;
                db.chatUsers[uid] = {
                    ...(db.chatUsers[uid] || {}),
                    uid,
                    device: getDeviceName(userAgent),
                    ip: clientIp,
                    lastSeen: Date.now(),
                    unreadForAdmin: target === 'admin' ? ((db.chatUsers[uid]?.unreadForAdmin || 0) + 1) : (db.chatUsers[uid]?.unreadForAdmin || 0)
                };

                if (target === 'public') {
                    db.publicMessages.push({ sender: uid, role, text, time: nowTimeStr() });
                    if (db.publicMessages.length > 80) db.publicMessages.shift();
                } else {
                    if (!db.privateChats[uid]) db.privateChats[uid] = [];
                    db.privateChats[uid].push({ sender: uid, text, time: nowTimeStr() });
                    if (db.privateChats[uid].length > 80) db.privateChats[uid].shift();
                }
                saveDB();
            }

            return {
                statusCode: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    uid,
                    publicMessages: db.publicMessages,
                    privateMessages: db.privateChats[uid] || []
                })
            };
        }

        // Poll tin nhắn
        const reqUid = existingUid || query.uid || '';
        if (reqUid && db.chatUsers[reqUid]) {
            db.chatUsers[reqUid].lastSeen = Date.now();
        }
        return {
            statusCode: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                uid: reqUid,
                publicMessages: db.publicMessages,
                privateMessages: reqUid ? (db.privateChats[reqUid] || []) : []
            })
        };
    }

    // ==========================================
    // 1. TRANG ĐĂNG NHẬP & XẾP HÀNG (/sub-login)
    // ==========================================
    if (reqPath === '/sub-login' && method === 'GET') {
        const errorMsg = query.err || '';
        const isBusy = Boolean(db.activeUser);
        const activeRemain = isBusy ? getRemainSeconds(db.users[db.activeUser]) : 0;

        const liveStatusBanner = isBusy
            ? `<div style="background:rgba(245,158,11,0.12);border:1px solid #f59e0b;padding:12px;border-radius:10px;margin-bottom:16px;font-size:13px;line-height:1.6;">
                🔴 <b>Trạng thái máy:</b> Đang có người sử dụng (Còn <b>${formatTimeVN(activeRemain)}</b>)<br>
                👥 <b>Đang xếp hàng chờ:</b> <b>${db.queue.length} người</b><br>
                ⏳ <i>Đăng nhập ngay để lấy số thứ tự trong hàng chờ (Thời gian của bạn chỉ bắt đầu tính khi tới lượt vào!).</i>
               </div>`
            : `<div style="background:rgba(34,197,94,0.12);border:1px solid #22c55e;padding:12px;border-radius:10px;margin-bottom:16px;font-size:13px;color:#4ade80;text-align:center;">
                🟢 <b>Trạng thái máy: Đang trống!</b> Đăng nhập là vào thẳng Studio ngay lập tức.
               </div>`;

        return {
            statusCode: 200,
            headers: {
                'content-type': 'text/html; charset=utf-8',
                'Set-Cookie': getConfigSyncCookie()
            },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Đăng nhập & Xếp hàng - ${BRAND_NAME}</title><style>body{background:#0b0b0c;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.box{background:#161618;padding:32px;border-radius:14px;border:1px solid #2a2a2e;width:390px;box-shadow:0 10px 30px rgba(0,0,0,0.6)}h2{margin-top:0;text-align:center;color:#f59e0b}input{width:100%;padding:12px;margin:8px 0;border-radius:8px;border:1px solid #333;background:#0f0f10;color:#fff;box-sizing:border-box}button{width:100%;padding:12px;background:#ea580c;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:10px;font-size:15px}.err{background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#f87171;padding:10px;border-radius:8px;font-size:13px;text-align:center;margin-bottom:12px}.note{color:#a1a1aa;font-size:12px;text-align:center;margin-top:14px;line-height:1.5}</style></head>
            <body>
                <div class="box">
                    <h2>${BRAND_NAME}</h2>
                    ${liveStatusBanner}
                    ${errorMsg ? `<div class="err">${errorMsg}</div>` : ''}
                    <form method="POST" action="/sub-login">
                        <input type="text" name="username" placeholder="Nhập Tài khoản được cấp" required />
                        <input type="password" name="password" placeholder="Nhập Mật khẩu" required />
                        <button type="submit">${isBusy ? '⏳ Đăng Nhập Để Xếp Hàng Chờ' : '🚀 Vào Studio Ngay'}</button>
                    </form>
                    <div class="note">
                        💡 Chưa có tài khoản? Bấm nút <b>💬 Chat Admin / Cộng đồng</b> ở góc dưới bên phải để tạo UID và nhắn Admin cấp tài khoản!
                    </div>
                </div>
                ${getCustomerChatWidgetHTML('Trang Đăng Nhập')}
            </body></html>`
        };
    }

    if (reqPath === '/sub-login' && method === 'POST') {
        const form = querystring.parse(bodyText);
        const username = (form.username || '').trim();
        const password = (form.password || '').trim();

        const savedAcctCookie = verifyToken(cookies[`acct_${username}`]);
        if (db.kickedUsers[username] || (savedAcctCookie && savedAcctCookie.kicked)) {
            return {
                statusCode: 302,
                headers: { Location: '/sub-login?err=' + encodeURIComponent('Tài khoản này đã bị Admin xóa hoặc thu hồi!') }
            };
        }

        let user = db.users[username];
        const smartInfo = verifySmartAccount(username, password);

        if ((!user || user.password !== password) && !smartInfo) {
            return { statusCode: 302, headers: { Location: '/sub-login?err=' + encodeURIComponent('Sai tài khoản hoặc mật khẩu!') } };
        }

        if (!user && smartInfo) {
            user = {
                password,
                durationMinutes: smartInfo.durationMinutes,
                maxQuota: smartInfo.maxQuota,
                usedQuota: 0,
                firstLoginAt: null,
                isOnline: false,
                device: '-',
                ip: '-'
            };
            db.users[username] = user;
        } else {
            user.password = password;
        }

        const now = Date.now();
        if (savedAcctCookie && savedAcctCookie.username === username) {
            if (savedAcctCookie.firstLoginAt && (!user.firstLoginAt || savedAcctCookie.firstLoginAt < user.firstLoginAt)) {
                user.firstLoginAt = savedAcctCookie.firstLoginAt;
            }
            if ((savedAcctCookie.usedQuota || 0) > (user.usedQuota || 0)) {
                user.usedQuota = savedAcctCookie.usedQuota;
            }
        }

        if (user.firstLoginAt && (now >= user.firstLoginAt + user.durationMinutes * 60000)) {
            saveDB();
            return {
                statusCode: 302,
                headers: { Location: '/sub-login?err=' + encodeURIComponent('Tài khoản này đã sử dụng hết thời gian!') }
            };
        }

        user.device = getDeviceName(userAgent);
        user.ip = clientIp;
        user.lastActiveAt = now;
        user.lastInteractionAt = now;

        if (!db.activeUser || db.activeUser === username) {
            db.activeUser = username;
            if (!user.firstLoginAt) user.firstLoginAt = now;
            user.isOnline = true;
            db.queue = db.queue.filter(u => u !== username);
        } else {
            if (!db.queue.includes(username)) {
                db.queue.push(username);
                user.queuedAt = now;
            }
            user.isOnline = true;
        }
        saveDB();

        const token = signToken({
            username,
            password: user.password,
            durationMinutes: user.durationMinutes,
            maxQuota: user.maxQuota || 0,
            usedQuota: user.usedQuota || 0,
            firstLoginAt: user.firstLoginAt,
            kicked: false
        });

        return {
            statusCode: 302,
            multiValueHeaders: {
                'Set-Cookie': [
                    `sub_token=${token}; Path=/; HttpOnly; Max-Age=86400`,
                    `acct_${username}=${token}; Path=/; HttpOnly; Max-Age=2592000`,
                    getConfigSyncCookie()
                ]
            },
            headers: { 'Location': db.activeUser === username ? '/' : '/waiting-room' }
        };
    }

    if (reqPath === '/sub-logout') {
        const session = verifyToken(cookies.sub_token);
        if (session) {
            const uName = session.username;
            if (db.users[uName]) db.users[uName].isOnline = false;
            if (db.activeUser === uName) {
                db.activeUser = null;
            }
            db.queue = db.queue.filter(u => u !== uName);
            syncQueueEngine();
            saveDB();
        }

        let msg = 'Bạn đã thoát khỏi phiên/hàng chờ. Nếu tài khoản còn thời gian, bạn có thể đăng nhập lại sau!';
        if (query.reason === 'timeout') msg = 'Tài khoản của bạn đã hết thời gian sử dụng!';
        if (query.reason === 'idle') msg = 'Bạn đã treo máy quá 10 phút không thao tác nên hệ thống tự động nhường lượt cho người tiếp theo!';
        if (query.reason === 'kicked') msg = 'Tài khoản của bạn đã bị Admin xóa hoặc đá khỏi hệ thống!';

        return {
            statusCode: 302,
            headers: {
                'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0',
                'Location': '/sub-login?err=' + encodeURIComponent(msg)
            }
        };
    }

    // ==========================================
    // 2. GIAO DIỆN PHÒNG CHỜ VIP (/waiting-room)
    // ==========================================
    if (reqPath === '/waiting-room') {
        const session = verifyToken(cookies.sub_token);
        if (!session) return { statusCode: 302, headers: { Location: '/sub-login' } };

        const username = session.username;
        if (db.kickedUsers[username]) {
            return { statusCode: 302, headers: { Location: '/sub-logout?reason=kicked' } };
        }

        ensureUserFromSession(session, userAgent, clientIp);

        if (db.activeUser === username) {
            return { statusCode: 302, headers: { Location: '/' } };
        }

        if (!db.queue.includes(username)) {
            if (!db.activeUser) {
                db.activeUser = username;
                if (db.users[username] && !db.users[username].firstLoginAt) {
                    db.users[username].firstLoginAt = Date.now();
                }
                db.users[username].lastInteractionAt = Date.now();
                saveDB();
                return { statusCode: 302, headers: { Location: '/' } };
            }
            db.queue.push(username);
            saveDB();
        }

        const qIndex = db.queue.indexOf(username);
        const position = qIndex + 1;
        const waitSeconds = getEstimatedWaitSeconds(qIndex);
        const activeRemainSec = db.activeUser ? getRemainSeconds(db.users[db.activeUser]) : 0;
        const myUser = db.users[username] || session;
        const myPackageMins = myUser.durationMinutes || 60;

        return {
            statusCode: 200,
            headers: {
                'content-type': 'text/html; charset=utf-8',
                'Set-Cookie': getConfigSyncCookie()
            },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Phòng Chờ Đến Lượt - ${BRAND_NAME}</title>
            <style>
                body{background:#09090b;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;padding:20px}
                .card{background:#141417;border:1px solid #27272a;border-radius:18px;padding:34px;max-width:500px;width:100%;box-shadow:0 15px 40px rgba(0,0,0,0.8);text-align:center}
                .badge{display:inline-block;background:rgba(245,158,11,0.15);border:1px solid #f59e0b;color:#facc15;padding:6px 16px;border-radius:99px;font-weight:bold;font-size:14px;margin-bottom:16px}
                .pos-box{background:#1c1c21;border:1px solid #3f3f46;border-radius:14px;padding:20px;margin:18px 0}
                .pos-num{font-size:44px;font-weight:800;color:#f59e0b;margin:4px 0}
                .wait-time{font-size:22px;font-weight:bold;color:#38bdf8;margin-top:8px}
                .info-row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #27272a;font-size:14px;color:#d4d4d8}
                .btn-out{display:inline-block;margin-top:22px;padding:10px 20px;background:#27272a;color:#f87171;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px}
                .btn-out:hover{background:#3f3f46}
                .pulse{display:inline-block;width:10px;height:10px;background:#22c55e;border-radius:50%;margin-right:6px;animation:blink 1.2s infinite}
                @keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}
            </style></head>
            <body>
                <div class="card">
                    <div class="badge"><span class="pulse"></span>HỆ THỐNG ĐANG XẾP HÀNG TỰ ĐỘNG (1 LUỒNG)</div>
                    <h2 style="margin:0 0 8px 0;">Xin chào, <span style="color:#f59e0b;">${username}</span>!</h2>
                    <p style="color:#a1a1aa;font-size:14px;margin:0;">Hiện đang có người sử dụng Studio. Hệ thống sẽ tự động mở cửa đưa bạn vào ngay khi tới lượt!</p>

                    <div class="pos-box">
                        <div style="color:#a1a1aa;font-size:13px;text-transform:uppercase;letter-spacing:1px;">Vị trí hàng chờ của bạn</div>
                        <div class="pos-num" id="pos-val">#${position}</div>
                        <div style="color:#a1a1aa;font-size:13px;margin-top:10px;">Thời gian chờ dự kiến tối đa:</div>
                        <div class="wait-time" id="wait-val">${formatTimeVN(waitSeconds)}</div>
                    </div>

                    <div class="info-row"><span>👤 Người đang dùng hiện tại còn:</span><b id="active-val" style="color:#facc15;">${formatTimeVN(activeRemainSec)}</b></div>
                    <div class="info-row"><span>🎁 Gói thời gian của bạn:</span><b style="color:#4ade80;">${myPackageMins} phút (Chưa bị trừ giây nào)</b></div>
                    <div class="info-row"><span>👥 Tổng số người trong hàng chờ:</span><b id="total-q">${db.queue.length} người</b></div>

                    <p style="color:#71717a;font-size:12.5px;margin-top:16px;line-height:1.5;">
                        💡 <b>Mẹo:</b> Bạn có thể bấm nút <b>💬 Chat</b> ở góc phải dưới để trò chuyện với người đang dùng trong Studio hoặc nhắn cho Admin!
                    </p>
                    <a href="/sub-logout" class="btn-out">Rời khỏi hàng chờ</a>
                </div>

                ${getCustomerChatWidgetHTML(`Hàng chờ #${position}`)}

                <script>
                    let waitSec = ${waitSeconds};
                    let activeSec = ${activeRemainSec};

                    function fmt(sec) {
                        sec = Math.max(0, sec);
                        const h = Math.floor(sec / 3600);
                        const m = Math.floor((sec % 3600) / 60);
                        const s = sec % 60;
                        if (h > 0) return h + ' giờ ' + m + ' phút ' + s + ' giây';
                        return m + ' phút ' + (s < 10 ? '0' : '') + s + ' giây';
                    }

                    setInterval(() => {
                        if (waitSec > 0) waitSec--;
                        if (activeSec > 0) activeSec--;
                        document.getElementById('wait-val').textContent = fmt(waitSec);
                        document.getElementById('active-val').textContent = fmt(activeSec);
                    }, 1000);

                    setInterval(() => {
                        fetch('/sub-status').then(r => r.json()).then(data => {
                            if (!data.valid) {
                                window.location.href = '/sub-logout?reason=' + (data.reason || 'kicked');
                                return;
                            }
                            if (data.status === 'active') {
                                window.location.href = '/';
                                return;
                            }
                            if (data.position) {
                                document.getElementById('pos-val').textContent = '#' + data.position;
                                document.getElementById('total-q').textContent = data.queueLength + ' người';
                                waitSec = data.waitSeconds;
                                activeSec = data.activeRemainSeconds;
                            }
                        }).catch(() => {});
                    }, 4000);
                </script>
            </body></html>`
        };
    }

    // ==========================================
    // 3. API ĐỒNG BỘ TRẠNG THÁI NGẦM (/sub-status)
    // ==========================================
    if (reqPath === '/sub-status') {
        const session = verifyToken(cookies.sub_token);
        if (!session) {
            return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ valid: false, reason: 'timeout' }) };
        }

        const username = session.username;
        if (db.kickedUsers[username]) {
            const kickedToken = signToken({ ...session, kicked: true });
            return {
                statusCode: 200,
                multiValueHeaders: {
                    'Set-Cookie': [
                        'sub_token=; Path=/; HttpOnly; Max-Age=0',
                        `acct_${username}=${kickedToken}; Path=/; HttpOnly; Max-Age=2592000`
                    ]
                },
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ valid: false, reason: 'kicked' })
            };
        }

        const user = ensureUserFromSession(session, userAgent, clientIp);
        user.isOnline = true;
        user.lastActiveAt = Date.now();
        user.device = getDeviceName(userAgent);
        user.ip = clientIp;

        if (query.active === '1' || query.action === 'increment') {
            user.lastInteractionAt = Date.now();
        }

        syncQueueEngine();

        if (db.activeUser === username) {
            const remainSec = getRemainSeconds(user);
            if (remainSec <= 0) {
                db.activeUser = null;
                syncQueueEngine();
                saveDB();
                return {
                    statusCode: 200,
                    headers: { 'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0', 'content-type': 'application/json' },
                    body: JSON.stringify({ valid: false, reason: 'timeout' })
                };
            }

            if (method === 'POST' && query.action === 'increment') {
                if (user.maxQuota > 0 && user.usedQuota >= user.maxQuota) {
                    return {
                        statusCode: 429,
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify({ valid: true, status: 'active', allowed: false, usedQuota: user.usedQuota, maxQuota: user.maxQuota, queueLength: db.queue.length })
                    };
                }
                user.usedQuota = (user.usedQuota || 0) + 1;
                saveDB();
            }

            const newToken = signToken({
                ...session,
                password: user.password,
                firstLoginAt: user.firstLoginAt,
                usedQuota: user.usedQuota
            });
            return {
                statusCode: 200,
                multiValueHeaders: {
                    'Set-Cookie': [
                        `sub_token=${newToken}; Path=/; HttpOnly; Max-Age=86400`,
                        `acct_${username}=${newToken}; Path=/; HttpOnly; Max-Age=2592000`,
                        getConfigSyncCookie()
                    ]
                },
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    valid: true,
                    status: 'active',
                    allowed: !(user.maxQuota > 0 && user.usedQuota > user.maxQuota),
                    remainSeconds: remainSec,
                    usedQuota: user.usedQuota || 0,
                    maxQuota: user.maxQuota || 0,
                    queueLength: db.queue.length
                })
            };
        }

        if (!db.queue.includes(username)) {
            if (user.firstLoginAt && getRemainSeconds(user) <= 0) {
                return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ valid: false, reason: 'timeout' }) };
            }
            db.queue.push(username);
            syncQueueEngine();
            saveDB();
        }

        if (db.activeUser === username) {
            return { statusCode: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ valid: true, status: 'active' }) };
        }

        const qIdx = db.queue.indexOf(username);
        const waitSeconds = getEstimatedWaitSeconds(qIdx);
        const activeRemainSeconds = db.activeUser ? getRemainSeconds(db.users[db.activeUser]) : 0;

        return {
            statusCode: 200,
            headers: {
                'content-type': 'application/json',
                'Set-Cookie': getConfigSyncCookie()
            },
            body: JSON.stringify({
                valid: true,
                status: 'queued',
                position: qIdx + 1,
                queueLength: db.queue.length,
                waitSeconds,
                activeRemainSeconds
            })
        };
    }

    // ==========================================
    // 4. TRANG QUẢN TRỊ ADMIN (/my-admin) - HIỆN MẬT KHẨU THẬT + CHAT KHÁCH + AJAX MƯỢT
    // ==========================================
    if (reqPath.startsWith('/my-admin')) {
        if (query.pass !== ADMIN_PASS) {
            return { statusCode: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Sai mật khẩu Admin!' };
        }

        // API trả dữ liệu JSON siêu nhẹ cho bảng Admin và khung Chat (không cần F5)
        if (reqPath === '/my-admin/api') {
            if (method === 'POST' && query.action === 'admin_chat') {
                let payload = {};
                try { payload = JSON.parse(bodyText || '{}'); } catch (e) {}
                const target = payload.target || 'public';
                const text = escapeHtml((payload.text || '').trim());
                const accountData = payload.accountData || null;

                if (text) {
                    if (target === 'public') {
                        db.publicMessages.push({ sender: 'ADMIN', role: 'ADMIN', text, time: nowTimeStr(), accountData });
                        if (db.publicMessages.length > 80) db.publicMessages.shift();
                    } else {
                        if (!db.privateChats[target]) db.privateChats[target] = [];
                        db.privateChats[target].push({ sender: 'ADMIN', text, time: nowTimeStr(), accountData });
                        if (db.chatUsers[target]) db.chatUsers[target].unreadForAdmin = 0;
                    }
                    saveDB();
                }
            }

            if (method === 'POST' && query.action === 'clear_unread') {
                const targetUid = query.uid;
                if (targetUid && db.chatUsers[targetUid]) {
                    db.chatUsers[targetUid].unreadForAdmin = 0;
                    saveDB();
                }
            }

            const usersList = Object.entries(db.users).reverse().map(([u, info]) => {
                const realPass = (info.password && info.password !== '(Đã mã hóa)')
                    ? info.password
                    : computeSmartPassword(u, info.durationMinutes, info.maxQuota);
                info.password = realPass;
                const qIdx = db.queue.indexOf(u);
                let statusType = 'unused';
                let remainOrWaitSec = info.durationMinutes * 60;

                if (db.activeUser === u) {
                    statusType = 'active';
                    remainOrWaitSec = getRemainSeconds(info);
                } else if (qIdx !== -1) {
                    statusType = 'queued';
                    remainOrWaitSec = getEstimatedWaitSeconds(qIdx);
                } else if (info.firstLoginAt) {
                    remainOrWaitSec = getRemainSeconds(info);
                    statusType = remainOrWaitSec > 0 ? 'paused' : 'expired';
                }

                return {
                    username: u,
                    password: realPass,
                    durationMinutes: info.durationMinutes,
                    maxQuota: info.maxQuota || 0,
                    usedQuota: info.usedQuota || 0,
                    statusType,
                    queuePos: qIdx + 1,
                    remainOrWaitSec,
                    device: info.device || '-',
                    ip: info.ip || '-'
                };
            });

            return {
                statusCode: 200,
                headers: {
                    'content-type': 'application/json',
                    'Set-Cookie': getConfigSyncCookie()
                },
                body: JSON.stringify({
                    activeUser: db.activeUser,
                    queueLength: db.queue.length,
                    lastCreated: db.lastCreated,
                    usersList,
                    chatUsers: db.chatUsers,
                    publicMessages: db.publicMessages,
                    privateChats: db.privateChats
                })
            };
        }

        if (reqPath === '/my-admin/config' && method === 'POST') {
            const form = querystring.parse(bodyText);
            db.masterCookie = (form.masterCookie || '').trim();
            db.masterCsrfToken = (form.masterCsrfToken || '').trim();
            db.hideHistoryTabs = Boolean(form.hideHistoryTabs);
            db.configUpdatedAt = Date.now();
            saveDB();
            return {
                statusCode: 302,
                headers: {
                    'Set-Cookie': getConfigSyncCookie(),
                    'Location': `/my-admin?pass=${ADMIN_PASS}`
                }
            };
        }

        if (reqPath === '/my-admin/random-user' && method === 'POST') {
            const form = querystring.parse(bodyText);
            const mins = Math.max(1, parseInt(form.durationMinutes, 10) || 60);
            const rawQuota = (form.maxQuota || '').trim();
            const maxQuota = rawQuota === '' ? 0 : Math.max(0, parseInt(rawQuota, 10) || 0);

            const { username, password } = generateSmartAccount(mins, maxQuota);
            delete db.kickedUsers[username];

            db.users[username] = {
                password,
                durationMinutes: mins,
                maxQuota,
                usedQuota: 0,
                firstLoginAt: null,
                isOnline: false,
                device: 'Chưa đăng nhập',
                ip: '-'
            };
            db.lastCreated = { username, password, durationMinutes: mins, maxQuota };
            saveDB();
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        if (reqPath === '/my-admin/promote') {
            const targetUser = query.user;
            if (targetUser && db.users[targetUser]) {
                if (db.activeUser && db.activeUser !== targetUser) {
                    db.queue.unshift(db.activeUser);
                }
                db.queue = db.queue.filter(u => u !== targetUser);
                db.activeUser = targetUser;
                if (!db.users[targetUser].firstLoginAt) {
                    db.users[targetUser].firstLoginAt = Date.now();
                }
                db.users[targetUser].lastInteractionAt = Date.now();
                saveDB();
            }
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        if (reqPath === '/my-admin/delete') {
            const targetUser = query.user;
            if (targetUser) {
                db.kickedUsers[targetUser] = true;
                if (db.activeUser === targetUser) db.activeUser = null;
                db.queue = db.queue.filter(u => u !== targetUser);
                delete db.users[targetUser];
                syncQueueEngine();
                saveDB();
            }
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        const lastCreatedBox = db.lastCreated ? `
            <div style="background:#14532d;border:1px solid #22c55e;padding:14px;border-radius:8px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                <div>
                    ✅ <b>Vừa tạo TK mới:</b> 
                    Tài khoản: <b style="color:#facc15;font-size:16px;">${db.lastCreated.username}</b> | 
                    Mật khẩu: <b style="color:#facc15;font-size:16px;">${db.lastCreated.password}</b> | 
                    Gói: <b>${db.lastCreated.durationMinutes} phút</b> | 
                    Lượt tạo: <b>${db.lastCreated.maxQuota > 0 ? db.lastCreated.maxQuota + ' lượt' : 'Vô hạn'}</b>
                </div>
                <button type="button" onclick="navigator.clipboard.writeText('Link: https://${event.headers.host}\\nTài khoản: ${db.lastCreated.username}\\nMật khẩu: ${db.lastCreated.password}\\nThời lượng: ${db.lastCreated.durationMinutes} phút\\nSố lượt tạo Ảnh/Video: ${db.lastCreated.maxQuota > 0 ? db.lastCreated.maxQuota + ' lượt' : 'Vô hạn'}');this.textContent='Đã Copy!';" style="background:#22c55e;color:#000;">📋 Copy gửi khách</button>
            </div>` : '';

        return {
            statusCode: 200,
            headers: {
                'content-type': 'text/html; charset=utf-8',
                'Set-Cookie': getConfigSyncCookie()
            },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Admin Hàng Chờ & Chat UID - ${BRAND_NAME}</title><style>
                body{background:#0f0f11;color:#e4e4e7;font-family:system-ui,sans-serif;padding:20px;max-width:1320px;margin:auto}
                .card{background:#18181b;padding:20px;border-radius:12px;border:1px solid #27272a;margin-bottom:20px}
                input,textarea{width:100%;padding:11px;margin:6px 0 14px;background:#09090b;border:1px solid #3f3f46;color:#fff;border-radius:6px;box-sizing:border-box}
                button{background:#f59e0b;color:#000;border:none;padding:10px 18px;border-radius:6px;font-weight:bold;cursor:pointer}
                table{width:100%;border-collapse:collapse;margin-top:10px}
                th,td{border:1px solid #27272a;padding:10px;text-align:left;font-size:13px}
                th{background:#27272a}
                .chat-grid{display:grid;grid-template-columns:280px 1fr;gap:16px;height:420px;margin-top:10px}
                .chat-uid-list{background:#09090b;border:1px solid #27272a;border-radius:8px;overflow-y:auto}
                .chat-uid-item{padding:11px 14px;border-bottom:1px solid #1f1f23;cursor:pointer;display:flex;justify-content:space-between;align-items:center;font-size:13px}
                .chat-uid-item.active{background:#27272a;border-left:3px solid #f59e0b}
                .chat-box-wrap{background:#09090b;border:1px solid #27272a;border-radius:8px;display:flex;flex-direction:column;overflow:hidden}
                .chat-messages{flex:1;padding:14px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;font-size:13px}
                .c-msg{padding:8px 12px;border-radius:8px;max-width:80%}
                .c-msg.admin{background:#14532d;border:1px solid #22c55e;align-self:flex-end}
                .c-msg.client{background:#27272a;align-self:flex-start}
            </style></head>
            <body>
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:10px;">
                    <h2 style="margin:0;">Quản trị Luồng, Hàng Chờ & Chat UID (${BRAND_NAME})</h2>
                    <div style="background:#18181b;border:1px solid #3f3f46;padding:8px 16px;border-radius:99px;font-size:14px;">
                        👤 Đang dùng: <b id="top-active-user" style="color:#4ade80;">${db.activeUser || 'Đang trống'}</b> &nbsp;|&nbsp; 
                        👥 Đang xếp hàng chờ: <b id="top-queue-count" style="color:#facc15;">${db.queue.length} người</b>
                    </div>
                </div>

                <!-- 1. TẠO TÀI KHOẢN -->
                <div class="card">
                    <h3 style="margin-top:0;">🎲 1. Tạo Tài khoản Mới (Mật khẩu luôn hiển thị rõ 100%)</h3>
                    ${lastCreatedBox}
                    <form method="POST" action="/my-admin/random-user?pass=${ADMIN_PASS}" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
                        <input type="number" name="durationMinutes" placeholder="Số phút sử dụng (VD: 60, 120, 180...)" required style="margin:0;flex:1;min-width:220px;font-size:15px;" />
                        <input type="number" name="maxQuota" placeholder="Giới hạn lượt tạo Ảnh/Video (VD: 20, để trống = Vô hạn)" style="margin:0;flex:1.3;min-width:260px;font-size:15px;" />
                        <button type="submit" style="white-space:nowrap;font-size:15px;">🎲 Tạo TK Ngẫu Nhiên</button>
                    </form>
                </div>

                <!-- 2. TRUNG TÂM CHAT VỚI KHÁCH (UID) & GỬI NHANH TK/MK -->
                <div class="card">
                    <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
                        <h3 style="margin:0;">💬 2. Chat Trực Tiếp Với Khách (Theo UID Vĩnh Viễn) & Chat Chung 2 Web</h3>
                        <button type="button" id="btn-send-last-acct" style="background:#22c55e;color:#000;padding:8px 14px;font-size:13px;">
                            🎁 Gửi nhanh TK vừa tạo vào khung chat đang mở
                        </button>
                    </div>
                    <div class="chat-grid">
                        <div class="chat-uid-list" id="admin-uid-list"></div>
                        <div class="chat-box-wrap">
                            <div id="admin-chat-header" style="padding:10px 14px;background:#18181b;border-bottom:1px solid #27272a;font-weight:bold;color:#f59e0b;font-size:13.5px;">
                                🌐 Kênh Chat Chung (Tất cả người dùng ở 2 web)
                            </div>
                            <div class="chat-messages" id="admin-chat-messages"></div>
                            <div style="padding:10px;background:#18181b;border-top:1px solid #27272a;display:flex;gap:8px;">
                                <input type="text" id="admin-chat-input" placeholder="Nhập tin nhắn trả lời khách hoặc gửi TK/MK..." style="margin:0;flex:1;" />
                                <button type="button" id="admin-chat-send">Gửi tin nhắn</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- 3. BẢNG DANH SÁCH TÀI KHOẢN (LÀM MỚI TỨC THÌ KHÔNG LAG) -->
                <div class="card">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <h3 style="margin:0;">🖥️ 3. Danh sách Luồng Chính, Thứ tự Hàng Chờ & Mật khẩu (Tự đồng bộ mượt 3s/lần)</h3>
                        <button type="button" id="btn-instant-refresh" style="background:#3b82f6;color:#fff;padding:7px 14px;font-size:13px;">🔄 Làm mới bảng ngay</button>
                    </div>
                    <table>
                        <thead>
                            <tr><th>Tài khoản</th><th>Mật khẩu</th><th>Gói</th><th>Vị trí / Luồng</th><th>Thời gian còn / Chờ dự kiến</th><th>Lượt tạo</th><th>Thiết bị / IP</th><th>Thao tác</th></tr>
                        </thead>
                        <tbody id="admin-user-tbody">
                            <tr><td colspan="8" style="text-align:center;color:#71717a;">Đang tải dữ liệu...</td></tr>
                        </tbody>
                    </table>
                </div>

                <!-- 4. CẤU HÌNH COOKIE GỐC -->
                <div class="card">
                    <h3 style="margin-top:0;">⚙️ 4. Cấu hình Cookie & X-CSRF-Token gốc (Tự động chống văng khi Server làm mới)</h3>
                    <form method="POST" action="/my-admin/config?pass=${ADMIN_PASS}">
                        <textarea name="masterCookie" rows="2">${db.masterCookie}</textarea>
                        <input type="text" name="masterCsrfToken" value="${db.masterCsrfToken}" placeholder="X-CSRF-Token (Nếu có)..." />
                        <label><input type="checkbox" name="hideHistoryTabs" style="width:auto;" ${db.hideHistoryTabs ? 'checked' : ''} /> Ẩn luôn tab Dự án & Thư viện</label><br><br>
                        <button type="submit">💾 Lưu Cấu Hình Gốc Vĩnh Viễn</button>
                    </form>
                </div>

                <script>
                    const PASS = ${JSON.stringify(ADMIN_PASS)};
                    const HOST = window.location.host;
                    let selectedChatTarget = 'public';
                    let latestData = null;

                    function fmt(sec) {
                        sec = Math.max(0, sec || 0);
                        const h = Math.floor(sec / 3600);
                        const m = Math.floor((sec % 3600) / 60);
                        const s = sec % 60;
                        if (h > 0) return h + ' giờ ' + m + ' phút ' + s + ' giây';
                        return m + ' phút ' + (s < 10 ? '0' : '') + s + ' giây';
                    }

                    function renderUserTable(usersList) {
                        const tbody = document.getElementById('admin-user-tbody');
                        if (!usersList || usersList.length === 0) {
                            tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#71717a;">Chưa có tài khoản nào.</td></tr>';
                            return;
                        }
                        tbody.innerHTML = usersList.map(u => {
                            let roleBadge = '<span style="color:#a1a1aa;">⚪ Chưa đăng nhập</span>';
                            let timeDetail = '<span style="color:#a1a1aa;">Còn nguyên ' + u.durationMinutes + ' phút</span>';

                            if (u.statusType === 'active') {
                                roleBadge = '<span style="background:#14532d;border:1px solid #22c55e;color:#4ade80;padding:4px 10px;border-radius:99px;font-weight:bold;font-size:12px;">🟢 ĐANG DÙNG LUỒNG CHÍNH</span>';
                                timeDetail = '<b class="admin-live-timer" data-sec="' + u.remainOrWaitSec + '" style="color:#f59e0b;font-size:14px;">' + fmt(u.remainOrWaitSec) + '</b>';
                            } else if (u.statusType === 'queued') {
                                roleBadge = '<span style="background:#422006;border:1px solid #f59e0b;color:#facc15;padding:4px 10px;border-radius:99px;font-weight:bold;font-size:12px;">⏳ ĐANG XẾP HÀNG SỐ #' + u.queuePos + '</span>';
                                timeDetail = '<span style="color:#38bdf8;">Chờ khoảng: <b class="admin-live-timer" data-sec="' + u.remainOrWaitSec + '">' + fmt(u.remainOrWaitSec) + '</b></span><br><small style="color:#a1a1aa;">(Gói ' + u.durationMinutes + 'p chưa trừ)</small>';
                            } else if (u.statusType === 'paused') {
                                roleBadge = '<span style="color:#eab308;font-weight:bold;">🟡 Đã thoát (Nhường luồng)</span>';
                                timeDetail = '<b class="admin-live-timer" data-sec="' + u.remainOrWaitSec + '" style="color:#eab308;">Còn ' + fmt(u.remainOrWaitSec) + '</b>';
                            } else if (u.statusType === 'expired') {
                                roleBadge = '<span style="color:#ef4444;font-weight:bold;">🔴 Đã hết giờ</span>';
                                timeDetail = '<span style="color:#ef4444;">00 phút 00 giây</span>';
                            }

                            const quotaText = u.maxQuota > 0
                                ? '<b style="color:' + (u.usedQuota >= u.maxQuota ? '#ef4444' : '#38bdf8') + ';">' + u.usedQuota + ' / ' + u.maxQuota + ' lượt</b>'
                                : '<b style="color:#22c55e;">' + u.usedQuota + ' / Vô hạn (∞)</b>';

                            const quotaLabel = u.maxQuota > 0 ? (u.maxQuota + ' lượt') : 'Vô hạn';
                            const copyStr = 'Link: https://' + HOST + ' | TK: ' + u.username + ' | MK: ' + u.password + ' (' + u.durationMinutes + ' phút - Tạo: ' + quotaLabel + ')';

                            return '<tr>' +
                                '<td><b style="color:#f59e0b;font-size:15px;">' + u.username + '</b></td>' +
                                '<td><code style="background:#27272a;color:#4ade80;padding:4px 8px;border-radius:4px;font-size:14px;font-weight:bold;">' + u.password + '</code></td>' +
                                '<td><b>' + u.durationMinutes + ' phút</b></td>' +
                                '<td>' + roleBadge + '</td>' +
                                '<td>' + timeDetail + '</td>' +
                                '<td>' + quotaText + '</td>' +
                                '<td><b>' + u.device + '</b><br><span style="font-size:12px;color:#a1a1aa;">IP: ' + u.ip + '</span></td>' +
                                '<td>' +
                                    '<button type="button" onclick="navigator.clipboard.writeText(\\'' + copyStr + '\\');this.textContent=\\'Đã Copy!\\';" style="padding:6px 10px;font-size:12px;margin-right:4px;background:#3b82f6;color:#fff;">Copy</button>' +
                                    (u.statusType !== 'active' ? '<a href="/my-admin/promote?pass=' + PASS + '&user=' + u.username + '" style="background:#22c55e;color:#000;padding:6px 10px;border-radius:6px;font-size:12px;font-weight:bold;text-decoration:none;margin-right:4px;">⚡ Cho vào ngay</a>' : '') +
                                    '<a href="/my-admin/delete?pass=' + PASS + '&user=' + u.username + '" style="background:#ef4444;color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;font-weight:bold;text-decoration:none;">🚫 Xóa / Đá</a>' +
                                '</td>' +
                            '</tr>';
                        }).join('');
                    }

                    function selectChatChannel(target) {
                        selectedChatTarget = target;
                        if (target !== 'public') {
                            fetch('/my-admin/api?pass=' + PASS + '&action=clear_unread&uid=' + encodeURIComponent(target), { method: 'POST' }).catch(() => {});
                        }
                        renderChatPanel();
                    }
                    window.__selectChatChannel = selectChatChannel;

                    function renderChatPanel() {
                        if (!latestData) return;
                        const uidListEl = document.getElementById('admin-uid-list');
                        const headerEl = document.getElementById('admin-chat-header');
                        const msgBoxEl = document.getElementById('admin-chat-messages');

                        const chatUsersArr = Object.values(latestData.chatUsers || {}).sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));

                        let leftHtml = '<div class="chat-uid-item ' + (selectedChatTarget === 'public' ? 'active' : '') + '" onclick="window.__selectChatChannel(\\'public\\')">' +
                            '<div><b>🌐 Chat Chung (2 Web)</b><div style="font-size:11px;color:#a1a1aa;">Mọi người cùng thấy</div></div>' +
                        '</div>';

                        chatUsersArr.forEach(cu => {
                            const unread = cu.unreadForAdmin || 0;
                            const badge = unread > 0 ? '<span style="background:#ef4444;color:#fff;padding:2px 7px;border-radius:99px;font-size:11px;font-weight:bold;">' + unread + '</span>' : '';
                            leftHtml += '<div class="chat-uid-item ' + (selectedChatTarget === cu.uid ? 'active' : '') + '" onclick="window.__selectChatChannel(\\'' + cu.uid + '\\')">' +
                                '<div><b style="color:#facc15;">🆔 ' + cu.uid + '</b><div style="font-size:11px;color:#a1a1aa;">' + (cu.device || '') + '</div></div>' +
                                badge +
                            '</div>';
                        });
                        uidListEl.innerHTML = leftHtml;

                        headerEl.textContent = selectedChatTarget === 'public'
                            ? '🌐 Kênh Chat Chung (Tất cả người dùng ở 2 web)'
                            : ('👨‍💼 Đang chat riêng với UID: ' + selectedChatTarget);

                        const msgs = selectedChatTarget === 'public'
                            ? (latestData.publicMessages || [])
                            : ((latestData.privateChats && latestData.privateChats[selectedChatTarget]) || []);

                        if (msgs.length === 0) {
                            msgBoxEl.innerHTML = '<div style="color:#71717a;text-align:center;margin-top:40px;">Chưa có tin nhắn nào.</div>';
                        } else {
                            msgBoxEl.innerHTML = msgs.map(m => {
                                const isAdmin = m.sender === 'ADMIN';
                                return '<div class="c-msg ' + (isAdmin ? 'admin' : 'client') + '">' +
                                    '<div style="font-size:11px;opacity:0.75;margin-bottom:3px;font-weight:bold;">' + (isAdmin ? '👑 ADMIN' : ('👤 ' + m.sender)) + ' • ' + m.time + '</div>' +
                                    '<div>' + m.text + '</div>' +
                                '</div>';
                            }).join('');
                            msgBoxEl.scrollTop = msgBoxEl.scrollHeight;
                        }
                    }

                    function syncAdminData() {
                        fetch('/my-admin/api?pass=' + PASS)
                            .then(r => r.json())
                            .then(data => {
                                latestData = data;
                                document.getElementById('top-active-user').textContent = data.activeUser || 'Đang trống';
                                document.getElementById('top-queue-count').textContent = data.queueLength + ' người';
                                renderUserTable(data.usersList);
                                renderChatPanel();
                            }).catch(() => {});
                    }

                    document.getElementById('btn-instant-refresh').addEventListener('click', function() {
                        this.textContent = '⏳ Đang đồng bộ...';
                        syncAdminData();
                        setTimeout(() => { this.textContent = '🔄 Làm mới bảng ngay'; }, 400);
                    });

                    function sendAdminMessage(customText, accountData = null) {
                        const input = document.getElementById('admin-chat-input');
                        const text = customText || (input.value || '').trim();
                        if (!text) return;
                        if (!customText) input.value = '';
                        fetch('/my-admin/api?pass=' + PASS + '&action=admin_chat', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                target: selectedChatTarget,
                                text,
                                accountData
                            })
                        }).then(() => syncAdminData());
                    }

                    document.getElementById('admin-chat-send').addEventListener('click', () => sendAdminMessage());
                    document.getElementById('admin-chat-input').addEventListener('keydown', e => {
                        if (e.key === 'Enter') {
                            e.preventDefault();
                            sendAdminMessage();
                        }
                    });

                    document.getElementById('btn-send-last-acct').addEventListener('click', () => {
                        if (!latestData || !latestData.lastCreated) {
                            return alert('Bạn hãy bấm Tạo TK Ngẫu Nhiên ở Mục 1 trước, hoặc copy TK bất kỳ trong bảng nhé!');
                        }
                        const lc = latestData.lastCreated;
                        const qLabel = lc.maxQuota > 0 ? (lc.maxQuota + ' lượt') : 'Vô hạn';
                        const msg = '🎁 Admin gửi bạn Tài khoản: ' + lc.username + ' | Mật khẩu: ' + lc.password + ' (Gói ' + lc.durationMinutes + ' phút - Lượt tạo: ' + qLabel + ')';
                        sendAdminMessage(msg, { username: lc.username, password: lc.password });
                    });

                    syncAdminData();
                    setInterval(syncAdminData, 3000);

                    setInterval(() => {
                        document.querySelectorAll('.admin-live-timer').forEach(el => {
                            let sec = parseInt(el.getAttribute('data-sec'), 10);
                            if (sec > 0) {
                                sec--;
                                el.setAttribute('data-sec', sec);
                                el.textContent = fmt(sec);
                            }
                        });
                    }, 1000);
                </script>
            </body></html>`
        };
    }

    // ==========================================
    // 5. KIỂM TRA QUYỀN LUỒNG CHÍNH TRƯỚC KHI VÀO STUDIO
    // ==========================================
    const session = verifyToken(cookies.sub_token);
    if (!session) {
        return { statusCode: 302, headers: { Location: '/sub-login' } };
    }

    const username = session.username;
    if (db.kickedUsers[username]) {
        return { statusCode: 302, headers: { Location: '/sub-logout?reason=kicked' } };
    }

    const currentUser = ensureUserFromSession(session, userAgent, clientIp);
    currentUser.lastInteractionAt = Date.now();

    if (db.activeUser !== username) {
        return { statusCode: 302, headers: { Location: '/waiting-room' } };
    }

    if (!currentUser || getRemainSeconds(currentUser) <= 0) {
        db.activeUser = null;
        syncQueueEngine();
        saveDB();
        return { statusCode: 302, headers: { Location: '/sub-logout?reason=timeout' } };
    }

    if (reqPath.toLowerCase() === '/app/api' || reqPath.toLowerCase().startsWith('/v1/keys')) {
        return { statusCode: 302, headers: { Location: '/' } };
    }

    const isGeneratePost = method === 'POST' && !reqPath.includes('auth') && !reqPath.includes('login');
    if (isGeneratePost && currentUser.maxQuota > 0 && currentUser.usedQuota >= currentUser.maxQuota) {
        return {
            statusCode: 429,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ error: { message: `Bạn đã dùng hết giới hạn ${currentUser.maxQuota} lượt tạo Ảnh/Video!` } })
        };
    }

    // ==========================================
    // 6. CHUYỂN TIẾP SANG WEB GỐC & HIỂN THỊ THANH TRẠNG THÁI + CHAT TRONG STUDIO
    // ==========================================
    const fetchHeaders = {
        'Cookie': db.masterCookie,
        'Origin': TARGET_URL,
        'Referer': `${TARGET_URL}/`,
        'User-Agent': userAgent || 'Mozilla/5.0',
        'Accept': acceptHeader || '*/*'
    };

    const clientCsrf = event.headers['x-csrf-token'] || event.headers['X-CSRF-Token'] || event.headers['x-xsrf-token'] || db.masterCsrfToken;
    if (clientCsrf) fetchHeaders['X-CSRF-Token'] = clientCsrf;
    if (event.headers['content-type']) fetchHeaders['Content-Type'] = event.headers['content-type'];
    if (event.headers['authorization']) fetchHeaders['Authorization'] = event.headers['authorization'];
    if (event.headers['range'] || event.headers['Range']) {
        fetchHeaders['Range'] = event.headers['range'] || event.headers['Range'];
    }

    try {
        const response = await fetch(targetFullUrl, {
            method,
            headers: fetchHeaders,
            body: ['GET', 'HEAD'].includes(method) ? undefined : (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body)
        });

        updateMasterCookieFromResponse(response);
        const contentType = response.headers.get('content-type') || '';
        const resCsrf = response.headers.get('x-csrf-token');
        if (resCsrf && resCsrf !== db.masterCsrfToken) {
            db.masterCsrfToken = resCsrf;
            db.configUpdatedAt = Date.now();
            saveDB();
        }

        if (contentType.includes('video/') || contentType.includes('audio/')) {
            return {
                statusCode: 302,
                headers: { 'Location': response.url || targetFullUrl }
            };
        }

        if (contentType.includes('text/html')) {
            let html = await response.text();
            html = html.replace(/<title>.*?<\/title>/i, `<title>${BRAND_NAME}</title>`);

            const remainSec = getRemainSeconds(currentUser);
            const usedQ = currentUser.usedQuota || 0;
            const maxQ = currentUser.maxQuota || 0;
            const hideHistory = db.hideHistoryTabs ? 'true' : 'false';

            const shield = `<style>
                a[href*="/api"], a[href*="zalo.me"], a[href*="pricing"], a[href*="billing"], a[href*="netlify.com"], iframe[src*="netlify"] { display: none !important; }
                #custom-timer-bar {
                    position: fixed; top: 8px; left: 50%; transform: translateX(-50%); z-index: 2147483647;
                    background: #161618; border: 1px solid #f59e0b;
                    color: #fff; padding: 6px 18px; border-radius: 99px;
                    font-family: system-ui, sans-serif; font-size: 13px;
                    box-shadow: 0 4px 20px rgba(0,0,0,0.9); white-space: nowrap;
                    display: flex; align-items: center; gap: 10px;
                }
            </style>
            <div id="custom-timer-bar">
                <span>🟢 <b>${username}</b></span>
                <span>|</span>
                <span>⏳ Còn: <b id="time-left-val" style="color:#f59e0b;">-- phút -- giây</b></span>
                <span>|</span>
                <span>🎨 Tạo: <b id="quota-val" style="color:#38bdf8;">${usedQ}/${maxQ > 0 ? maxQ : '∞'}</b></span>
                <span>|</span>
                <span>👥 Đang chờ sau bạn: <b id="queue-count-val" style="color:#facc15;">${db.queue.length} người</b></span>
                <span>|</span>
                <a href="/sub-logout" style="color:#ef4444;font-weight:bold;text-decoration:none;">Thoát (Nhường lượt)</a>
            </div>
            ${getCustomerChatWidgetHTML('Đang dùng Studio')}
            <script>
                (function(){
                    let sec = ${remainSec};
                    let usedQuota = ${usedQ};
                    let maxQuota = ${maxQ};
                    let hasInteracted = false;
                    let idleSeconds = 0;
                    const MAX_IDLE_SECONDS = 600;

                    const tEl = document.getElementById('time-left-val');
                    const qEl = document.getElementById('quota-val');
                    const qCountEl = document.getElementById('queue-count-val');

                    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
                        window.addEventListener(evt, () => {
                            hasInteracted = true;
                            idleSeconds = 0;
                        }, { passive: true });
                    });

                    function renderQuota() {
                        if (!qEl) return;
                        qEl.textContent = usedQuota + ' / ' + (maxQuota > 0 ? maxQuota : 'Vô hạn');
                        if (maxQuota > 0 && usedQuota >= maxQuota) {
                            qEl.style.color = '#ef4444';
                            qEl.textContent += ' (MAX)';
                        }
                    }
                    renderQuota();

                    setInterval(() => {
                        sec--;
                        idleSeconds++;
                        if (sec <= 0) {
                            window.location.href = '/sub-logout?reason=timeout';
                            return;
                        }
                        if (idleSeconds >= MAX_IDLE_SECONDS) {
                            window.location.href = '/sub-logout?reason=idle';
                            return;
                        }
                        if (tEl && sec >= 0) {
                            const h = Math.floor(sec / 3600);
                            const m = Math.floor((sec % 3600) / 60);
                            const s = sec % 60;
                            tEl.textContent = (h > 0 ? h + 'h ' : '') + m + 'p ' + (s < 10 ? '0' : '') + s + 's';
                        }
                    }, 1000);

                    const origFetch = window.fetch;
                    setInterval(() => {
                        const activeFlag = hasInteracted ? '?active=1' : '';
                        hasInteracted = false;
                        origFetch('/sub-status' + activeFlag).then(r => r.json()).then(data => {
                            if (!data.valid) {
                                window.location.href = '/sub-logout?reason=' + (data.reason || 'kicked');
                            } else if (data.status === 'queued') {
                                window.location.href = '/waiting-room';
                            } else {
                                usedQuota = data.usedQuota;
                                maxQuota = data.maxQuota;
                                if (qCountEl) qCountEl.textContent = (data.queueLength || 0) + ' người';
                                renderQuota();
                            }
                        }).catch(() => {});
                    }, 10000);

                    document.addEventListener('click', function(e) {
                        const btn = e.target.closest('button');
                        if (!btn) return;
                        const txt = (btn.textContent || '').trim();
                        if (/^Tạo(\\s|•|$)/i.test(txt) || txt.includes('Tạo ảnh') || txt.includes('Tạo video') || txt.includes('Chạy Excel')) {
                            if (maxQuota > 0 && usedQuota >= maxQuota) {
                                e.preventDefault();
                                e.stopPropagation();
                                alert('⛔ Bạn đã sử dụng hết giới hạn ' + maxQuota + '/' + maxQuota + ' lượt tạo Ảnh/Video!');
                                return false;
                            }
                            usedQuota++;
                            renderQuota();
                            origFetch('/sub-status?action=increment', { method: 'POST' }).then(r => r.json()).then(data => {
                                if (!data.allowed) alert('⛔ Bạn đã đạt giới hạn tối đa (' + maxQuota + ' lượt tạo)!');
                                usedQuota = data.usedQuota;
                                renderQuota();
                            }).catch(() => {});
                        }
                    }, true);

                    const savedCsrf = "${db.masterCsrfToken || ''}";
                    window.fetch = function(url, options = {}) {
                        const method = (options.method || 'GET').toUpperCase();
                        const urlStr = String(url);
                        if (method === 'POST' && !urlStr.includes('/sub-status') && !urlStr.includes('/chat-api') && maxQuota > 0 && usedQuota > maxQuota) {
                            return Promise.reject(new Error('Đã vượt quá giới hạn số lượt tạo!'));
                        }
                        options.headers = options.headers || {};
                        const csrfCookie = document.cookie.split('; ').find(r => r.startsWith('csrf') || r.startsWith('XSRF'));
                        const token = (csrfCookie ? csrfCookie.split('=')[1] : '') || window.__CSRF_TOKEN__ || savedCsrf;
                        if (token && !(options.headers instanceof Headers)) {
                            options.headers['X-CSRF-Token'] = options.headers['X-CSRF-Token'] || token;
                        }
                        return origFetch(url, options);
                    };

                    const f = ['Tải App', 'Báo lỗi / Góp ý', 'Báo lỗi', 'Vào Nhóm Zalo', 'Gói Vô Hạn', 'Nạp', 'API', 'Lịch sử request', 'Tạo API key', 'Powered by Netlify'];
                    if (${hideHistory}) f.push('Dự án', 'Thư viện');

                    let cleanTimer = null;
                    function c() {
                        document.querySelectorAll('a:not([data-cleaned]), button:not([data-cleaned]), span:not([data-cleaned])').forEach(el => {
                            if (el.id === 'custom-timer-bar' || el.closest('#custom-timer-bar') || el.closest('#vip-chat-modal') || el.id === 'vip-chat-launcher') {
                                el.setAttribute('data-cleaned', '1');
                                return;
                            }
                            const txt = (el.textContent || '').trim();
                            if (!txt || txt.length > 45) return;

                            if (el.children.length === 0 && (txt.toLowerCase() === 'lightvisual' || txt.toLowerCase() === '.studio')) {
                                el.textContent = txt.toLowerCase() === 'lightvisual' ? '${BRAND_NAME}' : '';
                                el.setAttribute('data-cleaned', '1');
                                return;
                            }
                            if (el.children.length === 0 && /^[0-9\\.]+đ$/i.test(txt)) {
                                el.style.display = 'none';
                                el.setAttribute('data-cleaned', '1');
                                return;
                            }
                            if (f.some(i => txt === i || txt.includes('Tải App') || txt.includes('Báo lỗi') || txt.includes('Vào Nhóm Zalo') || txt.includes('Gói Vô Hạn') || txt.includes('Powered by Netlify'))) {
                                const target = el.closest('a, button') || el;
                                target.style.display = 'none';
                                el.setAttribute('data-cleaned', '1');
                            }
                        });
                    }
                    c();
                    new MutationObserver(() => {
                        if (cleanTimer) clearTimeout(cleanTimer);
                        cleanTimer = setTimeout(c, 250);
                    }).observe(document.documentElement, { childList: true, subtree: true });
                })();
            </script>`;

            return {
                statusCode: response.status,
                headers: {
                    'content-type': 'text/html; charset=utf-8',
                    'Set-Cookie': getConfigSyncCookie()
                },
                body: html.replace('</body>', shield + '</body>')
            };
        }

        const outHeaders = { 'content-type': contentType };
        ['content-range', 'accept-ranges', 'content-length', 'cache-control'].forEach(h => {
            const val = response.headers.get(h);
            if (val) outHeaders[h] = val;
        });

        const arrayBuffer = await response.arrayBuffer();
        return {
            statusCode: response.status,
            headers: outHeaders,
            body: Buffer.from(arrayBuffer).toString('base64'),
            isBase64Encoded: true
        };
    } catch (err) {
        return { statusCode: 502, body: 'Lỗi kết nối Server gốc' };
    }
};
