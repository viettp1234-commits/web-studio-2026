const crypto = require('crypto');
const fs = require('fs');
const querystring = require('querystring');

const TARGET_URL = 'https://lightvisual.studio';
const ADMIN_PASS = 'admin123';
const BRAND_NAME = 'AI Studio Pro';
const SECRET_KEY = 'khoa-bao-mat-proxy-2026-vip-pro';

const DB_FILE = '/tmp/database.json';
let db = {
    masterCookie: '_fbp=fb.1.1791519268646.363735489448337118; llmgw_session=M1Y2NgLnIDTr9nJ21I4RrvOGHLovdiW0pH8-obhseXE',
    masterCsrfToken: '',
    hideHistoryTabs: false,
    lastCreated: null,
    users: {},
    kickedUsers: {}
};

function loadDB() {
    if (fs.existsSync(DB_FILE)) {
        try {
            const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
            db = { ...db, ...loaded, users: { ...db.users, ...(loaded.users || {}) }, kickedUsers: { ...db.kickedUsers, ...(loaded.kickedUsers || {}) } };
        } catch (e) {}
    }
}
function saveDB() {
    try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8'); } catch (e) {}
}
loadDB();

// Mã hóa thông số (Số phút + Giới hạn lượt) vào Mật khẩu để Netlify không bao giờ quên tài khoản
function generateSmartAccount(durationMinutes, maxQuota) {
    const id = Math.floor(1000 + Math.random() * 9000);
    const username = `tk_${id}`;
    const mins36 = Math.min(46655, Math.max(1, durationMinutes)).toString(36).padStart(3, '0');
    const quota36 = Math.min(1295, Math.max(0, maxQuota)).toString(36).padStart(2, '0');
    const sig = crypto.createHmac('sha256', SECRET_KEY).update(`${username}:${mins36}:${quota36}`).digest('hex').slice(0, 4);
    const password = `${mins36}${quota36}${sig}`;
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

exports.handler = async (event) => {
    loadDB();
    const reqPath = event.path || '/';
    const method = event.httpMethod || 'GET';
    const query = event.queryStringParameters || {};
    const cookies = parseCookies(event.headers.cookie || event.headers.Cookie);
    const bodyText = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    const clientIp = (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'] || 'Không rõ IP').split(',')[0].trim();
    const userAgent = event.headers['user-agent'] || '';

    // ==========================================
    // 1. TRANG ĐĂNG NHẬP KHÁCH
    // ==========================================
    if (reqPath === '/sub-login' && method === 'GET') {
        const errorMsg = query.err || '';
        return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Đăng nhập - ${BRAND_NAME}</title><style>body{background:#0b0b0c;color:#fff;font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0}.box{background:#161618;padding:32px;border-radius:14px;border:1px solid #2a2a2e;width:360px;box-shadow:0 10px 30px rgba(0,0,0,0.6)}h2{margin-top:0;text-align:center;color:#f59e0b}input{width:100%;padding:12px;margin:10px 0;border-radius:8px;border:1px solid #333;background:#0f0f10;color:#fff;box-sizing:border-box}button{width:100%;padding:12px;background:#ea580c;color:#fff;border:none;border-radius:8px;font-weight:bold;cursor:pointer;margin-top:10px}.err{background:rgba(239,68,68,0.15);border:1px solid #ef4444;color:#f87171;padding:10px;border-radius:8px;font-size:13px;text-align:center;margin-bottom:12px}.note{color:#a1a1aa;font-size:12px;text-align:center;margin-top:14px;line-height:1.5}</style></head><body><div class="box"><h2>${BRAND_NAME}</h2>${errorMsg ? `<div class="err">${errorMsg}</div>` : ''}<form method="POST" action="/sub-login"><input type="text" name="username" placeholder="Tài khoản được cấp" required /><input type="password" name="password" placeholder="Mật khẩu" required /><button type="submit">Đăng Nhập Vào Studio</button></form><div class="note">⏳ Thời gian bắt đầu tính giây ngay từ lần đăng nhập đầu tiên (kể cả khi thoát web). Nếu còn thời gian, bạn vẫn có thể đăng nhập lại.</div></div></body></html>`
        };
    }

    if (reqPath === '/sub-login' && method === 'POST') {
        const form = querystring.parse(bodyText);
        const username = (form.username || '').trim();
        const password = (form.password || '').trim();

        // Kiểm tra nếu tài khoản đã bị Admin bấm Xóa / Đá
        const savedAcctCookie = verifyToken(cookies[`acct_${username}`]);
        if (db.kickedUsers[username] || (savedAcctCookie && savedAcctCookie.kicked)) {
            return {
                statusCode: 302,
                headers: { Location: '/sub-login?err=' + encodeURIComponent('Tài khoản này đã bị xóa hoặc thu hồi quyền truy cập!') }
            };
        }

        let user = db.users[username];
        const smartInfo = verifySmartAccount(username, password);

        if ((!user || user.password !== password) && !smartInfo) {
            return { statusCode: 302, headers: { Location: '/sub-login?err=' + encodeURIComponent('Sai tài khoản hoặc mật khẩu!') } };
        }

        // Khôi phục tài khoản nếu Netlify vừa làm mới bộ nhớ tạm
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
        }

        const now = Date.now();
        // Đồng bộ thời gian đăng nhập đầu tiên và số lượt đã dùng từ Cookie trình duyệt (nếu có)
        if (savedAcctCookie && savedAcctCookie.username === username) {
            if (savedAcctCookie.firstLoginAt && (!user.firstLoginAt || savedAcctCookie.firstLoginAt < user.firstLoginAt)) {
                user.firstLoginAt = savedAcctCookie.firstLoginAt;
            }
            if ((savedAcctCookie.usedQuota || 0) > (user.usedQuota || 0)) {
                user.usedQuota = savedAcctCookie.usedQuota;
            }
        }

        // Bắt đầu tính giây từ lần đăng nhập đầu tiên
        if (!user.firstLoginAt) {
            user.firstLoginAt = now;
        }

        const expireTime = user.firstLoginAt + user.durationMinutes * 60 * 1000;
        if (now >= expireTime) {
            saveDB();
            return {
                statusCode: 302,
                headers: { Location: '/sub-login?err=' + encodeURIComponent('Tài khoản này đã hết thời gian sử dụng!') }
            };
        }

        user.isOnline = true;
        user.lastActiveAt = now;
        user.device = getDeviceName(userAgent);
        user.ip = clientIp;
        saveDB();

        const sessionState = {
            username,
            firstLoginAt: user.firstLoginAt,
            expireTime,
            durationMinutes: user.durationMinutes,
            maxQuota: user.maxQuota || 0,
            usedQuota: user.usedQuota || 0,
            kicked: false
        };

        const token = signToken(sessionState);
        const remainSec = Math.max(1, Math.floor((expireTime - now) / 1000));

        return {
            statusCode: 302,
            multiValueHeaders: {
                'Set-Cookie': [
                    `sub_token=${token}; Path=/; HttpOnly; Max-Age=${remainSec}`,
                    `acct_${username}=${token}; Path=/; HttpOnly; Max-Age=2592000`
                ]
            },
            headers: { 'Location': '/' }
        };
    }

    if (reqPath === '/sub-logout') {
        const session = verifyToken(cookies.sub_token);
        if (session && db.users[session.username]) {
            db.users[session.username].isOnline = false;
            saveDB();
        }
        let msg = 'Bạn đã thoát phiên làm việc. Nếu còn thời gian, bạn vẫn có thể đăng nhập lại!';
        if (query.reason === 'timeout') msg = 'Tài khoản đã hết thời gian sử dụng!';
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
    // 2. API KIỂM TRA TRẠNG THÁI NGẦM & ĐẾM LƯỢT TẠO (HEARTBEAT & QUOTA)
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

        const now = Date.now();
        if (now >= session.expireTime) {
            return {
                statusCode: 200,
                headers: { 'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0', 'content-type': 'application/json' },
                body: JSON.stringify({ valid: false, reason: 'timeout' })
            };
        }

        // Khôi phục hoặc cập nhật trạng thái trong DB để Admin luôn nhìn thấy
        if (!db.users[username]) {
            db.users[username] = {
                password: '(Đã mã hóa)',
                durationMinutes: session.durationMinutes || Math.round((session.expireTime - session.firstLoginAt) / 60000),
                maxQuota: session.maxQuota || 0,
                usedQuota: session.usedQuota || 0,
                firstLoginAt: session.firstLoginAt,
                isOnline: true,
                device: getDeviceName(userAgent),
                ip: clientIp
            };
        }
        const user = db.users[username];
        user.isOnline = true;
        user.lastActiveAt = now;
        user.device = getDeviceName(userAgent);
        user.ip = clientIp;

        // Nếu trình duyệt báo vừa bấm nút Tạo Ảnh/Video
        if (method === 'POST' && query.action === 'increment') {
            if (user.maxQuota > 0 && user.usedQuota >= user.maxQuota) {
                return {
                    statusCode: 429,
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ valid: true, allowed: false, usedQuota: user.usedQuota, maxQuota: user.maxQuota })
                };
            }
            user.usedQuota = (user.usedQuota || 0) + 1;
        }
        saveDB();

        const updatedState = { ...session, usedQuota: user.usedQuota };
        const newToken = signToken(updatedState);
        const remainSec = Math.max(1, Math.floor((session.expireTime - now) / 1000));

        return {
            statusCode: 200,
            multiValueHeaders: {
                'Set-Cookie': [
                    `sub_token=${newToken}; Path=/; HttpOnly; Max-Age=${remainSec}`,
                    `acct_${username}=${newToken}; Path=/; HttpOnly; Max-Age=2592000`
                ]
            },
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                valid: true,
                allowed: !(user.maxQuota > 0 && user.usedQuota > user.maxQuota),
                remainSeconds: remainSec,
                usedQuota: user.usedQuota || 0,
                maxQuota: user.maxQuota || 0
            })
        };
    }

    // ==========================================
    // 3. TRANG QUẢN TRỊ ADMIN
    // ==========================================
    if (reqPath.startsWith('/my-admin')) {
        if (query.pass !== ADMIN_PASS) {
            return { statusCode: 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'Sai mật khẩu Admin!' };
        }

        if (reqPath === '/my-admin/config' && method === 'POST') {
            const form = querystring.parse(bodyText);
            db.masterCookie = (form.masterCookie || '').trim();
            db.masterCsrfToken = (form.masterCsrfToken || '').trim();
            db.hideHistoryTabs = Boolean(form.hideHistoryTabs);
            saveDB();
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
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

        if (reqPath === '/my-admin/delete') {
            const targetUser = query.user;
            if (targetUser) {
                db.kickedUsers[targetUser] = true;
                delete db.users[targetUser];
                saveDB();
            }
            return { statusCode: 302, headers: { Location: `/my-admin?pass=${ADMIN_PASS}` } };
        }

        const now = Date.now();
        const userRows = Object.entries(db.users).reverse().map(([u, info]) => {
            let timeStatusHtml = `<span style="color:#a1a1aa;">⏳ Chưa kích hoạt (${info.durationMinutes} phút)</span>`;
            let machineHtml = `<span style="color:#71717a;">Chưa có máy vào</span>`;

            if (info.firstLoginAt) {
                const expireTime = info.firstLoginAt + info.durationMinutes * 60000;
                const remainSec = Math.max(0, Math.floor((expireTime - now) / 1000));
                const isRecentlyActive = info.isOnline && info.lastActiveAt && (now - info.lastActiveAt < 20000);

                if (remainSec > 0) {
                    const onlineBadge = isRecentlyActive
                        ? `<span style="color:#22c55e;font-weight:bold;">🟢 Đang trong web</span>`
                        : `<span style="color:#eab308;font-weight:bold;">🟡 Đã thoát tạm (Vẫn trừ giờ)</span>`;
                    timeStatusHtml = `${onlineBadge}<br><b class="admin-live-timer" data-sec="${remainSec}" style="color:#f59e0b;font-size:14px;">-- phút -- giây</b>`;
                } else {
                    timeStatusHtml = `<span style="color:#ef4444;font-weight:bold;">🔴 Đã hết thời gian (00p 00s)</span>`;
                }
                machineHtml = `<b>${info.device || '-'}</b><br><span style="font-size:12px;color:#a1a1aa;">IP: ${info.ip || '-'}</span>`;
            }

            const quotaText = info.maxQuota > 0
                ? (info.usedQuota >= info.maxQuota
                    ? `<b style="color:#ef4444;">⛔ Hết lượt (${info.usedQuota}/${info.maxQuota})</b>`
                    : `<b style="color:#38bdf8;">${info.usedQuota || 0} / ${info.maxQuota} lượt</b>`)
                : `<b style="color:#22c55e;">${info.usedQuota || 0} / Vô hạn (∞)</b>`;

            const quotaLabel = info.maxQuota > 0 ? `${info.maxQuota} lượt` : 'Vô hạn';
            const copyText = `Link: https://${event.headers.host} | TK: ${u} | MK: ${info.password} (${info.durationMinutes} phút - Tạo: ${quotaLabel})`;

            return `<tr>
                <td><b style="color:#f59e0b;font-size:15px;">${u}</b></td>
                <td><code style="background:#27272a;padding:4px 8px;border-radius:4px;font-size:14px;">${info.password}</code></td>
                <td><b>${info.durationMinutes} phút</b></td>
                <td>${timeStatusHtml}</td>
                <td>${quotaText}</td>
                <td>${machineHtml}</td>
                <td>
                    <button type="button" onclick="navigator.clipboard.writeText('${copyText}');this.textContent='Đã Copy!';" style="padding:6px 10px;font-size:12px;margin-right:6px;background:#3b82f6;color:#fff;">Copy</button>
                    <a href="/my-admin/delete?pass=${ADMIN_PASS}&user=${u}" style="background:#ef4444;color:#fff;padding:6px 10px;border-radius:6px;font-size:12px;font-weight:bold;text-decoration:none;">🚫 Xóa / Đá</a>
                </td>
            </tr>`;
        }).join('');

        const lastCreatedBox = db.lastCreated ? `
            <div style="background:#14532d;border:1px solid #22c55e;padding:14px;border-radius:8px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
                <div>
                    ✅ <b>Vừa tạo TK mới:</b> 
                    Tài khoản: <b style="color:#facc15;font-size:16px;">${db.lastCreated.username}</b> | 
                    Mật khẩu: <b style="color:#facc15;font-size:16px;">${db.lastCreated.password}</b> | 
                    Thời gian: <b>${db.lastCreated.durationMinutes} phút</b> | 
                    Giới hạn tạo: <b>${db.lastCreated.maxQuota > 0 ? db.lastCreated.maxQuota + ' lượt' : 'Vô hạn'}</b>
                </div>
                <button type="button" onclick="navigator.clipboard.writeText('Link: https://${event.headers.host}\\nTài khoản: ${db.lastCreated.username}\\nMật khẩu: ${db.lastCreated.password}\\nThời gian: ${db.lastCreated.durationMinutes} phút\\nSố lượt tạo Ảnh/Video: ${db.lastCreated.maxQuota > 0 ? db.lastCreated.maxQuota + ' lượt' : 'Vô hạn'}');this.textContent='Đã Copy!';" style="background:#22c55e;color:#000;">📋 Copy gửi khách</button>
            </div>` : '';

        return {
            statusCode: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: `<!DOCTYPE html><html lang="vi"><head><meta charset="UTF-8"><title>Admin - ${BRAND_NAME}</title><style>body{background:#0f0f11;color:#e4e4e7;font-family:system-ui,sans-serif;padding:24px;max-width:1150px;margin:auto}.card{background:#18181b;padding:20px;border-radius:10px;border:1px solid #27272a;margin-bottom:22px}input,textarea{width:100%;padding:11px;margin:6px 0 14px;background:#09090b;border:1px solid #3f3f46;color:#fff;border-radius:6px;box-sizing:border-box}button{background:#f59e0b;color:#000;border:none;padding:11px 20px;border-radius:6px;font-weight:bold;cursor:pointer}table{width:100%;border-collapse:collapse;margin-top:10px}th,td{border:1px solid #27272a;padding:10px;text-align:left;font-size:13.5px}th{background:#27272a}</style></head>
            <body>
                <h2>Quản trị Hệ thống (${BRAND_NAME})</h2>
                
                <div class="card">
                    <h3>🎲 1. Tạo Random Tài khoản & Mật khẩu (Tính giây từ lúc đăng nhập)</h3>
                    ${lastCreatedBox}
                    <form method="POST" action="/my-admin/random-user?pass=${ADMIN_PASS}" style="display:flex;gap:12px;align-items:center;flex-wrap:wrap;">
                        <input type="number" name="durationMinutes" placeholder="Số phút sử dụng (VD: 60)" required style="margin:0;flex:1;min-width:200px;font-size:15px;" />
                        <input type="number" name="maxQuota" placeholder="Giới hạn lượt tạo Ảnh/Video (VD: 20, để trống = Vô hạn)" style="margin:0;flex:1.3;min-width:260px;font-size:15px;" />
                        <button type="submit" style="white-space:nowrap;font-size:15px;">🎲 Tạo TK Ngẫu Nhiên</button>
                    </form>
                </div>

                <div class="card">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <h3>🖥️ 2. Danh sách Tài khoản, Thời gian chi tiết & Bộ đếm lượt tạo</h3>
                        <a href="/my-admin?pass=${ADMIN_PASS}" style="color:#f59e0b;text-decoration:none;font-size:14px;">🔄 Làm mới bảng</a>
                    </div>
                    <table>
                        <tr><th>Tài khoản</th><th>Mật khẩu</th><th>Gói</th><th>Thời gian còn lại (Chi tiết)</th><th>Lượt tạo Ảnh/Video</th><th>Máy đang dùng / IP</th><th>Thao tác</th></tr>
                        ${userRows || '<tr><td colspan="7" style="text-align:center;color:#71717a;">Chưa có tài khoản nào.</td></tr>'}
                    </table>
                </div>

                <div class="card">
                    <h3>⚙️ 3. Cấu hình Cookie & X-CSRF-Token gốc</h3>
                    <form method="POST" action="/my-admin/config?pass=${ADMIN_PASS}">
                        <textarea name="masterCookie" rows="2">${db.masterCookie}</textarea>
                        <input type="text" name="masterCsrfToken" value="${db.masterCsrfToken}" placeholder="X-CSRF-Token (Nếu có)..." />
                        <label><input type="checkbox" name="hideHistoryTabs" style="width:auto;" ${db.hideHistoryTabs ? 'checked' : ''} /> Ẩn luôn tab Dự án & Thư viện</label><br><br>
                        <button type="submit">Lưu Cấu Hình Gốc</button>
                    </form>
                </div>

                <script>
                    // Đồng hồ đếm ngược từng giây trực tiếp trên bảng Admin
                    function updateAdminTimers() {
                        document.querySelectorAll('.admin-live-timer').forEach(el => {
                            let sec = parseInt(el.getAttribute('data-sec'), 10);
                            if (sec > 0) {
                                sec--;
                                el.setAttribute('data-sec', sec);
                                const m = Math.floor(sec / 60);
                                const s = sec % 60;
                                el.textContent = '⏳ Còn ' + m + ' phút ' + (s < 10 ? '0' : '') + s + ' giây';
                            } else {
                                el.textContent = '🔴 Đã hết giờ (00p 00s)';
                                el.style.color = '#ef4444';
                            }
                        });
                    }
                    updateAdminTimers();
                    setInterval(updateAdminTimers, 1000);
                </script>
            </body></html>`
        };
    }

    // ==========================================
    // 4. KIỂM TRA PHIÊN TRƯỚC KHI VÀO STUDIO
    // ==========================================
    const session = verifyToken(cookies.sub_token);
    if (!session) {
        return { statusCode: 302, headers: { Location: '/sub-login' } };
    }

    if (db.kickedUsers[session.username]) {
        return {
            statusCode: 302,
            headers: {
                'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0',
                'Location': '/sub-login?err=' + encodeURIComponent('Tài khoản của bạn đã bị Admin xóa hoặc đá khỏi hệ thống!')
            }
        };
    }

    if (Date.now() >= session.expireTime) {
        return {
            statusCode: 302,
            headers: {
                'Set-Cookie': 'sub_token=; Path=/; HttpOnly; Max-Age=0',
                'Location': '/sub-login?err=' + encodeURIComponent('Tài khoản đã hết thời gian sử dụng!')
            }
        };
    }

    if (reqPath.toLowerCase() === '/app/api' || reqPath.toLowerCase().startsWith('/v1/keys')) {
        return { statusCode: 302, headers: { Location: '/' } };
    }

    // Chặn ở tầng Server nếu là lệnh POST tạo Ảnh/Video mà đã hết lượt
    const currentUser = db.users[session.username] || session;
    const isGeneratePost = method === 'POST' && !reqPath.includes('auth') && !reqPath.includes('login');
    if (isGeneratePost && currentUser.maxQuota > 0 && currentUser.usedQuota >= currentUser.maxQuota) {
        return {
            statusCode: 429,
            headers: { 'content-type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ error: { message: `Bạn đã dùng hết giới hạn ${currentUser.maxQuota} lượt tạo Ảnh/Video!` } })
        };
    }

    // ==========================================
    // 5. CHUYỂN TIẾP SANG WEB GỐC & TIÊM BỘ ĐẾM GIỜ + BỘ ĐẾM LƯỢT TẠO
    // ==========================================
    const queryStr = event.rawQuery ? `?${event.rawQuery}` : '';
    const targetFullUrl = `${TARGET_URL}${reqPath}${queryStr}`;

    const fetchHeaders = {
        'Cookie': db.masterCookie,
        'Origin': TARGET_URL,
        'Referer': `${TARGET_URL}/`,
        'User-Agent': userAgent || 'Mozilla/5.0',
        'Accept': event.headers['accept'] || '*/*'
    };

    const clientCsrf = event.headers['x-csrf-token'] || event.headers['X-CSRF-Token'] || event.headers['x-xsrf-token'] || db.masterCsrfToken;
    if (clientCsrf) fetchHeaders['X-CSRF-Token'] = clientCsrf;
    if (event.headers['content-type']) fetchHeaders['Content-Type'] = event.headers['content-type'];
    if (event.headers['authorization']) fetchHeaders['Authorization'] = event.headers['authorization'];

    try {
        const response = await fetch(targetFullUrl, {
            method,
            headers: fetchHeaders,
            body: ['GET', 'HEAD'].includes(method) ? undefined : (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body)
        });

        const contentType = response.headers.get('content-type') || '';
        const resCsrf = response.headers.get('x-csrf-token');
        if (resCsrf) db.masterCsrfToken = resCsrf;

        if (contentType.includes('text/html')) {
            let html = await response.text();
            html = html.replace(/lightvisual\.studio/gi, BRAND_NAME).replace(/lightvisual/gi, BRAND_NAME);
            const remainSec = Math.max(0, Math.floor((session.expireTime - Date.now()) / 1000));
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
                <span>👤 <b>${session.username}</b></span>
                <span>|</span>
                <span>⏳ Còn: <b id="time-left-val" style="color:#f59e0b;">-- phút -- giây</b></span>
                <span>|</span>
                <span>🎨 Lượt tạo: <b id="quota-val" style="color:#38bdf8;">${usedQ} / ${maxQ > 0 ? maxQ : 'Vô hạn'}</b></span>
                <span>|</span>
                <a href="/sub-logout" style="color:#ef4444;font-weight:bold;text-decoration:none;">Thoát</a>
            </div>
            <script>
                (function(){
                    let sec = ${remainSec};
                    let usedQuota = ${usedQ};
                    let maxQuota = ${maxQ};
                    const tEl = document.getElementById('time-left-val');
                    const qEl = document.getElementById('quota-val');

                    function renderQuota() {
                        if (!qEl) return;
                        qEl.textContent = usedQuota + ' / ' + (maxQuota > 0 ? maxQuota : 'Vô hạn');
                        if (maxQuota > 0 && usedQuota >= maxQuota) {
                            qEl.style.color = '#ef4444';
                            qEl.textContent += ' (Đã đạt giới hạn)';
                        }
                    }
                    renderQuota();

                    // 1. Đếm ngược chi tiết từng giây trên màn hình khách
                    setInterval(() => {
                        sec--;
                        if (sec <= 0) {
                            window.location.href = '/sub-logout?reason=timeout';
                        }
                        if (tEl && sec >= 0) {
                            const m = Math.floor(sec / 60);
                            const s = sec % 60;
                            tEl.textContent = m + ' phút ' + (s < 10 ? '0' : '') + s + ' giây';
                        }
                    }, 1000);

                    // 2. Kiểm tra ngầm mỗi 4 giây: Nếu Admin bấm "Xóa / Đá" là văng ra ngay lập tức
                    const origFetch = window.fetch;
                    setInterval(() => {
                        origFetch('/sub-status').then(r => r.json()).then(data => {
                            if (!data.valid) {
                                window.location.href = '/sub-logout?reason=' + (data.reason || 'kicked');
                            } else {
                                usedQuota = data.usedQuota;
                                maxQuota = data.maxQuota;
                                renderQuota();
                            }
                        }).catch(() => {});
                    }, 4000);

                    // 3. Bắt sự kiện bấm nút "Tạo" (Ảnh / Video) để đếm lượt & Khóa khi chạm Limit Max
                    document.addEventListener('click', function(e) {
                        const btn = e.target.closest('button');
                        if (!btn) return;
                        const txt = (btn.textContent || '').trim();
                        if (/^Tạo(\\s|•|$)/i.test(txt) || txt.includes('Tạo ảnh') || txt.includes('Tạo video') || txt.includes('Chạy Excel')) {
                            if (maxQuota > 0 && usedQuota >= maxQuota) {
                                e.preventDefault();
                                e.stopPropagation();
                                alert('⛔ Bạn đã sử dụng hết giới hạn ' + maxQuota + '/' + maxQuota + ' lượt tạo Ảnh/Video của tài khoản này!');
                                return false;
                            }
                            // Ghi nhận +1 lượt tạo lên Server
                            usedQuota++;
                            renderQuota();
                            origFetch('/sub-status?action=increment', { method: 'POST' }).then(r => r.json()).then(data => {
                                if (!data.allowed) {
                                    alert('⛔ Bạn đã đạt giới hạn tối đa (' + maxQuota + ' lượt tạo)!');
                                }
                                usedQuota = data.usedQuota;
                                renderQuota();
                            }).catch(() => {});
                        }
                    }, true);

                    // 4. Tự động đính kèm X-CSRF-Token & Chặn lệnh POST nếu vượt giới hạn
                    const savedCsrf = "${db.masterCsrfToken || ''}";
                    window.fetch = function(url, options = {}) {
                        const method = (options.method || 'GET').toUpperCase();
                        const urlStr = String(url);
                        if (method === 'POST' && !urlStr.includes('/sub-status') && maxQuota > 0 && usedQuota > maxQuota) {
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

                    // 5. Ẩn toàn bộ thông tin web gốc
                    const f = ['Tải App', 'Báo lỗi / Góp ý', 'Báo lỗi', 'Vào Nhóm Zalo', 'Gói Vô Hạn', 'Nạp', 'API', 'Lịch sử request', 'Tạo API key', 'Powered by Netlify'];
                    if (${hideHistory}) f.push('Dự án', 'Thư viện');

                    function c() {
                        document.querySelectorAll('a, button, span, div').forEach(el => {
                            const txt = (el.textContent || '').trim();
                            if (!txt || txt.length > 45) return;
                            if (el.children.length === 0 && (txt.toLowerCase() === 'lightvisual' || txt.toLowerCase() === '.studio')) {
                                el.textContent = txt.toLowerCase() === 'lightvisual' ? '${BRAND_NAME}' : '';
                            }
                            if (el.children.length === 0 && /^[0-9\\.]+đ$/i.test(txt)) {
                                const p = el.closest('button, a, div');
                                if (p) p.style.display = 'none';
                                el.style.display = 'none';
                            }
                            if ((el.tagName === 'A' || el.tagName === 'BUTTON' || el.children.length === 0) && f.some(i => txt === i || txt.includes('Vào Nhóm Zalo') || txt.includes('Gói Vô Hạn') || txt.includes('Powered by Netlify'))) {
                                (el.closest('a, button')||el).style.display = 'none';
                            }
                        });
                    }
                    c();
                    new MutationObserver(c).observe(document.documentElement, { childList: true, subtree: true });
                })();
            </script>`;

            return {
                statusCode: response.status,
                headers: { 'content-type': 'text/html; charset=utf-8' },
                body: html.replace('</body>', shield + '</body>')
            };
        }

        const arrayBuffer = await response.arrayBuffer();
        return {
            statusCode: response.status,
            headers: { 'content-type': contentType },
            body: Buffer.from(arrayBuffer).toString('base64'),
            isBase64Encoded: true
        };
    } catch (err) {
        return { statusCode: 502, body: 'Lỗi kết nối Server gốc' };
    }
};
